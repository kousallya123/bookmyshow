import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { config, buildBmsUrl, targetDateParts } from './config.js';

function findPlaywrightChrome() {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(root)) return null;

  const dirs = fs
    .readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const exe = path.join(root, dir, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

async function launchBrowser() {
  process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = '0';

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
  const errors = [];

  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, channel, args });
    } catch (err) {
      errors.push(`${channel}: ${err.message}`);
    }
  }

  const exe = findPlaywrightChrome();
  if (exe) {
    try {
      return await chromium.launch({ headless: true, executablePath: exe, args });
    } catch (err) {
      errors.push(`executablePath: ${err.message}`);
    }
  }

  try {
    return await chromium.launch({ headless: true, args });
  } catch (err) {
    errors.push(`default: ${err.message}`);
    throw new Error(`Could not launch browser.\n${errors.join('\n')}`);
  }
}

function urlDateCompact(url) {
  return (String(url).match(/\/(\d{8})(?:\?|$)/) || [])[1] || null;
}

function closedResult(isoDate, target, finalUrl, redirectedTo, reason) {
  return {
    date: isoDate,
    label: target.label,
    listed: false,
    open: false,
    shows: [],
    newShows: [],
    pageUrl: finalUrl,
    redirectedTo,
    checkedAt: new Date().toISOString(),
    error: null,
    reason,
  };
}

async function softWaitForPage(page) {
  // Never throw — Promise.race rejects if waitForSelector times out otherwise
  await Promise.race([
    page.waitForSelector('text=Broadway', { timeout: 18_000 }).catch(() => null),
    page.waitForSelector('text=/\\d{1,2}:\\d{2}\\s*(AM|PM)/i', { timeout: 18_000 }).catch(() => null),
    page.waitForSelector('text=/No [Ss]hows|Select a Date|Book tickets/i', { timeout: 18_000 }).catch(() => null),
    page.waitForTimeout(18_000),
  ]);
}

/**
 * redirect away → NOT OPEN
 * stay on date + booking UI loaded → OPEN
 * stay but page blocked/empty → soft failure (retry next loop), not OPEN
 */
