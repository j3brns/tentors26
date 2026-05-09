"use strict";

const POLL_MS = 60_000;
const DATA_URL = './data.json';
const HISTORY_URL = './history.json';

const $ = (id) => document.getElementById(id);
const fmtPct = (n) => (n == null ? '—' : `${n}%`);
const fmtPos = (n) => (n == null ? '—' : `#${n}`);
const fmtNum = (n) => (n == null ? '—' : String(n));

let lastData = null;
let lastHistory = null;

async function fetchJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function setBanner(msg) {
  const b = $('banner');
  if (!msg) { b.hidden = true; b.textContent = ''; return; }
  b.hidden = false;
  b.textContent = msg;
}

function renderWarnings(warnings) {
  const box = $('warnings');
  if (!warnings || warnings.length === 0) { box.hidden = true; box.innerHTML = ''; return; }
  const items = warnings.map(w => `<li><strong>${w.code || w.level || 'warn'}:</strong> ${w.message || ''}</li>`).join('');
  box.hidden = false;
  box.innerHTML = `<strong>Data warnings</strong><ul>${items}</ul>`;
}

function renderHero(data) {
  $('sourceUpdated').textContent = data.sourceLastUpdated || '—';
  $('lastChecked').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderTiles(data) {
  $('tileReached').textContent = `${data.reachedCount}/${data.totalCheckpoints}`;
  $('tileProgress').textContent = fmtPct(data.routeProgressPercent);
  $('tilePosition').textContent = fmtPos(data.comparator?.overallPosition);
  $('tileElapsed').textContent = data.elapsedRunning?.label || '—';
}

function renderCurrent(data) {
  const el = $('currentCheckpoint');
  const cur = data.currentCheckpoint;
  if (!cur) { el.innerHTML = '<span class="muted">No checkpoints reached yet.</span>'; return; }
  const img = cur.localImageUrl
    ? `<img class="cp-img" alt="" src="${cur.localImageUrl}" />`
    : `<div class="cp-img" aria-hidden="true"></div>`;
  el.innerHTML = `
    ${img}
    <div>
      <div class="cp-name">${cur.name}</div>
      <div class="cp-time">Arrived ${cur.arrivalTime || '—'} · ${cur.elapsed?.label || '—'} elapsed</div>
      <div class="cp-meta">#${cur.index + 1} of ${data.totalCheckpoints} · ${fmtPct(cur.progressPercent)}</div>
    </div>`;
}

function renderTimeline(data) {
  const ol = $('timeline');
  const curIdx = data.currentCheckpointIndex;
  const nextIdx = (curIdx != null ? curIdx + 1 : 0);
  ol.innerHTML = data.checkpoints.map((cp, i) => {
    let cls = 'upcoming';
    if (cp.reached) cls = i === curIdx ? 'current reached' : 'reached';
    else if (i === nextIdx) cls = 'next';
    return `<li class="${cls}"><span class="pip" aria-hidden="true"></span><span class="name">${cp.name}</span><span class="t">${cp.arrivalTime || '—'}</span></li>`;
  }).join('');
}

function renderMap(data) {
  const svg = $('routeMap');
  const cps = data.checkpoints.filter(c => c.coordinates);
  if (cps.length < 2) { svg.innerHTML = '<text x="180" y="120" fill="#7e8aa6" text-anchor="middle" font-size="12">No coordinates available</text>'; return; }
  const lats = cps.map(c => c.coordinates.lat);
  const lons = cps.map(c => c.coordinates.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const W = 360, H = 240, P = 18;
  const dLat = Math.max(0.001, maxLat - minLat);
  const dLon = Math.max(0.001, maxLon - minLon);
  // Equirectangular with cosine compensation.
  const meanLat = (minLat + maxLat) / 2;
  const cosL = Math.cos(meanLat * Math.PI / 180);
  const aspect = (dLon * cosL) / dLat;
  let drawW = W - 2 * P, drawH = H - 2 * P;
  if (aspect > drawW / drawH) drawH = drawW / aspect; else drawW = drawH * aspect;
  const offX = (W - drawW) / 2, offY = (H - drawH) / 2;
  const project = (lat, lon) => {
    const x = offX + ((lon - minLon) / dLon) * drawW;
    const y = offY + (1 - (lat - minLat) / dLat) * drawH;
    return [x, y];
  };
  const points = cps.map(c => project(c.coordinates.lat, c.coordinates.lon));
  const curIdx = data.currentCheckpointIndex;
  const reachedSlugs = new Set(data.checkpoints.filter(c => c.reached).map(c => c.slug));
  const reachedPath = points.filter((_, i) => reachedSlugs.has(cps[i].slug));
  const fullD = 'M' + points.map(p => p.join(',')).join(' L');
  const reachedD = reachedPath.length >= 2 ? 'M' + reachedPath.map(p => p.join(',')).join(' L') : '';

  let markers = '';
  for (let i = 0; i < cps.length; i++) {
    const [x, y] = points[i];
    const cp = cps[i];
    const isCur = data.currentCheckpoint?.slug === cp.slug;
    const isNext = data.nextCheckpoint?.slug === cp.slug;
    const cls = isCur ? 'current' : isNext ? 'next' : (cp.reached ? 'reached' : 'upcoming');
    const r = isCur ? 6 : isNext ? 5 : 3.5;
    const fill = { reached: '#4ade80', current: '#f59e0b', next: '#60a5fa', upcoming: '#6b7794' }[cls];
    markers += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" aria-label="${cp.name}${isCur ? ' (current)' : isNext ? ' (next)' : ''}"><title>${cp.name}${cp.arrivalTime ? ' · ' + cp.arrivalTime : ''}</title></circle>`;
    if (isCur) {
      markers += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="none" stroke="#f59e0b" stroke-opacity="0.4"><animate attributeName="r" values="6;14;6" dur="2.4s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="2.4s" repeatCount="indefinite"/></circle>`;
    }
  }

  svg.innerHTML = `
    <path d="${fullD}" stroke="#3b4a72" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${reachedD ? `<path d="${reachedD}" stroke="#4ade80" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    ${markers}
  `;
}

function renderPosition(history, data) {
  const sec = $('positionSection');
  const entries = (history?.entries || []).filter(e => e.overallPosition != null);
  if (entries.length < 2) { sec.hidden = true; return; }
  sec.hidden = false;
  const positions = entries.map(e => e.overallPosition);
  const min = Math.min(...positions), max = Math.max(...positions);
  const W = 320, H = 80, P = 6;
  const span = Math.max(1, max - min);
  const xs = positions.map((_, i) => P + (i / (positions.length - 1)) * (W - 2 * P));
  // Lower number = better, so invert Y so improvement goes up.
  const ys = positions.map(p => P + ((p - min) / span) * (H - 2 * P));
  const d = 'M' + xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' L');
  $('positionSpark').innerHTML = `
    <path d="${d}" stroke="#60a5fa" stroke-width="2" fill="none"/>
    <circle cx="${xs[xs.length - 1].toFixed(1)}" cy="${ys[ys.length - 1].toFixed(1)}" r="3" fill="#f59e0b"/>
  `;
  const now = positions[positions.length - 1];
  const first = positions[0];
  const delta = first - now; // positive = improved (rank decreased)
  $('posNow').textContent = fmtPos(now);
  $('posDelta').textContent = (delta > 0 ? `+${delta}` : String(delta));
  $('posBest').textContent = fmtPos(min);
  $('posWorst').textContent = fmtPos(max);
}

function renderComparator(data) {
  const c = data.comparator || {};
  $('compSummary').textContent = `${c.comparableTeams || 0} comparable Route I teams · overall position ${c.overallPosition ? '#' + c.overallPosition : '—'}.`;
  const tbody = document.querySelector('#compTable tbody');
  const rows = data.checkpoints.map(cp => {
    const s = c.checkpointStats?.[cp.slug];
    if (!s) return '';
    const vsMean = s.ifVsMean;
    const vsCls = vsMean == null ? '' : (vsMean < 0 ? 'pos' : (vsMean > 0 ? 'neg' : ''));
    const vsTxt = vsMean == null ? '—' : (vsMean > 0 ? `+${vsMean}` : String(vsMean));
    return `<tr>
      <td>${cp.name}</td>
      <td>${s.ifSplitMinutes ?? '—'}</td>
      <td>${s.meanSplitMinutes ?? '—'}</td>
      <td>${s.fastestSplitMinutes ?? '—'}</td>
      <td class="${vsCls}">${vsTxt}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows || `<tr><td colspan="5" class="muted">No comparator data yet.</td></tr>`;
}

function fallbackImg(name) {
  const safe = (name || '').replace(/[<>&"]/g, '');
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 110'><rect width='320' height='110' fill='%23172240'/><text x='160' y='60' fill='%23aab6cf' font-family='sans-serif' font-size='16' text-anchor='middle'>${safe}</text></svg>`)}`;
}

function renderCheckpointGrid(data) {
  const grid = $('checkpointGrid');
  grid.innerHTML = data.checkpoints.map((cp, i) => {
    const cls = cp.reached ? (i === data.currentCheckpointIndex ? 'current' : 'reached') : '';
    const src = cp.localImageUrl || fallbackImg(cp.name);
    const seg = cp.segmentFromPrevious;
    const segTxt = seg ? `${seg.distanceKm ?? '—'} km · ${seg.estimatedSteps ? seg.estimatedSteps.toLocaleString('en-GB') + ' steps' : '—'}` : 'Start';
    return `<div class="cp-card ${cls}">
      <img class="img" alt="" src="${src}" loading="lazy" onerror="this.src='${fallbackImg(cp.name)}'" />
      <div class="body">
        <div class="row"><span class="name">${cp.name}</span><span class="arrival ${cp.arrivalTime ? '' : 'miss'}">${cp.arrivalTime || 'pending'}</span></div>
        <div class="meta">${segTxt}${cp.elevationMetres != null ? ` · ${cp.elevationMetres} m` : ''}</div>
      </div>
    </div>`;
  }).join('');
}

function renderAll(data, history) {
  renderWarnings(data.warnings);
  renderHero(data);
  renderTiles(data);
  renderMap(data);
  renderCurrent(data);
  renderTimeline(data);
  renderPosition(history, data);
  renderComparator(data);
  renderCheckpointGrid(data);
}

async function poll() {
  try {
    const [data, history] = await Promise.all([
      fetchJson(DATA_URL),
      fetchJson(HISTORY_URL).catch(() => null)
    ]);
    lastData = data;
    lastHistory = history;
    setBanner(null);
    renderAll(data, history);
  } catch (e) {
    const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    setBanner(`Update failed at ${t} — showing last known data.`);
    if (lastData) renderAll(lastData, lastHistory);
  }
}

poll();
setInterval(poll, POLL_MS);
