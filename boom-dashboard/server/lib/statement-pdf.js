/**
 * Deterministic statement parsing — the fast path.
 *
 * The AI path has to WRITE every transaction as output tokens, which is why a
 * dense statement takes 6-8 minutes (316 transactions ≈ 6.4 min observed). Text
 * extraction plus rules does the same job in well under a second, because
 * nothing has to be generated.
 *
 * This is only safe because a statement can be made to prove itself. Every
 * parse is checked against the statement's OWN printed figures before it is
 * used:
 *
 *   1. beginning + Σ(signed amounts) = ending          — the whole statement
 *   2. Σ(signed amounts in section) = printed section total  — per section
 *   3. no orphan records (a date-opened record with no amount)
 *
 * If any check fails the caller discards this result and falls back to the AI
 * parse, so a layout change can only ever cost time, never correctness — the
 * worst case is that we silently stop taking the fast path.
 *
 * Bank of America and PayPal. The two documents prove themselves differently —
 * BofA against printed section totals, PayPal against a per-currency Activity
 * Summary — so each has its own parser and its own gate, and both must tie out
 * before their rows are used. Any other account returns null and keeps the AI
 * path.
 */

// pdfjs-dist directly, NOT a convenience wrapper. The obvious library here
// (pdf-parse) depends on @napi-rs/canvas — a native Skia build, ~23MB, needed
// only for rendering images we never ask for. Making a production deploy
// resolve a platform-specific native prebuild to read text is a risk with no
// upside, so the ~30 lines of layout reconstruction below are inlined instead.
// pdfjs-dist is pure JS and already the real engine underneath.
//
// The reconstruction reproduces pdf-parse's own algorithm and defaults, which
// is what the layout rules were derived against: items on the same line
// (|Δy| < 4.6) separated by more than 7 units of horizontal gap get a TAB
// between them, and hasEOL ends a line. Those tabs are the column boundaries
// the whole parser keys on — change these constants and the rules stop working
// (and, by design, the parse stops reconciling and falls back to the AI).
const LINE_THRESHOLD = 4.6;
const CELL_THRESHOLD = 7;

let pdfjsPromise;
const loadPdfjs = () => {
  // ESM-only package; dynamic import is the CJS-compatible entry point.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
};

function assemblePageText(items, viewport) {
  const buf = [];
  let lastX;
  let lastY;
  let lineHeight = 0;
  for (const item of items) {
    if (!('str' in item) || !item.transform) continue;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);

    // A y-jump larger than the current line's height is a new line even when
    // the PDF never emitted an EOL marker.
    if (lastY !== undefined && Math.abs(lastY - y) > LINE_THRESHOLD) {
      const prev = buf.length ? buf[buf.length - 1] : undefined;
      const startsNewLine = item.str.startsWith('\n') || (item.str.trim() === '' && item.hasEOL);
      if (prev !== undefined && !prev.endsWith('\n') && !startsNewLine) {
        if (Math.abs(lastY - y) - 1 > lineHeight) { buf.push('\n'); lineHeight = 0; }
      }
    }

    // Same line, but a horizontal gap — that's a column break.
    let str = item.str;
    if (lastY !== undefined && Math.abs(lastY - y) < LINE_THRESHOLD
        && lastX !== undefined && Math.abs(lastX - x) > CELL_THRESHOLD) {
      str = `\t${str}`;
    }

    buf.push(str);
    lastX = x + (item.width || 0);
    lastY = y;
    lineHeight = Math.max(lineHeight, item.height || 0);
    if (item.hasEOL) buf.push('\n');
    if (item.hasEOL || item.str.endsWith('\n')) lineHeight = 0;
  }
  return buf.join('');
}

async function extractPdfText(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // no dynamic code from an uploaded file
    useSystemFonts: false,  // we want glyph text, never system font substitution
    verbosity: 0,           // pdf.js warns constantly on real-world bank PDFs
  }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        pages.push(assemblePageText((await page.getTextContent()).items, page.getViewport({ scale: 1 })));
      } finally {
        page.cleanup();
      }
    }
    return pages.join('\n');
  } finally {
    await doc.destroy().catch(() => {});
  }
}

