require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const API = 'http://localhost:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'CV' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const l = await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) })).json();
  const H = { authorization: 'Bearer ' + (l.data?.token || l.token), 'content-type': 'application/json' };
  const j = async (p, o = {}) => { const r = await fetch(API + p, { headers: H, ...o });
    const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; } };
  const made = { exp: [], txn: [], stmt: [] };
  const mk = async (o) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, artist, song, invoice_date, status,
         payment_status, payment_date, payment_method, entry_source)
       VALUES ($1,$2,'USD',$3,$4,$5,'2026-06-01','approved','Paid','2026-06-01',$6,$7) RETURNING id`,
      [o.payee, o.amount, o.category, o.artist || `Zz ${TAG}`, o.song || null, o.method || null, o.source]);
    made.exp.push(r.id); return r.id;
  };

  try {
    // The shapes measured on production, in miniature.
    const creatorish = await mk({ payee: `Danielon ${TAG}`, amount: 120, category: 'Marketing', source: 'artist_campaigns', song: 'Track' });
    const alsoCreator = await mk({ payee: `Rager ${TAG}`, amount: 300, category: 'Marketing', source: 'recoupments', song: 'Track' });
    const adSpend = await mk({ payee: `META ${TAG}`, amount: 21709, category: 'Marketing', source: 'artist_campaigns' });
    const advance = await mk({ payee: `Mirzoyan ${TAG}`, amount: 15000, category: 'Advance', source: 'artist_campaigns' });
    const recording = await mk({ payee: `Poeppel ${TAG}`, amount: 2000, category: 'Recording', source: 'artist_campaigns' });
    const withAch = await mk({ payee: `AchPaid ${TAG}`, amount: 250, category: 'Marketing', source: 'artist_campaigns', method: 'ACH', song: 'T' });

    console.log('1. the classifier separates creators from everything else');
    const c = await j('/creators/convertible');
    const mine = (c.body?.data || []).filter((r) => String(r.payee).includes(TAG));
    const prop = (id) => mine.find((r) => r.id === id)?.proposed;
    ok(prop(creatorish) === 'convert', `a $120 Marketing row from artist_campaigns → ${prop(creatorish)}`);
    ok(prop(alsoCreator) === 'convert', `a $300 Marketing row from recoupments → ${prop(alsoCreator)}`);
    ok(prop(adSpend) === 'review', `$21,709 "META" → ${prop(adSpend)} (too large)`);
    ok(prop(advance) === 'review', `a $15,000 Advance → ${prop(advance)} (wrong category)`);
    ok(prop(recording) === 'review', `$2,000 Recording → ${prop(recording)} (wrong category)`);
    const missing = mine.find((r) => r.id === creatorish)?.missing || [];
    ok(missing.includes('email') && missing.includes('PayPal handle') && missing.includes('socials'),
       `and it is flagged as missing: ${missing.join(', ')}`);

    console.log('\\n2. an already-matched row keeps no false claim');
    const { rows: [st] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1,'paypal','2026-06-01','2026-06-30','ready',NOW()) RETURNING id`, [`cv-${TAG}.pdf`]);
    made.stmt.push(st.id);
    const { rows: [tx] } = await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction,
         matched_expense_id, match_method, matched_at)
       VALUES ($1,'2026-06-01',$2,120,'debit',$3,'manual',NOW()) RETURNING id`,
      [st.id, `PAYPAL ${TAG}`, creatorish]);
    made.txn.push(tx.id);

    const dry = await j('/creators/convert', { method: 'POST',
      body: JSON.stringify({ ids: [creatorish, alsoCreator, withAch], dry_run: true }) });
    ok(dry.body?.data?.would_convert === 3, `dry run reports ${dry.body?.data?.would_convert} conversions, writes nothing`);
    ok(dry.body?.data?.would_relabel_matches === 1, `and ${dry.body?.data?.would_relabel_matches} match to relabel`);
    const { rows: [stillThere] } = await pool.query('SELECT entry_source FROM expenses WHERE id=$1', [creatorish]);
    ok(stillThere.entry_source === 'artist_campaigns', 'the dry run really wrote nothing');

    const live = await j('/creators/convert', { method: 'POST',
      body: JSON.stringify({ ids: [creatorish, alsoCreator, withAch] }) });
    ok(live.body?.data?.converted === 3, `converted ${live.body?.data?.converted}`);
    const { rows: [txAfter] } = await pool.query('SELECT match_method FROM bank_transactions WHERE id=$1', [tx.id]);
    ok(txAfter.match_method === 'creator',
       `the matched row's bank line flipped 'manual' → '${txAfter.match_method}', so it stops claiming an invoice`);

    console.log('\\n3. payment method: filled when blank, never overwritten');
    const { rows: [m1] } = await pool.query('SELECT payment_method FROM expenses WHERE id=$1', [creatorish]);
    const { rows: [m2] } = await pool.query('SELECT payment_method FROM expenses WHERE id=$1', [withAch]);
    ok(m1.payment_method === 'PayPal', `a blank method became PayPal (${m1.payment_method})`);
    ok(m2.payment_method === 'ACH', `a recorded ACH was LEFT ALONE (${m2.payment_method}) — a fact is not overwritten`);

    console.log('\\n4. they are on the creators page now, and the review rows are not');
    const list = (await j('/creators')).body?.data || [];
    const ids = list.map((r) => r.id);
    ok(ids.includes(creatorish) && ids.includes(alsoCreator), 'the converted rows appear on the creator ledger');
    ok(!ids.includes(advance) && !ids.includes(adSpend), 'the advance and the ad spend do NOT');

    console.log('\\n5. the conversion is undoable, to the RIGHT source');
    const un = await j('/creators/unconvert', { method: 'POST', body: JSON.stringify({ ids: [creatorish, alsoCreator] }) });
    ok(un.body?.data?.reversed === 2, `reversed ${un.body?.data?.reversed}`);
    const { rows: back } = await pool.query('SELECT id, entry_source FROM expenses WHERE id = ANY($1::int[])', [[creatorish, alsoCreator]]);
    const src = Object.fromEntries(back.map((r) => [r.id, r.entry_source]));
    ok(src[creatorish] === 'artist_campaigns', `#1 went back to ${src[creatorish]}`);
    ok(src[alsoCreator] === 'recoupments', `#2 went back to ${src[alsoCreator]} — NOT guessed as artist_campaigns`);

    console.log('\\n6. several creators, several artists, one bulk deal');
    const batch = await j('/creators/batch', { method: 'POST', body: JSON.stringify({
      deal_name: `Summer push ${TAG}`, is_bulk_deal: true, payment_date: '2026-07-01',
      // All seven fields are required — a batch of partial rows is refused,
      // which section 7 below asserts on purpose.
      payments: [
        { payee: `Ann ${TAG}`, amount: 100, artist: `Art A ${TAG}`, song: 'Song A', vendor_email: 'a@e.com', paypal_handle: '@a', social_handles: [{ platform: 'tiktok', handle: '@a' }] },
        { payee: `Ben ${TAG}`, amount: 150, artist: `Art A ${TAG}`, song: 'Song B', vendor_email: 'b@e.com', paypal_handle: '@b', social_handles: [{ platform: 'tiktok', handle: '@b' }] },
        { payee: `Cal ${TAG}`, amount: 200, artist: `Art B ${TAG}`, song: 'Song C', vendor_email: 'c@e.com', paypal_handle: '@c', social_handles: [{ platform: 'tiktok', handle: '@c' }] },
      ] }) });
    for (const r of batch.body?.data?.rows || []) made.exp.push(r.id);
    ok(batch.status === 201 && batch.body?.data?.created === 3, `created ${batch.body?.data?.created} rows (${batch.status})`);
    ok(batch.body?.data?.artists?.length === 2, `across ${batch.body?.data?.artists?.length} artists`);
    ok(batch.body?.data?.songs?.length === 3, `and ${batch.body?.data?.songs?.length} songs — each creator on their own`);
    ok(batch.body?.data?.total === 450, `total $${batch.body?.data?.total}`);
    const { rows: bulk } = await pool.query(
      'SELECT is_bulk_deal, parent_id FROM expenses WHERE id = ANY($1::int[])',
      [batch.body.data.rows.map((r) => r.id)]);
    ok(bulk.every((r) => r.is_bulk_deal === true), 'every row carries the bulk-deal marker');
    ok(bulk.every((r) => r.parent_id === null),
       'and none is a split child — separate payments, so each matches its own PayPal line');

    console.log('\\n7. a bad row rejects the WHOLE batch');
    const before = (await j('/creators')).body?.data?.length;
    const OKROW = (n) => ({ payee: `${n} ${TAG}`, amount: 50, artist: `A ${TAG}`, song: 'S',
      vendor_email: 'x@e.com', paypal_handle: '@x', social_handles: [{ platform: 'tiktok', handle: '@x' }] });
    const bad = await j('/creators/batch', { method: 'POST', body: JSON.stringify({ payments: [
      OKROW('Good'), { ...OKROW('Blank'), payee: '' }, { ...OKROW('Third'), amount: 0 },
    ] }) });
    ok(bad.status === 400, `rejected (${bad.status})`);
    ok(/Creator 2.*Creator 3|Creator 3.*Creator 2/s.test(JSON.stringify(bad.body)), 'naming EVERY bad row, not just the first');
    const after = (await j('/creators')).body?.data?.length;
    ok(before === after, `and wrote nothing — ${before} rows before, ${after} after`);
  } finally {
    for (const id of made.txn) await pool.query('DELETE FROM bank_transactions WHERE id=$1', [id]).catch(() => {});
    for (const id of made.stmt) await pool.query('DELETE FROM bank_statements WHERE id=$1', [id]).catch(() => {});
    await pool.query('DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])', [made.exp]).catch(() => {});
    for (const id of made.exp) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
