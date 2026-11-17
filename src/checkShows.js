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

function closedResult(isoDate, target, finalUrl, redirectedTo, reason, cinemaName = null) {
  return {
    date: isoDate,
    label: target.label,
    cinemaName: cinemaName || null,
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

function resolveCinemaNames(options = {}) {
  const fromList = Array.isArray(options.cinemaNames)
    ? options.cinemaNames.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  if (fromList.length) return [...new Set(fromList)];
  const one = (options.cinemaName || config.cinemaName || '').trim();
  return one ? [one] : ['Broadway Cinemas'];
}

function closedForCinemas(isoDate, target, finalUrl, redirectedTo, reason, cinemaNames) {
  return cinemaNames.map((cinemaName) =>
    closedResult(isoDate, target, finalUrl, redirectedTo, reason, cinemaName),
  );
}

async function softWaitForPage(page, cinemaName = 'Broadway') {
  const cinema = (cinemaName || 'Broadway').split(/\s+/)[0] || 'Broadway';
  await Promise.race([
    page.waitForSelector(`text=${cinema}`, { timeout: 18_000 }).catch(() => null),
    page.waitForSelector('text=/\\d{1,2}:\\d{2}\\s*(AM|PM)/i', { timeout: 18_000 }).catch(() => null),
    page.waitForSelector('text=/No [Ss]hows|Select a Date|Book tickets/i', { timeout: 18_000 }).catch(() => null),
    page.waitForTimeout(18_000),
  ]);
}

/**
 * Inspect BMS date strip: selected date + whether target is greyed out.
 * Greyed dates are NOT OPEN even if the URL still contains that date.
 */
async function inspectDateStrip(page, target) {
  return page.evaluate(({ weekday, dayNum, month, label }) => {
    const normalize = (t) => (t || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const labelNorm = normalize(label);
    const isDatePillText = (text) => {
      if (!text || text.length < 5 || text.length > 28) return false;
      return (
        /^[A-Z]{3}\s+\d{1,2}\s+[A-Z]{3}$/.test(text) ||
        new RegExp(`^${weekday}\\s*${dayNum}\\s*${month}$`, 'i').test(text)
      );
    };
    const matchesTarget = (text) => {
      const n = normalize(text);
      return (
        n === labelNorm ||
        (n.includes(weekday) && n.includes(String(dayNum)) && n.includes(month))
      );
    };

    const nodes = [...document.querySelectorAll('li, button, a, div[role="button"], div, span')];
    const pills = [];

    for (const el of nodes) {
      let text = '';
      try {
        text = normalize(el.innerText);
      } catch {
        continue;
      }
      if (!isDatePillText(text)) continue;

      const style = window.getComputedStyle(el);
      const rgb = style.color.match(/\d+/g)?.map(Number) || [0, 0, 0];
      const opacity = Number(style.opacity || 1);
      const bg = style.backgroundColor || '';
      const cls = `${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
      const ariaDisabled =
        el.getAttribute('aria-disabled') === 'true' ||
        el.closest('[aria-disabled="true"]') != null;
      const ariaSelected =
        el.getAttribute('aria-selected') === 'true' ||
        el.closest('[aria-selected="true"]') != null;
      const disabledAttr = !!(el.disabled || el.getAttribute('disabled') != null);

      const greyText =
        opacity < 0.85 ||
        (rgb[0] > 140 && rgb[1] > 140 && rgb[2] > 140 && Math.max(...rgb) - Math.min(...rgb) < 40);
      const disabledClass = /disabled|inactive|unavailable|mute|dim/.test(cls);
      const pointerNone = style.pointerEvents === 'none';

      const redish =
        (rgb[0] > 160 && rgb[0] > rgb[1] + 40 && rgb[0] > rgb[2] + 40) ||
        /rgb\(\s*2\d{2}\s*,\s*[0-8]\d\s*,\s*[0-8]\d/.test(bg);
      const selectedClass = /select|active|current|chosen|picked/.test(cls);

      pills.push({
        text,
        target: matchesTarget(text),
        disabled: !!(ariaDisabled || disabledAttr || disabledClass || pointerNone || greyText),
        selected: !!(ariaSelected || selectedClass || redish),
      });
    }

    const byText = new Map();
    for (const p of pills) {
      const prev = byText.get(p.text);
      if (!prev) {
        byText.set(p.text, p);
        continue;
      }
      byText.set(p.text, {
        ...prev,
        disabled: prev.disabled || p.disabled,
        selected: prev.selected || p.selected,
        target: prev.target || p.target,
      });
    }

    const all = [...byText.values()];
    const targetPill = all.find((p) => p.target) || null;
    const selectedPill = all.find((p) => p.selected) || null;

    return {
      pills: all.slice(0, 14),
      targetFound: !!targetPill,
      targetDisabled: targetPill ? !!targetPill.disabled : null,
      targetSelected: targetPill ? !!targetPill.selected : false,
      selectedLabel: selectedPill?.text || null,
    };
  }, target);
}

/**
 * redirect away → NOT OPEN
 * greyed / not selected in date strip → NOT OPEN (even if URL stays)
 * stay on date + strip selected → OPEN
 */
export async function checkDateBooking(isoDate, browser, options = {}) {
  const target = targetDateParts(isoDate);
  const cinemaNames = resolveCinemaNames(options);
  const bmsUrl = options.bmsUrl || config.bmsUrl;
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

    const startUrl = buildBmsUrl(isoDate, bmsUrl);
    console.log(`[check] ${target.label} → ${startUrl} | theatres=${cinemaNames.join(' | ')}`);

    const response = await page.goto(startUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await dismissPopups(page);
    await softWaitForPage(page, cinemaNames[0]);
    await dismissPopups(page);
    await page.waitForTimeout(1500);

    let finalUrl = page.url();
    let pageCompact = urlDateCompact(finalUrl);

    if (pageCompact && pageCompact !== target.compact) {
      console.log(`[check] ${target.label}: NOT OPEN (redirect ${target.compact} → ${pageCompact})`);
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        pageCompact,
        `Not open (BMS redirected to ${pageCompact})`,
        cinemaNames,
      );
    }

    let strip = await inspectDateStrip(page, target);
    if (strip.targetFound && strip.targetDisabled) {
      console.log(
        `[check] ${target.label}: NOT OPEN (date greyed/disabled; selected=${strip.selectedLabel || 'n/a'})`,
      );
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        'Not open (date still greyed out on BMS)',
        cinemaNames,
      );
    }

    if (strip.targetFound && !strip.targetDisabled) {
      await trySelectDate(page, target);
      await page.waitForTimeout(1200);
      finalUrl = page.url();
      pageCompact = urlDateCompact(finalUrl);
      strip = await inspectDateStrip(page, target);
    }

    if (pageCompact && pageCompact !== target.compact) {
      console.log(`[check] ${target.label}: NOT OPEN (moved to ${pageCompact})`);
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        pageCompact,
        `Not open (BMS redirected to ${pageCompact})`,
        cinemaNames,
      );
    }

    if (strip.targetFound && strip.targetDisabled) {
      console.log(`[check] ${target.label}: NOT OPEN (still greyed after click)`);
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        'Not open (date still greyed out on BMS)',
        cinemaNames,
      );
    }

    const selectedOther =
      strip.targetFound &&
      !strip.targetSelected &&
      strip.selectedLabel &&
      strip.selectedLabel.replace(/\s+/g, ' ').trim().toUpperCase() !==
        target.label.replace(/\s+/g, ' ').trim().toUpperCase();
    if (selectedOther) {
      console.log(`[check] ${target.label}: NOT OPEN (strip still on ${strip.selectedLabel})`);
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        `Not open (BMS still on ${strip.selectedLabel})`,
        cinemaNames,
      );
    }

    // Soft-land / false OPEN guard: if we cannot see this date in the strip,
    // do not scrape leftover showtimes from another day.
    if (!strip.targetFound) {
      console.log(`[check] ${target.label}: NOT OPEN (date strip not confirmed)`);
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        'Not open (date strip not confirmed)',
        cinemaNames,
      );
    }

    const snapshot = await page.evaluate(({ cinemaNames: names }) => {
      const bodyText = document.body?.innerText || '';
      const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d\s?(AM|PM)\b/gi;
      const byCinema = {};

      for (const cinemaName of names) {
        let shows = [];
        const needle = cinemaName.toLowerCase();
        for (const el of document.querySelectorAll('a, div, section, li, article')) {
          const t = (el.innerText || '').trim();
          if (!t || t.length > 1200) continue;
          if (!t.toLowerCase().includes(needle)) continue;
          const local = [...t.matchAll(timeRe)].map((m) => m[0].replace(/\s+/g, ' ').trim());
          if (local.length) {
            shows = [...new Set(local)];
            break;
          }
        }
        byCinema[cinemaName] = {
          shows,
          found: bodyText.toLowerCase().includes(needle),
        };
      }

      const blocked =
        bodyText.length < 80 ||
        /access denied|unusual traffic|captcha|please verify|bot detected|403 forbidden/i.test(
          bodyText,
        );

      return { byCinema, blocked, bodyLen: bodyText.length };
    }, { cinemaNames });

    const status = response?.status?.() ?? 0;
    if (snapshot.blocked || (status >= 400 && status !== 404)) {
      console.log(`[check] ${target.label}: page not ready (status=${status})`);
      await context.close();
      return closedForCinemas(
        isoDate,
        target,
        finalUrl,
        null,
        'BMS page did not load (will retry)',
        cinemaNames,
      );
    }

    await context.close();

    return cinemaNames.map((cinemaName) => {
      const entry = snapshot.byCinema?.[cinemaName] || { shows: [], found: false };
      const listed = entry.shows.length > 0;
      console.log(
        `[check] ${target.label} · ${cinemaName}: ${listed ? 'OPEN' : 'NOT LISTED'}` +
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
    console.log(`[check] ${target.label}: soft-fail → ${err.message || err}`);
    return closedForCinemas(
      isoDate,
      target,
      buildBmsUrl(isoDate, bmsUrl),
      null,
      `Check failed (will retry): ${err.message || err}`,
      cinemaNames,
    );
  } finally {
    if (ownBrowser) await browserInstance.close();
  }
}

export async function checkAllDates(dates = config.targetDates, options = {}) {
  const browser = await launchBrowser();
  try {
    const results = [];
    for (const iso of dates) {
      const one = await checkDateBooking(iso, browser, options);
      if (Array.isArray(one)) results.push(...one);
      else results.push(one);
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
