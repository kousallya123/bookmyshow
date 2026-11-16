import {
  initTLS,
  destroyTLS,
  Session,
  ClientIdentifier,
} from 'node-tls-client';
import { config, buildBmsUrl, targetDateParts } from './config.js';

let tlsReady = false;

const PROFILES = [
  {
    id: ClientIdentifier.safari_ios_18_0,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: ClientIdentifier.safari_ios_18_5,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  },
  {
    id: ClientIdentifier.safari_ios_26_0,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: ClientIdentifier.confirmed_ios,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: ClientIdentifier.mms_ios_3,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: ClientIdentifier.safari_27_2,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15',
  },
  {
    id: ClientIdentifier.cloudscraper,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
];

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

function isBlocked(status, html) {
  if (status === 403 || status === 503) return true;
  if (!html || html.length < 200) return true;
  return /you have been blocked|access denied|cf-browser-verification|just a moment|attention required|enable javascript and cookies/i.test(
    html,
  );
}

async function fetchWithProfile(url, profile) {
  const session = new Session({
    clientIdentifier: profile.id,
    timeout: 30_000,
    // Match UA to TLS profile — mismatched default Chrome headers cause CF 403 on cloud IPs
    headers: {
      'user-agent': profile.ua,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8',
    },
  });

  try {
    const res = await session.get(url, { followRedirects: true });
    const html = await res.text();
    return {
      status: res.status,
      url: res.url || url,
      html,
      profile: profile.id,
      protocol: res.usedProtocol,
    };
  } finally {
    try {
      await session.close();
    } catch {
      /* ignore */
    }
  }
}

async function fetchBms(url) {
  await ensureTls();
  const errors = [];

  for (const profile of PROFILES) {
    try {
      const result = await fetchWithProfile(url, profile);
      if (!isBlocked(result.status, result.html)) {
        console.log(
          `[check:tls] ok profile=${profile.id} status=${result.status} len=${result.html.length} proto=${result.protocol}`,
        );
        return result;
      }
      console.log(
        `[check:tls] blocked profile=${profile.id} status=${result.status} len=${result.html.length}`,
      );
      errors.push(`${profile.id}:${result.status}`);
    } catch (err) {
      console.log(`[check:tls] profile=${profile.id} error=${err.message || err}`);
      errors.push(`${profile.id}:err`);
    }
  }

  return {
    status: 403,
    url,
    html: '',
    profile: null,
    protocol: null,
    errors,
  };
}

/**
 * Cloud-friendly BMS check (Safari TLS + profile rotation).
 * redirect away → NOT OPEN | stay on date → OPEN
 */
export async function checkDateBooking(isoDate) {
  const target = targetDateParts(isoDate);
  const startUrl = buildBmsUrl(isoDate);
  console.log(`[check:tls] ${target.label} → ${startUrl}`);

  try {
    const result = await fetchBms(startUrl);
    const finalUrl = result.url || startUrl;
    const pageCompact = urlDateCompact(finalUrl);

    if (isBlocked(result.status, result.html)) {
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
        reason: `BMS blocked request (profiles tried: ${(result.errors || []).join(',') || 'all'})`,
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

    const { shows, hasCinema } = parseShows(result.html, config.cinemaName);
    const listed = result.status >= 200 && result.status < 400;

    console.log(
      `[check:tls] ${target.label}: ${listed ? 'OPEN' : 'NOT OPEN'}` +
        (shows.length ? ` → ${shows.join(', ')}` : hasCinema ? ' (cinema found)' : ''),
    );

    return {
      date: isoDate,
      label: target.label,
      listed,
      open: listed,
      shows,
      newShows: [],
      pageUrl: finalUrl,
      redirectedTo: null,
      checkedAt: new Date().toISOString(),
      error: null,
      reason: listed ? null : `HTTP ${result.status}`,
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
  }
}

export async function checkAllDates(dates = config.targetDates) {
  await ensureTls();
  const results = [];
  for (const iso of dates) {
    results.push(await checkDateBooking(iso));
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

/** Used by /api/debug-bms so you can see what Render receives. */
export async function debugBmsFetch(isoDate = config.targetDates[0]) {
  const url = buildBmsUrl(isoDate);
  const result = await fetchBms(url);
  return {
    url,
    finalUrl: result.url,
    status: result.status,
    profile: result.profile,
    protocol: result.protocol,
    length: result.html?.length || 0,
    blocked: isBlocked(result.status, result.html),
    compact: urlDateCompact(result.url || url),
    broadway: /Broadway/i.test(result.html || ''),
    shows: parseShows(result.html || '', config.cinemaName).shows.slice(0, 10),
    preview: (result.html || '').slice(0, 240).replace(/\s+/g, ' '),
    errors: result.errors || [],
  };
}

export async function shutdownTls() {
  if (tlsReady) {
    await destroyTLS();
    tlsReady = false;
  }
}
