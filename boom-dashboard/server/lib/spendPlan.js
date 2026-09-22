/**
 * The release spend sheet — parsing "Copy of Boom.Records.xlsx" into commitments.
 *
 * John, 2026-09-03: "the attached excel is how we currently track artist budgets.
 * I want to transfer this over to our app."
 *
 * ── What the sheet is ──
 * ONE visible tab, `Expenses`, holding 1,373 releases side by side. Each release
 * is a three-column block starting at B and repeating every 3 columns:
 *
 *        B              C                 D
 *     ┌──────────────┬─────────────────┬────────────┐
 *   1 │ Darci - Lights │ Expense Notes │ Who Paid   │   ← header, only col 1 is real
 *   2 │ 500            │ Lauren PR     │ Tyler      │   ← lines
 *   3 │ 50             │ Video         │ Felipe     │
 *  17 │ 550            │ Total         │            │   ← the printed total
 *
 * The other four tabs are hidden and dead: `Accounting` carried the only real
 * budget-vs-actual model (Planned Marketing Budget / Amount Spent / Where
 * allocated / Remaining / Amount Recouped) and stops at row 21, November 2021.
 * `Recouped  Outstanding`, `Monthly Streams` and `Monthly Listeners` end in 2022.
 * None of them is read here.
 *
 * ── The sheet holds COMMITMENTS, the ledger holds actuals ──
 * Measured before writing this: 111 (artist, song) pairs exist in both the sheet
 * and `expenses`, and **not one of the 111 agrees**. It cuts both ways — the
 * sheet is bigger where spend is committed but unpaid ($1,790,594 of "not yet"),
 * the ledger is bigger where money moved that the marketing sheet never tracked.
 * They are not two copies of one number, so nothing here overwrites the ledger.
 * The sheet supplies the commitment; `release_id` lets the ledger supply actuals.
 *
 * ── What the sheet cannot tell us ──
 * The legend in A18 reads "Red = Non Recoup". Every cell style in the workbook
 * was checked: there is exactly ONE red cell (T4, "Dinner + Drinks"), no red
 * font is defined at all, and there is no conditional formatting. So
 * recoupability is NOT recoverable from this file and is deliberately not
 * imported — `expenses.recoupable` remains the only place that answer lives.
 *
 * ── Why streaming ──
 * 4,141,387 cell tags across 4,129 columns. The regular reader loads all of it;
 * only rows 1-18 matter, so WorkbookReader bails after row 18 (~0.4s).
 */

const ExcelJS = require('exceljs');
const { Readable } = require('stream');

const SHEET_NAME = 'Expenses';
const FIRST_COL = 2;   // column B — column A is the legend gutter ("da", "Red = Non Recoup")
const STRIDE = 3;      // amount | note | who-paid
const FIRST_ROW = 2;
const MAX_ROW = 18;    // one past the deepest total row seen (17)

// The last block is the sheet's grand total, not a release.
const GRAND_TOTAL_HEADER = /^total\s+expenses/i;

