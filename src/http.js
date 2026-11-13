/**
 * http.js — the HTTP / SSE entry point.
 *
 * An ALTERNATIVE transport to the default stdio (src/server.js). It exposes the
 * same tools and the same sync engine, but over Streamable HTTP instead of
 * stdio. Streamable HTTP is the current MCP HTTP transport; it provides the SSE
 * streaming endpoint that environments ask for (the legacy standalone HTTP+SSE
 * transport is deprecated).
 *
 * STATEFUL, MULTI-CLIENT SAFE. Each client session gets its OWN transport,
 * created on the `initialize` request and keyed by the session id the SDK
 * generates. Subsequent requests carry that id in the `Mcp-Session-Id` header
 * and are routed back to the same transport; on close the transport is removed.
 * A single shared transport cannot do this (it would cross client sessions), so
 * we keep a sessionId -> transport map, and build a SEPARATE McpServer per
 * session (the SDK forbids one server on multiple transports).
 *
 * Launch this instead of stdio by running `node src/http.js` (the Docker image
 * selects transport via env, see Dockerfile / OMNI_TRANSPORT).
 *
 * SECURITY: intended for LOCAL use (same machine / local Docker network). It
 * binds 127.0.0.1 by default. If OMNI_HTTP_TOKEN is set, every request must
 * carry `Authorization: Bearer <token>`; if unset, it runs open (acceptable
 * only on a trusted local interface). Do NOT bind 0.0.0.0 or expose the port
 * off-host without a token and TLS: it serves health data and can trigger
 * Glooko pulls.
 */

import http from 'http';
import { readFileSync } from 'fs';
import { randomUUID, timingSafeEqual } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, glucoseDefaults } from './server.js';
import { glookoConfigured } from './range.js';
import { fetchGlookoRange } from './glooko.js';
import { ensureFreshOnFirstCall } from './sync.js';
import { initDb, getEarliestCgmEpoch, getLatestCgmEpoch, getMeta, savePumpSettings } from './store.js';
import { parseTandemSettings } from './tandem-settings.js';

const PORT = parseInt(process.env.OMNI_HTTP_PORT || '3000', 10);
const HOST = process.env.OMNI_HTTP_HOST || '127.0.0.1';
const MCP_PATH = process.env.OMNI_HTTP_PATH || '/mcp';
const TOKEN = process.env.OMNI_HTTP_TOKEN || null;

// Optional raw-passthrough route for the Ridgeline web UI. That app POSTs
// /my-data with browser-typed Glooko credentials and expects back the three raw
// Glooko payloads. fetchGlookoRange() already returns exactly that shape, so
// serving it here lets the UI drop its own login entirely: one Glooko session
// for the whole house instead of two, and no credentials in the browser.
//
// Off by default. It cannot use OMNI_HTTP_TOKEN, because a browser cannot be made
// to send a Bearer header on a page's own fetch(). It uses HTTP Basic instead,
// which a browser DOES replay automatically on same-origin requests once the user
// has authenticated: set OMNI_MYDATA_BASIC to `user:password`.
//
// FAIL CLOSED: with OMNI_MYDATA=1 and no OMNI_MYDATA_BASIC the route refuses to
// serve. An open /my-data hands anyone who can reach the port a live pull of your
// glucose history using the server's own Glooko credentials, so there is no
// "just for now" mode where it answers without a credential.
const MYDATA = process.env.OMNI_MYDATA === '1';
const MYDATA_BASIC = process.env.OMNI_MYDATA_BASIC || null;

// Optional report page, the successor to the old standalone web app.
// With OMNI_WEB=1, GET / serves src/web/index.html and GET /api/* serves the JSON
// it renders. Same Basic credential (OMNI_MYDATA_BASIC) and the same fail-closed
// rule as /my-data; /mcp keeps its Bearer and is untouched. The API calls the MCP
// tools themselves (in process, see callTool), so the page shows exactly what an
// MCP client would get, from the archive, with no parsing in the browser.
const WEB = process.env.OMNI_WEB === '1';

// Constant-time compare of the full Authorization header against the expected
// Basic credential. Length is compared first because timingSafeEqual throws on a
// length mismatch — that leaks only the length, not the secret.
function basicOk(req) {
  const got = Buffer.from(req.headers['authorization'] || '');
  const want = Buffer.from(
    `Basic ${Buffer.from(MYDATA_BASIC, 'utf8').toString('base64')}`
  );
  return got.length === want.length && timingSafeEqual(got, want);
}

// sessionId -> transport. One transport per live client session. The MCP server
// is connected once to each transport when the session is created.
const transports = Object.create(null);

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function badRequest(res, message) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message || 'bad request' }));
}

