/**
 * Self-check for the report page and its JSON API (OMNI_WEB=1, src/http.js).
 * Seeds a scratch archive from the synthetic Tandem fixture plus two synthetic
 * Google Health daily rows, then runs offline. Nothing touches the network.
 *   node --no-warnings test-web.mjs
 * A child run (OMNI_TEST_NOBASIC=1) proves the page fails closed without
 * OMNI_MYDATA_BASIC.
 */
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NOBASIC = process.env.OMNI_TEST_NOBASIC === '1';
const fixture = JSON.parse(readFileSync(new URL('./test-tandem.fixture.json', import.meta.url)));

process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 'w.db');
process.env.OMNI_WEB = '1';
process.env.OMNI_UNITS = 'mmol';
process.env.OMNI_HTTP_PORT = NOBASIC ? '38036' : '38035';
process.env.OMNI_HTTP_HOST = '127.0.0.1';
process.env.OMNI_HTTP_TOKEN = 'test-token';
if (NOBASIC) delete process.env.OMNI_MYDATA_BASIC;
else process.env.OMNI_MYDATA_BASIC = 'mcp:s3cret';
for (const k of ['OMNI_GHEALTH_CLIENT_ID', 'OMNI_GHEALTH_CLIENT_SECRET', 'OMNI_GHEALTH_REFRESH_TOKEN']) delete process.env[k];

// Seed through the real ingest, then drop the credentials so the server is offline.
process.env.GLOOKO_EMAIL = 'stub@example.test';
process.env.GLOOKO_PASSWORD = 'stub';
globalThis.__OMNI_FETCH_STUB__ = (startDate, endDate) => ({ startDate, endDate, ...fixture });
const { pullAndIngest } = await import('./src/range.js');
const { ingestHealth } = await import('./src/store.js');
await pullAndIngest('2001-03-10T00:00:00.000Z', '2001-03-12T00:00:00.000Z');
ingestHealth({
  daily: [
    { day: '2001-03-10', type: 'steps', value: 8000, platform: 'ALL_SOURCES_ROLLUP' },
    { day: '2001-03-11', type: 'steps', value: 12000, platform: 'ALL_SOURCES_ROLLUP' },
  ],
});
delete process.env.GLOOKO_EMAIL;
delete process.env.GLOOKO_PASSWORD;

await import('./src/http.js');
await new Promise((r) => setTimeout(r, 300));

const base = `http://127.0.0.1:${process.env.OMNI_HTTP_PORT}`;
const BASIC = { Authorization: 'Basic ' + Buffer.from('mcp:s3cret').toString('base64') };
const get = (p, headers = BASIC) => fetch(base + p, { headers });
const json = async (p) => {
  const r = await get(p);
  assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  return r.json();
};
const win = 'start=2001-03-10T00:00:00.000Z&end=2001-03-12T00:00:00.000Z';

