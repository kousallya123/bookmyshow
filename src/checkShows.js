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

  const args = ['--disable-blink-features=AutomationControlled'];
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

/**
 * Only two outcomes:
 * - redirected away from target date → NOT OPEN
 * - URL stays on target date → OPEN (booking available)
 * Showtimes are scraped only for display / "new show" alerts.
 */
export async function checkDateBooking(isoDate, browser) {
  const target = targetDateParts(isoDate);
  const ownBrowser = !browser;
  const browserInstance = browser || (await launchBrowser());

  try {
    const context = await browserInstance.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-IN',
      viewport: { width: 1365, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);

    const startUrl = buildBmsUrl(isoDate);
    console.log(`[check] ${target.label} → ${startUrl}`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await dismissPopups(page);

    await Promise.race([
      page.waitForSelector('text=Broadway', { timeout: 12_000 }),
      page.waitForSelector('text=/\\d{1,2}:\\d{2}\\s*(AM|PM)/i', { timeout: 12_000 }),
      page.waitForTimeout(12_000),
    ]);
    await dismissPopups(page);
    await page.waitForTimeout(1000);

    let finalUrl = page.url();
    let pageCompact = urlDateCompact(finalUrl);

    if (pageCompact && pageCompact !== target.compact) {
      console.log(`[check] ${target.label}: NOT OPEN (redirect ${target.compact} → ${pageCompact})`);
      await context.close();
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
        reason: 'Not open (BMS redirected)',
      };
    }

    // Optional: click date strip; if BMS then redirects away → not open
    await trySelectDate(page, target);
    await page.waitForTimeout(1000);
    finalUrl = page.url();
    pageCompact = urlDateCompact(finalUrl);

    if (pageCompact && pageCompact !== target.compact) {
      console.log(`[check] ${target.label}: NOT OPEN (moved to ${pageCompact})`);
      await context.close();
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
        reason: 'Not open (BMS redirected)',
      };
    }

    // OPEN — URL stayed on this date
    const shows = await page.evaluate(({ cinemaName }) => {
      const bodyText = document.body?.innerText || '';
      const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d\s?(AM|PM)\b/gi;
      for (const el of document.querySelectorAll('a, div, section, li, article')) {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 1200) continue;
        if (!t.toLowerCase().includes(cinemaName.toLowerCase())) continue;
        const local = [...t.matchAll(timeRe)].map((m) => m[0].replace(/\s+/g, ' ').trim());
        if (local.length) return [...new Set(local)];
      }
      if (bodyText.toLowerCase().includes(cinemaName.toLowerCase())) {
        return [...new Set([...bodyText.matchAll(timeRe)].map((m) => m[0].replace(/\s+/g, ' ').trim()))];
      }
      return [];
    }, { cinemaName: config.cinemaName });

    console.log(
      `[check] ${target.label}: OPEN` +
        (shows.length ? ` → ${shows.join(', ')}` : ' (no show times parsed yet)'),
    );

    await context.close();

    return {
      date: isoDate,
      label: target.label,
      listed: true,
      open: true,
      shows,
      newShows: [],
      pageUrl: finalUrl,
      redirectedTo: null,
      checkedAt: new Date().toISOString(),
      error: null,
      reason: null,
    };
  } catch (err) {
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
      error: err.message || String(err),
      reason: null,
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
