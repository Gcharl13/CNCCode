'use strict';

const path = require('path');
const express = require('express');
const { PORT, JSON_LIMIT } = require('./config');
const store = require('./store');
const jobsRouter = require('./routes/jobs');

function createApp() {
  const app = express();
  app.use(express.json({ limit: JSON_LIMIT }));

  // Quietly handle the browser's automatic favicon request (no asset yet).
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // Clean URL for the shop-floor kiosk (static also serves /kiosk.html).
  app.get('/kiosk', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'kiosk.html')));

  // API
  app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.use('/api', jobsRouter);

  // Static app (the CNC Nest HTML and any assets)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // JSON error handler (keep last)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });

  return app;
}

async function main() {
  await store.ensureDirs();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`CNC Job Planner listening on http://0.0.0.0:${PORT}`);
  });
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createApp };
