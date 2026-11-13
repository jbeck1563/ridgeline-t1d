/**
 * Persistent store (SQLite via Node's built-in node:sqlite).
 *
 * Holds NORMALISED records, not raw Glooko blobs:
 *   - cgm:      one row per 5-minute reading (epoch seconds, value mmol/L, velocity)
 *   - bolus:    one row per bolus event (epoch, units, carbs, iob, class)
 *   - settings: effective-dated pump-setting snapshots (the JSON we already parse),
 *               resolved by date at query time exactly as the original code did
 *   - day_status: which UTC days are COMPLETE (immutable, never re-fetched) vs
 *                 partial (today / the boundary, always re-pulled on top-up)
 *
 * Normalising at ingest means a Glooko markup change can corrupt at most one
 * top-up, never the archive: the archive is in our own stable schema. The raw
 * Glooko parsing stays at the edge (analytics.processUnifiedGlookoData etc).
 *
 * The DB file lives at OMNI_DB_PATH (a mounted host folder in Docker) so the
 * archive survives container rebuilds.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

let db = null;

// Bump SCHEMA_VERSION whenever the set of data we derive-and-store changes
// (new series, new tables) so older archives self-heal. On a version mismatch,
// an existing archive's data is wiped and re-pulled fresh on the next query,
// rather than leaving days that predate a feature missing its data silently.
//   1 = cgm + bolus + settings + daily_insulin
//   2 = + basal_state + device_event (basal delivery states, pod/sensor changes)
//   3 = force re-pull: clears any basal_state rows written by an earlier build
//       whose derivation could differ, so states are re-derived from current code
//   4 = basal bar edge-pairing fix (re-derive all basal states)
//   5 = widened bolus table: delivered/programmed/recommendation split, override,
//       interrupted, bg input/source, is_manual
//   6 = device-neutral ingest (Tandem t:slim X2 / Control-IQ): automatic
//       correction boluses, pump_mode table, pumpOp5LimitedMode now fetched,
//       device_event type 'site' (was 'pod') plus 'cartridge'
const SCHEMA_VERSION = 6;
// NOTE: the `meta` table added below is purely additive (a new, independent
// table) and does not require a SCHEMA_VERSION bump — bumping it would trigger
// the self-heal wipe above and force a full destructive re-sync of an already
// -populated archive for no reason. `CREATE TABLE IF NOT EXISTS` alone is
// sufficient to add it to existing databases.

export function initDb(dbPath = process.env.OMNI_DB_PATH || '/data/omni-endo.db') {
  if (db) return db;
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* dir may already exist */
  }
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cgm (
      epoch INTEGER PRIMARY KEY,
      val   REAL NOT NULL,
      vel   REAL
    );
    CREATE TABLE IF NOT EXISTS bolus (
      epoch        INTEGER PRIMARY KEY,
      units        REAL,    -- canonical amount = delivered (kept for existing analytics)
      delivered    REAL,    -- insulinDelivered: what actually went in
      programmed   REAL,    -- insulinProgrammed: what was commanded
      rec_total    REAL,    -- totalInsulinRecommendation: algorithm's suggestion
      rec_corr     REAL,    -- insulinRecommendationForCorrection
      rec_carb     REAL,    -- insulinRecommendationForCarbs
      carbs        REAL,
      iob          REAL,    -- insulinOnBoard at delivery (Glooko-computed)
      bg_input     REAL,    -- bloodGlucoseInput the bolus calc used, if any
      bg_source    TEXT,    -- bloodGlucoseInputSource ('CGM' / manual / null)
      is_manual    INTEGER, -- 1 = user-initiated manual bolus
      interrupted  INTEGER, -- 1 = delivered cut short of programmed
      override     TEXT,    -- 'above' | 'below' | null vs recommendation
      class        TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      effective_epoch INTEGER PRIMARY KEY,
      effective_iso   TEXT NOT NULL,
      json            TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_event (
      epoch   INTEGER NOT NULL,
      type    TEXT NOT NULL,        -- 'site' | 'cartridge' | 'sensor' ('pod' = legacy 'site')
      day_utc TEXT NOT NULL,
      PRIMARY KEY (epoch, type)
    );
    CREATE TABLE IF NOT EXISTS basal_state (
      start_epoch INTEGER PRIMARY KEY,
      end_epoch   INTEGER NOT NULL,
      state       TEXT NOT NULL,      -- 'normal' | 'suspend' | 'max' | 'limited'
      day_utc     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pump_mode (
      start_epoch INTEGER NOT NULL,
      end_epoch   INTEGER NOT NULL,
      mode        TEXT NOT NULL,      -- 'automatic' | 'manual' | 'sleep' | 'exercise' | 'limited' | 'activity'
      day_utc     TEXT NOT NULL,
      PRIMARY KEY (start_epoch, mode)
    );
    CREATE TABLE IF NOT EXISTS daily_insulin (
      day_utc     TEXT PRIMARY KEY,   -- 'YYYY-MM-DD'
      day_epoch   INTEGER NOT NULL,
      basal_units REAL,
      bolus_units REAL,
      total_units REAL,
      complete    INTEGER NOT NULL,   -- 1 = past day (final), 0 = today (provisional)
      ingested_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS day_status (
      day_utc   TEXT PRIMARY KEY,   -- 'YYYY-MM-DD'
      complete  INTEGER NOT NULL,   -- 1 = immutable past day, 0 = partial
      ingested_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Google Health (src/health.js). Additive and independent of Glooko: not in
    -- the self-heal wipe below and not read by getStreamMaxima, so a Glooko
    -- re-pull never touches them and they never distort Glooko coverage.
    -- *_local epochs are local wall-clock time encoded as if UTC (physicalTime
    -- + utcOffset), the same frame as Glooko's epochs.
    CREATE TABLE IF NOT EXISTS health_sample (
      type        TEXT NOT NULL,      -- 'weight' (kg) | 'body_fat' (%); later body
                                      -- composition types land here too, e.g.
                                      -- 'muscle_mass' (kg), 'body_water' (%),
                                      -- 'bone_mass' (kg), 'visceral_fat' (index), 'bmr' (kcal)
      utc_epoch   INTEGER NOT NULL,
      local_epoch INTEGER NOT NULL,
      value       REAL NOT NULL,
      platform    TEXT,               -- e.g. HEALTH_CONNECT, FITBIT
      app         TEXT NOT NULL DEFAULT '',  -- source package name ('' if unknown)
      PRIMARY KEY (type, utc_epoch, app)
    );
    CREATE TABLE IF NOT EXISTS health_session (
      type        TEXT NOT NULL,      -- 'sleep' | 'exercise'
      start_utc   INTEGER NOT NULL,
      end_utc     INTEGER NOT NULL,
      start_local INTEGER NOT NULL,
      end_local   INTEGER NOT NULL,
      subtype     TEXT,               -- exercise type, or 'main' / 'nap' for sleep
      json        TEXT NOT NULL,      -- normalised details (stage minutes, avg HR, ...)
      platform    TEXT,
      app         TEXT,
      PRIMARY KEY (type, start_utc)
    );
    CREATE TABLE IF NOT EXISTS health_daily (
      day_local TEXT NOT NULL,        -- 'YYYY-MM-DD' in the user's time zone
      type      TEXT NOT NULL,        -- 'steps' | 'active_min' | 'rhr' | 'hrv'
      value     REAL NOT NULL,
      platform  TEXT,
      PRIMARY KEY (day_local, type)
    );
    -- Tandem pump settings pasted from t:connect (src/tandem-settings.js). Additive,
    -- user-entered and not re-pullable: never in the self-heal wipe below.
    CREATE TABLE IF NOT EXISTS pump_settings_upload (
      upload_local TEXT PRIMARY KEY,  -- 'YYYY-MM-DDTHH:MM', pump-local upload time
      json         TEXT NOT NULL,     -- the parsed snapshot
      imported_at  INTEGER NOT NULL   -- epoch seconds
    );
  `);

  // Self-heal: if this archive was written by an older schema, its tables for
  // newly-added series are empty for days pulled before the feature existed.
  // The top-up path keys off CGM recency and so would never backfill them.
  // Wipe the data (not the structure) and reset the stamp; the next query
  // cold-starts a fresh pull that populates every table for the whole span.
  const stored = db.prepare('PRAGMA user_version').get();
  const storedVersion = stored ? Object.values(stored)[0] : 0;
  // Only when Glooko credentials are configured: an offline archive (e.g. the
  // shipped example database) cannot be re-pulled, so wiping it would just
  // destroy it. It keeps its old stamp and is healed once credentials appear.
  const online = Boolean(
    process.env.GLOOKO_EMAIL?.trim() && process.env.GLOOKO_PASSWORD?.trim()
  );
  if (storedVersion > 0 && storedVersion < SCHEMA_VERSION) {
    if (!online) return db;
    db.exec(
      'DELETE FROM cgm; DELETE FROM bolus; DELETE FROM settings; ' +
        'DELETE FROM daily_insulin; DELETE FROM basal_state; ' +
        'DELETE FROM device_event; DELETE FROM day_status; DELETE FROM pump_mode;'
    );
  }
  // Stamp the current version (covers both fresh DBs at 0 and just-healed ones).
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  return db;
}

function d() {
  if (!db) initDb();
  return db;
}

// --- ingest ---------------------------------------------------------------

/**
 * Upsert a unified timeline (CGM + bolus rows) and settings snapshots into the
 * store. Idempotent: re-ingesting the same epochs overwrites, so re-pulling a
 * partial day and later the complete day converges correctly.
 */
export function ingestTimeline(timeline, settingsSnapshots) {
  const conn = d();
  const cgmStmt = conn.prepare(
    `INSERT INTO cgm (epoch, val, vel) VALUES (?, ?, ?)
     ON CONFLICT(epoch) DO UPDATE SET val=excluded.val, vel=excluded.vel`
  );
  const bolStmt = conn.prepare(
    `INSERT INTO bolus
       (epoch, units, delivered, programmed, rec_total, rec_corr, rec_carb,
        carbs, iob, bg_input, bg_source, is_manual, interrupted, override, class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(epoch) DO UPDATE SET
       units=excluded.units, delivered=excluded.delivered,
       programmed=excluded.programmed, rec_total=excluded.rec_total,
       rec_corr=excluded.rec_corr, rec_carb=excluded.rec_carb,
       carbs=excluded.carbs, iob=excluded.iob, bg_input=excluded.bg_input,
       bg_source=excluded.bg_source, is_manual=excluded.is_manual,
       interrupted=excluded.interrupted, override=excluded.override,
       class=excluded.class`
  );
  conn.exec('BEGIN');
  try {
    for (const item of timeline) {
      if (item.type === 'CGM') {
        cgmStmt.run(item.epoch, item.val, item.vel ?? null);
      } else if (item.type === 'BOLUS') {
        bolStmt.run(
          item.epoch,
          item.units ?? null,
          item.delivered ?? null,
          item.programmed ?? null,
          item.recTotal ?? null,
          item.recCorrection ?? null,
          item.recCarbs ?? null,
          item.carbs ?? null,
          item.iob ?? null,
          item.bgInput ?? null,
          item.bgSource ?? null,
          item.isManual ? 1 : 0,
          item.interrupted ? 1 : 0,
          item.override ?? null,
          item.class ?? null
        );
      }
    }
    if (settingsSnapshots && settingsSnapshots.length) {
      const setStmt = conn.prepare(
        `INSERT INTO settings (effective_epoch, effective_iso, json) VALUES (?, ?, ?)
         ON CONFLICT(effective_epoch) DO UPDATE SET json=excluded.json`
      );
      for (const s of settingsSnapshots) {
        const eIso = s.activeTimestamp;
        const eEpoch = Math.floor(new Date(eIso).getTime() / 1000);
        setStmt.run(eEpoch, eIso, JSON.stringify(s.settings));
      }
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Mark a set of UTC day strings with a completeness flag.
 * complete=1 days are treated as immutable and never re-fetched.
 */
export function markDays(dayStrings, complete) {
  const conn = d();
  const stmt = conn.prepare(
    `INSERT INTO day_status (day_utc, complete, ingested_at) VALUES (?, ?, ?)
     ON CONFLICT(day_utc) DO UPDATE SET complete=excluded.complete, ingested_at=excluded.ingested_at`
  );
  const now = Date.now();
  conn.exec('BEGIN');
  try {
    for (const day of dayStrings) stmt.run(day, complete ? 1 : 0, now);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upsert per-day insulin totals. Past days are stored complete (final); today
 * is stored provisional (complete=0) and overwritten on each top-up until the
 * day is over, because today's totals keep accruing.
 */
export function ingestDailyInsulin(records, todayUtc) {
  if (!records || !records.length) return;
  const conn = d();
  const stmt = conn.prepare(
    `INSERT INTO daily_insulin
       (day_utc, day_epoch, basal_units, bolus_units, total_units, complete, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_utc) DO UPDATE SET
       day_epoch=excluded.day_epoch,
       basal_units=excluded.basal_units,
       bolus_units=excluded.bolus_units,
       total_units=excluded.total_units,
       complete=excluded.complete,
       ingested_at=excluded.ingested_at`
  );
  const now = Date.now();
  conn.exec('BEGIN');
  try {
    for (const r of records) {
      const complete = r.dayUtc < todayUtc ? 1 : 0;
      stmt.run(
        r.dayUtc,
        r.dayEpoch,
        r.basalUnits,
        r.bolusUnits,
        r.totalUnits,
        complete,
        now
      );
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upsert basal-state intervals (normal/suspend/max/limited), keyed by start
 * epoch. Idempotent: re-deriving a day's intervals overwrites by start time.
 * Note: a re-pull whose interval boundaries shift slightly could leave a stale
 * old interval; we clear the window's day(s) first to keep it clean.
 */
export function ingestBasalStates(intervals) {
  if (!intervals || !intervals.length) return;
  const conn = d();
  const days = [...new Set(intervals.map((i) => i.start.split('T')[0]))];
  const del = conn.prepare('DELETE FROM basal_state WHERE day_utc = ?');
  const stmt = conn.prepare(
    `INSERT INTO basal_state (start_epoch, end_epoch, state, day_utc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(start_epoch) DO UPDATE SET
       end_epoch=excluded.end_epoch, state=excluded.state, day_utc=excluded.day_utc`
  );
  conn.exec('BEGIN');
  try {
    for (const day of days) del.run(day);
    for (const i of intervals) {
      stmt.run(i.startEpoch, i.endEpoch, i.state, i.start.split('T')[0]);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Replace the pump-mode intervals that start inside [fromEpoch, toEpoch] (the
 * pulled window) with freshly derived ones. Modes may overlap (sleep inside
 * automatic), so rows are keyed by (start, mode).
 */
export function ingestPumpModes(intervals, fromEpoch, toEpoch) {
  const conn = d();
  const del = conn.prepare(
    'DELETE FROM pump_mode WHERE start_epoch BETWEEN ? AND ?'
  );
  const stmt = conn.prepare(
    `INSERT INTO pump_mode (start_epoch, end_epoch, mode, day_utc) VALUES (?, ?, ?, ?)
     ON CONFLICT(start_epoch, mode) DO UPDATE SET end_epoch=excluded.end_epoch`
  );
  conn.exec('BEGIN');
  try {
    del.run(fromEpoch, toEpoch);
    for (const i of intervals) {
      stmt.run(i.startEpoch, i.endEpoch, i.mode, i.start.split('T')[0]);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/** Pump-mode intervals overlapping [startEpoch, endEpoch] (seconds), ordered. */
export function getPumpModes(startEpoch, endEpoch) {
  return d()
    .prepare(
      `SELECT start_epoch, end_epoch, mode FROM pump_mode
        WHERE end_epoch > ? AND start_epoch < ?
        ORDER BY start_epoch, mode`
    )
    .all(startEpoch, endEpoch)
    .map((r) => ({
      mode: r.mode,
      start: new Date(r.start_epoch * 1000).toISOString(),
      end: new Date(r.end_epoch * 1000).toISOString(),
      startEpoch: r.start_epoch,
      endEpoch: r.end_epoch,
      minutes: Math.round((r.end_epoch - r.start_epoch) / 60),
    }));
}

/**
 * Upsert device events (site, cartridge and sensor changes). Keyed by
 * (epoch, type), so re-pulling the same event is idempotent and the types
 * never collide.
 */
export function ingestDeviceEvents(events) {
  const conn = d();
  const all = [
    ...(events.siteChanges || []).map((e) => ({ ...e, type: 'site' })),
    ...(events.cartridgeChanges || []).map((e) => ({ ...e, type: 'cartridge' })),
    ...(events.sensorChanges || []).map((e) => ({ ...e, type: 'sensor' })),
  ];
  if (!all.length) return;
  const stmt = conn.prepare(
    `INSERT INTO device_event (epoch, type, day_utc) VALUES (?, ?, ?)
     ON CONFLICT(epoch, type) DO NOTHING`
  );
  conn.exec('BEGIN');
  try {
    for (const e of all) {
      const day = new Date(e.epoch * 1000).toISOString().split('T')[0];
      stmt.run(e.epoch, e.type, day);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Device events within [startEpoch, endEpoch] (seconds), split by type.
 * Legacy 'pod' rows (schema <= 5) read as site changes.
 * Returns { siteChanges, cartridgeChanges, sensorChanges }, each [{epoch,time}].
 */
export function getDeviceEvents(startEpoch, endEpoch) {
  const rows = d()
    .prepare(
      `SELECT epoch, type FROM device_event
        WHERE epoch BETWEEN ? AND ? ORDER BY epoch`
    )
    .all(startEpoch, endEpoch);
  const siteChanges = [];
  const cartridgeChanges = [];
  const sensorChanges = [];
  for (const r of rows) {
    const item = { epoch: r.epoch, time: new Date(r.epoch * 1000).toISOString() };
    if (r.type === 'site' || r.type === 'pod') siteChanges.push(item);
    else if (r.type === 'cartridge') cartridgeChanges.push(item);
    else if (r.type === 'sensor') sensorChanges.push(item);
  }
  return { siteChanges, cartridgeChanges, sensorChanges };
}


/**
 * Basal-state intervals overlapping [startEpoch, endEpoch] (seconds), ordered.
 * Returns [{ state, start, end, startEpoch, endEpoch, minutes }].
 */
export function getBasalStates(startEpoch, endEpoch) {
  const rows = d()
    .prepare(
      `SELECT start_epoch, end_epoch, state FROM basal_state
        WHERE end_epoch > ? AND start_epoch < ?
        ORDER BY start_epoch`
    )
    .all(startEpoch, endEpoch);
  return rows.map((r) => ({
    state: r.state,
    start: new Date(r.start_epoch * 1000).toISOString(),
    end: new Date(r.end_epoch * 1000).toISOString(),
    startEpoch: r.start_epoch,
    endEpoch: r.end_epoch,
    minutes: Math.round((r.end_epoch - r.start_epoch) / 60),
  }));
}


/**
 * Daily insulin rows whose day falls within [startEpoch, endEpoch] (seconds).
 * Returns [{ dayUtc, basalUnits, bolusUnits, totalUnits, complete }].
 */
export function getDailyInsulin(startEpoch, endEpoch) {
  const startDay = new Date(startEpoch * 1000).toISOString().split('T')[0];
  // Half-open on the end: if the window ends exactly at a day's 00:00:00 UTC,
  // that day has no duration inside the window and must be excluded (this was
  // the cause of an off-by-one day count, e.g. a 10-day window reporting 11).
  const endDate = new Date(endEpoch * 1000);
  const endsAtMidnight =
    endDate.getUTCHours() === 0 &&
    endDate.getUTCMinutes() === 0 &&
    endDate.getUTCSeconds() === 0;
  const endRef = endsAtMidnight ? new Date(endEpoch * 1000 - 1000) : endDate;
  const endDay = endRef.toISOString().split('T')[0];
  const rows = d()
    .prepare(
      `SELECT day_utc, basal_units, bolus_units, total_units, complete
         FROM daily_insulin
        WHERE day_utc BETWEEN ? AND ?
        ORDER BY day_utc`
    )
    .all(startDay, endDay);
  return rows.map((r) => ({
    dayUtc: r.day_utc,
    basalUnits: r.basal_units,
    bolusUnits: r.bolus_units,
    totalUnits: r.total_units,
    complete: !!r.complete,
  }));
}



/** Returns the set of complete day strings as a Set. */
export function getCompleteDays() {
  const rows = d()
    .prepare('SELECT day_utc FROM day_status WHERE complete=1')
    .all();
  return new Set(rows.map((r) => r.day_utc));
}

/** Newest stored CGM epoch (seconds), or null if empty. */
export function getLatestCgmEpoch() {
  const row = d().prepare('SELECT MAX(epoch) m FROM cgm').get();
  return row && row.m ? row.m : null;
}

/** Oldest stored CGM epoch (seconds), or null if empty. */
export function getEarliestCgmEpoch() {
  const row = d().prepare('SELECT MIN(epoch) m FROM cgm').get();
  return row && row.m ? row.m : null;
}

/** Total stored CGM row count. Used to detect whether a pull added anything. */
export function getCgmCount() {
  const row = d().prepare('SELECT COUNT(*) c FROM cgm').get();
  return row ? row.c : 0;
}

/**
 * Small persisted key-value store, currently used to remember the oldest
 * epoch a live backfill probe has confirmed to be empty (see
 * backfillProbedFloorEpoch in range.js), so a wide orientation query
 * (e.g. start=2000-01-01) does not re-hit Glooko for the same empty
 * historical span on every call.
 */
export function getMeta(key) {
  const row = d().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  d()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .run(key, String(value));
}

/**
 * Newest stored epoch (seconds) across EVERY data stream, returned per stream
 * plus the overall minimum-of-maxima. The sync top-up keys off the OLDEST of
 * the per-stream maxima ("coverageEpoch"), not CGM alone: if one stream (e.g.
 * daily insulin) lagged behind a Glooko sync, CGM recency would wrongly report
 * the archive as current and that stream would never be backfilled. Pulling
 * from the oldest stream max guarantees every stream is brought up to date.
 *
 * Streams with no rows are ignored (null), so an as-yet-unused table does not
 * peg coverage at the epoch (the start of time). Returns null fields where a
 * stream is empty, and coverageEpoch = null only when ALL streams are empty.
 */
export function getStreamMaxima() {
  const conn = d();
  const maxOf = (sql) => {
    const r = conn.prepare(sql).get();
    return r && r.m ? r.m : null;
  };
  const cgm = maxOf('SELECT MAX(epoch) m FROM cgm');
  const bolus = maxOf('SELECT MAX(epoch) m FROM bolus');
  const basal = maxOf('SELECT MAX(end_epoch) m FROM basal_state');
  // daily_insulin is keyed by day string; convert its newest day to an epoch.
  const diRow = conn.prepare('SELECT MAX(day_epoch) m FROM daily_insulin').get();
  const dailyInsulin = diRow && diRow.m ? diRow.m : null;

  const present = [cgm, bolus, basal, dailyInsulin].filter((v) => v != null);
  const coverageEpoch = present.length ? Math.min(...present) : null;
  return { cgm, bolus, basal, dailyInsulin, coverageEpoch };
}

/**
 * Newest stored epoch (seconds) across all streams (the MAX of maxima), used
 * for staleness reporting: "how fresh is the most recent thing we have".
 * null if the archive is entirely empty.
 */
export function getNewestDataEpoch() {
  const { cgm, bolus, basal, dailyInsulin } = getStreamMaxima();
  const present = [cgm, bolus, basal, dailyInsulin].filter((v) => v != null);
  return present.length ? Math.max(...present) : null;
}

/**
 * Rebuild a unified, sorted timeline for [startEpoch, endEpoch] (seconds)
 * directly from the store, in the same shape processUnifiedGlookoData produces,
 * so the analytics functions consume it unchanged.
 */
export function getTimeline(startEpoch, endEpoch) {
  const conn = d();
  const cgm = conn
    .prepare('SELECT epoch, val, vel FROM cgm WHERE epoch BETWEEN ? AND ? ORDER BY epoch')
    .all(startEpoch, endEpoch)
    .map((r) => ({
      epoch: r.epoch,
      type: 'CGM',
      val: r.val,
      vel: r.vel,
      time: new Date(r.epoch * 1000).toISOString(),
    }));
  const bolus = conn
    .prepare(
      `SELECT epoch, units, delivered, programmed, rec_total, rec_corr, rec_carb,
              carbs, iob, bg_input, bg_source, is_manual, interrupted, override, class
         FROM bolus WHERE epoch BETWEEN ? AND ? ORDER BY epoch`
    )
    .all(startEpoch, endEpoch)
    .map((r) => ({
      epoch: r.epoch,
      type: 'BOLUS',
      units: r.units,
      delivered: r.delivered,
      programmed: r.programmed,
      recTotal: r.rec_total,
      recCorrection: r.rec_corr,
      recCarbs: r.rec_carb,
      carbs: r.carbs,
      iob: r.iob,
      bgInput: r.bg_input,
      bgSource: r.bg_source,
      isManual: !!r.is_manual,
      interrupted: !!r.interrupted,
      override: r.override,
      class: r.class,
      time: new Date(r.epoch * 1000).toISOString(),
    }));
  return [...cgm, ...bolus].sort((a, b) => a.epoch - b.epoch);
}

/**
 * Settings snapshots effective at or before endEpoch, in the
 * { activeTimestamp, settings } shape getActiveSettings produced, including the
 * one in force at the start of the window (the most recent prior snapshot).
 */
export function getSettingsHistory(startEpoch, endEpoch) {
  const conn = d();
  const rows = conn
    .prepare('SELECT effective_epoch, effective_iso, json FROM settings ORDER BY effective_epoch')
    .all();
  if (!rows.length) return [];
  const mapped = rows.map((r) => ({
    epoch: r.effective_epoch,
    activeTimestamp: r.effective_iso,
    settings: JSON.parse(r.json),
  }));
  // Baseline: last snapshot effective at or before window start.
  const baselineIdx = mapped.findLastIndex((s) => s.epoch <= startEpoch);
  const startIndex = baselineIdx !== -1 ? baselineIdx : 0;
  return mapped
    .slice(startIndex)
    .filter((s) => s.epoch <= endEpoch)
    .map((s) => ({ activeTimestamp: s.activeTimestamp, settings: s.settings }));
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Google Health -------------------------------------------------------

/** Upsert normalised Google Health rows (see src/health.js) in one transaction. */
export function ingestHealth({ samples = [], sessions = [], daily = [] }) {
  const conn = d();
  const smp = conn.prepare(
    `INSERT INTO health_sample (type, utc_epoch, local_epoch, value, platform, app)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(type, utc_epoch, app) DO UPDATE SET
       local_epoch=excluded.local_epoch, value=excluded.value, platform=excluded.platform`
  );
  const ses = conn.prepare(
    `INSERT INTO health_session
       (type, start_utc, end_utc, start_local, end_local, subtype, json, platform, app)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(type, start_utc) DO UPDATE SET
       end_utc=excluded.end_utc, start_local=excluded.start_local,
       end_local=excluded.end_local, subtype=excluded.subtype, json=excluded.json,
       platform=excluded.platform, app=excluded.app`
  );
  const day = conn.prepare(
    `INSERT INTO health_daily (day_local, type, value, platform) VALUES (?, ?, ?, ?)
     ON CONFLICT(day_local, type) DO UPDATE SET value=excluded.value, platform=excluded.platform`
  );
  conn.exec('BEGIN');
  try {
    for (const r of samples) smp.run(r.type, r.utcEpoch, r.localEpoch, r.value, r.platform ?? null, r.app ?? '');
    for (const r of sessions)
      ses.run(r.type, r.startUtc, r.endUtc, r.startLocal, r.endLocal, r.subtype ?? null,
        JSON.stringify(r.details ?? {}), r.platform ?? null, r.app ?? null);
    for (const r of daily) day.run(r.day, r.type, r.value, r.platform ?? null);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/** Health rows whose local time falls in [startLocal, endLocal] (epoch seconds, Glooko frame). */
export function getHealth(startLocal, endLocal) {
  const conn = d();
  const dayOf = (e) => new Date(e * 1000).toISOString().slice(0, 10);
  const samples = conn
    .prepare(
      `SELECT type, utc_epoch utcEpoch, local_epoch localEpoch, value, platform, app
       FROM health_sample WHERE local_epoch BETWEEN ? AND ? ORDER BY local_epoch`
    )
    .all(startLocal, endLocal);
  // A session belongs to the window by its end (a night is dated by its wake time).
  const sessions = conn
    .prepare(
      `SELECT type, start_utc startUtc, end_utc endUtc, start_local startLocal,
              end_local endLocal, subtype, json, platform, app
       FROM health_session WHERE end_local BETWEEN ? AND ? ORDER BY start_local`
    )
    .all(startLocal, endLocal)
    .map(({ json, ...r }) => ({ ...r, details: JSON.parse(json) }));
  const daily = conn
    .prepare(
      `SELECT day_local day, type, value, platform FROM health_daily
       WHERE day_local BETWEEN ? AND ? ORDER BY day_local`
    )
    .all(dayOf(startLocal), dayOf(endLocal));
  return { samples, sessions, daily };
}

// --- Pasted Tandem pump settings ------------------------------------------

/** Store a parsed snapshot. Returns false (and changes nothing) when that upload is already stored. */
export function savePumpSettings(snapshot) {
  const r = d()
    .prepare('INSERT OR IGNORE INTO pump_settings_upload (upload_local, json, imported_at) VALUES (?, ?, ?)')
    .run(snapshot.uploadDate, JSON.stringify(snapshot), Math.floor(Date.now() / 1000));
  return r.changes === 1;
}

/** Stored upload stamps, newest first. */
export function listPumpSettingsUploads() {
  return d()
    .prepare('SELECT upload_local FROM pump_settings_upload ORDER BY upload_local DESC')
    .all()
    .map((r) => r.upload_local);
}

/** The latest snapshot uploaded at or before `atLocal` ('YYYY-MM-DDTHH:MM'), or null. */
export function getPumpSettingsAt(atLocal) {
  const row = d()
    .prepare('SELECT json FROM pump_settings_upload WHERE upload_local <= ? ORDER BY upload_local DESC LIMIT 1')
    .get(atLocal);
  return row ? JSON.parse(row.json) : null;
}

// Test helper: wipe everything.
export function _wipe() {
  const conn = d();
  conn.exec('DELETE FROM cgm; DELETE FROM bolus; DELETE FROM settings; DELETE FROM day_status; DELETE FROM daily_insulin; DELETE FROM basal_state; DELETE FROM device_event; DELETE FROM pump_mode;');
}
