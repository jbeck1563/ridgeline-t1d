/**
 * Self-check for the page's Refresh button endpoint (POST /api/refresh, src/http.js).
 * Seeds a scratch archive with day one of the synthetic Tandem fixture; the stubbed
 * Glooko fetch then "uploads" day two, so a refresh must add exactly those readings.
 * Nothing touches the network.
 *   node --no-warnings test-refresh.mjs
 */
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const full = JSON.parse(readFileSync(new URL('./test-tandem.fixture.json', import.meta.url)));
const dayOne = structuredClone(full);
for (const k of ['cgmHigh', 'cgmNormal', 'cgmLow']) {
  dayOne.data1.series[k] = dayOne.data1.series[k].filter((p) => p.timestamp < '2001-03-11');
}

process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 'r.db');
process.env.OMNI_WEB = '1';
process.env.OMNI_UNITS = 'mmol';
process.env.OMNI_HTTP_PORT = '38037';
process.env.OMNI_HTTP_HOST = '127.0.0.1';
process.env.OMNI_HTTP_TOKEN = 'test-token';
process.env.OMNI_MYDATA_BASIC = 'mcp:s3cret';
process.env.GLOOKO_EMAIL = 'stub@example.test';
process.env.GLOOKO_PASSWORD = 'stub';
for (const k of ['OMNI_GHEALTH_CLIENT_ID', 'OMNI_GHEALTH_CLIENT_SECRET', 'OMNI_GHEALTH_REFRESH_TOKEN']) delete process.env[k];

// The stub stands in for Glooko: `served` is what it returns, `gate` (when set)
// holds a pull open so the in-progress case can be observed, `fail` makes it throw.
let served = dayOne;
let calls = 0;
let gate = null;
let fail = null;
globalThis.__OMNI_FETCH_STUB__ = async (startDate, endDate) => {
  calls++;
  if (gate) await gate;
  if (fail) throw new Error(fail);
  return { startDate, endDate, ...structuredClone(served) };
};

const { pullAndIngest } = await import('./src/range.js');
const { isSyncing } = await import('./src/sync.js');
await pullAndIngest('2001-03-10T00:00:00.000Z', '2001-03-12T00:00:00.000Z');

await import('./src/http.js');
const idle = async () => { while (isSyncing()) await new Promise((r) => setTimeout(r, 20)); };
await new Promise((r) => setTimeout(r, 300));
await idle(); // the startup warm-up top-up (still day one only)

const base = `http://127.0.0.1:${process.env.OMNI_HTTP_PORT}`;
const BASIC = { Authorization: 'Basic ' + Buffer.from('mcp:s3cret').toString('base64') };
const refresh = (headers = BASIC) => fetch(base + '/api/refresh', { method: 'POST', headers });

// 1. Auth: no credential, a wrong one, or the MCP Bearer is 401 and never pulls.
calls = 0;
for (const h of [{}, { Authorization: 'Basic ' + Buffer.from('mcp:wrong').toString('base64') }, { Authorization: 'Bearer test-token' }]) {
  const r = await refresh(h);
  assert.strictEqual(r.status, 401, JSON.stringify(h));
  assert.match(r.headers.get('www-authenticate') || '', /^Basic realm="ridgeline"/);
}
await fetch(base + '/api/refresh', { headers: BASIC }); // GET is not a refresh
assert.strictEqual(calls, 0, 'only an authenticated POST may reach Glooko');

// 2. A refresh runs the top-up and reports the newly uploaded readings.
const latestBefore = (await (await fetch(base + '/api/config', { headers: BASIC })).json()).archive.latest;
assert.strictEqual(latestBefore, '2001-03-10T23:55:00.000Z');
served = full;
let r = await refresh();
assert.strictEqual(r.status, 200);
let body = await r.json();
assert.ok(calls > 0, 'refresh must call Glooko');
assert.deepStrictEqual(
  { status: body.status, newReadings: body.newReadings, latest: body.latest },
  { status: 'done', newReadings: 288, latest: '2001-03-11T23:55:00.000Z' }
);
assert.ok(!Number.isNaN(Date.parse(body.syncedAt)));

// 3. Again with nothing new: done, zero new readings.
body = await (await refresh()).json();
assert.deepStrictEqual([body.status, body.newReadings], ['done', 0]);

// 4. A second press while a pull is running answers 409 at once, without a second pull.
let release;
gate = new Promise((res) => (release = res));
calls = 0;
const first = refresh();
while (!isSyncing() || calls === 0) await new Promise((res) => setTimeout(res, 10));
r = await refresh();
assert.strictEqual(r.status, 409);
assert.strictEqual((await r.json()).status, 'in-progress');
assert.strictEqual(calls, 1, 'the in-progress press must not start another pull');
gate = null;
release();
assert.strictEqual((await first).status, 200);

// 5. A failing pull is a 502 with the error, and the lock is released.
fail = 'Glooko login failed (stub)';
r = await refresh();
assert.strictEqual(r.status, 502);
assert.deepStrictEqual(await r.json(), { status: 'error', error: 'Glooko login failed (stub)' });
assert.strictEqual(isSyncing(), false);

console.log('OK: POST /api/refresh');
setTimeout(() => process.exit(0), 100);
