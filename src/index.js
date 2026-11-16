import { config, buildBmsUrl, targetDateParts } from './config.js';
import { startDashboard } from './dashboard.js';
import { writeStatus, readStatus } from './statusStore.js';
import { processCheckResults } from './processResults.js';

const once = process.argv.includes('--once');

async function loadChecker() {
  // TLS Safari fingerprint works on Render (Playwright gets Cloudflare 403)
  if (config.checkMode === 'playwright') {
    const mod = await import('./checkShows.js');
    return mod.checkAllDates;
  }
  const mod = await import('./checkShowsTls.js');
  return mod.checkAllDates;
}

async function runCheck() {
  console.log(
    `\n[${new Date().toLocaleString()}] Checking dates: ${config.targetDates.join(', ')} [${config.checkMode}]`,
  );

  const prevStatus = readStatus();
  writeStatus({
    ...prevStatus,
    checking: true,
    cinemaName: config.cinemaName,
    targetDates: config.targetDates,
  });

  const checkAllDates = await loadChecker();
  const results = await checkAllDates(config.targetDates);
  await processCheckResults(results, {
    source: config.checkMode === 'tls' ? 'render-tls' : 'local',
  });
  return results;
}

function seedStatus() {
  writeStatus({
    updatedAt: null,
    checking: false,
    source: 'starting',
    cinemaName: config.cinemaName,
    formatHint: config.formatHint,
    targetDates: config.targetDates,
    bmsUrl: config.bmsUrl,
    dates: config.targetDates.map((date) => ({
      date,
      label: targetDateParts(date).label,
      listed: false,
      open: false,
      shows: [],
      newShows: [],
      pageUrl: buildBmsUrl(date),
      checkedAt: null,
      error: null,
      reason: 'Waiting for first check',
    })),
    alerts: [],
    alert: null,
  });
}

async function main() {
  console.log('BookMyShow booking monitor');
  console.log(`ROLE=${config.role} | CHECK_MODE=${config.checkMode}`);
  console.log(`Rule: redirect = NOT OPEN | stay on date = OPEN`);
  console.log(`Base URL: ${config.bmsUrl}`);
  for (const d of config.targetDates) {
    const parts = targetDateParts(d);
    console.log(`  ${parts.label} (${d}) → ${buildBmsUrl(d)}`);
  }

  startDashboard();
  seedStatus();

  if (once) {
    await runCheck();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
