"use strict";

const POLL_MS = 60_000;
const DATA_URL = './data.json';
const HISTORY_URL = './history.json';

const $ = (id) => document.getElementById(id);
const fmtPct = (n) => (n == null ? '—' : `${n}%`);
const fmtPos = (n) => (n == null ? '—' : `#${n}`);
const fmtKm = (n) => (n == null ? '—' : `${n.toFixed(1)} km`);

let lastData = null;
let lastHistory = null;
let map = null;
let mapLayers = { route: null, reached: null, markers: [] };

async function fetchJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function setBanner(msg) {
  const b = $('banner');
  if (!msg) { b.hidden = true; b.textContent = ''; return; }
  b.hidden = false; b.textContent = msg;
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
  const gen = data.generatedAt ? new Date(data.generatedAt) : null;
  if (gen && !Number.isNaN(gen.getTime())) {
    const d = gen.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const t = gen.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    $('dateChip').textContent = `${d} · ${t}`;
    $('dateChip').title = `Snapshot generated ${gen.toISOString()}`;
  }
}

function renderTiles(data) {
  $('tileReached').textContent = `${data.reachedCount}/${data.totalCheckpoints}`;
  $('tileProgress').textContent = fmtPct(data.routeProgressPercent);
  $('tilePosition').textContent = fmtPos(data.comparator?.overallPosition);
  $('tileElapsed').textContent = data.elapsedRunning?.label || '—';

  const eta = data.eta;
  $('etaNext').textContent = eta?.etaNext || '—';
  $('etaNextSub').textContent = eta?.minutesToNext != null ? `+${eta.minutesToNext} min · ${data.nextCheckpoint?.name || ''}` : '—';
  $('etaFinish').textContent = eta?.etaFinish || '—';
  $('etaFinishSub').textContent = eta?.minutesToFinish != null ? `+${Math.floor(eta.minutesToFinish / 60)}h ${String(eta.minutesToFinish % 60).padStart(2,'0')}m` : '—';
  $('tilePace').textContent = eta?.paceMinPerKm != null ? eta.paceMinPerKm.toFixed(1) : '—';
  $('tileDistance').textContent = eta?.coveredKm != null ? fmtKm(eta.coveredKm) : '—';
  $('tileDistanceSub').textContent = eta?.remainingKm != null ? `${fmtKm(eta.remainingKm)} remaining` : '—';
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

function ensureMap() {
  if (map) return map;
  if (typeof L === 'undefined') return null;
  map = L.map('routeMap', {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,
  }).setView([50.65, -3.99], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  return map;
}

function makeDivIcon(cls, label) {
  return L.divIcon({
    className: '',
    html: `<div class="cp-marker ${cls}" aria-label="${label}"></div>`,
    iconSize: cls === 'current' ? [20, 20] : cls === 'next' ? [16, 16] : [14, 14],
    iconAnchor: cls === 'current' ? [10, 10] : cls === 'next' ? [8, 8] : [7, 7],
  });
}

function renderMap(data) {
  const m = ensureMap();
  if (!m) return;
  const cps = data.checkpoints.filter(c => c.coordinates);
  if (cps.length < 2) return;

  // clear previous layers
  if (mapLayers.route) m.removeLayer(mapLayers.route);
  if (mapLayers.reached) m.removeLayer(mapLayers.reached);
  for (const mk of mapLayers.markers) m.removeLayer(mk);
  mapLayers.markers = [];

  const all = cps.map(c => [c.coordinates.lat, c.coordinates.lon]);
  const reachedPts = cps.filter(c => c.reached).map(c => [c.coordinates.lat, c.coordinates.lon]);

  mapLayers.route = L.polyline(all, { color: '#6b7794', weight: 3, opacity: 0.6, dashArray: '4 4' }).addTo(m);
  if (reachedPts.length >= 2) {
    mapLayers.reached = L.polyline(reachedPts, { color: '#4ade80', weight: 4, opacity: 0.95 }).addTo(m);
  }

  for (const cp of cps) {
    const isCur = data.currentCheckpoint?.slug === cp.slug;
    const isNext = data.nextCheckpoint?.slug === cp.slug;
    const cls = isCur ? 'current' : isNext ? 'next' : (cp.reached ? 'reached' : 'upcoming');
    const mk = L.marker([cp.coordinates.lat, cp.coordinates.lon], {
      icon: makeDivIcon(cls, cp.name),
      keyboard: true, title: cp.name, alt: cp.name,
    }).addTo(m);
    mk.bindPopup(`<strong>${cp.name}</strong><br/>${cp.arrivalTime ? 'Arrived ' + cp.arrivalTime : 'Pending'}${cp.elevationMetres != null ? '<br/>' + cp.elevationMetres + ' m' : ''}`);
    mapLayers.markers.push(mk);
  }

  m.fitBounds(L.latLngBounds(all), { padding: [20, 20] });
}

function renderPaceBars(data) {
  const host = $('paceBars');
  const cps = data.checkpoints;
  const stats = data.comparator?.checkpointStats || {};
  const rows = [];
  let maxAbs = 0;
  for (let i = 1; i < cps.length; i++) {
    const s = stats[cps[i].slug];
    if (!s) continue;
    if (s.ifVsMean != null) maxAbs = Math.max(maxAbs, Math.abs(s.ifVsMean));
  }
  if (maxAbs < 5) maxAbs = 5;

  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i];
    const s = stats[cp.slug] || {};
    const reached = cp.reached;
    const vs = s.ifVsMean;
    let fill = '';
    if (vs != null) {
      const pct = Math.min(50, (Math.abs(vs) / maxAbs) * 50);
      const cls = vs < 0 ? 'fast' : 'slow';
      fill = `<span class="fill ${cls}" style="width:${pct}%"></span>`;
    }
    const deltaTxt = vs == null ? '—' : (vs > 0 ? `+${vs}` : `${vs}`);
    const deltaCls = vs == null ? '' : (vs < 0 ? 'fast' : (vs > 0 ? 'slow' : ''));
    rows.push(`<div class="pace-row ${reached ? '' : 'upcoming'}">
      <span class="label">${cp.name}</span>
      <div class="bar">${fill}</div>
      <span class="delta ${deltaCls}">${deltaTxt}m</span>
    </div>`);
  }
  host.innerHTML = rows.join('') || '<p class="muted">No comparator data yet.</p>';
}

