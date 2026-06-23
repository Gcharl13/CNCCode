'use strict';

/*
 * On-disk job store for the production queue.
 *
 * Each job is one JSON file under DATA_DIR/jobs/<id>.json. Large blobs (the
 * source DXF and the finalized .nc) are kept as sibling files <id>.dxf /
 * <id>.nc so job listings stay small and fast. Writes are atomic (write to
 * a .tmp file then rename) so a crash mid-write can never leave a torn job.
 *
 * Assumes a single operator (one Express process). A per-id promise chain
 * serializes writes to the same job so concurrent saves can't interleave.
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { JOBS_DIR } = require('./config');

const STATUSES = ['planned', 'nested', 'ready', 'done'];

async function ensureDirs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
}

function jobPath(id) { return path.join(JOBS_DIR, id + '.json'); }
function sibling(id, ext) { return path.join(JOBS_DIR, id + '.' + ext); }

// ---- per-id write serialization -------------------------------------------
const chains = new Map();
function withLock(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  // Store a never-rejecting tail so one failed op doesn't poison the chain.
  chains.set(id, run.then(() => {}, () => {}));
  return run;
}

async function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

// ---- helpers ---------------------------------------------------------------
function isValidId(id) { return typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id); }

function newJob({ name, units } = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: (name && String(name).trim()) || 'Untitled job',
    status: 'planned',
    createdAt: now,
    updatedAt: now,
    units: units === 'mm' ? 'mm' : 'in',
    quantity: 1,
    source: { kind: 'dxf', file: null },   // future: kind:"spacer", params:{...}
    settings: null,                          // getSettings() snapshot + raw inputs
    nesting: null,                           // serialized nest plan
    outputs: { ncFile: null, estMinutes: null }
  };
}

function summarize(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    quantity: job.quantity,
    units: job.units,
    updatedAt: job.updatedAt,
    hasDxf: !!(job.source && job.source.file),
    hasNc: !!(job.outputs && job.outputs.ncFile)
  };
}

// ---- public API ------------------------------------------------------------
async function listJobs() {
  await ensureDirs();
  const files = await fsp.readdir(JOBS_DIR);
  const jobs = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.json.tmp')) continue;
    try {
      const job = JSON.parse(await fsp.readFile(path.join(JOBS_DIR, f), 'utf8'));
      jobs.push(summarize(job));
    } catch (_) { /* skip unreadable/partial files */ }
  }
  jobs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return jobs;
}

async function getJob(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fsp.readFile(jobPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

async function createJob(input) {
  await ensureDirs();
  const job = newJob(input);
  await withLock(job.id, () => atomicWrite(jobPath(job.id), JSON.stringify(job, null, 2)));
  return job;
}

const UPDATABLE = ['name', 'units', 'quantity', 'settings', 'nesting', 'status'];

async function updateJob(id, patch) {
  return withLock(id, async () => {
    const job = await getJob(id);
    if (!job) return null;
    for (const key of UPDATABLE) {
      if (patch[key] === undefined) continue;
      if (key === 'status' && !STATUSES.includes(patch.status)) {
        const err = new Error('Invalid status: ' + patch.status);
        err.status = 400;
        throw err;
      }
      if (key === 'units') { job.units = patch.units === 'mm' ? 'mm' : 'in'; continue; }
      if (key === 'quantity') { job.quantity = Math.max(0, parseInt(patch.quantity, 10) || 0); continue; }
      if (key === 'name') { job.name = String(patch.name).trim() || job.name; continue; }
      job[key] = patch[key];
    }
    job.updatedAt = new Date().toISOString();
    await atomicWrite(jobPath(id), JSON.stringify(job, null, 2));
    return job;
  });
}

async function saveSource(id, dxfText) {
  return withLock(id, async () => {
    const job = await getJob(id);
    if (!job) return null;
    const file = id + '.dxf';
    await atomicWrite(sibling(id, 'dxf'), dxfText);
    job.source = Object.assign({ kind: 'dxf' }, job.source, { file });
    job.updatedAt = new Date().toISOString();
    await atomicWrite(jobPath(id), JSON.stringify(job, null, 2));
    return job;
  });
}

async function getSource(id) {
  const job = await getJob(id);
  if (!job || !job.source || !job.source.file) return null;
  try { return await fsp.readFile(sibling(id, 'dxf'), 'utf8'); }
  catch (_) { return null; }
}

async function finalize(id, ncText, estMinutes) {
  return withLock(id, async () => {
    const job = await getJob(id);
    if (!job) return null;
    if (!ncText || !String(ncText).trim()) {
      const err = new Error('No G-code to finalize. Generate G-code before sending.');
      err.status = 409;
      throw err;
    }
    await atomicWrite(sibling(id, 'nc'), ncText);
    job.outputs = job.outputs || {};
    job.outputs.ncFile = id + '.nc';
    if (estMinutes != null) job.outputs.estMinutes = estMinutes;
    job.status = 'ready';
    job.updatedAt = new Date().toISOString();
    await atomicWrite(jobPath(id), JSON.stringify(job, null, 2));
    return job;
  });
}

async function getNc(id) {
  const job = await getJob(id);
  if (!job || !job.outputs || !job.outputs.ncFile) return null;
  try { return await fsp.readFile(sibling(id, 'nc'), 'utf8'); }
  catch (_) { return null; }
}

async function deleteJob(id) {
  return withLock(id, async () => {
    const job = await getJob(id);
    if (!job) return false;
    for (const p of [jobPath(id), sibling(id, 'dxf'), sibling(id, 'nc')]) {
      try { await fsp.unlink(p); } catch (_) { /* may not exist */ }
    }
    return true;
  });
}

module.exports = {
  STATUSES, ensureDirs, listJobs, getJob, createJob, updateJob,
  saveSource, getSource, finalize, getNc, deleteJob, summarize
};
