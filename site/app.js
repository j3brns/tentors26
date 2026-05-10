"use strict";

const POLL_MS = 60_000;
const DATA_URL = './data.json';
const HISTORY_URL = './history.json';
const HISTORICAL_URL = './fixtures/historical-35mi.json';

const $ = (id) => document.getElementById(id);
const fmtPct = (n) => (n == null ? '—' : `${n}%`);
const fmtPos = (n) => (n == null ? '—' : `#${n}`);
const fmtKm = (n) => (n == null ? '—' : `${n.toFixed(1)} km`);

// Strava-style grade-adjusted-pace cost curve, fit to the published GAP table.
// Returns the multiplier on flat-pace cost for a given signed grade fraction
// (e.g. +0.05 = +5% up, -0.05 = -5% down).
function gapMultiplier(grade) {
  // Polynomial fit. For typical Dartmoor grades (|g| <= 0.15) this is within ~2%
  // of Strava's published curve. Caps prevent extreme values at near-vertical
  // segments (which we won't see anyway).
  const g = Math.max(-0.30, Math.min(0.30, grade));
  // 4th-order polynomial: 1 + 3.5g + 28g² - 32g³ + 100g⁴ (lifted from public fits).
  // Asymmetric: downhills give a small boost up to about -10%, then cost climbs again.
  if (g >= 0) return 1 + 3.5 * g + 28 * g * g - 32 * g ** 3 + 100 * g ** 4;
  const a = -g; // downhill magnitude
  if (a <= 0.10) return 1 - 1.5 * a + 8 * a * a;
  return 1 - 0.05 + 6 * (a - 0.10) ** 2; // beyond -10% costs go back up
}

let lastData = null;
let lastHistory = null;
let lastHistorical = null;
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

  // GAP, hardest leg, effort total
  const legs = computeLegMetrics(data).filter(L => L && L.pace != null);
  if (legs.length > 0) {
    // Aggregate GAP: weighted by distance
    const totalDist = legs.reduce((a, L) => a + L.distKm, 0);
    const weightedGap = legs.reduce((a, L) => a + L.gapPace * L.distKm, 0) / totalDist;
    if ($('insGAP')) $('insGAP').innerHTML = `${weightedGap.toFixed(1)} min/km<span class="ins-sub">vs ${(legs.reduce((a,L)=>a+L.pace*L.distKm,0)/totalDist).toFixed(1)} raw</span>`;
    // Hardest leg by effort score
    const allEffort = computeLegMetrics(data).filter(Boolean);
    const hardest = [...allEffort].sort((a, b) => b.effort - a.effort)[0];
    if (hardest && $('insHardest')) $('insHardest').innerHTML = `${hardest.name}<span class="ins-sub">${hardest.distKm.toFixed(1)} km + ${hardest.ascent} m climb</span>`;
    const totalEffort = allEffort.reduce((a, L) => a + L.effort, 0);
    if ($('insEffort')) $('insEffort').innerHTML = `${Math.round(totalEffort)}<span class="ins-sub">km + ascent/10</span>`;
  }
}

