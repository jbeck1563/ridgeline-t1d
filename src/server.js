#!/usr/bin/env node
/**
 * server.js — the MCP server and tool definitions (stdio transport).
 *
 * This is the entry point Claude Desktop (and any other MCP client) launches.
 * It builds the MCP server, registers every tool, and connects over stdio. The
 * HTTP/SSE transport in http.js is an alternative front door to the same tools.
 *
 * Each tool is a thin wrapper: validate inputs, resolve the effective glucose
 * unit and boundaries (per-call override, else the server's configured default),
 * pull the data for the window from the archive layer (range.js), hand it to the
 * pure analytics functions (analytics.js), and return the shaped result. The
 * clinical maths lives in analytics.js, not here.
 *
 * Conventions enforced here:
 *  - Credentials come from the environment (GLOOKO_EMAIL / GLOOKO_PASSWORD),
 *    never from tool arguments.
 *  - All timestamps are UTC ISO 8601, in and out (the model resolves the
 *    patient's relative/local phrasing into UTC before calling).
 *  - The server is built by a createServer() factory so each transport/session
 *    gets its own instance (one McpServer cannot serve multiple transports).
 */


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  getProcessedRange,
  assertIsoDate,
  assertWithinCap,
  CAPS,
} from './range.js';
import {
  computeSummary,
  calculateHourly,
  buildEnrichedBolusLog,
  bucketTrend,
  downsampleForChart,
  summariseBasalStates,
  summarisePumpModes,
  getThresholds,
  toDisplay,
  toDisplayDelta,
  calendarBucketKey,
  buildControlIqReview,
  buildTddTrend,
} from './analytics.js';
import { PERSONA_PROMPT } from './prompt.js';
import { ensureHealthFresh, bucketHealth, healthSources } from './health.js';
import { getHealth, getPumpSettingsAt, listPumpSettingsUploads } from './store.js';

/**
 * The server's configured glucose unit and low/high boundaries (OMNI_UNITS,
 * OMNI_LOWER, OMNI_UPPER). Exported so the web page (http.js) labels values
 * with the same unit and range the tools compute with.
 */
export function glucoseDefaults() {
  const u = (process.env.OMNI_UNITS || 'mmol').trim().toLowerCase();
  const units = u === 'mgdl' ? 'mgdl' : 'mmol'; // anything unrecognised -> mmol
  const lo = parseFloat(process.env.OMNI_LOWER);
  const hi = parseFloat(process.env.OMNI_UPPER);
  return {
    units,
    lower: Number.isFinite(lo) ? lo : units === 'mgdl' ? 70 : 3.9,
    upper: Number.isFinite(hi) ? hi : units === 'mgdl' ? 180 : 10.0,
  };
}