const money = (s) => {
  const str = String(s).replace(/[$,\s ]/g, '');
  if (!/^-?\d*\.?\d+$/.test(str)) return null;
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
};

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// BofA prints MM/DD/YY. The century is unambiguous for statement dates.
const toIso = (mdy) => {
  const m = String(mdy).trim().match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  const year = yy.length === 4 ? yy : `20${yy}`;
  return `${year}-${mm}-${dd}`;
};

const MONEY_FIELD = /^-?\$?[\d,]+\.\d{2}$/;
const DATE_FIELD = /^\d{2}\/\d{2}\/\d{2,4}$/;

// Which table a line belongs to. Rows are only collected inside the four
// transaction sections; everything else — and critically the "Daily ledger
// balances" table, whose rows look just like transactions — is skipped.
// Section headers are bare. The same words followed by a tab and a figure are
// the account-summary block, which must NOT open a section.
function sectionOf(line) {
  const l = line.trim().toLowerCase().replace(/\s*-\s*continued$/, '');
  if (/^deposits and other credits$/.test(l)) return 'deposits';
  if (/^withdrawals and other debits$/.test(l)) return 'withdrawals';
  if (/^checks$/.test(l)) return 'checks';
  if (/^service fees$/.test(l)) return 'fees';
  if (/^daily ledger balances/.test(l)) return 'ledger-balances'; // NOT transactions
  if (/^total (deposits|withdrawals|checks|service)/.test(l)) return 'end-of-section';
  return null;
}

// Page furniture that lands mid-record when a transaction straddles a page
// break. Worth dropping so it stays out of descriptions; the reconciliation
// gate is what actually protects the amounts.
const NOISE = [
  /^page \d+ of \d+$/i,
  /^date\b.*description.*amount$/i,
  /^your checking account/i,
  /^account ?#? ?[\d\s-]{6,}$/i,
  /^continued on the next page/i,
  /^subtotal for card account/i,
  // The per-page account header, which the layout reconstruction emits as ONE
  // line with its columns joined:
  //   "<HOLDER> ! Account # 1234 5678 9012 ! March 1, 2026 to March 31, 2026"
  // The bare-account-number rule above doesn't reach it because the line starts
  // with the holder name, so it was accumulated into whichever record was open
  // at the page break — 23 rows across three statements carried the header in
  // their description, which corrupts the payee for matching, learned lessons
  // and vendor rollups alike.
  //
  // Deliberately requires BOTH an account number and a statement period: a wire
  // descriptor can legitimately contain "account #", but not followed by a
  // "Month D, YYYY to Month D, YYYY" range.
  /\baccount ?#\s*[\d\s-]{6,}.*\b[a-z]+ \d{1,2}, \d{4}\s+to\s+[a-z]+ \d{1,2}, \d{4}/i,
];
const isNoise = (l) => NOISE.some((re) => re.test(l));

/**
 * A transaction is NOT one line. Long descriptors (wires especially) wrap over
 * several extracted lines, and the amount frequently sits alone on the last one:
 *
 *   05/12/26 <TAB> WIRE TYPE:BOOK IN DATE:... SNDR REF:...
 *                  ORIG:/SOME COMPANY, INC. ID:...
 *                  12,345.67
 *
 * So records are accumulated: a line whose first field is a date opens one, and
 * everything up to the next date line belongs to it. The amount is the LAST
 * whole-field money token in the record. Testing whole tab-fields rather than
 * substrings is what keeps figures embedded in descriptors — "FX:EUR 250.00
 * 1.0834" — from being mistaken for the amount.
 *
 * @returns {null|{rows, beginningBalance, endingBalance, printed, orphans}}
 *   null when this doesn't look like a BofA statement at all.
 */
