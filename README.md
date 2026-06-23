# CNC Job Planner

A Dockerized **production queue** for cutting parts on an NK105 (G2) CNC router.
It serves the existing **CNC Nest** app (load DXF → nest → vacuum template →
NK105 G-code) and adds a server-persisted job queue: create/name a job, load its
DXF, set quantity, nest, generate the template + G-code, save it, and finalize →
download the `.nc`. Jobs survive container restarts.

> This is v1. It starts from the existing **load-DXF** workflow. The parametric
> **HDPE duct-bank spacer generator** plugs in next (see *Spacer seam* below) and
> needs no backend changes — it just feeds geometry into the same pipeline.

## Run

### Docker (recommended)
```bash
docker compose up --build
# open http://localhost:8080
```
Jobs persist in `./data/jobs` on the host (mounted into the container at `/data`).

### Local (dev)
```bash
npm install
npm start          # http://localhost:8080
npm run dev        # auto-restart on change
npm test           # engine smoke test + job API tests
```

## Configuration (env)
| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Job store root; jobs live in `<DATA_DIR>/jobs` |
| `JSON_LIMIT` | `8mb` | Max JSON body (DXF/G-code can be large) |

## Layout
```
public/index.html     The CNC Nest app (served as-is) + a Job panel
server/index.js       Express: static + /api + error handling
server/store.js       Atomic JSON job store (one file per job + sibling .dxf/.nc)
server/routes/jobs.js REST API for the queue
data/jobs/            Persisted jobs (mounted volume)
test/                 Headless engine + job API tests
```

## REST API
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | readiness probe |
| GET | `/api/jobs` | list job summaries |
| POST | `/api/jobs` | create `{ name, units }` |
| GET | `/api/jobs/:id` | full job |
| PUT | `/api/jobs/:id` | update `{ name, units, quantity, settings, nesting, status }` |
| PUT | `/api/jobs/:id/dxf` | save source DXF `{ dxf }` |
| GET | `/api/jobs/:id/dxf` | source DXF text |
| POST | `/api/jobs/:id/finalize` | store G-code `{ gcode, estMinutes }`, status → `ready` |
| GET | `/api/jobs/:id/nc` | download the finalized `.nc` |
| POST | `/api/jobs/:id/status` | set `{ status }` (e.g. `done`) |
| DELETE | `/api/jobs/:id` | delete job + its files |

Status lifecycle: `planned → nested → ready → done`.

## Send to machine
v1 is **download-only**: finalize stores the `.nc` server-side and you download it
to copy to USB for the NK105. (No outbox/network push.)

## Spacer seam (next phase)
A duct-bank-spacer generator will produce a DXF string and call the app's existing
`loadDxfText(text, name)` — the single integration point. Everything downstream
(nesting, template, G-code) already works on whatever `loadDxfText` receives, so the
generator drops in with no backend changes; the job's `source` simply becomes
`{ kind: "spacer", params: {...} }` instead of a stored DXF.

## Assumptions
- Single trusted operator on a LAN (no auth in v1).
- The geometry/G-code engine (ClipperLib + CNC core) is vendored inside
  `public/index.html` and is not modified.