// A FACTORY, not a singleton. Each transport (each stdio process, or each HTTP
// session) needs its OWN McpServer: the SDK forbids connecting one server to
// more than one transport. createServer() builds a fully-registered server.
export function createServer() {
const server = new McpServer({
  name: 'ridgeline-t1d',
  version: '1.0.0',
});

// --- Glucose unit & boundary defaults -------------------------------------
// The user sets their preferred unit and target boundaries ONCE in the
// environment (.env); see glucoseDefaults(). Tools then use those by default.
// The per-call units/lower/upper parameters are OPTIONAL overrides: omit them
// to use the configured defaults, or pass them for a one-off.
const { units: ENV_UNITS, lower: ENV_LOWER, upper: ENV_UPPER } = glucoseDefaults();

// Resolve the effective unit/boundaries for a call: a provided parameter wins,
// otherwise the environment default applies.
function resolveThresholdInputs({ units, lower, upper }) {
  return {
    units: units ?? ENV_UNITS,
    lower: lower ?? ENV_LOWER,
    upper: upper ?? ENV_UPPER,
  };
}

// Shared threshold inputs reused across tools. All OPTIONAL: when omitted, the
// handler falls back to the env-configured default (see resolveThresholdInputs).
const unitsSchema = z
  .enum(['mmol', 'mgdl'])
  .optional()
  .describe(
    'Optional. Glucose unit for this call. Omit to use the unit configured on ' +
      'the server (OMNI_UNITS). One of: "mmol" (mmol/L) or "mgdl" (mg/dL). ' +
      'Pass only to override the configured unit for this one call.'
  );
const lowerSchema = z
  .number()
  .optional()
  .describe(
    'Optional. Low (hypo) boundary in the chosen unit; readings below it count ' +
      'as time-low. Omit to use the server default (OMNI_LOWER). Pass only to ' +
      'override for this one call, e.g. to ask about time under a different ' +
      'threshold.'
  );
const upperSchema = z
  .number()
  .optional()
  .describe(
    'Optional. High (hyper) boundary in the chosen unit; readings above it ' +
      'count as time-high. Omit to use the server default (OMNI_UPPER). Pass ' +
      'only to override for this one call.'
  );

const startDesc =
  'Required. Window start as a UTC ISO 8601 timestamp (the trailing Z means ' +
  'UTC), e.g. 2026-06-19T00:00:00.000Z. ALL times in this API are UTC: pass ' +
  'UTC here and convert any local time to UTC first. Resolve relative phrases ' +
  'like "yesterday" or "last 3 weeks" to a concrete UTC value before calling. ' +
  'Treated as inclusive.';
const endDesc =
  'Required. Window end as a UTC ISO 8601 timestamp (Z = UTC), e.g. ' +
  '2026-06-20T00:00:00.000Z. Treated as inclusive and must be after start. ' +
  'All timestamps returned by this API are likewise UTC.';

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// --- get_diabetes_summary -------------------------------------------------
server.registerTool(
  'get_diabetes_summary',
  {
    title: 'Diabetes summary for a window',
    description:
      'The single best starting point for any overview question ("how was my ' +
      'control yesterday / over the last 3 weeks / last 6 months"). Returns ' +
      'fixed-size aggregates no matter how long the span, so it is cheap to call ' +
      'over months and tolerates very long windows.\n\n' +
      'TIP: because this tool is uncapped, a deliberately wide call (e.g. start ' +
      '2000-01-01T00:00:00.000Z, end tomorrow) is the quickest way to discover ' +
      'how much data the system actually holds: the returned reportRange.start ' +
      'and reportRange.end are the first and last readings present in the ' +
      'archive. Use it as an orientation call before drilling into a specific ' +
      'period.\n\n' +
      'Insulin uses the project-wide rule: bolus is summed from individual ' +
      'events; basal comes from Glooko\'s per-day totals. The basal/bolus split ' +
      'is reported as percentages on a per-day-rate basis (a useful balance ' +
      'metric for a closed-loop system). GMI and CV are computed from the CGM ' +
      'readings.\n\n' +
      'Best/worst day and hour are ranked decisively: Time In Range first, then ' +
      'closeness to the glucose target in force at each reading (median absolute ' +
      'deviation), then variability, and each carries those figures so the ' +
      'ranking is explainable.\n\n' +
      'Returns: reportRange (start, end, days, reflecting the actual data ' +
      'present), glucoseControl (averageBG, gmiEstimatedA1c, stdDev, ' +
      'coefficientOfVariation, variability flag, timeInRange/timeLow/timeHigh, ' +
      'cgmReadingCount); glucoseExtremes (highest and lowest readings, each with ' +
      'every timestamped instance); bestWorst (bestDay, worstDay, bestHour, ' +
      'worstHour, each with tir, medianAbsTargetDev, cv); insulin (observedDays, ' +
      'bolusUnits, bolusUnitsPerDay, bolusEventCount, avgUnitsPerBolus, and when ' +
      'Glooko daily data exists basalUnits, basalDayCount, ' +
      'averageBasalUnitsPerDay, basalPercent, bolusPercent); bolusArchitecture ' +
      '(counts by bolus type); carbs (carbsGrams, carbsPerDay, carbEntryCount); ' +
      'settings (the time-segmented profiles in force, from the active profile; ' +
      'fields the pump does not report are null, and settingsNote says when ' +
      'none are available); and device (pumpBrand, pumpModel, cgm, algorithm, ' +
      'or null if unknown). bolusArchitecture.automaticCorrection counts ' +
      'algorithm-delivered boluses (Control-IQ). All timestamps UTC.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      // No span cap here: this tool returns fixed-size aggregates no matter how
      // large the window, so a multi-year summary costs the LLM the same as a
      // single day. An uncapped summary also lets the user/LLM survey the whole
      // archive to locate periods of interest. SQLite handles the aggregation.
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);
      const unitLabel = units === 'mgdl' ? 'mg/dL' : 'mmol/L';
      const summary = computeSummary(
        bundle.timeline,
        bundle.stats,
        bundle.settingsHistory,
        thresholds,
        unitLabel,
        'exact',
        bundle.dailyInsulin
      );
      summary.servedFromArchive = bundle.servedFromArchive;
      summary.device = bundle.device ?? null;
      if (!summary.settings.length) summary.settingsNote = 'Pump settings unavailable for this window.';
      if (!bundle.timeline.length) {
        return jsonResult({
          ...summary,
          note: 'No CGM/bolus data is stored for this window (and none was returned by Glooko on top-up).',
        });
      }
      return jsonResult(summary);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_daily_insulin ----------------------------------------------------
server.registerTool(
  'get_daily_insulin',
  {
    title: 'Daily insulin totals (Glooko per-day figures)',
    description:
      'Glooko\'s own per-day insulin totals shown verbatim: basal units, bolus ' +
      'units and the combined total for each day, plus a window aggregate.\n\n' +
      'Use this when you specifically want the device-reported daily totals (for ' +
      'example a day-by-day basal/bolus table, or "what was my total daily dose ' +
      'each day"). Note: the bolus here is Glooko\'s pre-aggregated daily figure. ' +
      'For bolus aggregated from individual events (the project-wide method used ' +
      'everywhere else), use get_diabetes_summary or get_trend. Basal is only ' +
      'available from Glooko, so this and those tools share the same basal ' +
      'source.\n\n' +
      'The most recent day may be flagged provisional if it is still today and ' +
      'not yet finalised.\n\n' +
      'Returns: source ("glooko-daily"), a days array (date, basalUnits, ' +
      'bolusUnits, totalUnits, provisional), and an aggregate (daysWithData, ' +
      'basalUnits, bolusUnits, totalUnits, basalUnitsPerDay, bolusUnitsPerDay, ' +
      'totalUnitsPerDay, basalPercent). All dates are UTC days.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_daily_insulin');
      const bundle = await getProcessedRange(s, e);
      const days = bundle.dailyInsulin || [];

      const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
      const withValues = days.filter((d) => d.totalUnits != null);
      const sum = (key) =>
        withValues.reduce((a, d) => a + (d[key] || 0), 0);
      const n = withValues.length;
      const provisional = days.filter((d) => !d.complete).map((d) => d.dayUtc);

      return jsonResult({
        window: { start: s, end: e },
        source: 'glooko-daily',
        sourceNote:
          "These are Glooko's own per-day totals as reported by the device, " +
          'shown verbatim (not recomputed from individual bolus events). For ' +
          'bolus aggregated from stored events, see get_diabetes_summary or ' +
          'get_trend.',
        days: days.map((d) => ({
          date: d.dayUtc,
          basalUnits: round(d.basalUnits),
          bolusUnits: round(d.bolusUnits),
          totalUnits: round(d.totalUnits),
          provisional: !d.complete,
        })),
        aggregate: n
          ? {
              daysWithData: n,
              basalUnits: round(sum('basalUnits')),
              bolusUnits: round(sum('bolusUnits')),
              totalUnits: round(sum('totalUnits')),
              basalUnitsPerDay: round(sum('basalUnits') / n),
              bolusUnitsPerDay: round(sum('bolusUnits') / n),
              totalUnitsPerDay: round(sum('totalUnits') / n),
              basalPercent:
                sum('totalUnits') > 0
                  ? Math.round((sum('basalUnits') / sum('totalUnits')) * 100)
                  : null,
            }
          : null,
        note:
          provisional.length > 0
            ? `${provisional.length} day(s) are today/provisional and may rise as the day completes: ${provisional.join(', ')}.`
            : undefined,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_enriched_bolus_log ----------------------------------------------
server.registerTool(
  'get_enriched_bolus_log',
  {
    title: 'Enriched bolus log',
    description:
      'Every bolus in the window, each enriched with the context needed to judge ' +
      'whether it was the right dose: the interpolated CGM value at the moment of ' +
      'delivery, and the ISF, carb ratio, target and DIA in force at that time.\n\n' +
      'Each record also carries delivered vs programmed units (delivered < ' +
      'programmed means the bolus was interrupted, flagged interrupted=true); the ' +
      'calculator recommendation broken into recCorrection, recCarbs and ' +
      'recTotal; whether the user overrode it (override: "above" or "below"); the ' +
      'bloodGlucoseInput and its source the calculator used; the bolus class; and ' +
      'isManual.\n\n' +
      'Use it to investigate insulin stacking, bolus-calculator accuracy, ' +
      'interrupted deliveries and user overrides. Filter with "classes" to pull ' +
      'only the bolus types you care about and keep the response small.\n\n' +
      `Capped to ${CAPS.bolusMaxDays} days per call. All glucose values are in the ` +
      'configured unit and all times are UTC.\n\n' +
      'Returns: count, the classes filter applied, and a boluses array of ' +
      'enriched records (each with time, units, delivered, programmed, ' +
      'interrupted, recCorrection, recCarbs, recTotal, override, bgInput, ' +
      'bgSource, cgm_val, class, isManual, and a context object of the settings ' +
      'in force).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      classes: z
        .array(
          z.enum([
            'Meal Bolus',
            'Manual Correction Bolus',
            'System Correction Bolus',
            'Meal With Correction Bolus',
            'Automatic Correction Bolus'
          ])
        )
        .optional()
        .describe(
          'Optional filter. Array of bolus classes to include. Valid values ' +
          '(use these exact strings): "Meal Bolus" (carb-only dose), ' +
          '"Manual Correction Bolus" (user-initiated correction for a high), ' +
          '"System Correction Bolus" (bolus-calculator correction, no carbs), ' +
          '"Meal With Correction Bolus" (combined carb + correction dose), ' +
          '"Automatic Correction Bolus" (delivered by the algorithm on its own, ' +
          'e.g. a Tandem Control-IQ automatic correction; no user action). ' +
          'Provide one or more to combine, e.g. ["Manual Correction Bolus", ' +
          '"System Correction Bolus"]. Omit or leave empty to return all classes.'
        ),
    },
  },
  async ({ start, end, classes }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.bolusMaxDays, 'get_enriched_bolus_log');
      const bundle = await getProcessedRange(s, e);
      const sEpoch = Date.parse(s) / 1000;
      const eEpoch = Date.parse(e) / 1000;
      const slice = bundle.timeline.filter(
        (i) => i.epoch >= sEpoch && i.epoch <= eEpoch
      );
      let log = buildEnrichedBolusLog(slice, bundle.settingsHistory, resolveThresholdInputs({}).units);

      // Elegantly filter by selected classes if provided
      if (classes && classes.length > 0) {
        log = log.filter((b) => classes.includes(b.class));
      }

      return jsonResult({
        window: { start: s, end: e },
        filterApplied: classes && classes.length > 0 ? classes : 'All',
        count: log.length,
        boluses: log,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_hourly_trends ----------------------------------------------------
server.registerTool(
  'get_hourly_trends',
  {
    title: 'Hourly (circadian) trends',
    description:
      'Time In Range and average glucose pooled by clock-hour across the whole ' +
      'window, so every reading that fell in the 07:00 hour on any day is ' +
      'combined into one 07:00 row, and so on for all 24 hours.\n\n' +
      'Use it for "why am I always high/low at a certain time" questions, ' +
      'recurring circadian patterns, the dawn phenomenon and evening highs.\n\n' +
      'Hours are UTC clock-hours. When presenting to the patient, convert each ' +
      'hour to their local time and label it.\n\n' +
      'Returns: a byHour array of up to 24 rows, each with hour (UTC, "HH:00"), ' +
      'averageBG, timeInRange, timeLow, timeHigh and the reading count for that ' +
      'hour. Glucose values are in the configured unit.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.hourlyMaxDays, 'get_hourly_trends');
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);
      const hourly = calculateHourly(bundle.timeline, thresholds, units);
      return jsonResult({
        window: { start: s, end: e },
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        byHour: hourly,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_settings_history -------------------------------------------------
server.registerTool(
  'get_settings_history',
  {
    title: 'Pump settings history',
    description:
      'Every pump setting change that was in effect during the window, in ' +
      'chronological order: DIA, max basal rate, and the time-segmented target, ' +
      'ISF and carb-ratio profiles.\n\n' +
      'Use it to establish which settings were active at a given time (essential ' +
      'before judging a bolus or an excursion), or to see how settings have been ' +
      'adjusted over a long span.\n\n' +
      'Glucose-based values (target, ISF) are in the configured unit. Effective ' +
      'timestamps are UTC; the per-segment "from" times are pump-schedule ' +
      'clock-hours.\n\n' +
      'Returns: a settings array, each entry with its effective timestamp, ' +
      'DIA_hours, maxBasalRate, and the targetBg, isf and carbRatio profiles ' +
      '(each a list of {from, value} time segments).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_settings_history');
      const bundle = await getProcessedRange(s, e);
      // Reuse computeSummary's settings shaping for consistency. Use the
      // configured display unit so target/ISF profiles come back in the user's
      // unit, not always mmol.
      const cfg = resolveThresholdInputs({});
      const summary = computeSummary(
        bundle.timeline,
        bundle.stats,
        bundle.settingsHistory,
        getThresholds(cfg.units, cfg.lower, cfg.upper),
        cfg.units === 'mgdl' ? 'mg/dL' : 'mmol/L'
      );
      return jsonResult({
        window: { start: s, end: e },
        settings: summary.settings,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_trend ------------------------------------------------------------
server.registerTool(
  'get_trend',
  {
    title: 'Bucketed trend over any timeframe',
    description:
      'Glucose, insulin and carb aggregates split into time buckets across a ' +
      'span, for "how have things changed month by month over the last year" ' +
      'style questions.\n\n' +
      'Each bucket is computed independently from the raw readings (not by ' +
      'averaging averages), so a year split by month returns 12 correct rows in ' +
      'a single call without pulling raw data back to you. Prefer this over ' +
      'making many separate summary calls for a multi-period comparison.\n\n' +
      'Insulin per bucket follows the same rule as elsewhere: bolus is summed ' +
      'from individual events; basal comes from Glooko\'s per-day totals. Each ' +
      'bucket also reports observedDays (the real decimal span of data in it) ' +
      'and a coverage percentage, so you can judge which rows to trust.\n\n' +
      'Returns: bucketCount and a buckets array. Each row has: bucket (period ' +
      'key), start, end, observedDays; glucose (avg, timeInRange, timeLow, ' +
      'timeHigh, stdDev, coefficientOfVariation, gmiEstimatedA1c, ' +
      'cgmReadingCount); insulin (bolusUnits, bolusUnitsPerDay, bolusEventCount, ' +
      'avgUnitsPerBolus, and when Glooko daily data exists basalUnits, ' +
      'basalDayCount, averageBasalUnitsPerDay, basalPercent, bolusPercent); ' +
      'carbs (carbsGrams, carbsPerDay, carbEntryCount); and coverage ' +
      '(cgmReadingCount, expectedReadingCount, coveragePercent, trustworthy).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      mode: z
        .enum(['calendar', 'fixed'])
        .default('calendar')
        .describe(
          'Optional (default: "calendar"). How the span is divided into buckets. ' +
            '"calendar" uses real calendar units (days/weeks/months/quarters) with ' +
            'ragged edges at the ends; "fixed" uses equal-length buckets of ' +
            'fixedSizeDays counting from the start date. Choose the bucket size ' +
            'with "granularity" (calendar) or "fixedSizeDays" (fixed).'
        ),
      granularity: z
        .enum(['day', 'week', 'month', 'quarter'])
        .default('month')
        .describe(
          'Optional (default: "month"). Calendar bucket size. Only used when ' +
            'mode is "calendar". One of: "day", "week", "month", "quarter".'
        ),
      fixedSizeDays: z
        .number()
        .int()
        .positive()
        .default(7)
        .describe(
          'Optional (default: 7). Length of each bucket in days. Only used when ' +
            'mode is "fixed".'
        ),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, mode, granularity, fixedSizeDays, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      // Aggregating tool: generous cap, like the summary.
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_trend');
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);
      const rows = bucketTrend(
        bundle.timeline,
        thresholds,
        {
          mode,
          granularity,
          fixedSizeDays,
          windowStart: Math.floor(Date.parse(s) / 1000),
          windowEnd: Math.floor(Date.parse(e) / 1000),
          units,
        },
        bundle.dailyInsulin
      );
      return jsonResult({
        window: { start: s, end: e },
        mode,
        granularity: mode === 'calendar' ? granularity : `${fixedSizeDays}d`,
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        bucketCount: rows.length,
        buckets: rows,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_health_context ---------------------------------------------------
server.registerTool(
  'get_health_context',
  {
    title: 'Activity, sleep, heart and weight beside glucose and insulin',
    description:
      'Context view: Google Health data (steps, active minutes, workouts, sleep, ' +
      'resting heart rate, HRV, weight, body fat) bucketed by day, week or month, ' +
      'each bucket next to the same glucose/insulin/carb row get_trend returns. ' +
      'Use for "does my glucose move with my sleep / activity / weight" questions.\n\n' +
      'Descriptive only: co-movement in a few buckets is not cause and effect. ' +
      'Health data comes from the Google Health app (phone, watch and scale data ' +
      'synced through Health Connect).\n\n' +
      'Returns: bucketCount, buckets (each: bucket key, the get_trend row fields ' +
      'when Glooko data exists, and health: steps {total, perDay, days}, ' +
      'activeMinutes {perDay, days}, exercise {count, minutes, types}, sleep ' +
      '{nights, avgMinutesAsleep, avgMinutesAwake, avgStageMinutes}, ' +
      'restingHeartRate {avgBpm, days}, hrv {avgRmssdMs, days}, weight {medianKg, ' +
      'weighIns}, bodyFat {medianPercent, readings}; null where no data), ' +
      'sources (which platform/app each type came from; steps and active minutes are Google\'s deduplicated all-source daily totals, ALL_SOURCES_ROLLUP), healthSync (whether the ' +
      'Google pull worked; when ok is false, relay its hint to the patient), and notes.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      granularity: z
        .enum(['day', 'week', 'month'])
        .default('week')
        .describe('Optional (default: "week"). Bucket size: "day", "week" (Monday start) or "month".'),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, granularity, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_health_context');
      const sEpoch = Math.floor(Date.parse(s) / 1000);
      const eEpoch = Math.floor(Date.parse(e) / 1000);
      // Health sync has its own lock and never throws, so Google cannot block Glooko.
      const [bundle, healthSync] = await Promise.all([
        getProcessedRange(s, e),
        ensureHealthFresh(sEpoch),
      ]);
      const trend = bucketTrend(
        bundle.timeline,
        getThresholds(units, lower, upper),
        { mode: 'calendar', granularity, windowStart: sEpoch, windowEnd: eEpoch, units },
        bundle.dailyInsulin
      );
      // Health rows are stored in Glooko's frame (local time as if UTC), so the
      // same window and bucket keys apply directly.
      const health = getHealth(sEpoch, eEpoch);
      const hb = bucketHealth(health, (ep) => calendarBucketKey(ep, granularity).replace(/^W:/, ''));
      const byKey = new Map(trend.map((r) => [r.bucket, r]));
      const keys = [...new Set([...byKey.keys(), ...hb.keys()])].sort();
      const buckets = keys.map((k) => ({ ...(byKey.get(k) || { bucket: k }), health: hb.get(k) || null }));
      return jsonResult({
        window: { start: s, end: e },
        granularity,
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        bucketCount: buckets.length,
        buckets,
        sources: healthSources(health),
        healthSync,
        notes: [
          'Descriptive only (n = 1). Buckets that move together are a hypothesis to discuss with the care team, not a finding; never base a setting change on this view alone.',
          'Days are local days. Health times are the phone\'s local time; Glooko times are the pump clock. The t:slim X2 clock is set by hand, so around a daylight-saving change (or travel) before the pump clock is corrected, Glooko times can be an hour off from health times. Treat hour-level matches as +/-1 h.',
        ],
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_chart_series -----------------------------------------------------
server.registerTool(
  'get_chart_series',
  {
    title: 'Downsampled series for plotting',
    description:
      'Glucose downsampled to a target number of points for drawing a chart, ' +
      'with a min/max band per point so spikes are not lost, plus bolus events ' +
      'as overlay markers.\n\n' +
      'Use this whenever the patient wants a GRAPH or CHART of glucose over a ' +
      'window. It returns a few hundred points instead of every 5-minute reading, ' +
      'so it is far cheaper than get_glucose and a chart cannot show more points ' +
      'than its pixel width anyway. Reserve get_glucose for close-up numeric ' +
      'inspection of a short window, not for wide charts.\n\n' +
      'Glucose values are in the configured unit; times are UTC.\n\n' +
      'Returns: unit, a points array (t, avg, min, max, n per point) and an ' +
      'events array of bolus markers for overlay.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      maxPoints: z
        .number()
        .int()
        .min(20)
        .max(1000)
        .default(250)
        .describe(
          'Optional (default: 250). Target number of plotted points (20-1000). ' +
            '200-400 is plenty for a smooth chart at typical screen widths; higher ' +
            'values cost more for little visual gain.'
        ),
    },
  },
  async ({ start, end, maxPoints }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      // Aggregating/downsampling tool: bounded output, so generous span cap.
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_chart_series');
      const bundle = await getProcessedRange(s, e);
      const sEpoch = Math.floor(Date.parse(s) / 1000);
      const eEpoch = Math.floor(Date.parse(e) / 1000);
      const slice = bundle.timeline.filter(
        (i) => i.epoch >= sEpoch && i.epoch <= eEpoch
      );
      const chartUnits = resolveThresholdInputs({}).units;
      const series = downsampleForChart(slice, maxPoints, chartUnits);
      return jsonResult({
        window: { start: s, end: e },
        unit: chartUnits === 'mgdl' ? 'mg/dL' : 'mmol/L',
        ...series,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_basal_delivery ---------------------------------------------------
server.registerTool(
  'get_basal_delivery',
  {
    title: 'Basal delivery state timeline',
    description:
      'What the pump\'s algorithm was doing with basal over time: delivering ' +
      'normally, pausing it (suspend), running at its ceiling (max), or running ' +
      'blind on a fixed preset because it lost CGM signal (limited). These ' +
      'states come from Omnipod 5 bar series and may be absent for other pumps.\n\n' +
      'Also returns pumpModes: time in each pump mode (automatic, manual, sleep, ' +
      'exercise, limited, activity), from Glooko\'s mode series. For Tandem ' +
      'Control-IQ this is where Sleep and Exercise mode time shows up; for ' +
      'Omnipod 5, limited and activity (HypoProtect).\n\n' +
      'IMPORTANT: these are STATES describing the algorithm\'s behaviour, NOT ' +
      'insulin amounts. "suspend" means paused, "max" means at the ceiling; ' +
      'neither is a number of units. (For basal units, use get_daily_insulin.)\n\n' +
      'Use it to investigate lows (was basal already suspended beforehand?), ' +
      'rebound patterns (max, then suspend, then a low), how hard the system is ' +
      'working, and whether excursions coincided with limited mode (algorithm ' +
      'not adjusting at all).\n\n' +
      'Times are UTC. Capped to a generous span since it returns collapsed ' +
      'intervals, not raw points.\n\n' +
      'Returns: a summary of minutes and percentage per state ' +
      '(normal/suspend/max/limited) and, unless includeIntervals is false, an ' +
      'intervals array (state, start, end, minutes); pumpModes with a per-mode ' +
      'summary (minutes, percent of the window, episodes) and, unless ' +
      'includeIntervals is false, its own intervals (mode, start, end, minutes). ' +
      'Modes can overlap (e.g. sleep inside automatic), so percentages need not ' +
      'sum to 100.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      includeIntervals: z
        .boolean()
        .default(true)
        .describe(
          'Optional (default: true). Whether to include the full interval ' +
            'timeline. Set false to get only the per-state summary totals, which ' +
            'is much smaller over a long span.'
        ),
    },
  },
  async ({ start, end, includeIntervals }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_basal_delivery');
      const bundle = await getProcessedRange(s, e);
      const intervals = bundle.basalStates || [];
      const summary = summariseBasalStates(intervals);
      const modes = bundle.pumpModes || [];
      const result = {
        window: { start: s, end: e },
        summary,
        pumpModes: {
          summary: summarisePumpModes(modes, Date.parse(s) / 1000, Date.parse(e) / 1000),
        },
      };
      if (includeIntervals) {
        result.intervals = intervals.map((i) => ({
          state: i.state,
          start: i.start,
          end: i.end,
          minutes: i.minutes,
        }));
        result.pumpModes.intervals = modes.map((i) => ({
          mode: i.mode,
          start: i.start,
          end: i.end,
          minutes: i.minutes,
        }));
      }
      return jsonResult(result);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_controliq_review ------------------------------------------------
server.registerTool(
  'get_controliq_review',
  {
    title: 'Control-IQ day review (algorithm behaviour per day and hour)',
    description:
      'How hard Tandem Control-IQ worked, day by day. Per pump-local day: ' +
      'minutes and percent in automatic, sleep, exercise and manual mode (plus ' +
      'other and unknown/no-data, so each day sums to 1440 min), automatic ' +
      'correction bolus count and units, user-initiated bolus units, basal ' +
      'units, total daily dose, and the automatic-correction share of TDD.\n\n' +
      'Also a period summary and 24 hour-of-day rows (automatic correction ' +
      'count/units and the number of days with one in that hour, mode share), ' +
      'both over COMPLETE days only with n stated. Days with missing mode data, ' +
      'a provisional or absent daily total, or bolus events that disagree with ' +
      'Glooko\'s daily bolus are flagged with reasons and left out of the ' +
      'aggregates.\n\n' +
      'basalVsProfile is not available: the archive has no time-resolved ' +
      'delivered basal rate; its missing field says exactly what is absent.\n\n' +
      'Output is descriptive. Relay its caveat: patterns are indirect ' +
      'evidence, the patient should discuss them with their endocrinologist ' +
      'before changing settings, and never present a new setting value as an ' +
      'instruction.\n\n' +
      'Days and hours follow the pump clock (Glooko pump-local time).\n\n' +
      'Returns: caveat, notes, summary, byHour, basalVsProfile, days.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_controliq_review');
      const bundle = await getProcessedRange(s, e);
      return jsonResult({
        window: { start: s, end: e },
        device: bundle.device,
        ...buildControlIqReview(bundle, Date.parse(s) / 1000, Date.parse(e) / 1000),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_tdd_trend --------------------------------------------------------
server.registerTool(
  'get_tdd_trend',
  {
    title: 'Week-over-week total daily dose trend',
    description:
      'Is my insulin use going up or down over time? Per Monday-start week ' +
      '(pump-local days): mean total daily dose, mean basal, mean bolus and mean ' +
      'automatic-correction units per day, basal/bolus split, the number of ' +
      'complete days behind the means, and the change vs the previous week ' +
      '(units and %). Weeks with fewer than 5 complete days are flagged ' +
      '(included: false) and left out of the change, the 4-week rolling mean and ' +
      'the slope. trend gives the least-squares slope of weekly mean TDD in units ' +
      'per week with the number of weeks behind it.\n\n' +
      'Each week also carries mean glucose and time in range, and two labelled ' +
      'proxies: TDD per kg (Google Health weigh-in in that week; omitted when ' +
      'none) and TDD per gram of logged carbs (when carbs are logged). Read them ' +
      'together: rising TDD with flat glucose and TIR means more insulin is doing ' +
      'the same job; rising TDD with rising glucose means it is not keeping up. ' +
      'These are proxies, not a measured ISF; never derive an ISF, carb ratio or ' +
      'basal value from them. Relay the caveat: discuss with your ' +
      'endocrinologist before changing settings.\n\n' +
      'Returns: caveat, notes, trend {weeksInWindow, includedWeeks, ' +
      'slopeUnitsPerWeek, confidence}, weeks, healthSync.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_tdd_trend');
      const sEpoch = Math.floor(Date.parse(s) / 1000);
      const eEpoch = Math.floor(Date.parse(e) / 1000);
      const [bundle, healthSync] = await Promise.all([getProcessedRange(s, e), ensureHealthFresh(sEpoch)]);
      // Weigh-ins anywhere in the first/last week count, so widen to whole weeks.
      const weights = getHealth(sEpoch - 7 * 86400, eEpoch + 7 * 86400).samples.filter((x) => x.type === 'weight');
      return jsonResult({
        window: { start: s, end: e },
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        ...buildTddTrend(bundle, weights, getThresholds(units, lower, upper), units, sEpoch, eEpoch),
        healthSync,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_pump_settings ----------------------------------------------------
server.registerTool(
  'get_pump_settings',
  {
    title: 'Tandem pump profile settings (pasted from t:connect)',
    description:
      'The Tandem pump settings the user pasted in from t:connect (Glooko does ' +
      'not carry them): every pump profile (name, active flag, basal / ' +
      'correction factor / carb ratio / target BG segments with pump-local start ' +
      'times, insulin duration, carbs on/off, stated total daily basal), ' +
      'Control-IQ settings (weight, total daily insulin, sleep schedules, ' +
      'insulin duration, target), CGM alerts, general settings and alerts. ' +
      'Returns the snapshot in effect at `at` (the latest upload on or before ' +
      'it; omit for the latest) plus every stored upload date. Glucose units are ' +
      'as printed by the pump. Upload times are the pump clock, not UTC.\n\n' +
      'These are the programmed settings as uploaded, not a measurement. Never ' +
      'present a new setting value as an instruction; relay the caveat.\n\n' +
      'Returns: caveat, at, snapshot (null if none stored by then), uploads.',
    inputSchema: {
      at: z
        .string()
        .optional()
        .describe(
          'Optional. Pump-local date YYYY-MM-DD (whole day counts) or date-time ' +
            'YYYY-MM-DDTHH:MM. Omit for the latest upload.'
        ),
    },
  },
  async ({ at }) => {
    if (at != null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(at)) {
      return errorResult('at must be YYYY-MM-DD or YYYY-MM-DDTHH:MM (pump-local time).');
    }
    const key = at == null ? '9999-12-31T23:59' : at.length === 10 ? `${at}T23:59` : at;
    return jsonResult({
      caveat:
        'Settings as programmed on the pump at upload time. Discuss with your ' +
        'endocrinologist before changing settings.',
      at: at ?? null,
      snapshot: getPumpSettingsAt(key),
      uploads: listPumpSettingsUploads(),
    });
  }
);

// --- get_device_events ----------------------------------------------------
server.registerTool(
  'get_device_events',
  {
    title: 'Infusion site and CGM sensor changes',
    description:
      'Infusion-site changes and CGM sensor changes, as timestamped events, ' +
      'kept as separate lists. A site change is an Omnipod pod change or a ' +
      'Tandem infusion-set (site) change; Tandem cartridge (reservoir) changes ' +
      'are listed separately as cartridgeChanges. podChanges is the historical ' +
      'name for siteChanges and holds the same list.\n\n' +
      'These are point-in-time markers, not amounts. They are most useful as ' +
      'CONTEXT for nearby glucose disruption: a fresh site can run high for the ' +
      'first hours while the cannula settles, and a new sensor can read ' +
      'erratically while it warms up. Use them to check whether an unexplained ' +
      'high or a run of odd readings lines up with a recent change. Treat any ' +
      'such link as a possible contributing factor, never assert it as the ' +
      'cause.\n\n' +
      'Times are UTC.\n\n' +
      'Returns: siteChanges (also as podChanges), cartridgeChanges and ' +
      'sensorChanges arrays of UTC timestamps, plus a count for each.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_device_events');
      const bundle = await getProcessedRange(s, e);
      const ev = bundle.deviceEvents || {};
      const times = (a) => (a || []).map((x) => x.time);
      const site = times(ev.siteChanges);
      return jsonResult({
        window: { start: s, end: e },
        podChanges: site,
        siteChanges: site,
        cartridgeChanges: times(ev.cartridgeChanges),
        sensorChanges: times(ev.sensorChanges),
        counts: {
          podChanges: site.length,
          siteChanges: site.length,
          cartridgeChanges: (ev.cartridgeChanges || []).length,
          sensorChanges: (ev.sensorChanges || []).length,
        },
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);


// --- get_glucose ----------------------------------------------------------
server.registerTool(
  'get_glucose',
  {
    title: 'Glucose readings for a window (filterable by band)',
    description:
      'Individual timestamped CGM readings for a window, optionally filtered to ' +
      'just the part of the range you care about.\n\n' +
      'The "band" option decides which readings come back: "low" (below the low ' +
      'boundary, i.e. hypos), "high" (above the high boundary), "target" (in ' +
      'range), or "all" (every reading, each tagged with its band). Use ' +
      '"low"/"high" to pull only excursions for a close look without dragging in ' +
      'thousands of normal readings; "all" gives the full trace.\n\n' +
      'This returns raw points, so it is capped to ' +
      `${CAPS.timelineMaxDays} days. For a wide chart use get_chart_series ` +
      '(downsampled); for aggregate stats use get_diabetes_summary or get_trend ' +
      'rather than computing over a raw array yourself.\n\n' +
      'Glucose values are in the configured unit; times are UTC.\n\n' +
      'Returns: window, thresholdsUsed (lower, upper, unit), the band requested, ' +
      'count, and a readings array (time, value, velocity, plus band when ' +
      'band="all").',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
      band: z
        .enum(['low', 'high', 'target', 'all'])
        .default('all')
        .describe(
          'Optional (default: "all"). Which readings to return. "low" = below ' +
            'the low boundary (hypo); "high" = above the high boundary (hyper); ' +
            '"target" = in range, between the boundaries inclusive; "all" = every ' +
            'reading, each tagged with its band.'
        ),
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn, band }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.timelineMaxDays, 'get_glucose');
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);

      const sEpoch = Date.parse(s) / 1000;
      const eEpoch = Date.parse(e) / 1000;

      // Classify a reading relative to the boundaries. Target is inclusive of
      // both boundaries; low/high are strictly outside them.
      const bandOf = (v) => {
        if (v < thresholds.low) return 'low';
        if (v > thresholds.high) return 'high';
        return 'target';
      };

      const readings = bundle.timeline
        .filter((i) => {
          if (i.type !== 'CGM') return false;
          if (i.epoch < sEpoch || i.epoch > eEpoch) return false;
          if (band === 'all') return true;
          return bandOf(i.val) === band;
        })
        .map((i) => {
          const r = { time: i.time, value: toDisplay(i.val, units), velocity: toDisplayDelta(i.vel, units) };
          if (band === 'all') r.band = bandOf(i.val);
          return r;
        });

      return jsonResult({
        window: { start: s, end: e },
        thresholdsUsed: {
          lower: toDisplay(thresholds.low, units),
          upper: toDisplay(thresholds.high, units),
          unit: units,
        },
        band,
        count: readings.length,
        readings,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);


// --- get_meal_window_analysis --------------------------------------------
server.registerTool(
  'get_meal_window_analysis',
  {
    title: 'Post-meal target window analysis',
    description:
      'A focused look around a single event (typically a meal bolus): exactly 30 ' +
      'minutes before and 3 hours after the timestamp you pass.\n\n' +
      'Use it to judge a post-meal excursion and how well a dose worked, without ' +
      'pulling whole days. Find the event time first (e.g. from ' +
      'get_enriched_bolus_log), then pass it here.\n\n' +
      'Glucose values are in the configured unit; times are UTC.\n\n' +
      'Returns: targetEvent (the timestamp you passed), unit, a glucoseTimeline ' +
      'array (time, value) across the window, and an associatedBoluses array of ' +
      'enriched bolus records that fall in the window.',
    inputSchema: {
      eventTimestamp: z.string().describe('The concrete UTC ISO 8601 timestamp of the meal/bolus event (Z = UTC). Convert local event times to UTC before calling. Returned times are UTC.'),
      units: unitsSchema,
    },
  },
  async ({ eventTimestamp, units: unitsIn }) => {
    try {
      const { units } = resolveThresholdInputs({ units: unitsIn });
      const eventEpoch = Date.parse(assertIsoDate(eventTimestamp, 'eventTimestamp'));
      const startIso = new Date(eventEpoch - 30 * 60 * 1000).toISOString();
      const endIso = new Date(eventEpoch + 180 * 60 * 1000).toISOString();

      const bundle = await getProcessedRange(startIso, endIso);
      const sEpoch = Date.parse(startIso) / 1000;
      const eEpoch = Date.parse(endIso) / 1000;

      const slice = bundle.timeline.filter((i) => i.epoch >= sEpoch && i.epoch <= eEpoch);
      const cgm = slice.filter((i) => i.type === 'CGM');
      const boluses = buildEnrichedBolusLog(slice, bundle.settingsHistory, units);

      return jsonResult({
        targetEvent: eventTimestamp,
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        glucoseTimeline: cgm.map((i) => ({ time: i.time, value: toDisplay(i.val, units) })),
        associatedBoluses: boluses,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);


// --- persona prompt -------------------------------------------------------
server.registerPrompt(
  'clinical_auditor',
  {
    title: 'Clinical auditor persona',
    description:
      'The tough-love endocrinologist persona and audit workflow. Load this to ' +
      'set the analytical frame before asking diabetes questions.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: PERSONA_PROMPT },
      },
    ],
  })
);

  return server;
}

async function main() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
  // stderr is safe for logging; stdout is the MCP channel.
  console.error('[ridgeline] MCP server running on stdio.');
}

// Only start the stdio transport when this file is run directly. When http.js
// imports `server` to attach an HTTP/SSE transport instead, this must NOT fire
// (stdio would fight the HTTP transport for the same server, and stdout).
import { fileURLToPath } from 'url';
import { argv } from 'process';
const isDirectEntry =
  argv[1] && fileURLToPath(import.meta.url) === argv[1];

if (isDirectEntry) {
  main().catch((err) => {
    console.error('[ridgeline] Fatal:', err);
    process.exit(1);
  });
}
