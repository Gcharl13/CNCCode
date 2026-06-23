'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

function notFound(res) { return res.status(404).json({ error: 'Job not found' }); }

// List (summaries only)
router.get('/jobs', async (req, res, next) => {
  try { res.json(await store.listJobs()); } catch (e) { next(e); }
});

// Create
router.post('/jobs', async (req, res, next) => {
  try {
    const { name, units } = req.body || {};
    const job = await store.createJob({ name, units });
    res.status(201).json(job);
  } catch (e) { next(e); }
});

// Read full job
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await store.getJob(req.params.id);
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Update metadata (name, units, quantity, settings, nesting, status)
router.put('/jobs/:id', async (req, res, next) => {
  try {
    const job = await store.updateJob(req.params.id, req.body || {});
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Save the source DXF (sent separately from metadata to avoid resending it on every save).
// Optional { kind, params } tags the source (e.g. kind:'spacer' from the generator).
router.put('/jobs/:id/dxf', async (req, res, next) => {
  try {
    const dxf = (req.body && req.body.dxf) || '';
    if (!dxf) return res.status(400).json({ error: 'Missing dxf text' });
    const job = await store.saveSource(req.params.id, dxf, { kind: req.body.kind, params: req.body.params });
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Get the source DXF text
router.get('/jobs/:id/dxf', async (req, res, next) => {
  try {
    const dxf = await store.getSource(req.params.id);
    if (dxf == null) return res.status(404).json({ error: 'No source DXF for this job' });
    res.type('application/dxf').send(dxf);
  } catch (e) { next(e); }
});

// Finalize: store the generated .nc and flip status to "ready"
router.post('/jobs/:id/finalize', async (req, res, next) => {
  try {
    const { gcode, estMinutes } = req.body || {};
    const job = await store.finalize(req.params.id, gcode, estMinutes);
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Download the finalized .nc
router.get('/jobs/:id/nc', async (req, res, next) => {
  try {
    const job = await store.getJob(req.params.id);
    if (!job) return notFound(res);
    const nc = await store.getNc(req.params.id);
    if (nc == null) return res.status(404).json({ error: 'Job has not been finalized' });
    const safe = String(job.name).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'job';
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.nc"`);
    res.type('text/plain').send(nc);
  } catch (e) { next(e); }
});

// Explicit status transition (e.g. mark "done")
router.post('/jobs/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const job = await store.updateJob(req.params.id, { status });
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Bump the cut counter (kiosk "+1 cut"); auto-advances ready->running and ->done at quantity
router.post('/jobs/:id/progress', async (req, res, next) => {
  try {
    const delta = (req.body && req.body.delta != null) ? req.body.delta : 1;
    const job = await store.bumpProgress(req.params.id, delta);
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Save a part-preview thumbnail (PNG data URL captured from the design canvas)
router.put('/jobs/:id/thumb', async (req, res, next) => {
  try {
    const job = await store.saveThumb(req.params.id, (req.body && req.body.dataUrl) || '');
    if (!job) return notFound(res);
    res.json(job);
  } catch (e) { next(e); }
});

// Serve the thumbnail image
router.get('/jobs/:id/thumb', async (req, res, next) => {
  try {
    const png = await store.getThumb(req.params.id);
    if (png == null) return res.status(404).json({ error: 'No thumbnail' });
    res.type('image/png').send(png);
  } catch (e) { next(e); }
});

// Delete
router.delete('/jobs/:id', async (req, res, next) => {
  try {
    const ok = await store.deleteJob(req.params.id);
    if (!ok) return notFound(res);
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
