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
  const by = parseShowsForCinemas(html, [cinemaName]);
  const entry = by[cinemaName] || { shows: [], found: false };
  return { shows: entry.shows, hasCinema: entry.found };
}

function parseShowsForCinemas(html, cinemaNames) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d\s?(AM|PM)\b/gi;
  const out = {};
  for (const name of cinemaNames) {
    const needle = name.toLowerCase();
    const idx = text.toLowerCase().indexOf(needle);
    if (idx < 0) {
      out[name] = { shows: [], found: false };
      continue;
    }
    const slice = text.slice(idx, idx + 2800);
    const shows = [
      ...new Set([...slice.matchAll(timeRe)].map((m) => m[0].replace(/\s+/g, ' ').trim())),
    ];
    out[name] = { shows, found: true };
  }
  return out;
}

function resolveCinemaNames(options = {}) {
  const fromList = Array.isArray(options.cinemaNames)
    ? options.cinemaNames.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  if (fromList.length) return [...new Set(fromList)];
  const one = (options.cinemaName || config.cinemaName || '').trim();
  return one ? [one] : ['Broadway Cinemas'];
}

function closedForCinemas(isoDate, target, finalUrl, redirectedTo, reason, cinemaNames) {
  return cinemaNames.map((cinemaName) => ({
    date: isoDate,
    label: target.label,
    cinemaName,
    listed: false,
    open: false,
    shows: [],
    newShows: [],
    pageUrl: finalUrl,
    redirectedTo,
    checkedAt: new Date().toISOString(),
    error: null,
    reason,
  }));
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
export async function checkDateBooking(isoDate, options = {}) {
  const target = targetDateParts(isoDate);
  const cinemaNames = resolveCinemaNames(options);
  const bmsUrl = options.bmsUrl || config.bmsUrl;
  const startUrl = buildBmsUrl(isoDate, bmsUrl);
  console.log(`[check:tls] ${target.label} → ${startUrl} | theatres=${cinemaNames.join(' | ')}`);

  try {
    const result = await fetchBms(startUrl);
    const finalUrl = result.url || startUrl;
    const pageCompact = urlDateCompact(finalUrl);

    if (isBlocked(result.status, result.html)) {
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        `BMS blocked request (profiles tried: ${(result.errors || []).join(',') || 'all'})`,
        cinemaNames,
      );
    }

    if (pageCompact && pageCompact !== target.compact) {
      console.log(
        `[check:tls] ${target.label}: NOT OPEN (redirect ${target.compact} → ${pageCompact})`,
      );
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        pageCompact,
        `Not open (BMS redirected to ${pageCompact})`,
        cinemaNames,
      );
    }

    const htmlHasTargetDate =
      new RegExp(`"showDate"\\s*:\\s*"${target.compact}"`, 'i').test(result.html) ||
      new RegExp(`"date"\\s*:\\s*"${target.compact}"`, 'i').test(result.html) ||
      new RegExp(`/${target.compact}(?:\\?|"|'|\\s|<)`, 'i').test(result.html);

    if (!htmlHasTargetDate) {
      console.log(
        `[check:tls] ${target.label}: NOT OPEN (URL stayed but page has no ${target.compact} show data)`,
      );
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        'Not open (page still serving another date)',
        cinemaNames,
      );
    }

    const byCinema = parseShowsForCinemas(result.html, cinemaNames);
    return cinemaNames.map((cinemaName) => {
      const entry = byCinema[cinemaName] || { shows: [], found: false };
      const listed = entry.shows.length > 0;
      console.log(
        `[check:tls] ${target.label} · ${cinemaName}: ${listed ? 'OPEN' : 'NOT LISTED'}` +
          (entry.shows.length ? ` → ${entry.shows.join(', ')}` : ''),
      );
      return {
        date: isoDate,
        label: target.label,
        cinemaName,
        listed,
        open: listed,
        shows: entry.shows,
        newShows: [],
        pageUrl: finalUrl,
        redirectedTo: null,
        checkedAt: new Date().toISOString(),
        error: null,
        reason: listed
          ? null
          : entry.found
            ? 'Theatre found but no showtimes yet'
            : 'Theatre not listed on this date yet',
      };
    });
  } catch (err) {
    console.log(`[check:tls] ${target.label}: soft-fail → ${err.message || err}`);
    return closedForCinemas(
      isoDate,
      target,
      buildBmsUrl(isoDate, bmsUrl),
      null,
      `Check failed (will retry): ${err.message || err}`,
      cinemaNames,
    );
  }
}

export async function checkAllDates(dates = config.targetDates, options = {}) {
  await ensureTls();
  const results = [];
  for (const iso of dates) {
    const one = await checkDateBooking(iso, options);
    if (Array.isArray(one)) results.push(...one);
    else results.push(one);
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

/** Used by /api/debug-bms so you can see what Render receives. */
export async function debugBmsFetch(isoDate = config.targetDates[0], options = {}) {
  const cinemaName = (options.cinemaName || config.cinemaName || '').trim();
  const bmsUrl = options.bmsUrl || config.bmsUrl;
  const url = buildBmsUrl(isoDate, bmsUrl);
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
    cinema: new RegExp(cinemaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(result.html || ''),
    shows: parseShows(result.html || '', cinemaName).shows.slice(0, 10),
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
