/**
 * Range layer (now archive-backed).
 *
 * Every question is answered from the local SQLite archive. Because past days
 * are immutable, the archive only ever needs topping up:
 *
 *   1. TOP-UP: on every question, pull from the day after the newest stored
 *      COMPLETE day up to now, ingest it, and mark newly-complete days. The
 *      current (incomplete) day is always re-pulled and stored as partial, so
 *      its filling-in tail stays current. This is the small, cheap fetch.
 *
 *   2. BACKFILL: if the question reaches further back than the oldest stored
 *      reading, pull the missing older span once and ingest it. Thereafter it
 *      is permanent and never re-fetched.
 *
 *   3. SERVE: build the timeline and settings for the requested window straight
 *      from the archive and hand them to the analytics functions unchanged.
 *
 * The expensive historical pull therefore happens at most once per span, ever,
 * rather than once per container life. Glooko is touched only for genuine gaps.
 *
 * Relative date language is resolved by the model into ISO timestamps; this
 * layer only deals in ISO and epochs.
 */

import { fetchGlookoRange } from './glooko.js';
import {
  processUnifiedGlookoData,
  getActiveSettings,
  extractDailyInsulin,
  deriveBasalStates,
  derivePumpModes,
  detectDevice,
  extractDeviceEvents,
} from './analytics.js';
import {
  initDb,
  ingestTimeline,
  ingestDailyInsulin,
  ingestBasalStates,
  ingestDeviceEvents,
  ingestPumpModes,
  markDays,
  getLatestCgmEpoch,
  getEarliestCgmEpoch,
  getStreamMaxima,
  getTimeline,
  getSettingsHistory,
  getDailyInsulin,
  getBasalStates,
  getDeviceEvents,
  getPumpModes,
  getMeta,
  setMeta,
} from './store.js';
// sync.js imports pullAndIngest + date helpers from THIS module. The cycle is
// safe because both sides reference the imported bindings only inside functions
// invoked at call time, never during module evaluation.
import { runColdStart, withSyncLock, yearBatches, pullBatch, MAX_EMPTY_BATCHES } from './sync.js';

export const CAPS = {
  summaryMaxDays: 400,
  timelineMaxDays: 21,
  bolusMaxDays: 92,
  hourlyMaxDays: 400,
};

// A request whose end is within this margin of the freshest stored reading is
// treated as already covered. CGM lags "now" by minutes, the current day is
// never complete, and sensors have short gaps, so without a tolerance every
// "today" question would refetch. 6 hours absorbs that routine lag while still
// pulling when the server has genuinely been idle for longer (e.g. overnight).
const COVERAGE_TOLERANCE_SECONDS = 6 * 60 * 60;


initDb();