if (NOBASIC) {
  assert.strictEqual((await get('/')).status, 503);
  assert.strictEqual((await get('/api/config')).status, 503);
  console.log('OK: web page fails closed without OMNI_MYDATA_BASIC');
  setTimeout(() => process.exit(0), 100);
} else {
  // 1. Auth: 401 with a realm without a credential, wrong one, or the MCP Bearer.
  for (const h of [{}, { Authorization: 'Basic ' + Buffer.from('mcp:s3crey').toString('base64') }, { Authorization: 'Bearer test-token' }]) {
    for (const p of ['/', '/api/config', `/api/report?${win}`, `/api/trends?${win}`]) {
      const r = await get(p, h);
      assert.strictEqual(r.status, 401, `${p} ${JSON.stringify(h)}`);
      assert.match(r.headers.get('www-authenticate') || '', /^Basic realm="ridgeline"/);
    }
  }

  // 2. The page itself.
  const page = await get('/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<title>Ridgeline T1D<\/title>/);
  assert.ok(!/mmol\/L/.test(html), 'page must not hard-code a glucose unit');
  for (const t of ['overview', 'patterns', 'days', 'trends', 'settings', 'ai']) {
    assert.ok(html.includes(`href="#${t}"`) && html.includes(`id="tab-${t}"`), `tab ${t}`);
  }

  // 3. Config: unit and archive span from the server.
  const cfg = await json('/api/config');
  assert.deepStrictEqual(
    { unit: cfg.unit, lower: cfg.lower, upper: cfg.upper, online: cfg.online, algorithm: cfg.device.algorithm },
    { unit: 'mmol/L', lower: 3.9, upper: 10, online: false, algorithm: 'Control-IQ' }
  );
  assert.strictEqual(cfg.archive.earliest, '2001-03-10T00:00:00.000Z');
  assert.strictEqual(cfg.archive.latest, '2001-03-11T23:55:00.000Z');
  // Wall-clock time of the seeding pull, for the page's "synced n min ago".
  assert.ok(Date.now() - Date.parse(cfg.archive.syncedAt) < 120000, `syncedAt ${cfg.archive.syncedAt}`);

  // 4. Report: the same numbers the MCP tools return, automatic boluses included.
  const rep = await json(`/api/report?${win}`);
  assert.strictEqual(rep.summary.glucoseControl.cgmReadingCount, 576);
  assert.strictEqual(rep.summary.glucoseControl.cgmActivePercent, 100); // 576 readings over 2 days
  assert.deepStrictEqual([rep.agp.readings, rep.agp.slots.length], [576, 96]);
  // Hourly five-band TIR for the Patterns tab: 24 pump-clock hours, 12 readings an hour on 2 days.
  assert.deepStrictEqual(rep.hourly.byHour.map((h) => [h.hourNum, h.readings]), Array.from({ length: 24 }, (_, h) => [h, 24]));
  for (const h of rep.hourly.byHour) {
    const b = h.consensusBands;
    assert.ok(Math.abs(b.veryLow + b.low + b.inRange + b.high + b.veryHigh - 100) < 0.05, `hour ${h.hour} bands sum to 100`);
  }
  assert.deepStrictEqual(rep.hourly.byHour[0].consensusBands, { veryLow: 0, low: 0, inRange: 100, high: 0, veryHigh: 0 });
  assert.deepStrictEqual(rep.hourly.byHour[3].consensusBands, { veryLow: 0, low: 0, inRange: 62.5, high: 37.5, veryHigh: 0 });
  assert.strictEqual(rep.summary.bolusArchitecture.automaticCorrection, 3);
  assert.strictEqual(rep.summary.insulin.bolusEventCount, 6);
  assert.strictEqual(rep.pumpModes.modes.sleep.minutes, 780);
  assert.strictEqual(rep.controlIq.summary.completeDays, 2);
  assert.match(rep.controlIq.caveat, /Discuss with your endocrinologist before changing settings/);
  assert.deepStrictEqual(rep.tddTrend.weeks.map((x) => [x.week, x.completeDays, x.included]), [['2001-03-05', 2, false]]);
  // The one daily-insulin figure the page shows, with its basis.
  assert.strictEqual(rep.tddTrend.windowMean.completeDays, 2);
  assert.strictEqual(rep.tddTrend.windowMean.meanTdd, rep.tddTrend.weeks[0].meanTdd);
  const wk = rep.health.buckets.find((b) => b.health);
  assert.deepStrictEqual(wk.health.steps, { total: 20000, perDay: 10000, days: 2 });

  // 4b. Trends: only the weekly parts, for the Trends tab's own (wider) window.
  const tr = await json(`/api/trends?start=2001-02-10T00:00:00.000Z&end=2001-03-12T00:00:00.000Z`);
  assert.deepStrictEqual(Object.keys(tr).sort(), ['health', 'tddTrend', 'window']);
  assert.strictEqual(tr.tddTrend.windowMean.completeDays, 2);
  assert.deepStrictEqual(tr.health.buckets.find((b) => b.health).health.steps, { total: 20000, perDay: 10000, days: 2 });
  assert.strictEqual((await get('/api/trends')).status, 400);

  // 5. Exports: one per deep-dive file, each straight from its MCP tool.
  const tl = await json(`/api/export?type=timeline&${win}`);
  assert.strictEqual(tl.count, 576);
  assert.strictEqual(tl.thresholdsUsed.unit, 'mmol');
  const bl = await json(`/api/export?type=bolus&${win}`);
  assert.strictEqual(bl.count, 6);
  assert.strictEqual(bl.boluses.filter((b) => b.class === 'Automatic Correction Bolus').length, 3);
  const hr = await json(`/api/export?type=hourly&${win}`);
  assert.strictEqual(hr.byHour.length, 24);

  // 6. Tool errors and bad input come back as JSON 400s.
  const capped = await get('/api/export?type=timeline&start=2001-01-01T00:00:00.000Z&end=2001-03-12T00:00:00.000Z');
  assert.strictEqual(capped.status, 400);
  assert.ok((await capped.json()).error);
  assert.strictEqual((await get('/api/export?type=nope&' + win)).status, 400);
  assert.strictEqual((await get('/api/report')).status, 400);
  assert.strictEqual((await get('/api/nope?' + win)).status, 404);
  assert.strictEqual((await fetch(base + '/', { method: 'POST', headers: BASIC })).status, 404);

  // 7. /mcp still wants the Bearer, and Basic does not open it.
  const mcp = (h) => fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: '{"method":"initialize"}' });
  assert.strictEqual((await mcp({})).status, 401);
  assert.strictEqual((await mcp(BASIC)).status, 401);

  console.log('OK: web page and /api endpoints');
  execFileSync(process.execPath, ['--no-warnings', import.meta.filename], {
    env: { ...process.env, OMNI_TEST_NOBASIC: '1' },
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  setTimeout(() => process.exit(0), 100);
}
