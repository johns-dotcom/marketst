/**
 * Parse + diff + apply for the Market Street master sheet.
 *
 * Shared by the CLI script (scripts/import-master-sheet.js) and the API
 * route used by the Master Sheet Import page (POST /api/import/master-sheet).
 *
 * Insert-only — never updates an existing release row.
 * Match key: UPC if present on the spreadsheet row, else (artist + title)
 * compared case-insensitively. Past Releases → in_catalog = true,
 * Upcoming → false. Pitch columns ("yes" / blank) → boolean.
 */

const ExcelJS = require('exceljs');

// ── Cell helpers ────────────────────────────────────────────────────────
function cellText(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text.trim();
    if (typeof v.result === 'string') return v.result.trim();
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text || '').join('').trim();
    if (typeof v.hyperlink === 'string') return v.hyperlink.trim();
  }
  return String(v).trim();
}

function cellDate(cell) {
  const v = cell.value;
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object') {
    const t = cellText(cell);
    const d = t ? new Date(t) : null;
    return d && !isNaN(d.getTime()) ? d : null;
  }
  return null;
}

function normalizeFormat(raw) {
  const s = (raw || '').toLowerCase().trim();
  if (!s) return null;
  if (s.startsWith('alb')) return 'Album';
  if (s === 'ep') return 'EP';
  if (s.startsWith('sing')) return 'Single';
  return raw.trim();
}

function normalizePriority(raw) {
  const s = (raw || '').toLowerCase().trim();
  if (!s) return null;
  if (s === 'high priority') return 'High';
  if (s === 'priority' || s === 'priotiry') return 'Priority';
  if (s === 'standard') return 'Standard';
  return raw.trim();
}

function isTruthyFlag(raw) {
  const s = (raw || '').toString().toLowerCase().trim();
  return !!s && s !== '0' && s !== 'no' && s !== 'false';
}

// EPs/albums sometimes list every track's ISRC in one cell. Schema stores one,
// so pull the first ISRC-shaped token. Fall back to truncated raw so the row
// still lands.
const ISRC_RE = /\b[A-Z][A-Z0-9]{11}\b/;
function parseIsrc(raw) {
  if (!raw) return null;
  const m = String(raw).toUpperCase().match(ISRC_RE);
  if (m) return m[0];
  return String(raw).slice(0, 30);
}

// Both sheets share the field set, just with the date column in a different
// place. These fixed maps are the FALLBACK only — the real mapping is
// detected from the header row (see colMapFromHeader), because copies of
// the master sheet have shipped with the columns shuffled (an Upcoming
// tab laid out date-first once made the parser read release dates as
// artist names and create artists literally named ISO timestamps).
function colMap(sheetName) {
  if (sheetName === 'Upcoming Releases') {
    return {
      artist: 1, title: 2, date: 3, format: 4, genre: 5, priority: 6,
      upc: 7, isrc: 8, apple_id: 9, spotify_uri: 10,
      presave: 11, presave_analytics: 12, notes: 13,
      stem_pitch: 14, s4a_pitch: 15, am4a_pitch: 16,
    };
  }
  return {
    date: 1, artist: 2, title: 3, format: 4, genre: 5, priority: 6,
    upc: 7, isrc: 8, apple_id: 9, spotify_uri: 10,
    presave: 11, presave_analytics: 12, notes: 13,
    stem_pitch: 14, s4a_pitch: 15, am4a_pitch: 16,
  };
}

// Detect the column layout from the header row. Any header the detector
// can't place keeps its fallback position, so a sheet with standard
// headers behaves exactly as before while shuffled copies still map
// correctly. Match order matters: "Release Date" must hit `date` before
// the title patterns, "Presave Analytics" before plain presave, and
// "Spotify for Artists" before the Spotify-URI pattern.
function colMapFromHeader(sheet, sheetName) {
  const map = { ...colMap(sheetName) };
  const found = {};
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const h = cellText(cell).toLowerCase();
    if (!h) return;
    const set = (key) => { if (found[key] == null) found[key] = col; };
    if (/artist/.test(h)) set('artist');
    else if (/date/.test(h)) set('date');
    else if (/title|song|track|project|release/.test(h)) set('title');
    else if (/format|type/.test(h)) set('format');
    else if (/genre/.test(h)) set('genre');
    else if (/priority/.test(h)) set('priority');
    else if (/upc/.test(h)) set('upc');
    else if (/isrc/.test(h)) set('isrc');
    else if (/apple/.test(h)) set('apple_id');
    else if (/s4a|spotify\s*for\s*artists/.test(h)) set('s4a_pitch');
    else if (/spotify/.test(h)) set('spotify_uri');
    else if (/analytic/.test(h)) set('presave_analytics');
    else if (/pre-?save/.test(h)) set('presave');
    else if (/stem/.test(h)) set('stem_pitch');
    else if (/am4a|amazon/.test(h)) set('am4a_pitch');
    else if (/note/.test(h)) set('notes');
  });
  // Only trust the detection when it found the two load-bearing columns —
  // a decorative header row shouldn't scramble the fallback map.
  if (found.artist != null && found.title != null) Object.assign(map, found);
  return map;
}

// Artists are never named like timestamps — a date-shaped "artist" means
// the columns are misaligned for that row, and importing it would create
// a junk artist. Skipped + counted instead.
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}([T ]|$)|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

