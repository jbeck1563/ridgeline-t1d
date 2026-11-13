/**
 * tandem-settings.js — parse the pump settings text copied from Tandem's
 * t:connect web "pump settings" view into a structured snapshot.
 *
 * Pure: text in, object out, no I/O. Glooko never receives a Tandem pump's
 * profile settings, so this paste is the only source for them.
 *
 * PRIVACY: the header block (name, date of birth) and the pump serial number and
 * CGM transmitter ID are dropped here, at parse time, and never reach the
 * snapshot or its warnings.
 *
 * Times stay as the pump printed them (pump-local). Glucose units stay as
 * printed (mmol/L or mg/dL); nothing is converted.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TIME = String.raw`(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?`;
const pad = (n) => String(n).padStart(2, '0');

/** "12:00 a.m." -> 0, "5:30 p.m." -> 1050 (minutes after pump-local midnight); null if not a time. */
export function minutesOf(text) {
  const m = new RegExp(`^${TIME}$`, 'i').exec(text.trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h < 1 || h > 12 || min > 59) return null;
  return ((h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + min;
}

const hhmm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const onOff = (v) => (/^on\b/i.test(v) ? true : /^off\b/i.test(v) ? false : null);
const numIn = (v) => {
  const m = /-?\d+(?:\.\d+)?/.exec(v);
  return m ? +m[0] : null;
};
// "3 hrs", "4 hrs 30 mins", "5 hours" -> hours
function hoursOf(v) {
  const h = /(\d+(?:\.\d+)?)\s*h/i.exec(v), m = /(\d+)\s*min/i.exec(v);
  if (!h && !m) return null;
  return (h ? +h[1] : 0) + (m ? +m[1] / 60 : 0);
}
const camel = (label) =>
  label
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toLowerCase());
// "-" means "not set" on the t:connect page.
const raw = (v) => (v === '-' || v === '' ? null : v);

// "Nov 5, 2026, 10:40 p.m." -> "2026-11-05T22:40" (pump-local, no zone)
function uploadStamp(v) {
  const m = new RegExp(String.raw`^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4}),?\s+(${TIME})$`, 'i').exec(v.trim());
  const mon = m && MONTHS[m[1].toLowerCase()];
  const mins = m && minutesOf(m[4]);
  if (!mon || mins == null) return null;
  return `${m[3]}-${pad(mon)}-${pad(+m[2])}T${hhmm(mins)}`;
}

const TABLES = {
  'basal rate': 'basal',
  'correction factor': 'correctionFactor',
  'carb ratio': 'carbRatio',
  'target bg': 'targetBg',
};

/**
 * Parse the copied text. Throws when no profile section or no upload date is
 * found. Lines it does not recognise land in `warnings` (never header lines,
 * which can hold the name).
 */
export function parseTandemSettings(text) {
  if (typeof text !== 'string') throw new Error('Expected the copied settings text as a string.');
  const lines = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n').map((l) => l.trim());

  const snap = {
    uploadDate: null,
    pump: null,
    glucoseUnit: null,
    profiles: [],
    controlIq: null,
    cgm: null,
    general: null,
    alerts: null,
    warnings: [],
  };
  let section = 'header'; // header | profile | controlIq | cgm | general | alerts
  let profile = null;
  let table = null; // key into TABLES values while reading segment rows
  let tableUnit = null;
  let inSleep = false;
  const warn = (line) => snap.warnings.push(`${section}: ${line}`);

  for (const line of lines) {
    if (!line) continue;
    let m;

    // Section headers.
    if ((m = /^Pump Profile settings\s*-\s*(.+)$/i.exec(line))) {
      profile = {
        name: m[1].trim(),
        active: false,
        basal: [],
        totalDailyBasal: null,
        correctionFactor: [],
        carbRatio: [],
        targetBg: [],
        insulinDurationHours: null,
        carbohydrates: null,
      };
      snap.profiles.push(profile);
      section = 'profile';
      table = null;
      continue;
    }
    const named = { 'control-iq settings': 'controlIq', 'cgm settings': 'cgm', 'general settings': 'general', 'alerts & reminders': 'alerts' }[line.toLowerCase()];
    if (named) {
      section = named;
      snap[named] ??= {};
      table = null;
      inSleep = false;
      continue;
    }

    if (section === 'header') {
      if ((m = /^Upload date:\s*(.+)$/i.exec(line))) {
        snap.uploadDate = uploadStamp(m[1]);
        if (!snap.uploadDate) snap.warnings.push('header: upload date not understood');
      } else if ((m = /^(.*?Insulin Pump)\b.*\(([^()]+)\)$/i.exec(line))) {
        // Keep model and firmware only; the "No. <serial>" between them is dropped.
        snap.pump = { model: m[1].replace(/[™®]/g, '').replace(/\s+/g, ' ').trim(), firmware: m[2].trim() };
      }
      // Anything else in the header (name, date of birth) is dropped silently.
      continue;
    }

    if (section === 'profile') {
      if (/^Active at upload$/i.test(line)) { profile.active = true; continue; }
      if ((m = /^Time\s+(Basal Rate|Correction Factor|Carb Ratio|Target BG)\s*\(([^)]*)\)$/i.exec(line))) {
        table = TABLES[m[1].toLowerCase()];
        tableUnit = m[2].split(':').pop().trim();
        if (table === 'correctionFactor' || table === 'targetBg') {
          snap.glucoseUnit ??= tableUnit;
          if (tableUnit !== snap.glucoseUnit) warn(`mixed glucose units (${tableUnit} vs ${snap.glucoseUnit})`);
        }
        continue;
      }
      if ((m = new RegExp(`^(${TIME})\\s+(.+)$`, 'i').exec(line)) && table) {
        const start = minutesOf(m[1]);
        const v = m[5].trim();
        const ratio = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(v);
        const value = table === 'correctionFactor' || table === 'carbRatio' ? (ratio ? +ratio[1] : null) : /^\d+(?:\.\d+)?$/.test(v) ? +v : null;
        if (start == null || value == null) { warn(line); continue; }
        const seg = { start, time: hhmm(start) };
        if (table === 'basal') seg.unitsPerHour = value;
        else if (table === 'correctionFactor') seg.glucosePerUnit = value;
        else if (table === 'carbRatio') seg.gramsPerUnit = value;
        else seg.value = value;
        profile[table].push(seg);
        continue;
      }
      if ((m = /^Total Daily Basal:\s*(.+)$/i.exec(line))) { profile.totalDailyBasal = numIn(m[1]); continue; }
      if ((m = /^Insulin Duration:\s*(.+)$/i.exec(line))) { profile.insulinDurationHours = hoursOf(m[1]); continue; }
      if ((m = /^Carbohydrates:\s*(.+)$/i.exec(line))) { profile.carbohydrates = onOff(m[1]); continue; }
      warn(line);
      continue;
    }

    if (section === 'controlIq') {
      const c = snap.controlIq;
      if (/^Sleep schedules$/i.test(line)) { inSleep = true; c.sleepSchedules = []; continue; }
      if (inSleep && (m = new RegExp(`^(.*?)\\s*\\((${TIME})\\s*-\\s*(${TIME})\\)\\s*:\\s*(\\S+)$`, 'i').exec(line))) {
        c.sleepSchedules.push({ name: m[1], start: hhmm(minutesOf(m[2])), end: hhmm(minutesOf(m[6])), enabled: onOff(m[10]) });
        continue;
      }
      if (inSleep && /^-\s*:/.test(line)) continue; // an empty schedule slot
      if ((m = /^([^:]+):\s*(.*)$/.exec(line))) {
        const [, k, v] = m;
        inSleep = false;
        if (/^Control-IQ$/i.test(k)) c.enabled = onOff(v);
        else if (/^Weight$/i.test(k)) c.weight = { value: numIn(v), unit: v.replace(/^[\d.\s]+/, '') || null };
        else if (/^Total daily insulin$/i.test(k)) c.totalDailyInsulin = numIn(v);
        else if (/^Insulin duration$/i.test(k)) c.insulinDurationHours = hoursOf(v);
        else if (/^Target BG$/i.test(k)) c.targetBg = { value: numIn(v), unit: v.replace(/^[\d.\s]+/, '') || null };
        else warn(line);
        continue;
      }
      warn(line);
      continue;
    }

    // cgm, general, alerts: plain "Label: value" lines, value kept as printed.
    if ((m = /^([^:]+):\s*(.*)$/.exec(line))) {
      const [, k, v] = m;
      if (section === 'cgm' && /^TX ID$/i.test(k)) continue; // transmitter ID: never stored
      snap[section][camel(k)] = raw(v);
      continue;
    }
    warn(line);
  }

  if (!snap.profiles.length) {
    throw new Error('No "Pump Profile settings" section found. Paste the text copied from the t:connect pump settings page.');
  }
  if (!snap.uploadDate) {
    throw new Error('No readable "Upload date:" line found. Paste the whole copied text, header included.');
  }
  for (const p of snap.profiles) {
    if (!p.basal.length) snap.warnings.push(`profile ${p.name}: no basal segments`);
  }
  return snap;
}
