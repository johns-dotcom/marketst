/**
 * Remove the $35,000 Distant Matter double-count and give invoice 009 its real
 * payment.
 *
 * The chain:
 *   tx2326  2026-07-01  $35,000  Distant Matter transfer, match_method='created'
 *                                — it BOOKED exp2415 into the ledger
 *   exp2415 $35,000, no invoice number, entry_source='bank_statement'
 *                                — a duplicate of an invoice that already existed
 *   exp1143 $35,000, invoice 009, dated 06/18, Paid 07/01
 *                                — the real invoice, currently with no bank match
 *
 * So the same $35,000 sits in the ledger twice, and the genuine invoice has no
 * evidence. exp1143's payment_date (07/01) is exactly tx2326's date, which is the
 * corroboration that tx2326 is its payment.
 *
 * Uses the app's own `unbook`, the designed inverse of booking a debit: it
 * soft-deletes the created entry (restorable from the archive), cascades to any
 * split children, clears the match, and un-teaches the payee/category mappings
 * the booking taught. That is why this is not a manual delete.
 *
 * Then matches tx2326 to invoice 009, so the money lands on the real record.
 *
 * Aborts unless every row is in exactly the state described above.
 *
 * Run:  node scripts/fix-distant-matter-duplicate.cjs scripts/.env [--go]
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

const TX = 2326, DUPE = 2415, REAL = 1143;

(async () => {
  console.log('deployed commit:', (await (await fetch(`${BASE}/health`)).json()).commit);
  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = async () => {
    const all = ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
    const ej = await (await fetch(`${BASE}/api/bk/entries?status=approved&from=2026-01-01&to=2026-12-31`, { headers: H })).json();
    const list = Array.isArray(ej.data) ? ej.data : (ej.data?.data || []);
    return { tx: all.find((t) => t.id === TX), dupe: list.find((e) => e.id === DUPE), real: list.find((e) => e.id === REAL), all };
  };

  let { tx, dupe, real } = await load();
  console.log('\nbefore:');
  console.log(`   tx${TX}   ${money(tx?.amount)}  matched=${tx?.matched_expense_id}  method=${tx?.match_method}`);
  console.log(`   exp${DUPE}  ${money(dupe?.amount)}  inv=${dupe?.invoice_number || '(none)'}  src=${dupe?.entry_source}   <- the duplicate`);
  console.log(`   exp${REAL}  ${money(real?.amount)}  inv=${real?.invoice_number}  src=${real?.entry_source || '(vendor)'}  <- the real invoice`);

  const problems = [];
  if (tx?.match_method !== 'created') problems.push(`tx${TX} is not a booked debit (method=${tx?.match_method})`);
  if (tx?.matched_expense_id !== DUPE) problems.push(`tx${TX} is not attached to exp${DUPE}`);
  if (dupe?.entry_source !== 'bank_statement') problems.push(`exp${DUPE} is not bank-derived — refusing to remove it`);
  if (String(dupe?.invoice_number || '').trim()) problems.push(`exp${DUPE} has an invoice number — it may not be a duplicate`);
  if (String(real?.invoice_number || '').trim() !== '009') problems.push(`exp${REAL} is not invoice 009`);
  if (Number(dupe?.amount) !== Number(real?.amount)) problems.push('the two entries are not the same amount');
  if (problems.length) { console.error('\nABORTED:\n  ' + problems.join('\n  ') + '\nNothing was modified.'); process.exit(2); }

  if (!GO) { console.log(`\n--dry: would unbook tx${TX} (soft-deleting exp${DUPE}) then match tx${TX} to exp${REAL}`); return; }

  const r1 = await fetch(`${BASE}/api/statements/tx/${TX}/unbook`, { method: 'POST', headers: H });
  console.log(`\n1. unbook tx${TX} (removes exp${DUPE}) ->`, r1.status, JSON.stringify(await r1.json().catch(() => ({}))).slice(0, 120));
  const r2 = await fetch(`${BASE}/api/statements/tx/${TX}/match`, {
    method: 'POST', headers: H, body: JSON.stringify({ expense_id: REAL }) });
  console.log(`2. match tx${TX} to invoice 009      ->`, r2.status, JSON.stringify(await r2.json().catch(() => ({}))).slice(0, 120));

  ({ tx, dupe, real } = await load());
  console.log('\nafter:');
  console.log(`   tx${TX}   matched=${tx?.matched_expense_id || '-'}  method=${tx?.match_method || '-'}`);
  console.log(`   exp${DUPE}  ${dupe ? 'STILL PRESENT — check the archive' : 'removed from the ledger (soft-deleted, restorable)'}`);
  console.log(`   exp${REAL}  now backed by its real payment: ${tx?.matched_expense_id === REAL ? 'yes' : 'NO'}`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
