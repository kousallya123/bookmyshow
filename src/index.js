import { config, buildBmsUrl, targetDateParts } from './config.js';
import { checkAllDates } from './checkShows.js';
import { startDashboard } from './dashboard.js';
import { writeStatus, readStatus } from './statusStore.js';
import { processCheckResults } from './processResults.js';

const once = process.argv.includes('--once');

async function runCheckLocal() {
  console.log(
    `\n[${new Date().toLocaleString()}] Checking dates: ${config.targetDates.join(', ')}`,
  );

  const prevStatus = readStatus();
  writeStatus({
    ...prevStatus,
    checking: true,
    cinemaName: config.cinemaName,
    targetDates: config.targetDates,
  });

  const results = await checkAllDates(config.targetDates);
  await processCheckResults(results, { source: 'local' });
  return results;
}

async function runCheckWorker() {
  if (!config.reportUrl) {
    throw new Error('REPORT_URL is required for ROLE=worker (your Render app URL)');
  }
  if (!config.ingestSecret) {
    throw new Error('INGEST_SECRET is required for ROLE=worker');
  }

  console.log(
    `\n[${new Date().toLocaleString()}] Worker checking: ${config.targetDates.join(', ')}`,
  );
  console.log(`[worker] Reporting to ${config.reportUrl}/api/ingest`);

  const results = await checkAllDates(config.targetDates);

  for (const result of results) {
    if (result.listed) {
      console.log(`[worker] ${result.label}: OPEN → ${(result.shows || []).join(', ') || 'open'}`);
    } else {
      console.log(`[worker] ${result.label}: ${result.reason || result.error || 'not open'}`);
    }
  }

  const res = await fetch(`${config.reportUrl}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ingestSecret}`,
    },
    body: JSON.stringify({
      results,
      cinemaName: config.cinemaName,
      formatHint: config.formatHint,
      targetDates: config.targetDates,
      bmsUrl: config.bmsUrl,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Ingest failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  console.log(`[worker] Ingest OK: ${body.slice(0, 120)}`);
  return results;
}

function seedStatus() {
  writeStatus({
    updatedAt: null,
    checking: false,
    source: config.role === 'dashboard' ? 'waiting-for-worker' : 'local',
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
      reason:
        config.role === 'dashboard'
          ? 'Waiting for local worker (Render cannot open BookMyShow)'
          : 'Waiting for first check',
    })),
    alerts: [],
    alert: null,
  });
}

async function main() {
  console.log('BookMyShow booking monitor');
  console.log(`ROLE=${config.role}`);
  console.log(`Rule: redirect = NOT OPEN | stay on date = OPEN`);
  console.log(`Base URL: ${config.bmsUrl}`);
  for (const d of config.targetDates) {
    const parts = targetDateParts(d);
    console.log(`  ${parts.label} (${d}) → ${buildBmsUrl(d)}`);
  }

  if (config.role === 'dashboard' || config.role === 'all') {
    startDashboard();
    seedStatus();
  }

  if (config.role === 'dashboard') {
    console.log('Dashboard-only mode: BMS checks must come from local worker (ROLE=worker).');
    console.log('Keepalive cron should hit /api/health; worker posts to /api/ingest.');
    // Keep process alive
    await new Promise(() => {});
    return;
  }

  const run = config.role === 'worker' ? runCheckWorker : runCheckLocal;

  if (once) {
    await run();
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await run();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
