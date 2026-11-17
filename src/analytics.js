/**
 * analytics.js — the clinical maths and data shaping.
 *
 * This is the heart of Ridgeline T1D. It takes raw Glooko data (and rows read back
 * from the archive) and turns it into the summaries, trends, logs and metrics
 * the tools return. There is no I/O here: functions take data in and return
 * plain objects out, which keeps the maths easy to test in isolation.
 *
 * A few invariants are worth knowing before reading on, because they explain
 * choices that would otherwise look odd:
 *
 *  - Glucose is stored and computed internally in ONE canonical unit, mmol/L.
 *    Incoming data is normalised to mmol at ingest (see normaliseIncoming and
 *    GLOOKO_GLUCOSE_UNIT); outgoing values are converted to the caller's chosen
 *    display unit at the very end (see toDisplay / toDisplayDelta). Nothing in
 *    between has to think about units.
 *
 *  - Bolus insulin is always aggregated from individual stored events. Basal is
 *    only ever taken from Glooko's per-day totals (there is no per-event basal
 *    stream). The two are never blended into a single figure computed two ways.
 *
 *  - Time is UTC throughout. Day grouping and hour-of-day buckets use UTC, and
 *    emitted timestamps are UTC ISO 8601. Converting to the patient's local zone
 *    is left to the presentation layer.
 *
 *  - Per-day RATES use the real decimal span of observed data (observedDaySpan),
 *    not a calendar day count, so they are correct regardless of where a window
 *    falls.
 */

// Exact mmol/L <-> mg/dL conversion factor. Used both for normalising incoming
// data and for converting outgoing values to the display unit.
const MGDL_PER_MMOL = 18.0182;


// --- unit handling --------------------------------------------------------
// Two separate concerns: normalising INCOMING data to canonical mmol at ingest
// (driven by GLOOKO_GLUCOSE_UNIT, the source account's unit), and converting
// OUTGOING values to the caller's chosen display unit. Storage is always mmol.

/**
 * The unit Glooko delivers glucose in, which depends on how the user configured
 * their Glooko account (US accounts typically mg/dL, others mmol/L). This is the
 * SOURCE unit for incoming data and is SEPARATE from OMNI_UNITS (how the user
 * wants to SEE their data). Set GLOOKO_GLUCOSE_UNIT to match the Glooko account.
 * Defaults to mmol when unset. Anything other than "mgdl" is treated as mmol.
 */
function glookoSourceUnit() {
  const u = (process.env.GLOOKO_GLUCOSE_UNIT || 'mmol').trim().toLowerCase();
  return u === 'mgdl' ? 'mgdl' : 'mmol';
}

/**
 * Normalise an incoming ABSOLUTE glucose value (a reading, target, or BG input)
 * from the Glooko source unit to the canonical internal unit (mmol/L). Storage
 * is always mmol; the display layer converts back out per OMNI_UNITS. Null-safe.
 */
function normaliseIncoming(value, sourceUnit = glookoSourceUnit()) {
  if (value == null || !Number.isFinite(value)) return value;
  return sourceUnit === 'mgdl' ? value / MGDL_PER_MMOL : value;
}

/**
 * Normalise an incoming glucose DELTA (e.g. ISF, a glucose drop per unit of
 * insulin) from the source unit to mmol. A delta scales by the factor with no
 * offset. Null-safe.
 */
function normaliseIncomingDelta(value, sourceUnit = glookoSourceUnit()) {
  if (value == null || !Number.isFinite(value)) return value;
  return sourceUnit === 'mgdl' ? value / MGDL_PER_MMOL : value;
}

/**
 * Convert user-supplied limits into mmol/L thresholds.
 * units: 'mmol' | 'mgdl'. lower/upper are in the chosen unit.
 */
export function getThresholds(units, lower, upper) {
  let low = parseFloat(lower);
  let high = parseFloat(upper);
  if (units === 'mgdl') {
    low /= MGDL_PER_MMOL;
    high /= MGDL_PER_MMOL;
  }
  return { low, high };
}

/**
 * Convert a stored glucose VALUE (always mmol/L internally) to the display unit.
 * mg/dL is rounded to a whole number (clinical convention); mmol/L keeps the
 * requested decimals (1 by default). Returns null for null/undefined input.
 * Use this at EVERY point a glucose value leaves a tool, so output always
 * matches the user's chosen unit.
 */
export function toDisplay(mmolValue, units, decimals = 1) {
  if (mmolValue == null || !Number.isFinite(mmolValue)) return null;
  if (units === 'mgdl') return Math.round(mmolValue * MGDL_PER_MMOL);
  return +mmolValue.toFixed(decimals);
}

/**
 * Convert a glucose DIFFERENCE/spread (e.g. a standard deviation, or a median
 * deviation from target) to the display unit. A delta scales by the factor but
 * has NO offset, so it must not go through toDisplay (which is for absolute
 * points). mg/dL deltas are rounded to whole numbers, mmol keeps decimals.
 */
export function toDisplayDelta(mmolDelta, units, decimals = 2) {
  if (mmolDelta == null || !Number.isFinite(mmolDelta)) return null;
  if (units === 'mgdl') return Math.round(mmolDelta * MGDL_PER_MMOL);
  return +mmolDelta.toFixed(decimals);
}

// International consensus CGM time in ranges (Battelino et al., Diabetes Care
// 2019), fixed in mmol/L whatever OMNI_LOWER/OMNI_UPPER say. Five bands:
// very low < 3.0, low 3.0-3.8, in range 3.9-10.0, high 10.1-13.9, very high > 13.9.
export const CONSENSUS_MMOL = { veryLow: 3.0, low: 3.9, high: 10.0, veryHigh: 13.9 };
const BAND_KEYS = ['veryLow', 'low', 'inRange', 'high', 'veryHigh'];

/** Consensus band index 0..4 of a stored mmol/L value. */
export function consensusBandIndex(v) {
  // Round to the 0.1 mmol/L CGM step first, so mg/dL-sourced values such as
  // 70 mg/dL (3.885) land in range as the mg/dL consensus (70-180) says.
  const r = Math.round(v * 10) / 10;
  const c = CONSENSUS_MMOL;
  return r < c.veryLow ? 0 : r < c.low ? 1 : r <= c.high ? 2 : r <= c.veryHigh ? 3 : 4;
}

/** Five-band percentages (2 dp) from per-band counts [veryLow..veryHigh]. */
export function consensusBandsFromCounts(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  return Object.fromEntries(BAND_KEYS.map((k, i) => [k, n ? +((counts[i] / n) * 100).toFixed(2) : 0]));
}

export function consensusBands(bgValues) {
  const counts = [0, 0, 0, 0, 0];
  for (const v of bgValues || []) counts[consensusBandIndex(v)]++;
  return consensusBandsFromCounts(counts);
}

// tir/low/high use the configured thresholds (unchanged); veryLow/veryHigh and
// bands use the fixed consensus cut-offs.
export function calculateTIRMetrics(bgValues, thresholds) {
  const bands = consensusBands(bgValues);
  if (!bgValues?.length) return { tir: 0, low: 0, high: 0, veryLow: 0, veryHigh: 0, bands };
  const { low, high } = thresholds;
  const inRange = bgValues.filter((v) => v >= low && v <= high).length;
  const lowCount = bgValues.filter((v) => v < low).length;
  const highCount = bgValues.filter((v) => v > high).length;
  return {
    tir: (inRange / bgValues.length) * 100,
    low: (lowCount / bgValues.length) * 100,
    high: (highCount / bgValues.length) * 100,
    veryLow: bands.veryLow,
    veryHigh: bands.veryHigh,
    bands,
  };
}

/**
 * Ambulatory glucose profile: every CGM reading laid over one 24 h pump clock
 * in 15-minute slots (96). Per slot the 5th/25th/50th/75th/95th percentiles
 * (linear interpolation), then each percentile line is smoothed with a
 * circular 5-slot (75 min) moving average over the slots that have readings.
 * n is the raw reading count in the slot, before smoothing.
 */
export function agpProfile(timeline, units = 'mmol', slotMinutes = 15) {
  const nSlots = 1440 / slotMinutes;
  const bins = Array.from({ length: nSlots }, () => []);
  for (const p of timeline) {
    if (p.type !== 'CGM') continue;
    const d = new Date(p.epoch * 1000);
    bins[Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes()) / slotMinutes)].push(p.val);
  }
  const Q = [0.05, 0.25, 0.5, 0.75, 0.95];
  const pct = (s, q) => {
    const i = (s.length - 1) * q, lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  const raw = bins.map((b) => {
    const s = [...b].sort((x, y) => x - y);
    return Q.map((q) => (s.length ? pct(s, q) : null));
  });
  const keys = ['p5', 'p25', 'p50', 'p75', 'p95'];
  return bins.map((b, i) => {
    const row = {
      slot: i,
      time: `${String(Math.floor((i * slotMinutes) / 60)).padStart(2, '0')}:${String((i * slotMinutes) % 60).padStart(2, '0')}`,
      n: b.length,
    };
    keys.forEach((k, qi) => {
      let t = 0, c = 0;
      for (let j = -2; j <= 2; j++) {
        const v = raw[(i + j + nSlots) % nSlots][qi];
        if (v != null) { t += v; c++; }
      }
      row[k] = c ? toDisplay(t / c, units) : null;
    });
    return row;
  });
}

/**
 * Extracts chronological pump-setting changes active within a window.
 * startDate / endDate are epoch milliseconds.
 */
export function getActiveSettings(json, startDate, endDate) {
  if (!json?.deviceSettings?.pumps) return [];
  const startEpoch = new Date(startDate).getTime();
  const endEpoch = new Date(endDate).getTime();
  const pumps = json.deviceSettings.pumps;
  let flatHistory = [];

  Object.keys(pumps).forEach((guid) => {
    Object.keys(pumps[guid]).forEach((ts) => {
      flatHistory.push({
        timestamp: ts,
        epoch: new Date(ts).getTime(),
        data: pumps[guid][ts],
      });
    });
  });

  flatHistory.sort((a, b) => a.epoch - b.epoch);
  const baselineIdx = flatHistory.findLastIndex((s) => s.epoch <= startEpoch);
  const startIndex = baselineIdx !== -1 ? baselineIdx : 0;

  // Glooko returns the bolus-profile glucose values (target, ISF) in the user's
  // Glooko account unit. Normalise them to canonical mmol at ingest so stored
  // settings match the stored CGM/bolus values. Target is an absolute glucose
  // value; ISF is a glucose delta per unit of insulin.
  const srcUnit = glookoSourceUnit();
  const normaliseSettingsData = (data) => {
    if (srcUnit !== 'mgdl' || !data?.profilesBolus) return data;
    const profiles = data.profilesBolus.map((profile) => {
      const p = { ...profile };
      if (p.targetBgSegments?.data) {
        p.targetBgSegments = {
          ...p.targetBgSegments,
          data: p.targetBgSegments.data.map((sn) => ({
            ...sn,
            value: normaliseIncoming(sn.value, srcUnit),
          })),
        };
      }
      if (p.isfSegments?.data) {
        p.isfSegments = {
          ...p.isfSegments,
          data: p.isfSegments.data.map((sn) => ({
            ...sn,
            value: normaliseIncomingDelta(sn.value, srcUnit),
          })),
        };
      }
      return p;
    });
    return { ...data, profilesBolus: profiles };
  };

  return flatHistory
    .slice(startIndex)
    .filter((item) => item.epoch <= endEpoch)
    .map((item) => ({
      activeTimestamp: item.timestamp,
      settings: normaliseSettingsData(item.data),
    }));
}

