/**
 * Self-check for the pasted Tandem pump settings import: the parser on a
 * synthetic t:connect paste (CRLF, trailing spaces, three profiles, one active,
 * multi-segment schedules), identifiers dropped, duplicate import a no-op,
 * get_pump_settings by date, and POST/GET /api/pump-settings behind Basic auth.
 * All values are fabricated. Nothing touches the network.
 *   node --no-warnings test-pump-settings.mjs
 */
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 'ps.db');
process.env.OMNI_WEB = '1';
process.env.OMNI_UNITS = 'mmol';
process.env.OMNI_HTTP_PORT = '38037';
process.env.OMNI_HTTP_HOST = '127.0.0.1';
process.env.OMNI_HTTP_TOKEN = 'test-token';
process.env.OMNI_MYDATA_BASIC = 'mcp:s3cret';
for (const k of ['GLOOKO_EMAIL', 'GLOOKO_PASSWORD', 'OMNI_GHEALTH_CLIENT_ID', 'OMNI_GHEALTH_CLIENT_SECRET', 'OMNI_GHEALTH_REFRESH_TOKEN'])
  delete process.env[k];

const { parseTandemSettings, minutesOf } = await import('./src/tandem-settings.js');

const PASTE = `Testy McTestface
Date of birth: Jan 1, 1990
Upload date: Mar 4, 2001, 9:05 p.m.
t:slim X2™ Insulin Pump, No. 11223344 (7.10.2.0)


Pump Profile settings - 7
Active at upload

Time           Basal Rate (units/hr)
12:00 a.m.     0.9
6:30 a.m.      1.1
9:00 p.m.      0.95
Total Daily Basal: 23.7 units

Time           Correction Factor (units:mmol/L)
12:00 a.m.     1:2.5
6:30 a.m.      1:2.0

Time           Carb Ratio (units:grams)
12:00 a.m.     1:12
12:00 p.m.     1:10

Time           Target BG (mmol/L)
12:00 a.m.     5.8

Insulin Duration: 4 hrs 30 mins
Carbohydrates: On
Mystery line here


Pump Profile settings - Weekend

Time           Basal Rate (units/hr)
12:00 a.m.     0.8
Total Daily Basal: 19.2 units

Time           Correction Factor (units:mmol/L)
12:00 a.m.     1:2.5

Time           Carb Ratio (units:grams)
12:00 a.m.     1:12

Time           Target BG (mmol/L)
12:00 a.m.     6.0

Insulin Duration: 3 hrs
Carbohydrates: Off


Pump Profile settings - Profile 3

Time           Basal Rate (units/hr)
12:00 a.m.     1.0
Total Daily Basal: 24 units

Time           Correction Factor (units:mmol/L)
12:00 a.m.     1:3

Time           Carb Ratio (units:grams)
12:00 a.m.     1:15

Time           Target BG (mmol/L)
12:00 a.m.     6.1

Insulin Duration: 3 hrs
Carbohydrates: On


Control-IQ settings

Control-IQ: On
Weight: 70 kg
Total daily insulin: 40 units

Sleep schedules

Weeknights (11:00 p.m. - 7:00 a.m.): On
-: Off

Insulin duration: 5 hrs
Target BG: 6.1 mmol/L


CGM settings

Type: Dexcom G6
TX ID: 8QQQQQ
High alert: On 12.0 mmol/L, never repeat
Rise alert: -


General settings

Quick bolus: Off
Max bolus: 10 units


Alerts & reminders

Alert Low Insulin: 15 units
Low BG: On 4.0 mmol/L 15 mins
After bolus BG: -
`.replace(/\n/g, '\r\n');

// 1. Parser.
assert.deepStrictEqual(['12:00 a.m.', '12:30 p.m.', '6:30 a.m.', '11:59 p.m.', '13:00 a.m.'].map(minutesOf), [0, 750, 390, 1439, null]);
const snap = parseTandemSettings(PASTE);
assert.strictEqual(snap.uploadDate, '2001-03-04T21:05');
assert.deepStrictEqual(snap.pump, { model: 't:slim X2 Insulin Pump', firmware: '7.10.2.0' });
assert.strictEqual(snap.glucoseUnit, 'mmol/L');
assert.deepStrictEqual(snap.profiles.map((p) => [p.name, p.active]), [['7', true], ['Weekend', false], ['Profile 3', false]]);
const p1 = snap.profiles[0];
assert.deepStrictEqual(p1.basal, [
  { start: 0, time: '00:00', unitsPerHour: 0.9 },
  { start: 390, time: '06:30', unitsPerHour: 1.1 },
  { start: 1260, time: '21:00', unitsPerHour: 0.95 },
]);
assert.deepStrictEqual(p1.correctionFactor.map((x) => [x.start, x.glucosePerUnit]), [[0, 2.5], [390, 2]]);
assert.deepStrictEqual(p1.carbRatio.map((x) => [x.start, x.gramsPerUnit]), [[0, 12], [720, 10]]);
assert.deepStrictEqual(p1.targetBg, [{ start: 0, time: '00:00', value: 5.8 }]);
assert.deepStrictEqual([p1.totalDailyBasal, p1.insulinDurationHours, p1.carbohydrates], [23.7, 4.5, true]);
assert.strictEqual(snap.profiles[1].carbohydrates, false);
assert.deepStrictEqual(snap.controlIq, {
  enabled: true,
  weight: { value: 70, unit: 'kg' },
  totalDailyInsulin: 40,
  sleepSchedules: [{ name: 'Weeknights', start: '23:00', end: '07:00', enabled: true }],
  insulinDurationHours: 5,
  targetBg: { value: 6.1, unit: 'mmol/L' },
});
assert.deepStrictEqual(snap.cgm, { type: 'Dexcom G6', highAlert: 'On 12.0 mmol/L, never repeat', riseAlert: null });
assert.deepStrictEqual(snap.general, { quickBolus: 'Off', maxBolus: '10 units' });
assert.deepStrictEqual(snap.alerts, { alertLowInsulin: '15 units', lowBG: 'On 4.0 mmol/L 15 mins', afterBolusBG: null });
assert.deepStrictEqual(snap.warnings, ['profile: Mystery line here']);

