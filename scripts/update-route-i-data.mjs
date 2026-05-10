#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Prefer source parser (fast iteration with node_modules/cheerio installed).
// Fall back to the vendored bundle so CI never needs `npm install`.
const parserMod = await import('./lib/parser.mjs').catch(() => import('./lib/parser.bundle.mjs'));
const { parseRouteI, slugify, fallbackCheckpoints } = parserMod;
import { computeComparator } from './lib/comparator.mjs';
import { computeSegment, computeRouteMetrics, getCoords } from './lib/route-metrics.mjs';

const SCHEMA_VERSION = 1;
const SOURCE_URL = 'https://www.tentors.org.uk/eventdata/routei.html';
const TEAM_CODE = (process.env.TEAM_CODE || 'IF').toUpperCase();
const REQUESTED_NAME = process.env.REQUESTED_NAME || 'Polar Explorer Scouts';
const STRIDE_METRES = parseFloat(process.env.STRIDE_METRES || '0.76');
const HISTORY_CAP = 500;

// Ten Tors overnight: teams must camp by 19:10 on day 1 and may not leave camp
// before 06:10 on day 2. Subtract this 11h gap from day-2 elapsed so the
// reported figures and pace reflect walking time, not wall-clock time.
const DAY1_CUTOFF_MIN = 19 * 60 + 10;
const DAY2_START_MIN = 6 * 60 + 10;
const OVERNIGHT_MIN = (24 * 60 - DAY1_CUTOFF_MIN) + DAY2_START_MIN;

const SITE_DIR = path.resolve('site');
const DATA_PATH = path.join(SITE_DIR, 'data.json');
const HISTORY_PATH = path.join(SITE_DIR, 'history.json');
const IMAGE_DIR = path.join(SITE_DIR, 'images');

function nowIsoUtc() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function timeToMinutes(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function elapsedLabel(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

async function fetchSource() {
  if (process.env.LOCAL_FIXTURE) {
    return fs.readFileSync(process.env.LOCAL_FIXTURE, 'utf8');
  }
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'tentors26-route-i-dashboard/0.1 (+github actions)' }
  });
  if (!res.ok) throw new Error(`source fetch failed: HTTP ${res.status}`);
  return await res.text();
}

function imageUrlFor(slug) {
  const candidates = [`${slug}.webp`, `${slug}.jpg`, `${slug}.svg`];
  for (const c of candidates) {
    if (fs.existsSync(path.join(IMAGE_DIR, c))) return `./images/${c}`;
  }
  return null;
}

function buildCheckpoints(parsedCheckpoints, ifTeam, startTimeMinutes) {
  const out = [];
  let prevSlug = null;
  // Day rollover: arrivals are clock times only ("HH:MM"), no date. Walk in route
  // order; any backward jump vs the previous reached checkpoint means +24h.
  let dayOffset = 0;
  let prevArrivalMin = null;
  for (let i = 0; i < parsedCheckpoints.length; i++) {
    const cp = parsedCheckpoints[i];
    const arrival = ifTeam ? (ifTeam.times[cp.slug] || null) : null;
    const arrivalMin = timeToMinutes(arrival);
    let elapsedMin = null;
    if (arrivalMin != null && startTimeMinutes != null) {
      if (prevArrivalMin != null && arrivalMin < prevArrivalMin) {
        dayOffset += 24 * 60;
      }
      const effective = arrivalMin + dayOffset;
      let d = effective - startTimeMinutes;
      if (d < 0) d += 24 * 60;
      // Day-2 checkpoints: strip the mandatory overnight rest from elapsed.
      if (dayOffset >= 24 * 60) d -= OVERNIGHT_MIN;
      elapsedMin = d;
      prevArrivalMin = arrivalMin;
    }
    const seg = computeSegment(prevSlug, cp.slug, STRIDE_METRES);
    const coords = getCoords(cp.slug);
    const localImageUrl = imageUrlFor(cp.slug);
    out.push({
      name: cp.name,
      slug: cp.slug,
      index: i,
      arrivalTime: arrival,
      reached: !!arrival,
      elapsed: elapsedMin != null ? { minutes: elapsedMin, label: elapsedLabel(elapsedMin) } : null,
      progressPercent: Math.round(((i + 1) / parsedCheckpoints.length) * 100),
      coordinates: coords ? { lat: coords.lat, lon: coords.lon, source: coords.source } : null,
      elevationMetres: coords ? coords.elevationMetres : null,
      segmentFromPrevious: i === 0 ? null : seg,
      localImageUrl,
      imageSource: null,
      imageTitle: null,
      fallback: cp.fallback || false
    });
    prevSlug = cp.slug;
  }
  return out;
}