// Explainer popover content keyed by data-info-key. Plain HTML strings.
const INFO_EXPLAINERS = {
  distance: `<strong>Haversine straight-line</strong> between consecutive checkpoint coordinates. Actual walked distance on Dartmoor is typically 10–15% greater (terrain, bog avoidance, navigation lines), so a 35-mi official route reads as ~40 mi straight-line.`,
  gap: `<strong>Grade-Adjusted Pace.</strong> Your raw pace for each leg is divided by a Strava-style cost multiplier that reflects how much harder the terrain made it: ~1.24 at +5% grade, 1.61 at +10%. The result is a flat-equivalent pace — what you would have walked on level ground at the same effort. The card-level GAP shown here is distance-weighted across all reached legs.`,
  effort: `<strong>Effort score = distance (km) + ascent (m) ÷ 10.</strong> A 100 m climb is treated as roughly equivalent to 1 km of flat walking. Lets us rank legs and full routes by combined exertion. The hardest leg shown above is the leg with the highest effort number.`,
  consistency: `<strong>Pace consistency.</strong> Standard deviation of per-leg pace (min/km) across all reached legs, with the coefficient of variation (CV = stddev ÷ mean) shown alongside. Lower numbers mean a steadier walker. Endurance coaches typically aim for CV under 15% on long-form events.`,
  negSplit: `<strong>Negative split.</strong> Day-2 average pace minus day-1 average pace (after the 11h overnight rest is stripped out). Negative means day 2 was faster — a marker of pacing discipline and recovery.`,
  percentile: `Where the team finished relative to all teams on this route. <strong>90th percentile</strong> means top 10%. Computed from final rank ÷ total teams.`,
  climb: `<strong>Climb rate</strong> = total ascent metres ÷ walking hours. Roughly comparable across routes regardless of distance — a useful "how hard was the up?" measure.`,
  hardest: `Leg with the highest <strong>effort score</strong> (distance + ascent/10). The headline number combines the leg's length and its uphill metres into one ranking.`,
  achievements: `Auto-derived from the data on this page. Criteria:<br/>🚀 Negative splitter — day-2 pace < day-1.<br/>⛰️ Hill killer — beat the comparator mean on at least half of the legs with grade ≥ +5%.<br/>🎯 Consistent — pace CV under 25%.<br/>⛺ Camp ninja — camp→Willsworthy split below comparator mean.<br/>🥇 Top half — final rank ≤ midpoint.<br/>🏁 All checkpoints — reached every checkpoint on the route.`,
  paceVsGrade: `Each row is a leg between checkpoints. The bar's <strong>length</strong> is your raw pace (min/km). The bar's <strong>colour</strong> tracks the leg's grade — cooler blue for downhill, amber to red as the climb steepens. The white tick marks <strong>GAP</strong>: where the bar would end if the same effort were applied on flat ground. A long bar with a tick far to the left = you were actually fast for the terrain.`,
  whatIf: `Sums comparator splits across all legs (mean and fastest), adds the start time and an 11h overnight, and projects the resulting wall-clock finish. Helpful for asking "if we matched the field" or "if we matched the leader on every leg".`,
  historical: `Hand-curated reference from past Ten Tors 35-mi events (Churcher's 2011/2013, Gordon's 2024). Walking minutes are computed by subtracting the 11h overnight from the wall-clock Sunday finish.`
};

function setupInfoPopovers() {
  const btns = document.querySelectorAll('.info-btn');
  const closeAll = () => document.querySelectorAll('.info-pop').forEach(p => p.hidden = true);
  for (const btn of btns) {
    if (btn.dataset.wired) continue;
    btn.dataset.wired = '1';
    const key = btn.dataset.infoKey;
    let pop = btn.nextElementSibling;
    if (!pop || !pop.classList.contains('info-pop')) {
      // Create on demand if HTML didn't include one inline.
      pop = document.createElement('div');
      pop.className = 'info-pop';
      pop.role = 'tooltip';
      pop.hidden = true;
      btn.parentNode.insertBefore(pop, btn.nextSibling);
    }
    if (key && INFO_EXPLAINERS[key] && !pop.dataset.populated) {
      pop.innerHTML = INFO_EXPLAINERS[key];
      pop.dataset.populated = '1';
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = pop.hidden;
      closeAll();
      if (wasHidden) pop.hidden = false;
    });
  }
  if (!document.body.dataset.popWired) {
    document.body.dataset.popWired = '1';
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  }
}

