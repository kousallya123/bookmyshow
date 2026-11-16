import {
  initTLS,
  destroyTLS,
  Session,
  ClientIdentifier,
} from 'node-tls-client';
import { config, buildBmsUrl, targetDateParts } from './config.js';

let tlsReady = false;

async function ensureTls() {
  if (!tlsReady) {
    await initTLS();
    tlsReady = true;
  }
}

function urlDateCompact(url) {
  return (String(url).match(/\/(\d{8})(?:\?|$)/) || [])[1] || null;
}

function parseShows(html, cinemaName) {
  const showTimes = [...html.matchAll(/"showTime"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(showTimes)];
  const hasCinema = new RegExp(cinemaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(html);
  return { shows: unique, hasCinema };
}

/**
 * Cloud-friendly BMS check using Safari TLS fingerprint (bypasses CF 403 on Render).
 * redirect away → NOT OPEN | stay on date → OPEN
 */
export async function checkDateBooking(isoDate, session) {
  const target = targetDateParts(isoDate);
  const startUrl = buildBmsUrl(isoDate);
  console.log(`[check:tls] ${target.label} → ${startUrl}`);

  const ownSession = !session;
  const sess =
    session ||
    new Session({
      clientIdentifier: ClientIdentifier.safari_ios_18_0,
      timeout: 25_000,
    });

  try {
    const res = await sess.get(startUrl, { followRedirects: true });
    const html = await res.text();
    const finalUrl = res.url || startUrl;
    const pageCompact = urlDateCompact(finalUrl);
    const blocked = /you have been blocked|access denied|captcha/i.test(html);

    if (blocked || res.status === 403) {
      console.log(`[check:tls] ${target.label}: blocked status=${res.status}`);
      return {
        date: isoDate,
        label: target.label,
        listed: false,
        open: false,
        shows: [],
        newShows: [],
        pageUrl: finalUrl,
        redirectedTo: null,
        checkedAt: new Date().toISOString(),
        error: null,
        reason: 'BMS blocked request (will retry)',
      };
    }

    if (pageCompact && pageCompact !== target.compact) {
      console.log(
        `[check:tls] ${target.label}: NOT OPEN (redirect ${target.compact} → ${pageCompact})`,
      );
      return {
        date: isoDate,
        label: target.label,
        listed: false,
        open: false,
        shows: [],
        newShows: [],
        pageUrl: finalUrl,
        redirectedTo: pageCompact,
        checkedAt: new Date().toISOString(),
        error: null,
        reason: `Not open (BMS redirected to ${pageCompact})`,
      };
    }

    const { shows, hasCinema } = parseShows(html, config.cinemaName);
    const listed = res.status >= 200 && res.status < 400;

    console.log(
      `[check:tls] ${target.label}: ${listed ? 'OPEN' : 'NOT OPEN'}` +
        (shows.length ? ` → ${shows.join(', ')}` : hasCinema ? ' (cinema found)' : ''),
    );

    return {
      date: isoDate,
      label: target.label,
      listed,
      open: listed,
      shows: hasCinema ? shows : shows,
      newShows: [],
      pageUrl: finalUrl,
      redirectedTo: null,
      checkedAt: new Date().toISOString(),
      error: null,
      reason: listed ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    console.log(`[check:tls] ${target.label}: soft-fail → ${err.message || err}`);
    return {
      date: isoDate,
      label: target.label,
      listed: false,
      open: false,
      shows: [],
      newShows: [],
      pageUrl: buildBmsUrl(isoDate),
      redirectedTo: null,
      checkedAt: new Date().toISOString(),
      error: null,
      reason: `Check failed (will retry): ${err.message || err}`,
    };
  } finally {
    if (ownSession) {
      try {
        await sess.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function checkAllDates(dates = config.targetDates) {
  await ensureTls();
  const session = new Session({
    clientIdentifier: ClientIdentifier.safari_ios_18_0,
    timeout: 25_000,
  });

  try {
    const results = [];
    for (const iso of dates) {
      results.push(await checkDateBooking(iso, session));
      // small gap to look less bot-like
      await new Promise((r) => setTimeout(r, 400));
    }
    return results;
  } finally {
    try {
      await session.close();
    } catch {
      /* ignore */
    }
  }
}

export async function shutdownTls() {
  if (tlsReady) {
    await destroyTLS();
    tlsReady = false;
  }
}