// --- ingest: raw Glooko JSON -> normalised records ------------------------

/**
 * Unifies CGM and bolus events into a single sorted timeline.
 * CGM points are de-duplicated into 5-minute buckets and tagged with velocity.
 * Boluses are categorised (meal / manual correction / system correction / meal+correction).
 * Incoming glucose values are normalised to canonical mmol/L here, at ingest.
 */
export function processUnifiedGlookoData(rawJson) {
  const series = (rawJson && rawJson.series) || {};
  const allCgm = [
    ...(series.cgmHigh || []),
    ...(series.cgmNormal || []),
    ...(series.cgmLow || []),
  ].sort((a, b) => a.x - b.x);

  const cleanCgm = [];
  const seenBuckets = new Set();
  const srcUnit = glookoSourceUnit();

  allCgm.forEach((p) => {
    const bucket = Math.floor(p.x / 300) * 300;
    if (!seenBuckets.has(bucket)) {
      seenBuckets.add(bucket);
      // Normalise the incoming reading to canonical mmol BEFORE deriving
      // velocity, so velocity (a difference of readings) is correct too.
      const valMmol = normaliseIncoming(p.y, srcUnit);
      let vel =
        cleanCgm.length > 0
          ? parseFloat((valMmol - cleanCgm[cleanCgm.length - 1].val).toFixed(2))
          : 0;
      cleanCgm.push({
        epoch: p.x,
        type: 'CGM',
        val: valMmol,
        vel,
        time: new Date(p.x * 1000).toISOString(),
      });
    }
  });

  // Algorithm-initiated boluses (Tandem Control-IQ automatic corrections) come
  // in their own automaticBolus series, disjoint from deliveredBolus; Glooko's
  // daily bolus total is the sum of both. Keyed by epoch so a bolus that ever
  // appears in both series is counted once, as automatic.
  const byEpoch = new Map();
  for (const b of series.deliveredBolus || []) byEpoch.set(b.x, { b, auto: false });
  for (const b of series.automaticBolus || []) byEpoch.set(b.x, { b, auto: true });

  const boluses = [...byEpoch.values()].map(({ b, auto }) => {
    // Tandem leaves the correction recommendation null rather than 0.
    const rc = b.insulinRecommendationForCorrection ?? 0;
    let cat = 'Unknown';
    if (auto) cat = 'Automatic Correction Bolus';
    else if (!b.isManual && b.carbsInput > 0 && rc === 0) cat = 'Meal Bolus';
    else if (b.isManual && b.carbsInput === 0) cat = 'Manual Correction Bolus';
    else if (!b.isManual && b.carbsInput === 0 && rc > 0)
      cat = 'System Correction Bolus';
    else if (!b.isManual && b.carbsInput > 0 && rc > 0)
      cat = 'Meal With Correction Bolus';
    // Override direction: the device flags when the programmed dose was pushed
    // above or below the algorithm's recommendation.
    const override = b.isOverrideAbove
      ? 'above'
      : b.isOverrideBelow
        ? 'below'
        : null;
    const delivered = numOrNull(b.insulinDelivered);
    const programmed = numOrNull(b.insulinProgrammed);
    // Interrupted if the device says so, OR delivered fell short of programmed
    // (a partial delivery means the bolus was cut off mid-way).
    const interrupted =
      b.isInterrupted === true ||
      (delivered != null && programmed != null && delivered < programmed - 1e-9);
    return {
      epoch: b.x,
      type: 'BOLUS',
      // 'units' kept as the canonical amount = what was actually DELIVERED, so
      // existing analytics (totals, carb ratios, charts) stay correct even when
      // a bolus was interrupted. Falls back to b.y if delivered is missing.
      units: delivered != null ? delivered : b.y,
      delivered,
      programmed,
      recTotal: numOrNull(b.totalInsulinRecommendation),
      recCorrection: numOrNull(b.insulinRecommendationForCorrection),
      recCarbs: numOrNull(b.insulinRecommendationForCarbs),
      carbs: b.carbsInput,
      iob: b.insulinOnBoard,
      bgInput: normaliseIncoming(numOrNull(b.bloodGlucoseInput), srcUnit),
      bgSource: b.bloodGlucoseInputSource ?? null,
      isManual: b.isManual === true,
      interrupted,
      override,
      class: cat,
      time: new Date(b.x * 1000).toISOString(),
    };
  });

  return [...cleanCgm, ...boluses].sort((a, b) => a.epoch - b.epoch);
}

/**
 * Circadian distribution: aggregate TIR / average glucose by clock-hour.
 */
export function calculateHourly(timeline, thresholds, units = 'mmol') {
  const hourly = {};
  const cgm = timeline.filter((i) => i.type === 'CGM');
  if (!cgm.length) return [];
  cgm.forEach((p) => {
    const h = new Date(p.epoch * 1000).getUTCHours();
    if (!hourly[h]) hourly[h] = [];
    hourly[h].push(p.val);
  });
  return Object.keys(hourly)
    .map((h) => {
      const metrics = calculateTIRMetrics(hourly[h], thresholds);
      return {
        hour: h.padStart(2, '0') + ':00',
        hourNum: parseInt(h, 10),
        avg: toDisplay(
          hourly[h].reduce((a, b) => a + b, 0) / hourly[h].length,
          units
        ),
        tir: +metrics.tir.toFixed(2),
        low: +metrics.low.toFixed(2),
        high: +metrics.high.toFixed(2),
        veryLow: metrics.veryLow,
        veryHigh: metrics.veryHigh,
        consensusBands: metrics.bands,
        readings: hourly[h].length,
      };
    })
    .sort((a, b) => a.hourNum - b.hourNum);
}

/**
 * Metabolic state (interpolated BG) at an arbitrary epoch.
 * Returns null if the nearest CGM points straddle a gap > 10 minutes.
 */
export function getInterpolatedBG(targetEpoch, timeline) {
  const cgm = timeline.filter((i) => i.type === 'CGM');
  const before = [...cgm].reverse().find((i) => i.epoch <= targetEpoch);
  const after = cgm.find((i) => i.epoch > targetEpoch);
  if (!before || !after || after.epoch - before.epoch > 600)
    return before?.val || after?.val || null;
  const weight = (targetEpoch - before.epoch) / (after.epoch - before.epoch);
  return parseFloat((before.val + weight * (after.val - before.val)).toFixed(2));
}

/**
 * The bolus profile in force in a settings snapshot. Tandem pumps hold several
 * named Personal Profiles; Glooko flags the active one with current=true on its
 * segment blocks and names it in basalSettings.activeBasalProgram. Omnipod has
 * a single profile. Returns null when the snapshot has no profiles.
 */
export function activeBolusProfile(settings) {
  const profiles = settings?.profilesBolus;
  if (!Array.isArray(profiles) || !profiles.length) return null;
  const blocks = (p) => [
    p?.targetBgSegments,
    p?.isfSegments,
    p?.insulinToCarbRatioSegments,
  ];
  const program = settings?.basalSettings?.activeBasalProgram;
  return (
    profiles.find((p) => blocks(p).some((b) => b?.current === true)) ||
    (program != null &&
      profiles.find((p) => blocks(p).some((b) => b?.profileName === program))) ||
    profiles[0]
  );
}

/** The active profile's segment list for one setting, or null if absent. */
function segmentsOf(settings, key) {
  const data = activeBolusProfile(settings)?.[key]?.data;
  return Array.isArray(data) && data.length ? data : null;
}

/**
 * Finds the active setting value for a clock-hour from time-segmented data.
 * Returns null for missing or empty data.
 */
export function findActiveDataRecord(data, epoch) {
  if (!Array.isArray(data) || !data.length) return null;
  const h = new Date(epoch * 1000).getUTCHours();
  const sorted = [...data].sort((a, b) => a.segmentStart - b.segmentStart);
  const active = sorted.findLast((s) => s.segmentStart <= h);
  return active ? active.value : sorted[sorted.length - 1].value;
}

export const formatHour = (h) =>
  `${Math.floor(h)}:${h % 1 === 0.5 ? '30' : '00'}`;

/**
 * Builds the enriched bolus log: each bolus matched with interpolated BG at
 * delivery plus the ISF / CR / target / DIA in force at that moment.
 * This is downloadSubset('bolus') from the browser, as a pure function.
 */
export function buildEnrichedBolusLog(timeline, settingsHistory, units = 'mmol') {
  return timeline
    .filter((i) => i.type === 'BOLUS')
    .map((bolus) => {
      const activeSetting = settingsHistory.findLast(
        (s) => new Date(s.activeTimestamp).getTime() / 1000 <= bolus.epoch
      );
      const st = activeSetting?.settings;
      const context = activeSetting
        ? {
            DIA: st?.generalSettings?.activeInsulinTime ?? null,
            target: toDisplay(
              findActiveDataRecord(segmentsOf(st, 'targetBgSegments'), bolus.epoch),
              units
            ),
            // ISF is a glucose drop per unit of insulin, so it scales like a
            // glucose delta (factor, no offset).
            isf: toDisplayDelta(
              findActiveDataRecord(segmentsOf(st, 'isfSegments'), bolus.epoch),
              units
            ),
            active_cr: findActiveDataRecord(
              segmentsOf(st, 'insulinToCarbRatioSegments'),
              bolus.epoch
            ),
          }
        : null;
      return {
        ...bolus,
        // bgInput (the calculator's BG input) is a glucose value stored in mmol.
        bgInput: toDisplay(bolus.bgInput, units),
        cgm_val: toDisplay(getInterpolatedBG(bolus.epoch, timeline), units),
        context,
      };
    });
}