function parseBofaText(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.replace(/ /g, ' '))
    .filter((l) => l.trim());

  let beginningBalance = null;
  let endingBalance = null;
  const printed = { deposits: null, withdrawals: null, checks: null, fees: null };

  // Account summary: "Beginning balance on May 1, 2026 <TAB> $12,345.67".
  // Section totals come from the summary rather than the "Total ..." footers,
  // because the summary lists all four even when a section doesn't exist — an
  // account with no checks prints "Checks 0.00" and no Checks table.
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.includes('\t')) continue;
    const last = l.split('\t').pop().trim();
    if (!MONEY_FIELD.test(last)) continue;
    if (beginningBalance == null && /^beginning balance/i.test(l)) beginningBalance = money(last);
    else if (/^ending balance/i.test(l)) endingBalance = money(last) ?? endingBalance;
    else if (printed.deposits == null && /^(total )?deposits and other credits/i.test(l)) printed.deposits = money(last);
    else if (printed.withdrawals == null && /^(total )?withdrawals and other debits/i.test(l)) printed.withdrawals = money(last);
    else if (printed.checks == null && /^(total )?checks/i.test(l)) printed.checks = money(last);
    else if (printed.fees == null && /^(total )?service fees/i.test(l)) printed.fees = money(last);
  }

  // Not a BofA statement (or extraction produced nothing usable).
  if (beginningBalance == null || endingBalance == null) return null;

  const rows = [];
  let orphans = 0; // date-opened records with no amount — a parse we can't trust
  let section = null;
  let open = null; // { date, fields[] }

  const flush = () => {
    if (!open) return;
    const rec = open;
    open = null;
    const moneyIdx = rec.fields
      .map((f, i) => (MONEY_FIELD.test(f) ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    const signed = moneyIdx == null ? null : money(rec.fields[moneyIdx]);
    if (signed == null) { orphans++; return; }
    if (signed === 0) return; // $0.00 lines carry no money and no risk
    const description = rec.fields
      .filter((_, i) => i !== moneyIdx)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    rows.push({
      txn_date: rec.date,
      description: description.slice(0, 500),
      payee_guess: '', // filled by the caller's descriptor cleaner
      payee_email: null,
      amount: Math.abs(signed),
      signed,          // reconciliation only — stripped before the rows are stored
      section: rec.section,
      direction: signed < 0 ? 'debit' : 'credit',
      currency: 'USD', // BofA statements are USD-only
      amount_usd: null,
      reference: '',
      fee: null,
    });
  };

  for (const raw of lines) {
    const l = raw.trim();
    const sec = sectionOf(l);
    if (sec) {
      // A "- continued" header inside the SAME section must not flush: a record
      // straddling the page break still has its amount on the far side.
      if (sec === 'end-of-section') { flush(); continue; }
      if (sec !== section) { flush(); section = sec; }
      continue;
    }
    if (!section || section === 'ledger-balances') continue;
    if (isNoise(l)) continue;

    const parts = l.split('\t').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;

    if (DATE_FIELD.test(parts[0])) {
      flush();
      const iso = toIso(parts[0]);
      if (!iso) continue;
      open = { date: iso, fields: parts.slice(1), section };
    } else if (open) {
      open.fields.push(...parts);
    }
  }
  flush();

  if (!rows.length) return null;
  return { rows, beginningBalance, endingBalance, printed, orphans };
}

// ── PayPal Monthly Statement Report ─────────────────────────────────────────
//
// A different document from a bank statement, and it proves itself differently.
//
// It opens with an Activity Summary: one column per currency, one row per
// component, bracketed by Beginning and Ending Available Balance —
//
//   USD        AUD        BRL        CAD
//   Beginning Available Balance   …
//   Payments received             …
//   Payments sent                 …
//   Withdrawal and Debits         …
//   Deposits and Credits          …
//   Fees                          …
//   Chargeback                    …          <- not on every statement
//   Transfers                     …
//   Ending Available Balance      …
//
// then a transaction table per currency, each introduced by
// "Transaction History - USD". That header is the ONLY thing that says which
// currency a row is in: the rows themselves carry three bare numbers
// (Gross, Fee, Net) and no code.
//
// Component rows are SUMMED, never enumerated by name. Two statements one month
// apart already differ: July has 6 currencies, June has 10 (including JPY, which
// prints no decimals) plus a Chargeback row and "Withdrawal" singular. Matching a
// fixed label list silently produced NOTHING for June — the worst failure mode,
// because it looks like a clean statement. Summing whatever sits between
// Beginning and Ending means an unfamiliar row type is included automatically.
const CUR_HEADER = /^([A-Z]{3}(?:\s+[A-Z]{3})*)$/;
// JPY prints whole numbers, so decimals are optional.
const PP_NUM = '-?\\(?\\$?[\\d,]+(?:\\.\\d{2})?\\)?';
const PP_LABEL_ROW = new RegExp(`^([A-Za-z][A-Za-z ,&/\\\\-]*?)\\s+((?:${PP_NUM})(?:\\s+${PP_NUM})*)\\s*$`);
const PP_TRIPLE = new RegExp(`(${PP_NUM})\\s+(${PP_NUM})\\s+(${PP_NUM})\\s*$`);
const PP_HISTORY = /^Transaction History\s*[-–]\s*([A-Z]{3})\b/i;
const PP_DATE = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(.*)$/;
const PP_FURNITURE = /^(Merchant Account ID|Page \d+$|Date\s+Descript|Total\b|Statement for |Balance Summary|Activity Summary)/i;

const ppNum = (s) => {
  const neg = /^\(.*\)$/.test(String(s).trim());
  const n = Number(String(s).replace(/[()$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
};

const ppIso = (mdy) => {
  const m = String(mdy).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const yy = m[3].length === 4 ? m[3] : `20${m[3]}`;
  return `${yy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};

/**
 * Activity Summary → { CUR: { beginning, ending, components } }.
 * `components` is the signed sum of every row between Beginning and Ending.
 */
function paypalActivitySummary(lines) {
  const per = {};
  let cols = null;
  let inSummary = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (/^Activity Summary/i.test(l)) { inSummary = true; cols = null; continue; }
    if (!inSummary) continue;

    const c = l.match(CUR_HEADER);
    if (c) { cols = c[1].split(/\s+/); continue; }
    if (!cols) continue;

    const m = l.match(PP_LABEL_ROW);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    const vals = m[2].trim().split(/\s+/).map(ppNum);
    if (vals.length !== cols.length) continue; // not a summary row for these columns

    cols.forEach((cur, i) => {
      const v = vals[i];
      if (v == null) return;
      const slot = (per[cur] ||= { beginning: null, ending: null, components: 0, rows: 0 });
      if (/^beginning available balance/.test(label)) slot.beginning = v;
      else if (/^ending available balance/.test(label)) slot.ending = v;
      else { slot.components += v; slot.rows++; }
    });
  }
  // Only currencies with a complete bracket are usable.
  for (const [cur, v] of Object.entries(per)) {
    if (v.beginning == null || v.ending == null) delete per[cur];
  }
  return per;
}

/**
 * @returns {null|{rows, summary, byCurrency}} null when this isn't a PayPal MSR.
 */
function parsePaypalText(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.replace(/ /g, ' ').trim())
    .filter(Boolean);

  const summary = paypalActivitySummary(lines);
  if (!Object.keys(summary).length) return null;

  const rows = [];
  let currency = null;
  let open = null;
  let orphans = 0;

  const flush = () => {
    if (!open) return;
    const rec = open;
    open = null;
    // Gross / Fee / Net are the last three numbers in the record, on whichever
    // line ends it — the ID line when there's no name, else the email line.
    let hit = null;
    for (let i = rec.parts.length - 1; i >= 0 && !hit; i--) {
      const m = rec.parts[i].match(PP_TRIPLE);
      if (m) hit = { i, m };
    }
    if (!hit) { orphans++; return; }
    const gross = ppNum(hit.m[1]);
    const fee = ppNum(hit.m[2]);
    const net = ppNum(hit.m[3]);
    if (gross == null || net == null) { orphans++; return; }

    const text0 = rec.parts
      .map((p, i) => (i === hit.i ? p.slice(0, p.length - hit.m[0].length) : p))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const email = (text0.match(/[\w.+-]+@[\w.-]+\.\w+/) || [null])[0];
    const ref = (text0.match(/\bID:\s*([A-Z0-9]+)/i) || [null, null])[1];

    // AMOUNT IS GROSS, not net.
    //
    // Gross is what the counterparty was actually invoiced or paid; the fee is a
    // separate cost, and the app has always stored it that way — matching an
    // invoice works off gross. Storing net instead put this parser 4.99 (or ~5%
    // on a foreign transfer) away from every fee-bearing row the app already
    // held: 13 rows on the February statement, which read as a permanent
    // "mismatch" until the amounts were compared side by side.
    //
    // The GATE still uses net, because net is what actually moves the balance —
    // beginning + Σ(net) = ending. So the two are kept apart deliberately: net
    // proves the parse, gross is what gets stored.
    //
    // Easy to miss: the July and June statements have no fees at all, so a check
    // against those two alone shows gross === net and hides this entirely.
    rows.push({
      txn_date: ppIso(rec.date),
      description: text0.slice(0, 500),
      payee_guess: '',
      payee_email: email,
      amount: Math.abs(gross),
      net,                            // reconciliation only — stripped before storage
      currency: rec.currency,
      direction: net < 0 ? 'debit' : 'credit',
      amount_usd: null,
      reference: ref ? ref.slice(0, 120) : null,
      fee: fee == null ? null : Math.abs(fee),
    });
  };

  for (const l of lines) {
    const th = l.match(PP_HISTORY);
    if (th) { flush(); currency = th[1].toUpperCase(); continue; }
    if (PP_FURNITURE.test(l)) { if (/^Total\b/i.test(l)) flush(); continue; }
    if (!currency) continue; // everything before the first table is summary matter

    const dm = l.match(PP_DATE);
    if (dm) { flush(); open = { date: dm[1], currency, parts: dm[2] ? [dm[2]] : [] }; continue; }
    if (open) open.parts.push(l);
  }
  flush();

  if (!rows.filter((r) => r.txn_date).length) return null;
  return { rows: rows.filter((r) => r.txn_date), summary, orphans };
}

/**
 * PayPal gate: for every currency, the parsed rows must move the balance exactly
 * as the statement says it moved.
 *
 *   beginning + Σ(row Net) = ending          — ties the ROWS to the balances
 *   beginning + Σ(components) = ending       — confirms the summary was read right
 *
 * The first check is the one that matters: a summary-only check would pass while
 * the rows were garbage.
 */
function verifyPaypal(parsed, tolerance = 0.02) {
  const { rows, summary, orphans } = parsed;
  const checks = [];
  const byCurrency = {};

  for (const [cur, s] of Object.entries(summary)) {
    const mine = rows.filter((r) => r.currency === cur);
    const netSum = mine.reduce((t, r) => t + r.net, 0);
    // JPY and other zero-decimal currencies can't be held to a cent.
    const tol = mine.some((r) => !Number.isInteger(r.net)) ? tolerance : Math.max(tolerance, 1);
    const rowDelta = s.ending - (s.beginning + netSum);
    const sumDelta = s.ending - (s.beginning + s.components);
    byCurrency[cur] = { rows: mine.length, row_delta: round2(rowDelta), summary_delta: round2(sumDelta) };
    // A currency with no table and no movement is not evidence of anything.
    if (!mine.length && Math.abs(s.components) <= tol) continue;
    checks.push({ name: `${cur}-rows`, ok: Math.abs(rowDelta) <= tol, delta: round2(rowDelta) });
    checks.push({ name: `${cur}-summary`, ok: Math.abs(sumDelta) <= tol, delta: round2(sumDelta) });
  }

  checks.push({ name: 'orphans', ok: !orphans, count: orphans });
  if (!checks.some((c) => c.name.endsWith('-rows'))) {
    checks.push({ name: 'no-verifiable-currency', ok: false });
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    byCurrency,
    rowCount: rows.length,
    reason: failed.length ? `failed: ${failed.map((f) => f.name).join(', ')}` : null,
  };
}

/**
 * Verify a deterministic parse against the statement's own printed figures.
 * Returns { ok, checks, reason } — ok:false means DISCARD and use the AI path.
 */
function verifyAgainstPrinted(parsed, tolerance = 0.02) {
  const { rows, beginningBalance, endingBalance, printed, orphans } = parsed;
  const net = rows.reduce((s, r) => s + r.signed, 0);
  const checks = [];

  // 1. The whole-statement identity. Signed throughout, so a row landing in the
  //    wrong section can't hide here.
  const delta = endingBalance - (beginningBalance + net);
  checks.push({ name: 'balance', ok: Math.abs(delta) <= tolerance, delta: round2(delta) });

  // 2. Per-section totals. These localise a failure — "we lost deposits" is a
  //    very different bug from "we double-counted fees" — and catch the case
  //    where two sections are off by equal and opposite amounts.
  for (const [key, section] of [['deposits', 'deposits'], ['withdrawals', 'withdrawals'], ['checks', 'checks'], ['fees', 'fees']]) {
    if (printed[key] == null) continue;
    const got = rows.filter((r) => r.section === section).reduce((s, r) => s + r.signed, 0);
    // The summary prints outflows negative; compare signed sums directly.
    const d = got - printed[key];
    checks.push({ name: key, ok: Math.abs(d) <= tolerance, delta: round2(d) });
  }

  // 3. Orphans mean the record accumulator lost an amount. Even if the sums
  //    happen to tie out, we don't trust a parse that dropped a transaction.
  checks.push({ name: 'orphans', ok: !orphans, count: orphans });

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    rowCount: rows.length,
    reason: failed.length ? `failed: ${failed.map((f) => f.name).join(', ')}` : null,
  };
}

/**
 * Fast path entry point.
 * @returns {null} for accounts with no rules (fall back to the AI)
 * @returns {{ok:false, verdict}} parsed but didn't reconcile (fall back to the AI)
 * @returns {{ok:true, verdict, rows, beginningBalance, endingBalance}} trustworthy
 */
let warnedNoCanvas = false;

async function parseStatementPdfText(buffer, account) {
  if (account !== 'bofa' && account !== 'paypal') return null; // no rules for it
  let parsed;
  try {
    const text = await extractPdfText(buffer);
    if (account === 'paypal') {
      const pp = parsePaypalText(text);
      if (!pp) return null;
      const verdict = verifyPaypal(pp);
      if (!verdict.ok) return { ok: false, verdict };
      // `net` exists only for reconciliation; don't leak it into stored rows.
      const rows = pp.rows.map(({ net, ...row }) => row);
      // A PayPal balance is normally swept to the bank, so beginning/ending are
      // usually 0.00 — real, not a parse failure. Report the USD bracket when
      // there is one, since that is the account the app tracks.
      const usd = pp.summary.USD || {};
      return {
        ok: true,
        verdict,
        rows,
        beginningBalance: usd.beginning ?? null,
        endingBalance: usd.ending ?? null,
      };
    }
    parsed = parseBofaText(text);
  } catch (err) {
    // pdfjs-dist v5 needs @napi-rs/canvas even to read text, and it's an
    // OPTIONAL dependency — deliberately, so a platform with no prebuild can't
    // fail the deploy. The cost is that the fast path would then be silently
    // unavailable forever, so say it out loud once. Everything still works; it
    // just goes back to taking minutes per statement via the AI.
    if (!warnedNoCanvas && /DOMMatrix|@napi-rs\/canvas|ImageData|Path2D/.test(String(err && err.message))) {
      warnedNoCanvas = true;
      console.error('[parse] FAST PATH DISABLED: pdfjs-dist could not initialise because the optional '
        + '@napi-rs/canvas native package is missing for this platform. Statement parsing will fall back '
        + 'to the AI (minutes per statement instead of milliseconds). Fix: ensure `npm install` in server/ '
        + 'installs @napi-rs/canvas for the deploy platform.');
    }
    return null;
  }
  if (!parsed) return null;

  const verdict = verifyAgainstPrinted(parsed);
  if (!verdict.ok) return { ok: false, verdict };

  // `signed` and `section` exist only for reconciliation; don't leak them into
  // the rows the caller stores.
  const rows = parsed.rows.map(({ signed, section, ...row }) => row);
  return {
    ok: true,
    verdict,
    rows,
    beginningBalance: parsed.beginningBalance,
    endingBalance: parsed.endingBalance,
  };
}

module.exports = { parseStatementPdfText, parseBofaText, verifyAgainstPrinted, extractPdfText,
  parsePaypalText, verifyPaypal, paypalActivitySummary };