export async function checkDateBooking(isoDate, browser) {
  const target = targetDateParts(isoDate);
  const ownBrowser = !browser;
  const browserInstance = browser || (await launchBrowser());

  try {
    const context = await browserInstance.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-IN',
      viewport: { width: 1365, height: 900 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    const startUrl = buildBmsUrl(isoDate);
    console.log(`[check] ${target.label} → ${startUrl}`);

    const response = await page.goto(startUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await dismissPopups(page);
    await softWaitForPage(page);
    await dismissPopups(page);
    await page.waitForTimeout(1500);

    let finalUrl = page.url();
    let pageCompact = urlDateCompact(finalUrl);

    if (pageCompact && pageCompact !== target.compact) {
      console.log(`[check] ${target.label}: NOT OPEN (redirect ${target.compact} → ${pageCompact})`);
      await context.close();
      return closedResult(
        isoDate,
        target,
        finalUrl,
        pageCompact,
        `Not open (BMS redirected to ${pageCompact})`,
      );
    }

    await trySelectDate(page, target);
    await page.waitForTimeout(1200);
    finalUrl = page.url();
    pageCompact = urlDateCompact(finalUrl);

    if (pageCompact && pageCompact !== target.compact) {
      console.log(`[check] ${target.label}: NOT OPEN (moved to ${pageCompact})`);
      await context.close();
      return closedResult(
        isoDate,
        target,
        finalUrl,
        pageCompact,
        `Not open (BMS redirected to ${pageCompact})`,
      );
    }

    const snapshot = await page.evaluate(({ cinemaName }) => {
      const bodyText = document.body?.innerText || '';
      const lower = bodyText.toLowerCase();
      const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d\s?(AM|PM)\b/gi;

      let shows = [];
      for (const el of document.querySelectorAll('a, div, section, li, article')) {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 1200) continue;
        if (!t.toLowerCase().includes(cinemaName.toLowerCase())) continue;
        const local = [...t.matchAll(timeRe)].map((m) => m[0].replace(/\s+/g, ' ').trim());
        if (local.length) {
          shows = [...new Set(local)];
          break;
        }
      }
      if (!shows.length && lower.includes(cinemaName.toLowerCase())) {
        shows = [...new Set([...bodyText.matchAll(timeRe)].map((m) => m[0].replace(/\s+/g, ' ').trim()))];
      }

      const blocked =
        bodyText.length < 80 ||
        /access denied|unusual traffic|captcha|please verify|bot detected|403 forbidden/i.test(
          bodyText,
        );

      const hasBookingUi =
        lower.includes(cinemaName.toLowerCase()) ||
        shows.length > 0 ||
        /no shows|select a date|showtimes|book tickets|venues?/i.test(bodyText);

      return {
        shows,
        blocked,
        hasBookingUi,
        bodyLen: bodyText.length,
        preview: bodyText.slice(0, 160).replace(/\s+/g, ' '),
      };
    }, { cinemaName: config.cinemaName });

    const status = response?.status?.() ?? 0;
    if (snapshot.blocked || (status >= 400 && status !== 404)) {
      console.log(
        `[check] ${target.label}: page not ready (status=${status}, bodyLen=${snapshot.bodyLen}) ${snapshot.preview}`,
      );
      await context.close();
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
        reason: 'BMS page did not load (will retry)',
      };
    }

    // URL stayed on target date and booking UI is present → OPEN
    if (!snapshot.hasBookingUi) {
      console.log(`[check] ${target.label}: URL ok but booking UI missing — retry later`);
      await context.close();
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
        reason: 'Booking UI not loaded yet (will retry)',
      };
    }

    console.log(
      `[check] ${target.label}: OPEN` +
        (snapshot.shows.length ? ` → ${snapshot.shows.join(', ')}` : ' (showtimes pending parse)'),
    );

    await context.close();

    return {
      date: isoDate,
      label: target.label,
      listed: true,
      open: true,
      shows: snapshot.shows,
      newShows: [],
      pageUrl: finalUrl,
      redirectedTo: null,
      checkedAt: new Date().toISOString(),
      error: null,
      reason: null,
    };
  } catch (err) {
    console.log(`[check] ${target.label}: soft-fail → ${err.message || err}`);
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
    if (ownBrowser) await browserInstance.close();
  }
}

export async function checkAllDates(dates = config.targetDates) {
  const browser = await launchBrowser();
  try {
    const results = [];
    for (const iso of dates) {
      results.push(await checkDateBooking(iso, browser));
    }
    return results;
  } finally {
    await browser.close();
  }
}

async function trySelectDate(page, target) {
  const patterns = [
    new RegExp(`${target.weekday}\\s*${target.dayNum}\\s*${target.month}`, 'i'),
  ];
  const nodes = page.locator('li, button, a, div[role="button"], div');
  const count = await nodes.count();
  for (let i = 0; i < Math.min(count, 160); i++) {
    const el = nodes.nth(i);
    let text = '';
    try {
      text = ((await el.innerText({ timeout: 300 })) || '').replace(/\s+/g, ' ').trim();
    } catch {
      continue;
    }
    if (text.length < 3 || text.length > 24) continue;
    const hit =
      patterns.some((re) => re.test(text)) ||
      (text.toUpperCase().includes(target.weekday) &&
        text.includes(target.dayNum) &&
        text.toUpperCase().includes(target.month));
    if (!hit) continue;
    try {
      await el.click({ timeout: 1500 });
      return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function dismissPopups(page) {
  const selectors = [
    'button:has-text("Not Now")',
    'button:has-text("No thanks")',
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Continue")',
    'button:has-text("Allow")',
    '[aria-label="Close"]',
    'button:has-text("Close")',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 700 })) await el.click({ timeout: 1000 });
    } catch {
      /* ignore */
    }
  }
}
