/**
 * Self-check for Google Health ingest (src/health.js) and get_health_context.
 * Feeds test-health.fixture.json (synthetic: v4 REST field names, fabricated
 * values) through a stubbed fetch, plus the synthetic Tandem Glooko fixture for
 * the diabetes side. Nothing touches the network.
 *   node --no-warnings test-health.mjs
 * A child run (OMNI_TEST_NOTLINKED=1) proves an unlinked Google account comes
 * back as a clear, actionable status instead of an error or a crash.
 */
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NOTLINKED = process.env.OMNI_TEST_NOTLINKED === '1';
const fx = JSON.parse(readFileSync(new URL('./test-health.fixture.json', import.meta.url)));
const glooko = JSON.parse(readFileSync(new URL('./test-tandem.fixture.json', import.meta.url)));

process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 'h.db');
process.env.GLOOKO_GLUCOSE_UNIT = 'mmol';
process.env.OMNI_UNITS = 'mmol';
process.env.GLOOKO_EMAIL = 'stub@example.test';
process.env.GLOOKO_PASSWORD = 'stub';
process.env.OMNI_OLDEST_DATE = '2001-03-01';
process.env.OMNI_GHEALTH_CLIENT_ID = 'stub-client';
process.env.OMNI_GHEALTH_CLIENT_SECRET = 'stub-secret';
process.env.OMNI_GHEALTH_REFRESH_TOKEN = 'stub-refresh';
globalThis.__OMNI_FETCH_STUB__ = (startDate, endDate) => ({ startDate, endDate, ...glooko });

// Stub Google: token endpoint and the v4 dataPoints endpoints. Data comes back
// only for a request whose window covers March 2001; every other window is empty.
const calls = { token: 0, api: 0 };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  if (u.host === 'oauth2.googleapis.com') {
    calls.token++;
    assert.strictEqual(new URLSearchParams(init.body).get('grant_type'), 'refresh_token');
    return json(200, { access_token: 'stub-access', expires_in: 3600 });
  }
  assert.strictEqual(u.host, 'health.googleapis.com');
  assert.strictEqual(init.headers.Authorization, 'Bearer stub-access');
  calls.api++;
  if (NOTLINKED) return json(400, fx['error:not-linked']);
  const [, type, method] = u.pathname.match(/dataTypes\/([^/]+)\/dataPoints(:\w+)?$/);
  if (method === ':dailyRollUp') {
    const { start } = JSON.parse(init.body).range;
    const hit = start.date.year === 2001 && start.date.month === 3;
    return json(200, hit ? fx[`rollup:${type}`] : {});
  }
  const hit = /2001-03/.test(u.searchParams.get('filter'));
  const pages = fx[type];
  if (!hit) return json(200, {});
  return json(200, u.searchParams.get('pageToken') === 'p2' ? pages[1] : pages[0]);
};

