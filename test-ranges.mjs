/**
 * Self-check for the five consensus glucose bands and the AGP percentiles.
 * Part 1 calls calculateTIRMetrics and agpProfile directly on tiny fabricated
 * inputs. Part 2 seeds a scratch archive with one synthetic week and checks the
 * bands come through get_diabetes_summary, get_trend, get_hourly_trends,
 * get_tdd_trend and get_agp offline. Nothing touches the network.
 *   node --no-warnings test-ranges.mjs
 */
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 'ranges.db');
process.env.OMNI_UNITS = 'mmol';
for (const k of ['GLOOKO_EMAIL', 'GLOOKO_PASSWORD', 'OMNI_GHEALTH_CLIENT_ID', 'OMNI_GHEALTH_CLIENT_SECRET', 'OMNI_GHEALTH_REFRESH_TOKEN', 'OMNI_LOWER', 'OMNI_UPPER'])
  delete process.env[k];

const { calculateTIRMetrics, agpProfile } = await import('./src/analytics.js');

// --- 1a. Five bands: one value at each edge of every band. ---------------------
const EDGES = [2.9, 3.0, 3.8, 3.9, 10.0, 10.1, 13.9, 14.0];
const FIVE = { veryLow: 12.5, low: 25, inRange: 25, high: 25, veryHigh: 12.5 };
assert.deepStrictEqual(calculateTIRMetrics(EDGES, { low: 3.9, high: 10 }), {
  tir: 25, low: 37.5, high: 37.5, veryLow: 12.5, veryHigh: 12.5, bands: FIVE,
});
// Configured thresholds move tir/low/high only; the consensus bands stay fixed.
const wide = calculateTIRMetrics(EDGES, { low: 3.5, high: 12 });
assert.deepStrictEqual([wide.tir, wide.low, wide.high, wide.bands], [50, 25, 25, FIVE]);
// mg/dL-sourced values: 70 mg/dL (3.885) is in range, 54 (2.997) is low, 53 is very low.
assert.deepStrictEqual(calculateTIRMetrics([70, 54, 53].map((v) => v / 18.0182), { low: 3.9, high: 10 }).bands,
  { veryLow: 33.33, low: 33.33, inRange: 33.33, high: 0, veryHigh: 0 });
assert.deepStrictEqual(calculateTIRMetrics([], { low: 3.9, high: 10 }),
  { tir: 0, low: 0, high: 0, veryLow: 0, veryHigh: 0, bands: { veryLow: 0, low: 0, inRange: 0, high: 0, veryHigh: 0 } });

// --- 1b. AGP: slot 0 holds 4..8 across five days, slot 2 holds one 10. ---------
const D0 = Date.UTC(2001, 0, 1) / 1000;
const cgm = (epoch, val) => ({ type: 'CGM', epoch, val });
const agpIn = [
  ...[4, 5, 6, 7, 8].map((v, i) => cgm(D0 + i * 86400 + i * 120, v)), // 00:00-00:08
  cgm(D0 + 30 * 60, 10), // 00:30, slot 2
  { type: 'BOLUS', epoch: D0 + 60, units: 1 }, // ignored
];
const agp = agpProfile(agpIn);
assert.strictEqual(agp.length, 96);
const pick = (s) => [s.time, s.n, s.p5, s.p25, s.p50, s.p75, s.p95];
// Raw slot 0: p5 4.2, p25 5, p50 6, p75 7, p95 7.8 (linear interpolation).
// Smoothing averages the slots with readings among i-2..i+2, wrapping at midnight.
assert.deepStrictEqual(pick(agp[0]), ['00:00', 5, 7.1, 7.5, 8, 8.5, 8.9]); // (slot 0 + slot 2) / 2
assert.deepStrictEqual(pick(agp[1]), ['00:15', 0, 7.1, 7.5, 8, 8.5, 8.9]);
assert.deepStrictEqual(pick(agp[2]), ['00:30', 1, 7.1, 7.5, 8, 8.5, 8.9]);
assert.deepStrictEqual(pick(agp[3]), ['00:45', 0, 10, 10, 10, 10, 10]); // slot 2 only
assert.deepStrictEqual(pick(agp[5]), ['01:15', 0, null, null, null, null, null]);
assert.deepStrictEqual(pick(agp[94]), ['23:30', 0, 4.2, 5, 6, 7, 7.8]); // wraps to slot 0 only
assert.deepStrictEqual(pick(agpProfile(agpIn, 'mgdl')[94]), ['23:30', 0, 76, 90, 108, 126, 141]);

