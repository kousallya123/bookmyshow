import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const webpush = require('web-push');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const vapidPath = path.join(root, 'vapid.json');
const subsPath = path.join(root, 'subscriptions.json');

function loadOrCreateVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }

  try {
    return JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(vapidPath, JSON.stringify(keys, null, 2));
    console.log('[push] Generated VAPID keys → vapid.json (set VAPID_* env on Render for persistence)');
    return keys;
  }
}

const vapid = loadOrCreateVapid();
const contact = process.env.VAPID_SUBJECT || 'mailto:ramayana-monitor@localhost';

webpush.setVapidDetails(contact, vapid.publicKey, vapid.privateKey);

export function getVapidPublicKey() {
  return vapid.publicKey;
}

function readSubs() {
  try {
    const raw = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeSubs(subs) {
  fs.writeFileSync(subsPath, JSON.stringify(subs, null, 2));
}

export function saveSubscription(subscription) {
  if (!subscription?.endpoint) return { ok: false, error: 'invalid subscription' };
  const subs = readSubs().filter((s) => s.endpoint !== subscription.endpoint);
  subs.push(subscription);
  writeSubs(subs);
  console.log(`[push] Saved subscription (${subs.length} total)`);
  return { ok: true, count: subs.length };
}

export function removeSubscription(endpoint) {
  const subs = readSubs().filter((s) => s.endpoint !== endpoint);
  writeSubs(subs);
  return { ok: true, count: subs.length };
}

export async function sendPushToAll({ title, body, url }) {
  const subs = readSubs();
  if (!subs.length) {
    console.log('[push] No mobile subscriptions yet — open the site on phone and tap Enable alerts');
    return { sent: 0, failed: 0 };
  }

  const payload = JSON.stringify({
    title: title || 'BookMyShow alert',
    body: body || 'Booking update',
    url: url || '/',
  });

  let sent = 0;
  let failed = 0;
  const keep = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      keep.push(sub);
      sent += 1;
    } catch (err) {
      failed += 1;
      const code = err.statusCode;
      // Drop gone/expired subscriptions
      if (code !== 404 && code !== 410) keep.push(sub);
      console.error('[push] send failed:', code || err.message);
    }
  }

  writeSubs(keep);
  console.log(`[push] Sent ${sent}, failed ${failed}`);
  return { sent, failed };
}