const norm = s => (s || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');

// Match key: accents folded, & spelled out, punctuation dropped. "Łaszewo" and
// "Laszewo", "Eli & Fur" and "Eli and Fur" are the same release.
function matchKey(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const pairKey = (artist, title) => `${matchKey(artist)}␟${matchKey(title)}`;

// ── Payment status ───────────────────────────────────────────────────────────
//
// "Who Paid" started as a person and drifted into a payment status. Across 7,218
// lines it is 2,868 "not yet", 1,663 "paid", and 67 distinct values total; the
// rows still naming a person (Tyler, Felipe, market.st, Sergio, Kenny) number about
// 40 and all sit in the oldest blocks on the left.
//
// John's call: map the status, discard the names as legacy noise. So a BARE name
// yields `null` — unknown — and never `paid`. "Paid Felipe" still reads paid
// because the word is there; "Felipe" alone is not evidence that money moved,
// and inferring it would put $90k of guesses into a commitment total.
//
// Everything unrecognized also lands on `null`, deliberately: `pitched`,
// `passed`, `accepted` and `sound on` are pitch outcomes, not payments. The raw
// cell is kept on every line regardless, so a bad call here is reversible
// without re-reading the workbook.
const NOT_YET = new Set([
  'not yet', 'no', 'pending', 'pending approval', 'pending results', 'tba', 'tbd',
  'on hold', 'need to run', 'broke', 'setup', 'un paid', 'unpaid', 'not paid',
]);

function paymentStatus(raw) {
  const v = norm(raw);
  if (!v) return null;
  if (NOT_YET.has(v)) return 'not_yet';
  // "un paid" / "unpaid" are caught above; guard the substring test anyway so a
  // value like "still unpaid" can never come back as paid.
  if (/\bun\s*paid\b/.test(v) || /\bnot\s+paid\b/.test(v)) return 'not_yet';
  if (/\bpaid\b/.test(v) || v === 'yes') return 'paid';
  return null;
}

// ── Cell readers ─────────────────────────────────────────────────────────────
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText) return v.richText.map(t => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.error) return '';
    return '';
  }
  return String(v);
}

// 6,985 of 7,218 amount cells are plain numbers. The other 56 non-empty ones are
// prose the operator typed into the money column — "625 advance", "1250
// alloocated", "FREE", "updated on stem", "?", ".". They are kept verbatim on
// `amount_raw` with a NULL amount rather than being coerced: "625 advance" is
// probably $625, and probably is not good enough for a number that feeds a
// commitment total. The match queue surfaces them for a human.
function parseAmount(v) {
  if (v === null || v === undefined || v === '') return { amount: null, raw: '' };
  if (typeof v === 'number' && Number.isFinite(v)) return { amount: v, raw: '' };
  if (typeof v === 'object' && typeof v.result === 'number') {
    return { amount: v.result, raw: '' };
  }
  const text = cellText(v).trim();
  if (!text) return { amount: null, raw: '' };
  // Accept only a clean money literal: optional $, digits, commas, decimals.
  const m = /^\$?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)$/.exec(text);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return { amount: n, raw: '' };
  }
  return { amount: null, raw: text };
}

// ── Parse ────────────────────────────────────────────────────────────────────
//
// Returns one entry per release block, in sheet order (left to right = oldest to
// newest). `sheetTotal` is the printed row-17 figure, stored as printed and
// never recomputed — where it disagrees with the lines beneath it (10 blocks do)
// that disagreement is the sheet's, and the import reports it rather than
// silently picking a side.
async function parseSheet(input) {
  const source = Buffer.isBuffer(input) ? Readable.from(input) : input;
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    entries: 'emit',
  });

  // grid[row] = sparse array of cell values, 1-indexed by column
  const grid = [];
  let found = false;
  for await (const ws of reader) {
    if (ws.name !== SHEET_NAME) continue;
    found = true;
    for await (const row of ws) {
      if (row.number > MAX_ROW) break;
      grid[row.number] = row.values;
    }
    break;
  }
  if (!found) {
    throw new Error(`No "${SHEET_NAME}" sheet in this workbook`);
  }

  const header = grid[1] || [];
  const lastCol = Math.max(
    header.length,
    ...grid.filter(Boolean).map(r => r.length)
  );

  const at = (row, col) => (grid[row] ? grid[row][col] : undefined);

  const blocks = [];
  for (let col = FIRST_COL; col <= lastCol; col += STRIDE) {
    const headerText = cellText(at(1, col)).trim();
    if (GRAND_TOTAL_HEADER.test(headerText)) continue;

    // A block's own total row is wherever its NOTE column says "Total" — seen at
    // 17 (the norm), and at 13 and 16 in a handful of blocks. Found per block
    // rather than assumed, so a stray total is not counted as a line item.
    let totalRow = null;
    for (let r = FIRST_ROW; r <= MAX_ROW; r++) {
      if (norm(at(r, col + 1)) === 'total') { totalRow = r; break; }
    }

    const lines = [];
    for (let r = FIRST_ROW; r <= MAX_ROW; r++) {
      if (r === totalRow) continue;
      const rawAmount = at(r, col);
      const note = cellText(at(r, col + 1)).trim();
      const who = cellText(at(r, col + 2)).trim();
      if ((rawAmount === null || rawAmount === undefined || rawAmount === '')
          && !note && !who) continue;
      const { amount, raw } = parseAmount(rawAmount);
      lines.push({
        sourceRow: r,
        amount,
        amountRaw: raw || null,
        note: note || null,
        status: paymentStatus(who),
        statusRaw: who || null,
      });
    }

    if (!headerText && !lines.length) continue;

    const linesTotal = round2(lines.reduce((s, l) => s + (l.amount || 0), 0));

    // The total is taken AS PRINTED and is not recomputed — where it disagrees
    // with the lines under it, that disagreement belongs to the sheet and the
    // import reports it rather than picking a side.
    //
    // 46 blocks are the exception, and they are a file artifact rather than a
    // judgement: their total cell is a live formula (`sum(HM2:HM11)`) that this
    // workbook carries with NO cached result, so there is no printed figure to
    // take. Only there is the sum computed, and `totalSource` says so, so a
    // derived figure is never mistaken downstream for one a person typed.
    let sheetTotal = null;
    let totalSource = 'missing';
    if (totalRow !== null) {
      const cell = at(totalRow, col);
      const { amount } = parseAmount(cell);
      if (amount !== null) {
        sheetTotal = amount;
        totalSource = 'printed';
      } else if (cell && typeof cell === 'object' && cell.formula) {
        sheetTotal = linesTotal;
        totalSource = 'derived';
      }
    }

    blocks.push({
      sourceColumn: colLetter(col),
      header: headerText,
      ...splitHeader(headerText),
      lines,
      sheetTotal,
      totalSource,
      linesTotal,
    });
  }

  return blocks;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

