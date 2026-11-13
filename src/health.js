/**
 * Google Health API ingest (activity, sleep, heart, weight, body fat).
 *
 * Read-only. Credentials come from the environment only:
 *   OMNI_GHEALTH_CLIENT_ID, OMNI_GHEALTH_CLIENT_SECRET, OMNI_GHEALTH_REFRESH_TOKEN
 * (a one-user OAuth client with the three googlehealth.*.readonly scopes).
 *
 * Every point is stored with its real UTC epoch AND a local epoch
 * (physicalTime + utcOffset): local wall-clock time encoded as if UTC, which is
 * exactly the frame Glooko's epochs use, so joins are plain comparisons.
 *
 * Sync is a lazy top-up on the first health tool call (and again once the data
 * is older than HEALTH_STALE_SECONDS), under its OWN lock: a Google outage or an
 * unlinked account never blocks or fails a Glooko pull. Failures are returned
 * as a status object for the tool to show, never thrown at the tool.
 */

import { getMeta, setMeta, ingestHealth } from './store.js';
import { resolveOldestEpoch } from './sync.js';

const API = 'https://health.googleapis.com/v4/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DAY = 86400;
// dailyRollUp caps: 90 days per call, 14 for active-minutes (API reference).
const WINDOW_DAYS = 90;
const ACTIVE_MINUTES_WINDOW_DAYS = 14;
// Re-read the last 14 days on every top-up: the phone can sync to Google Health days
// late, after healthSyncedTo has already moved past those days. Upserts keep it idempotent.
const TRAILING_SECONDS = 14 * DAY;
export const HEALTH_STALE_SECONDS = 6 * 60 * 60;
const MAX_PAGES = 200;

export function healthConfigured() {
  return ['OMNI_GHEALTH_CLIENT_ID', 'OMNI_GHEALTH_CLIENT_SECRET', 'OMNI_GHEALTH_REFRESH_TOKEN'].every(
    (k) => process.env[k]?.trim()
  );
}

export class HealthApiError extends Error {
  constructor(message, { status, reason, hint } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.hint = hint;
  }
}

const HINTS = {
  ACCOUNT_NOT_LINKED:
    'The Google account has no Google Health profile yet. Install the Google Health app on the ' +
    'phone, sign in with the same Google account that granted access, and connect Health Connect ' +
    '(Garmin Connect and Renpho Health must also be allowed to write to Health Connect). ' +
    'Health data appears after the app has synced.',
  invalid_grant:
    'The Google refresh token was revoked or expired. Run the consent helper again and replace ' +
    'OMNI_GHEALTH_REFRESH_TOKEN.',
};

