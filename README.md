# Ten Tors 2026 — Route I dashboard (team IF)

Mobile-first dashboard for **Polar Explorer Scouts (IF)** on Route I (35 mi) of the 2026 Ten Tors Challenge (9–10 May 2026). Data is scraped server-side by GitHub Actions and published as static JSON; the browser only fetches local files.

Live: <https://j3brns.github.io/tentors26/> · alt hero: <https://j3brns.github.io/tentors26/index2.html>

## Status

The team finished at **11:44 Sunday — 7th of 16 — 17h 44m walking**. The dashboard is frozen on the final snapshot (`site/data.json`) and the scheduled scraper is **paused** (`schedule` cron is commented out in `.github/workflows/update-route-i.yml`). Manual `workflow_dispatch` / `repository_dispatch` triggers still work.

For the full record of teams, times and DNFs see `site/fixtures/route-i-2026-final.json`.

## How it works

- `scripts/update-route-i-data.mjs` fetches <https://www.tentors.org.uk/eventdata/routei.html>, parses it with `cheerio`, computes per-checkpoint and comparator metrics, and writes `site/data.json` and `site/history.json`.
- `.github/workflows/update-route-i.yml` runs the updater on `workflow_dispatch` / `repository_dispatch` (the `*/5 * * * *` cron is commented out outside the event window). The job re-anchors on `origin/main` on every push attempt to survive races, and refuses to clobber a previously-populated snapshot with an empty parse.
- GitHub Pages serves the `/site` directory of `main`. The browser polls `./data.json` and `./history.json` every 60 seconds with a cache-busting query string.

No third-party scripts, no analytics, no client-side scraping.

## What the dashboard shows

**Hero** — team name, build chip (version + snapshot timestamp), Dartmoor daytime weather chip, GitHub link, and four headline tiles: **Reached · Progress · Position (with DNF count) · Class (35 mi)**.

**Map** — Leaflet + OSM tiles with start/finish flags and per-checkpoint markers; labelled "Inferred route map" because checkpoint coordinates are approximate (errors typically <1 km).

**Post-race stat strip** — Steps, Ascent/Descent, Hike avg pace, est. foot Distance. Every metric has a tappable `i` explainer.

**Insights card**
- Hiking time (= day 1 + day 2 breakdown to show consistency)
- Day 1 (07:00 → Standon Farm camp) / Day 2 (Standon Farm 06:10 → Finish) splits
- Climb rate with typical band (60–100 m/h reference)
- Best / worst leg vs comparator mean
- Position percentile (1st / 63rd / 100th — proper ordinals)
- Pace consistency (stddev + CV)
- GAP (Strava-style grade-adjusted pace, distance-weighted)
- Hardest leg + Effort score
- Achievement badges: 🚀 Negative splitter · ⛰️ Hill killer · 🎯 Consistent · ⛺ Camp ninja · 🥇 Top half · 🏁 All checkpoints

**Pace vs grade per leg** — bar per leg coloured by terrain grade, with a white tick at the GAP flat-equivalent.

**What-if calculator** — three labelled rows: actual finish, "if you matched the average on every leg", "if you matched the fastest on every leg (theoretical best of breed)".

**Ten Tors folklore** — origin anecdote (Sittaford Tor, 1959), notable 35-mi performances from prior years annotated with ±delta vs this team.

**Standard cards** — Current checkpoint, Pace per segment vs mean, Elevation profile, Position over time (when history data present), Progress timeline, Checkpoint grid.

## GitHub Pages settings

- Settings → Pages → **Source: Deploy from a branch**
- Branch: **`main`**, folder: **`/site`** (currently `/` if the legacy job is used; check Pages config)

## Local development

```bash
npm install
npm run update           # fetches the live page and rewrites site/*.json
npx http-server site     # or any static server, then open http://localhost:8080
```

To work without internet, point at a saved fixture:

```bash
LOCAL_FIXTURE=/path/to/routei.html npm run update
```

Useful environment variables:

| Variable             | Default                  | Purpose |
| -------------------- | ------------------------ | ------- |
| `TEAM_CODE`          | `IF`                     | Team to highlight. |
| `REQUESTED_NAME`     | `Polar Explorer Scouts`  | Compared against the parsed team name. |
| `STRIDE_METRES`      | `0.76`                   | Stride length used to estimate steps from distance. |
| `LOCAL_FIXTURE`      | unset                    | Read HTML from a local path instead of the live URL. |

## Triggering an update manually

**Workflow dispatch** — Actions tab → "Update Route I data" → Run workflow.

**Repository dispatch** via the API:

```bash
curl -X POST \
  -H "Authorization: Bearer <PAT_WITH_REPO_SCOPE>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"ten-tors-route-i-update"}'
```

To re-enable the 5-minute cron for a future event, uncomment the `schedule` block in `.github/workflows/update-route-i.yml`.

## Data contract

- `site/data.json` — current snapshot (`schemaVersion: 1`). Top-level fields include `reachedCount`, `currentCheckpoint`, `nextCheckpoint`, `elapsedRunning` (walking time, overnight stripped), `eta`, `checkpoints[]`, `comparator` (now with `dnfCount`), `routeMetrics`.
- `site/history.json` — appends one entry per genuine change of the team's row (hashed) or `sourceLastUpdated`. Capped at **500 entries** with FIFO eviction; cap is set in the updater (`HISTORY_CAP`).
- `site/fixtures/route-i-2026-final.json` — frozen record of all 16 teams' day-1 and day-2 times and final statuses (13 finished, 3 DNF).
- `site/fixtures/historical-35mi.json` — hand-curated references from prior 35-mi events (Churcher's 2011, Churcher's 2013, Gordon's 2024). Used by the Folklore card.

Missing values are returned as `null` with a sibling `reason` or `valueSource` field where applicable. The updater never invents data; if parsing fails it writes a `warnings` array and falls back to a labelled checkpoint list (each fallback checkpoint has `fallback: true`).

### Overnight handling

Ten Tors requires teams to camp by 19:10 day 1 and forbids leaving before 06:10 day 2 — an 11h mandatory rest. The updater detects the day rollover from a backwards jump in arrival clock and subtracts the 11h from elapsed, so all "moving" stats reflect walking time, not wall-clock. Comparator splits across the camp→Willsworthy segment are likewise stripped of the overnight.

### Foot distance

The client converts the Haversine straight-line `totalDistanceKm` into an estimated foot-distance using a single `FOOT_FACTOR = 1.12` (typical Dartmoor terrain factor over straight-line). The Distance tile, Steps tile, and Hike avg pace all derive from the same foot km so the moving stats agree.

## Coordinates

`scripts/lib/checkpoint-coords.json` holds slug-keyed coordinates with a `source` per entry (approx WGS84 from OS Explorer OL28 reads). Distances are great-circle Haversine between consecutive checkpoints — reliable for relative pacing and visualisation, a few percent shorter than the actual walked distance. Each segment carries `valueSource: "calculated"`.

A handful of elevations were cross-checked against published OS heights and corrected (`start`/`finish` to 340 m, `higher-tor` to 462 m, `watern-tor` to 524 m, `white-barrow` to 466 m).

## Pages

`site/index.html` and `site/index2.html` are two variants sharing the same `app.js`, `styles.css` and `data.json`. They differ only in the hero background image.

## Images

`site/images/<slug>.{webp,jpg,svg}` is preferred. A missing image renders an inline SVG fallback containing the checkpoint name. The updater does not download images unless `FORCE_IMAGE_REFRESH=true` and a referenced image is missing.

## Schedule and event window

The 5-minute cron is **paused** (commented out) post-event. Re-enable in `.github/workflows/update-route-i.yml` for the next expedition weekend.
