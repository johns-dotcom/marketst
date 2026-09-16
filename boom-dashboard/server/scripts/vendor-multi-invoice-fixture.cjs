/**
 * One submission, many invoices — and nothing written until all of them pass.
 *
 * John, 2026-09-15: "allow users to upload multiple invoices in one submission."
 * A vendor with five bills filled the form five times, and `vendorLimiter` is
 * 10/hour, so the sixth was refused.
 *
 * ── What this exists to stop ──
 *
 *   THE OLD SHAPE STILL WORKS      section 1. `file` / `invoice_number_hint` /
 *                                  `amount` at the top level is what every open
 *                                  vendor tab posts and what
 *                                  `vendor-required-fixture.cjs` asserts 74
 *                                  things about. It must keep meaning INVOICE 1,
 *                                  with byte-identical error wording.
 *
 *   EACH INVOICE IS ITS OWN ROW    section 2. Five invoices are five rows with
 *                                  five numbers, amounts, artists and documents
 *                                  — not one row with the first of everything,
 *                                  which is what a loop that forgets to index
 *                                  produces and which no totals check would
 *                                  catch.
 *
 *   ONE 400 LISTS EVERY PROBLEM    section 3. A batch that reports its faults
 *                                  one at a time is the vendor fixing a field,
 *                                  pressing Submit, and being told about the
 *                                  next one — five times.
 *
 *   NOTHING IS WRITTEN UNTIL ALL   sections 4 and 6. A refused batch leaves no
 *   PASS                           rows; a batch that dies at R2 leaves no rows
 *                                  EITHER, which is the assertion that bites —
 *                                  rolling back only the invoice in flight
 *                                  leaves the earlier ones on Approvals under a
 *                                  response that said the submission failed.
 *
 *   A NUMBER IS NOT REUSED         section 5. The cross-submission duplicate
 *                                  check was removed for good reasons (it
 *                                  refused 393 pairs already in the ledger).
 *                                  WITHIN one submission there is no history and
 *                                  no normalizing: two cards in front of the
 *                                  vendor carrying one number is one bill sent
 *                                  twice.
 *
 * ── Why the write path is tested through a FAILURE ──
 * R2 is unconfigured in dev, so every real (non-sandbox) submission reaches
 * `stage: r2_upload_invoice` and throws — which is exactly the rollback this
 * feature had to get right, and the only way to exercise it without object
 * storage. `vendor-required-fixture.cjs` relies on the same behaviour.
 *
 * ── Running ──
 *   cd server
 *   PORT=3011 VENDOR_SUBMIT_LIMIT=500 node index.js &
 *   node scripts/vendor-multi-invoice-fixture.cjs
 *
 * `vendorLimiter` is 10/hour/IP with an in-memory store, and a 429 writes
 * nothing — so every "nothing was written" assertion below would pass VACUOUSLY
 * against one. This aborts on 429 rather than grading it.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'MI' + (process.pid % 100000);
const EMAIL = `mi${process.pid}@example.com`;
const VENDOR = `Multi Vendor ${TAG}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

let token = null;
let aborted = false;

const VENDOR_FIELDS = () => ({
  vendor_name: VENDOR,
  vendor_email: EMAIL,
  payment_preference: 'ACH',
  payment_account_number: '123456789',
  payment_routing_number: '021000021',
  payment_account_type: 'Checking',
  payment_holder_name: VENDOR,
  payment_bank_name: 'Test Bank',
  payment_bank_address: '1 Bank St, Los Angeles CA',
  social_handles: JSON.stringify([{ platform: 'Instagram', handle: '@fixture' }]),
  is_reimbursement: 'no',
});

/** One well-formed invoice; each test breaks exactly one thing on one card. */
const INV = (n, over = {}) => ({
  invoice_number: `${TAG}-${n}`,
  category: 'Marketing',
  currency: 'USD',
  boom_rep: 'John',
  amount: String(100 * n),
  artist: `Fixture Artist ${n}`,
  song: `Fixture Song ${n}`,
  ...over,
});

/**
 * Post a batch. `invoices` is the new shape; each one gets its own document
 * under `invoice_file_${i}` and its own supporting files under
 * `invoice_extra_${i}`.
 */
