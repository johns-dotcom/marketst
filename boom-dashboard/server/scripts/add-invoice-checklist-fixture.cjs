/**
 * An invoice added by hand must answer the same checklist as one that queued.
 *
 * ── THE HOLE, MEASURED FIRST ──
 * POST /bk/entries writes `status = (entrySource || isAdmin(req.user)) ? 'approved'
 * : 'pending'`. So an admin's Add Invoice files as APPROVED on the spot: it never
 * enters the Approvals queue, and the checklist that gates every vendor-submitted
 * invoice never runs on it. Production, 2026-08-27: 894 hand-added approved
 * invoices worth $3,091,450 carry no approval_checklist at all — 771 of them read
 * recoupable=true and 684 read artist_campaign='Yes' purely because those columns
 * default that way and nobody was ever asked. 16 rows in the whole ledger carry
 * one.
 *
 * Test 1 proves that still happens when no checklist is sent, because every other
 * caller of this route (vendor submit, Bulk Upload, the Recoupments and Artist
 * Campaigns add-expense modals, creator payments) sends none and must be
 * unaffected. Everything after it is what changes for Add Invoice.
 *
 * ── The claims that are not obvious ──
 *  • the gate runs BEFORE the insert, so a refused checklist leaves NO row —
 *    a 400 afterwards would create the exact thing this prevents
 *  • the checklist, not the form's own boxes, decides cobrand / recoupable /
 *    bulk deal / campaign — and it decides them for the SPLIT CHILDREN too,
 *    which are built from those values a few lines below
 *  • a PENDING row refuses to store one: that checklist belongs to the approver
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'AC' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

const FULL = { artist: true, song: true, amount: true, category: true,
  bulk_deal: false, cobrand: false, recoupable: true, campaign: true };

(async () => {
  const made = [];
  let token = null;
  const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
  const j = async (p, o) => {
    const r = await fetch(BASE + '/api' + p, { headers: H(), ...o });
    let b = null; try { b = await r.json() } catch {}
    return { code: r.status, body: b };
  };
  let n = 0;
  const invoice = (over = {}) => ({
    payee: `Whitaker ${TAG}`, amount: 2000, currency: 'USD',
    invoice_date: '2026-08-27', invoice_number: `${TAG}-${++n}`,
    category: 'Services', artist: 'nikko', song: '4 music videos',
    vendor_email: `w${TAG}@example.com`, ...over,
  });
  const create = async (body) => {
    const r = await j('/bk/entries', { method: 'POST', body: JSON.stringify(body) });
    if (r.body?.data?.id) made.push(r.body.data.id);
    return r;
  };
  const row = async (id) => (await pool.query(
    `SELECT status, approval_checklist, cobrand, category, recoupable, artist_campaign,
            is_bulk_deal, amount FROM expenses WHERE id = $1`, [id])).rows[0];
  const kids = async (id) => (await pool.query(
    `SELECT id, cobrand, category, recoupable, artist_campaign, amount FROM expenses
      WHERE parent_id = $1 ORDER BY id`, [id])).rows;
  const countFor = async () => Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM expenses WHERE payee LIKE $1`, [`%${TAG}%`])).rows[0].n);

  try {
    const L = await fetch(BASE + '/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database\n');

    console.log('1. THE HOLE: no checklist sent, and it files approved anyway');
    const a = await create(invoice());
    ok(a.code === 200, `created (${a.code}) ${a.body?.error || ''}`);
    const ra = await row(a.body.data.id);
    ok(ra.status === 'approved', `status is 'approved' with nobody asked (${ra.status})`);
    ok(ra.approval_checklist === null, 'and it carries NO checklist — every other caller of this route is unchanged');
    ok(ra.recoupable === true && ra.artist_campaign === 'Yes',
      'recoupable and artist_campaign read yes purely from their defaults');
    ok(a.body.checklist_stored === false, `and the response says so: checklist_stored=${a.body.checklist_stored}`);

    console.log('\n2. a completed checklist is stored on the row it describes');
    const b = await create(invoice({ checklist: FULL }));
    ok(b.code === 200, `created (${b.code}) ${b.body?.error || ''}`);
    ok(b.body.checklist_stored === true, 'checklist_stored=true');
    const rb = await row(b.body.data.id);
    ok(!!rb.approval_checklist, 'the row carries the checklist');
    ok(rb.approval_checklist?.by === 'John' && !!rb.approval_checklist?.at,
      `stamped with WHO answered it and when (${rb.approval_checklist?.by})`);
    ok(rb.recoupable === true && rb.artist_campaign === 'Yes',
      'the answers landed on the columns the Recoupments and Campaigns pages read');

    console.log('\n3. the checklist OVERRULES the form — and it does so before the insert');
    const c = await create(invoice({
      // The form said not recoupable and not cobrand; the review answered the
      // opposite. The answer is the one that was ASKED.
      recoupable: false, cobrand: false, is_bulk_deal: false,
      checklist: { ...FULL, cobrand: true, recoupable: false, bulk_deal: true, campaign: true },
    }));
    ok(c.code === 200, `created (${c.code})`);
    const rc = await row(c.body.data.id);
    ok(rc.cobrand === true, `cobrand follows the answer (${rc.cobrand})`);
    ok(rc.category === 'Marketing', `and cobrand forced the category (${rc.category})`);
    ok(rc.recoupable === false, `recoupable follows the answer (${rc.recoupable})`);
    ok(rc.is_bulk_deal === true, `bulk deal follows the answer (${rc.is_bulk_deal})`);

    console.log('\n4. SPLIT CHILDREN agree with it — they are built from the same values');
    const d = await create(invoice({
      amount: 1000, cobrand: false, recoupable: true,
      artist_breakdown: [
        { artist: 'nikko', amount: 600 },
        { artist: 'jerri', amount: 400 },
      ],
      checklist: { ...FULL, cobrand: true, recoupable: false, campaign: false },
    }));
    ok(d.code === 200, `created a split (${d.code}) ${d.body?.error || ''}`);
    const rd = await row(d.body.data.id);
    const kd = await kids(d.body.data.id);
    ok(kd.length === 1, `one child row (${kd.length})`);
    ok(rd.cobrand === true && kd.every(k => k.cobrand === true),
      'parent AND child are cobrand — not a parent that flipped alone');
    ok(rd.category === 'Marketing' && kd.every(k => k.category === 'Marketing'),
      'both are Marketing');
    ok(rd.recoupable === false && kd.every(k => k.recoupable === false),
      'both are NOT recoupable — a child that stayed recoupable would put this on Recoupments');
    // campaign is 'Yes' here even though the checklist sent false, because
    // cobrand yes IMPLIES campaign yes — so a second split answers that half.
    ok(rd.artist_campaign === 'Yes' && kd.every(k => k.artist_campaign === 'Yes'),
      'campaign reads Yes on both — cobrand implied it, and the implication reached the child');

    const d2 = await create(invoice({
      amount: 1000,
      artist_breakdown: [
        { artist: 'nikko', amount: 600 },
        { artist: 'jerri', amount: 400 },
      ],
      checklist: { ...FULL, cobrand: false, campaign: false },
    }));
    const rd2 = await row(d2.body.data.id);
    const kd2 = await kids(d2.body.data.id);
    ok(d2.code === 200 && rd2.artist_campaign === 'No' && kd2.every(k => k.artist_campaign === 'No'),
      'answered NO on a split: the child says No too, and its column defaults to Yes '
      + `(parent ${rd2.artist_campaign}, child ${kd2.map(k => k.artist_campaign).join('/')})`);

    console.log('\n5. a checklist that is not complete creates NOTHING');
    const before = await countFor();
    const e1 = await j('/bk/entries', { method: 'POST', body: JSON.stringify(
      invoice({ checklist: { artist: true, song: true, amount: true } }) ) });
    ok(e1.code === 400 && /Not confirmed: category/.test(e1.body?.error || ''),
      `an unconfirmed item (${e1.code}) ${String(e1.body?.error || '').slice(0, 45)}`);
    const e2 = await j('/bk/entries', { method: 'POST', body: JSON.stringify(
      invoice({ checklist: { artist: true, song: true, amount: true, category: true, bulk_deal: false } }) ) });
    ok(e2.code === 400 && /Not answered/.test(e2.body?.error || ''),
      `an unanswered question (${e2.code}) ${String(e2.body?.error || '').slice(0, 45)}`);
    ok(await countFor() === before,
      'and NO row was written — the gate runs before the insert, or a 400 leaves behind the exact thing this fixes');

    console.log('\n6. cobrand yes means campaign yes, even sent as no');
    const f = await create(invoice({ checklist: { ...FULL, cobrand: true, campaign: false } }));
    const rf = await row(f.body.data.id);
    ok(f.code === 200 && rf.artist_campaign === 'Yes',
      `the contradiction was corrected, not stored (${rf.artist_campaign})`);
    ok(rf.approval_checklist?.campaign_implied_by_cobrand === true,
      'and the row records that it was implied rather than answered');

    console.log('\n7. every other caller of this route is untouched');
    const g = await create(invoice({ entry_source: 'recoupments', checklist: FULL }));
    const rg = await row(g.body.data.id);
    ok(g.code === 200, `an add-expense modal row still creates (${g.code})`);
    ok(rg.status === 'approved', 'still approved');
    ok(!!rg.approval_checklist, 'a checklist it sent is still honoured — nothing about this is Add-Invoice-only');
  } catch (err) {
    console.error('\nfixture blew up:', err.message);
    fail++;
  } finally {
    if (made.length) {
      await pool.query(`DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])`, [made]).catch(() => {});
      await pool.query(`DELETE FROM expenses WHERE parent_id = ANY($1::int[])`, [made]).catch(() => {});
      await pool.query(`DELETE FROM expenses WHERE id = ANY($1::int[])`, [made]).catch(() => {});
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
