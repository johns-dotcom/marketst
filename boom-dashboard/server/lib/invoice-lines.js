/**
 * Line items off a multi-line invoice — deterministically, with the printed
 * total as the checksum.
 *
 * ── Why rules and not the AI ──
 * A reimbursement sheet like "Market Street x Dean St — JANUARY 2026" is 20 numbered rows
 * of somebody else's spending: a PayPal subscription, five Grammy ride-shares,
 * eight items for one artist's event, an exec coffee. Filed as ONE expense it is
 * a $2,564.38 blob with a single category and a single artist, which is wrong for
 * 19 of the 20 lines however you pick them.
 *
 * The amounts are the part that must never be wrong, so the amounts do not go
 * near a language model. They are read from the text, and the sheet's own printed
 * TOTAL is the check: Σ lines must equal it to the cent or this returns
 * `reconciles: false` and says so. Same safety argument as the statement fast
 * path in lib/statement-pdf.js — a layout change can cost us the parse, never
 * correctness.
 *
 * The model's job is narrower and safe to get wrong: propose a CATEGORY and an
 * ARTIST per line. A bad guess mislabels a row a person is already reviewing; it
 * cannot move a number.
 */

// Money as its own whole field: "$1,234.56" or "1234.56". Anchored, so a figure
// buried in prose ("paid $20 toward") is not mistaken for the line's amount.
const MONEY_RE = /^\$?\(?-?([\d,]+\.\d{2})\)?$/;
const asMoney = (s) => {
  const m = String(s == null ? '' : s).trim().match(MONEY_RE);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// A leading "1", "2." or "17)" is what makes a row a LINE ITEM rather than a
// header, a note or the signature block. Requiring it is what keeps
// "TOTAL: $2,564.38" and "REVIEWED BY: …" out of the list.
const ROW_NUM_RE = /^(\d{1,3})[.)]?$/;

// A date that may lead the vendor cell ("01/13/26 Fedex", "1/27 Uber"). The year
// is optional because these sheets are inconsistent about it.
const LEADING_DATE_RE = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.*)$/;

/**
 * @param {string} text  tab-delimited text from extractPdfText
 * @returns {{
 *   lines: Array<{n:number,date:string|null,vendor:string|null,description:string,note:string|null,amount:number}>,
 *   printed_total: number|null,
 *   line_total: number,
 *   reconciles: boolean,
 *   reason: string|null
 * }}
 */
function parseInvoiceLines(text) {
  const rows = String(text || '').split('\n');
  const lines = [];
  let printedTotal = null;
  // Notes wrap onto their own lines under the row they belong to ("Oxis requested
  // we printed additional…"), so an unnumbered line right after a line item is
  // attached to it rather than dropped.
  let lastItem = null;

  for (const raw of rows) {
    const fields = raw.split('\t').map((f) => f.trim()).filter((f) => f !== '');
    if (!fields.length) continue;

    // The printed total, wherever it sits. Taken as the LAST money field on the
    // row so "TOTAL: | $2,564.38" and "TOTAL | 20 items | $2,564.38" both read.
    if (/^total\b/i.test(fields[0])) {
      const money = fields.map(asMoney).filter((v) => v !== null);
      if (money.length) printedTotal = money[money.length - 1];
      lastItem = null;
      continue;
    }

    const numMatch = fields[0].match(ROW_NUM_RE);
    if (!numMatch) {
      // A continuation note for the row above — only prose, never a figure, so a
      // stray money row can't be silently folded into someone else's line.
      if (lastItem && fields.every((f) => asMoney(f) === null) && fields.join(' ').length > 3) {
        lastItem.note = [lastItem.note, fields.join(' ')].filter(Boolean).join(' ');
      }
      continue;
    }

    const money = fields.map(asMoney).filter((v) => v !== null);
    if (!money.length) { lastItem = null; continue; }
    // The LAST money field is the amount. Sheets put a unit price or a quantity
    // before it, and the extensible column is the one that matters.
    const amount = money[money.length - 1];
    // Everything that isn't the row number and isn't a figure is text. The cell
    // AFTER the amount is a note, not part of the description — that is how these
    // sheets are laid out ("$360.00 | To prep studio for the photoshoot").
    const amountIdx = fields.findIndex((f) => asMoney(f) === amount);
    const before = fields.slice(1, amountIdx).filter((f) => asMoney(f) === null);
    const after = fields.slice(amountIdx + 1).filter((f) => asMoney(f) === null);

    let date = null;
    let vendor = before[0] || null;
    if (vendor) {
      const d = vendor.match(LEADING_DATE_RE);
      // Date and vendor share a cell on these sheets — split them so the line can
      // carry its own date, which is often a DIFFERENT month from the invoice
      // (line 9 here is dated 12/16, on a January sheet).
      if (d) { date = d[1]; vendor = d[2].trim() || null; }
    }
    const description = before.slice(1).join(' — ').trim() || vendor || '(no description)';

    const item = {
      n: Number(numMatch[1]),
      date,
      vendor,
      description,
      note: after.join(' ') || null,
      amount: round2(amount),
    };
    lines.push(item);
    lastItem = item;
  }

  const lineTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  // THE GATE. Without a printed total there is nothing to check against, so the
  // lines are returned but NOT called reconciled — the caller has to decide, and
  // the UI has to say so. Silence here would present a guess as arithmetic.
  let reason = null;
  if (!lines.length) reason = 'no numbered line items found';
  else if (printedTotal === null) reason = 'the document prints no total, so the lines cannot be checked';
  else if (Math.abs(lineTotal - printedTotal) > 0.005) {
    reason = `the lines add to ${lineTotal.toFixed(2)} but the document says ${printedTotal.toFixed(2)}`;
  }

  return {
    lines,
    printed_total: printedTotal,
    line_total: lineTotal,
    reconciles: Boolean(lines.length && printedTotal !== null && !reason),
    reason,
  };
}

/**
 * Which known artist does this line name?
 *
 * `known` is the roster UNION the names already in the ledger — Oxis owns 8 lines
 * of this invoice and is NOT on the 50-artist roster, while it IS one of the 213
 * artist names the ledger uses. Rostering is not the test for whether a name is
 * real, and refusing to attribute those 8 lines would put $1,229.72 of an
 * artist's spend into the unattributed pile.
 *
 * NEVER invents a name. Longest match first, so "3ee" cannot win a line that says
 * "3ee Deluxe" when both exist.
 */
function artistOnLine(line, known) {
  const hay = ` ${[line.description, line.note, line.vendor].filter(Boolean).join(' ').toLowerCase()} `;
  let best = null;
  for (const name of known) {
    const n = String(name || '').trim();
    if (n.length < 2) continue;
    // Word-ish boundaries: "oxis" must not match inside "proxist".
    const re = new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(hay) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

module.exports = { parseInvoiceLines, artistOnLine, asMoney };