// Compute per-leg metrics: split minutes, distance, ascent/descent, grade, raw
// pace, GAP pace, effort score. Returns array aligned with checkpoints, with
// null entries where data is missing (e.g. start, or unreached).
function computeLegMetrics(data) {
  const cps = data.checkpoints || [];
  const stats = data.comparator?.checkpointStats || {};
  const out = new Array(cps.length).fill(null);
  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i];
    const seg = cp.segmentFromPrevious;
    const s = stats[cp.slug];
    const split = s?.ifSplitMinutes;
    if (!seg || seg.distanceKm == null) continue;
    const distKm = seg.distanceKm;
    const ascent = seg.ascentMetres || 0;
    const descent = seg.descentMetres || 0;
    const netRiseM = ascent - descent;
    const grade = distKm > 0 ? netRiseM / (distKm * 1000) : 0;
    const pace = (split != null && distKm > 0) ? split / distKm : null;
    const gapPace = pace != null ? pace / gapMultiplier(grade) : null;
    // Effort score: km + ascent / 10 (so 100 m of climb ≈ 1 km of distance).
    const effort = distKm + ascent / 10;
    out[i] = {
      name: cp.name,
      slug: cp.slug,
      reached: !!cp.reached,
      distKm,
      ascent,
      descent,
      grade,
      pace,
      gapPace,
      gapDelta: (pace != null && gapPace != null) ? (pace - gapPace) : null,
      effort,
      ifVsMean: s?.ifVsMean ?? null
    };
  }
  return out;
}

function renderGAPBars(data) {
  const host = $('gapBars');
  if (!host) return;
  const legs = computeLegMetrics(data);
  const reachedLegs = legs.filter(L => L && L.pace != null);
  if (reachedLegs.length === 0) { host.innerHTML = '<p class="muted">No pace data yet.</p>'; return; }
  const maxPace = Math.max(...reachedLegs.map(L => Math.max(L.pace, L.gapPace || 0)));
  const rows = [];
  for (let i = 1; i < legs.length; i++) {
    const L = legs[i];
    if (!L) continue;
    const label = data.checkpoints[i].name.replace(/\s*\(VIA\)\s*/i, '');
    const isVia = /\(VIA\)/i.test(data.checkpoints[i].name);
    if (L.pace == null) {
      rows.push(`<div class="gap-row upcoming"><span class="label">${label}${isVia ? '<sup>v</sup>' : ''}</span><div class="track"></div><span class="value">—</span></div>`);
      continue;
    }
    const pacePct = (L.pace / maxPace) * 100;
    const gapPct = (L.gapPace / maxPace) * 100;
    const gradeColor = gradeColour(L.grade);
    const grade = L.grade;
    const gradePill = `<span class="grade-pill" style="background:${gradeColor.bg};color:${gradeColor.fg}">${(grade * 100).toFixed(0)}%</span>`;
    rows.push(`<div class="gap-row">
      <span class="label">${label}${isVia ? '<sup>v</sup>' : ''}</span>
      <div class="track">
        <span class="pace-fill" style="width:${pacePct.toFixed(1)}%;background:${gradeColor.bg}"></span>
        <span class="gap-tick" style="left:${gapPct.toFixed(1)}%" title="GAP ${L.gapPace.toFixed(1)} min/km"></span>
      </div>
      <span class="value">${L.pace.toFixed(1)}${gradePill}</span>
    </div>`);
  }
  host.innerHTML = rows.join('');
}

function gradeColour(grade) {
  // grade is signed fraction. Map magnitude to colour intensity.
  const g = grade;
  const abs = Math.min(0.15, Math.abs(g));
  const t = abs / 0.15;
  if (g >= 0) {
    // uphill: green -> amber -> red as it gets steeper
    const r = Math.round(96 + (245 - 96) * t);
    const gC = Math.round(165 + (158 - 165) * t);
    const b = Math.round(250 + (11 - 250) * t);
    return { bg: `rgba(${r},${gC},${b},0.5)`, fg: '#fff' };
  } else {
    // downhill: cooler blue tint
    const r = Math.round(96 + (74 - 96) * t);
    const gC = Math.round(165 + (222 - 165) * t);
    const b = Math.round(250 + (128 - 250) * t);
    return { bg: `rgba(${r},${gC},${b},0.5)`, fg: '#fff' };
  }
}