// ── Header → (artist, title) ─────────────────────────────────────────────────
//
// 1,347 of 1,372 headers contain " - ", and the ORDER IS NOT CONSISTENT: 1,005
// read Artist - Song ("Darci - Lights") and 58 read Song - Artist ("Around -
// Night Tales", "CÁLLATE - MARTHA"). A handful use a tab instead of a dash.
// Both readings are produced here and the matcher tries each against the
// releases table; the sheet alone cannot say which is which.
function splitHeader(headerText) {
  const text = (headerText || '').replace(/\t/g, ' - ').trim();
  const i = text.search(/\s+-\s+|\s+-(?=\S)|(?<=\S)-\s+/);
  if (i < 0) return { left: text, right: null };
  const m = /\s+-\s+|\s+-(?=\S)|(?<=\S)-\s+/.exec(text);
  return {
    left: text.slice(0, i).trim(),
    right: text.slice(i + m[0].length).trim(),
  };
}


// ── Similarity, for SUGGESTIONS only ─────────────────────────────────────────
//
// Never used to link anything automatically. 1,063 of the 1,372 headers match a
// release exactly; the rest go to a queue with these as ranked suggestions,
// because the failure mode of a wrong automatic link here is money attributed to
// the wrong artist's recoupable balance.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - editDistance(a, b) / max;
}

// A suggestion is scored on the ARTIST AND THE TITLE TOGETHER, weighted toward
// the title because it is the more distinctive half. Scoring on the title alone
// — the obvious version, and the first one written here — proposed "Maximo —
// Lights" for "Darci - Lights" and "Rachel Levin — My Way" for "Tim North - My
// Way", both at a confident 1.000. A queue whose top suggestion is a different
// artist's release is worse than no suggestion: the whole point of the queue is
// that a person accepts one, and these are the ones they would accept.
const TITLE_WEIGHT = 0.65;
const ARTIST_WEIGHT = 0.35;
const TITLE_FLOOR = 0.78;    // the title must be close on its own merits
const SUGGEST_FLOOR = 0.78;  // and the combined score must clear this too
const SUGGEST_LIMIT = 5;