// Identifiers never survive the parse.
const flat = JSON.stringify(snap);
for (const id of ['Testy', 'McTestface', '1990', '11223344', '8QQQQQ', 'birth', 'TX ID']) assert.ok(!flat.includes(id), `leaked ${id}`);

// mg/dL kept as printed; garbage rejected with a clear message.
const mg = parseTandemSettings('Upload date: Dec 31, 2001, 12:00 a.m.\nPump Profile settings - A\nTime  Correction Factor (units:mg/dL)\n12:00 a.m.  1:45\nTime  Basal Rate (units/hr)\n12:00 a.m. 1');
assert.strictEqual(mg.glucoseUnit, 'mg/dL');
assert.strictEqual(mg.uploadDate, '2001-12-31T00:00');
assert.strictEqual(mg.profiles[0].correctionFactor[0].glucosePerUnit, 45);
assert.throws(() => parseTandemSettings('hello\nworld'), /No "Pump Profile settings" section/);
assert.throws(() => parseTandemSettings('Pump Profile settings - 1\n'), /Upload date/);
console.log('OK: parser');

// 2. Store and MCP tool.
const { savePumpSettings, initDb } = await import('./src/store.js');
const { createServer } = await import('./src/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const older = parseTandemSettings(PASTE.replace('Mar 4, 2001, 9:05 p.m.', 'Feb 1, 2001, 8:00 a.m.'));
assert.strictEqual(savePumpSettings(older), true);
assert.strictEqual(savePumpSettings(older), false, 'same upload twice is a no-op');
assert.strictEqual(initDb().prepare('SELECT COUNT(*) n FROM pump_settings_upload').get().n, 1);

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 't', version: '1' });
await client.connect(b);
const tool = async (args) => {
  const r = await client.callTool({ name: 'get_pump_settings', arguments: args });
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
};

// 3. Route: 401 without auth, 200 with; import, duplicate, oversize, bad text.
await import('./src/http.js');
await new Promise((r) => setTimeout(r, 300));
const base = `http://127.0.0.1:${process.env.OMNI_HTTP_PORT}/api/pump-settings`;
const BASIC = { Authorization: 'Basic ' + Buffer.from('mcp:s3cret').toString('base64') };
const post = (body, h = BASIC) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body });

assert.strictEqual((await fetch(base)).status, 401);
assert.strictEqual((await post(JSON.stringify({ text: PASTE }), {})).status, 401);
assert.strictEqual((await post(JSON.stringify({ text: PASTE }), { Authorization: 'Bearer test-token' })).status, 401);

let r = await post(JSON.stringify({ text: PASTE }));
assert.strictEqual(r.status, 200);
let j = await r.json();
assert.strictEqual(j.saved, true);
assert.strictEqual(j.snapshot.uploadDate, '2001-03-04T21:05');
assert.deepStrictEqual(j.uploads, ['2001-03-04T21:05', '2001-02-01T08:00']);
j = await (await post(JSON.stringify({ text: PASTE }))).json();
assert.strictEqual(j.saved, false);
assert.strictEqual(j.uploads.length, 2);

assert.strictEqual((await post(JSON.stringify({ text: 'x'.repeat(70 * 1024) }))).status, 413);
r = await post(JSON.stringify({ text: 'not a settings page' }));
assert.strictEqual(r.status, 400);
assert.match((await r.json()).error, /Pump Profile settings/);
assert.strictEqual((await post('{nope')).status, 400);

r = await fetch(base, { headers: BASIC });
assert.strictEqual(r.status, 200);
assert.strictEqual((await r.json()).snapshot.uploadDate, '2001-03-04T21:05');
r = await fetch(base + '?at=2001-02-15', { headers: BASIC });
assert.strictEqual((await r.json()).snapshot.uploadDate, '2001-02-01T08:00');
assert.strictEqual((await fetch(base + '?at=yesterday', { headers: BASIC })).status, 400);

// The tool: latest on or before `at`, whole day counts for a date.
assert.strictEqual((await tool({})).snapshot.uploadDate, '2001-03-04T21:05');
assert.strictEqual((await tool({ at: '2001-03-04' })).snapshot.uploadDate, '2001-03-04T21:05');
assert.strictEqual((await tool({ at: '2001-03-04T21:00' })).snapshot.uploadDate, '2001-02-01T08:00');
const none = await tool({ at: '2001-01-31' });
assert.deepStrictEqual([none.snapshot, none.uploads.length], [null, 2]);
assert.match(none.caveat, /Discuss with your endocrinologist before changing settings/);
assert.ok((await tool({ at: '1 March' })).error);
console.log('OK: store, get_pump_settings and /api/pump-settings');
setTimeout(() => process.exit(0), 100);