function renderAchievements(data) {
  const host = $('achievements');
  if (!host) return;
  const legs = computeLegMetrics(data).filter(Boolean);
  const reachedLegs = legs.filter(L => L.pace != null);
  const badges = [];
  if (reachedLegs.length === 0) { host.innerHTML = ''; return; }

  // Negative split
  // (use the renderInsights computation by re-running here for self-containment)
  const cps = data.checkpoints || [];
  let dayBoundaryIdx = -1, prev = null;
  for (let i = 0; i < cps.length; i++) {
    const e = cps[i].elapsed?.minutes;
    if (e == null) continue;
    if (prev != null && e - prev >= 30) { dayBoundaryIdx = i; break; }
    prev = e;
  }
  if (dayBoundaryIdx > 0) {
    const day1End = cps[dayBoundaryIdx - 1].elapsed.minutes;
    const lastReached = [...cps].reverse().find(c => c.elapsed?.minutes != null);
    const day2 = lastReached ? lastReached.elapsed.minutes - day1End : null;
    let d1Km = 0, d2Km = 0;
    for (let i = 1; i < dayBoundaryIdx; i++) d1Km += cps[i].segmentFromPrevious?.distanceKm || 0;
    for (let i = dayBoundaryIdx; i < cps.length; i++) {
      if (cps[i].elapsed?.minutes != null) d2Km += cps[i].segmentFromPrevious?.distanceKm || 0;
    }
    if (day1End > 0 && day2 != null && d1Km > 0 && d2Km > 0) {
      const p1 = day1End / d1Km, p2 = day2 / d2Km;
      if (p2 < p1) badges.push({ emoji: '🚀', text: 'Negative splitter', cls: 'b-elite' });
    }
  }

  // Hill killer: top quartile on legs with grade >= +5%
  const climbingLegs = reachedLegs.filter(L => L.grade >= 0.05 && L.ifVsMean != null);
  if (climbingLegs.length >= 2) {
    const fasterCount = climbingLegs.filter(L => L.ifVsMean < 0).length;
    if (fasterCount / climbingLegs.length >= 0.5) badges.push({ emoji: '⛰️', text: 'Hill killer', cls: 'b-elite' });
  }

  // Consistent: CV < 25%
  const paces = reachedLegs.map(L => L.pace);
  if (paces.length >= 3) {
    const mean = paces.reduce((a,b)=>a+b,0) / paces.length;
    const variance = paces.reduce((a,b)=>a+(b-mean)**2,0) / paces.length;
    const stddev = Math.sqrt(variance);
    if ((stddev / mean) * 100 < 25) badges.push({ emoji: '🎯', text: 'Consistent', cls: '' });
  }

  // Camp ninja: Willsworthy split below comparator mean
  const willsworthy = reachedLegs.find(L => L.slug === 'willsworthy');
  if (willsworthy && willsworthy.ifVsMean != null && willsworthy.ifVsMean < 0) {
    badges.push({ emoji: '⛺', text: 'Camp ninja', cls: '' });
  }

  // Top quartile finish
  const pos = data.comparator?.overallPosition;
  const tot = data.comparator?.totalTeamsOnRoute;
  if (pos && tot && (pos / tot) <= 0.5) {
    badges.push({ emoji: '🥇', text: `Top half (#${pos} of ${tot})`, cls: 'b-elite' });
  }

  // Endurance: covered the full 64 km / 40 mi
  if (data.reachedCount === data.totalCheckpoints && data.totalCheckpoints > 0) {
    badges.push({ emoji: '🏁', text: 'All checkpoints', cls: '' });
  }

  host.innerHTML = badges.map(b => `<span class="badge ${b.cls}"><span class="emoji">${b.emoji}</span>${b.text}</span>`).join('');
}