// ── DB state ─────────────────────────────────────────────────────────────────
async function loadDbState(client) {
  const [{ rows: releases }, { rows: artists }] = await Promise.all([
    client.query(`
      SELECT r.id, r.project_name, r.artist_id, r.release_date,
             a.name AS artist_name
        FROM releases r
        LEFT JOIN artists a ON a.id = r.artist_id
    `),
    client.query('SELECT id, name FROM artists'),
  ]);
  return { dbReleases: releases, dbArtists: artists };
}

// ── Diff: which block belongs to which release ───────────────────────────────
//
// The header order is not consistent (Artist - Song AND Song - Artist both
// occur), so BOTH readings are tried against the releases table and whichever
// one the data recognises wins. That is evidence, not a guess — a header only
// links when some release actually carries that exact (artist, project) pair.
//
// Three outcomes:
//   matched     exactly one release matches one of the two readings
//   ambiguous   both readings match, or one reading matches several releases
//   unmatched   neither reading matches anything
//
// `ambiguous` is NOT resolved by preferring Artist - Song. Two different
// releases genuinely answering to one header is a question for a person, and
// picking the commoner convention would be right about 95% of the time — which
// is another way of saying it would silently misfile the rest.
function diff(blocks, dbReleases) {
  const byPair = new Map();
  for (const r of dbReleases) {
    const k = pairKey(r.artist_name, r.project_name);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  const titles = dbReleases.map(r => ({
    r,
    key: matchKey(r.project_name),
    artistKey: matchKey(r.artist_name),
  }));

  const results = blocks.map((b) => {
    const left = b.left || '';
    const right = b.right || '';
    const asArtistSong = right ? byPair.get(pairKey(left, right)) || [] : [];
    const asSongArtist = right ? byPair.get(pairKey(right, left)) || [] : [];

    const hits = [];
    if (asArtistSong.length) hits.push({ order: 'artist_song', rows: asArtistSong });
    if (asSongArtist.length) hits.push({ order: 'song_artist', rows: asSongArtist });

    if (hits.length === 1 && hits[0].rows.length === 1) {
      const r = hits[0].rows[0];
      return {
        ...b,
        status: 'matched',
        matchOrder: hits[0].order,
        releaseId: r.id,
        releaseLabel: `${r.artist_name} — ${r.project_name}`,
        suggestions: [],
      };
    }

    const candidates = hits.flatMap(h => h.rows);
    if (candidates.length) {
      // Two shapes wear one word, and they need different fixes. ONE reading
      // matching SEVERAL releases means the releases table holds duplicates of
      // that project — the answer is to merge them, and the queue says so.
      // BOTH readings matching means the header itself is the ambiguity.
      const dupes = hits.length === 1 && hits[0].rows.length > 1;
      return {
        ...b,
        status: dupes ? 'duplicate_release' : 'ambiguous',
        matchOrder: null,
        releaseId: null,
        releaseLabel: null,
        suggestions: candidates.slice(0, SUGGEST_LIMIT).map(r => ({
          releaseId: r.id,
          label: `${r.artist_name} — ${r.project_name}`,
          score: 1,
        })),
      };
    }

    // No exact pair. Score every release on both readings of the header — the
    // title against its project name AND the artist against its artist name —
    // and keep the better reading. Both halves must agree for a suggestion to
    // survive, which is what stops a title-only coincidence being offered.
    const lk = matchKey(left);
    const rk = matchKey(right);
    const scored = [];
    for (const t of titles) {
      let best = 0;
      // reading A: left is the artist, right is the title
      const tA = similarity(rk, t.key);
      if (tA >= TITLE_FLOOR) {
        best = Math.max(best, tA * TITLE_WEIGHT + similarity(lk, t.artistKey) * ARTIST_WEIGHT);
      }
      // reading B: left is the title, right is the artist
      const tB = similarity(lk, t.key);
      if (tB >= TITLE_FLOOR) {
        best = Math.max(best, tB * TITLE_WEIGHT + similarity(rk, t.artistKey) * ARTIST_WEIGHT);
      }
      if (best >= SUGGEST_FLOOR) scored.push({ r: t.r, s: best });
    }
    scored.sort((x, y) => y.s - x.s);
    const seen = new Set();
    const suggestions = [];
    for (const { r, s } of scored) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      suggestions.push({
        releaseId: r.id,
        label: `${r.artist_name} — ${r.project_name}`,
        score: Math.round(s * 1000) / 1000,
      });
      if (suggestions.length >= SUGGEST_LIMIT) break;
    }
    return {
      ...b,
      status: 'unmatched',
      matchOrder: null,
      releaseId: null,
      releaseLabel: null,
      suggestions,
    };
  });

  const stats = {
    blocks: results.length,
    lines: results.reduce((s, r) => s + r.lines.length, 0),
    matched: results.filter(r => r.status === 'matched').length,
    ambiguous: results.filter(r => r.status === 'ambiguous').length,
    duplicateRelease: results.filter(r => r.status === 'duplicate_release').length,
    unmatched: results.filter(r => r.status === 'unmatched').length,
    withSuggestion: results.filter(r => r.status !== 'matched' && r.suggestions.length).length,
    sheetTotal: round2(results.reduce((s, r) => s + (r.sheetTotal || 0), 0)),
    derivedTotals: results.filter(r => r.totalSource === 'derived').length,
    totalDisagreements: results.filter(
      r => r.totalSource === 'printed' && Math.abs(r.sheetTotal - r.linesTotal) > 0.005
    ).length,
    nonNumericAmounts: results.reduce((s, r) => s + r.lines.filter(l => l.amountRaw).length, 0),
    committed: round2(results.reduce(
      (s, r) => s + r.lines.filter(l => l.status === 'not_yet').reduce((t, l) => t + (l.amount || 0), 0), 0)),
    paid: round2(results.reduce(
      (s, r) => s + r.lines.filter(l => l.status === 'paid').reduce((t, l) => t + (l.amount || 0), 0), 0)),
    unknownStatus: round2(results.reduce(
      (s, r) => s + r.lines.filter(l => l.status === null).reduce((t, l) => t + (l.amount || 0), 0), 0)),
  };

  return { results, stats };
}


