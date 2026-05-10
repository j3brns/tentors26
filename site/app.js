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

function appVersion() {
  const m = document.querySelector('meta[name="app-version"]');
  return (m?.getAttribute('content') || 'v0.0.0').replace(/^v?/, 'v');
}

function renderHero(data) {
  const gen = data.generatedAt ? new Date(data.generatedAt) : null;
  const buildChip = $('buildChip');
  if (buildChip) {
    if (gen && !Number.isNaN(gen.getTime())) {
      const d = gen.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      const t = gen.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      buildChip.textContent = `${appVersion()} · ${d} · ${t}`;
      buildChip.title = `App ${appVersion()} · snapshot generated ${gen.toISOString()}`;
    } else {
      buildChip.textContent = appVersion();
    }
  }
}

function renderTiles(data) {
  $('tileReached').textContent = `${data.reachedCount}/${data.totalCheckpoints}`;
  $('tileProgress').textContent = fmtPct(data.routeProgressPercent);
  $('tilePosition').textContent = fmtPos(data.comparator?.overallPosition);
  const total = data.comparator?.totalTeamsOnRoute;
  const dnf = data.comparator?.dnfCount;
  if ($('tilePositionSub')) {
    const parts = [];
    if (total != null) parts.push(`of ${total}`);
    if (dnf != null && dnf > 0) parts.push(`${dnf} DNF`);
    $('tilePositionSub').textContent = parts.join(' · ') || '—';
  }

  const eta = data.eta;
  const finished = !data.nextCheckpoint && data.reachedCount === data.totalCheckpoints && data.reachedCount > 0;
  const rm = data.routeMetrics || {};
  if (finished) {
    // Race over: repurpose ETA tiles to show post-race stats.
    const elapsedMin = data.elapsedRunning?.minutes || 0;
    const distKm = rm.totalDistanceKm;
    const overallPace = (distKm && elapsedMin) ? (elapsedMin / distKm) : null;
    const kmh = (distKm && elapsedMin) ? (distKm / (elapsedMin / 60)) : null;
    const miles = distKm != null ? distKm * 0.621371 : null;

    setTileLabel('etaNext', 'Steps');
    $('etaNext').textContent = rm.totalEstimatedSteps != null ? rm.totalEstimatedSteps.toLocaleString('en-GB') : '—';
    $('etaNextSub').textContent = rm.strideLengthMetres ? `@ ${rm.strideLengthMetres} m stride` : '';

    setTileLabel('etaFinish', 'Ascent');
    $('etaFinish').textContent = rm.cumulativeAscentMetres != null ? `${rm.cumulativeAscentMetres} m` : '—';
    $('etaFinishSub').textContent = rm.cumulativeDescentMetres != null ? `↓ ${rm.cumulativeDescentMetres} m descent` : '';

    $('tilePace').textContent = overallPace != null ? overallPace.toFixed(1) : '—';
    setTileSubByLabel('tilePace', 'Pace', kmh != null ? `min/km · ${kmh.toFixed(1)} km/h` : 'min / km');

    $('tileDistance').textContent = distKm != null ? fmtKm(distKm) : '—';
    $('tileDistanceSub').textContent = miles != null ? `${miles.toFixed(1)} mi · 45-mi class` : '—';
  } else {
    $('etaNext').textContent = eta?.etaNext || '—';
    $('etaNextSub').textContent = eta?.minutesToNext != null ? `+${eta.minutesToNext} min · ${data.nextCheckpoint?.name || ''}` : '—';
    $('etaFinish').textContent = eta?.etaFinish || '—';
    $('etaFinishSub').textContent = eta?.minutesToFinish != null ? `+${Math.floor(eta.minutesToFinish / 60)}h ${String(eta.minutesToFinish % 60).padStart(2,'0')}m` : '—';
    $('tilePace').textContent = eta?.paceMinPerKm != null ? eta.paceMinPerKm.toFixed(1) : '—';
    $('tileDistance').textContent = eta?.coveredKm != null ? fmtKm(eta.coveredKm) : '—';
    $('tileDistanceSub').textContent = eta?.remainingKm != null ? `${fmtKm(eta.remainingKm)} remaining` : '—';
  }
}

