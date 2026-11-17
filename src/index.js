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

async function runCheck() {
  const monitor = await getMonitor(true);
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
  await processCheckResults(results, {
    source: config.checkMode === 'tls' ? 'render-tls' : 'local',
  });
  return results;
}

async function seedStatus() {
  const monitor = await getMonitor();
  const dates = enabledDates(monitor);
  writeStatus({
    updatedAt: null,
    checking: false,
    source: 'starting',
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
      reason: 'Waiting for first check',
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
  console.log(`Movie: ${monitor.movieName}`);
  console.log(`Theatre: ${monitor.cinemaName}${monitor.city ? ` · ${monitor.city}` : ''}`);
  console.log(`Rule: redirect / greyed date = NOT OPEN | selected available date = OPEN`);
  console.log(`Base URL: ${monitor.bmsUrl}`);
  for (const d of monitor.dates) {
    const mark = d.enabled === false ? 'OFF' : 'ON';
    console.log(`  [${mark}] ${d.label} (${d.date}) → ${buildBmsUrl(d.date, monitor.bmsUrl)}`);
  }

  startDashboard();
  await seedStatus();

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
      const prev = readStatus();
      writeStatus({
        ...prev,
        updatedAt: new Date().toISOString(),
        checking: false,
        error: err.message || String(err),
      });
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
