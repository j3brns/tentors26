// Compute comparator analytics over Route I teams.

// Ten Tors mandatory overnight rest: camp by 19:10 day 1, leave from 06:10 day 2.
const OVERNIGHT_MIN = (24 * 60 - (19 * 60 + 10)) + (6 * 60 + 10);

function timeToMinutes(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Splits are minutes between consecutive arrival times for one team.
// Returns array aligned with checkpoints (split[i] = time at i - time at i-1, or null).
// The day-1 → day-2 segment crosses the mandatory overnight rest; subtract it
// so per-segment comparisons reflect walking time, not wall-clock.
function teamSplits(team, checkpoints) {
  const splits = new Array(checkpoints.length).fill(null);
  let prevMin = null;
  for (let i = 0; i < checkpoints.length; i++) {
    const slug = checkpoints[i].slug;
    const tm = timeToMinutes(team.times[slug]);
    if (tm != null && prevMin != null) {
      let d = tm - prevMin;
      let crossedNight = false;
      if (d < 0) { d += 24 * 60; crossedNight = true; }
      if (crossedNight) d -= OVERNIGHT_MIN;
      splits[i] = d;
    }
    if (tm != null) prevMin = tm;
  }
  return splits;
}

function stats(values) {
  const v = values.filter(x => x != null && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return { fastest: null, slowest: null, mean: null, median: null, mode: null };
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = Math.round(sum / v.length);
  const median = v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
  const counts = new Map();
  for (const x of v) counts.set(x, (counts.get(x) || 0) + 1);
  let mode = null, modeCount = 0;
  for (const [k, c] of counts) if (c > modeCount) { modeCount = c; mode = k; }
  if (modeCount < 3) mode = null;
  return { fastest: v[0], slowest: v[v.length - 1], mean, median, mode };
}

function reachedCount(team, checkpoints) {
  let n = 0;
  for (const cp of checkpoints) if (team.times[cp.slug]) n++;
  return n;
}

function furthestIndex(team, checkpoints) {
  let idx = -1;
  for (let i = 0; i < checkpoints.length; i++) if (team.times[checkpoints[i].slug]) idx = i;
  return idx;
}

export function computeComparator(team, allTeams, checkpoints) {
  const others = allTeams; // include IF in stats; comparator includes the team itself for ranking
  const comparable = others.filter(t => reachedCount(t, checkpoints) > 0);

  // IF splits
  const ifSplitsArr = teamSplits(team, checkpoints);
  const ifSplits = {};
  for (let i = 0; i < checkpoints.length; i++) {
    if (ifSplitsArr[i] != null) ifSplits[checkpoints[i].slug] = ifSplitsArr[i];
  }

  // Per-checkpoint stats across comparable teams.
  const checkpointStats = {};
  for (let i = 0; i < checkpoints.length; i++) {
    const slug = checkpoints[i].slug;
    const splits = comparable.map(t => teamSplits(t, checkpoints)[i]);
    const s = stats(splits);
    const ifSplit = ifSplitsArr[i];
    checkpointStats[slug] = {
      fastestSplitMinutes: s.fastest,
      slowestSplitMinutes: s.slowest,
      meanSplitMinutes: s.mean,
      medianSplitMinutes: s.median,
      modeSplitMinutes: s.mode,
      ifSplitMinutes: ifSplit ?? null,
      ifVsMean: ifSplit != null && s.mean != null ? ifSplit - s.mean : null,
      ifVsFastest: ifSplit != null && s.fastest != null ? ifSplit - s.fastest : null
    };
  }

  // Overall ranking by (furthest cp, earliest arrival there, code).
  const ranked = allTeams.slice().sort((a, b) => {
    const fa = furthestIndex(a, checkpoints);
    const fb = furthestIndex(b, checkpoints);
    if (fb !== fa) return fb - fa;
    if (fa < 0) return a.code.localeCompare(b.code);
    const ta = timeToMinutes(a.times[checkpoints[fa].slug]) ?? 99999;
    const tb = timeToMinutes(b.times[checkpoints[fb].slug]) ?? 99999;
    if (ta !== tb) return ta - tb;
    return a.code.localeCompare(b.code);
  });
  const overallPosition = ranked.findIndex(t => t.code === team.code) + 1 || null;

  // Per-checkpoint position for IF.
  const checkpointPositions = {};
  for (const cp of checkpoints) {
    const ifTime = timeToMinutes(team.times[cp.slug]);
    if (ifTime == null) { checkpointPositions[cp.slug] = null; continue; }
    const arrivals = allTeams
      .map(t => ({ code: t.code, m: timeToMinutes(t.times[cp.slug]) }))
      .filter(x => x.m != null)
      .sort((a, b) => a.m - b.m || a.code.localeCompare(b.code));
    const idx = arrivals.findIndex(x => x.code === team.code);
    checkpointPositions[cp.slug] = idx >= 0 ? idx + 1 : null;
  }

  return {
    comparableTeams: comparable.length,
    totalTeamsOnRoute: allTeams.length,
    overallPosition,
    ifSplits,
    checkpointStats,
    checkpointPositions
  };
}