const { pullAndIngest } = await import('./src/range.js');
const { createServer } = await import('./src/server.js');
const { getHealth } = await import('./src/store.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const start = '2001-03-10T00:00:00.000Z';
const end = '2001-03-12T00:00:00.000Z';
await pullAndIngest(start, end);
delete process.env.GLOOKO_EMAIL;
delete process.env.GLOOKO_PASSWORD;

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = async (args) => {
  const r = await client.callTool({ name: 'get_health_context', arguments: args });
  assert.ok(!r.isError, `get_health_context errored: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};

if (NOTLINKED) {
  const out = await call({ start, end, granularity: 'day' });
  assert.strictEqual(out.healthSync.ok, false);
  assert.strictEqual(out.healthSync.reason, 'ACCOUNT_NOT_LINKED');
  assert.match(out.healthSync.hint, /Google Health app/);
  // Glooko rows are still served; health is simply absent.
  assert.ok(out.buckets.length >= 2 && out.buckets.every((x) => x.glucose && x.health === null));
  console.log('OK: unlinked Google account reported as an actionable status');
  process.exit(0);
}

// 1. Daily buckets: health beside the glucose row.
const day = await call({ start, end, granularity: 'day' });
assert.strictEqual(day.healthSync.ok, true);
const d10 = day.buckets.find((x) => x.bucket === '2001-03-10');
const d11 = day.buckets.find((x) => x.bucket === '2001-03-11');
assert.ok(d10.glucose.cgmReadingCount > 0, 'Glooko row kept');
assert.deepStrictEqual(d10.health, {
  steps: { total: 8000, perDay: 8000, days: 1 },
  activeMinutes: { perDay: 30, days: 1 }, // MODERATE + VIGOROUS, LIGHT excluded
  exercise: null,
  sleep: { nights: 1, avgMinutesAsleep: 410, avgMinutesAwake: 40, avgStageMinutes: { deep: 70, light: 250, rem: 90 } },
  restingHeartRate: { avgBpm: 58, days: 1 },
  hrv: { avgRmssdMs: 45.5, days: 1 },
  weight: { medianKg: 80.5, weighIns: 1 },
  bodyFat: { medianPercent: 22.4, readings: 1 },
});
assert.deepStrictEqual(d11.health.exercise, { count: 1, minutes: 40, types: { RUNNING: 1 } });
assert.strictEqual(d11.health.sleep, null, 'nap is not a night');
assert.strictEqual(d11.health.weight.medianKg, 80.1, 'second page read');
assert.deepStrictEqual(day.sources.weight, { 'HEALTH_CONNECT / com.example.scale': 1, FITBIT: 1 });
assert.deepStrictEqual(day.sources.steps, { ALL_SOURCES_ROLLUP: 2 });

// 2. Local-epoch mapping: physicalTime + utcOffset (-5 h), Glooko's frame.
const h = getHealth(Date.parse(start) / 1000, Date.parse(end) / 1000);
const w = h.samples.find((x) => x.type === 'weight');
assert.strictEqual(w.utcEpoch - w.localEpoch, 5 * 3600);
assert.strictEqual(new Date(w.localEpoch * 1000).toISOString(), '2001-03-10T07:30:00.000Z');
const night = h.sessions.find((x) => x.type === 'sleep' && x.subtype === 'main');
assert.strictEqual(new Date(night.startLocal * 1000).toISOString(), '2001-03-09T23:00:00.000Z');
assert.strictEqual(new Date(night.endLocal * 1000).toISOString(), '2001-03-10T06:30:00.000Z');

// 3. Weekly bucket merges both days; no second Google pull in the same session.
const apiCalls = calls.api;
const week = await call({ start, end, granularity: 'week' });
assert.strictEqual(calls.api, apiCalls);
assert.strictEqual(calls.token, 1, 'access token cached');
const wk = week.buckets.find((x) => x.bucket === '2001-03-05');
assert.deepStrictEqual(wk.health.weight, { medianKg: 80.3, weighIns: 2 });
assert.deepStrictEqual(wk.health.steps, { total: 20000, perDay: 10000, days: 2 });
assert.ok(week.notes.some((n) => /an hour off/.test(n)));

// 4. Late sync: healthSyncedTo already advanced, yet a top-up re-reads ~5 days back; repeat adds no rows.
{
  const { DatabaseSync } = await import('node:sqlite');
  const { setMeta } = await import('./src/store.js');
  const { ensureHealthFresh } = await import('./src/health.js');
  const raw = new DatabaseSync(process.env.OMNI_DB_PATH);
  const count = () => ['health_sample', 'health_session', 'health_daily'].map((t) => raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  for (const t of ['health_sample', 'health_session', 'health_daily']) raw.exec(`DELETE FROM ${t}`);
  const now = Date.parse('2001-03-15T12:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;
  setMeta('healthSyncedTo', Math.floor(now / 1000) - 12 * 3600); // advanced to 03-15 00:00, stale by 12 h
  const top = await ensureHealthFresh(0);
  assert.strictEqual(top.ok, true);
  const [s1, , d1] = count();
  assert.ok(s1 > 0 && d1 > 0, 'sample ~5 days before healthSyncedTo ingested');
  assert.ok(getHealth(Date.parse(start) / 1000, Date.parse(end) / 1000).samples.some((x) => x.type === 'body_fat'));
  const once = count();
  setMeta('healthSyncedTo', Math.floor(now / 1000) - 7 * 3600); // stale again, forces a second top-up
  await ensureHealthFresh(0);
  assert.deepStrictEqual(count(), once, 'repeat top-up adds no duplicates');
  Date.now = realNow;
}

console.log('OK: Google Health ingest and get_health_context');
execFileSync(process.execPath, ['--no-warnings', import.meta.filename], {
  env: { ...process.env, OMNI_TEST_NOTLINKED: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.exit(0);
