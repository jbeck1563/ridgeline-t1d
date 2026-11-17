/**
 * Self-check for get_tdd_trend. Seeds a scratch archive with five synthetic
 * weeks (fabricated values) straight through the store, then calls the real
 * MCP tool offline. Week 3 has only 3 days of data, so it must be flagged and
 * kept out of the change, rolling mean and slope. Nothing touches the network.
 *   node --no-warnings test-tdd.mjs
 */
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 'tdd.db');
process.env.OMNI_UNITS = 'mmol';
for (const k of ['GLOOKO_EMAIL', 'GLOOKO_PASSWORD', 'OMNI_GHEALTH_CLIENT_ID', 'OMNI_GHEALTH_CLIENT_SECRET', 'OMNI_GHEALTH_REFRESH_TOKEN'])
  delete process.env[k];

const { ingestTimeline, ingestDailyInsulin, ingestHealth } = await import('./src/store.js');
const { createServer } = await import('./src/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

// 2001-01-01 is a Monday. Weekly TDD 30, 32, (partial 34), 36, 38; basal is half.
const MON = Date.UTC(2001, 0, 1) / 1000;
const tddForWeek = [30, 32, 34, 36, 38];
const timeline = [];
const daily = [];
for (let i = 0; i < 35; i++) {
  const w = Math.floor(i / 7);
  if (w === 2 && i % 7 >= 3) continue; // week 3: only Mon-Wed
  const d0 = MON + i * 86400;
  const tdd = tddForWeek[w];
  daily.push({ dayUtc: new Date(d0 * 1000).toISOString().slice(0, 10), dayEpoch: d0, basalUnits: tdd / 2, bolusUnits: tdd / 2, totalUnits: tdd });
  timeline.push({ type: 'CGM', epoch: d0 + 3600, val: 6 }, { type: 'CGM', epoch: d0 + 7200, val: w === 4 ? 14 : 12 });
  if (w === 0) timeline.push({ type: 'BOLUS', epoch: d0 + 10800, units: 0.5, class: 'Automatic Correction Bolus' });
  if (w === 1) timeline.push({ type: 'BOLUS', epoch: d0 + 43200, units: 5, carbs: 150, class: 'Meal Bolus' });
}
ingestTimeline(timeline, []);
ingestDailyInsulin(daily, '2026-01-01');
ingestHealth({ samples: [{ type: 'weight', utcEpoch: MON + 86400, localEpoch: MON + 86400, value: 80 }] });

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const r = await client.callTool({
  name: 'get_tdd_trend',
  arguments: { start: '2001-01-01T00:00:00.000Z', end: '2001-02-05T00:00:00.000Z' },
});
assert.ok(!r.isError, r.content?.[0]?.text);
const out = JSON.parse(r.content[0].text);
const [w1, w2, w3, w4, w5] = out.weeks;

// 1. One row per ISO week, means over complete days.
assert.deepStrictEqual(out.weeks.map((w) => [w.week, w.completeDays, w.included, w.meanTdd]), [
  ['2001-01-01', 7, true, 30],
  ['2001-01-08', 7, true, 32],
  ['2001-01-15', 3, false, 34],
  ['2001-01-22', 7, true, 36],
  ['2001-01-29', 7, true, 38],
]);
assert.deepStrictEqual(
  [w1.meanBasal, w1.meanBolus, w1.meanAutoCorrectionUnits, w1.basalPercent, w1.bolusPercent],
  [15, 15, 0.5, 50, 50]
);
assert.match(w3.excludedReason, /3 complete day/);

// 2. Change vs previous week only between included neighbours.
assert.strictEqual(w1.changeVsPreviousWeek, null);
assert.deepStrictEqual(w2.changeVsPreviousWeek, { units: 2, percent: 6.7 });
assert.strictEqual(w3.changeVsPreviousWeek, undefined);
assert.strictEqual(w4.changeVsPreviousWeek, null);
assert.deepStrictEqual(w5.changeVsPreviousWeek, { units: 2, percent: 5.6 });

// 3. Rolling mean and slope skip the partial week (x = 0, 1, 3, 4 -> slope 2 U/week).
assert.deepStrictEqual(w4.rolling4WeekMeanTdd, { value: 32.67, nWeeks: 3 });
assert.deepStrictEqual(w5.rolling4WeekMeanTdd, { value: 35.33, nWeeks: 3 });
assert.strictEqual(w3.rolling4WeekMeanTdd, undefined);
assert.deepStrictEqual(out.trend, { weeksInWindow: 5, includedWeeks: 4, slopeUnitsPerWeek: 2, confidence: 'medium' });

// 3b. One window-level figure over every complete day (31 days, the partial week included).
assert.deepStrictEqual(out.windowMean, {
  completeDays: 31, meanTdd: 34, meanBasal: 17, meanBolus: 17, meanAutoCorrectionUnits: 0.11, basalPercent: 50,
});

// 4. Proxies appear only when their data exists; glucose sits beside each week.
assert.deepStrictEqual(w1.proxies, { tddPerKg: { value: 0.375, weightKg: 80, weighIns: 1 } });
assert.deepStrictEqual(w2.proxies, { tddUnitsPerGramLoggedCarbs: { value: 0.213, carbsGrams: 1050, carbEntries: 7 } });
assert.deepStrictEqual(w4.proxies, {});
assert.deepStrictEqual(w1.glucose, {
  mean: 9, timeInRange: 50, timeVeryLow: 0, timeVeryHigh: 0,
  consensusBands: { veryLow: 0, low: 0, inRange: 50, high: 50, veryHigh: 0 }, cgmReadings: 14,
});
assert.deepStrictEqual(w5.glucose, {
  mean: 10, timeInRange: 50, timeVeryLow: 0, timeVeryHigh: 50,
  consensusBands: { veryLow: 0, low: 0, inRange: 50, high: 0, veryHigh: 50 }, cgmReadings: 14,
});

// 5. Caveat rule; never a setting value.
assert.match(out.caveat, /Discuss with your endocrinologist before changing settings/);
assert.match(out.caveat, /not a\s+measured insulin sensitivity/);
assert.strictEqual(out.unit, 'mmol/L');

// 6. A window starting mid-week leaves that week partial (Thu-Sun = 4 days).
const mid = JSON.parse(
  (await client.callTool({ name: 'get_tdd_trend', arguments: { start: '2001-01-04T00:00:00.000Z', end: '2001-01-15T00:00:00.000Z' } }))
    .content[0].text
);
assert.deepStrictEqual(mid.weeks.map((w) => [w.daysInWindow, w.completeDays, w.included]), [[4, 4, false], [7, 7, true]]);
assert.strictEqual(mid.trend.slopeUnitsPerWeek, null);

console.log('OK: get_tdd_trend');
process.exit(0);
