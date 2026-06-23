'use strict';

const path = require('path');

// All runtime configuration comes from the environment so the same image
// behaves correctly in Docker (with mounted volumes) and in local/dev runs.
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');

// Body size limit for JSON payloads (DXF text and G-code can be large).
const JSON_LIMIT = process.env.JSON_LIMIT || '8mb';

module.exports = { PORT, DATA_DIR, JOBS_DIR, JSON_LIMIT };
