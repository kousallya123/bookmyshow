import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { config, targetDateParts, normalizeDateInput } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(__dirname, '..', 'data', 'monitor.json');

const DOC_ID = 'default';

let client = null;
let db = null;
let cache = null;
let cacheAt = 0;
const CACHE_MS = 2_000;

function defaultMonitor() {
  const cinemaName = config.cinemaName;
  return {
    _id: DOC_ID,
    movieName: process.env.MOVIE_NAME || 'Ramayana (Tamil)',
    cinemaName,
    cinemas: [{ name: cinemaName, enabled: true }],
    city: process.env.CITY || 'Coimbatore',
    formatHint: config.formatHint,
    bmsUrl: config.bmsUrl,
    notificationsEnabled: true,
    dates: config.targetDates.map((date) => ({
      date,
      enabled: true,
      label: targetDateParts(date).label,
    })),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeCinemas(input = {}, baseCinemaName) {
  const raw = Array.isArray(input.cinemas) ? input.cinemas : null;
  const list = [];
  const seen = new Set();

  const push = (name, enabled = true) => {
    const n = String(name || '').trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ name: n, enabled: enabled !== false });
  };

  if (raw?.length) {
    for (const item of raw) {
      if (typeof item === 'string') push(item, true);
      else push(item?.name, item?.enabled !== false);
    }
  }

  // Legacy single theatre field
  if (!list.length && input.cinemaName) push(input.cinemaName, true);
  if (!list.length) push(baseCinemaName, true);

  return list;
}

function ensureFileDir() {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readFileMonitor() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeMonitor(raw);
  } catch {
    const seed = defaultMonitor();
    ensureFileDir();
    fs.writeFileSync(filePath, JSON.stringify(seed, null, 2));
    return seed;
  }
}

function writeFileMonitor(doc) {
  ensureFileDir();
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
}

function normalizeMonitor(input = {}) {
  const base = defaultMonitor();
  const datesRaw = Array.isArray(input.dates) ? input.dates : base.dates;
  const dates = [];
  const seen = new Set();

  for (const item of datesRaw) {
    const iso =
      typeof item === 'string'
        ? normalizeDateInput(item)
        : normalizeDateInput(item?.date || '');
    if (!iso || seen.has(iso)) continue;
    seen.add(iso);
    dates.push({
      date: iso,
      enabled: typeof item === 'object' ? item.enabled !== false : true,
      label: targetDateParts(iso).label,
    });
  }

  if (!dates.length) {
    for (const d of base.dates) dates.push({ ...d });
  }

  const cinemas = normalizeCinemas(input, base.cinemaName);
  const cinemaName = cinemas.find((c) => c.enabled !== false)?.name || cinemas[0]?.name || base.cinemaName;

  return {
    _id: DOC_ID,
    movieName: String(input.movieName || base.movieName).trim() || base.movieName,
    cinemaName,
    cinemas,
    city: String(input.city || base.city).trim() || base.city,
    formatHint: String(input.formatHint ?? base.formatHint).trim(),
    bmsUrl: String(input.bmsUrl || base.bmsUrl).trim() || base.bmsUrl,
    notificationsEnabled: input.notificationsEnabled !== false,
    dates: dates.sort((a, b) => a.date.localeCompare(b.date)),
    updatedAt: input.updatedAt || new Date().toISOString(),
    storage: input.storage || (config.mongoUri ? 'mongodb' : 'file'),
  };
}

async function getCollection() {
  if (!config.mongoUri) return null;
  if (db) return db.collection('bms_monitors');
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.mongoDbName);
  console.log(`[monitor] MongoDB connected → ${config.mongoDbName}`);
  return db.collection('bms_monitors');
}

export async function initMonitorStore() {
  cache = null;
  try {
    const col = await getCollection();
    if (!col) {
      cache = readFileMonitor();
      cache.storage = 'file';
      console.log('[monitor] Using file store data/monitor.json (set MONGODB_URI for MongoDB)');
      return cache;
    }
    const existing = await col.findOne({ _id: DOC_ID });
    if (!existing) {
      const seed = { ...defaultMonitor(), storage: 'mongodb' };
      await col.insertOne(seed);
      cache = seed;
    } else {
      cache = normalizeMonitor({ ...existing, storage: 'mongodb' });
    }
    cacheAt = Date.now();
    return cache;
  } catch (err) {
    console.warn(`[monitor] MongoDB unavailable (${err.message}) — falling back to file`);
    cache = readFileMonitor();
    cache.storage = 'file';
    cacheAt = Date.now();
    return cache;
  }
}

export async function getMonitor(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  try {
    const col = await getCollection();
    if (!col) {
      cache = readFileMonitor();
      cache.storage = 'file';
      cacheAt = Date.now();
      return cache;
    }
    const doc = await col.findOne({ _id: DOC_ID });
    cache = normalizeMonitor({ ...(doc || defaultMonitor()), storage: 'mongodb' });
    cacheAt = Date.now();
    return cache;
  } catch (err) {
    console.warn(`[monitor] read failed: ${err.message}`);
    cache = readFileMonitor();
    cache.storage = 'file';
    cacheAt = Date.now();
    return cache;
  }
}

export async function saveMonitor(patch = {}) {
  const current = await getMonitor(true);
  const next = normalizeMonitor({
    ...current,
    ...patch,
    dates: patch.dates !== undefined ? patch.dates : current.dates,
    cinemas: patch.cinemas !== undefined ? patch.cinemas : current.cinemas,
    updatedAt: new Date().toISOString(),
  });

  try {
    const col = await getCollection();
    if (col) {
      next.storage = 'mongodb';
      await col.updateOne({ _id: DOC_ID }, { $set: next }, { upsert: true });
    } else {
      next.storage = 'file';
      writeFileMonitor(next);
    }
  } catch (err) {
    console.warn(`[monitor] save mongo failed (${err.message}) — writing file`);
    next.storage = 'file';
    writeFileMonitor(next);
  }

  cache = next;
  cacheAt = Date.now();
  return next;
}

export function enabledDates(monitor) {
  return (monitor?.dates || []).filter((d) => d.enabled !== false).map((d) => d.date);
}

export function enabledCinemas(monitor) {
  const list = (monitor?.cinemas || [])
    .filter((c) => c && c.enabled !== false && String(c.name || '').trim())
    .map((c) => String(c.name).trim());
  if (list.length) return list;
  if (monitor?.cinemaName) return [String(monitor.cinemaName).trim()];
  return [config.cinemaName];
}

export async function closeMonitorStore() {
  if (client) {
    await client.close().catch(() => {});
    client = null;
    db = null;
  }
}