function renderWhatIf(data) {
  const host = $('whatIf');
  if (!host) return;
  const cps = data.checkpoints || [];
  const stats = data.comparator?.checkpointStats || {};
  const elapsed = data.elapsedRunning?.minutes;
  if (!elapsed || data.reachedCount !== data.totalCheckpoints) { host.innerHTML = ''; return; }
  // Sum mean splits across all legs we have stats for.
  let totalMean = 0, totalFastest = 0, count = 0, fastCount = 0;
  for (let i = 1; i < cps.length; i++) {
    const s = stats[cps[i].slug];
    if (s?.meanSplitMinutes != null) { totalMean += s.meanSplitMinutes; count++; }
    if (s?.fastestSplitMinutes != null) { totalFastest += s.fastestSplitMinutes; fastCount++; }
  }
  const startMin = (() => {
    const m = String(cps[0]?.arrivalTime || '').match(/^(\d{2}):(\d{2})$/);
    return m ? +m[1] * 60 + +m[2] : null;
  })();
  const OVERNIGHT = 11 * 60;
  function projectFinish(walkingMin) {
    if (startMin == null) return null;
    const wallMin = (startMin + walkingMin + OVERNIGHT) % (24 * 60);
    return `${String(Math.floor(wallMin / 60)).padStart(2,'0')}:${String(wallMin % 60).padStart(2,'0')}`;
  }
  const lines = [];
  if (count >= 10 && totalMean > 0) {
    const delta = elapsed - totalMean;
    const finish = projectFinish(totalMean);
    const dir = delta > 0 ? `${delta} min faster` : `${-delta} min slower`;
    lines.push(`At the route <strong>mean</strong> pace this team would have finished at <strong>${finish}</strong> — ${dir} than actual.`);
  }
  if (fastCount >= 10 && totalFastest > 0) {
    const delta = elapsed - totalFastest;
    const finish = projectFinish(totalFastest);
    lines.push(`Matching the <strong>fastest split on every leg</strong> would put finish at <strong>${finish}</strong> — ${delta} min faster.`);
  }
  host.innerHTML = lines.join('<br/>');
}

function renderHistorical(data) {
  const host = $('historicalLine');
  if (!host) return;
  const elapsed = data.elapsedRunning?.minutes;
  if (!elapsed || !lastHistorical?.entries?.length) { host.innerHTML = ''; return; }
  const ours = elapsed;
  const sorted = [...lastHistorical.entries].sort((a, b) => a.movingMinutes - b.movingMinutes);
  const beaten = sorted.filter(h => ours <= h.movingMinutes);
  const couldBeat = sorted.find(h => ours <= h.movingMinutes);
  const recent = lastHistorical.entries.find(h => h.year >= 2024);
  const fastestEver = sorted[0];
  const lines = [];
  if (fastestEver) {
    const gap = ours - fastestEver.movingMinutes;
    lines.push(`Fastest reference 35-mi: <strong>${fastestEver.school} ${fastestEver.year}</strong> at ${fastestEver.finishClock} (${Math.floor(fastestEver.movingMinutes/60)}h ${String(fastestEver.movingMinutes%60).padStart(2,'0')}m walking). This team was <strong>${Math.floor(gap/60)}h ${String(gap%60).padStart(2,'0')}m</strong> behind that mark.`);
  }
  if (recent && recent !== fastestEver) {
    const gap = ours - recent.movingMinutes;
    const sign = gap > 0 ? 'behind' : 'ahead of';
    const abs = Math.abs(gap);
    lines.push(`vs ${recent.year} ${recent.school}: <strong>${Math.floor(abs/60)}h ${String(abs%60).padStart(2,'0')}m</strong> ${sign}.`);
  }
  host.innerHTML = lines.join('<br/>');
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
  renderGAPBars(data);
  renderAchievements(data);
  renderWhatIf(data);
  renderHistorical(data);
  setupInfoPopovers();
}

async function poll() {
  try {
    const [data, history, historical] = await Promise.all([
      fetchJson(DATA_URL),
      fetchJson(HISTORY_URL).catch(() => null),
      lastHistorical ? Promise.resolve(lastHistorical) : fetchJson(HISTORICAL_URL).catch(() => null)
    ]);
    lastData = data;
    lastHistory = history;
    lastHistorical = historical;
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
