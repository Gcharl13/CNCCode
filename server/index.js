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

  // Page routes — one job, four screens. (static is index:false so '/' is the dashboard)
  const page = (f) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', f));
  app.get('/', page('dashboard.html'));      // jobs dashboard (home)
  app.get('/spacer', page('spacer.html'));   // spacer design stage
  app.get('/cut', page('index.html'));       // cut-path stage (the CNC Nest app)
  app.get('/kiosk', page('kiosk.html'));     // operator production board

  // API
  app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.use('/api', jobsRouter);

  // Static assets (index:false — the dashboard owns '/')
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

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
