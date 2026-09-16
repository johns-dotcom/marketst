/**
 * Vendor submit: the form must collect everything needed to pay, and the SERVER
 * must be the thing that says so.
 *
 * ── The hole this closes, measured before it was closed ──
 * On 2026-08-26, posting straight at `POST /api/vendor/submit?sandbox=1` with no
 * song, no social handles and no payment details returned **200** and reported it
 * would create the row, with `"song": ""`. Every one of those checks lived in
 * VendorSubmit.jsx and nowhere else, which makes them requests rather than rules:
 * a stale tab, /admin/vendor-lab, or a direct POST wrote rows without them. Live
 * evidence on production: 11 rows with no song (3.1%), 35 with no socials (9.9%).
 *
 * And payment details were not collected AT ALL — account number, routing, IBAN
 * and PayPal handle existed only inside the uploaded PDF. An invoice that did not
 * print them was REFUSED, which is exactly the "forgot to put it on the invoice"
 * case, answered by bouncing the vendor.
 *
 * ── Budget ──
 * `vendorLimiter` is 10 submissions per hour per IP and its store is in memory,
 * so this restarts the dev server before running and ABORTS ON 429. That matters:
 * a rate-limited request writes nothing either, so "nothing was written"
 * assertions pass VACUOUSLY against a 429 — which has already happened once in
 * this repo, 13 passes against four refusals.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');

const BASE = 'http://localhost:3011';
const NOKEY = 'http://localhost:3012';        // a second server started without PAYMENT_DETAILS_KEY
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'VR' + (process.pid % 100000);
const EMAIL = `vr${process.pid}@example.com`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

let token = null;
let aborted = false;

/** A complete, valid submission — each test removes or breaks exactly one thing. */
const GOOD = () => ({
  vendor_name: `Fixture Vendor ${TAG}`,
  vendor_email: EMAIL,
  // No vendor_address and no top-level vendor_bank: the form stopped asking for
  // a mailing address on 2026-08-31, and bank name moved INTO the payment block
  // (payment_bank_name) so PayPal vendors are no longer asked for one. Their
  // absence from a submission that must pass is the assertion.
  payment_preference: 'ACH',
  payment_account_number: '123456789',
  payment_routing_number: '021000021',          // a real, checksum-valid ABA
  payment_account_type: 'Checking',
  payment_holder_name: `Fixture Vendor ${TAG}`,
  payment_bank_name: 'Test Bank',
  payment_bank_address: '1 Bank St, Los Angeles CA',
  invoice_number_hint: `${TAG}-1`,
  category: 'Marketing',
  currency: 'USD',
  boom_rep: 'John',
  amount: '100.00',
  artist: 'Fixture Artist',
  song: 'Fixture Song',
  social_handles: JSON.stringify([{ platform: 'Instagram', handle: '@fixture' }]),
  is_reimbursement: 'no',
});

async function submit(overrides = {}, { sandbox = true, base = BASE, extras = 0 } = {}) {
  if (aborted) return { code: 0, j: null };
  const f = new FormData();
  const body = { ...GOOD(), ...overrides };
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) f.append(k, String(v));
  }
  f.append('file', new Blob([PDF], { type: 'application/pdf' }), 'invoice.pdf');
  f.append('w9_file', new Blob([PDF], { type: 'application/pdf' }), 'w9.pdf');
  // Supporting files, under the `file_extra` key. `extras: n` on the call, not a
  // body field, because these are files rather than values.
  for (let i = 0; i < (extras || 0); i += 1) {
    f.append('file_extra', new Blob([PDF], { type: 'application/pdf' }), `page${i + 2}.pdf`);
  }
  const r = await fetch(`${base}/api/vendor/submit${sandbox ? '?sandbox=1' : ''}`, {
    method: 'POST',
    headers: sandbox ? { Authorization: 'Bearer ' + token } : {},
    body: f,
  });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  if (r.status === 429) {
    console.error('\nABORTING: vendorLimiter returned 429. A refused request writes nothing, so every '
      + '"nothing was written" assertion after this would pass vacuously. Restart the dev server '
      + '(the limiter store is in memory) and run again.');
    aborted = true;
  }
  return { code: r.status, j };
}