// Read and JSON-parse a request body (for POST). Returns undefined for empty.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Read a small request body as UTF-8 text, refusing more than `max` bytes
// (rejects with err.tooLarge; the rest of the upload is drained, not kept).
function readSmallText(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return reject(Object.assign(new Error('body too large'), { tooLarge: true }));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function tokenOk(req) {
  if (!TOKEN) return true; // open mode (local, trusted interface only)
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${TOKEN}`;
}

// Is this parsed POST body an MCP `initialize` request? Initialize is the only
// request allowed to arrive WITHOUT a session id; it mints a new session.
function isInitialize(body) {
  if (!body) return false;
  if (Array.isArray(body)) return body.some((m) => m && m.method === 'initialize');
  return body.method === 'initialize';
}

// Create a fresh transport for a new session, connect the shared server to it,
// and register it in the map once the SDK assigns a session id.
async function createSessionTransport() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      transports[sessionId] = transport;
    },
    onsessionclosed: (sessionId) => {
      delete transports[sessionId];
    },
  });
  // Also clean up if the transport closes for any other reason.
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports[sid]) delete transports[sid];
  };
  // Each session needs its OWN server instance: the SDK forbids connecting one
  // server to multiple transports.
  const sessionServer = createServer();
  await sessionServer.connect(transport);
  return transport;
}

// The Basic check shared by /my-data and the web page. Writes the refusal and
// returns false when the caller may not proceed. FAIL CLOSED: no configured
// credential means 503 for everyone.
function basicGate(req, res, route) {
  if (!MYDATA_BASIC) {
    console.error(
      `[ridgeline] ${route} refused: OMNI_MYDATA_BASIC is unset.`
    );
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: `Server misconfigured: ${route} has no credential set.` })
    );
    return false;
  }
  if (!basicOk(req)) {
    // The realm makes a browser prompt for credentials by itself, so this holds
    // even if the reverse proxy in front is misconfigured or absent.
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="ridgeline", charset="UTF-8"',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

// POST /my-data — { startDate, endDate } -> { startDate, endDate, data1, data2, data3 }.
// Credentials in the body (which the UI still sends) are ignored: this always uses
// GLOOKO_EMAIL / GLOOKO_PASSWORD from the environment.
async function handleMyData(req, res) {
  if (req.method !== 'POST') return notFound(res);
  if (!basicGate(req, res, '/my-data')) return;
  if (!glookoConfigured()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        error: 'Offline mode: no Glooko credentials configured on the server.',
      })
    );
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return badRequest(res, 'invalid JSON body');
  }
  const { startDate, endDate } = body || {};
  if (!startDate || !endDate) {
    return badRequest(res, 'startDate and endDate are required');
  }

  try {
    const result = await fetchGlookoRange(startDate, endDate);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[ridgeline] /my-data failed:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}


// --- Web page and its JSON API (OMNI_WEB=1) -------------------------------

const PAGE = WEB ? readFileSync(new URL('./web/index.html', import.meta.url)) : null;

// One in-process MCP client for the page. Calling the registered tools (rather
// than the analytics functions directly) keeps a single code path: same input
// validation, same caps, same output shape as /mcp.
let pageClient = null;
async function callTool(name, args) {
  if (!pageClient) {
    pageClient = (async () => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createServer().connect(a);
      const client = new Client({ name: 'ridgeline-web', version: '1.0.0' });
      await client.connect(b);
      return client;
    })();
  }
  const r = await (await pageClient).callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) return { error: text || `${name} failed` };
  return JSON.parse(text);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const iso = (epoch) => (epoch ? new Date(epoch * 1000).toISOString() : null);

// Deep-dive exports the page offers for download, each one MCP tool.
const EXPORTS = {
  timeline: (w) => callTool('get_glucose', { ...w, band: 'all' }),
  bolus: (w) => callTool('get_enriched_bolus_log', w),
  hourly: (w) => callTool('get_hourly_trends', w),
};

// The t:connect settings text is ~3 KB; anything near this cap is not a paste.
const PASTE_MAX_BYTES = 64 * 1024;

// POST /api/pump-settings — { text } -> { saved, snapshot, uploads }. Parses the
// pasted t:connect settings and stores them; the same upload twice is a no-op.
async function importPumpSettings(req, res) {
  let text;
  try {
    const body = JSON.parse(await readSmallText(req, PASTE_MAX_BYTES));
    text = body?.text;
  } catch (err) {
    if (err.tooLarge) return sendJson(res, 413, { error: `Paste is over ${PASTE_MAX_BYTES / 1024} KB.` });
    return badRequest(res, 'invalid JSON body');
  }
  if (typeof text !== 'string' || !text.trim()) return badRequest(res, 'text is required');
  let snapshot;
  try {
    snapshot = parseTandemSettings(text);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const saved = savePumpSettings(snapshot);
  const { uploads } = await callTool('get_pump_settings', {});
  return sendJson(res, 200, { saved, snapshot, uploads });
}

async function handleWeb(req, res, url) {
  const isImport = url.pathname === '/api/pump-settings' && req.method === 'POST';
  if (req.method !== 'GET' && !isImport) return notFound(res);
  if (!basicGate(req, res, url.pathname)) return;

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }

  try {
    if (url.pathname === '/api/config') {
      const g = glucoseDefaults();
      return sendJson(res, 200, {
        unit: g.units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        lower: g.lower,
        upper: g.upper,
        online: glookoConfigured(),
        device: JSON.parse(getMeta('device') || 'null'),
        archive: { earliest: iso(getEarliestCgmEpoch()), latest: iso(getLatestCgmEpoch()) },
      });
    }

    if (url.pathname === '/api/pump-settings') {
      if (isImport) return await importPumpSettings(req, res);
      const at = url.searchParams.get('at');
      const out = await callTool('get_pump_settings', at ? { at } : {});
      return sendJson(res, out.error ? 400 : 200, out);
    }

    const w = { start: url.searchParams.get('start'), end: url.searchParams.get('end') };
    if (!w.start || !w.end) return badRequest(res, 'start and end are required');

    if (url.pathname === '/api/report') {
      // Each part is independent: one failing (e.g. a span cap) leaves the
      // others intact and comes back as { error }. The summary runs first so any
      // Glooko top-up for the window happens once, before the others read it.
      const summary = await callTool('get_diabetes_summary', w);
      const [basal, controlIq, health, tddTrend] = await Promise.all([
        callTool('get_basal_delivery', { ...w, includeIntervals: false }),
        callTool('get_controliq_review', w),
        callTool('get_health_context', { ...w, granularity: 'week' }),
        callTool('get_tdd_trend', w),
      ]);
      return sendJson(res, 200, {
        window: w,
        summary,
        pumpModes: basal.error ? basal : basal.pumpModes.summary,
        controlIq,
        health,
        tddTrend,
      });
    }

    if (url.pathname === '/api/export') {
      const run = EXPORTS[url.searchParams.get('type')];
      if (!run) return badRequest(res, 'type must be one of: ' + Object.keys(EXPORTS).join(', '));
      const out = await run(w);
      return sendJson(res, out.error ? 400 : 200, out);
    }
  } catch (err) {
    console.error('[ridgeline] web API failed:', err.message);
    return sendJson(res, 500, { error: err.message });
  }
  return notFound(res);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (MYDATA && url.pathname === '/my-data') return handleMyData(req, res);
  if (WEB && (url.pathname === '/' || url.pathname.startsWith('/api/'))) {
    return handleWeb(req, res, url);
  }
  if (url.pathname !== MCP_PATH) return notFound(res);
  if (!tokenOk(req)) return unauthorized(res);

  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const sessionId =
      req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];

    let transport;
    if (sessionId && transports[sessionId]) {
      // Existing session: route to its own transport.
      transport = transports[sessionId];
    } else if (!sessionId && req.method === 'POST' && isInitialize(body)) {
      // New session: an initialize POST with no session id mints one.
      transport = await createSessionTransport();
    } else {
      // A non-initialize request without a known session id. In stateful mode
      // this is invalid: either the session expired/never existed (provided an
      // id we do not hold) or a non-init request arrived with no id at all.
      if (sessionId) return notFound(res); // unknown/expired session
      return badRequest(res, 'missing session id (no active session)');
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[ridgeline] HTTP request error:', err);
    if (!res.headersSent) badRequest(res);
  }
});

function main() {
  httpServer.listen(PORT, HOST, () => {
    console.error(
      `[ridgeline] MCP server running on http://${HOST}:${PORT}${MCP_PATH} (Streamable HTTP / SSE, stateful).`
    );
    if (!TOKEN) {
      console.error(
        '[ridgeline] WARNING: OMNI_HTTP_TOKEN is not set, the endpoint is ' +
          'unauthenticated. Only acceptable on a trusted local interface.'
      );
    }
    if (HOST === '0.0.0.0' && !TOKEN) {
      console.error(
        '[ridgeline] WARNING: bound to 0.0.0.0 WITHOUT a token. Your health ' +
          'data is exposed to the network. Set OMNI_HTTP_TOKEN.'
      );
    }

    // Warm the archive on startup so the data is present right after
    // `docker compose up`, not only after the first tool call. Runs AFTER the
    // server is already listening (above), so the container is reachable
    // promptly and the load fills in behind it. Skipped entirely in offline
    // mode (no credentials), where we must never contact Glooko. A failure here
    // (e.g. bad credentials) is logged but never crashes the server: tool calls
    // will retry the load and surface the error to the user.
    if (glookoConfigured()) {
      console.error(
        '[ridgeline] Warming archive on startup (cold start if empty, else top-up)...'
      );
      // Fire and forget: do not block the event loop / listener.
      (async () => {
        try {
          initDb();
          await ensureFreshOnFirstCall((m) => console.error(`[ridgeline] ${m}`));
          console.error('[ridgeline] Startup archive warm-up complete.');
        } catch (err) {
          console.error(
            '[ridgeline] Startup warm-up failed (will retry on first tool call):',
            err.message
          );
        }
      })();
    } else {
      console.error(
        '[ridgeline] No Glooko credentials: running in OFFLINE mode, serving ' +
          'only the existing database. No data will be downloaded.'
      );
    }
  });
}

main();
