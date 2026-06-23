'use strict';

/*
 * Headless end-to-end smoke test (real Chromium via Puppeteer).
 * Not part of `npm test` (needs a browser); run with: node test/e2e.js
 *
 * Drives the actual UI: load page -> create job -> load a part (the geometry
 * engine runs in the real browser and produces G-code) -> save -> finalize ->
 * verify the .nc is persisted and downloadable server-side.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-e2e-'));
const { createApp } = require('../server/index');
const store = require('../server/store');
const puppeteer = require('puppeteer');

const SQUARE_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'POLYLINE', '8', '0', '66', '1', '70', '1',
  '0', 'VERTEX', '8', '0', '10', '0', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '10', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '10', '20', '10',
  '0', 'VERTEX', '8', '0', '10', '0', '20', '10',
  '0', 'SEQEND', '8', '0',
  '0', 'ENDSEC', '0', 'EOF'
].join('\r\n') + '\r\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, { tries = 40, gap = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(gap);
  }
  return null;
}

(async () => {
  await store.ensureDirs();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let failed = false;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

    // Deny the attachment download triggered by Finalize so it doesn't navigate.
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

    await page.goto(base + '/', { waitUntil: 'networkidle0' });

    // 1) App + job panel rendered, no uncaught errors on load
    await page.waitForSelector('#jobBox', { visible: true });
    assert.equal(errors.length, 0, 'no page/console errors on load; got: ' + errors.join(' | '));
    console.log('✓ page loaded, #jobBox visible, no JS errors');

    // 2) Create a job via the New button (stub prompt)
    await page.evaluate(() => { window.prompt = () => 'E2E job'; });
    await page.click('#btnJobNew');
    await page.waitForFunction(() => document.getElementById('jobName').textContent === 'E2E job', { timeout: 5000 });
    console.log('✓ New job created and shown in panel');

    const jobId = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.name === 'E2E job').id;
    assert.ok(jobId, 'created job present in API list');

    // 3) Load a part — the engine runs in the real browser and must produce G-code
    const gen = await page.evaluate((dxf) => {
      loadDxfText(dxf, 'sq.dxf');
      return { hasChained: !!(state.chained && state.chained.loops && state.chained.loops.length),
               gcodeLen: (state.gcode && state.gcode.text) ? state.gcode.text.length : 0 };
    }, SQUARE_DXF);
    assert.ok(gen.hasChained, 'DXF loaded and chained in-browser');
    assert.ok(gen.gcodeLen > 0, 'G-code generated in-browser (len ' + gen.gcodeLen + ')');
    console.log('✓ part loaded; engine generated G-code in-browser (' + gen.gcodeLen + ' chars)');

    // 4) Save -> job gains source DXF on the server
    await page.click('#btnJobSave');
    const saved = await poll(async () => {
      const j = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
      return (j.source && j.source.file && j.settings) ? j : null;
    });
    assert.ok(saved, 'job saved with source DXF + settings');
    console.log('✓ Save persisted source DXF + settings server-side');

    // 5) Finalize -> .nc stored, status ready
    await page.click('#btnJobFinalize');
    const ready = await poll(async () => {
      const j = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
      return (j.status === 'ready' && j.outputs && j.outputs.ncFile) ? j : null;
    });
    assert.ok(ready, 'job finalized: status ready + ncFile set');

    const ncRes = await fetch(`${base}/api/jobs/${jobId}/nc`);
    assert.equal(ncRes.status, 200, '.nc downloadable');
    const nc = await ncRes.text();
    const browserGcode = await page.evaluate(() => state.gcode.text);
    assert.equal(nc, browserGcode, 'downloaded .nc is byte-identical to the in-browser G-code');
    console.log('✓ Finalize stored .nc; download byte-identical to generated G-code');

    console.log('\nALL E2E CHECKS PASSED');
  } catch (e) {
    failed = true;
    console.error('\nE2E FAILED:', e.message);
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
})();
