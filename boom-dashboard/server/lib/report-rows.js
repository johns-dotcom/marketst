/**
 * The row model behind BOTH report exports — Excel and Google Sheets.
 *
 * Why this exists rather than each exporter building its own rows: the two
 * outputs are the same report. If Sheets composed its own rows, the first change
 * to either would silently desynchronise them, and the failure mode is the worst
 * kind — two files that both look authoritative and disagree, with nothing on
 * screen to say which is stale. An accountant filing from one of them has no way
 * to tell. Same argument as lib/reversal-pairs.js and lib/vendor-aliases.js: one
 * definition, many renderers.
 *
 * A row is deliberately dumb — a label, some values, and a KIND. All styling
 * decisions belong to the renderer, because ExcelJS and the Sheets API express
 * them completely differently (numFmt strings vs numberFormat objects, row.font
 * vs repeatCell requests). What the model guarantees is that both produce the
 * SAME CELLS: same labels, same numbers, same order, same blanks.
 *
 * Label strings carry their own indentation ("  Legal", "    A/R aging — …").
 * That looks crude next to an indent level, and it is on purpose: it makes
 * cell-for-cell equality between the two exports checkable by string compare,
 * with no renderer-specific indent logic to get subtly wrong.
 *
 * One exception to "no styling in the model": SECTION rows carry a font `size`.
 * The P&L sets 11 and the balance sheet 12, which is not a principled
 * distinction — it is just what the existing workbooks do. Encoding it here
 * keeps the extraction a pure refactor of the Excel output instead of quietly
 * restyling a file people already read.
 */

