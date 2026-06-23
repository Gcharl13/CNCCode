'use strict';

// Use an isolated temp data dir BEFORE requiring config/store (config reads env at load).
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-jobs-'));

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');
const store = require('../server/store');

let server, base;

test.before(async () => {
  await store.ensureDirs();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server && server.close(); });

const j = (r) => r.json();
const postJson = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const putJson = (b) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

test('health responds ok', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await j(res)).ok, true);
});

test('full job lifecycle: create -> dxf -> finalize -> download -> done -> delete', async () => {
  // create
  let res = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'DB-test', units: 'in' })
  });
  assert.equal(res.status, 201);
  const job = await j(res);
  assert.match(job.id, /[a-f0-9-]{36}/);
  assert.equal(job.status, 'planned');
  assert.equal(job.units, 'in');

  // appears in list
  res = await fetch(`${base}/api/jobs`);
  const list = await j(res);
  assert.ok(list.find((x) => x.id === job.id));

  // update metadata
  res = await fetch(`${base}/api/jobs/${job.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quantity: 10, status: 'nested', settings: { feed: 160 }, nesting: { sheets: 1 } })
  });
  assert.equal(res.status, 200);
  let updated = await j(res);
  assert.equal(updated.quantity, 10);
  assert.equal(updated.status, 'nested');
  assert.deepEqual(updated.settings, { feed: 160 });

  // invalid status rejected
  res = await fetch(`${base}/api/jobs/${job.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'bogus' })
  });
  assert.equal(res.status, 400);

  // save source DXF
  const dxf = '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
  res = await fetch(`${base}/api/jobs/${job.id}/dxf`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dxf })
  });
  assert.equal(res.status, 200);

  // read it back verbatim
  res = await fetch(`${base}/api/jobs/${job.id}/dxf`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), dxf);

  // finalize without gcode -> 409
  res = await fetch(`${base}/api/jobs/${job.id}/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gcode: '' })
  });
  assert.equal(res.status, 409);

  // finalize with gcode -> ready
  const gcode = 'G21\nG0 X0 Y0\nM30\n';
  res = await fetch(`${base}/api/jobs/${job.id}/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gcode, estMinutes: 5.5 })
  });
  assert.equal(res.status, 200);
  updated = await j(res);
  assert.equal(updated.status, 'ready');
  assert.equal(updated.outputs.estMinutes, 5.5);

  // download nc, byte-identical, with attachment filename
  res = await fetch(`${base}/api/jobs/${job.id}/nc`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /DB-test\.nc/);
  assert.equal(await res.text(), gcode);

  // mark done
  res = await fetch(`${base}/api/jobs/${job.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'done' })
  });
  assert.equal((await j(res)).status, 'done');

  // delete
  res = await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  res = await fetch(`${base}/api/jobs/${job.id}`);
  assert.equal(res.status, 404);
});

test('unknown job ids return 404', async () => {
  const id = crypto.randomUUID();
  const res = await fetch(`${base}/api/jobs/${id}`);
  assert.equal(res.status, 404);
});

test('persistence: job json is written to DATA_DIR/jobs', async () => {
  const res = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'persist' })
  });
  const job = await j(res);
  const file = path.join(process.env.DATA_DIR, 'jobs', job.id + '.json');
  assert.ok(fs.existsSync(file), 'job json should exist on disk');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.name, 'persist');
});

test('running status is valid and progress drives the cut counter', async () => {
  const job = await j(await fetch(`${base}/api/jobs`, postJson({ name: 'prog' })));
  await fetch(`${base}/api/jobs/${job.id}`, putJson({ quantity: 3 }));

  let r = await fetch(`${base}/api/jobs/${job.id}/status`, postJson({ status: 'running' }));
  assert.equal((await j(r)).status, 'running');

  let u = await j(await fetch(`${base}/api/jobs/${job.id}/progress`, postJson({ delta: 2 })));
  assert.equal(u.completed, 2);
  assert.equal(u.status, 'running');

  u = await j(await fetch(`${base}/api/jobs/${job.id}/progress`, postJson({ delta: -1 })));
  assert.equal(u.completed, 1, 'decrement clamps within range');

  u = await j(await fetch(`${base}/api/jobs/${job.id}/progress`, postJson({ delta: 99 })));
  assert.equal(u.completed, 3, 'overshoot clamps to quantity');
  assert.equal(u.status, 'done', 'auto-completes at quantity');
});

test('thumbnail round-trip, summary flag, and delete cleanup', async () => {
  const job = await j(await fetch(`${base}/api/jobs`, postJson({ name: 'thumb' })));
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  let r = await fetch(`${base}/api/jobs/${job.id}/thumb`, putJson({ dataUrl: 'data:image/png;base64,' + pngB64 }));
  assert.equal(r.status, 200);

  const sum = (await j(await fetch(`${base}/api/jobs`))).find((x) => x.id === job.id);
  assert.equal(sum.hasThumb, true);
  assert.equal(sum.completed, 0);

  r = await fetch(`${base}/api/jobs/${job.id}/thumb`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/png/);

  r = await fetch(`${base}/api/jobs/${job.id}/thumb`, putJson({ dataUrl: 'not-a-png' }));
  assert.equal(r.status, 400, 'rejects a non-PNG data URL');

  await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' });
  const pngPath = path.join(process.env.DATA_DIR, 'jobs', job.id + '.png');
  assert.ok(!fs.existsSync(pngPath), 'png removed on delete');
});
