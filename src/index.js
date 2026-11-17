import { config, buildBmsUrl, targetDateParts } from './config.js';
import { startDashboard } from './dashboard.js';
import { writeStatus, readStatus } from './statusStore.js';
import { processCheckResults } from './processResults.js';
import {
  initMonitorStore,
  getMonitor,
  enabledDates,
  enabledCinemas,
  closeMonitorStore,
} from './monitorStore.js';

const once = process.argv.includes('--once');

async function loadChecker() {
  if (config.checkMode === 'playwright') {
    const mod = await import('./checkShows.js');
    return mod.checkAllDates;
  }
  const mod = await import('./checkShowsTls.js');
  return mod.checkAllDates;
}

async function fetchRemoteMonitor() {
  if (!config.reportUrl) return getMonitor(true);
  const res = await fetch(`${config.reportUrl}/api/monitor`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch remote monitor (${res.status})`);
  return res.json();
}

async function postIngest(results) {
  if (!config.reportUrl) return null;
  if (!config.ingestSecret) {
    console.warn('[ingest] REPORT_URL set but INGEST_SECRET missing — skip post');
    return null;
  }
  const res = await fetch(`${config.reportUrl}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ingestSecret}`,
    },
    body: JSON.stringify({ results }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ingest failed (${res.status}): ${body.error || res.statusText}`);
  }
  console.log(`[ingest] posted ${results.length} result(s) → ${config.reportUrl}`);
  return body;
}

async function runCheck() {
  const useRemote = config.role === 'worker' && !!config.reportUrl;
  const monitor = useRemote ? await fetchRemoteMonitor() : await getMonitor(true);
  const dates = enabledDates(monitor);
  const cinemas = enabledCinemas(monitor);
  console.log(
    `\n[${new Date().toLocaleString()}] ${monitor.movieName} @ ${cinemas.join(' | ') || '(no theatre)'} | dates: ${dates.join(', ') || '(none enabled)'} [${config.checkMode}]`,
  );

  const prevStatus = readStatus();
  writeStatus({
    ...prevStatus,
    checking: true,
    movieName: monitor.movieName,
    cinemaName: monitor.cinemaName,
    cinemas: monitor.cinemas,
    city: monitor.city,
    targetDates: dates,
    monitor,
  });

  if (!dates.length) {
    writeStatus({
      ...readStatus(),
      checking: false,
      updatedAt: new Date().toISOString(),
      dates: [],
      reason: 'No dates enabled — turn on dates in Settings',
    });
    console.log('[check] No dates enabled — skipping');
    return [];
  }

  if (!cinemas.length) {
    console.log('[check] No theatres enabled — skipping');
    return [];
  }

  const checkAllDates = await loadChecker();
  const results = await checkAllDates(dates, {
    cinemaNames: cinemas,
    bmsUrl: monitor.bmsUrl,
  });

  if (config.role !== 'worker') {
    await processCheckResults(results, {
      source: config.checkMode === 'tls' ? 'render-tls' : 'local',
    });
  }

  if (config.role === 'worker' || config.reportUrl) {
    await postIngest(results);
  }

  return results;
}

async function seedStatus() {
  const monitor = await getMonitor();
  const dates = enabledDates(monitor);
  const waitingWorker = config.role === 'dashboard';
  writeStatus({
    updatedAt: null,
    checking: false,
    source: waitingWorker ? 'waiting-worker' : 'starting',
    movieName: monitor.movieName,
    cinemaName: monitor.cinemaName,
    city: monitor.city,
    formatHint: monitor.formatHint,
    notificationsEnabled: monitor.notificationsEnabled !== false,
    targetDates: dates,
    bmsUrl: monitor.bmsUrl,
    monitor,
    dates: dates.map((date) => ({
      date,
      label: targetDateParts(date).label,
      listed: false,
      open: false,
      shows: [],
      newShows: [],
      pageUrl: buildBmsUrl(date, monitor.bmsUrl),
      checkedAt: null,
      error: null,
      reason: waitingWorker
        ? 'Waiting for local worker (Render IPs are blocked by BookMyShow)'
        : 'Waiting for first check',
    })),
    alerts: [],
    alert: null,
  });
}

async function main() {
  await initMonitorStore();
  const monitor = await getMonitor();

  console.log('BookMyShow booking monitor');
  console.log(`ROLE=${config.role} | CHECK_MODE=${config.checkMode} | storage=${monitor.storage}`);
  if (config.reportUrl) console.log(`REPORT_URL=${config.reportUrl}`);
  console.log(`Movie: ${monitor.movieName}`);
  console.log(`Theatre: ${monitor.cinemaName}${monitor.city ? ` · ${monitor.city}` : ''}`);
  console.log(`Rule: redirect / greyed date = NOT OPEN | selected available date = OPEN`);
  console.log(`Base URL: ${monitor.bmsUrl}`);
  for (const d of monitor.dates) {
    const mark = d.enabled === false ? 'OFF' : 'ON';
    console.log(`  [${mark}] ${d.label} (${d.date}) → ${buildBmsUrl(d.date, monitor.bmsUrl)}`);
  }

  if (config.role !== 'worker') {
    startDashboard();
    await seedStatus();
  }

  if (config.role === 'dashboard') {
    console.log('');
    console.log('Dashboard mode: not checking BMS from this host (Cloudflare blocks Render).');
    console.log('Run a local worker: ROLE=worker CHECK_MODE=playwright REPORT_URL=<this-url> INGEST_SECRET=<secret>');
    // Keep process alive for the web service
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, 60 * 60 * 1000));
    }
  }

  if (once) {
    await runCheck();
    await closeMonitorStore();
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCheck();
    } catch (err) {
      console.error('[error]', err.message || err);
      if (config.role !== 'worker') {
        const prev = readStatus();
        writeStatus({
          ...prev,
          updatedAt: new Date().toISOString(),
          checking: false,
          error: err.message || String(err),
        });
      }
    }
    console.log(`Sleeping ${config.pollIntervalMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeMonitorStore();
  process.exit(1);
});
