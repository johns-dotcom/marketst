#!/usr/bin/env node
/**
 * Song campaigns, server side: the money is the ledger's (paid = spent, unpaid =
 * committed, listed-but-uninvoiced = expected), the checklist warns and a note
 * lets you confirm anyway, uploading every item flips ready → uploaded, a late
 * invoice flips ready → live, the Flags detectors and /team/my-work see it.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/song-campaigns-fixture.cjs
 *
 * Creates its own users, expenses and campaigns and deletes them at the end.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (m, p, t, b) => { const r = await fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${t}`, ...(b ? { 'content-type': 'application/json' } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const TAG = 'campfx';
const ARTIST = `${TAG} Artist`; const SONG = `${TAG} Song`;

(async () => {
  const made = { users: [], expenses: [] };
  try {
    const mk = async (name, role) => { const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, token_version) VALUES ($1,$2,$3,'x',0) RETURNING id,name,email,role`, [`${TAG} ${name}`, `${TAG}-${name.toLowerCase()}@example.test`, role]); made.users.push(u.id); return u; };
    const mkt = await mk('Marketer', 'User'); const bk = await mk('Bookkeeper', 'Approver');
    const M = tokenFor(mkt); const B = tokenFor(bk);
    const exp = async (o) => { const { rows: [e] } = await pool.query(`INSERT INTO expenses (payee, amount, currency, category, artist, song, invoice_date, status, payment_status, created_by, invoice_data) VALUES ($1,$2,'USD',$3,$4,$5,CURRENT_DATE,'approved',$6,'fixture',$7) RETURNING id`, [o.payee, o.amount, o.category || 'Marketing', ARTIST, SONG, o.paid ? 'Paid' : 'Unpaid', o.doc === false ? null : 'x']); made.expenses.push(e.id); return e.id; };
    const paid1 = await exp({ payee: `${TAG} Ads Co`, amount: 1200, paid: true, category: 'Advertisements' });
    const paid2 = await exp({ payee: `${TAG} PR Co`, amount: 800, paid: true });
    const unpaid = await exp({ payee: `${TAG} Creator`, amount: 500, paid: false, doc: false });
    await exp({ payee: `${TAG} Studio`, amount: 9999, paid: true, category: 'Recording' }); // not a campaign category — must not count

    // ── create ──
    const c1 = await call('POST', '/campaigns', M, { artist: ARTIST, song: SONG, budget: 3000, notes: 'the plan', lines: [{ label: 'IG ads', expected_amount: 1200, vendor: `${TAG} Ads Co` }, { label: 'PR', expected_amount: 800 }, { label: 'Creators', expected_amount: 500 }, { label: 'Boost', expected_amount: 300 }] });
    const c = c1.body?.data;
    check('POST /campaigns creates it in planning, owner = the caller, lines stored', c1.status === 201 && c.status === 'planning' && c.owner_id === mkt.id && c.lines.length === 4, JSON.stringify({ status: c?.status, owner: c?.owner_id, lines: c?.lines?.length }));
    check('the money is the LEDGER\'s: spent = paid campaign rows, committed = unpaid, the Recording row does not count', c.spent === 2000 && c.committed === 500 && c.rows === 3, JSON.stringify({ spent: c.spent, committed: c.committed, rows: c.rows }));
    check('expected = lines without an invoice; total and left follow', c.expected_open === 2800 && c.total === 5300 && c.left === -2300 && c.over_budget === true, JSON.stringify({ expected: c.expected_open, total: c.total, left: c.left }));
    check('spend by channel splits Advertisements and Marketing', c.by_channel.some((x) => x.category === 'Advertisements' && x.spent === 1200) && c.by_channel.some((x) => x.category === 'Marketing' && x.spent === 800 && x.committed === 500));
    check('a second campaign for the same song is refused', (await call('POST', '/campaigns', M, { artist: ARTIST.toUpperCase(), song: SONG.toLowerCase() })).status === 409);

    // ── lines link to invoices ──
    const igLine = c.lines.find((l) => l.label === 'IG ads');
    check('a line cannot link an invoice from another song', (await call('PUT', `/campaigns/${c.id}/lines/${igLine.id}`, M, { expense_id: 999999999 })).status === 400);
    const linked = await call('PUT', `/campaigns/${c.id}/lines/${igLine.id}`, M, { expense_id: paid1 });
    check('linking the invoice ticks the line and drops it from expected', linked.body?.data?.lines.find((l) => l.id === igLine.id)?.expense_id === paid1 && linked.body.data.expected_open === 1600);
    for (const label of ['PR', 'Creators']) { const l = linked.body.data.lines.find((x) => x.label === label); await call('PUT', `/campaigns/${c.id}/lines/${l.id}`, M, { expense_id: label === 'PR' ? paid2 : unpaid }); }
    const boost = linked.body.data.lines.find((x) => x.label === 'Boost');
    await call('DELETE', `/campaigns/${c.id}/lines/${boost.id}`, M);

    // ── lifecycle ──
    let r = await call('POST', `/campaigns/${c.id}/status`, M, { status: 'live' });
    check('planning → live', r.body?.data?.status === 'live');
    r = await call('POST', `/campaigns/${c.id}/status`, M, { status: 'finished' });
    check('live → finished stamps finished_at/by', r.body?.data?.status === 'finished' && !!r.body.data.finished_at && r.body.data.finished_by === mkt.id);
    check('the checklist is not clear (an unpaid invoice, a row with no document)', r.body.data.ready === false && r.body.data.checklist.find((k) => k.key === 'all_paid').ok === false && r.body.data.checklist.find((k) => k.key === 'docs').ok === false && r.body.data.checklist.find((k) => k.key === 'lines_in').ok === true);
    check('confirming without a note is refused with the checklist and needs_note', (r = await call('POST', `/campaigns/${c.id}/status`, M, { status: 'ready' })).status === 400 && r.body.needs_note === true && Array.isArray(r.body.checklist));
    check('uploaded cannot be set by hand', (await call('POST', `/campaigns/${c.id}/status`, M, { status: 'uploaded' })).status === 400);
    r = await call('POST', `/campaigns/${c.id}/status`, M, { status: 'ready', note: 'creator invoice is being paid Friday' });
    check('confirming WITH a note works and records who and why', r.status === 200 && r.body.data.status === 'ready' && r.body.data.confirmed_by === mkt.id && r.body.data.confirm_note === 'creator invoice is being paid Friday');
    const ev = (await call('GET', `/campaigns/${c.id}`, M)).body.data.events;
    check('the timeline has created, note, the two moves and the confirmation', ev.some((e) => e.kind === 'created') && ev.some((e) => e.kind === 'note' && e.body === 'the plan') && ev.some((e) => e.kind === 'finished') && ev.some((e) => e.kind === 'confirmed' && /Friday/.test(e.body)), ev.map((e) => e.kind).join(','));

    // ── the ready queue and the automatic transitions ──
    const ready = await call('GET', '/campaigns?status=ready', B);
    check('GET /campaigns?status=ready lists it with its expense ids for the Recoupments queue', ready.body.data.some((x) => x.id === c.id && x.expense_ids.length === 3));
    await pool.query(`UPDATE expenses SET payment_status = 'Paid' WHERE id = $1`, [unpaid]);
    const up = await call('POST', '/bk/entries/ufr-bulk', B, { ids: [paid1, paid2, unpaid], ufr: true });
    check('the items upload for recoupment through the existing bulk route', up.status === 200, JSON.stringify(up.body).slice(0, 120));
    const after = await call('GET', `/campaigns/${c.id}`, B);
    check('…and the campaign becomes uploaded on the next read', after.body.data.status === 'uploaded' && !!after.body.data.uploaded_at, after.body.data.status);
    // The confirmation has to sit BETWEEN the rows already on the campaign and the
    // late one — backdating only the campaign left every row (seeded seconds ago)
    // "arrived after confirmation", so the reason named three of four and the late
    // vendor fell off the end of it.
    await pool.query(`UPDATE expenses SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ANY($1)`, [made.expenses.slice()]);
    await pool.query(`UPDATE song_campaigns SET confirmed_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [c.id]);
    const late = await exp({ payee: `${TAG} Late Vendor`, amount: 75, paid: false });
    const re = await call('GET', `/campaigns/${c.id}`, M);
    check('a late invoice REOPENS it to live with the reason, and clears the confirmation', re.body.data.status === 'live' && /Late Vendor/.test(re.body.data.reopen_reason) && re.body.data.confirmed_at === null && re.body.data.rows === 4, JSON.stringify({ status: re.body.data.status, reason: re.body.data.reopen_reason }));
    check('…the timeline says so', re.body.data.events[0]?.kind === 'reopened');

    // ── flags + my work ──
    const { DETECTORS } = require('../lib/flags-register');
    const run = async (kind) => (await DETECTORS.find((d) => d.kind === kind).run()) || [];
    await call('PUT', `/campaigns/${c.id}`, M, { budget: 1000 });
    check('campaign_over_budget flags it once the budget is below the total', (await run('campaign_over_budget')).some((f) => f.key === String(c.id) && /over budget/.test(f.title)));
    check('campaign_reopened flags it, naming the late vendor', (await run('campaign_reopened')).some((f) => f.key === String(c.id) && /Late Vendor/.test(f.detail)));
    const mw = await call('GET', '/team/my-work', M);
    check('/team/my-work lists it for its owner with why', Array.isArray(mw.body?.data?.campaigns_due) && mw.body.data.campaigns_due.some((x) => x.id === c.id && /reopened|over budget/.test(x.why)), JSON.stringify(mw.body?.data?.campaigns_due));
    check('/campaigns/songs offers the song the ledger already names', (await call('GET', `/campaigns/songs?artist=${encodeURIComponent(ARTIST)}`, M)).body.data.ledger.includes(SONG));
    check('a stranger cannot delete it; the owner can', (await call('DELETE', `/campaigns/${c.id}`, tokenFor({ ...bk, id: bk.id + 100000, role: 'User' }))).status !== 200 && (await call('DELETE', `/campaigns/${c.id}`, M)).status === 200);
    void late;
  } catch (err) {
    check('fixture ran to completion', false, err.stack);
  } finally {
    await pool.query(`DELETE FROM song_campaigns WHERE artist_key LIKE $1`, [`${TAG.toLowerCase()}%`]).catch(() => {});
    await pool.query(`DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])`, [made.expenses]).catch(() => {});
    await pool.query(`DELETE FROM expenses WHERE id = ANY($1::int[]) OR payee LIKE $2`, [made.expenses, `${TAG} %`]).catch(() => {});
    for (const t of ['user_page_permissions', 'activity_log', 'user_login_logs', 'security_audit_log']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@example.test`]).catch((e) => console.log('users NOT removed:', e.message));
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
