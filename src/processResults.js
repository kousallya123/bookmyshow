import { config } from './config.js';
import { loadState, saveState, writeStatus, readStatus, diffNewShows } from './statusStore.js';
import { sendPushToAll } from './push.js';

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

/**
 * Apply check results: update state/status, fire alerts + push for newly open / new shows.
 */
export async function processCheckResults(results, { source = 'local' } = {}) {
  const prevStatus = readStatus();
  const state = loadState();
  state.dates ||= {};

  const alertsByDate = new Map();
  for (const a of normalizeAlerts(prevStatus.alerts || prevStatus.alert)) {
    if (a?.active && !a?.dismissed && a.date) {
      alertsByDate.set(a.date, a);
    }
  }

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
          title:
            kind === 'new_shows'
              ? `New shows · ${result.label}`
              : `Booking OPEN · ${result.label}`,
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
      // Don't wipe notifiedOpen on soft "will retry" failures — only on real not-open
      const softRetry = /will retry|did not load|not loaded/i.test(result.reason || '');
      if (softRetry) {
        state.dates[result.date] = prev;
      } else {
        state.dates[result.date] = {
          shows: [],
          notifiedOpen: false,
          lastAlertAt: null,
        };
        alertsByDate.delete(result.date);
      }
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
    source,
    cinemaName: config.cinemaName,
    formatHint: config.formatHint,
    targetDates: config.targetDates,
    bmsUrl: config.bmsUrl,
    dates: sortedResults,
    alerts,
    alert: alerts[0] || null,
  });

  return { alerts, dates: sortedResults };
}
