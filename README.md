# Ten Tors 2026 — Route I dashboard (team IF)

Live, mobile-first dashboard for **Polar Explorer Scouts (IF)** on Route I of
the 2026 Ten Tors expedition (9–10 May 2026). Data is scraped server-side by
GitHub Actions and published as static JSON; the browser only fetches local
files.

Public URL pattern: `https://<owner>.github.io/<repo>/`

## How it works

- `scripts/update-route-i-data.mjs` fetches
  <https://www.tentors.org.uk/eventdata/routei.html>, parses it with
  `cheerio`, computes per-checkpoint and comparator metrics, and writes
  `site/data.json` and `site/history.json`.
- `.github/workflows/update-route-i.yml` runs the updater every 5 minutes
  during the event window (also via `workflow_dispatch` and
  `repository_dispatch`). It commits **only when JSON content actually
  changed**.
- GitHub Pages serves the `/site` directory of `main`. The browser polls
  `./data.json` and `./history.json` every 60 seconds with a cache-busting
  query string.

No third-party scripts, no analytics, no client-side scraping.

## GitHub Pages settings

- Settings → Pages → **Source: Deploy from a branch**
- Branch: **`main`**, folder: **`/site`**
- Custom domain: optional, none required.

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
| `STRIDE_METRES`      | `0.76`                   | Stride length used to estimate steps from distance. Source: typical adolescent walking stride on rough ground (range 0.65–0.85 m). |
| `LOCAL_FIXTURE`      | unset                    | Read HTML from a local path instead of the live URL. |

## Triggering an update manually

**Workflow dispatch** (Actions tab → "Update Route I data" → Run workflow).

**Repository dispatch** via the API:

```bash
curl -X POST \
  -H "Authorization: Bearer <PAT_WITH_REPO_SCOPE>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"ten-tors-route-i-update"}'
```

## Data contract

See the schema documentation in [SPEC.md-equivalent comments inside
`scripts/update-route-i-data.mjs`]. Headline fields:

- `data.json` carries the current snapshot (`schemaVersion: 1`).
- `history.json` appends one entry per genuine change of the team's row
  (hashed) or `sourceLastUpdated`. Capped at **500 entries** with FIFO
  eviction; the cap is set in the updater (`HISTORY_CAP`).

Missing values are returned as `null` with a sibling `reason` or `valueSource`
field where applicable. The updater never invents data; if parsing fails it
writes a `warnings` array and falls back to a labelled checkpoint list (each
fallback checkpoint has `fallback: true`).

## Coordinates

`scripts/lib/checkpoint-coords.json` holds slug-keyed coordinates with a
`source` per entry (Ordnance Survey OL28 / OpenStreetMap). Distances are
great-circle Haversine between consecutive checkpoints, so they are reliable
for relative pacing but a few percent shorter than the actual walked
distance. Each segment carries `valueSource: "calculated"`.

## Images

`site/images/<slug>.{webp,jpg,svg}` is preferred. A missing image renders
an inline SVG fallback containing the checkpoint name. The updater does not
download images unless `FORCE_IMAGE_REFRESH=true` and a referenced image is
missing.

## Schedule and event window

The 5-minute cron runs continuously while committed; comment out the
`schedule` block in `.github/workflows/update-route-i.yml` outside the
expedition weekend to avoid pointless commits.

## Verification checklist

The verification checklist is the single source of truth for "done". Run
through it before declaring the dashboard ready.