async function submitBatch(invoices, { sandbox = true, vendor = {}, extras = {}, files = true } = {}) {
  if (aborted) return { code: 0, j: null };
  const f = new FormData();
  for (const [k, v] of Object.entries({ ...VENDOR_FIELDS(), ...vendor })) {
    if (v !== undefined && v !== null) f.append(k, String(v));
  }
  f.append('invoices', JSON.stringify(invoices));
  f.append('w9_file', new Blob([PDF], { type: 'application/pdf' }), 'w9.pdf');
  invoices.forEach((inv, i) => {
    if (files && inv.__nofile !== true) {
      f.append(`invoice_file_${i}`, new Blob([PDF], { type: 'application/pdf' }), `invoice-${i + 1}.pdf`);
    }
    for (let k = 0; k < (extras[i] || 0); k += 1) {
      f.append(`invoice_extra_${i}`, new Blob([PDF], { type: 'application/pdf' }), `inv${i + 1}-page${k + 2}.pdf`);
    }
  });
  return send(f, sandbox);
}

/** Post the LEGACY single-invoice shape — the one every live vendor tab sends. */
async function submitLegacy(over = {}, { sandbox = true } = {}) {
  if (aborted) return { code: 0, j: null };
  const f = new FormData();
  const body = {
    ...VENDOR_FIELDS(),
    invoice_number_hint: `${TAG}-legacy`,
    category: 'Marketing', currency: 'USD', boom_rep: 'John', amount: '250.00',
    artist: 'Fixture Artist', song: 'Fixture Song',
    ...over,
  };
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) f.append(k, String(v));
  }
  f.append('file', new Blob([PDF], { type: 'application/pdf' }), 'invoice.pdf');
  f.append('w9_file', new Blob([PDF], { type: 'application/pdf' }), 'w9.pdf');
  return send(f, sandbox);
}

async function send(f, sandbox) {
  const r = await fetch(`${BASE}/api/vendor/submit${sandbox ? '?sandbox=1' : ''}`, {
    method: 'POST',
    headers: sandbox ? { Authorization: 'Bearer ' + token } : {},
    body: f,
  });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  if (r.status === 429) {
    console.error('\nABORTING: vendorLimiter returned 429 — every "nothing was written" assertion '
      + 'after this would pass vacuously. Restart the dev server and run again.');
    aborted = true;
  }
  return { code: r.status, j };
}

const rowsForVendor = async () => (await pool.query(
  `SELECT id, invoice_number, amount::float8 AS amount, artist, song, category,
          invoice_filename, w9_filename, off_roster_artist, payment_check
     FROM expenses WHERE vendor_email = $1 ORDER BY id`, [EMAIL])).rows;