function teamRowHash(team) {
  if (!team) return null;
  const blob = JSON.stringify({ code: team.code, name: team.name, times: team.times });
  return crypto.createHash('sha1').update(blob).digest('hex');
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  fs.mkdirSync(SITE_DIR, { recursive: true });

  const warnings = [];
  let html = '';
  let parsed;
  try {
    html = await fetchSource();
    parsed = parseRouteI(html);
    warnings.push(...parsed.warnings);
  } catch (e) {
    warnings.push({ level: 'error', code: 'FETCH_FAILED', message: String(e.message || e) });
    parsed = { checkpoints: fallbackCheckpoints(), teams: [], sourceLastUpdated: null, fallbackUsed: true };
  }

  let checkpoints = parsed.checkpoints;
  let teams = parsed.teams || [];
  if (!checkpoints || checkpoints.length === 0) {
    checkpoints = fallbackCheckpoints();
    warnings.push({ level: 'warn', code: 'USING_FALLBACK_CHECKPOINTS', message: 'Falling back to hard-coded checkpoint list.' });
  }

  const ifTeam = teams.find(t => t.code === TEAM_CODE) || null;
  if (teams.length > 0 && !ifTeam) {
    warnings.push({ level: 'warn', code: 'TEAM_NOT_FOUND', message: `Team ${TEAM_CODE} not present in parsed table.` });
  }

  // Start time for IF: earliest arrival time, or null.
  let startMin = null;
  if (ifTeam) {
    for (const cp of checkpoints) {
      const m = timeToMinutes(ifTeam.times[cp.slug]);
      if (m != null) { startMin = m; break; }
    }
  }

  const cpObjects = buildCheckpoints(checkpoints, ifTeam, startMin);
  const reachedCount = cpObjects.filter(c => c.reached).length;
  const totalCheckpoints = cpObjects.length;
  const routeProgressPercent = totalCheckpoints ? Math.round((reachedCount / totalCheckpoints) * 100) : 0;

  let currentCheckpoint = null, nextCheckpoint = null, currentCheckpointIndex = null;
  for (let i = 0; i < cpObjects.length; i++) {
    if (cpObjects[i].reached) { currentCheckpoint = cpObjects[i]; currentCheckpointIndex = i; }
  }
  if (currentCheckpointIndex != null && currentCheckpointIndex + 1 < cpObjects.length) {
    nextCheckpoint = cpObjects[currentCheckpointIndex + 1];
  }

  const routeMetrics = computeRouteMetrics(cpObjects, STRIDE_METRES);

  let comparator = {
    comparableTeams: 0, totalTeamsOnRoute: teams.length, overallPosition: null,
    ifSplits: {}, checkpointStats: {}, checkpointPositions: {}
  };
  if (ifTeam && teams.length > 0) {
    comparator = computeComparator(ifTeam, teams, checkpoints);
  }

  // Elapsed running time = since first checkpoint, until last reached checkpoint (HH:MM total).
  let elapsedRunning = null;
  if (currentCheckpoint && currentCheckpoint.elapsed) {
    elapsedRunning = currentCheckpoint.elapsed;
  }

  // ETA projection: pace from IF so far, applied to remaining route distance.
  // Falls back to comparator median split per remaining checkpoint when IF data is thin.
  function computeEta() {
    if (!currentCheckpoint || !currentCheckpoint.elapsed || currentCheckpointIndex == null) return null;
    let coveredKm = 0;
    for (let i = 1; i <= currentCheckpointIndex; i++) {
      const seg = cpObjects[i].segmentFromPrevious;
      if (seg?.distanceKm != null) coveredKm += seg.distanceKm;
    }
    let remainingKm = 0;
    for (let i = currentCheckpointIndex + 1; i < cpObjects.length; i++) {
      const seg = cpObjects[i].segmentFromPrevious;
      if (seg?.distanceKm != null) remainingKm += seg.distanceKm;
    }
    const elapsedMin = currentCheckpoint.elapsed.minutes || 0;
    const paceMinPerKm = coveredKm > 0 ? elapsedMin / coveredKm : null;
    if (paceMinPerKm == null) return null;
    const minutesToFinish = Math.round(paceMinPerKm * remainingKm);
    const minutesToNext = nextCheckpoint?.segmentFromPrevious?.distanceKm != null
      ? Math.round(paceMinPerKm * nextCheckpoint.segmentFromPrevious.distanceKm)
      : null;
    const fmtClock = (m) => {
      if (m == null || startMin == null) return null;
      const t = ((startMin + elapsedMin + m) % (24 * 60) + 24 * 60) % (24 * 60);
      return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };
    return {
      paceMinPerKm: Math.round(paceMinPerKm * 10) / 10,
      coveredKm: Math.round(coveredKm * 10) / 10,
      remainingKm: Math.round(remainingKm * 10) / 10,
      minutesToNext,
      etaNext: fmtClock(minutesToNext),
      minutesToFinish,
      etaFinish: fmtClock(minutesToFinish),
      assumption: 'IF pace projected on Haversine remaining distance'
    };
  }
  const eta = computeEta();

  const data = {
    schemaVersion: SCHEMA_VERSION,
    sourceUrl: SOURCE_URL,
    generatedAt: nowIsoUtc(),
    sourceLastUpdated: parsed.sourceLastUpdated || null,
    route: 'I',
    team: {
      requestedName: REQUESTED_NAME,
      sourceName: ifTeam ? ifTeam.name : null,
      code: TEAM_CODE,
      nameMatchesRequest: ifTeam ? (ifTeam.name.toLowerCase() === REQUESTED_NAME.toLowerCase()) : false
    },
    warnings,
    fallbackUsed: !!parsed.fallbackUsed,
    routeProgressPercent,
    reachedCount,
    totalCheckpoints,
    currentCheckpointIndex,
    currentCheckpoint,
    nextCheckpoint,
    elapsedRunning,
    eta,
    checkpoints: cpObjects,
    comparator,
    routeMetrics
  };

  const prevData = readJsonSafe(DATA_PATH, null);

  // Sanity guards against bad scrapes.
  if (prevData && ifTeam && reachedCount < (prevData.reachedCount || 0)) {
    warnings.push({
      level: 'warn',
      code: 'REACHED_COUNT_REGRESSION',
      message: `reachedCount dropped from ${prevData.reachedCount} to ${reachedCount}; likely a partial scrape — values rendered but treat with care.`
    });
  }
  // Stale source warning during the event window (no source update for >15 min).
  if (prevData?.sourceLastUpdated && data?.sourceLastUpdated && prevData.sourceLastUpdated === data.sourceLastUpdated) {
    const ageMinutes = Math.round((Date.now() - new Date(prevData.generatedAt).getTime()) / 60000);
    if (ageMinutes >= 15) {
      warnings.push({
        level: 'info',
        code: 'SOURCE_NOT_ADVANCING',
        message: `source 'last updated' has been ${data.sourceLastUpdated} for ~${ageMinutes} min; the feed may be paused.`
      });
    }
  }

  // History append: only when team-row hash or sourceLastUpdated changes.
  const history = readJsonSafe(HISTORY_PATH, { schemaVersion: SCHEMA_VERSION, capacity: HISTORY_CAP, entries: [] });
  if (!history.entries) history.entries = [];

  const newHash = teamRowHash(ifTeam);
  const prevHash = prevData ? teamRowHash({
    code: prevData.team?.code,
    name: prevData.team?.sourceName,
    times: Object.fromEntries((prevData.checkpoints || []).map(c => [c.slug, c.arrivalTime]))
  }) : null;
  const sourceChanged = (prevData?.sourceLastUpdated || null) !== (data.sourceLastUpdated || null);

  if (newHash && (newHash !== prevHash || sourceChanged)) {
    history.entries.push({
      generatedAt: data.generatedAt,
      sourceLastUpdated: data.sourceLastUpdated,
      reachedCount,
      currentCheckpointSlug: currentCheckpoint?.slug || null,
      overallPosition: comparator.overallPosition,
      routeProgressPercent
    });
    if (history.entries.length > HISTORY_CAP) {
      history.entries.splice(0, history.entries.length - HISTORY_CAP);
    }
  }
  history.schemaVersion = SCHEMA_VERSION;
  history.capacity = HISTORY_CAP;

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');

  const summary = {
    teamFound: !!ifTeam,
    reachedCount,
    totalCheckpoints,
    overallPosition: comparator.overallPosition,
    warnings: warnings.length,
    historyEntries: history.entries.length
  };
  console.log('update-route-i-data:', JSON.stringify(summary));
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