const norm = s => (s || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');
const titleArtistKey = (artist, title) => `${norm(artist)}␟${norm(title)}`;

// ── Parse ────────────────────────────────────────────────────────────────
async function parseSheet(input) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) {
    await wb.xlsx.load(input);
  } else {
    await wb.xlsx.readFile(input);
  }
  const all = [];
  for (const sheetName of ['Upcoming Releases', 'Past Releases']) {
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) continue;
    const map = colMapFromHeader(sheet, sheetName);
    const inCatalog = sheetName === 'Past Releases';
    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // header
      const artist = cellText(row.getCell(map.artist));
      const title  = cellText(row.getCell(map.title));
      if (!artist && !title) return; // padding
      all.push({
        sheet: sheetName,
        rowNum,
        artist,
        title,
        release_date: cellDate(row.getCell(map.date)),
        release_type: normalizeFormat(cellText(row.getCell(map.format))),
        genre: cellText(row.getCell(map.genre)) || null,
        priority: normalizePriority(cellText(row.getCell(map.priority))),
        upc: cellText(row.getCell(map.upc)) || null,
        isrc: parseIsrc(cellText(row.getCell(map.isrc))),
        apple_id: cellText(row.getCell(map.apple_id)) || null,
        spotify_uri: cellText(row.getCell(map.spotify_uri)) || null,
        presave_link: cellText(row.getCell(map.presave)) || null,
        presave_analytics: cellText(row.getCell(map.presave_analytics)) || null,
        notes: cellText(row.getCell(map.notes)) || null,
        stem_pitch:  isTruthyFlag(cellText(row.getCell(map.stem_pitch))),
        s4a_pitch:   isTruthyFlag(cellText(row.getCell(map.s4a_pitch))),
        amazon_pitch:isTruthyFlag(cellText(row.getCell(map.am4a_pitch))),
        in_catalog:  inCatalog,
      });
    });
  }
  return all;
}

// ── Diff: take parsed rows + current DB state, return what to do ────────
function diff(rows, dbReleases, dbArtists) {
  const artistByName = new Map(dbArtists.map(a => [norm(a.name), a]));
  const dbByUpc = new Map();
  const dbByTitleArtist = new Map();
  for (const r of dbReleases) {
    if (r.upc) dbByUpc.set(String(r.upc).trim(), r);
    dbByTitleArtist.set(titleArtistKey(r.artist_name, r.project_name), r);
  }

  const sheetCoversDbId = new Set();
  const artistsToCreate = [];
  const toInsert = [];
  const stats = {
    totalRows: rows.length,
    skippedDuplicate: 0,
    skippedNoArtistName: 0,
    skippedNoTitle: 0,
  };

  for (const r of rows) {
    if (!r.artist) { stats.skippedNoArtistName++; continue; }
    // Date-shaped "artist" = misaligned row; never create an artist
    // named like a timestamp.
    if (DATE_SHAPED.test(r.artist)) { stats.skippedNoArtistName++; continue; }
    if (!r.title)  { stats.skippedNoTitle++;      continue; }

    let dup = null;
    if (r.upc && dbByUpc.has(String(r.upc).trim())) dup = dbByUpc.get(String(r.upc).trim());
    if (!dup) {
      const k = titleArtistKey(r.artist, r.title);
      if (dbByTitleArtist.has(k)) dup = dbByTitleArtist.get(k);
    }
    if (dup) {
      sheetCoversDbId.add(dup.id);
      stats.skippedDuplicate++;
      continue;
    }

    if (!artistByName.has(norm(r.artist))
        && !artistsToCreate.find(a => norm(a.name) === norm(r.artist))) {
      artistsToCreate.push({ name: r.artist });
    }
    toInsert.push(r);
  }

  const dbOrphans = dbReleases
    .filter(r => !sheetCoversDbId.has(r.id))
    .map(r => ({
      id: r.id,
      artist_name: r.artist_name,
      project_name: r.project_name,
      upc: r.upc,
    }));

  return { stats, artistsToCreate, toInsert, dbOrphans };
}

// ── DB helpers: fetch the rows the diff needs ───────────────────────────
async function loadDbState(client) {
  const [{ rows: artistRows }, { rows: releaseRows }] = await Promise.all([
    client.query('SELECT id, name FROM artists'),
    client.query(`
      SELECT r.id, r.upc, r.project_name, a.name AS artist_name
      FROM releases r
      LEFT JOIN artists a ON a.id = r.artist_id
      WHERE COALESCE(r.archived, false) = false
    `),
  ]);
  return { dbArtists: artistRows, dbReleases: releaseRows };
}

// ── Apply: must run inside a transaction the caller manages ─────────────
async function applyImport(client, { artistsToCreate, toInsert, dbArtists }) {
  const artistByName = new Map(dbArtists.map(a => [norm(a.name), a]));
  let artistsCreated = 0;
  let releasesInserted = 0;

  for (const a of artistsToCreate) {
    const ins = await client.query(
      'INSERT INTO artists (name) VALUES ($1) RETURNING id, name',
      [a.name]
    );
    artistByName.set(norm(ins.rows[0].name), ins.rows[0]);
    artistsCreated++;
  }

  for (const r of toInsert) {
    const artist = artistByName.get(norm(r.artist));
    if (!artist) continue; // should be impossible — guard anyway
    await client.query(
      `INSERT INTO releases (
         artist_id, project_name, release_date, release_type, genre,
         priority, upc, isrc, apple_id, spotify_uri,
         presave_link, presave_analytics, notes,
         stem_pitch, s4a_pitch, amazon_pitch,
         in_catalog
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
       )`,
      [
        artist.id, r.title, r.release_date, r.release_type, r.genre,
        r.priority, r.upc, r.isrc, r.apple_id, r.spotify_uri,
        r.presave_link, r.presave_analytics, r.notes,
        r.stem_pitch, r.s4a_pitch, r.amazon_pitch,
        r.in_catalog,
      ]
    );
    releasesInserted++;
  }

  return { artistsCreated, releasesInserted };
}

module.exports = {
  parseSheet,
  diff,
  loadDbState,
  applyImport,
  // exported for tests / debug
  norm,
  titleArtistKey,
};
