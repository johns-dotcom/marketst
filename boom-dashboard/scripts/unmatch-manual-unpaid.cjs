/**
 * Undo MANUAL bank matches on invoices that are still marked Unpaid.
 *
 * Why these specifically: a manual match bypassed the date sanity the
 * auto-matcher always applied (fixed in 40d878f), and every one of the inverted
 * matches found — a debit that left the bank up to 208 days BEFORE its invoice
 * existed, including $10,000 for Oxis Music — was manual and on an unpaid
 * invoice. A match is treated as proof of payment, so leaving them risks a false
 * payment record the moment one is confirmed.
 *
 * Unmatching is reversible: it clears the match pointer on bank_transactions and
 * touches no ledger entry, no amount and no payment status. The debit returns to
 * the open list to be matched correctly.
 *
 * Scope is deliberately narrow — only rows where ALL of:
 *   • the bank transaction's match_method is 'manual'
 *   • the matched expense family is NOT marked Paid
 *
 * Paid invoices are excluded: unmatching one would strip bank evidence from a
 * payment record someone has already asserted is real.
 *
 * Run:  node scripts/unmatch-manual-unpaid.cjs scripts/.env [--go]
 *       (reports only unless --go is passed)
 */
const fs = require('fs');

const GO = process.argv.includes('--go');
const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-production.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d10 = (x) => String(x || '').slice(0, 10);

(async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log('deployed commit:', health.commit);

  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Payments dashboard gives payment_status + bank_evidence per ledger entry;
  // /all gives the bank rows with match_method. Join on the family root.
  const pj = await (await fetch(`${BASE}/api/bk/payments`, { headers: H })).json();
  const entries = (Array.isArray(pj.data) ? pj.data : (pj.data?.data || []));
  const unpaidMatched = new Map();
  entries.filter((e) => e.bank_evidence && e.payment_status !== 'Paid')
    .forEach((e) => unpaidMatched.set(e.id, e));

  const aj = await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json();
  const txns = (aj.data?.transactions || []).filter((t) => t.matched_expense_id && t.match_method === 'manual');

  const targets = txns.filter((t) => unpaidMatched.has(t.matched_expense_id));
  console.log(`\nmanual matches on invoices still marked Unpaid: ${targets.length}`);
  if (!targets.length) { console.log('nothing to do'); return; }

  targets.sort((a, b) => Number(b.amount) - Number(a.amount)).forEach((t) => {
    const e = unpaidMatched.get(t.matched_expense_id);
    const inv = d10(e.invoice_date);
    const bank = d10(t.txn_date);
    const inverted = inv && bank && new Date(inv) - new Date(bank) > 5 * 86400000;
    console.log(`  tx${String(t.id).padEnd(6)} ${money(t.amount).padStart(13)}  exp${String(t.matched_expense_id).padEnd(6)}`
      + ` ${String(e.payee || '').slice(0, 24).padEnd(24)} bank ${bank}  invoice ${inv}`
      + (inverted ? '  <-- debit PREDATES the invoice' : ''));
  });

  if (!GO) { console.log('\nreport only — pass --go to unmatch these'); return; }

  let ok = 0;
  const failed = [];
  for (const t of targets) {
    const r = await fetch(`${BASE}/api/statements/tx/${t.id}/match`, { method: 'DELETE', headers: H });
    if (r.ok) ok++; else failed.push(`tx${t.id} HTTP ${r.status}`);
  }
  console.log(`\nunmatched ${ok} of ${targets.length}`);
  if (failed.length) console.log('failed:', failed.join(', '));

  // Verify: none of the targeted transactions should still hold a match.
  const after = ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
  const stillMatched = after.filter((t) => targets.some((x) => x.id === t.id) && t.matched_expense_id);
  console.log(stillMatched.length
    ? `!! ${stillMatched.length} still matched: ${stillMatched.map((t) => t.id).join(', ')}`
    : 'verified — none of them hold a match any more');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