export function assertIsoDate(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${label} must be an ISO 8601 timestamp (e.g. 2026-06-19T00:00:00.000Z). Received: ${JSON.stringify(
        value
      )}`
    );
  }
  return new Date(value).toISOString();
}

export function spanDays(startISO, endISO) {
  return (Date.parse(endISO) - Date.parse(startISO)) / 86400000;
}

export function assertWithinCap(startISO, endISO, capDays, toolName) {
  const span = spanDays(startISO, endISO);
  if (span < 0) throw new Error('Start date is after end date.');
  if (span > capDays) {
    throw new Error(
      `Requested window is ${span.toFixed(
        1
      )} days, which exceeds the ${capDays}-day limit for ${toolName}. ` +
        `Request a narrower window. For wide overviews use get_diabetes_summary, ` +
        `which aggregates and tolerates long spans.`
    );
  }
}

export function dayStr(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().split('T')[0];
}

export function startOfTodayEpochSeconds() {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return Math.floor(t.getTime() / 1000);
}

/** Complete UTC days strictly before today, within [fromEpoch, toEpoch]. */
function completeDaysInSpan(fromEpoch, toEpoch) {
  const days = [];
  const todayStart = startOfTodayEpochSeconds();
  let cursor = new Date(fromEpoch * 1000);
  cursor.setUTCHours(0, 0, 0, 0);
  let c = Math.floor(cursor.getTime() / 1000);
  while (c <= toEpoch) {
    if (c < todayStart) days.push(dayStr(c));
    c += 86400;
  }
  return days;
}

/**
 * Pull a Glooko range, normalise it, ingest it, and mark completeness.
 * Days strictly before today are marked complete; today is marked partial.
 */
export async function pullAndIngest(startISO, endISO) {
  const raw = await fetchGlookoRange(startISO, endISO);
  const timeline = processUnifiedGlookoData(raw.data1);
  const settings = getActiveSettings(
    raw.data3,
    Date.parse(startISO),
    Date.parse(endISO)
  );
  ingestTimeline(timeline, settings);

  // Daily insulin totals (basal/bolus/total per day) from the dailyInsulinTotals
  // block. Today is provisional; past days final. Keyed by UTC day.
  const dailyInsulin = extractDailyInsulin(raw.data1);
  // Diagnostic: surface whether the block arrived and how many days parsed.
  // stdout is the MCP channel, so this MUST go to stderr only.
  const hasBlock =
    raw.data1 && raw.data1.series && raw.data1.series.dailyInsulinTotals
      ? Object.keys(raw.data1.series.dailyInsulinTotals).length
      : 'ABSENT';
  console.error(
    `[ridgeline] pull ${startISO.split('T')[0]}..${endISO.split('T')[0]}: ` +
      `dailyInsulinTotals keys=${hasBlock}, parsed=${dailyInsulin.length} days`
  );
  if (dailyInsulin.length) {
    const todayUtc = new Date().toISOString().split('T')[0];
    ingestDailyInsulin(dailyInsulin, todayUtc);
    console.error(`[ridgeline] ingested ${dailyInsulin.length} daily-insulin rows`);
  } else {
    console.error('[ridgeline] NO daily-insulin rows to ingest (block absent or empty)');
  }

  // Basal delivery states (normal/suspend/max/limited), derived from the bar
  // and mode series and stored as collapsed intervals.
  const basalStates = deriveBasalStates(
    raw.data1,
    Math.floor(Date.parse(startISO) / 1000),
    Math.floor(Date.parse(endISO) / 1000)
  );
  if (basalStates.length) ingestBasalStates(basalStates);

  // Device events: site (setSiteChange), cartridge (reservoirChange) and
  // sensor (cgmSensorChange) changes, deduplicated by timestamp.
  ingestDeviceEvents(extractDeviceEvents(raw.data1));

  const fromEpoch = Math.floor(Date.parse(startISO) / 1000);
  const toEpoch = Math.floor(Date.parse(endISO) / 1000);

  // Pump modes (Control-IQ automatic/manual/sleep/exercise, Omnipod 5
  // automatic/manual/limited/activity), stored as possibly-overlapping intervals.
  ingestPumpModes(derivePumpModes(raw.data1), fromEpoch, toEpoch);

  // Device identity for tool output. A pull whose window has no mode series
  // keeps the algorithm an earlier pull detected.
  const device = detectDevice(raw.data3, raw.data1);
  if (device) {
    const prev = JSON.parse(getMeta('device') || 'null');
    device.algorithm ??= prev?.algorithm ?? null;
    setMeta('device', JSON.stringify(device));
  }
  const complete = completeDaysInSpan(fromEpoch, toEpoch);
  if (complete.length) markDays(complete, true);

  // Mark today partial if the window reached into it.
  const todayStart = startOfTodayEpochSeconds();
  if (toEpoch >= todayStart) markDays([dayStr(todayStart)], false);
  // Wall-clock time of the last successful Glooko pull, for the page's freshness line.
  setMeta('glookoSyncedAt', new Date().toISOString());

  return { rawStats: raw.data2 };
}

/**
 * Whether Glooko credentials are configured. When they are NOT, the server runs
 * in OFFLINE / ARCHIVE-ONLY mode: it never logs in, never fetches, and serves
 * only whatever is already in the shipped database. This is the master switch
 * that makes it safe to distribute a prebuilt DB (e.g. example data) without
 * the server trying to mutate it on a machine that has no credentials.
 */
export function glookoConfigured() {
  return Boolean(
    process.env.GLOOKO_EMAIL &&
      process.env.GLOOKO_PASSWORD &&
      process.env.GLOOKO_EMAIL.trim() &&
      process.env.GLOOKO_PASSWORD.trim()
  );
}

/**
 * Ensure the archive covers up to "now" and back to the requested start,
 * pulling only the gaps. Returns Glooko's stats blob ONLY when a fresh pull
 * exactly matching the requested window happened (so insulin/carb aggregates
 * are trustworthy for that window); otherwise null, and the caller computes
 * everything from the archived timeline.
 */
async function ensureCoverage(startISO, endISO) {
  // OFFLINE / ARCHIVE-ONLY: no credentials means never contact Glooko. Serve
  // exactly what is in the database. This is the single gate that guarantees a
  // shipped example DB is never mutated and no login is ever attempted.
  if (!glookoConfigured()) return;

  const reqStartEpoch = Math.floor(Date.parse(startISO) / 1000);
  const reqEndEpoch = Math.floor(Date.parse(endISO) / 1000);

  const { coverageEpoch } = getStreamMaxima();

  // COLD START: archive empty. Year-batched, recent-first historical load from
  // the OMNI_OLDEST_DATE floor. Owned by the sync module (locked).
  if (coverageEpoch === null) {
    await runColdStart((m) => console.error(`[ridgeline] ${m}`));
  } else if (reqEndEpoch > coverageEpoch + COVERAGE_TOLERANCE_SECONDS) {
    // NEWER GAP: the question reaches MEANINGFULLY past our freshest stored data
    // (e.g. asking about today when the archive stops two days ago). CGM always
    // lags "now" by a few minutes and the current day is never "complete", so a
    // tolerance prevents every "today" question from triggering a needless pull;
    // only a real gap (older than the tolerance) fetches. Pull just the missing
    // tail, keyed off the OLDEST stream max so a lagging stream is included, with
    // a short trailing overlap to refresh the partial boundary day.
    const TOPUP_TRAILING = 2 * 86400;
    const from = Math.max(0, coverageEpoch - TOPUP_TRAILING);
    await withSyncLock(() =>
      pullAndIngest(
        new Date(from * 1000).toISOString(),
        new Date(reqEndEpoch * 1000).toISOString()
      )
    );
  }

  // OLDER GAP / BACKFILL: the requested window reaches before the oldest stored
  // reading (a question older than the initial load floor, or a wide orientation
  // probe like start=2000-01-01 per the get_diabetes_summary tool description).
  // Pull that older span once; thereafter it is permanent. Locked so it cannot
  // race the above.
  //
  // Walked backward in YEAR-SIZED batches (same shape as sync.js's cold start),
  // NOT as one single request: a naive single pullAndIngest spanning decades was
  // measured taking 5+ minutes (or hanging) against Glooko's live API for a
  // wide orientation probe, which is well past any client-side tool-call
  // timeout. Batching also lets it stop after MAX_EMPTY_BATCHES consecutive
  // empty years instead of walking the full span.
  //
  // A probe that finds NOTHING (e.g. 2000-01-01 predates the pump entirely)
  // never moves `earliest`, so without the guard below the exact same empty
  // range would be re-fetched from Glooko on every future wide query, forever.
  // backfillProbedFloorEpoch remembers the oldest point we have already probed
  // (whether or not it found data), so a request at or after it skips straight
  // past this whole block.
  const earliest = getEarliestCgmEpoch();
  if (earliest !== null && reqStartEpoch < earliest) {
    const probedFloorRaw = getMeta('backfillProbedFloorEpoch');
    const probedFloor = probedFloorRaw !== null ? Number(probedFloorRaw) : null;
    const alreadyProbed = probedFloor !== null && reqStartEpoch >= probedFloor;
    if (!alreadyProbed) {
      const lowerBound = probedFloor !== null ? Math.max(reqStartEpoch, probedFloor) : reqStartEpoch;
      const batches = yearBatches(lowerBound, earliest).reverse(); // newest-first
      let consecutiveEmpty = 0;
      let reachedFloor = lowerBound;
      for (const [s, e] of batches) {
        reachedFloor = s;
        const produced = await withSyncLock(() => pullBatch(s, e));
        if (produced) {
          consecutiveEmpty = 0;
        } else {
          consecutiveEmpty += 1;
          if (consecutiveEmpty >= MAX_EMPTY_BATCHES) break;
        }
      }
      setMeta('backfillProbedFloorEpoch', reachedFloor);
    }
  }
}

/**
 * Public entry point used by the tools. Tops up + backfills as needed, then
 * builds the window straight from the archive.
 *
 * Returns { startDate, endDate, timeline, stats, settingsHistory, servedFromArchive, statsAreForWiderRange }.
 *
 * stats is always null here (the archive does not keep Glooko's pre-aggregated
 * statistics blob, by design), so computeSummary will recompute insulin/carb
 * aggregates from the archived bolus rows. statsAreForWiderRange is therefore
 * always false: every figure is computed for exactly the requested window.
 */
export async function getProcessedRange(startISO, endISO) {
  await ensureCoverage(startISO, endISO);

  const sEpoch = Math.floor(Date.parse(startISO) / 1000);
  const eEpoch = Math.floor(Date.parse(endISO) / 1000);
  const timeline = getTimeline(sEpoch, eEpoch);
  const settingsHistory = getSettingsHistory(sEpoch, eEpoch);
  const dailyInsulin = getDailyInsulin(sEpoch, eEpoch);
  const basalStates = getBasalStates(sEpoch, eEpoch);
  const deviceEvents = getDeviceEvents(sEpoch, eEpoch);
  const pumpModes = getPumpModes(sEpoch, eEpoch);

  return {
    startDate: startISO,
    endDate: endISO,
    timeline,
    stats: null,
    settingsHistory,
    dailyInsulin,
    basalStates,
    deviceEvents,
    pumpModes,
    device: JSON.parse(getMeta('device') || 'null'),
    servedFromArchive: true,
    statsAreForWiderRange: false,
  };
}
