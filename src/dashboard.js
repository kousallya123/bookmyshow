import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { readStatus, writeStatus } from './statusStore.js';
import { getVapidPublicKey, saveSubscription, removeSubscription } from './push.js';
import { processCheckResults } from './processResults.js';
import { getMonitor, saveMonitor } from './monitorStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function normalizeAlerts(status) {
  if (Array.isArray(status.alerts)) return status.alerts;
  if (status.alert) return [status.alert];
  return [];
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

export function startDashboard() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${config.dashboardPort}`);

    if (url.pathname === '/api/health') {
      const status = readStatus();
      json(res, 200, {
        ok: true,
        ts: new Date().toISOString(),
        role: config.role,
        source: status.source || null,
        updatedAt: status.updatedAt || null,
      });
      return;
    }

    if (url.pathname === '/api/debug-bms') {
      try {
        const { debugBmsFetch } = await import('./checkShowsTls.js');
        const date = url.searchParams.get('date') || config.targetDates[0];
        const info = await debugBmsFetch(date);
        json(res, 200, info);
      } catch (err) {
        json(res, 500, { ok: false, error: err.message || String(err) });
      }
      return;
    }

    // Local worker posts BMS check results here (Render IPs are blocked by BMS)
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!config.ingestSecret || token !== config.ingestSecret) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      const body = await readBody(req);
      const results = Array.isArray(body.results) ? body.results : [];
      if (!results.length) {
        json(res, 400, { ok: false, error: 'results[] required' });
        return;
      }

      const out = await processCheckResults(results, { source: 'worker' });
      json(res, 200, { ok: true, alerts: out.alerts.length, dates: out.dates.length });
      return;
    }

    if (url.pathname === '/api/vapid-public-key') {
      json(res, 200, { publicKey: getVapidPublicKey() });
      return;
    }

    if (url.pathname === '/api/push-subscribe' && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, saveSubscription(body.subscription || body));
      return;
    }

    if (url.pathname === '/api/push-unsubscribe' && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, removeSubscription(body.endpoint));
      return;
    }

    if (url.pathname === '/api/status') {
      const status = readStatus();
      status.alerts = normalizeAlerts(status).filter((a) => a?.active && !a?.dismissed);
      status.monitor = status.monitor || (await getMonitor());
      json(res, 200, status);
      return;
    }

    if (url.pathname === '/api/monitor' && req.method === 'GET') {
      json(res, 200, await getMonitor(true));
      return;
    }

    if (url.pathname === '/api/monitor' && req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const saved = await saveMonitor(body);
        const prev = readStatus();
        writeStatus({
          ...prev,
          movieName: saved.movieName,
          cinemaName: saved.cinemaName,
          city: saved.city,
          formatHint: saved.formatHint,
          notificationsEnabled: saved.notificationsEnabled !== false,
          bmsUrl: saved.bmsUrl,
          targetDates: saved.dates.filter((d) => d.enabled !== false).map((d) => d.date),
          monitor: saved,
        });
        json(res, 200, { ok: true, monitor: saved });
      } catch (err) {
        json(res, 400, { ok: false, error: err.message || String(err) });
      }
      return;
    }

    if (url.pathname === '/api/dismiss-alert' && req.method === 'POST') {
      const body = await readBody(req);
      const status = readStatus();
      const alerts = normalizeAlerts(status);
      const date = body.date || null;
      const cinemaName = body.cinemaName || null;

      const next = alerts.map((a) => {
        const matchDate = date ? a.date === date : true;
        const matchCinema = cinemaName ? a.cinemaName === cinemaName : true;
        if (!(matchDate && matchCinema)) return a;
        return {
          ...a,
          active: false,
          dismissed: true,
          dismissedAt: new Date().toISOString(),
        };
      });

      status.alerts = next;
      status.alert = next.find((a) => a.active && !a.dismissed) || null;
      writeStatus(status);
      json(res, 200, { ok: true, alerts: status.alerts });
      return;
    }

    const filePath =
      url.pathname === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, url.pathname);

    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.webmanifest': 'application/manifest+json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `Dashboard port ${config.dashboardPort} already in use — open http://localhost:${config.dashboardPort}`,
      );
      return;
    }
    throw err;
  });

  server.listen(config.dashboardPort, '0.0.0.0', () => {
    console.log(`Dashboard: http://localhost:${config.dashboardPort}`);
  });

  return server;
}