// ── Apply: must run inside a transaction the caller manages ──────────────────
//
// Upserts one plan per BLOCK, keyed on `source_column`, and REPLACES that plan's
// lines. Replace rather than merge because a line has no identity of its own —
// the sheet's rows are positional, so "the same line, edited" and "a different
// line in that slot" are indistinguishable, and merging would invent a history
// the source does not have.
//
// `release_id`, `match_status` and `match_order` are re-derived on a re-import
// ONLY for blocks nobody has answered — `matched_at IS NULL`. Two requirements
// pull in opposite directions here and both matter:
//
//   a block that has BECOME matchable must link on the next run. Merging two
//   duplicate releases is the ordinary fix for the 47 `duplicate_release`
//   blocks, and it is worthless if re-importing cannot then pick them up. This
//   was written update-nothing first, which made that advice false.
//
//   a block somebody has ANSWERED must never be touched. `matched_at` is
//   stamped by link / unlink / skip and by nothing else, so it is exactly the
//   flag for "a person has been here".
//
// SET-BASED, not row-by-row, and that is a requirement rather than a tidiness:
// 1,373 plans plus 7,083 lines is ~8,500 round trips, which took over two
// minutes against a hosted database. The in-app upload runs this inside one
// HTTP request, and Cloudflare would return its own error page long before it
// finished — see the note about origin 5xx in the API routes.
const LINE_CHUNK = 1000;

