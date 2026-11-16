import { config, buildBmsUrl, targetDateParts } from './config.js';
import { checkAllDates } from './checkShows.js';
import { startDashboard } from './dashboard.js';
import { loadState, saveState, writeStatus, readStatus, diffNewShows } from './statusStore.js';
import { sendPushToAll } from './push.js';

const once = process.argv.includes('--once');

function buildMessage(result, kind = 'open') {
  const shows = result.shows.length ? result.shows.join(', ') : 'booking page open';
  const newBit = result.newShows?.length ? `\nNEW shows: ${result.newShows.join(', ')}` : '';
  const title = kind === 'new_shows' ? '🎬 NEW showtimes appeared!' : '🎬 Booking OPEN!';

  return [
    title,
    ``,
    `Movie: Ramayana (Tamil)`,
    `Date: ${result.label} (${result.date})`,
    `Cinema: ${config.cinemaName}: Coimbatore`,
    config.formatHint ? `Format: ${config.formatHint}` : null,
    `Shows: ${shows}${newBit}`,
    ``,
    `Book now: ${result.pageUrl}`,
    ``,
    `Turn off this date's alert on the dashboard when done.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeAlerts(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

async function runCheck() {
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

  const state = loadState();
  state.dates ||= {};

  // Keep active alerts per date until user dismisses that date
  const alertsByDate = new Map();
  for (const a of normalizeAlerts(prevStatus.alerts || prevStatus.alert)) {
    if (a?.active && !a?.dismissed && a.date) {
      alertsByDate.set(a.date, a);
    }
  }

  const results = await checkAllDates(config.targetDates);

  for (const result of results) {
    const prev = state.dates[result.date] || { shows: [], notifiedOpen: false };
    const newShows = result.listed ? diffNewShows(prev.shows || [], result.shows || []) : [];
    result.newShows = newShows;

    const firstOpen = result.listed && !prev.notifiedOpen;
    const hasNewShows = result.listed && newShows.length > 0;

    if (result.listed) {
      console.log(
        `[result] ${result.label}: OPEN` +
          (result.shows.length ? ` → ${result.shows.join(', ')}` : '') +
          (hasNewShows ? ` | NEW: ${newShows.join(', ')}` : ''),
      );
    } else if (result.error) {
      console.log(`[result] ${result.label}: ERROR → ${result.error}`);
    } else {
      console.log(`[result] ${result.label}: NOT OPEN — ${result.reason || 'redirected'}`);
    }

    if (result.listed && (firstOpen || hasNewShows)) {
      const kind = firstOpen ? 'open' : 'new_shows';
      const message = buildMessage(result, kind);
      const alert = {
        id: `${result.date}:${kind}:${result.shows.join('|')}:${Date.now()}`,
        active: true,
        dismissed: false,
        date: result.date,
        label: result.label,
        kind,
        message,
        pageUrl: result.pageUrl,
        shows: result.shows,
        newShows,
        at: new Date().toISOString(),
      };
      alertsByDate.set(result.date, alert);

      try {
        await sendPushToAll({
          title: kind === 'new_shows' ? `New shows · ${result.label}` : `Booking OPEN · ${result.label}`,
          body: result.shows.length
            ? `${result.shows.join(', ')} · Broadway Coimbatore`
            : `Ramayana booking is open for ${result.label}`,
          url: result.pageUrl,
        });
      } catch (err) {
        console.error('[push]', err.message || err);
      }

      state.dates[result.date] = {
        shows: result.shows,
        notifiedOpen: true,
        lastAlertAt: new Date().toISOString(),
      };
    } else if (result.listed) {
      state.dates[result.date] = {
        shows: result.shows,
        notifiedOpen: true,
        lastAlertAt: prev.lastAlertAt || null,
      };
    } else {
      state.dates[result.date] = {
        shows: [],
        notifiedOpen: false,
        lastAlertAt: null,
      };
      // closed again → drop any lingering alert for that date
      alertsByDate.delete(result.date);
    }
  }

  saveState(state);

  const alerts = [...alertsByDate.values()].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );
  const sortedResults = [...results].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );
  writeStatus({
    updatedAt: new Date().toISOString(),
    checking: false,
    cinemaName: config.cinemaName,
    formatHint: config.formatHint,
    targetDates: config.targetDates,
    bmsUrl: config.bmsUrl,
    dates: sortedResults,
    alerts,
    // legacy single field: first active (dashboard prefers alerts[])
    alert: alerts[0] || null,
  });

  return results;
}

async function main() {
  console.log('BookMyShow booking monitor');
  console.log(`Rule: redirect = NOT OPEN | stay on date = OPEN`);
  console.log(`Alert: one per date (sound until you turn that date off)`);
  console.log(`Base URL: ${config.bmsUrl}`);
  for (const d of config.targetDates) {
    const parts = targetDateParts(d);
    console.log(`  ${parts.label} (${d}) → ${buildBmsUrl(d)}`);
  }
  console.log(`Cinema: ${config.cinemaName} | Alerts: dashboard sound only`);

  startDashboard();
  writeStatus({
    updatedAt: null,
    checking: false,
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
        dates:
          prev.dates?.length
            ? prev.dates.map((d) => ({
                ...d,
                error: err.message || String(err),
                checkedAt: new Date().toISOString(),
              }))
            : config.targetDates.map((date) => ({
                date,
                label: targetDateParts(date).label,
                listed: false,
                open: false,
                shows: [],
                newShows: [],
                pageUrl: buildBmsUrl(date),
                checkedAt: new Date().toISOString(),
                error: err.message || String(err),
              })),
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