function renderElevation(data) {
  const svg = $('elevChart');
  const cps = data.checkpoints.filter(c => c.elevationMetres != null);
  if (cps.length < 2) { svg.innerHTML = ''; $('elevSummary').textContent = 'No elevation data yet.'; return; }

  let cumKm = 0;
  const points = cps.map((c, i) => {
    if (i > 0) cumKm += (c.segmentFromPrevious?.distanceKm || 0);
    return { x: cumKm, y: c.elevationMetres, cp: c };
  });
  const W = 360, H = 160, P = 24;
  const maxX = points[points.length - 1].x || 1;
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const spanY = Math.max(20, maxY - minY);

  const projX = (x) => P + (x / maxX) * (W - 2 * P);
  const projY = (y) => P + (1 - (y - minY) / spanY) * (H - 2 * P);

  const linePts = points.map(p => `${projX(p.x).toFixed(1)},${projY(p.y).toFixed(1)}`);
  const fillD = `M ${P},${H - P} L ${linePts.join(' L ')} L ${(W - P).toFixed(1)},${H - P} Z`;
  const lineD = `M ${linePts.join(' L ')}`;

  const cur = data.currentCheckpoint;
  let curMark = '';
  if (cur) {
    const idx = points.findIndex(p => p.cp.slug === cur.slug);
    if (idx >= 0) {
      const p = points[idx];
      curMark = `<line x1="${projX(p.x).toFixed(1)}" y1="${P}" x2="${projX(p.x).toFixed(1)}" y2="${H - P}" stroke="#f59e0b" stroke-width="1" stroke-dasharray="2 2"/>
        <circle cx="${projX(p.x).toFixed(1)}" cy="${projY(p.y).toFixed(1)}" r="5" fill="#f59e0b"/>`;
    }
  }
  // axis labels
  const yTop = `<text x="4" y="${(P + 4).toFixed(0)}" fill="#7e8aa6" font-size="10">${maxY} m</text>`;
  const yBot = `<text x="4" y="${(H - P + 4).toFixed(0)}" fill="#7e8aa6" font-size="10">${minY} m</text>`;
  const xRight = `<text x="${(W - P).toFixed(0)}" y="${(H - 6).toFixed(0)}" fill="#7e8aa6" font-size="10" text-anchor="end">${maxX.toFixed(1)} km</text>`;
  const xLeft = `<text x="${P.toFixed(0)}" y="${(H - 6).toFixed(0)}" fill="#7e8aa6" font-size="10">0</text>`;

  svg.innerHTML = `
    <defs><linearGradient id="elevGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#60a5fa" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#60a5fa" stop-opacity="0.02"/>
    </linearGradient></defs>
    <path d="${fillD}" fill="url(#elevGrad)"/>
    <path d="${lineD}" stroke="#60a5fa" stroke-width="2" fill="none"/>
    ${curMark}
    ${yTop}${yBot}${xLeft}${xRight}
  `;
  const rm = data.routeMetrics || {};
  $('elevSummary').textContent = `${rm.totalDistanceKm ?? '—'} km · +${rm.cumulativeAscentMetres ?? '—'} m ascent · −${rm.cumulativeDescentMetres ?? '—'} m descent`;
}

