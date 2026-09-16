require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const API = 'http://localhost:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'WR' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const l = await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) })).json();
  const H = { authorization: 'Bearer ' + (l.data?.token || l.token), 'content-type': 'application/json' };
  const j = async (p, o = {}) => { const r = await fetch(API + p, { headers: H, ...o });
    const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; } };
  const made = [];
  const mk = async (o) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, artist, song, invoice_date, status,
         invoice_filename, invoice_r2_key, w9_r2_key, w9_filename, w9_scan, vendor_submitted, boom_rep)
       VALUES ($1,$2,'USD','Services',$3,'S','2026-06-01',$4,'inv.pdf','inv/k.pdf',$5,$6,$7::jsonb,TRUE,NULL) RETURNING id`,
      [o.payee, o.amount || 100, `Zz ${TAG}`, o.status || 'pending',
        o.w9 ? `w9/${TAG}.pdf` : null, o.w9 ? 'W9.pdf' : null,
        o.scan ? JSON.stringify(o.scan) : null]);
    made.push(r.id); return r.id;
  };

  try {
    const V = `Wr Vendor ${TAG}`;
    // ONE W9, on the oldest invoice. Three more pending invoices from the same
    // vendor carry none — the exact 12-of-13 shape on the live queue.
    const holder = await mk({ payee: V, w9: true, scan: { w9_signed: true, w9_dated: true, form_type: 'W-9', w9_name: V } });
    const inv2 = await mk({ payee: V });
    const inv3 = await mk({ payee: V });
    const inv4 = await mk({ payee: V });
    const NOW9 = `Wr NoForm ${TAG}`;
    const orphan = await mk({ payee: NOW9 });

    const queue = async () => (await j('/bk/w9-reviews')).body?.data || {};

    console.log('1. one card per DOCUMENT, not per invoice');
    let q = await queue();
    const mine = (q.queue || []).filter((c) => c.payee === V);
    ok(mine.length === 1, `4 pending invoices from one vendor produce ${mine.length} card, not 4`);
    ok(mine[0]?.entry_id === holder, `and it is the entry HOLDING the W9 (#${mine[0]?.entry_id} vs #${holder})`);
    ok(mine[0]?.invoices?.length === 4, `the card lists all ${mine[0]?.invoices?.length} invoices it covers`);
    ok(mine[0]?.scan?.signed === true && mine[0]?.scan?.dated === true,
       'the stored scan rides along for the pre-fill');
    const orphaned = (q.no_w9 || []).some((r) => r.id === orphan);
    ok(orphaned, 'a vendor with no W9 anywhere lands in no_w9, not in the queue');
    ok(!(q.queue || []).some((c) => c.payee === NOW9), 'and produces no reviewable card');

    console.log('\\n2. reviewing once clears it for every invoice');
    const post = await j(`/bk/w9-reviews/${holder}`, { method: 'POST',
      body: JSON.stringify({ signed_and_dated: true, prefilled: true, accepted_prefill: true }) });
    ok(post.status === 200, `POST /bk/w9-reviews/:id answered (${post.status})`);
    q = await queue();
    ok(!(q.queue || []).some((c) => c.payee === V), 'the card is out of the queue');
    ok((q.reviewed || []).some((c) => c.payee === V), 'and shows as reviewed');
    ok(!(q.queue || []).some((c) => (c.invoices || []).some((i) => [inv2, inv3, inv4].includes(i.id))),
       'none of the other three invoices re-asks');

    console.log('\\n3. the pre-fill stays distinguishable');
    const r1 = (await j('/bk/w9-reviews')).body.data.reviewed.find((c) => c.payee === V)?.review;
    ok(r1?.accepted_prefill === true, 'accepting the scan records accepted_prefill = true');
    ok(r1?.scan_said?.signed === true, 'and what the scan said is kept beside the answer');
    ok(!!r1?.by && !!r1?.at, `stamped with who and when (${r1?.by})`);
    await j(`/bk/w9-reviews/${holder}`, { method: 'POST',
      body: JSON.stringify({ signed_and_dated: false, prefilled: true, accepted_prefill: false }) });
    const r2 = (await j('/bk/w9-reviews')).body.data.reviewed.find((c) => c.payee === V)?.review;
    ok(r2?.signed_and_dated === false && r2?.accepted_prefill === false,
       'changing the answer records accepted_prefill = false');

    console.log('\\n4. a NEW W9 re-opens the review');
    const newHolder = await mk({ payee: V, w9: true, scan: { w9_signed: false, w9_dated: true, form_type: 'W-9' } });
    q = await queue();
    const again = (q.queue || []).filter((c) => c.payee === V);
    ok(again.length === 1 && again[0].entry_id === newHolder,
       `a fresh upload is unreviewed again (card #${again[0]?.entry_id} vs new #${newHolder})`);
    ok(again[0]?.scan?.signed === false, 'and the deck would pre-fill NO from the new scan');

    console.log('\\n5. "no" never blocks approval');
    // The invoice checklist still gates; the W9 answer does not.
    const approve = await j(`/bk/entries/${inv2}/approve`, { method: 'POST', body: JSON.stringify({
      // `recoupable` joined the required answers on 2026-08-27 — a checklist
      // without it is now refused, which is the point of this section being a
      // COMPLETE checklist rather than a minimal one.
      checklist: { artist: true, song: true, amount: true, category: true,
        bulk_deal: false, cobrand: false, recoupable: true, campaign: true },
    }) });
    ok(approve.status === 200,
       `approving an invoice whose W9 was answered NO succeeds (${approve.status}) — ${JSON.stringify(approve.body).slice(0, 90)}`);

    console.log('\\n6. the invoice checklist is untouched');
    const noChecklist = await j(`/bk/entries/${inv3}/approve`, { method: 'POST', body: JSON.stringify({}) });
    ok(noChecklist.status >= 400, `approving with NO checklist still fails (${noChecklist.status})`);
    ok(/checklist/i.test(JSON.stringify(noChecklist.body)), 'with the same checklist error as before');

    console.log('\\n7. a blank answer is refused');
    const blank = await j(`/bk/w9-reviews/${newHolder}`, { method: 'POST', body: JSON.stringify({}) });
    ok(blank.status === 400 && /yes or no/i.test(JSON.stringify(blank.body)),
       `answering neither is refused (${blank.status})`);
  } finally {
    for (const id of made) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