(async () => {
  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database');

    // ══ 1. the old shape still means INVOICE 1 ════════════════════════════════
    console.log('\n1. the single-invoice shape is untouched');
    const legacy = await submitLegacy();
    ok(legacy.code === 200, `a legacy submission is accepted (${legacy.code}) `
      + `${legacy.code !== 200 ? JSON.stringify(legacy.j?.error || '').slice(0, 110) : ''}`);
    ok(legacy.j?.data?.invoice_count === 1, `it counts as one invoice (${legacy.j?.data?.invoice_count})`);
    ok(legacy.j?.data?.would_create?.invoice_number === `${TAG}-legacy`,
      'would_create still carries the row, in the shape it always had');
    ok(legacy.j?.data?.files?.invoice?.name === 'invoice.pdf',
      `and the "file" field is still the primary document (${legacy.j?.data?.files?.invoice?.name})`);
    // The wording matters as much as the refusal: 190 vendors read these
    // sentences, and a batch feature is not a reason to reword them.
    const legacyBad = await submitLegacy({ amount: '' });
    ok(legacyBad.code === 400 && legacyBad.j?.error === 'Please enter the invoice amount.',
      `one invoice gets the UNPREFIXED message (${JSON.stringify(legacyBad.j?.error || '')})`);
    ok(!/Invoice 1/.test(String(legacyBad.j?.error || '')),
      'never "Invoice 1 — ..." when there is only one');

    // ══ 2. three invoices are three rows ══════════════════════════════════════
    console.log('\n2. each invoice keeps its own everything');
    const three = await submitBatch([INV(1), INV(2), INV(3)], { extras: { 1: 2 } });
    ok(three.code === 200, `a batch of three is accepted (${three.code}) `
      + `${three.code !== 200 ? JSON.stringify(three.j?.error || '').slice(0, 140) : ''}`);
    const rows = three.j?.data?.would_create_rows || [];
    ok(rows.length === 3, `three rows would be created (${rows.length})`);
    ok(three.j?.data?.invoice_count === 3, `the count says so too (${three.j?.data?.invoice_count})`);
    ok(rows.map((r) => r.invoice_number).join(',') === `${TAG}-1,${TAG}-2,${TAG}-3`,
      `each row has its OWN invoice number (${rows.map((r) => r.invoice_number).join(',')})`);
    ok(rows.map((r) => r.amount).join(',') === '100,200,300',
      `and its own amount (${rows.map((r) => r.amount).join(',')})`);
    ok(rows.map((r) => r.artist).join(',') === 'Fixture Artist 1,Fixture Artist 2,Fixture Artist 3',
      'and its own artist');
    ok(rows.map((r) => r.song).join(',') === 'Fixture Song 1,Fixture Song 2,Fixture Song 3',
      'and its own song');
    ok(three.j?.data?.batch_total === 600, `the batch totals its invoices (${three.j?.data?.batch_total})`);
    const bf = three.j?.data?.invoice_files || [];
    ok(bf.length === 3 && bf.every((x) => !!x.invoice), 'every invoice carries a document');
    ok(bf[0].invoice.name === 'invoice-1.pdf' && bf[2].invoice.name === 'invoice-3.pdf',
      `documents are not shuffled (${bf.map((x) => x.invoice?.name).join(', ')})`);
    ok(bf[1].supporting.length === 2 && bf[0].supporting.length === 0,
      `supporting files stay with THEIR invoice (${bf.map((x) => x.supporting.length).join(',')})`);
    // Vendor-level things are collected once and copied onto every row.
    ok(rows.every((r) => r.payee === VENDOR && r.vendor_email === EMAIL),
      'the vendor is the same on all three');
    ok(rows.every((r) => JSON.stringify(r.payment_snapshot) === JSON.stringify(rows[0].payment_snapshot)),
      'and so is how they are to be paid');
    ok(rows.every((r) => !!r.payment_check), 'each row carries its own payment_check');

    // ══ 3. one 400, every fault, named by card ════════════════════════════════
    console.log('\n3. one refusal lists every problem, per invoice');
    const bad = await submitBatch([INV(1), INV(2, { amount: '' }), INV(3, { category: '' })]);
    ok(bad.code === 400, `a batch with two bad cards is refused (${bad.code})`);
    const per = bad.j?.invoice_errors || [];
    ok(per.length === 2, `both bad cards are reported, not just the first (${per.length})`);
    ok(per[0]?.index === 1 && per[1]?.index === 2,
      `each fault names its invoice by index (${per.map((p) => p.index).join(',')})`);
    ok(/Invoice 2 — Please enter the invoice amount\./.test(String(bad.j?.error || '')),
      `and the flat message is prefixed (${String(bad.j?.error || '').slice(0, 60)})`);
    ok((bad.j?.errors || []).some((e) => /Invoice 3 — Please select a category\./.test(e)),
      'the second fault is in `errors` too');
    ok(!per.some((p) => p.index === 0), 'the good card is not reported');

    // ══ 4. a refused batch writes nothing ═════════════════════════════════════
    console.log('\n4. a refused batch leaves no rows');
    const before = (await rowsForVendor()).length;
    await submitBatch([INV(7), INV(8, { song: '' })], { sandbox: false });
    const after = (await rowsForVendor()).length;
    ok(after === before, `still ${before} rows for this vendor (${after})`);

    // ══ 5. the same number twice is one bill sent twice ═══════════════════════
    console.log('\n5. two cards cannot carry one invoice number');
    const dupe = await submitBatch([INV(1), INV(2, { invoice_number: `${TAG}-1` })]);
    ok(dupe.code === 400, `refused (${dupe.code})`);
    ok(/already on invoice 1 of this submission/i.test(String(dupe.j?.error || '')),
      `naming the card it collides with (${String(dupe.j?.error || '').slice(0, 80)})`);
    // Different numbers that NORMALIZE the same are fine — 001 and 1 collapse
    // under normalizeInvoiceNum, and that rule refusing real invoices is why the
    // cross-submission check was removed. This test is on what was typed.
    const nearly = await submitBatch([INV(1, { invoice_number: '001' }), INV(2, { invoice_number: '1' })]);
    ok(nearly.code === 200,
      `"001" and "1" are two numbers here, not one (${nearly.code}) `
      + `${nearly.code !== 200 ? JSON.stringify(nearly.j?.error || '').slice(0, 90) : ''}`);

    // ══ 6. the write path is all-or-nothing ═══════════════════════════════════
    console.log('\n6. a batch that dies mid-write leaves NOTHING behind');
    // R2 is unconfigured in dev, so this reaches the upload and throws — after
    // three rows have been INSERTed. Rolling back only the row in flight would
    // leave two of them on Approvals.
    const real = await submitBatch([INV(4), INV(5), INV(6)], { sandbox: false });
    ok(real.code === 500 && /r2/i.test(String(real.j?.stage || '')),
      `it reaches R2 and fails there, as dev must (${real.code}, stage ${real.j?.stage})`);
    const left = await rowsForVendor();
    ok(left.length === 0,
      `ALL THREE inserted rows were rolled back, not just the last (${left.length} left)`);

    // ══ 7. the cap is a refusal, never a silent truncation ════════════════════
    console.log('\n7. eleven invoices are refused, not trimmed to ten');
    const many = await submitBatch(Array.from({ length: 11 }, (_, i) => INV(i + 1)));
    ok(many.code === 400, `refused (${many.code})`);
    ok(/up to 10 invoices/i.test(String(many.j?.error || '')),
      `saying what the limit is and that 11 arrived (${String(many.j?.error || '').slice(0, 90)})`);
    ok(/you attached 11/i.test(String(many.j?.error || '')), 'and how many they sent');
    const ten = await submitBatch(Array.from({ length: 10 }, (_, i) => INV(i + 1)));
    ok(ten.code === 200, `ten is accepted (${ten.code}) `
      + `${ten.code !== 200 ? JSON.stringify(ten.j?.error || '').slice(0, 90) : ''}`);
    ok(ten.j?.data?.would_create_rows?.length === 10,
      `all ten would be created (${ten.j?.data?.would_create_rows?.length})`);

    // ══ 8. a missing document is a per-card fault ═════════════════════════════
    console.log('\n8. every invoice needs its own document');
    const noFile = await submitBatch([INV(1), { ...INV(2), __nofile: true }]);
    ok(noFile.code === 400, `refused (${noFile.code})`);
    ok((noFile.j?.invoice_errors || []).some(
      (p) => p.index === 1 && p.errors.some((e) => /upload your invoice file/i.test(e))),
      'and it is invoice 2 that is named');

    // ══ 9. a malformed list is not a missing field ════════════════════════════
    console.log('\n9. a malformed batch says so');
    const f = new FormData();
    for (const [k, v] of Object.entries(VENDOR_FIELDS())) f.append(k, String(v));
    f.append('invoices', 'not json at all');
    f.append('file', new Blob([PDF], { type: 'application/pdf' }), 'invoice.pdf');
    f.append('w9_file', new Blob([PDF], { type: 'application/pdf' }), 'w9.pdf');
    const junk = await send(f, true);
    ok(junk.code === 400 && /list of invoices/i.test(String(junk.j?.error || '')),
      `unreadable JSON is reported as that, not as a blank field (${String(junk.j?.error || '').slice(0, 70)})`);
    const f2 = new FormData();
    for (const [k, v] of Object.entries(VENDOR_FIELDS())) f2.append(k, String(v));
    f2.append('invoices', '[]');
    f2.append('w9_file', new Blob([PDF], { type: 'application/pdf' }), 'w9.pdf');
    const empty = await send(f2, true);
    ok(empty.code === 400 && /at least one invoice/i.test(String(empty.j?.error || '')),
      `an empty list asks for one (${String(empty.j?.error || '').slice(0, 60)})`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail++;
  } finally {
    await pool.query(`DELETE FROM expenses WHERE vendor_email = $1`, [EMAIL]).catch(() => {});
    await pool.query(`DELETE FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)`, [EMAIL]).catch(() => {});
    await pool.query(`DELETE FROM vendor_emails WHERE vendor_name = $1`, [VENDOR]).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
