import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_BMS_URL =
  'https://in.bookmyshow.com/movies/coimbatore/ramayana/buytickets/ET00523959/20261119?etCodes=ET00523959&language=tamil&refEventCode=ET00523959';

function parseDates() {
  const raw =
    process.env.TARGET_DATES ||
    process.env.TARGET_DATE ||
    '2026-11-20,2026-11-19';

  const list = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeDate);

  return [...new Set(list)].sort();
}

export function normalizeDateInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  throw new Error(`Invalid date "${value}". Use YYYY-MM-DD or YYYYMMDD.`);
}

function normalizeDate(value) {
  const out = normalizeDateInput(value);
  if (!out) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD or YYYYMMDD.`);
  return out;
}

export function toCompactDate(isoDate) {
  return isoDate.replace(/-/g, '');
}

/** Swap the YYYYMMDD segment in the BMS buytickets URL for a given date. */
export function buildBmsUrl(isoDate, baseUrl = config.bmsUrl) {
  const compact = toCompactDate(isoDate);
  try {
    const u = new URL(baseUrl);
    u.pathname = u.pathname.replace(/\/\d{8}(?=\/?$)/, `/${compact}`);
    if (!/\/\d{8}/.test(u.pathname) && /\/buytickets\//i.test(u.pathname)) {
      u.pathname = `${u.pathname.replace(/\/$/, '')}/${compact}`;
    }
    return u.toString();
  } catch {
    return baseUrl.replace(/\d{8}/, compact);
  }
}

export function targetDateParts(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return {
    iso: isoDate,
    compact: toCompactDate(isoDate),
    dayNum: String(d),
    weekday: weekdays[date.getUTCDay()],
    month: months[m - 1],
    label: `${weekdays[date.getUTCDay()]} ${d} ${months[m - 1]}`,
  };
}

/** tls = Safari fingerprint (works on Render) | playwright = local browser */
const checkMode = (process.env.CHECK_MODE || 'tls').toLowerCase();

export const config = {
  role: (process.env.ROLE || 'all').toLowerCase(),
  checkMode: checkMode === 'playwright' ? 'playwright' : 'tls',
  bmsUrl: process.env.BMS_URL || DEFAULT_BMS_URL,
  targetDates: parseDates(),
  cinemaName: (process.env.CINEMA_NAME || 'Broadway Cinemas').trim(),
  formatHint: (process.env.FORMAT_HINT || 'IMAX').trim(),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60_000),
  dashboardPort: Number(process.env.PORT || process.env.DASHBOARD_PORT || 3847),
  reportUrl: (process.env.REPORT_URL || '').replace(/\/$/, ''),
  ingestSecret: process.env.INGEST_SECRET || '',
  mongoUri: (process.env.MONGODB_URI || process.env.MONGO_URL || '').trim(),
  mongoDbName: (process.env.MONGODB_DB || 'bms_monitor').trim() || 'bms_monitor',
};
