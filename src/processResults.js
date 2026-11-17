import { config } from './config.js';
import { getMonitor } from './monitorStore.js';
import { loadState, saveState, writeStatus, readStatus, diffNewShows } from './statusStore.js';
import { sendPushToAll } from './push.js';

function resultKey(result) {
  return `${result.date}::${result.cinemaName || 'default'}`;
}

function buildMessage(result, monitor, kind = 'open') {
  const shows = result.shows.length ? result.shows.join(', ') : 'booking page open';
  const newBit = result.newShows?.length ? `\nNEW shows: ${result.newShows.join(', ')}` : '';
  const title = kind === 'new_shows' ? '🎬 NEW showtimes appeared!' : '🎬 Booking OPEN!';
  const movie = monitor.movieName || 'Movie';
  const cinema = result.cinemaName || monitor.cinemaName || config.cinemaName;
  const city = monitor.city || 'Coimbatore';

  return [
    title,
    ``,
    `Movie: ${movie}`,
    `Date: ${result.label} (${result.date})`,
    `Cinema: ${cinema}${city ? `: ${city}` : ''}`,
    monitor.formatHint ? `Format: ${monitor.formatHint}` : null,
    `Shows: ${shows}${newBit}`,
    ``,
    `Book now: ${result.pageUrl}`,
    ``,
    `Turn off this alert on the dashboard when done.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeAlerts(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

function alertKey(a) {
  return `${a.date}::${a.cinemaName || 'default'}`;
}

function clearAlertsForDateCinema(alertsByKey, date, cinemaName) {
  for (const [key, alert] of [...alertsByKey.entries()]) {
    if (alert.date !== date) continue;
    if (!cinemaName || !alert.cinemaName || alert.cinemaName === cinemaName) {
      alertsByKey.delete(key);
    }
  }
  // Legacy keys
  alertsByKey.delete(date);
  alertsByKey.delete(`${date}::default`);
  if (cinemaName) alertsByKey.delete(`${date}::${cinemaName}`);
}

function clearStateForDateCinema(state, date, cinemaName) {
  delete state.dates[date];
  delete state.dates[`${date}::default`];
  if (cinemaName) delete state.dates[`${date}::${cinemaName}`];
  state.dates[`${date}::${cinemaName || 'default'}`] = {
    shows: [],
    notifiedOpen: false,
    lastAlertAt: null,
  };
}

/**
 * Apply check results: update state/status, fire alerts + push for newly open / new shows.
 */
export async function processCheckResults(results, { source = 'local' } = {}) {
  const monitor = await getMonitor();
  const prevStatus = readStatus();
  const state = loadState();
  state.dates ||= {};

  const alertsByKey = new Map();
  for (const a of normalizeAlerts(prevStatus.alerts || prevStatus.alert)) {
    if (a?.active && !a?.dismissed && a.date) {
      alertsByKey.set(alertKey(a), a);
    }
  }

  for (const result of results) {
    const key = resultKey(result);
    // Only trust the cinema-scoped key (avoid legacy date-only notifiedOpen causing re-alerts)
    const prev = state.dates[key] || { shows: [], notifiedOpen: false };
    const newShows = result.listed ? diffNewShows(prev.shows || [], result.shows || []) : [];
    result.newShows = newShows;

    const firstOpen = result.listed && !prev.notifiedOpen;
    const hasNewShows = result.listed && newShows.length > 0;
    const cinemaTag = result.cinemaName ? ` · ${result.cinemaName}` : '';

    if (result.listed) {
      console.log(
        `[result] ${result.label}${cinemaTag}: OPEN` +
          (result.shows.length ? ` → ${result.shows.join(', ')}` : '') +
          (hasNewShows ? ` | NEW: ${newShows.join(', ')}` : ''),
      );
    } else if (result.error) {
      console.log(`[result] ${result.label}${cinemaTag}: ERROR → ${result.error}`);
    } else {
      console.log(`[result] ${result.label}${cinemaTag}: NOT OPEN — ${result.reason || 'redirected'}`);
    }

    if (result.listed && (firstOpen || hasNewShows) && monitor.notificationsEnabled !== false) {
      const kind = firstOpen ? 'open' : 'new_shows';
      const message = buildMessage(result, monitor, kind);
      const alert = {
        id: `${key}:${kind}:${result.shows.join('|')}:${Date.now()}`,
        active: true,
        dismissed: false,
        date: result.date,
        cinemaName: result.cinemaName || null,
        label: result.label,
        kind,
        message,
        pageUrl: result.pageUrl,
        shows: result.shows,
        newShows,
        at: new Date().toISOString(),
      };
      alertsByKey.set(key, alert);

      try {
        await sendPushToAll({
          title:
            kind === 'new_shows'
              ? `New shows · ${result.label}`
              : `Booking OPEN · ${result.label}`,
          body: result.shows.length
            ? `${result.shows.join(', ')} · ${result.cinemaName || monitor.cinemaName}`
            : `${monitor.movieName} open at ${result.cinemaName || monitor.cinemaName} · ${result.label}`,
          url: result.pageUrl,
        });
      } catch (err) {
        console.error('[push]', err.message || err);
      }

      state.dates[key] = {
        shows: result.shows,
        notifiedOpen: true,
        lastAlertAt: new Date().toISOString(),
      };
    } else if (result.listed) {
      state.dates[key] = {
        shows: result.shows,
        notifiedOpen: true,
        lastAlertAt: prev.lastAlertAt || null,
      };
    } else {
      const softRetry = /will retry|did not load|not loaded|blocked request|403/i.test(
        result.reason || '',
      );
      if (softRetry) {
        state.dates[key] = prev;
      } else {
        clearAlertsForDateCinema(alertsByKey, result.date, result.cinemaName);
        clearStateForDateCinema(state, result.date, result.cinemaName);
      }
    }
  }

  // Drop any leftover alerts that are not currently listed in this check batch
  const openKeys = new Set(results.filter((r) => r.listed).map(resultKey));
  for (const [key, alert] of [...alertsByKey.entries()]) {
    const stillOpen = results.some(
      (r) =>
        r.listed &&
        r.date === alert.date &&
        (!alert.cinemaName || !r.cinemaName || r.cinemaName === alert.cinemaName),
    );
    if (!stillOpen && !openKeys.has(key)) {
      alertsByKey.delete(key);
    }
  }

  saveState(state);

  const alerts = [...alertsByKey.values()].sort((a, b) =>
    `${a.date}:${a.cinemaName || ''}`.localeCompare(`${b.date}:${b.cinemaName || ''}`),
  );
  const sortedResults = [...results].sort((a, b) =>
    `${a.date}:${a.cinemaName || ''}`.localeCompare(`${b.date}:${b.cinemaName || ''}`),
  );

  writeStatus({
    updatedAt: new Date().toISOString(),
    checking: false,
    source,
    movieName: monitor.movieName,
    cinemaName: monitor.cinemaName,
    cinemas: monitor.cinemas,
    city: monitor.city,
    formatHint: monitor.formatHint,
    notificationsEnabled: monitor.notificationsEnabled !== false,
    targetDates: (monitor.dates || []).filter((d) => d.enabled !== false).map((d) => d.date),
    bmsUrl: monitor.bmsUrl,
    monitor,
    dates: sortedResults,
    alerts,
    alert: alerts[0] || null,
  });

  return { alerts, dates: sortedResults };
}
