'use strict';

/*
 * Full-flow headless end-to-end test (real Chromium via Puppeteer).
 * Not part of `npm test` (needs a browser); run with: node test/e2e.js
 *
 * Walks the whole job-centric pipeline in a real browser:
 *   dashboard New job -> spacer "Save & Cut path" -> cut page auto-loads the
 *   generated spacer DXF and produces G-code -> finalize -> kiosk Start/+1/Done.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-e2e-'));
const { createApp } = require('../server/index');
const store = require('../server/store');
const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, { tries = 50, gap = 150 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}
async function clickByText(pg, text) {
  const ok = await pg.evaluate((t) => {
    const b = [...document.querySelectorAll('.card .btn')].find((x) => x.textContent.trim().includes(t));
    if (b) { b.click(); return true; }
    return false;
  }, text);
  if (!ok) throw new Error('kiosk button not found: ' + text);
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
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message)); // uncaught JS exceptions only
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'deny' }); // Finalize triggers a download
    const noJsErrors = (label) => assert.equal(pageErrors.length, 0, label + ' had JS exceptions: ' + pageErrors.join(' | '));

    // 1) Dashboard -> New job
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#btnNew', { visible: true });
    noJsErrors('dashboard');
    console.log('✓ dashboard loaded');

    await page.evaluate(() => { window.prompt = () => 'E2E spacer'; });
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#btnNew')]);
    assert.ok(page.url().includes('/spacer?job='), 'navigated to spacer; got ' + page.url());
    const jobId = new URL(page.url()).searchParams.get('job');
    console.log('✓ New job created -> spacer (' + jobId + ')');

    // 2) Spacer -> Save & Cut path
    await page.waitForSelector('#btnSaveCut', { visible: true });
    noJsErrors('spacer');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#btnSaveCut')]);
    assert.ok(page.url().includes('/cut?job=' + jobId), 'navigated to cut path; got ' + page.url());
    console.log('✓ spacer "Save & Cut path" -> cut page');

    // 3) Cut path: the spacer DXF auto-loads and the engine produces G-code
    await page.waitForSelector('#jobBox', { visible: true });
    await page.waitForFunction(
      () => typeof state !== 'undefined' && state.gcode && state.gcode.text && state.gcode.text.length > 0,
      { timeout: 20000 });
    noJsErrors('cut path');
    const gen = await page.evaluate(() => ({
      chained: !!(state.chained && state.chained.loops && state.chained.loops.length),
      holes: state.chained.loops.filter((l) => l.isHole).length,
      glen: state.gcode.text.length
    }));
    assert.ok(gen.chained && gen.holes > 0, 'spacer DXF chained with holes (' + gen.holes + ')');
    assert.ok(gen.glen > 0, 'G-code generated from spacer part');
    console.log('✓ cut page auto-loaded spacer part; ' + gen.holes + ' holes, G-code ' + gen.glen + ' chars');

    // nesting panel is visible for the single spacer; nest a few copies onto the sheet
    const nestVisible = await page.evaluate(() => {
      const b = document.getElementById('nestBox');
      return !!(b && b.style.display !== 'none' && document.querySelectorAll('#nestParts .nestrow').length > 0);
    });
    assert.ok(nestVisible, 'nesting panel visible for the spacer part');
    await page.evaluate(() => { const i = document.querySelector('#nestParts input[data-nq]'); if (i) { i.value = '4'; i.dispatchEvent(new Event('change')); } });
    await page.click('#btnNest'); // Mixed sheet
    await page.waitForFunction(() => state.chained && state.chained.loops.filter((l) => !l.isHole).length >= 2, { timeout: 10000 });
    const outers = await page.evaluate(() => state.chained.loops.filter((l) => !l.isHole).length);
    assert.ok(outers >= 2, 'nested multiple parts onto the sheet (' + outers + ')');
    console.log('✓ nesting panel works; nested ' + outers + ' parts onto the sheet');

    // set quantity and finalize
    await page.evaluate(() => { const q = document.getElementById('jobQty'); q.value = '3'; q.dispatchEvent(new Event('change')); });
    await page.click('#btnJobFinalize');
    const ready = await poll(async () => {
      const jb = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
      return (jb.status === 'ready' && jb.outputs && jb.outputs.ncFile) ? jb : null;
    });
    assert.ok(ready, 'job finalized to ready');
    assert.equal(ready.source.kind, 'spacer', 'job source tagged as spacer (preserved through cut-path save)');
    assert.equal(ready.quantity, 3, 'quantity saved');
    console.log('✓ finalized; source.kind=spacer, qty=3, .nc stored');

    // 4) Kiosk: run it Start -> +1 cut -> Done
    const kiosk = await browser.newPage();
    const kErrors = [];
    kiosk.on('pageerror', (e) => kErrors.push(e.message));
    const kclient = await kiosk.createCDPSession();
    await kclient.send('Page.setDownloadBehavior', { behavior: 'deny' });
    await kiosk.goto(base + '/kiosk', { waitUntil: 'networkidle0' });

    await kiosk.waitForFunction(() => document.querySelectorAll('.card.ready').length > 0, { timeout: 10000 });
    assert.equal(kErrors.length, 0, 'kiosk JS exceptions: ' + kErrors.join(' | '));
    const thumbOk = await kiosk.evaluate(() => { const i = document.querySelector('.card .thumb img'); return !!(i && i.complete && i.naturalWidth > 0); });
    assert.ok(thumbOk, 'kiosk shows a part thumbnail');
    console.log('✓ kiosk shows job Ready with preview');

    await clickByText(kiosk, 'Start');
    await kiosk.waitForFunction(() => document.querySelectorAll('.card.running').length > 0, { timeout: 10000 });
    await clickByText(kiosk, '+1 cut');
    await kiosk.waitForFunction(() => { const b = document.querySelector('.card.running .prognum b'); return b && b.textContent === '1'; }, { timeout: 10000 });
    await clickByText(kiosk, 'Done');
    await kiosk.waitForFunction(() => document.querySelectorAll('.card.done').length > 0, { timeout: 10000 });
    const fin = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    assert.equal(fin.status, 'done', 'job marked done from the kiosk');
    console.log('✓ kiosk Start → +1 cut → Done');

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