// --- 2. Through the MCP tools on one seeded week. -------------------------------
// 2001-01-01 is a Monday. Every day: the eight edge values at 01:00..08:00.
const { ingestTimeline, ingestDailyInsulin } = await import('./src/store.js');
const { createServer } = await import('./src/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const timeline = [];
const daily = [];
for (let i = 0; i < 7; i++) {
  const d0 = D0 + i * 86400;
  EDGES.forEach((v, h) => timeline.push(cgm(d0 + (h + 1) * 3600, v)));
  daily.push({ dayUtc: new Date(d0 * 1000).toISOString().slice(0, 10), dayEpoch: d0, basalUnits: 15, bolusUnits: 15, totalUnits: 30 });
}
ingestTimeline(timeline, []);
ingestDailyInsulin(daily, '2026-01-01');

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: { start: '2001-01-01T00:00:00.000Z', end: '2001-01-08T00:00:00.000Z', ...args } });
  assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};

const g = (await call('get_diabetes_summary', {})).glucoseControl;
assert.deepStrictEqual(
  [g.timeInRange, g.timeLow, g.timeHigh, g.timeVeryLow, g.timeVeryHigh, g.consensusBands, g.cgmReadingCount, g.cgmActivePercent],
  [25, 37.5, 37.5, 12.5, 12.5, FIVE, 56, 2.8] // 56 of 2016 five-minute slots
);
// A per-call lower/upper changes timeInRange but not the consensus bands.
const g2 = (await call('get_diabetes_summary', { lower: 3.5, upper: 12 })).glucoseControl;
assert.deepStrictEqual([g2.timeInRange, g2.consensusBands], [50, FIVE]);

const days = (await call('get_trend', { mode: 'calendar', granularity: 'day' })).buckets;
assert.strictEqual(days.length, 7);
assert.deepStrictEqual([days[0].glucose.timeVeryLow, days[0].glucose.timeVeryHigh, days[0].glucose.consensusBands], [12.5, 12.5, FIVE]);

const hours = (await call('get_hourly_trends', {})).byHour;
assert.deepStrictEqual(hours.map((h) => [h.hour, h.veryLow, h.veryHigh]), [
  ['01:00', 100, 0], ['02:00', 0, 0], ['03:00', 0, 0], ['04:00', 0, 0],
  ['05:00', 0, 0], ['06:00', 0, 0], ['07:00', 0, 0], ['08:00', 0, 100],
]);
assert.deepStrictEqual(hours[2].consensusBands, { veryLow: 0, low: 100, inRange: 0, high: 0, veryHigh: 0 });

const week = (await call('get_tdd_trend', {})).weeks[0];
assert.deepStrictEqual([week.glucose.timeVeryLow, week.glucose.timeVeryHigh, week.glucose.consensusBands], [12.5, 12.5, FIVE]);

const out = await call('get_agp', {});
assert.deepStrictEqual([out.unit, out.slotMinutes, out.readings, out.slots.length], ['mmol/L', 15, 56, 96]);
assert.deepStrictEqual(out.consensusThresholds, { veryLow: 3, low: 3.9, high: 10, veryHigh: 13.9 });
assert.deepStrictEqual(pick(out.slots[4]), ['01:00', 7, 2.9, 2.9, 2.9, 2.9, 2.9]); // 01:00 only, 7 days of 2.9
assert.deepStrictEqual(pick(out.slots[6]), ['01:30', 0, 3, 3, 3, 3, 3]); // (2.9 + 3.0) / 2, shown at 1 dp
const mg = await call('get_agp', { units: 'mgdl' });
assert.deepStrictEqual(mg.consensusThresholds, { veryLow: 54, low: 70, high: 180, veryHigh: 250 });

await client.close();
console.log('test-ranges: all assertions passed');
process.exit(0);