(async () => {
  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database');

    // runMigrations() runs in the BACKGROUND after app.listen, so a fixture that
    // starts too soon after a restart races it. The first run of this file did
    // exactly that: nine assertions passed, then section 4 hit
    // "relation vendor_payment_details does not exist" — which looks like a
    // missing migration and was actually a missing wait.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      const { rows } = await pool.query(
        `SELECT to_regclass('public.vendor_payment_details') IS NOT NULL AS t,
                EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name='expenses' AND column_name='payment_check') AS c`);
      ready = rows[0].t && rows[0].c;
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    ok(ready, 'schema is migrated (vendor_payment_details + expenses.payment_check)');
    if (!ready) throw new Error('migrations did not complete — is the dev server running?');
    console.log('');

    // ══ 1. the rules the browser used to keep to itself ═══════════════════════
    console.log('1. every rule is now refused by the SERVER, posting past the client');
    for (const [label, patch, expect] of [
      ['no song',                 { song: '' },                         /song \/ track/i],
      ['no social handles',       { social_handles: undefined },        /social media handle/i],
      ['blank social handle',     { social_handles: JSON.stringify([{ platform: 'Instagram', handle: '' }]) }, /social media handle/i],
      ['no artist',               { artist: '' },                       /artist or project/i],
      ['no payment details',      { payment_account_number: undefined, payment_routing_number: undefined, payment_holder_name: undefined }, /account number/i],
      ['no routing number',       { payment_routing_number: undefined }, /routing number/i],
      ['a mistyped routing number', { payment_routing_number: '021000022' }, /routing number/i],
      ['a 2-digit account',       { payment_account_number: '12' },      /account number/i],
      // ── The fields added on 2026-08-31 ──────────────────────────────────
      // An ACH batch that does not say checking-or-savings, or does not name the
      // receiving bank and where it is, cannot be filed — so these are refusals,
      // not nudges. Each was accepted with a 200 before this.
      ['no account type',         { payment_account_type: undefined },   /account type/i],
      ['an account type of "crypto"', { payment_account_type: 'crypto' }, /checking or a savings/i],
      ['no bank name',            { payment_bank_name: undefined },      /bank name/i],
      ['no bank address',         { payment_bank_address: undefined },   /bank address/i],
      ['an artist row with no song', { artist_breakdown: JSON.stringify([
        { artist: 'A', song: 'S', amount: 50 }, { artist: 'B', song: '', amount: 50 }]) }, /song \/ track/i],
    ]) {
      const r = await submit(patch);
      if (aborted) break;
      ok(r.code === 400 && expect.test(String(r.j?.error || '')),
        `${label.padEnd(28)} -> ${r.code} ${JSON.stringify(r.j?.error || '').slice(0, 64)}`);
    }
    if (aborted) throw new Error('rate limited');

    // ══ 2. a complete submission passes, and carries a verdict ════════════════
    console.log('\n2. a complete submission passes and carries a payment verdict');
    const good = await submit({});
    ok(good.code === 200, `complete submission accepted (${good.code}) ${good.code !== 200 ? JSON.stringify(good.j).slice(0, 160) : ''}`);
    const wc = good.j?.data?.would_create || {};
    ok(wc.payment_last4 === '6789', `it would store the masked account only (${wc.payment_last4})`);
    ok(!JSON.stringify(good.j).includes('123456789'),
      'and the full account number is NOT echoed anywhere in the response');
    // Dev has no ANTHROPIC_API_KEY, so the document scan cannot run — which is
    // precisely why the comparison itself is a pure function tested separately.
    ok(['unscanned', 'absent', 'match', 'mismatch'].includes(wc.payment_check?.verdict),
      `verdict is one of the four states (${wc.payment_check?.verdict})`);

    // ══ 3. an invoice with NO payment details on it now succeeds ══════════════
    // This is the behaviour change John asked for: it used to be a 400 telling the
    // vendor to edit their document. The fixture PDF carries nothing at all, so
    // this submission is exactly that case.
    console.log('\n3. an invoice with nothing printed on it no longer bounces the vendor');
    ok(good.code === 200,
      'the same submission above IS that case — a blank PDF, accepted because the form has the details');

    // ══ 4. storage: encrypted, keyed by email, masked ═════════════════════════
    console.log('\n4. what gets stored');
    // A real (non-sandbox) submit. Dev has no R2 bucket, so it 500s at the file
    // upload and the expense row is rolled back — but the payment upsert runs
    // BEFORE that, so the storage path is genuinely exercised.
    const real = await submit({ invoice_number_hint: `${TAG}-2` }, { sandbox: false });
    ok(real.code === 500 && /r2/i.test(String(real.j?.stage || '')),
      `the real submit reaches the R2 upload and fails there, as dev must (${real.code}, stage ${real.j?.stage})`);
    const { rows: stored } = await pool.query(
      'SELECT * FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)', [EMAIL]);
    ok(stored.length === 1, `one payment record stored for this vendor (${stored.length})`);
    const rec = stored[0];
    if (rec) {
      const raw = JSON.stringify(rec);
      ok(!raw.includes('123456789'), 'the stored row does NOT contain the account number in plain text');
      ok(!raw.includes('021000021'), 'nor the routing number');
      ok(rec.account_last4 === '6789', `account_last4 is the masked form (${rec.account_last4})`);
      const crypto = require('../lib/payment-crypto');
      ok(crypto.decrypt(rec.account_enc) === '123456789', 'and it decrypts back to what was submitted');
      ok(crypto.decrypt(rec.routing_enc) === '021000021', 'routing decrypts too');
    }

    // ══ 5. the public on-file endpoint confirms without disclosing ════════════
    console.log('\n5. /payment-on-file confirms, and never discloses');
    const on = await (await fetch(`${BASE}/api/vendor/payment-on-file?email=${encodeURIComponent(EMAIL)}`)).json();
    ok(on.on_file === true && on.last4 === '6789', `on file, last4 only (${JSON.stringify(on).slice(0, 90)})`);
    ok(!JSON.stringify(on).includes('123456789') && !JSON.stringify(on).includes('021000021'),
      'the response contains neither the account nor the routing number');
    const other = await (await fetch(`${BASE}/api/vendor/payment-on-file?email=someone.else@example.com`)).json();
    ok(other.on_file === false, 'a different email gets nothing — the match is email-exact, never by name');
    const junk = await (await fetch(`${BASE}/api/vendor/payment-on-file?email=notanemail`)).json();
    ok(junk.on_file === false, 'a malformed email is refused rather than queried');

    // ══ 6. a changed account is flagged, not swallowed ════════════════════════
    console.log('\n6. a vendor whose bank details change is flagged');
    const changed = await submit({
      invoice_number_hint: `${TAG}-3`,
      payment_account_number: '555444333',
    }, { sandbox: false });
    ok(changed.code === 500, `second real submit also reaches R2 (${changed.code})`);
    const { rows: after } = await pool.query(
      'SELECT account_last4 FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)', [EMAIL]);
    ok(after[0]?.account_last4 === '4333',
      `the stored record now holds the NEW account (${after[0]?.account_last4})`);
    // The flag itself, via the sandbox — which reports it because the lookup runs
    // BEFORE the sandbox branch. (The first version of this section asserted
    // `auditRows >= 0`, which is true of every number and proved nothing. A
    // vacuous assertion is worse than a missing one: it reads as coverage.)
    const flagged = await submit({ invoice_number_hint: `${TAG}-4`, payment_account_number: '777666555' });
    const chk = flagged.j?.data?.would_create?.payment_check || {};
    ok(chk.changed_from?.last4 === '4333',
      `a third, different account is flagged against the one on file (changed_from ${JSON.stringify(chk.changed_from)})`);
    ok(chk.typed_last4 === '6555', `and carries the new last4 (${chk.typed_last4})`);
    const same = await submit({ invoice_number_hint: `${TAG}-5`, payment_account_number: '555444333' });
    ok(!same.j?.data?.would_create?.payment_check?.changed_from,
      'resubmitting the SAME details raises no flag — only a change does');

    // ══ 6b. a returning vendor confirming what we hold ════════════════════════
    console.log('\n6b. a returning vendor can confirm rather than re-type');
    const reuse = await submit({
      invoice_number_hint: `${TAG}-6`,
      payment_account_number: undefined, payment_routing_number: undefined,
      payment_holder_name: undefined, payment_reuse_on_file: 'true',
    });
    ok(reuse.code === 200, `confirming the stored details is accepted with no fields typed (${reuse.code}) `
      + `${reuse.code !== 200 ? JSON.stringify(reuse.j?.error || '').slice(0, 90) : ''}`);
    const rchk = reuse.j?.data?.would_create?.payment_check || {};
    ok(rchk.reused_on_file === true, 'and is marked as a re-confirmation, not fresh entry');
    ok(rchk.typed_last4 === '4333', `resolving to the account on file (${rchk.typed_last4})`);
    ok(!rchk.changed_from, 'with no change flag, because nothing changed');
    // The flag must not become a way to submit with nothing on file at all.
    const bogus = await submit({
      vendor_email: `nobody${process.pid}@example.com`,
      invoice_number_hint: `${TAG}-7`,
      payment_account_number: undefined, payment_routing_number: undefined,
      payment_holder_name: undefined, payment_reuse_on_file: 'true',
    });
    ok(bogus.code === 400,
      `claiming reuse with nothing on file is still refused (${bogus.code}) — the flag is a fallback, not a bypass`);

    // ══ 8. Wire asks for what a wire actually needs ═══════════════════════════
    // The Wire required set grew the most on 2026-08-31: an account number
    // alongside the IBAN/SWIFT, the bank's name, and the BENEFICIARY's own
    // address, which is the vendor's and not the bank's. Tested separately from
    // ACH because GOOD is an ACH submission and a per-method spec that is only
    // ever exercised on one method is half-tested.
    console.log('\n8. the Wire required set');
    const WIRE = (patch = {}) => ({
      payment_preference: 'Wire',
      payment_wire_scope: 'International',
      payment_iban_swift: 'GB82WEST12345698765432',
      payment_account_number: '12345678',
      payment_holder_name: `Fixture Vendor ${TAG}`,
      payment_bank_name: 'Test Bank plc',
      payment_bank_address: '1 Bank St, London',
      payment_beneficiary_address: '2 Home St, London',
      // ACH-only fields must be absent, or this is not really a Wire submission.
      payment_routing_number: undefined,
      payment_account_type: undefined,
      ...patch,
    });
    const wireOk = await submit({ ...WIRE(), invoice_number_hint: `${TAG}-w1` });
    ok(wireOk.code === 200, `a complete wire is accepted (${wireOk.code}) ${wireOk.code !== 200 ? JSON.stringify(wireOk.j?.error || '').slice(0, 120) : ''}`);
    // Identity for a wire is the IBAN, not the account number — so last4 comes
    // off the IBAN even though both were given.
    ok(wireOk.j?.data?.would_create?.payment_last4 === '5432',
      `identified by the IBAN, not the account number (${wireOk.j?.data?.would_create?.payment_last4})`);
    // An intermediary bank is genuinely optional: its absence above did not
    // refuse, and naming one is still accepted.
    const wireInt = await submit({ ...WIRE({ payment_intermediary_bank: 'Correspondent Bank AG' }), invoice_number_hint: `${TAG}-w2` });
    ok(wireInt.code === 200, `an intermediary bank is accepted and not required (${wireInt.code})`);
    for (const [label, patch, expect] of [
      ['no bank name',           { payment_bank_name: undefined },           /bank name/i],
      ['no bank address',        { payment_bank_address: undefined },        /bank address/i],
      ['no beneficiary address', { payment_beneficiary_address: undefined }, /beneficiary address/i],
      ['a junk IBAN',            { payment_iban_swift: 'NOTANIBAN' },        /IBAN or a SWIFT/i],
    ]) {
      const r = await submit({ ...WIRE(patch), invoice_number_hint: `${TAG}-w3` });
      if (aborted) break;
      ok(r.code === 400 && expect.test(String(r.j?.error || '')),
        `wire with ${label.padEnd(22)} -> ${r.code} ${JSON.stringify(r.j?.error || '').slice(0, 56)}`);
    }
    // The US 4-to-17-DIGIT account rule must NOT reach a wire: foreign account
    // numbers carry letters and run longer, and borrowing the ACH check would
    // refuse correct details.
    const wireAlnum = await submit({ ...WIRE({ payment_account_number: 'GB12ABCD3456789012345678' }), invoice_number_hint: `${TAG}-w4` });
    ok(wireAlnum.code === 200,
      `an alphanumeric foreign account number is accepted on a wire (${wireAlnum.code}) — the ACH digit rule must not apply here`);

    // ── The account number is CONDITIONAL on an international wire ───────────
    // An IBAN contains it; a SWIFT/BIC does not. Demanding it in both cases was
    // a box with no new answer half the time.
    const ibanOnly = await submit({ ...WIRE({ payment_account_number: undefined }), invoice_number_hint: `${TAG}-w5` });
    ok(ibanOnly.code === 200,
      `an IBAN with NO separate account number is accepted (${ibanOnly.code}) — the IBAN already contains it`);
    const swiftNoAcct = await submit({
      ...WIRE({ payment_iban_swift: 'DEUTDEFF', payment_account_number: undefined }),
      invoice_number_hint: `${TAG}-w6`,
    });
    ok(swiftNoAcct.code === 400 && /account number/i.test(String(swiftNoAcct.j?.error || '')),
      `a SWIFT/BIC with no account number IS refused (${swiftNoAcct.code}) — it names the bank, not the account`);

    // ══ 10. a DOMESTIC wire is routing + account, and nothing foreign ═════════
    // John, 2026-08-31: "sometimes wires just need routing and account". A US
    // wire has no IBAN and no SWIFT to give, so requiring them was a required
    // field with no correct answer. Every assertion here returned 400 before the
    // scope existed, because the old flat list demanded an IBAN.
    console.log('\n10. the DOMESTIC wire required set');
    const DOM = (patch = {}) => ({
      payment_preference: 'Wire',
      payment_wire_scope: 'Domestic',
      payment_routing_number: '021000021',
      payment_account_number: '123456789',
      payment_holder_name: `Fixture Vendor ${TAG}`,
      payment_bank_name: 'Test Bank',
      payment_iban_swift: undefined,
      payment_account_type: undefined,
      payment_bank_address: undefined,
      payment_beneficiary_address: undefined,
      ...patch,
    });
    const domOk = await submit({ ...DOM(), invoice_number_hint: `${TAG}-d1` });
    ok(domOk.code === 200,
      `routing + account + name + bank is enough for a US wire (${domOk.code}) `
      + `${domOk.code !== 200 ? JSON.stringify(domOk.j?.error || '').slice(0, 120) : ''}`);
    // Identity falls back to the account number: there is no IBAN to take it from,
    // and a null last4 would mean a swapped account could never be flagged.
    ok(domOk.j?.data?.would_create?.payment_last4 === '6789',
      `identified by the account number (${domOk.j?.data?.would_create?.payment_last4})`);
    // No bank address, no beneficiary address — deliberately NOT required here.
    ok(!/bank address|beneficiary/i.test(String(domOk.j?.error || '')),
      'neither address is demanded on a domestic wire');
    for (const [label, patch, expect] of [
      ['no routing number',   { payment_routing_number: undefined },   /routing number/i],
      ['a mistyped ABA',      { payment_routing_number: '021000022' }, /routing number/i],
      ['no account number',   { payment_account_number: undefined },   /account number/i],
      ['no bank name',        { payment_bank_name: undefined },        /bank name/i],
    ]) {
      const r = await submit({ ...DOM(patch), invoice_number_hint: `${TAG}-d2` });
      if (aborted) break;
      ok(r.code === 400 && expect.test(String(r.j?.error || '')),
        `domestic wire with ${label.padEnd(18)} -> ${r.code} ${JSON.stringify(r.j?.error || '').slice(0, 50)}`);
    }
    // The scope itself is required, and is refused on its own so a domestic
    // vendor never sees a demand for an IBAN.
    const noScope = await submit({ ...DOM({ payment_wire_scope: undefined }), invoice_number_hint: `${TAG}-d3` });
    ok(noScope.code === 400 && /US \(domestic|outside the US/i.test(String(noScope.j?.error || '')),
      `a wire with no scope is refused, asking only that (${noScope.code}) ${String(noScope.j?.error || '').slice(0, 60)}`);
    ok(!/IBAN/i.test(String(noScope.j?.error || '')),
      'and the refusal does NOT mention an IBAN — the whole point of the branch');

    // ══ 9. supporting invoice files ═══════════════════════════════════════════
    console.log('\n9. more than one file can come with an invoice');
    const multi = await submit({ invoice_number_hint: `${TAG}-m1` }, { extras: 3 });
    ok(multi.code === 200, `an invoice with 3 supporting files is accepted (${multi.code})`);
    const sup = multi.j?.data?.files?.supporting;
    ok(Array.isArray(sup) && sup.length === 3, `all 3 arrived and were parsed (${Array.isArray(sup) ? sup.length : 'none'})`);
    // The PRIMARY invoice must still be the one required document. Supporting
    // files are additive and must not satisfy the gate in its place — otherwise
    // the invoice-number check silently starts judging an arbitrary attachment.
    const supOnly = await submit({ invoice_number_hint: `${TAG}-m2` }, { extras: 2 });
    ok(supOnly.j?.data?.files?.invoice?.name === 'invoice.pdf',
      `the primary invoice is still identified separately (${supOnly.j?.data?.files?.invoice?.name})`);
    // Over the cap, multer refuses the whole request rather than dropping the
    // overflow — which is why the client truncates at EXTRA_FILE_MAX. Asserted
    // so the two caps cannot drift apart silently.
    const overCap = await submit({ invoice_number_hint: `${TAG}-m3` }, { extras: 12 });
    ok(overCap.code === 400 && /too many files/i.test(String(overCap.j?.error || '')),
      `12 supporting files is refused with a sentence, not a bare 500 (${overCap.code}) `
      + `${String(overCap.j?.error || '').slice(0, 60)}`);

    // ══ 11. the shipping label: payment_snapshot ═════════════════════════════
    // vendor_payment_details is a PROFILE — overwritten on every submission, no
    // history — so it answers "where does this vendor bank NOW" and could not
    // answer "where did THIS invoice go". These assert the frozen per-invoice
    // copy, and above all that it carries no secrets.
    console.log('\n11. every invoice keeps its own copy of how it was to be paid');
    const snapRes = await submit({ invoice_number_hint: `${TAG}-s1` });
    const snap = snapRes.j?.data?.would_create?.payment_snapshot;
    ok(!!snap, `a snapshot is built (${snap ? 'yes' : 'MISSING'})`);
    ok(snap?.method === 'ACH' && snap?.account_type === 'Checking',
      `it carries the method and account type (${snap?.method} / ${snap?.account_type})`);
    ok(snap?.bank_name === 'Test Bank' && snap?.holder_name === `Fixture Vendor ${TAG}`,
      'and the bank + holder name as typed');
    ok(snap?.last4 === '6789', `and the masked account (${snap?.last4})`);
    // THE assertion. A snapshot that duplicated the account number onto every
    // invoice row would multiply the blast radius of a key compromise by the
    // number of invoices, for nothing last4 does not already give.
    const snapStr = JSON.stringify(snap || {});
    ok(!snapStr.includes('123456789') && !snapStr.includes('021000021'),
      `NO account or routing number anywhere in it — ${snapStr.slice(0, 90)}`);
    // A domestic wire's scope has no other home: the entry's payment_method says
    // "Wire" and nothing said which kind.
    const domSnapRes = await submit({ ...DOM(), invoice_number_hint: `${TAG}-s2` });
    ok(domSnapRes.j?.data?.would_create?.payment_snapshot?.wire_scope === 'Domestic',
      `a domestic wire records its scope (${domSnapRes.j?.data?.would_create?.payment_snapshot?.wire_scope})`);

    // ── changed_from carries the PREVIOUS snapshot, not just method + last4 ───
    // "Something changed" is a weaker claim than "it used to be Chase checking";
    // the second is the one an approver can act on.
    await submit({ invoice_number_hint: `${TAG}-s3`, payment_bank_name: 'First Bank' }, { sandbox: false });
    const moved = await submit({
      invoice_number_hint: `${TAG}-s4`,
      payment_account_number: '999888777',
      payment_bank_name: 'Second Bank',
    });
    const cf = moved.j?.data?.would_create?.payment_check?.changed_from;
    ok(!!cf, `a changed account is flagged (${cf ? 'yes' : 'no'})`);
    ok(cf?.bank_name === 'First Bank',
      `and says which bank it USED to be (${cf?.bank_name}) — not merely that something changed`);
    ok(cf?.holder_name === `Fixture Vendor ${TAG}`, 'carrying the previous holder name too');
    const cfStr = JSON.stringify(cf || {});
    ok(!cfStr.includes('123456789') && !cfStr.includes('999888777'),
      'and still no account numbers in the history record');

    // ══ 7. no key, no submission ══════════════════════════════════════════════
    console.log('\n7. with no PAYMENT_DETAILS_KEY the form refuses rather than losing the details');
    let reachable = true;
    try { await fetch(NOKEY + '/health'); } catch { reachable = false; }
    if (!reachable) {
      ok(false, 'the keyless server on :3012 is not running — start it before this fixture (see header)');
    } else {
      const nk = await submit({}, { sandbox: true, base: NOKEY });
      ok(nk.code === 503 && /payment details/i.test(String(nk.j?.error || '')),
        `refused with 503 and an explanation (${nk.code}) ${String(nk.j?.error || '').slice(0, 70)}`);
    }
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    await pool.query('DELETE FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)', [EMAIL]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE payee LIKE $1', [`Fixture Vendor ${TAG}%`]).catch(() => {});
    await pool.query('DELETE FROM bk_audit_log WHERE entry_payee LIKE $1', [`%${TAG}%`]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