const KIND = {
  TITLE:    'title',       // report name, large
  SUBTITLE: 'subtitle',    // range / as-of / generated stamp, small grey
  BLANK:    'blank',       // spacer
  HEADER:   'header',      // column header band
  SECTION:  'section',     // Income / Expenses / Assets … (carries `size`, see below)
  LINE:     'line',        // label + money values
  NOTE:     'note',        // small italic caveat, travels WITH the numbers
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const sum = (perMonth) => Object.values(perMonth || {}).reduce((a, b) => a + b, 0);

/**
 * P&L rows.
 *
 * @param {object} pnl   the buildPnl() result
 * @param {object} opts  {from, to, artist, generated}
 * @returns {{widths:number[], freeze:{rows:number,cols:number}, valueCols:number, rows:Array}}
 */
function pnlRows(pnl, opts = {}) {
  const { from, to, artist } = opts;
  const generated = opts.generated || todayIso();
  const months = pnl.months || [];
  const rows = [];

  const line = (label, perMonth, total, bold = false) => rows.push({
    kind: KIND.LINE,
    label,
    values: [...months.map((m) => perMonth[m] || 0), total],
    bold,
  });
  const note = (text) => rows.push({ kind: KIND.NOTE, label: `    ${text}` });
  const usdText = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  // The basis line has to be TRUE of the figures underneath it. Plain
  // "statement-verified cash basis" means every number sits in the month its
  // bank statement puts it in; once any row has been reassigned to another
  // month that claim is false, and an accountant reading this file has no other
  // way to find that out. So the label follows the data.
  //
  // This is not the disclosure block John removed from the exports — it names
  // nothing and lists nothing. It is the report stating its own basis, and it
  // disappears again by itself when there are no adjustments in the period.
  const adjusted = Number(pnl.reassigned?.count) > 0;
  const basis = adjusted
    ? 'cash basis, statement-verified, with recorded period adjustments'
    : 'statement-verified cash basis';
  rows.push({ kind: KIND.TITLE, label: `Profit & Loss — ${basis}${artist ? ` — ${artist}` : ''}` });
  rows.push({ kind: KIND.SUBTITLE, label: `${from} → ${to} · generated ${generated}` });
  rows.push({ kind: KIND.BLANK, label: '' });
  rows.push({ kind: KIND.HEADER, label: '', values: [...months, 'Total'] });

  rows.push({ kind: KIND.SECTION, label: 'Income', size: 11 });
  for (const [type, perMonth] of Object.entries(pnl.income || {}).sort()) {
    line(`  ${type}`, perMonth, sum(perMonth));
  }
  line('Total Income', pnl.income_totals.series, pnl.income_totals.total, true);

  rows.push({ kind: KIND.BLANK, label: '' });
  rows.push({ kind: KIND.SECTION, label: 'Expenses', size: 11 });
  for (const [cat, perMonth] of Object.entries(pnl.expenses || {}).sort()) {
    line(`  ${cat}`, perMonth, sum(perMonth));
  }
  line('Total Expenses', pnl.expense_totals.series, pnl.expense_totals.total, true);

  rows.push({ kind: KIND.BLANK, label: '' });
  line('Net Income (operating)', pnl.net.series, pnl.net.total, true);

  // Recoveries are netted into the expense they recover, so the gross has to be
  // recoverable from the file — otherwise "Marketing 1,900,109" is
  // indistinguishable from 1,900,109 of gross spend and the netting can't be
  // checked by anyone reading it.
  const contra = pnl.contra || {};
  if (Object.keys(contra).length) {
    rows.push({ kind: KIND.BLANK, label: '' });
    for (const [target, info] of Object.entries(contra).sort()) {
      const sources = Object.keys(info.from || {}).join(', ');
      note(`${target} is shown net of ${usdText(info.total)} recovered${sources ? ` (${sources})` : ''}.`);
    }
  }

  // One-off asset dispositions. Below Net Income deliberately: a single catalog
  // sale would otherwise make its month read as the best trading month of the
  // year, and a reader building a run-rate would have to strip it out by hand.
  const nonRec = pnl.non_recurring;
  if (nonRec && (Object.keys(nonRec.income || {}).length || Object.keys(nonRec.expenses || {}).length)) {
    rows.push({ kind: KIND.BLANK, label: '' });
    rows.push({ kind: KIND.SECTION, label: 'Non-recurring — asset sales & one-offs', size: 11 });
    for (const [type, perMonth] of Object.entries(nonRec.income).sort()) {
      line(`  ${type} (in)`, perMonth, sum(perMonth));
    }
    for (const [cat, perMonth] of Object.entries(nonRec.expenses).sort()) {
      line(`  ${cat} (out)`, perMonth, sum(perMonth));
    }
    line('Non-recurring net', nonRec.net.series, nonRec.net.total, true);
    note('Excluded from Net Income above — one-time dispositions, not trading revenue. Strip these out of any run-rate.');
  }

  const below = pnl.below;
  if (below && (Object.keys(below.income || {}).length || Object.keys(below.expenses || {}).length)) {
    rows.push({ kind: KIND.BLANK, label: '' });
    rows.push({ kind: KIND.SECTION, label: 'Below the line — advances & pass-through', size: 11 });
    for (const [type, perMonth] of Object.entries(below.income).sort()) {
      line(`  ${type} (in)`, perMonth, sum(perMonth));
    }
    for (const [cat, perMonth] of Object.entries(below.expenses).sort()) {
      line(`  ${cat} (out)`, perMonth, sum(perMonth));
    }
    line('Below-line net', below.net.series, below.net.total, true);
  }

  // Net Change in Cash sums EVERY section — operating, non-recurring and
  // below-line. That is what makes the report tie back to what the bank
  // actually did; omitting a section here would leave the statement's own
  // bottom line disagreeing with the statements it was built from.
  const hasBelow = below && (Object.keys(below.income || {}).length || Object.keys(below.expenses || {}).length);
  const hasNonRec = nonRec && (Object.keys(nonRec.income || {}).length || Object.keys(nonRec.expenses || {}).length);
  if (hasBelow || hasNonRec) {
    rows.push({ kind: KIND.BLANK, label: '' });
    const cashSeries = {};
    for (const m of months) {
      cashSeries[m] = (pnl.net.series[m] || 0)
        + (hasNonRec ? (nonRec.net.series[m] || 0) : 0)
        + (hasBelow ? (below.net.series[m] || 0) : 0);
    }
    const cashTotal = pnl.net.total
      + (hasNonRec ? nonRec.net.total : 0)
      + (hasBelow ? below.net.total : 0);
    line('Net Change in Cash', cashSeries, cashTotal, true);
  }

  // The P&L export is bank figures only, by John's decision (2026-08-07).
  //
  // Two blocks used to sit at the end and were removed together: "Not counted —
  // no bank evidence" (ledger entries marked Paid that no bank row vouches for)
  // and "Excluded from the figures above" (item dismissals, standing category
  // rules, and reversal pairs).
  //
  // Stating the cost plainly, because it is real and it is not visible from the
  // file: the totals here already have those exclusions netted out, and nothing
  // in the file now says so. A reader cannot tell from the spreadsheet alone
  // that anything was removed. The ON-SCREEN report still discloses all of it —
  // the dismissal banner, the reversal banner and the "not counted" section are
  // untouched — so the disclosure exists, just not in the export.
  //
  // Do not reinstate without asking; this was a deliberate call, not an
  // oversight. It now applies to the Google Sheet too, which is the point of
  // the decision living in the shared model rather than in one renderer.

  return {
    widths: [32, ...months.map(() => 13), 14],
    freeze: { rows: 4, cols: 1 },   // title, subtitle, blank, header
    valueCols: months.length + 1,
    rows,
  };
}

/**
 * Balance-sheet rows.
 *
 * The notes are not decoration. The aging profile and the "gross, not netted"
 * qualification are what make the A/R and A/P figures readable; an earlier
 * version of the workbook dropped both and the numbers were misleading without
 * them. They travel with the numbers in every renderer.
 *
 * @param {object} bs    the buildBalanceSheet() result
 * @param {object} opts  {asOf, ymd} — ymd formats the per-account statement date
 */
function balanceSheetRows(bs, opts = {}) {
  const asOf = opts.asOf;
  const ymd = opts.ymd || ((d) => String(d).slice(0, 10));
  const rows = [];

  const section = (label) => rows.push({ kind: KIND.SECTION, label, size: 12 });
  const line = (label, val, bold = false) => rows.push({ kind: KIND.LINE, label, values: [val], bold });
  const note = (text) => rows.push({ kind: KIND.NOTE, label: `    ${text}` });

  // Notes are text cells, so they need their own money rendering — the
  // renderers' number formats do not reach inside a string.
  const usdText = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  // Composition of a line, one indented row per category / client / source.
  //
  // ALWAYS expanded in the file. On screen these are collapsed behind a caret,
  // but a spreadsheet has no caret and detail is the reason someone asks for
  // the file — an export that hid it would be strictly worse than the screen.
  //
  // The server builds each breakdown from the same rows as its line total, so
  // these sum to the line above them by construction.
  const composition = (block) => {
    for (const b of block?.breakdown || []) {
      line(`      ${b.key}`, b.total);
    }
  };
  const aging = (label, block) => {
    if (!block?.aging) return;
    const a = block.aging;
    note(`${label} aging — current ${usdText(a.current)} · 31-60 ${usdText(a.d60)} · 61-90 ${usdText(a.d90)} · 90+ ${usdText(a.over90)}`);
  };

  rows.push({ kind: KIND.TITLE, label: 'Balance Sheet' });
  rows.push({ kind: KIND.SUBTITLE, label: `As of ${asOf}` });
  rows.push({ kind: KIND.BLANK, label: '' });

  // ── Excluded lines must not print ───────────────────────────────────────────
  //
  // buildBalanceSheet zeroes an excluded line out of the section total but
  // leaves the line object holding its full amount. Rendering that amount
  // anyway produced a workbook that DID NOT ADD UP — Cash 438,945 + A/R 5,500
  // printed under a Total Assets of 438,945 — so anyone summing the column got
  // a different answer than the statement claimed. Skip the line, its aging and
  // its note together; a stranded aging profile describing a line that isn't
  // there is its own kind of wrong.
  //
  // Nothing marks the absence, by the standing decision that exports carry
  // figures and the screen carries the disclosure banner. The cost is real and
  // worth restating: a reader of the file alone cannot tell a line was removed.
  // What they can now do is add the column up and have it agree.
  const arExcluded = !!bs.assets.accounts_receivable?.excluded;
  const apExcluded = !!bs.liabilities.accounts_payable?.excluded;

  section('Assets');
  // Cash needs no test here — buildBalanceSheet drops excluded accounts from
  // `assets.cash` before this model ever sees them.
  for (const c of bs.assets.cash) {
    line(`  Cash — ${c.account.toUpperCase()} (at ${ymd(c.as_of)} statement close)`, c.balance);
  }
  note('Cash is each account\'s last statement close on or before the as-of date, not a rolled-forward balance.');
  if (!arExcluded) {
    line('  Accounts Receivable', bs.assets.accounts_receivable.total);
    composition(bs.assets.accounts_receivable);
    aging('A/R', bs.assets.accounts_receivable);
    if (bs.assets.accounts_receivable?.note) note(bs.assets.accounts_receivable.note);
  }
  line('Total Assets', bs.assets.total, true);

  rows.push({ kind: KIND.BLANK, label: '' });
  section('Liabilities');
  if (!apExcluded) {
    line('  Accounts Payable', bs.liabilities.accounts_payable.total);
    composition(bs.liabilities.accounts_payable);
    aging('A/P', bs.liabilities.accounts_payable);
    if (bs.liabilities.accounts_payable?.note) note(bs.liabilities.accounts_payable.note);
  }
  line('Total Liabilities', bs.liabilities.total, true);
  note('Liabilities are unpaid invoices. Drawdowns are funding, not debt, and are reported below.');

  rows.push({ kind: KIND.BLANK, label: '' });
  const netAssets = bs.net_assets?.total ?? bs.equity?.total ?? 0;
  line('Net Assets (Assets − Liabilities)', netAssets, true);

  // Funded by. Drawdowns moved out of Liabilities here (2026-08-07): stacking
  // $4.73M of funding next to $762k of unpaid invoices reported liabilities of
  // $5.49M and made "what do we owe" unanswerable. This block answers the more
  // useful question — of everything put in, how much is left.
  // `hidden` turns the section off entirely — in the workbook as well as on
  // screen, so the file matches what you were looking at when you exported it.
  // Net Assets above remains the closing line, which stands on its own.
  const f = bs.funding?.hidden ? null : bs.funding;
  if (f) {
    rows.push({ kind: KIND.BLANK, label: '' });
    section('Funded by');
    // Same rule as A/R and A/P above: an excluded drawdown line is left out
    // entirely rather than printed against a total that no longer contains it.
    // The block still ties without it — the deficit is Net Assets − 0, and the
    // total is 0 + deficit.
    if (!f.drawdowns?.excluded) {
      line('  Drawdowns received', f.drawdowns.total);
      composition(f.drawdowns);
      if (f.drawdowns.note) note(f.drawdowns.note);
    }
    line('  Accumulated deficit', f.accumulated_deficit.total);
    line('Total', f.total, true);
    note('The deficit is derived as Net Assets − Drawdowns, so this block always sums. It is a presentation, not a proof.');
    if (f.memo?.recoupable?.count > 0) {
      const m = f.memo.recoupable;
      note(`Memo — ${usdText(m.total)} of recoupable artist spend across ${m.count} entries. Not counted as an asset here.`);
    }
  }

  return {
    widths: [40, 18],
    freeze: { rows: 0, cols: 0 },
    valueCols: 1,
    rows,
  };
}

/**
 * Spend by artist — the executive breakdown.
 *
 * One row per artist, columns = spend categories, ranked by total. Then the
 * unattributed remainder, then a TOTAL SPEND line that equals the P&L's
 * operating expense.
 *
 * Two things here are not decoration:
 *
 * 1. UNATTRIBUTED IS A LINE, NOT A FOOTNOTE. On live data only ~29% of counted
 *    operating spend names an artist; the rest is ad platforms, travel, bank
 *    fees and transfers that will never belong to one. A ranked list without
 *    that line invites the reader to treat the artists as the whole of spending.
 *
 * 2. THE RECONCILIATION BLOCK. Anyone who has seen the ledger remembers a much
 *    larger number, because this basis deliberately excludes advances and other
 *    below-the-line items, person-dismissed rows, reversal pairs that never
 *    moved money, and Paid ledger rows with no bank line behind them. The sheet
 *    bridges from its own total to that one instead of leaving the gap to be
 *    discovered mid-meeting.
 *
 * @param {object} data  the /reports/spend-by-artist payload
 * @param {object} opts  {from, to, generated, topN}
 */
function spendByArtistRows(data, opts = {}) {
  const { from, to } = opts;
  const generated = opts.generated || todayIso();
  const money = (n) => Number(n || 0);
  const usdText = (n) => `$${money(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  const all = data.artists || [];
  const topN = opts.topN && opts.topN > 0 ? opts.topN : 0;
  const shown = topN ? all.slice(0, topN) : all;
  const tail = topN ? all.slice(topN) : [];
  const un = data.unattributed || {};

  // ── Only the columns that carry money ───────────────────────────────────────
  //
  // The sheet used to render every category in the vocabulary. Measured on the
  // live export: 29 columns × 94 artists = 2,726 cells, 94.1% of them $0.00, and
  // TWELVE columns with no spend at all — Rent, Travel, Bank Fees, Utilities and
  // the rest, present because the category exists, not because anything was
  // spent. That is what made it unreadable: the numbers that matter were a
  // scattering of islands in a field of zeros.
  //
  // Columns are kept only if some artist (or the unattributed line) has spend in
  // them, and ordered by size, so the biggest sit next to the frozen artist
  // column where the eye lands.
  // Columns come from ARTIST spend only, deliberately.
  //
  // Including the unattributed line's categories keeps every column alive — Rent,
  // Bank Fees, Utilities all have label-level spend — and re-fills the grid with
  // 94 blank artist cells apiece for one number at the bottom. This sheet answers
  // "what did we spend on each artist"; the unattributed line's own split is the
  // P&L's job, and it says so below rather than dragging twelve columns along.
  const catTotals = new Map();
  for (const c of (data.categories || [])) catTotals.set(c, 0);
  for (const a of all) {
    for (const [c, v] of Object.entries(a.by_category || {})) {
      catTotals.set(c, (catTotals.get(c) || 0) + money(v));
    }
  }
  const live = [...catTotals.entries()]
    .filter(([, v]) => Math.abs(v) > 0.005)
    .sort((a, b) => b[1] - a[1]);

  // NO FOLDING. This sheet used to keep only the columns carrying 1% of artist
  // spend and roll the rest into "Other categories" — the right call for a
  // screen, and the wrong one for the document John hands to an accountant, who
  // needs to see the category a specific payment landed in rather than a bucket
  // whose contents are described in a footnote.
  //
  // So every category that carries money gets its own column. Columns that are
  // empty for EVERY artist and for the overhead line are still left out: a column
  // of nothing is not information, and the note says how many were dropped so
  // nothing goes quietly missing.
  const liveTotal = live.reduce((s, [, v]) => s + Math.abs(v), 0);
  const usedBy = (c) => all.filter((a) => Math.abs(money(a.by_category?.[c])) > 0.005).length;
  const keep = live;
  const folded = [];
  const cats = live.map(([c]) => c);
  const byCatFolded = (byCat) => byCat || {};

  const rows = [];
  // Zero renders as BLANK, not "$0.00". 2,565 zeros is not information, and a
  // reader scanning for the figure that matters should meet white space, not a
  // wall of decimals.
  const cell = (v) => (Math.abs(money(v)) > 0.005 ? money(v) : '');
  // TOTAL FIRST, then categories. The artist's total is the number anyone opens
  // this for; it used to sit past 29 columns of mostly nothing, off the screen.
  //
  // ── Advances ride in their own column, not inside Total ──
  // An advance is recoupable — money the label expects back — so folding it into
  // spend would stop this sheet answering "what did we spend that we can't get
  // back". But it is also the biggest artist-attributable outflow there is
  // ($1,482,835 against $3,302,854 of operating spend), and it used only to
  // appear as one excluded line in the bridge at the bottom. So: Total stays
  // operating and keeps tying to the P&L, Advances sits beside it, and Total out
  // is what the artist actually cost in cash.
  const line = (label, byCat, total, bold = false, advance = 0) => rows.push({
    kind: KIND.LINE,
    label,
    values: [cell(total), cell(advance), cell(money(total) + money(advance)),
      ...cats.map((c) => cell(byCat?.[c]))],
    bold,
  });
  // Blanks across every value column, for the rows that carry one figure.
  const pad = () => [...cats.map(() => ''), '', ''];
  const note = (text) => rows.push({ kind: KIND.NOTE, label: `    ${text}` });

  rows.push({ kind: KIND.TITLE, label: 'Spend by Artist — statement-verified cash basis' });
  rows.push({ kind: KIND.SUBTITLE, label: `${from} → ${to} · generated ${generated}` });

  // What the reader's first question actually is: is this all the spending?
  rows.push({ kind: KIND.BLANK, label: '' });
  rows.push({ kind: KIND.SECTION, label: 'Summary', size: 11 });
  note(`${usdText(data.attributed_total)} of ${usdText(data.total)} names an artist `
     + `(${data.coverage_pct}%), across ${all.length} artists.`);
  note(`The rest — ${usdText(un.total)} — is label overhead and spend not yet matched to an invoice.`);
  if (money(data.advances?.total)) {
    note(`Advances are shown SEPARATELY, in their own column: ${usdText(data.advances.total)} across `
       + `${(data.advances.artists || []).length} artists. They are recoupable — money the label `
       + `expects back — so they are not in Total; "Total out" adds the two. Total alone is the `
       + 'figure that ties to the P&L operating expense line.');
  }
  note(`Every artist is listed, and every category carrying artist spend has its own column `
     + `— ${all.length} rows × ${cats.length} categories, nothing folded or truncated.`);
  const emptyCats = (data.categories || []).length - live.length;
  if (emptyCats > 0) {
    note(`${emptyCats} categor${emptyCats === 1 ? 'y' : 'ies'} in the vocabulary carr${emptyCats === 1 ? 'ies' : 'y'} `
       + 'no artist spend in this window and would be a column of blanks, so they are not shown; '
       + 'the overhead breakdown below lists every category with money in it.');
  }
  const oneArtist = cats.filter((c) => usedBy(c) === 1).length;
  if (oneArtist) {
    note(`${oneArtist} of those columns belong to a single artist each — expected on a label `
       + 'where one-off costs sit against one release.');
  }

  rows.push({ kind: KIND.BLANK, label: '' });
  rows.push({ kind: KIND.HEADER, label: 'Artist', values: ['Total', 'Advances', 'Total out', ...cats] });

  rows.push({ kind: KIND.SECTION, label: 'Artist-attributed spend', size: 11 });
  for (const a of shown) line(`  ${a.name}`, byCatFolded(a.by_category), a.total, false, a.advances);
  if (tail.length) {
    const tailCats = {};
    let tailTotal = 0;
    let tailAdv = 0;
    for (const a of tail) {
      tailTotal += money(a.total);
      tailAdv += money(a.advances);
      for (const [c, v] of Object.entries(byCatFolded(a.by_category))) tailCats[c] = (tailCats[c] || 0) + money(v);
    }
    line(`  Other artists (${tail.length})`, tailCats, tailTotal, false, tailAdv);
  }
  line('Total artist-attributed', {}, data.attributed_total, true,
    data.advances?.attributed_total || 0);

  rows.push({ kind: KIND.BLANK, label: '' });
  rows.push({ kind: KIND.SECTION, label: 'Not attributed to an artist', size: 11 });
  line('  Label overhead & unmatched spend', {}, un.total, true,
    data.advances?.unattributed || 0);
  note('Ad platforms, travel, bank fees, transfers and any bank debit not yet matched to an '
     + 'invoice. Most of this will never belong to a single artist.');
  note('Placeholder artist values (N/A, NA, Unknown, TBD …) are counted here, not as artists.');

  // BROKEN OUT BY CATEGORY, because this is the biggest number on the sheet —
  // three quarters of reported spend — and a single figure that large invites
  // exactly one question, which the sheet then couldn't answer. It used to say
  // "the breakdown is on the P&L", which is a reference, not an explanation.
  //
  // As ROWS, not columns. The grid's columns come from artist spend, and 12 of
  // these categories have none — Rent, Bank Fees, Utilities, Credit Card and the
  // rest — so adding them as columns would bring back the wall of blank cells
  // this sheet was rebuilt to remove (94 empty artist cells apiece, for one
  // line at the bottom). Money sits in the Total column, the same shape the
  // "What this total excludes" bridge below already uses.
  const unCats = Object.entries(un.by_category || {})
    .map(([c, v]) => [c, money(v)])
    .filter(([, v]) => Math.abs(v) > 0.005)
    .sort((a2, b2) => b2[1] - a2[1]);
  if (unCats.length) {
    rows.push({ kind: KIND.BLANK, label: '' });
    note('What it consists of:');
    for (const [c, v] of unCats) {
      rows.push({ kind: KIND.LINE, label: `    ${c}`, values: [v, ...pad()] });
    }
    // Stated, not left to be added up: the reader's next question after "what is
    // it" is "is it a few things or a long tail", and this sheet can answer it.
    const head = unCats.slice(0, 6);
    const headSum = head.reduce((n, [, v]) => n + v, 0);
    const pct = money(un.total) ? Math.round((headSum / money(un.total)) * 100) : 0;
    note(`The top ${head.length} — ${head.map(([c]) => c).join(', ')} — are ${pct}% of it.`);
    const noArtistCats = unCats.filter(([c]) => !cats.includes(c));
    if (noArtistCats.length) {
      note(`${noArtistCats.length} of these ${unCats.length} categories have no artist spend at all `
         + `(${usdText(noArtistCats.reduce((n, [, v]) => n + v, 0))}), which is why they are listed `
         + 'here rather than appearing as columns above.');
    }
  }

  rows.push({ kind: KIND.BLANK, label: '' });
  line('TOTAL SPEND', {}, data.total, true, data.advances?.total || 0);
  if (money(data.advances?.unattributed)) {
    note(`${usdText(data.advances.unattributed)} of the advances name no artist yet — they are on `
       + 'the overhead line above, and the recoupment audit lists them individually.');
  }

  // The bridge. Every figure here is EXCLUDED from the total above.
  const ex = data.excluded || {};
  // Advance-aware: with advances shown in their own column, the below-line
  // figure that is still EXCLUDED is only the rest of that section.
  const belowExcluded = data.advances ? money(data.advances.other_total) : money(ex.below_line);
  const anyExcluded = belowExcluded || money(ex.non_recurring)
    || money(ex.dismissed?.total) || money(ex.reversals?.total) || money(ex.unverified?.total);
  if (anyExcluded) {
    rows.push({ kind: KIND.BLANK, label: '' });
    rows.push({ kind: KIND.SECTION, label: 'What this total excludes', size: 11 });
    note('This is operating spend on the statement-verified cash basis. The ledger\'s "paid" '
       + 'figure is larger, for these reasons:');
    // Money in the TOTAL column (now column 2), blanks across the categories.
    const ln = (label, v) => rows.push({ kind: KIND.LINE, label: `  ${label}`,
      values: [money(v), ...pad()] });
    // Advances are IN the sheet now, in their own column, so excluding them here
    // as well would tell the reader the same money is both shown and not shown.
    // Only the rest of the below-line section is excluded.
    if (data.advances) {
      if (money(data.advances.other_total)) {
        ln('Below-the-line, other (partner draws, reimbursements)', data.advances.other_total);
      }
    } else if (money(ex.below_line)) {
      ln('Below-the-line (artist advances, drawdowns)', ex.below_line);
    }
    if (money(ex.non_recurring))    ln('Non-recurring / one-off items', ex.non_recurring);
    if (money(ex.dismissed?.total)) ln(`Excluded by review (${ex.dismissed.count} items)`, ex.dismissed.total);
    if (money(ex.reversals?.total)) ln(`Reversal pairs — money that never moved (${ex.reversals.count} pairs)`, ex.reversals.total);
    if (money(ex.unverified?.total)) ln(`Paid in the ledger, no bank line (${ex.unverified.count} rows)`, ex.unverified.total);
    note('"Excluded by review" is transfers and internal movements someone judged not to be '
       + 'operating spend; each one is listed on the P&L with its reason.');
    note('The last line is a reconciliation backlog, not a decision — those rows are shown on '
       + 'the P&L but never counted, because no statement vouches for them.');
  }

  return {
    // Artist names run long; the Total column is the one people read; category
    // widths follow their header, which is why "Unorganized (not yet booked)"
    // used to be truncated to "Unorganized (not yet b…".
    // The label column is sized from the labels it actually holds, not from a
    // number someone picked once: a 52-character line next to a figure in
    // column B has nowhere to overflow to, so it is simply cut off mid-word.
    // Capped, because one very long label should not push the grid off-screen.
    widths: [Math.max(34, Math.min(52, Math.max(...rows
      .filter((r) => r.kind === KIND.LINE)
      .map((r) => String(r.label || '').length + 2), 34))),
    16, 14, 14, ...cats.map((c) => Math.max(13, Math.min(26, c.length + 3)))],
    // Freeze BELOW the header wherever it landed. Hardcoding a row number here
    // would be wrong the moment a conditional note above it is absent — and a
    // frozen pane one row out is the kind of defect nobody reports, they just
    // stop trusting the sheet.
    freeze: { rows: rows.findIndex((r) => r.kind === KIND.HEADER) + 1, cols: 2 },
    valueCols: cats.length + 3,
    rows,
  };
}

module.exports = { KIND, pnlRows, balanceSheetRows, spendByArtistRows };