/**
 * Computes the full aggregate summary for a window: the glucose-control,
 * insulin-delivery, bolus-architecture, best/worst day and hour figures that
 * formatHeader assembled in the browser. Returned as structured data rather
 * than a formatted string, so the model can reason over it directly.
 *
 * stats is Glooko's data2 (statistics/overall) blob.
 */
/**
 * The glucose target in force for a single reading: resolves BOTH the settings
 * VERSION active at that timestamp (settings change over weeks) AND the target
 * SEGMENT active at that reading's clock-hour (the PDM can set different targets
 * per hour). Returns null if no settings/target can be resolved for it.
 */
export function targetForEpoch(epoch, settingsHistory) {
  if (!settingsHistory || !settingsHistory.length) return null;
  const activeSetting = settingsHistory.findLast(
    (s) => new Date(s.activeTimestamp).getTime() / 1000 <= epoch
  );
  return findActiveDataRecord(
    segmentsOf(activeSetting?.settings, 'targetBgSegments'),
    epoch
  );
}

/** Median of a numeric array (returns null for empty). */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Ranking metrics for a set of CGM points (each {epoch, val}). Used to compare
 * days or clock-hours decisively: TIR first, then closeness to the per-reading
 * target (median absolute deviation, robust to single spikes), then variability
 * (CV). Each reading is compared to the target IN FORCE at its own timestamp, so
 * hourly target profiles are honoured automatically; a whole-day single target
 * collapses to the same number. medianAbsTargetDev is null when no target can be
 * resolved (e.g. settings history missing), and ranking then falls back to CV.
 */
export function rankingMetrics(points, thresholds, settingsHistory) {
  const vals = points.map((p) => p.val);
  const tir = +calculateTIRMetrics(vals, thresholds).tir.toFixed(2);

  const devs = [];
  for (const p of points) {
    const tgt = targetForEpoch(p.epoch, settingsHistory);
    if (tgt != null) devs.push(Math.abs(p.val - tgt));
  }
  const med = median(devs);
  const medianAbsTargetDev = med == null ? null : +med.toFixed(2);

  let cv = null;
  if (vals.length) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg > 0) {
      const sd = Math.sqrt(
        vals.map((v) => (v - avg) ** 2).reduce((a, b) => a + b, 0) / vals.length
      );
      cv = +((sd / avg) * 100).toFixed(2);
    }
  }
  return { tir, medianAbsTargetDev, cv };
}

/**
 * Compares two ranking-metric objects. Returns >0 if A is BETTER than B, <0 if
 * worse, 0 if indistinguishable. Better = higher TIR, then lower median target
 * deviation (closer to target), then lower CV (steadier). Nulls sort last so a
 * day with a computable deviation beats one without.
 */
function compareRanking(a, b) {
  if (a.tir !== b.tir) return a.tir - b.tir; // higher TIR better
  // lower median target deviation better; null (unknown) is worse
  const ad = a.medianAbsTargetDev, bd = b.medianAbsTargetDev;
  if (ad != null && bd != null && ad !== bd) return bd - ad;
  if (ad == null && bd != null) return -1;
  if (ad != null && bd == null) return 1;
  // lower CV better; null worse
  const ac = a.cv, bc = b.cv;
  if (ac != null && bc != null && ac !== bc) return bc - ac;
  if (ac == null && bc != null) return -1;
  if (ac != null && bc == null) return 1;
  return 0;
}

// --- window summary (the get_diabetes_summary aggregator) -----------------

