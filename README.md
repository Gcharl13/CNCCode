# CNC Job Planner

A Dockerized **job planner / production queue** for cutting HDPE **duct-bank spacers**
on an NK105 (G2) CNC router. One job flows through four screens that share a single
server-persisted store (jobs survive container restarts):

- **Jobs dashboard** (`/`) — list every job, create new ones, jump into a stage.
- **Spacer design** (`/spacer`) — parametric duct-bank-spacer generator (plate +
  conduit grid + concrete-fill + rebar) that emits the part DXF.
- **Cut path** (`/cut`) — the CNC Nest app: nest, vacuum template, NK105 G-code, finalize.
- **Kiosk** (`/kiosk`) — touch board by the machine; the operator runs the queue
  (Start → Cutting → Done, tracking cut counts).

Typical flow: **dashboard → spacer design → cut path → finalize → kiosk**.

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
npm run test:e2e   # real-browser smoke incl. kiosk flow (needs Chromium)
```

## Configuration (env)
| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Job store root; jobs live in `<DATA_DIR>/jobs` |
| `JSON_LIMIT` | `8mb` | Max JSON body (DXF/G-code can be large) |

## Layout
```
public/dashboard.html Jobs dashboard                   (served at /)
public/spacer.html    Duct-bank spacer generator       (served at /spacer)
public/index.html     CNC Nest app + Job panel         (cut path, served at /cut)
public/kiosk.html     Shop-floor production board       (served at /kiosk)
server/index.js       Express: page routes + static + /api + error handling
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
| PUT | `/api/jobs/:id/dxf` | save source DXF `{ dxf, kind?, params? }` (e.g. `kind:'spacer'`) |
| GET | `/api/jobs/:id/dxf` | source DXF text |
| POST | `/api/jobs/:id/finalize` | store G-code `{ gcode, estMinutes }`, status → `ready` |
| GET | `/api/jobs/:id/nc` | download the finalized `.nc` |
| POST | `/api/jobs/:id/status` | set `{ status }` (e.g. `running`, `done`) |
| POST | `/api/jobs/:id/progress` | bump cut counter `{ delta }` (kiosk "+1 cut") |
| PUT | `/api/jobs/:id/thumb` | save part preview `{ dataUrl }` (PNG) |
| GET | `/api/jobs/:id/thumb` | part preview image |
| DELETE | `/api/jobs/:id` | delete job + its files |

Status lifecycle: `planned → nested → ready → running → done`.

## Send to machine
v1 is **download-only**: finalize stores the `.nc` server-side and you download it
to copy to USB for the NK105. (No outbox/network push.)

## Kiosk (shop floor)
Open **`/kiosk`** on a screen by the machine. It shows a live, touch-friendly "next up"
list of finalized jobs (auto-refreshes ~4 s): **Cutting** pinned at top, then **Ready**
(oldest first), then recently **Done**. Each card has a part preview and a `cut / quantity`
progress bar. The operator taps **Start** (Ready → Cutting), **+1 cut** to count parts
(auto-completes at quantity), and **Done**; **Download .nc** grabs the file. Every screen
cross-links (Jobs / Spacer / Cut path / Kiosk).

## Spacer generator
The spacer page builds a parametric HDPE duct-bank spacer (plate, conduit grid with Sch-40
hole sizing, concrete-fill holes, rebar). On **Save & Cut path →** it writes the part DXF to
the job (`source.kind:"spacer"` + the params, so the job can be reopened and re-edited) plus a
preview, then hands off to the cut-path view. That view loads the DXF through the engine's
`loadDxfText` — the single integration seam — so nesting / template / G-code work unchanged;
re-saving on the cut-path side preserves the spacer `kind`/`params`.

## Assumptions
- Single trusted operator on a LAN (no auth in v1).
- The geometry/G-code engine (ClipperLib + CNC core) is vendored inside
  `public/index.html` and is not modified.