function setTileLabel(valueId, label) {
  const valueEl = $(valueId);
  if (!valueEl) return;
  const tile = valueEl.closest('.tile');
  const labelEl = tile?.querySelector('.tile-label');
  if (labelEl) labelEl.textContent = label;
}
function setTileSubByLabel(valueId, _label, subText) {
  const valueEl = $(valueId);
  const tile = valueEl?.closest('.tile');
  const sub = tile?.querySelector('.tile-sub');
  if (sub) sub.textContent = subText;
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

function makeTerminusIcon(letter, label, reached) {
  return L.divIcon({
    className: '',
    html: `<div class="cp-terminus ${reached ? 'reached' : ''}" aria-label="${label}">${letter}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
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
    const isStart = cp.slug === 'start' || cp.index === 0;
    const isFinish = cp.slug === 'finish' || cp.index === data.checkpoints.length - 1;
    let icon;
    if ((isStart || isFinish) && !isCur && !isNext) {
      icon = makeTerminusIcon(isStart ? 'S' : 'F', cp.name, cp.reached);
    } else {
      const cls = isCur ? 'current' : isNext ? 'next' : (cp.reached ? 'reached' : 'upcoming');
      icon = makeDivIcon(cls, cp.name);
    }
    const mk = L.marker([cp.coordinates.lat, cp.coordinates.lon], {
      icon, keyboard: true, title: cp.name, alt: cp.name,
      zIndexOffset: isStart || isFinish ? 100 : 0,
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
      <span class="label">${cp.name.replace(/\s*\(VIA\)\s*/i, '')}${/\(VIA\)/i.test(cp.name) ? '<sup>v</sup>' : ''}</span>
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

function fmtSignedMin(m) {
  if (m == null) return '—';
  return (m > 0 ? '+' : '') + m + 'm';
}
function fmtHm(min) {
  if (min == null) return '—';
  const sign = min < 0 ? '−' : '';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60), m = abs % 60;
  return `${sign}${h}h ${String(m).padStart(2,'0')}m`;
}

function renderInsights(data) {
  const cps = data.checkpoints || [];
  const stats = data.comparator?.checkpointStats || {};
  // Hiking time
  const totalMin = data.elapsedRunning?.minutes;
  if ($('insHiking')) $('insHiking').textContent = totalMin != null ? `${fmtHm(totalMin)} <span class="ins-sub">walking only</span>` : '—';
  if ($('insHiking') && totalMin != null) $('insHiking').innerHTML = `${fmtHm(totalMin)}<span class="ins-sub">walking only</span>`;

  // Day 1 / Day 2 split: find checkpoint where day rolls over (overnight gap).
  // Heuristic: any reached cp whose elapsed jumps by ~12h+ vs the previous reached
  // marks the overnight wake; first such cp is the day-2 anchor.
  let dayBoundaryIdx = -1;
  let prev = null;
  for (let i = 0; i < cps.length; i++) {
    const e = cps[i].elapsed?.minutes;
    if (e == null) continue;
    if (prev != null && e - prev >= 30) { dayBoundaryIdx = i; break; }
    prev = e;
  }
  let day1Min = null, day2Min = null;
  if (dayBoundaryIdx > 0) {
    day1Min = cps[dayBoundaryIdx - 1].elapsed?.minutes;
    const lastReached = [...cps].reverse().find(c => c.elapsed?.minutes != null);
    if (lastReached) day2Min = lastReached.elapsed.minutes - cps[dayBoundaryIdx - 1].elapsed.minutes;
  }
  if ($('insDay1')) $('insDay1').innerHTML = day1Min != null ? `${fmtHm(day1Min)}<span class="ins-sub">to camp</span>` : '—';
  if ($('insDay2')) $('insDay2').innerHTML = day2Min != null ? `${fmtHm(day2Min)}<span class="ins-sub">camp → finish</span>` : '—';

  // Climb rate (m of ascent per hour walked)
  const ascent = data.routeMetrics?.cumulativeAscentMetres;
  if ($('insClimb')) $('insClimb').innerHTML = (ascent != null && totalMin) ? `${Math.round(ascent / (totalMin / 60))} m/h<span class="ins-sub">${ascent} m total ascent</span>` : '—';

  // Best / worst leg vs comparator mean.
  let bestLeg = null, worstLeg = null;
  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i];
    const s = stats[cp.slug];
    if (!s || s.ifVsMean == null) continue;
    if (bestLeg == null || s.ifVsMean < bestLeg.delta) bestLeg = { name: cp.name, delta: s.ifVsMean };
    if (worstLeg == null || s.ifVsMean > worstLeg.delta) worstLeg = { name: cp.name, delta: s.ifVsMean };
  }
  if ($('insBestLeg')) {
    if (bestLeg) {
      $('insBestLeg').innerHTML = `${fmtSignedMin(bestLeg.delta)}<span class="ins-sub">${bestLeg.name}</span>`;
      $('insBestLeg').className = bestLeg.delta < 0 ? 'fast' : '';
    } else $('insBestLeg').textContent = '—';
  }
  if ($('insWorstLeg')) {
    if (worstLeg) {
      $('insWorstLeg').innerHTML = `${fmtSignedMin(worstLeg.delta)}<span class="ins-sub">${worstLeg.name}</span>`;
      $('insWorstLeg').className = worstLeg.delta > 0 ? 'slow' : '';
    } else $('insWorstLeg').textContent = '—';
  }

  // Position percentile across teams (lower position = higher percentile)
  const pos = data.comparator?.overallPosition;
  const tot = data.comparator?.totalTeamsOnRoute;
  if ($('insPercentile')) {
    if (pos && tot) {
      const pct = Math.round((1 - (pos - 1) / tot) * 100);
      $('insPercentile').innerHTML = `${pct}th pct<span class="ins-sub">#${pos} of ${tot}</span>`;
    } else $('insPercentile').textContent = '—';
  }

  // Pace consistency: stddev of per-leg pace (min/km)
  const legPaces = [];
  for (let i = 1; i < cps.length; i++) {
    const seg = cps[i].segmentFromPrevious;
    const s = stats[cps[i].slug];
    const split = s?.ifSplitMinutes;
    if (seg?.distanceKm > 0 && split != null && split > 0) {
      legPaces.push(split / seg.distanceKm);
    }
  }
  if ($('insConsistency')) {
    if (legPaces.length >= 3) {
      const mean = legPaces.reduce((a,b)=>a+b,0) / legPaces.length;
      const variance = legPaces.reduce((a,b)=>a+(b-mean)**2,0) / legPaces.length;
      const stddev = Math.sqrt(variance);
      const cv = (stddev / mean) * 100;
      $('insConsistency').innerHTML = `±${stddev.toFixed(1)} min/km<span class="ins-sub">${cv.toFixed(0)}% CV across ${legPaces.length} legs</span>`;
    } else $('insConsistency').textContent = '—';
  }

  // Negative split: day-2 pace vs day-1 pace.
  if ($('insNegSplit')) {
    if (day1Min != null && day2Min != null && dayBoundaryIdx > 0) {
      let d1Km = 0, d2Km = 0;
      for (let i = 1; i < dayBoundaryIdx; i++) d1Km += cps[i].segmentFromPrevious?.distanceKm || 0;
      for (let i = dayBoundaryIdx; i < cps.length; i++) {
        if (cps[i].elapsed?.minutes != null) d2Km += cps[i].segmentFromPrevious?.distanceKm || 0;
      }
      const p1 = d1Km > 0 ? day1Min / d1Km : null;
      const p2 = d2Km > 0 ? day2Min / d2Km : null;
      if (p1 != null && p2 != null) {
        const delta = p2 - p1;
        const cls = delta < 0 ? 'fast' : 'slow';
        const verdict = delta < 0 ? 'day 2 faster' : 'day 1 faster';
        $('insNegSplit').innerHTML = `${(delta < 0 ? '' : '+')}${delta.toFixed(1)} min/km<span class="ins-sub">${verdict}</span>`;
        $('insNegSplit').className = cls;
      } else $('insNegSplit').textContent = '—';
    } else $('insNegSplit').textContent = '—';
  }
}

function setupInfoPopovers() {
  const btn = document.getElementById('distanceInfoBtn');
  const pop = document.getElementById('distanceInfoPop');
  if (!btn || !pop || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  const toggle = (e) => { e?.stopPropagation(); pop.hidden = !pop.hidden; };
  btn.addEventListener('click', toggle);
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });
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
  renderInsights(data);
  setupInfoPopovers();
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
