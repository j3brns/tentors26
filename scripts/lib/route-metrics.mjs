import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COORDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'checkpoint-coords.json'), 'utf8'));

export function getCoords(slug) {
  const c = COORDS[slug];
  if (!c || typeof c.lat !== 'number') return null;
  return { lat: c.lat, lon: c.lon, source: c.source || 'unknown', elevationMetres: c.elevationMetres ?? null };
}

export function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function computeSegment(prevSlug, slug, strideMetres) {
  const a = prevSlug ? getCoords(prevSlug) : null;
  const b = getCoords(slug);
  if (!a || !b) {
    return {
      distanceKm: null,
      estimatedSteps: null,
      ascentMetres: null,
      descentMetres: null,
      valueSource: 'unknown',
      reason: !b ? 'missing-coords-current' : 'missing-coords-previous'
    };
  }
  const distanceKm = haversineKm(a, b);
  const dElev = (b.elevationMetres ?? 0) - (a.elevationMetres ?? 0);
  const ascentMetres = dElev > 0 ? Math.round(dElev) : 0;
  const descentMetres = dElev < 0 ? Math.round(-dElev) : 0;
  const estimatedSteps = distanceKm != null ? Math.round((distanceKm * 1000) / strideMetres) : null;
  return {
    distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
    estimatedSteps,
    ascentMetres,
    descentMetres,
    valueSource: 'calculated'
  };
}

export function computeRouteMetrics(checkpoints, strideMetres) {
  let totalDistanceKm = 0, totalSteps = 0, ascent = 0, descent = 0;
  let anyMissing = false;
  for (const cp of checkpoints) {
    const seg = cp.segmentFromPrevious;
    if (!seg || seg.distanceKm == null) { anyMissing = true; continue; }
    totalDistanceKm += seg.distanceKm;
    totalSteps += seg.estimatedSteps || 0;
    ascent += seg.ascentMetres || 0;
    descent += seg.descentMetres || 0;
  }
  return {
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalEstimatedSteps: totalSteps,
    cumulativeAscentMetres: ascent,
    cumulativeDescentMetres: descent,
    strideLengthMetres: strideMetres,
    assumptions: [
      'stepsFromDistanceAndStride',
      'elevationFromCheckpointCoordsLookup',
      anyMissing ? 'someSegmentsMissingCoords' : 'allSegmentsResolved'
    ]
  };
}