export function computeSummary(
  timeline,
  stats,
  settingsHistory,
  thresholds,
  unitLabel,
  statsScope = 'exact', // 'exact' | 'wider': whether stats match the timeline window
  dailyInsulin = null // per-day basal/bolus/total records for the window, if available
) {
  // Display unit code derived from the label. All stored values are mmol/L;
  // every glucose value emitted below is converted to this unit via toDisplay
  // (absolute points) or toDisplayDelta (spreads/deviations).
  const units = unitLabel === 'mg/dL' ? 'mgdl' : 'mmol';
  const cgmVals = timeline.filter((i) => i.type === 'CGM').map((i) => i.val);

  const reportStart = timeline.length
    ? new Date(timeline[0].epoch * 1000).toISOString()
    : null;
  const reportEnd = timeline.length
    ? new Date(timeline[timeline.length - 1].epoch * 1000).toISOString()
    : null;
  const days =
    timeline.length > 1
      ? (timeline[timeline.length - 1].epoch - timeline[0].epoch) / 86400
      : 0;

  let avg = 0,
    std = 0,
    cv = 0,
    gmi = 0,
    tir = calculateTIRMetrics([], thresholds);
  if (cgmVals.length) {
    avg = cgmVals.reduce((a, b) => a + b, 0) / cgmVals.length;
    std = Math.sqrt(
      cgmVals.map((v) => Math.pow(v - avg, 2)).reduce((a, b) => a + b, 0) /
        cgmVals.length
    );
    cv = (std / avg) * 100;
    tir = calculateTIRMetrics(cgmVals, thresholds);
    gmi = +(3.31 + 0.02392 * (avg * MGDL_PER_MMOL)).toFixed(2);
  }

  // Best / worst day by TIR
  // Best / worst day. Ranked decisively: TIR, then closeness to the target in
  // force per reading (median absolute deviation, hour-aware), then CV. Keep
  // full {epoch,val} points so each reading's target can be resolved.
  const dailyPts = {};
  timeline
    .filter((i) => i.type === 'CGM')
    .forEach((p) => {
      const k = new Date(p.epoch * 1000).toISOString().split('T')[0];
      (dailyPts[k] = dailyPts[k] || []).push({ epoch: p.epoch, val: p.val });
    });
  let bestD = null;
  let worstD = null;
  let bestDM = null;
  let worstDM = null;
  Object.keys(dailyPts).forEach((k) => {
    const m = rankingMetrics(dailyPts[k], thresholds, settingsHistory);
    if (bestDM === null || compareRanking(m, bestDM) > 0) {
      bestDM = m;
      bestD = { day: k, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
    if (worstDM === null || compareRanking(m, worstDM) < 0) {
      worstDM = m;
      worstD = { day: k, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
  });
  if (!bestD) bestD = { day: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };
  if (!worstD) worstD = { day: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };

  // Best / worst hour (recurring clock-hour, pooled across all days). Same
  // decisive ranking, and per-reading target lookup means each clock-hour is
  // judged against the target set for THAT hour in the PDM.
  const hourly = calculateHourly(timeline, thresholds);
  const hourlyPts = {};
  timeline
    .filter((i) => i.type === 'CGM')
    .forEach((p) => {
      const h = new Date(p.epoch * 1000).getUTCHours();
      (hourlyPts[h] = hourlyPts[h] || []).push({ epoch: p.epoch, val: p.val });
    });
  let bestH = null;
  let worstH = null;
  let bestHM = null;
  let worstHM = null;
  Object.keys(hourlyPts).forEach((h) => {
    const m = rankingMetrics(hourlyPts[h], thresholds, settingsHistory);
    const label = String(h).padStart(2, '0') + ':00';
    if (bestHM === null || compareRanking(m, bestHM) > 0) {
      bestHM = m;
      bestH = { hour: label, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
    if (worstHM === null || compareRanking(m, worstHM) < 0) {
      worstHM = m;
      worstH = { hour: label, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
  });
  if (!bestH) bestH = { hour: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };
  if (!worstH) worstH = { hour: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };

  // Highest / lowest glucose readings in the window, WITH timestamps. If a peak
  // or trough value occurs more than once, every instance is returned (e.g. four
  // separate readings of 17.9 all come back). CGM values are quantised to 0.1
  // mmol/L, so an exact-equality match (with a tiny epsilon for float safety) on
  // the rounded value reliably groups identical readings.
  const cgmPoints = timeline.filter((i) => i.type === 'CGM');
  let glucoseExtremes = null;
  if (cgmPoints.length) {
    const EPS = 0.001;
    let hi = -Infinity;
    let lo = Infinity;
    for (const p of cgmPoints) {
      if (p.val > hi) hi = p.val;
      if (p.val < lo) lo = p.val;
    }
    const instances = (target) =>
      cgmPoints
        .filter((p) => Math.abs(p.val - target) < EPS)
        .map((p) => ({
          value: toDisplay(p.val, units),
          time: new Date(p.epoch * 1000).toISOString(),
        }))
        .sort((a, b) => a.time.localeCompare(b.time));
    const highs = instances(hi);
    const lows = instances(lo);
    glucoseExtremes = {
      highest: {
        value: toDisplay(hi, units),
        count: highs.length,
        instances: highs,
      },
      lowest: {
        value: toDisplay(lo, units),
        count: lows.length,
        instances: lows,
      },
    };
  }

  // Bolus architecture
  const boluses = timeline.filter((i) => i.type === 'BOLUS');
  const bolusArchitecture = {
    meal: boluses.filter((b) => b.class === 'Meal Bolus').length,
    manualCorrection: boluses.filter((b) => b.class === 'Manual Correction Bolus')
      .length,
    systemCorrection: boluses.filter((b) => b.class === 'System Correction Bolus')
      .length,
    mealWithCorrection: boluses.filter(
      (b) => b.class === 'Meal With Correction Bolus'
    ).length,
    automaticCorrection: boluses.filter(
      (b) => b.class === 'Automatic Correction Bolus'
    ).length,
  };

  // Settings snapshots, human-readable
  // Every field is optional: Tandem snapshots carry no maxBasalRate, and a
  // snapshot may lack profiles entirely. Missing values come back null rather
  // than throwing, so the summary always renders.
  const segList = (st, key, fmt) =>
    (segmentsOf(st, key) || []).map((sn) => ({
      from: formatHour(sn.segmentStart),
      value: fmt(sn.value),
    }));
  const settings = settingsHistory.map((s) => {
    const st = s.settings;
    const profile = activeBolusProfile(st);
    return {
      effective: s.activeTimestamp,
      DIA_hours: st?.generalSettings?.activeInsulinTime ?? null,
      maxBasalRate: st?.basalSettings?.maxBasalRate ?? null,
      activeProfile:
        profile?.targetBgSegments?.profileName ??
        st?.basalSettings?.activeBasalProgram ??
        null,
      targetBg: segList(st, 'targetBgSegments', (v) => toDisplay(v, units)),
      isf: segList(st, 'isfSegments', (v) => toDisplayDelta(v, units)),
      carbRatio: segList(st, 'insulinToCarbRatioSegments', (v) => v),
    };
  });

  return {
    unit: unitLabel,
    reportRange: { start: reportStart, end: reportEnd, days: +days.toFixed(2) },
    glucoseControl: {
      averageBG: toDisplay(avg, units),
      gmiEstimatedA1c: gmi,
      stdDev: toDisplayDelta(std, units),
      coefficientOfVariation: +cv.toFixed(2),
      variabilityFlag: cv > 36 ? 'High Variability' : 'Stable',
      timeInRange: +tir.tir.toFixed(2),
      timeLow: +tir.low.toFixed(2),
      timeHigh: +tir.high.toFixed(2),
      timeVeryLow: tir.veryLow,
      timeVeryHigh: tir.veryHigh,
      consensusBands: tir.bands,
      cgmReadingCount: cgmVals.length,
    },
    glucoseExtremes,
    bestWorst: {
      bestDay: bestD,
      worstDay: worstD,
      bestHour: bestH,
      worstHour: worstH,
    },
    insulin: summariseInsulin(timeline, dailyInsulin, units),
    bolusArchitecture,
    carbs: summariseCarbs(timeline, units),
    settings,
  };
}

/**
 * Window-level insulin summary. BOLUS is aggregated from archive events (one
 * method), with per-day rate over the decimal observed span. BASAL comes only
 * from Glooko daily totals: every day with a basal figure is included (no
 * exclusions, no notes), and we report the total, the count of basal days, and
 * the average per basal day. Because basal is whole-day quantised, basalDayCount
 * can differ slightly from the decimal observed span; both numbers are shown so
 * the difference is visible. The basal/bolus split is computed on a per-day-rate
 * basis (immune to the day-count vs span mismatch), an important balance metric
 * for a closed-loop system.
 */
export function summariseInsulin(timeline, dailyInsulin, units = 'mmol') {
  const bolusItems = timeline.filter((i) => i.type === 'BOLUS');
  const bolusUnits = bolusItems.reduce((a, b) => a + (b.units || 0), 0);
  const bolusEventCount = bolusItems.length;
  const cgmEpochs = timeline.filter((i) => i.type === 'CGM').map((i) => i.epoch);
  const observedDays = observedDaySpan(cgmEpochs);
  const bolusUnitsPerDay = bolusUnits / observedDays;

  const out = {
    observedDays: +observedDays.toFixed(2),
    bolusSource: 'archive-events',
    bolusUnits: +bolusUnits.toFixed(2),
    bolusUnitsPerDay: +bolusUnitsPerDay.toFixed(2),
    bolusEventCount,
    avgUnitsPerBolus: bolusEventCount ? +(bolusUnits / bolusEventCount).toFixed(2) : null,
  };

  if (dailyInsulin && dailyInsulin.length) {
    let basalUnits = 0;
    let basalDayCount = 0;
    for (const rec of dailyInsulin) {
      if (rec.basalUnits == null) continue;
      basalUnits += rec.basalUnits;
      basalDayCount++;
    }
    const averageBasalUnitsPerDay = basalDayCount ? basalUnits / basalDayCount : null;
    out.basalSource = 'glooko-daily';
    out.basalUnits = +basalUnits.toFixed(2);
    out.basalDayCount = basalDayCount;
    out.averageBasalUnitsPerDay =
      averageBasalUnitsPerDay == null ? null : +averageBasalUnitsPerDay.toFixed(2);

    // Basal/bolus split on a per-day-rate basis (normalises the differing
    // denominators: basal over basalDayCount whole days, bolus over the
    // observed span).
    if (averageBasalUnitsPerDay != null) {
      const dailyTotal = averageBasalUnitsPerDay + bolusUnitsPerDay;
      out.basalPercent = dailyTotal ? +((averageBasalUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
      out.bolusPercent = dailyTotal ? +((bolusUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
    }
  }
  return out;
}

/** Window-level carb summary from archive carb-bearing bolus events. */
export function summariseCarbs(timeline, units = 'mmol') {
  const cgmEpochs = timeline.filter((i) => i.type === 'CGM').map((i) => i.epoch);
  const observedDays = observedDaySpan(cgmEpochs);
  let carbsGrams = 0;
  let carbEntryCount = 0;
  for (const i of timeline) {
    if (i.type === 'BOLUS' && (i.carbs || 0) > 0) {
      carbsGrams += i.carbs;
      carbEntryCount++;
    }
  }
  return {
    carbsGrams: Math.round(carbsGrams),
    carbsPerDay: Math.round(carbsGrams / observedDays),
    carbEntryCount,
  };
}

function round(v, dp = 2) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
  return +Number(v).toFixed(dp);
}

// --- day completeness & observed span -------------------------------------
/**
 * Build the set of UTC day strings (YYYY-MM-DD) that contain at least one CGM
 * reading. Used to classify a day as "whole" by the neighbour rule.
 */
export function daysWithReadings(timeline) {
  const days = new Set();
  for (const item of timeline) {
    if (item.type !== 'CGM') continue;
    days.add(new Date(item.epoch * 1000).toISOString().slice(0, 10));
  }
  return days;
}

/** The UTC day string N days from the given day string. */
function shiftDay(dayStr, deltaDays) {
  const d = new Date(dayStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * A day is WHOLE when both adjacent calendar days have at least one reading: a
 * day bracketed by data on each side must itself be fully covered. The only
 * partial days are therefore the first and last of the data (or any day next to
 * an interior gap). Whole days carry a trustworthy whole-day basal that can be
 * combined with our bolus into a clean daily total; partial days show basal
 * flagged as a whole-day figure that the window may not fully cover.
 */
export function isWholeDay(dayStr, daySet) {
  return daySet.has(shiftDay(dayStr, -1)) && daySet.has(shiftDay(dayStr, 1));
}

/**
 * Decimal day-span actually observed between the first and last CGM reading of
 * a set of epochs (seconds). This is the correct denominator for per-day RATES
 * of things we measure event-by-event (bolus, CGM), avoiding calendar-boundary
 * miscounts. Returns a small positive floor for a single reading.
 */
export function observedDaySpan(epochs) {
  if (!epochs.length) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const e of epochs) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  const span = (max - min) / 86400;
  return span > 0 ? span : 1 / 24;
}

// --- bucketed trend aggregation -------------------------------------------

const MGDL_PER_MMOL_TREND = 18.0182;

/**
 * Map a UTC epoch (seconds) to a calendar bucket key for the given granularity.
 * Keys sort lexically into chronological order.
 */
export function calendarBucketKey(epochSeconds, granularity) {
  const d = new Date(epochSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  const day = d.getUTCDate();
  if (granularity === 'day') {
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }
  if (granularity === 'week') {
    // ISO-ish week: bucket by the Monday of the reading's week (UTC).
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(Date.UTC(y, m, day - dow));
    return 'W:' + monday.toISOString().split('T')[0];
  }
  if (granularity === 'month') {
    return `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  if (granularity === 'quarter') {
    const q = Math.floor(m / 3) + 1;
    return `${y}-Q${q}`;
  }
  throw new Error(`Unknown granularity: ${granularity}`);
}

/**
 * Map an epoch to a fixed-length bucket index relative to a start epoch.
 * sizeDays is 1/7/14/30 etc. Returns a key like 'F:<startISO>'.
 */
function fixedBucketKey(epochSeconds, startEpochSeconds, sizeDays) {
  const sizeSecs = sizeDays * 86400;
  const idx = Math.floor((epochSeconds - startEpochSeconds) / sizeSecs);
  const bucketStart = startEpochSeconds + idx * sizeSecs;
  return 'F:' + new Date(bucketStart * 1000).toISOString().split('T')[0];
}

/**
 * Bucket a unified timeline and aggregate each bucket INDEPENDENTLY from raw
 * readings. Critically, every metric is derived from sums and counts within the
 * bucket, never by combining pre-computed averages, so the rows are accurate
 * regardless of differing reading counts (e.g. sensor dropout) between buckets.
 *
 * mode: 'calendar' | 'fixed'
 * granularity: 'day'|'week'|'month'|'quarter' (calendar) or a day-size (fixed)
 * windowStart/windowEnd are epoch seconds, used for coverage expectation.
 *
 * Each row carries:
 *   - glucose: avg, TIR/low/high %, stdDev, CV, GMI, reading count
 *   - insulin: bolus units total + per-day (basal not stored; see note)
 *   - carbs:   total + per-day, carb-entry count
 *   - coverage: expected vs actual readings and a percentage, so each row's
 *               trustworthiness is visible
 */
export function bucketTrend(
  timeline,
  thresholds,
  { mode, granularity, fixedSizeDays, windowStart, windowEnd, units = 'mmol' },
  dailyInsulin = null
) {
  const buckets = new Map();

  const keyFor = (epoch) =>
    mode === 'fixed'
      ? fixedBucketKey(epoch, windowStart, fixedSizeDays)
      : calendarBucketKey(epoch, granularity);

  for (const item of timeline) {
    const key = keyFor(item.epoch);
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        firstEpoch: item.epoch,
        lastEpoch: item.epoch,
        cgmEpochs: [],
        cgmSum: 0,
        cgmSumSq: 0,
        cgmCount: 0,
        inRange: 0,
        low: 0,
        high: 0,
        bandCounts: [0, 0, 0, 0, 0],
        bolusUnits: 0,
        bolusCount: 0,
        carbs: 0,
        carbEntries: 0,
        // Per-day Glooko basal for this bucket: dayStr -> basalUnits. Bolus is
        // NOT taken from Glooko (we aggregate it ourselves from events above).
        basalByDay: new Map(),
        hasInsulinData: false,
      });
    }
    const b = buckets.get(key);
    if (item.epoch < b.firstEpoch) b.firstEpoch = item.epoch;
    if (item.epoch > b.lastEpoch) b.lastEpoch = item.epoch;

    if (item.type === 'CGM') {
      const v = item.val;
      b.cgmEpochs.push(item.epoch);
      b.cgmSum += v;
      b.cgmSumSq += v * v;
      b.cgmCount++;
      if (v < thresholds.low) b.low++;
      else if (v > thresholds.high) b.high++;
      else b.inRange++;
      b.bandCounts[consensusBandIndex(v)]++;
    } else if (item.type === 'BOLUS') {
      b.bolusUnits += item.units || 0;
      b.bolusCount++;
      if ((item.carbs || 0) > 0) {
        b.carbs += item.carbs;
        b.carbEntries++;
      }
    }
  }

  // Attribute Glooko per-day BASAL to its bucket, keyed by day so we can later
  // classify each day as whole/partial. We deliberately take ONLY basal from
  // Glooko: bolus is aggregated by us from individual events above (one
  // consistent method), so Glooko's pre-aggregated bolus is not used here.
  if (dailyInsulin && dailyInsulin.length) {
    for (const rec of dailyInsulin) {
      if (rec.basalUnits == null) continue;
      const dayEpoch = Math.floor(
        new Date(rec.dayUtc + 'T12:00:00.000Z').getTime() / 1000
      );
      const key = keyFor(dayEpoch);
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          firstEpoch: dayEpoch,
          lastEpoch: dayEpoch,
          cgmEpochs: [],
          cgmSum: 0,
          cgmSumSq: 0,
          cgmCount: 0,
          inRange: 0,
          low: 0,
          high: 0,
          bandCounts: [0, 0, 0, 0, 0],
          bolusUnits: 0,
          bolusCount: 0,
          carbs: 0,
          carbEntries: 0,
          basalByDay: new Map(),
          hasInsulinData: false,
        });
      }
      const b = buckets.get(key);
      b.basalByDay.set(rec.dayUtc, rec.basalUnits || 0);
      b.hasInsulinData = true;
    }
  }

  const rows = [...buckets.values()]
    .sort((a, b) => a.firstEpoch - b.firstEpoch)
    .map((b) => buildBucketRow(b, thresholds, units));
  return rows;
}

/** Build a single trend bucket's output row. */
function buildBucketRow(b, thresholds, units) {
  const avg = b.cgmCount ? b.cgmSum / b.cgmCount : 0;
  const variance = b.cgmCount ? b.cgmSumSq / b.cgmCount - avg * avg : 0;
  const std = Math.sqrt(Math.max(0, variance));
  const cv = avg ? (std / avg) * 100 : 0;
  const gmi = b.cgmCount
    ? +(3.31 + 0.02392 * (avg * MGDL_PER_MMOL_TREND)).toFixed(2)
    : null;

  // Decimal days actually observed in this bucket (first to last CGM reading).
  // This is the denominator for per-day RATES of things we measure event by
  // event (bolus, carbs), and is correct regardless of calendar boundaries.
  const observedDays = observedDaySpan(b.cgmEpochs);

  // Coverage relative to the observed span at 5-min cadence.
  const expectedReadings = Math.max(1, Math.round(observedDays * 288));
  const coveragePct = +Math.min(100, (b.cgmCount / expectedReadings) * 100).toFixed(1);

  // Sum ALL basal days in this bucket (no whole/partial exclusion). basalDayCount
  // is the number of whole-day basal loads; it may differ slightly from the
  // decimal observedDays, and both are shown so the difference is visible.
  let basalUnits = 0;
  let basalDayCount = 0;
  for (const [, basal] of b.basalByDay) {
    basalUnits += basal;
    basalDayCount++;
  }

  // Bolus is aggregated from events (authoritative, single method).
  const bolusUnits = +b.bolusUnits.toFixed(2);
  const bolusUnitsPerDay = b.bolusUnits / observedDays;
  const avgUnitsPerBolus = b.bolusCount
    ? +(b.bolusUnits / b.bolusCount).toFixed(2)
    : null;

  // Insulin block. Bolus always present (from events). Basal present only when
  // Glooko supplied daily figures: total, day count, average per basal day, and
  // a per-day-rate basal/bolus split.
  const insulin = {
    bolusSource: 'archive-events',
    bolusUnits,
    bolusUnitsPerDay: +bolusUnitsPerDay.toFixed(2),
    bolusEventCount: b.bolusCount,
    avgUnitsPerBolus,
  };
  if (b.hasInsulinData) {
    const averageBasalUnitsPerDay = basalDayCount ? basalUnits / basalDayCount : null;
    insulin.basalSource = 'glooko-daily';
    insulin.basalUnits = +basalUnits.toFixed(2);
    insulin.basalDayCount = basalDayCount;
    insulin.averageBasalUnitsPerDay =
      averageBasalUnitsPerDay == null ? null : +averageBasalUnitsPerDay.toFixed(2);
    if (averageBasalUnitsPerDay != null) {
      const dailyTotal = averageBasalUnitsPerDay + bolusUnitsPerDay;
      insulin.basalPercent = dailyTotal ? +((averageBasalUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
      insulin.bolusPercent = dailyTotal ? +((bolusUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
    }
  }

  const bands = consensusBandsFromCounts(b.bandCounts);
  return {
    bucket: b.key.replace(/^[WF]:/, ''),
    start: new Date(b.firstEpoch * 1000).toISOString(),
    end: new Date(b.lastEpoch * 1000).toISOString(),
    observedDays: +observedDays.toFixed(3),
    glucose: {
      avg: toDisplay(avg, units),
      timeInRange: b.cgmCount ? +((b.inRange / b.cgmCount) * 100).toFixed(2) : 0,
      timeLow: b.cgmCount ? +((b.low / b.cgmCount) * 100).toFixed(2) : 0,
      timeHigh: b.cgmCount ? +((b.high / b.cgmCount) * 100).toFixed(2) : 0,
      timeVeryLow: bands.veryLow,
      timeVeryHigh: bands.veryHigh,
      consensusBands: bands,
      stdDev: toDisplayDelta(std, units),
      coefficientOfVariation: +cv.toFixed(2),
      gmiEstimatedA1c: gmi,
      cgmReadingCount: b.cgmCount,
    },
    insulin,
    carbs: {
      carbsGrams: Math.round(b.carbs),
      carbsPerDay: Math.round(b.carbs / observedDays),
      carbEntryCount: b.carbEntries,
    },
    coverage: {
      cgmReadingCount: b.cgmCount,
      expectedReadingCount: expectedReadings,
      coveragePercent: coveragePct,
      trustworthy: coveragePct >= 70,
    },
  };
}

// --- chart downsampling ---------------------------------------------------

/**
 * Downsample a timeline into at most maxPoints buckets for plotting. Each point
 * carries the average plus min/max for its bucket, so a sharp excursion between
 * samples shows as a band rather than being silently smoothed away. Bolus events
 * are returned separately as markers to overlay (meals/corrections), not folded
 * into the line.
 *
 * The whole purpose is to keep volume OUT of the model's context: a wide chart
 * that would be ~6000 raw readings becomes a few hundred points here, so it is
 * far faster and cheaper to pass through the model and draw. Full resolution
 * remains available via get_glucose_timeline for deliberate close-ups.
 *
 * Returns { points: [{t, avg, min, max, n}], boluses: [{t, units, carbs, class}], requestedMax, actualPoints }.
 */
export function downsampleForChart(timeline, maxPoints, units = 'mmol') {
  const cgm = timeline.filter((i) => i.type === 'CGM');
  const boluses = timeline
    .filter((i) => i.type === 'BOLUS')
    .map((b) => ({
      t: new Date(b.epoch * 1000).toISOString(),
      epoch: b.epoch,
      units: b.units ?? null,
      carbs: b.carbs ?? null,
      class: b.class ?? null,
    }));

  if (!cgm.length) {
    return { points: [], boluses, requestedMax: maxPoints, actualPoints: 0 };
  }

  const cap = Math.max(2, Math.floor(maxPoints) || 200);

  // If there are already fewer readings than the cap, return them as-is
  // (each its own bucket), so short windows keep full fidelity.
  if (cgm.length <= cap) {
    const points = cgm.map((p) => ({
      t: new Date(p.epoch * 1000).toISOString(),
      avg: toDisplay(p.val, units),
      min: toDisplay(p.val, units),
      max: toDisplay(p.val, units),
      n: 1,
    }));
    return { points, boluses, requestedMax: cap, actualPoints: points.length };
  }

  // Bucket by time span so points are evenly spaced on the x-axis (important:
  // bucketing by reading-index would distort spacing across coverage gaps).
  const startEpoch = cgm[0].epoch;
  const endEpoch = cgm[cgm.length - 1].epoch;
  const totalSpan = endEpoch - startEpoch || 1;
  const bucketSpan = totalSpan / cap;

  const buckets = new Map();
  for (const p of cgm) {
    const idx = Math.min(cap - 1, Math.floor((p.epoch - startEpoch) / bucketSpan));
    if (!buckets.has(idx)) {
      buckets.set(idx, { sum: 0, n: 0, min: Infinity, max: -Infinity, firstEpoch: p.epoch });
    }
    const b = buckets.get(idx);
    b.sum += p.val;
    b.n++;
    if (p.val < b.min) b.min = p.val;
    if (p.val > b.max) b.max = p.val;
  }

  const points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      t: new Date((startEpoch + idx * bucketSpan) * 1000).toISOString(),
      avg: toDisplay(b.sum / b.n, units),
      min: toDisplay(b.min, units),
      max: toDisplay(b.max, units),
      n: b.n,
    }));

  return { points, boluses, requestedMax: cap, actualPoints: points.length };
}

// --- daily insulin totals -------------------------------------------------

/**
 * Extract the dailyInsulinTotals block Glooko returns when the
 * totalInsulinPerDay series is requested, into normalised per-day records.
 *
 * The block is keyed by a per-day epoch (seconds). Per the Glooko data, that
 * epoch denotes the calendar day (its UTC date is the day it belongs to, even
 * though the literal time may sit at midday). We key our records by that UTC
 * date string so they line up with the CGM/bolus day.
 *
 * Returns [{ dayUtc, dayEpoch, basalUnits, bolusUnits, totalUnits }].
 * Tight scope: only basal, bolus and total, as agreed.
 */
export function extractDailyInsulin(rawJson) {
  // The block lives under series.dailyInsulinTotals (confirmed against the real
  // Glooko response), NOT at the top level. It is keyed by an epoch at midday
  // UTC of the day it describes.
  const block =
    rawJson && rawJson.series && rawJson.series.dailyInsulinTotals;
  if (!block || typeof block !== 'object') return [];
  const out = [];
  for (const key of Object.keys(block)) {
    const rec = block[key];
    const dayEpoch = parseInt(key, 10);
    if (Number.isNaN(dayEpoch)) continue;
    out.push({
      dayUtc: new Date(dayEpoch * 1000).toISOString().split('T')[0],
      dayEpoch,
      basalUnits: numOrNull(rec.basalUnitsPerDay),
      bolusUnits: numOrNull(rec.bolusUnitsPerDay),
      totalUnits: numOrNull(rec.totalInsulinPerDay),
    });
  }
  return out.sort((a, b) => a.dayEpoch - b.dayEpoch);
}

function numOrNull(v) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
  return +Number(v).toFixed(2);
}


// --- basal delivery state ------------------------------------------------

// Interval series (pump modes, suspendBasal, lgsPlgs, scheduledBasal, ...)
// carry real start/end timestamps; each interval is repeated as several
// drawing points, so take the distinct [timestamp, endTimestamp] pairs.
function modeIntervals(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    if (!p.timestamp || !p.endTimestamp) continue;
    const s = Math.floor(new Date(p.timestamp).getTime() / 1000);
    const e = Math.floor(new Date(p.endTimestamp).getTime() / 1000);
    const key = `${s}|${e}`;
    if (e > s && !seen.has(key)) {
      seen.add(key);
      out.push([s, e]);
    }
  }
  return out;
}

// Glooko mode series -> normalised pump mode. Control-IQ and Omnipod 5 name
// the same ideas differently; HypoProtect is Omnipod's activity feature.
export const PUMP_MODE_SERIES = {
  pumpControliqAutomaticMode: 'automatic',
  pumpControliqManualMode: 'manual',
  pumpControliqSleepMode: 'sleep',
  pumpControliqExerciseMode: 'exercise',
  pumpOp5AutomaticMode: 'automatic',
  pumpOp5ManualMode: 'manual',
  pumpOp5LimitedMode: 'limited',
  pumpOp5HypoprotectMode: 'activity',
  pumpGenericAutomaticMode: 'automatic',
  pumpGenericManualMode: 'manual',
};

/**
 * Pump-mode intervals from Glooko's mode series. Modes can overlap (Control-IQ
 * Sleep or Exercise runs inside automatic). Glooko splits intervals at local
 * midnight (23:59:59 -> 00:00:00), so same-mode intervals within 1 s are
 * merged back together.
 * Returns [{ mode, start, end, startEpoch, endEpoch, minutes }] sorted by start.
 */
export function derivePumpModes(rawJson) {
  const series = rawJson && rawJson.series ? rawJson.series : {};
  const byMode = {};
  for (const [name, mode] of Object.entries(PUMP_MODE_SERIES)) {
    (byMode[mode] ||= []).push(...modeIntervals(series[name]));
  }
  const out = [];
  for (const [mode, ivs] of Object.entries(byMode)) {
    ivs.sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [s, e] of ivs) {
      if (cur && s <= cur[1] + 1) cur[1] = Math.max(cur[1], e);
      else {
        if (cur) out.push([mode, ...cur]);
        cur = [s, e];
      }
    }
    if (cur) out.push([mode, ...cur]);
  }
  return out
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([mode, s, e]) => ({
      mode,
      start: new Date(s * 1000).toISOString(),
      end: new Date(e * 1000).toISOString(),
      startEpoch: s,
      endEpoch: e,
      minutes: Math.round((e - s) / 60),
    }));
}

/**
 * Minutes, share of the window, and episode count per pump mode. Intervals are
 * clipped to [windowStart, windowEnd] (seconds). Modes overlap, so percentages
 * need not sum to 100.
 */
export function summarisePumpModes(intervals, windowStart, windowEnd) {
  if (!intervals || !intervals.length) {
    return { available: false, note: 'No pump-mode data for this window.' };
  }
  const span = Math.max(1, windowEnd - windowStart);
  const out = { available: true, windowHours: +(span / 3600).toFixed(2), modes: {} };
  for (const i of intervals) {
    const secs = Math.min(i.endEpoch, windowEnd) - Math.max(i.startEpoch, windowStart);
    if (secs <= 0) continue;
    const m = (out.modes[i.mode] ||= { minutes: 0, percent: 0, episodes: 0 });
    m.minutes += secs / 60;
    m.episodes += 1;
  }
  for (const m of Object.values(out.modes)) {
    m.percent = +(((m.minutes * 60) / span) * 100).toFixed(1);
    m.minutes = Math.round(m.minutes);
  }
  return out;
}

/**
 * The Omnipod 5 basal delivery state over time, derived from Glooko's bar
 * series. These series are DRAWING instructions (y is only 0/1/null, the bar
 * rising and falling); the information is in the x timestamps. Consecutive
 * pairs of x values bound an interval during which that state was active.
 *
 * Four states, in order of precedence when they overlap:
 *   - 'limited' : pumpOp5LimitedMode. The system LOST CGM signal (>20 min) and
 *                 fell back to a fixed programmed basal. The smart algorithm was
 *                 NOT adjusting. This is "running blind", not an effort level, so
 *                 it takes precedence: anything during limited is reported limited.
 *   - 'max'     : basalBarAutomatedMax. Algorithm delivering at its ceiling,
 *                 typically fighting a rise it cannot otherwise catch.
 *   - 'suspend' : basalBarAutomatedSuspend. Algorithm paused basal, typically to
 *                 prevent a predicted low.
 *   - 'normal'  : basalBarAutomated. Ordinary automated delivery.
 *
 * IMPORTANT: these are STATES, not insulin amounts. 'max' means at the ceiling,
 * 'suspend' means paused; neither is a number of units. Downstream descriptions
 * must stay qualitative.
 *
 * Returns merged, sorted intervals: [{ start, end, state, startEpoch, endEpoch, minutes }].
 */
export function deriveBasalStates(rawJson, windowStartEpoch, windowEndEpoch) {
  const series = rawJson && rawJson.series ? rawJson.series : {};

  // Pull [start,end] intervals from a bar series. Glooko encodes each bar with
  // its y-value: a bar is "on" between the x where y rises to 1 and the x where
  // y falls back to 0. We must pair on these EDGES, not by blind positional
  // (0,1),(2,3) pairing of distinct x's. A series can begin mid-bar (its first
  // point is a falling edge that closes a bar started before the window), and
  // positional pairing then pairs (end,start),(end,start) and silently inverts
  // every interval into the gaps. Tracking the y level avoids that entirely.
  const barIntervals = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return [];
    const out = [];
    let openStart = null; // x at which the current bar turned on, or null
    let prevY = 0;
    for (const p of arr) {
      if (typeof p.x !== 'number') continue;
      const y = p.y === 1 ? 1 : 0; // treat null/0/undefined as off, 1 as on
      if (y === 1 && prevY !== 1) {
        // rising edge: a bar starts here (only if not already open)
        if (openStart === null) openStart = p.x;
      } else if (y !== 1 && prevY === 1) {
        // falling edge: the open bar ends here
        if (openStart !== null && p.x > openStart) out.push([openStart, p.x]);
        openStart = null;
      }
      prevY = y;
    }
    return out;
  };

  // Omnipod 5 encodes basal states as bars. Tandem has no bars: it reports
  // suspensions (suspendBasal; lgsPlgs = Control-IQ / Basal-IQ low-glucose
  // suspends) and profile or temporary basal segments, which mark the time
  // basal was actually being delivered.
  const bars = [
    ...barIntervals(series.basalBarAutomated),
    ...barIntervals(series.basalBarAutomatedSuspend),
    ...barIntervals(series.basalBarAutomatedMax),
  ];
  const suspend = [
    ...barIntervals(series.basalBarAutomatedSuspend),
    ...modeIntervals(series.suspendBasal),
    ...modeIntervals(series.lgsPlgs),
  ];
  const max = barIntervals(series.basalBarAutomatedMax);
  const normal = [
    ...barIntervals(series.basalBarAutomated),
    ...modeIntervals(series.scheduledBasal),
    ...modeIntervals(series.temporaryBasal),
    // Algorithm-modulated basal is not in scheduledBasal; the pump being in
    // any mode means it was delivering unless suspended.
    ...derivePumpModes(rawJson).map((m) => [m.startEpoch, m.endEpoch]),
  ];
  const limited = modeIntervals(series.pumpOp5LimitedMode);
  // With bars, a gap between bars has always been read as normal delivery.
  // Without them, a gap is time with no basal data and gets no state.
  const fillGaps = bars.length > 0;

  // Determine the day/window bounds from the data if not supplied.
  const allStarts = [...suspend, ...max, ...normal, ...limited].map((i) => i[0]);
  const allEnds = [...suspend, ...max, ...normal, ...limited].map((i) => i[1]);
  if (!allStarts.length) return [];
  const lo = windowStartEpoch ?? Math.min(...allStarts);
  const hi = windowEndEpoch ?? Math.max(...allEnds);

  const inAny = (t, ivs) => ivs.some(([s, e]) => t >= s && t < e);

  // Collect all boundary points, classify each sub-interval by precedence.
  const bounds = new Set([lo, hi]);
  for (const [s, e] of [...suspend, ...max, ...normal, ...limited]) {
    if (s >= lo && s <= hi) bounds.add(s);
    if (e >= lo && e <= hi) bounds.add(e);
  }
  const pts = [...bounds].sort((a, b) => a - b);

  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b <= a) continue;
    const mid = a + (b - a) / 2;
    let state;
    if (inAny(mid, limited)) state = 'limited';
    else if (inAny(mid, max)) state = 'max';
    else if (inAny(mid, suspend)) state = 'suspend';
    else if (fillGaps || inAny(mid, normal)) state = 'normal';
    else continue;
    segs.push([a, b, state]);
  }

  // Merge consecutive same-state segments.
  const merged = [];
  for (const [a, b, st] of segs) {
    const last = merged[merged.length - 1];
    if (last && last.state === st && last.endEpoch === a) {
      last.endEpoch = b;
    } else {
      merged.push({ startEpoch: a, endEpoch: b, state: st });
    }
  }

  return merged.map((m) => ({
    state: m.state,
    start: new Date(m.startEpoch * 1000).toISOString(),
    end: new Date(m.endEpoch * 1000).toISOString(),
    startEpoch: m.startEpoch,
    endEpoch: m.endEpoch,
    minutes: Math.round((m.endEpoch - m.startEpoch) / 60),
  }));
}

/**
 * Aggregate basal-state intervals into totals and counts for a window.
 * Returns durations and percentages per state, plus episode counts, with
 * explicit notes on what each state means so the model reasons correctly.
 */
export function summariseBasalStates(intervals) {
  if (!intervals || !intervals.length) {
    return { available: false, note: 'No basal-state data for this window.' };
  }
  const totalSecs = intervals.reduce(
    (a, i) => a + (i.endEpoch - i.startEpoch),
    0
  );
  const byState = { normal: 0, suspend: 0, max: 0, limited: 0 };
  const counts = { normal: 0, suspend: 0, max: 0, limited: 0 };
  for (const i of intervals) {
    byState[i.state] = (byState[i.state] || 0) + (i.endEpoch - i.startEpoch);
    counts[i.state] = (counts[i.state] || 0) + 1;
  }
  const pct = (s) => (totalSecs ? +((s / totalSecs) * 100).toFixed(1) : 0);
  const mins = (s) => Math.round(s / 60);

  return {
    available: true,
    spanHours: +(totalSecs / 3600).toFixed(2),
    normal: { minutes: mins(byState.normal), percent: pct(byState.normal), episodes: counts.normal },
    suspend: { minutes: mins(byState.suspend), percent: pct(byState.suspend), episodes: counts.suspend },
    max: { minutes: mins(byState.max), percent: pct(byState.max), episodes: counts.max },
    limited: { minutes: mins(byState.limited), percent: pct(byState.limited), episodes: counts.limited },
    interpretation: {
      suspend: 'Algorithm paused basal, typically to prevent a predicted low. A state, not zero units quantified.',
      max: 'Algorithm delivering at its ceiling, typically fighting a rise. A state, not a unit amount.',
      limited: 'System lost CGM signal (>20 min) and ran a fixed preset basal. The smart algorithm was NOT adjusting; glucose excursions during limited mode are not attributable to algorithm decisions.',
      normal: 'Ordinary automated delivery.',
    },
  };
}

// --- device events (site / cartridge / sensor changes) -------------------

/**
 * Extract infusion-site (setSiteChange: an Omnipod pod change or a Tandem set
 * change), cartridge (reservoirChange, plus Tandem's "Cartridge Loaded" pump
 * alarm) and CGM sensor (cgmSensorChange) change events from a Glooko
 * response. These are point-in-time markers, not intervals or amounts. Glooko
 * sometimes emits the same event twice (identical timestamp), so we
 * deduplicate by timestamp: same time means the same event.
 *
 * Kept as separate event types. Useful as context for explaining nearby
 * glucose disruption (a fresh site can run high while the cannula settles; a
 * new sensor can read erratically while it warms up), never asserted as a cause.
 *
 * Returns { siteChanges, cartridgeChanges, sensorChanges }, each [{epoch, time}].
 */
export function extractDeviceEvents(rawJson) {
  const series = rawJson && rawJson.series ? rawJson.series : {};

  const dedupe = (arr) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const e of arr) {
      const epoch = typeof e.x === 'number' ? e.x : (e.timestamp ? Math.floor(new Date(e.timestamp).getTime() / 1000) : null);
      if (epoch == null) continue;
      if (seen.has(epoch)) continue; // same timestamp = same event
      seen.add(epoch);
      out.push({ epoch, time: new Date(epoch * 1000).toISOString() });
    }
    return out.sort((a, b) => a.epoch - b.epoch);
  };

  const cartridgeAlarms = (series.pumpAlarm || []).filter((a) =>
    /cartridge loaded/i.test(a?.name || '')
  );
  return {
    siteChanges: dedupe(series.setSiteChange),
    cartridgeChanges: dedupe([...(series.reservoirChange || []), ...cartridgeAlarms]),
    sensorChanges: dedupe(series.cgmSensorChange),
  };
}

// --- device detection ----------------------------------------------------

/**
 * Which pump, CGM and algorithm the account uses, from devices_and_settings
 * (data3) and the series a pull returned (data1). Returns null when Glooko
 * lists no pump. A Tandem Source link shows up as a generic Tandem "pump", so
 * the model falls back to another device of the same brand.
 */
export function detectDevice(settingsJson, rawJson) {
  const pumps = (settingsJson?.devices || []).filter((d) => d?.type === 'pump');
  if (!pumps.length) return null;
  const active =
    pumps.find((d) => d.guid === settingsJson.activePumpGuid) || pumps[0];
  const real = (m) => (m && m !== 'pump' ? m : null);
  const series = rawJson?.series || {};
  const has = (re) =>
    Object.keys(series).some(
      (k) => re.test(k) && Array.isArray(series[k]) && series[k].length
    );
  return {
    pumpBrand: active.brand ?? null,
    pumpModel:
      real(active.model) ??
      real(pumps.find((d) => d.brand === active.brand && real(d.model))?.model) ??
      null,
    cgm: active.properties?.cgmModel ?? null,
    algorithm: has(/^pumpControliq/)
      ? 'Control-IQ'
      : has(/^(pumpOp5|basalBarAutomated)/)
        ? 'SmartAdjust'
        : null,
  };
}

// --- Control-IQ day review ------------------------------------------------

// One exclusive mode per minute so a day sums to 24 h. Sleep and Exercise run
// inside automatic; manual means the algorithm was off, so it wins over both.
const REVIEW_MODE_ORDER = ['manual', 'exercise', 'sleep', 'automatic'];
const REVIEW_MODES = [...REVIEW_MODE_ORDER, 'other', 'unknown'];

export const BASAL_VS_PROFILE_MISSING =
  'Hourly basal-vs-profile deviation is omitted: the archive holds no delivered ' +
  'basal RATE over time. basal_state stores only delivery states ' +
  '(normal/suspend/max/limited, no units); the rate on Glooko\'s scheduledBasal / ' +
  'temporaryBasal segments is not persisted, and the rate Control-IQ actually ' +
  'delivered each 5 minutes is not in the Glooko data this server pulls. Only ' +
  'per-day basal units (daily_insulin) exist. The profile basal schedule is ' +
  'kept only inside the raw settings JSON (pumpProfilesBasal); ' +
  'profileBasalSegmentsStored says whether it holds any segments for this window.';

export const CONTROLIQ_CAVEAT =
  'Descriptive only. A recurring pattern (for example the algorithm correcting ' +
  'at the same hour on most days) is indirect evidence about the profile ' +
  'settings, not a diagnosis; check the n of days and the confidence on each ' +
  'figure. Discuss with your endocrinologist before changing settings. This ' +
  'tool never suggests a new setting value.';

const r2 = (v) => +v.toFixed(2);
const r1 = (v) => +v.toFixed(1);
const confidenceFor = (n) => (n >= 14 ? 'high' : n >= 7 ? 'medium' : 'low');

/**
 * Per-day Control-IQ review over [sEpoch, eEpoch) (seconds). Epochs are pump
 * local wall-clock time (Glooko labels them Z), so UTC day and hour of an
 * epoch ARE the local day and hour. Takes the getProcessedRange bundle.
 * Aggregates use only complete days; incomplete days are listed with reasons.
 */
export function buildControlIqReview(bundle, sEpoch, eEpoch) {
  const modes = bundle.pumpModes || [];
  const boluses = (bundle.timeline || []).filter((i) => i.type === 'BOLUS');
  const dailyByDay = new Map((bundle.dailyInsulin || []).map((d) => [d.dayUtc, d]));
  const isAuto = (b) => b.class === 'Automatic Correction Bolus';

  const days = [];
  const hourAcc = Array.from({ length: 24 }, () => ({
    minutes: Object.fromEntries(REVIEW_MODES.map((m) => [m, 0])),
    autoCount: 0,
    autoUnits: 0,
    autoDays: 0,
  }));

  for (let day0 = Math.floor(sEpoch / 86400) * 86400; day0 < eEpoch; day0 += 86400) {
    const day1 = day0 + 86400;
    const date = new Date(day0 * 1000).toISOString().slice(0, 10);
    const dayModes = modes.filter((m) => m.endEpoch > day0 && m.startEpoch < day1);
    const minutes = Object.fromEntries(REVIEW_MODES.map((m) => [m, 0]));
    const minuteMode = new Array(1440);
    for (let i = 0; i < 1440; i++) {
      const t = day0 + i * 60 + 30;
      let mode = 'unknown';
      if (t >= sEpoch && t < eEpoch) {
        const active = new Set(
          dayModes.filter((m) => t >= m.startEpoch && t < m.endEpoch).map((m) => m.mode)
        );
        if (active.size) mode = REVIEW_MODE_ORDER.find((m) => active.has(m)) || 'other';
      }
      minuteMode[i] = mode;
      minutes[mode] += 1;
    }

    const inDay = boluses.filter((b) => b.epoch >= Math.max(day0, sEpoch) && b.epoch < Math.min(day1, eEpoch));
    const auto = inDay.filter(isAuto);
    const autoUnits = r2(auto.reduce((a, b) => a + (b.units || 0), 0));
    const manualUnits = r2(inDay.filter((b) => !isAuto(b)).reduce((a, b) => a + (b.units || 0), 0));
    const di = dailyByDay.get(date);
    const tdd = di?.totalUnits ?? null;

    const incomplete = [];
    if (day0 < sEpoch || day1 > eEpoch) incomplete.push('day only partly inside the window');
    if (minutes.unknown > 60) incomplete.push(`no pump-mode data for ${minutes.unknown} min`);
    if (!di) incomplete.push('no Glooko daily insulin total');
    else if (!di.complete) incomplete.push('daily insulin total is provisional (day not over)');
    if (di?.bolusUnits != null && Math.abs(di.bolusUnits - (autoUnits + manualUnits)) >= 0.1 - 1e-9)
      incomplete.push(
        `bolus events (${r2(autoUnits + manualUnits)} U) do not match Glooko daily bolus (${di.bolusUnits} U)`
      );

    const row = {
      date,
      complete: incomplete.length === 0,
      ...(incomplete.length ? { incompleteReasons: incomplete } : {}),
      modes: Object.fromEntries(
        REVIEW_MODES.map((m) => [m, { minutes: minutes[m], percent: r1((minutes[m] / 1440) * 100) }])
      ),
      autoBolus: { count: auto.length, units: autoUnits },
      manualBolusUnits: manualUnits,
      basalUnits: di?.basalUnits ?? null,
      totalDailyDose: tdd,
      autoBolusShareOfTddPercent: tdd ? r1((autoUnits / tdd) * 100) : null,
    };
    days.push(row);

    if (!row.complete) continue;
    for (let i = 0; i < 1440; i++) hourAcc[Math.floor(i / 60)].minutes[minuteMode[i]] += 1;
    const seenHours = new Set();
    for (const b of auto) {
      const h = new Date(b.epoch * 1000).getUTCHours();
      hourAcc[h].autoCount += 1;
      hourAcc[h].autoUnits += b.units || 0;
      seenHours.add(h);
    }
    for (const h of seenHours) hourAcc[h].autoDays += 1;
  }

  const full = days.filter((d) => d.complete);
  const n = full.length;
  const sum = (f) => full.reduce((a, d) => a + f(d), 0);
  const tddSum = sum((d) => d.totalDailyDose || 0);
  const autoSum = sum((d) => d.autoBolus.units);

  const summary = {
    daysInWindow: days.length,
    completeDays: n,
    incompleteDays: days.filter((d) => !d.complete).map((d) => d.date),
    confidence: confidenceFor(n),
  };
  if (n) {
    Object.assign(summary, {
      meanModePercent: Object.fromEntries(
        REVIEW_MODES.map((m) => [m, r1(sum((d) => d.modes[m].minutes) / (n * 1440) * 100)])
      ),
      meanAutoBolusPerDay: { count: r1(sum((d) => d.autoBolus.count) / n), units: r2(autoSum / n) },
      meanManualBolusUnitsPerDay: r2(sum((d) => d.manualBolusUnits) / n),
      meanTotalDailyDose: r2(tddSum / n),
      autoBolusShareOfTddPercent: tddSum ? r1((autoSum / tddSum) * 100) : null,
    });
  }

  const byHour = hourAcc.map((h, hour) => ({
    hour,
    nDays: n,
    autoBolus: {
      count: h.autoCount,
      units: r2(h.autoUnits),
      daysWithAutoBolus: h.autoDays,
    },
    modePercent: Object.fromEntries(
      REVIEW_MODES.map((m) => [m, n ? r1((h.minutes[m] / (n * 60)) * 100) : null])
    ),
  }));

  return {
    caveat: CONTROLIQ_CAVEAT,
    notes: [
      'Days and hours are the pump\'s own clock (Glooko stores pump-local time). If the pump clock was wrong (e.g. not moved for a daylight-saving change), hour-of-day figures for those days are shifted.',
      'Modes are made exclusive per minute (manual > exercise > sleep > automatic > other) so each day sums to 1440 min; "unknown" is time with no mode data.',
      'manualBolusUnits is every user-initiated bolus (meal and correction), not insulin given in Manual mode.',
      'Glooko rounds its daily bolus total to 0.1 U, so a bolus-event mismatch under 0.1 U is not flagged.',
      'Period summary and byHour use complete days only (n = completeDays); incomplete days stay in days[] with their reasons.',
    ],
    summary,
    byHour,
    basalVsProfile: {
      available: false,
      missing: BASAL_VS_PROFILE_MISSING,
      profileBasalSegmentsStored: (bundle.settingsHistory || []).some((s) =>
        (s.settings?.pumpProfilesBasal || []).some((p) => p.segments?.length)
      ),
    },
    days,
  };
}

// --- Weekly total daily dose trend ------------------------------------------

export const TDD_TREND_CAVEAT =
  'Descriptive only. Rising TDD with flat glucose and time in range means more ' +
  'insulin is doing the same job (needs went up: weight, activity, illness, ' +
  'hormones); rising TDD with rising glucose means more insulin is not keeping ' +
  'up. TDD per kg and units per gram of logged carbs are rough proxies, not a ' +
  'measured insulin sensitivity. Check the n of weeks and days behind each ' +
  'figure. Discuss with your endocrinologist before changing settings. This tool ' +
  'never suggests a new setting value.';

const MIN_COMPLETE_DAYS_PER_WEEK = 5;
const WEEK = 7 * 86400;

/**
 * Week-over-week total daily dose over [sEpoch, eEpoch) (seconds, pump-local
 * epochs as everywhere else). Weeks are Monday-start calendar weeks. A day
 * counts only when it lies wholly inside the window and Glooko has a final
 * daily total for it. Weeks with fewer than 5 such days are listed but kept
 * out of the change, rolling mean and slope. weights is Google Health weight
 * samples ({ localEpoch, value } in kg); thresholds as getThresholds returns.
 */
export function buildTddTrend(bundle, weights, thresholds, units, sEpoch, eEpoch) {
  const dailyByDay = new Map((bundle.dailyInsulin || []).map((d) => [d.dayUtc, d]));
  const timeline = bundle.timeline || [];
  const weeks = new Map();
  const weekOf = (epoch) => {
    const dow = (new Date(epoch * 1000).getUTCDay() + 6) % 7;
    return Math.floor(epoch / 86400) * 86400 - dow * 86400;
  };

  for (let day0 = Math.floor(sEpoch / 86400) * 86400; day0 < eEpoch; day0 += 86400) {
    const w0 = weekOf(day0);
    if (!weeks.has(w0)) weeks.set(w0, { w0, daysInWindow: 0, days: [] });
    const w = weeks.get(w0);
    w.daysInWindow += 1;
    const di = dailyByDay.get(new Date(day0 * 1000).toISOString().slice(0, 10));
    if (day0 < sEpoch || day0 + 86400 > eEpoch || !di?.complete || di.totalUnits == null) continue;
    const items = timeline.filter((i) => i.epoch >= day0 && i.epoch < day0 + 86400);
    w.days.push({ di, items });
  }

  const rows = [...weeks.values()].map(({ w0, daysInWindow, days }) => {
    const n = days.length;
    const included = n >= MIN_COMPLETE_DAYS_PER_WEEK;
    const row = {
      week: new Date(w0 * 1000).toISOString().slice(0, 10),
      daysInWindow,
      completeDays: n,
      included,
    };
    if (!included)
      row.excludedReason = `${n} complete day(s); at least ${MIN_COMPLETE_DAYS_PER_WEEK} needed for the trend`;
    if (!n) return row;

    const sum = (f) => days.reduce((a, d) => a + (f(d) || 0), 0);
    const tdd = sum((d) => d.di.totalUnits);
    const basal = sum((d) => d.di.basalUnits);
    const bolusesOf = (d) => d.items.filter((i) => i.type === 'BOLUS');
    const auto = sum((d) =>
      bolusesOf(d).filter((b) => b.class === 'Automatic Correction Bolus').reduce((a, b) => a + (b.units || 0), 0)
    );
    const carbs = sum((d) => bolusesOf(d).reduce((a, b) => a + (b.carbs > 0 ? b.carbs : 0), 0));
    const carbEntries = sum((d) => bolusesOf(d).filter((b) => b.carbs > 0).length);
    const cgm = days.flatMap((d) => d.items.filter((i) => i.type === 'CGM').map((i) => i.val));
    const inRange = cgm.filter((v) => v >= thresholds.low && v <= thresholds.high).length;
    const bands = cgm.length ? consensusBands(cgm) : null;

    Object.assign(row, {
      meanTdd: r2(tdd / n),
      meanBasal: r2(basal / n),
      meanBolus: r2(sum((d) => d.di.bolusUnits) / n),
      meanAutoCorrectionUnits: r2(auto / n),
      basalPercent: tdd ? r1((basal / tdd) * 100) : null,
      bolusPercent: tdd ? r1(100 - (basal / tdd) * 100) : null,
      glucose: {
        mean: cgm.length ? toDisplay(cgm.reduce((a, v) => a + v, 0) / cgm.length, units) : null,
        timeInRange: cgm.length ? r1((inRange / cgm.length) * 100) : null,
        timeVeryLow: bands ? bands.veryLow : null,
        timeVeryHigh: bands ? bands.veryHigh : null,
        consensusBands: bands,
        cgmReadings: cgm.length,
      },
    });
    const proxies = {};
    const kg = weights.filter((x) => x.localEpoch >= w0 && x.localEpoch < w0 + WEEK).map((x) => x.value);
    if (kg.length) {
      const sorted = [...kg].sort((a, b) => a - b);
      const med = (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
      proxies.tddPerKg = { value: +(tdd / n / med).toFixed(3), weightKg: r1(med), weighIns: kg.length };
    }
    if (carbs > 0)
      proxies.tddUnitsPerGramLoggedCarbs = { value: +(tdd / carbs).toFixed(3), carbsGrams: Math.round(carbs), carbEntries };
    row.proxies = proxies;
    return row;
  });

  // Change, rolling mean and slope use included weeks only.
  const byW0 = new Map([...weeks.keys()].map((w0, i) => [w0, rows[i]]));
  const firstW0 = weeks.keys().next().value;
  for (const [w0, row] of byW0) {
    if (!row.included) continue;
    const prev = byW0.get(w0 - WEEK);
    row.changeVsPreviousWeek = prev?.included
      ? { units: r2(row.meanTdd - prev.meanTdd), percent: prev.meanTdd ? r1(((row.meanTdd - prev.meanTdd) / prev.meanTdd) * 100) : null }
      : null;
    const last4 = [0, 1, 2, 3].map((k) => byW0.get(w0 - k * WEEK)).filter((r) => r?.included);
    row.rolling4WeekMeanTdd = { value: r2(last4.reduce((a, r) => a + r.meanTdd, 0) / last4.length), nWeeks: last4.length };
  }

  const pts = [...byW0].filter(([, r]) => r.included).map(([w0, r]) => [(w0 - firstW0) / WEEK, r.meanTdd]);
  let slope = null;
  if (pts.length >= 2) {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    slope = r2(pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx);
  }

  // One daily-insulin figure for the whole window: the mean over every complete day.
  const all = [...weeks.values()].flatMap((w) => w.days);
  const allSum = (f) => all.reduce((a, d) => a + (f(d) || 0), 0);
  const allTdd = allSum((d) => d.di.totalUnits);
  const allBasal = allSum((d) => d.di.basalUnits);
  const windowMean = all.length
    ? {
        completeDays: all.length,
        meanTdd: r2(allTdd / all.length),
        meanBasal: r2(allBasal / all.length),
        meanBolus: r2(allSum((d) => d.di.bolusUnits) / all.length),
        meanAutoCorrectionUnits: r2(
          allSum((d) => d.items.filter((i) => i.type === 'BOLUS' && i.class === 'Automatic Correction Bolus').reduce((a, b) => a + (b.units || 0), 0)) / all.length
        ),
        basalPercent: allTdd ? r1((allBasal / allTdd) * 100) : null,
      }
    : { completeDays: 0 };

  return {
    caveat: TDD_TREND_CAVEAT,
    notes: [
      'Weeks are Monday to Sunday on the pump clock (Glooko pump-local days). TDD, basal and bolus are Glooko\'s own daily totals; automatic correction units are summed from the stored bolus events.',
      `A complete day lies wholly inside the window and has a final Glooko daily total. Weeks with fewer than ${MIN_COMPLETE_DAYS_PER_WEEK} complete days stay in weeks[] (included: false) but are left out of changeVsPreviousWeek, rolling4WeekMeanTdd and the slope.`,
      'changeVsPreviousWeek compares with the calendar week before; null when that week is missing or not included. rolling4WeekMeanTdd averages the included weeks among this week and the three before it.',
      'tddPerKg uses the median Google Health weigh-in inside the same week and is omitted when there is none. tddUnitsPerGramLoggedCarbs is the week\'s TDD over its logged carbs, so unlogged meals inflate it. Neither is an insulin sensitivity or carb ratio.',
      'Glucose mean and time in range cover the CGM readings on the same complete days.',
      'windowMean is the mean over every complete day in the window, whatever week it falls in; it is the one daily-insulin figure the report page shows.',
    ],
    windowMean,
    trend: {
      weeksInWindow: rows.length,
      includedWeeks: pts.length,
      slopeUnitsPerWeek: slope,
      confidence: pts.length >= 8 ? 'high' : pts.length >= 4 ? 'medium' : 'low',
    },
    weeks: rows,
  };
}