let token = null; // { value, expiresAt }

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.OMNI_GHEALTH_CLIENT_ID.trim(),
      client_secret: process.env.OMNI_GHEALTH_CLIENT_SECRET.trim(),
      refresh_token: process.env.OMNI_GHEALTH_REFRESH_TOKEN.trim(),
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new HealthApiError(`Google token refresh failed (HTTP ${r.status} ${j.error || ''})`.trim(), {
      status: r.status,
      reason: j.error,
      hint: HINTS[j.error],
    });
  }
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function api(pathAndQuery, body) {
  const r = await fetch(`${API}/${pathAndQuery}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    const reason = (e.details || []).find((x) => x.reason)?.reason || e.status;
    throw new HealthApiError(`Google Health API: ${e.message || `HTTP ${r.status}`}`, {
      status: r.status,
      reason,
      hint: HINTS[reason],
    });
  }
  return j;
}

async function listAll(type, filter, pageSize, method = '') {
  const points = [];
  let pageToken = '';
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ filter, pageSize: String(pageSize) });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await api(`dataTypes/${type}/dataPoints${method}?${q}`);
    points.push(...(j.dataPoints || []));
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return points;
}

async function rollUp(type, startDay, endDay, pageSize) {
  const points = [];
  let pageToken = '';
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await api(`dataTypes/${type}/dataPoints:dailyRollUp`, {
      range: { start: { date: dateObj(startDay) }, end: { date: dateObj(endDay) } },
      windowSizeDays: 1,
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    });
    points.push(...(j.rollupDataPoints || []));
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return points;
}

// --- parsing (field names from the v4 REST reference) ---------------------

const dayOf = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);
const rfc3339 = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function dateObj(day) {
  const [year, month, d] = day.split('-').map(Number);
  return { year, month, day: d };
}
const dateStr = (d) =>
  d && `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
/** google-duration ("-18000s", "3600.5s") to whole seconds. */
export const durationSeconds = (s) => (s ? Math.round(parseFloat(s)) : 0);
const utcEpoch = (t) => Math.floor(Date.parse(t) / 1000);
/** Local wall-clock epoch in Glooko's frame: physicalTime + utcOffset. */
export const localEpoch = (t, offset) => utcEpoch(t) + durationSeconds(offset);
const num = (v) => (v == null || v === '' ? null : Number(v));
const source = (dp) => ({
  platform: dp.dataSource?.platform ?? null,
  app: dp.dataSource?.application?.packageName ?? '',
});

function sample(type, t, value, dp) {
  if (!t?.physicalTime || value == null || !Number.isFinite(value)) return null;
  return {
    type,
    utcEpoch: utcEpoch(t.physicalTime),
    localEpoch: localEpoch(t.physicalTime, t.utcOffset),
    value,
    ...source(dp),
  };
}

function session(type, iv, subtype, details, dp) {
  if (!iv?.startTime || !iv?.endTime) return null;
  return {
    type,
    startUtc: utcEpoch(iv.startTime),
    endUtc: utcEpoch(iv.endTime),
    startLocal: localEpoch(iv.startTime, iv.startUtcOffset),
    endLocal: localEpoch(iv.endTime, iv.endUtcOffset ?? iv.startUtcOffset),
    subtype,
    details,
    ...source(dp),
  };
}

const ROLLUP = 'ALL_SOURCES_ROLLUP';

export const parse = {
  weight: (dp) => {
    const g = num(dp.weight?.weightGrams);
    return sample('weight', dp.weight?.sampleTime, g == null ? null : g / 1000, dp);
  },
  'body-fat': (dp) => sample('body_fat', dp.bodyFat?.sampleTime, num(dp.bodyFat?.percentage), dp),
  sleep: (dp) => {
    const s = dp.sleep || {};
    const stages = {};
    for (const st of s.summary?.stagesSummary || []) stages[String(st.type).toLowerCase()] = num(st.minutes);
    // Real Health Connect sleeps carry metadata.mainSleep and no nap flag.
    const main = !s.metadata?.nap && s.metadata?.mainSleep !== false;
    return session('sleep', s.interval, main ? 'main' : 'nap', {
      minutesAsleep: num(s.summary?.minutesAsleep),
      minutesAwake: num(s.summary?.minutesAwake),
      minutesInSleepPeriod: num(s.summary?.minutesInSleepPeriod),
      stages,
    }, dp);
  },
  exercise: (dp) => {
    const x = dp.exercise || {};
    const m = x.metricsSummary || {};
    return session('exercise', x.interval, x.exerciseType || null, {
      name: x.displayName ?? null,
      activeMinutes: x.activeDuration ? Math.round(durationSeconds(x.activeDuration) / 60) : null,
      avgHeartRate: num(m.averageHeartRateBeatsPerMinute),
      calories: m.caloriesKcal ?? null,
      steps: num(m.steps),
    }, dp);
  },
  'daily-resting-heart-rate': (dp) => {
    const v = dp.dailyRestingHeartRate || {};
    const value = num(v.beatsPerMinute);
    return v.date && value != null ? { day: dateStr(v.date), type: 'rhr', value, platform: source(dp).platform } : null;
  },
  'daily-heart-rate-variability': (dp) => {
    const v = dp.dailyHeartRateVariability || {};
    const value = num(v.averageHeartRateVariabilityMilliseconds);
    return v.date && value != null ? { day: dateStr(v.date), type: 'hrv', value, platform: source(dp).platform } : null;
  },
  // Rollups: one point per civil day, already deduplicated by Google across
  // sources (a phone and a watch both counting the same walk count once), so
  // they carry no single data source.
  stepsRollup: (p) => {
    const value = num(p.steps?.countSum);
    return value == null ? null : { day: dateStr(p.civilStartTime?.date), type: 'steps', value, platform: ROLLUP };
  },
  // Active minutes = MODERATE + VIGOROUS (LIGHT left out, as Fitbit's "active minutes" did).
  activeMinutesRollup: (p) => {
    const lv = p.activeMinutes?.activeMinutesRollupByActivityLevel;
    if (!lv) return null;
    const value = lv
      .filter((x) => x.activityLevel === 'MODERATE' || x.activityLevel === 'VIGOROUS')
      .reduce((a, x) => a + (num(x.activeMinutesSum) || 0), 0);
    return { day: dateStr(p.civilStartTime?.date), type: 'active_min', value, platform: ROLLUP };
  },
};

const keep = (arr, f) => arr.map(f).filter(Boolean);

/** Pull and store everything in [fromEpoch, toEpoch) (real UTC seconds), walking API-cap windows. */
export async function pullHealth(fromEpoch, toEpoch) {
  const counts = { samples: 0, sessions: 0, daily: 0 };
  for (let s = fromEpoch; s < toEpoch; s += WINDOW_DAYS * DAY) {
    const e = Math.min(s + WINDOW_DAYS * DAY, toEpoch);
    const [ps, pe] = [rfc3339(s), rfc3339(e)];
    // Civil windows: whole days, end exclusive, one extra day so the
    // boundary day in any time zone is covered (upserts make overlap harmless).
    const [ds, de] = [dayOf(s), dayOf(e + DAY)];
    const samples = [
      ...keep(await listAll('weight', `weight.sample_time.physical_time >= "${ps}" AND weight.sample_time.physical_time < "${pe}"`, 10000), parse.weight),
      ...keep(await listAll('body-fat', `body_fat.sample_time.physical_time >= "${ps}" AND body_fat.sample_time.physical_time < "${pe}"`, 10000), parse['body-fat']),
    ];
    const sleepFilter = `sleep.interval.end_time >= "${ps}" AND sleep.interval.end_time < "${pe}"`;
    let sleep;
    try {
      sleep = await listAll('sleep', sleepFilter, 25);
    } catch (err) {
      // The reference says sleep listing can be refused under restricted
      // scopes and points to :reconcile instead.
      if (err.status !== 403) throw err;
      sleep = await listAll('sleep', sleepFilter, 25, ':reconcile');
    }
    const sessions = [
      ...keep(sleep, parse.sleep),
      ...keep(await listAll('exercise', `exercise.interval.civil_start_time >= "${ds}" AND exercise.interval.civil_start_time < "${de}"`, 25), parse.exercise),
    ];
    const daily = [
      ...keep(await listAll('daily-resting-heart-rate', `daily_resting_heart_rate.date >= "${ds}" AND daily_resting_heart_rate.date < "${de}"`, 10000), parse['daily-resting-heart-rate']),
      ...keep(await listAll('daily-heart-rate-variability', `daily_heart_rate_variability.date >= "${ds}" AND daily_heart_rate_variability.date < "${de}"`, 10000), parse['daily-heart-rate-variability']),
      ...keep(await rollUp('steps', ds, de, 90), parse.stepsRollup),
    ];
    for (let a = Date.parse(ds) / 1000; a < Date.parse(de) / 1000; a += ACTIVE_MINUTES_WINDOW_DAYS * DAY) {
      const b = Math.min(a + ACTIVE_MINUTES_WINDOW_DAYS * DAY, Date.parse(de) / 1000);
      daily.push(...keep(await rollUp('active-minutes', dayOf(a), dayOf(b), 14), parse.activeMinutesRollup));
    }
    ingestHealth({ samples, sessions, daily });
    counts.samples += samples.length;
    counts.sessions += sessions.length;
    counts.daily += daily.length;
  }
  return counts;
}

// --- lazy top-up under its own lock ---------------------------------------

let inFlight = null;
let checkedThisProcess = false;

/**
 * Bring the health tables up to now (and back to reqStartEpoch if the request
 * reaches before what has been pulled). Never throws: returns a status object.
 */
export function ensureHealthFresh(reqStartEpoch) {
  if (!healthConfigured()) {
    return Promise.resolve({
      ok: false,
      configured: false,
      hint: 'Google Health is not configured (OMNI_GHEALTH_* unset); showing stored health data only.',
    });
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const syncedTo = num(getMeta('healthSyncedTo'));
    const floor = num(getMeta('healthFloor'));
    const jobs = [];
    if (syncedTo == null) {
      jobs.push([Math.min(reqStartEpoch, resolveOldestEpoch()), now, 'full']);
    } else {
      if (!checkedThisProcess || now - syncedTo > HEALTH_STALE_SECONDS) {
        jobs.push([Math.max(0, syncedTo - TRAILING_SECONDS), now, 'top-up']);
      }
      if (floor != null && reqStartEpoch < floor) jobs.push([reqStartEpoch, floor, 'backfill']);
    }
    try {
      const counts = { samples: 0, sessions: 0, daily: 0 };
      for (const [s, e, kind] of jobs) {
        const c = await pullHealth(s, e);
        for (const k in counts) counts[k] += c[k];
        if (kind !== 'backfill') setMeta('healthSyncedTo', e);
        if (kind !== 'top-up') setMeta('healthFloor', s);
      }
      checkedThisProcess = true;
      return { ok: true, pulled: jobs.length ? counts : 'already current', syncedTo: rfc3339(num(getMeta('healthSyncedTo'))) };
    } catch (err) {
      const last = num(getMeta('healthSyncedTo'));
      return {
        ok: false,
        error: err.message,
        reason: err.reason ?? null,
        hint: err.hint ?? 'Showing stored health data only; ask again later to retry.',
        lastSuccessfulSync: last == null ? null : rfc3339(last),
      };
    }
  })().finally(() => {
    // Cleared here, not inside the body: a body with nothing to pull finishes
    // synchronously, before inFlight is assigned, and would stay set forever.
    inFlight = null;
  });
  return inFlight;
}

// --- bucketing (pure) -------------------------------------------------------

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Aggregate stored health rows into buckets. keyFor(localEpoch) gives the
 * bucket key; daily rows are placed at noon of their day, sleep by its wake
 * time, exercise by its start. Returns Map key -> health block.
 */
export function bucketHealth({ samples, sessions, daily }, keyFor) {
  const B = new Map();
  const get = (k) => {
    if (!B.has(k)) B.set(k, { steps: [], active: [], rhr: [], hrv: [], weight: [], fat: [], sleep: [], exercise: [] });
    return B.get(k);
  };
  const noon = (day) => Date.parse(`${day}T12:00:00Z`) / 1000;
  const dailyMap = { steps: 'steps', active_min: 'active', rhr: 'rhr', hrv: 'hrv' };
  for (const r of daily) if (dailyMap[r.type]) get(keyFor(noon(r.day)))[dailyMap[r.type]].push(r.value);
  for (const r of samples) {
    if (r.type === 'weight') get(keyFor(r.localEpoch)).weight.push(r.value);
    else if (r.type === 'body_fat') get(keyFor(r.localEpoch)).fat.push(r.value);
  }
  for (const r of sessions) {
    if (r.type === 'sleep' && r.subtype !== 'nap') get(keyFor(r.endLocal)).sleep.push(r);
    else if (r.type === 'exercise') get(keyFor(r.startLocal)).exercise.push(r);
  }
  const out = new Map();
  for (const [k, b] of B) {
    const types = {};
    for (const x of b.exercise) types[x.subtype || 'UNKNOWN'] = (types[x.subtype || 'UNKNOWN'] || 0) + 1;
    const exMin = (x) => x.details.activeMinutes ?? Math.round((x.endUtc - x.startUtc) / 60);
    const stageAvg = (name) => r1(avg(b.sleep.map((s) => s.details.stages?.[name]).filter((v) => v != null)));
    out.set(k, {
      steps: b.steps.length ? { total: b.steps.reduce((a, x) => a + x, 0), perDay: Math.round(avg(b.steps)), days: b.steps.length } : null,
      activeMinutes: b.active.length ? { perDay: r1(avg(b.active)), days: b.active.length } : null,
      exercise: b.exercise.length
        ? { count: b.exercise.length, minutes: b.exercise.reduce((a, x) => a + exMin(x), 0), types }
        : null,
      sleep: b.sleep.length
        ? {
            nights: b.sleep.length,
            avgMinutesAsleep: r1(avg(b.sleep.map((s) => s.details.minutesAsleep).filter((v) => v != null))),
            avgMinutesAwake: r1(avg(b.sleep.map((s) => s.details.minutesAwake).filter((v) => v != null))),
            avgStageMinutes: { deep: stageAvg('deep'), light: stageAvg('light'), rem: stageAvg('rem') },
          }
        : null,
      restingHeartRate: b.rhr.length ? { avgBpm: r1(avg(b.rhr)), days: b.rhr.length } : null,
      hrv: b.hrv.length ? { avgRmssdMs: r1(avg(b.hrv)), days: b.hrv.length } : null,
      weight: b.weight.length ? { medianKg: r1(median(b.weight)), weighIns: b.weight.length } : null,
      bodyFat: b.fat.length ? { medianPercent: r1(median(b.fat)), readings: b.fat.length } : null,
    });
  }
  return out;
}

/** Which platform/app each health type came from in the window (answers "is my watch/scale arriving?"). */
export function healthSources({ samples, sessions, daily }) {
  const out = {};
  const add = (type, platform, app) => {
    const k = [platform || 'unknown', app].filter(Boolean).join(' / ');
    out[type] ??= {};
    out[type][k] = (out[type][k] || 0) + 1;
  };
  for (const r of samples) add(r.type, r.platform, r.app);
  for (const r of sessions) add(r.type, r.platform, r.app);
  for (const r of daily) add(r.type, r.platform, null);
  return out;
}