async function applyImport(client, results, userId = null) {
  if (!results.length) return { plansInserted: 0, plansUpdated: 0, linesWritten: 0 };

  const col = (fn) => results.map(fn);
  const { rows: planRows } = await client.query(
    `INSERT INTO release_spend_plans
       (release_id, source_header, source_column, parsed_left, parsed_right,
        match_status, match_order, suggestions, sheet_total, total_source,
        imported_at, imported_by)
     SELECT release_id, source_header, source_column, parsed_left, parsed_right,
            match_status, match_order, suggestions, sheet_total, total_source,
            NOW(), $11::int
       FROM UNNEST(
              $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
              $6::text[], $7::text[], $8::jsonb[], $9::numeric[], $10::text[]
            ) AS t(release_id, source_header, source_column, parsed_left, parsed_right,
                   match_status, match_order, suggestions, sheet_total, total_source)
     ON CONFLICT (source_column) DO UPDATE SET
       source_header = EXCLUDED.source_header,
       parsed_left   = EXCLUDED.parsed_left,
       parsed_right  = EXCLUDED.parsed_right,
       sheet_total   = EXCLUDED.sheet_total,
       total_source  = EXCLUDED.total_source,
       suggestions   = EXCLUDED.suggestions,
       imported_at   = NOW(),
       imported_by   = EXCLUDED.imported_by,
       -- Re-match ONLY the blocks nobody has answered. matched_at is stamped
       -- by link / unlink / skip and is NULL until a person acts, so this
       -- promotes a block that has become matchable since the last run (merge
       -- two duplicate releases and the next import links it) without ever
       -- overwriting somebody's decision. NOTE: no backticks in this comment --
       -- one inside a -- comment ends the enclosing JS template literal, and the
       -- error it produces points at the query rather than at the comment.
       release_id   = CASE WHEN release_spend_plans.matched_at IS NULL
                           THEN EXCLUDED.release_id   ELSE release_spend_plans.release_id   END,
       match_status = CASE WHEN release_spend_plans.matched_at IS NULL
                           THEN EXCLUDED.match_status ELSE release_spend_plans.match_status END,
       match_order  = CASE WHEN release_spend_plans.matched_at IS NULL
                           THEN EXCLUDED.match_order  ELSE release_spend_plans.match_order  END
     RETURNING id, source_column, (xmax = 0) AS inserted`,
    [
      col(r => (r.status === 'matched' ? r.releaseId : null)),
      col(r => r.header || '(no header)'),
      col(r => r.sourceColumn),
      col(r => r.left || null),
      col(r => r.right || null),
      col(r => r.status),
      col(r => r.matchOrder),
      col(r => JSON.stringify(r.suggestions || [])),
      col(r => r.sheetTotal),
      col(r => r.totalSource),
      userId,
    ]
  );

  const idByColumn = new Map(planRows.map(r => [r.source_column, r.id]));
  const plansInserted = planRows.filter(r => r.inserted).length;
  const plansUpdated = planRows.length - plansInserted;

  const planIds = planRows.map(r => r.id);
  await client.query(
    'DELETE FROM release_spend_plan_lines WHERE plan_id = ANY($1::int[])',
    [planIds]
  );

  const flat = [];
  for (const r of results) {
    const planId = idByColumn.get(r.sourceColumn);
    if (!planId) continue;
    for (const l of r.lines) flat.push([planId, l]);
  }

  for (let i = 0; i < flat.length; i += LINE_CHUNK) {
    const chunk = flat.slice(i, i + LINE_CHUNK);
    await client.query(
      `INSERT INTO release_spend_plan_lines
         (plan_id, source_row, amount, amount_raw, note, status, status_raw)
       SELECT * FROM UNNEST(
         $1::int[], $2::int[], $3::numeric[], $4::text[], $5::text[], $6::text[], $7::text[]
       )`,
      [
        chunk.map(([p]) => p),
        chunk.map(([, l]) => l.sourceRow),
        chunk.map(([, l]) => l.amount),
        chunk.map(([, l]) => l.amountRaw),
        chunk.map(([, l]) => l.note),
        chunk.map(([, l]) => l.status),
        chunk.map(([, l]) => l.statusRaw),
      ]
    );
  }

  return { plansInserted, plansUpdated, linesWritten: flat.length };
}

module.exports = {
  parseSheet,
  diff,
  loadDbState,
  applyImport,
  similarity,
  splitHeader,
  paymentStatus,
  parseAmount,
  matchKey,
  pairKey,
  norm,
  round2,
  colLetter,
  SHEET_NAME,
};