function renderPosition(history) {
  const sec = $('positionSection');
  const entries = (history?.entries || []).filter(e => e.overallPosition != null);
  if (entries.length < 2) { sec.hidden = true; return; }
  sec.hidden = false;

  const positions = entries.map(e => e.overallPosition);
  const min = Math.min(...positions), max = Math.max(...positions);
  const W = 360, H = 180, P = 28;
  const span = Math.max(1, max - min);
  const xs = positions.map((_, i) => P + (i / (positions.length - 1)) * (W - 2 * P));
  // Inverted Y: lower position number = better, drawn higher.
  const ys = positions.map(p => P + ((p - min) / span) * (H - 2 * P));

  const linePts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const fillD = `M ${P},${H - P} L ${linePts.replace(/ /g, ' L ')} L ${(W - P).toFixed(1)},${H - P} Z`;

  const ticks = 4;
  let yLabels = '';
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round(min + (span * i) / ticks);
    const y = P + (i / ticks) * (H - 2 * P);
    yLabels += `<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}" stroke="#243352" stroke-width="0.5"/>
      <text x="4" y="${y + 3}" fill="#7e8aa6" font-size="10">#${v}</text>`;
  }

  $('positionChart').innerHTML = `
    ${yLabels}
    <path d="${fillD}" fill="rgba(96,165,250,0.12)"/>
    <polyline points="${linePts}" stroke="#60a5fa" stroke-width="2" fill="none"/>
    <circle cx="${xs[xs.length - 1].toFixed(1)}" cy="${ys[ys.length - 1].toFixed(1)}" r="4" fill="#f59e0b"/>
  `;
  const now = positions[positions.length - 1];
  const first = positions[0];
  const delta = first - now;
  $('posNow').textContent = fmtPos(now);
  $('posDelta').textContent = (delta > 0 ? `+${delta}` : String(delta));
  $('posBest').textContent = fmtPos(min);
  $('posWorst').textContent = fmtPos(max);
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
  renderPaceBars(data);
  renderElevation(data);
  renderPosition(history);
  renderTimeline(data);
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
