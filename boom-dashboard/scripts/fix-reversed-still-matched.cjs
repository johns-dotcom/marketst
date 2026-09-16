/**
 * Detach the ledger from money that came back.
 *
 * Six bank rows are reversals — the payment bounced and returned within days —
 * yet each still vouches for a ledger record, so the books report bills paid and
 * income earned on money that never stayed. routes/reports.js now excludes both
 * legs from the P&L (lib/reversal-pairs.js), so this is ledger state only; the
 * reported numbers are already correct without it.
 *
 * NOT a blanket unmatch. The six are four different situations and the treatment
 * differs per row — that is the whole reason this is a script and not a loop:
 *
 *   tx147  -> exp3637   BOOKED (match_method='created', entry_source=
 *                       'bank_statement'). The debit created its own ledger
 *                       entry, so the fix is unbook, not unmatch — the entry
 *                       exists only because of a purchase that was refunded.
 *   tx22   -> income 15 BOOKED INCOME ('created-income'). The refund of that
 *                       same purchase was booked as revenue. Money coming back
 *                       is not income; unbook it too, or removing only the
 *                       expense leaves a phantom $194.75 of revenue behind.
 *   tx2055 -> exp1076   Plain match. Already Unpaid, so nothing claimed it was
 *                       paid — but a reversed debit must not be its evidence.
 *   tx5474 -> exp555    Plain match. payment_date is 2026-08-06, i.e. a real
 *                       later payment whose statement isn't uploaded yet, so
 *                       leave payment_status alone and just drop the May
 *                       reversed debit.
 *   tx3284 -> exp709    Plain match, $1,010 debit against a $1,000 invoice
 *                       (fee tolerance). Reversed the same day.
 *   tx218  -> exp124    Plain match, and wrong for a second reason: exp124 is
 *                       Chase Mann invoice 533, attached to a PAYPAL purchase
 *                       by the auto-sameday carve-out (amount + date only) —
 *                       the same weak rule that mis-matched Venable. Chase
 *                       Mann's real payment is the 01-27 transfer tx99.
 *
 * On tx218 vs tx219: two identical $2,000 "PURCHASE 0125 PAYPAL *CALIFORNIA"
 * debits sit on 01-26 and only one refund. They are indistinguishable at the
 * bank, so which one the refund cancels cannot be proven. It does not affect the
 * P&L — exp124 and exp3619 are both category Marketing, so exactly $2,000 of
 * Marketing is excluded either way. tx218 is unmatched here because its match is
 * independently wrong, and that is the honest reason.
 *
 * Every operation is reversible: unmatch relinks, unbook soft-deletes and the
 * entry restores from the archive. Aborts unless all six rows are in exactly the
 * state described above.
 *
 * Run:  node scripts/fix-reversed-still-matched.cjs scripts/.env [--go]
 */
const fs = require('fs');

const GO = process.argv.includes('--go');
const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-dashboard.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });

// txn, what it points at, how to detach it, and the state it must be in first.
const CASES = [
  { tx: 147, kind: 'unbook', expense: 3637, method: 'created', note: 'SP Mercado purchase, booked from the bank row' },
  { tx: 22, kind: 'unbook-income', income: 15, method: 'created-income', note: 'its refund, booked as revenue' },
  { tx: 2055, kind: 'unmatch', expense: 1076, note: 'SCS LA — already Unpaid' },
  { tx: 5474, kind: 'unmatch', expense: 555, note: 'Laszewo — real payment is later, statement not uploaded' },
  { tx: 3284, kind: 'unmatch', expense: 709, note: 'Blake Hall — fee-tolerance match, reversed same day' },
  { tx: 218, kind: 'unmatch', expense: 124, note: 'Chase Mann inv 533 — wrong auto-sameday PayPal match' },
];

(async () => {
  console.log('deployed commit:', (await (await fetch(`${BASE}/health`)).json()).commit);
  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const txns = async () => ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
  let all = await txns();

  console.log('\nbefore:');
  const problems = [];
  for (const c of CASES) {
    const t = all.find((x) => x.id === c.tx);
    if (!t) { problems.push(`tx${c.tx} not found`); continue; }
    const points = c.kind === 'unbook-income' ? t.matched_income_id : t.matched_expense_id;
    const want = c.kind === 'unbook-income' ? c.income : c.expense;
    console.log(`   tx${String(c.tx).padEnd(5)}${String(t.txn_date).slice(0, 10)} ${money(t.amount).padStart(12)}`
      + `  ${c.kind.padEnd(14)} -> ${c.kind === 'unbook-income' ? 'income' : 'exp'}${points || '-'}  ${c.note}`);
    if (points !== want) problems.push(`tx${c.tx} points at ${points}, expected ${want}`);
    if (c.method && t.match_method !== c.method) problems.push(`tx${c.tx} method is ${t.match_method}, expected ${c.method}`);
    if (!c.method && t.match_method === 'created') problems.push(`tx${c.tx} is BOOKED — unmatch would be wrong, it needs unbook`);
  }
  if (problems.length) {
    console.error('\nABORTED — state has changed:\n  ' + problems.join('\n  ') + '\nNothing was modified.');
    process.exit(2);
  }

  if (!GO) { console.log(`\n--dry: all ${CASES.length} rows are in the expected state; would detach each as listed above`); return; }

  console.log();
  for (const c of CASES) {
    const url = c.kind === 'unmatch'
      ? `${BASE}/api/statements/tx/${c.tx}/match`
      : `${BASE}/api/statements/tx/${c.tx}/${c.kind}`;
    const r = await fetch(url, { method: c.kind === 'unmatch' ? 'DELETE' : 'POST', headers: H });
    const body = await r.json().catch(() => ({}));
    console.log(`${c.kind.padEnd(14)} tx${String(c.tx).padEnd(5)} -> ${r.status} ${JSON.stringify(body).slice(0, 90)}`);
  }

  all = await txns();
  console.log('\nafter:');
  let left = 0;
  for (const c of CASES) {
    const t = all.find((x) => x.id === c.tx) || {};
    const still = c.kind === 'unbook-income' ? t.matched_income_id : t.matched_expense_id;
    if (still) left += 1;
    console.log(`   tx${String(c.tx).padEnd(5)} now points at ${still || 'nothing'}${still ? '   <-- STILL ATTACHED' : ''}`);
  }
  console.log(left ? `\n${left} row(s) still attached — investigate` : '\nno reversed row vouches for a ledger record any more');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
