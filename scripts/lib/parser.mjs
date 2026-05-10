import * as cheerio from 'cheerio';

export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // drop parenthetical suffixes like "(via)"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const FALLBACK_CHECKPOINTS = [
  'Start', 'Shilstone Tor', 'Cosdon Hill', 'Watern Tor', 'Sittaford Tor',
  'Higher White Tor', 'White Barrow', 'Hare Tor', 'Standon Farm',
  'Kitty Tor', 'Holming Beam', 'Higher Tor', 'Steeperton Tor',
  'East Mill Tor', 'Postbridge', 'Stannon Tor', 'Willsworthy', 'Finish'
];

export function fallbackCheckpoints() {
  return FALLBACK_CHECKPOINTS.map((n, i) => ({
    name: n.toUpperCase(),
    slug: slugify(n),
    index: i,
    fallback: true
  }));
}

function normaliseTime(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (!s || s === '-' || s === '—' || s === '*') return null;
  const m = s.match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const hh = String(Math.min(23, parseInt(m[1], 10))).padStart(2, '0');
  const mm = String(Math.min(59, parseInt(m[2], 10))).padStart(2, '0');
  return `${hh}:${mm}`;
}

function textOf($el) {
  return $el.text().replace(/\s+/g, ' ').trim();
}

/**
 * Parse the Route I page. Returns:
 *   { checkpoints: [{name, slug, index}], teams: [{code, name, times: {slug: "HH:MM"|null}}],
 *     sourceLastUpdated: string|null, warnings: [] }
 */
export function parseRouteI(html) {
  const warnings = [];
  const $ = cheerio.load(html);

  // Look for "last updated" hint anywhere on page.
  let sourceLastUpdated = null;
  const bodyText = $('body').text();
  const updMatch = bodyText.match(/(?:last\s+updated|updated)\s*[:\-]?\s*(\d{1,2}[:.]\d{2})/i);
  if (updMatch) sourceLastUpdated = normaliseTime(updMatch[1]);

  // Find candidate table: the largest table with a header row that includes a column matching a known checkpoint or "Team".
  const tables = $('table').toArray();
  let best = null;
  let bestScore = 0;
  for (const t of tables) {
    const rows = $(t).find('tr').toArray();
    if (rows.length < 2) continue;
    const headerCells = $(rows[0]).find('th,td').toArray().map(c => textOf($(c)));
    let score = rows.length + headerCells.length;
    const headerJoined = headerCells.join(' ').toLowerCase();
    if (/team|code|number/.test(headerJoined)) score += 50;
    if (/tor|barrow|beam|bridge|finish|start/.test(headerJoined)) score += 50;
    if (score > bestScore) { bestScore = score; best = t; }
  }

  if (!best) {
    warnings.push({ level: 'error', code: 'NO_TABLE_FOUND', message: 'No suitable Route I table found on source page.' });
    return { checkpoints: fallbackCheckpoints(), teams: [], sourceLastUpdated, warnings, fallbackUsed: true };
  }

  const rows = $(best).find('tr').toArray();
  const headerCells = $(rows[0]).find('th,td').toArray().map(c => textOf($(c)));

  // Identify which columns are team metadata vs checkpoints.
  // Heuristic: first 1-3 columns are team code/name; the remainder are checkpoints.
  let cpStart = 0;
  for (let i = 0; i < headerCells.length; i++) {
    const h = headerCells[i].toLowerCase();
    if (/team|code|name|number|no\.?$/.test(h)) cpStart = i + 1;
  }
  if (cpStart === 0) cpStart = 2; // safe default: code, name

  const cpHeaders = headerCells.slice(cpStart).filter(h => h && h.length > 0);
  if (cpHeaders.length < 3) {
    warnings.push({ level: 'error', code: 'TOO_FEW_CHECKPOINTS', message: `Only ${cpHeaders.length} checkpoint columns parsed.` });
    return { checkpoints: fallbackCheckpoints(), teams: [], sourceLastUpdated, warnings, fallbackUsed: true };
  }

  const checkpoints = cpHeaders.map((name, index) => ({
    name: name.toUpperCase(),
    slug: slugify(name),
    index
  }));

  const teams = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = $(rows[r]).find('td,th').toArray().map(c => textOf($(c)));
    if (cells.length < cpStart + 1) continue;
    // Team code: first cell that looks like a 1-3 letter code.
    let code = null, name = null;
    for (let i = 0; i < cpStart; i++) {
      const v = cells[i];
      if (!v) continue;
      if (!code && /^[A-Z]{1,4}$/.test(v)) { code = v; continue; }
      if (!name) name = v;
    }
    if (!code && cpStart > 0) code = (cells[0] || '').toUpperCase();
    if (!name) name = code || `Team ${r}`;
    if (!code) continue;
    const times = {};
    for (let i = 0; i < checkpoints.length; i++) {
      const v = cells[cpStart + i];
      times[checkpoints[i].slug] = normaliseTime(v);
    }
    teams.push({ code, name, times });
  }

  if (teams.length === 0) {
    warnings.push({ level: 'error', code: 'NO_TEAMS_PARSED', message: 'Header parsed but no team rows.' });
  }

  return { checkpoints, teams, sourceLastUpdated, warnings, fallbackUsed: false };
}
