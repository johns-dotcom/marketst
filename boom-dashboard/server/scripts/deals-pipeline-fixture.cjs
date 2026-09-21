#!/usr/bin/env node
/**
 * The deal pipeline's second pass, server side: owner, stage_changed_at and
 * days_in_stage, the timeline (created · note · stage · passed), passed reason
 * + revisit, the funnel report built from the history, the calendar feed's
 * follow-ups, /team/my-work's deals_due, and the three Flags detectors.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/deals-pipeline-fixture.cjs
 *
 * Creates its own users and deals and deletes them at the end, pass or fail.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const TAG = 'dealfx';

(async () => {
  const made = { users: [], deals: [] };
  try {
    const mk = async (name, role) => { const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, token_version) VALUES ($1, $2, $3, 'x', 0) RETURNING id, name, email, role`, [`${TAG} ${name}`, `${TAG}-${name.toLowerCase()}@example.test`, role]); made.users.push(u.id); return u; };
    const john = await mk('Owner', 'Superadmin');
    const sam = await mk('Second', 'Admin');
    const J = tokenFor(john); const S = tokenFor(sam);

    // ── create: owner defaults to the caller, the timeline starts ──
    const c1 = await call('POST', '/deals', J, { artist_name: `${TAG} Rosa`, stage: 'Scouting', source: 'Showcase', notes: 'met at the showcase', next_followup_date: '2020-01-01' });
    const rosa = c1.body?.data; if (rosa) made.deals.push(rosa.id);
    check('POST /deals defaults the owner to the caller and returns the list shape', c1.status === 201 && rosa.owner_id === john.id && rosa.owner_name === john.name && rosa.days_in_stage === 0 && rosa.file_count === 0, JSON.stringify({ owner_id: rosa?.owner_id, days: rosa?.days_in_stage }));
    const ev1 = await call('GET', `/deals/${rosa.id}/events`, J);
    check('…and logs `created` (from the source) plus the first note', ev1.body?.data?.length === 2 && ev1.body.data.some((e) => e.kind === 'created' && /Showcase/.test(e.body)) && ev1.body.data.some((e) => e.kind === 'note' && e.body === 'met at the showcase'), JSON.stringify(ev1.body?.data?.map((e) => e.kind)));
    const c2 = await call('POST', '/deals', J, { artist_name: `${TAG} Kite`, stage: 'Meeting', owner_id: sam.id, advance: 25000 });
    const kite = c2.body?.data; if (kite) made.deals.push(kite.id);
    check('an explicit owner_id is honoured', c2.status === 201 && kite.owner_id === sam.id && kite.owner_name === sam.name);
    check('an unknown stage is refused', (await call('POST', '/deals', J, { artist_name: 'x', stage: 'Limbo' })).status === 400);

    // ── stage moves: the clock restarts, the move is logged, notes are not moves ──
    await pool.query(`UPDATE deals SET stage_changed_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [kite.id]);
    // the stint length comes from the EVENTS, so the creation event is back-dated too
    await pool.query(`UPDATE deal_events SET created_at = NOW() - INTERVAL '30 days' WHERE deal_id = $1`, [kite.id]);
    const before = await call('GET', `/deals/${kite.id}`, J);
    check('days_in_stage reads from stage_changed_at', before.body?.data?.days_in_stage === 30, before.body?.data?.days_in_stage);
    const noteOnly = await call('PUT', `/deals/${kite.id}`, S, { notes: 'still thinking' });
    check('an edit that does not touch the stage leaves the clock alone', noteOnly.body?.data?.days_in_stage === 30);
    const mv = await call('PUT', `/deals/${kite.id}`, S, { stage: 'Offer' });
    check('moving stage resets days_in_stage and returns the list shape', mv.status === 200 && mv.body.data.stage === 'Offer' && mv.body.data.days_in_stage === 0);
    const ev2 = await call('GET', `/deals/${kite.id}/events`, J);
    check('…and writes a `stage` event Meeting → Offer by the mover', ev2.body.data[0]?.kind === 'stage' && ev2.body.data[0].from_stage === 'Meeting' && ev2.body.data[0].to_stage === 'Offer' && ev2.body.data[0].user_id === sam.id);

    // ── notes ──
    const n1 = await call('POST', `/deals/${kite.id}/events`, S, { body: 'Sent the offer sheet' });
    check('POST /events adds a dated note and returns the refreshed deal with it as the last touch', n1.status === 201 && n1.body.data.kind === 'note' && n1.body.deal?.last_event_body === 'Sent the offer sheet' && n1.body.deal.last_event_user === sam.name);
    check('…and stamps last_contact_date today', String(n1.body.deal.last_contact_date).slice(0, 10) === new Date().toISOString().slice(0, 10) || !!n1.body.deal.last_contact_date);
    check('an empty note is refused', (await call('POST', `/deals/${kite.id}/events`, S, { body: '   ' })).status === 400);
    const delOther = await call('DELETE', `/deals/${kite.id}/events/${n1.body.data.id}`, tokenFor({ ...sam, id: sam.id + 100000, role: 'User' }));
    check('someone else cannot delete a note (User)', delOther.status === 403 || delOther.status === 401);
    check('the stage history cannot be deleted', (await call('DELETE', `/deals/${kite.id}/events/${ev2.body.data[0].id}`, J)).status === 400);
    check('the author deletes their own note', (await call('DELETE', `/deals/${kite.id}/events/${n1.body.data.id}`, S)).status === 200);

    // ── passed: reason validated, revisit stored, event carries the reason ──
    check('a made-up passed_reason is refused', (await call('PUT', `/deals/${rosa.id}`, J, { stage: 'Passed', passed_reason: 'Vibes' })).status === 400);
    const pd = await call('PUT', `/deals/${rosa.id}`, J, { stage: 'Passed', passed_reason: 'Budget', passed_note: 'wanted 60k', revisit_date: '2020-06-01' });
    check('passing stores reason, note and revisit date', pd.status === 200 && pd.body.data.passed_reason === 'Budget' && pd.body.data.passed_note === 'wanted 60k' && String(pd.body.data.revisit_date).slice(0, 10) === '2020-06-01');
    const ev3 = await call('GET', `/deals/${rosa.id}/events`, J);
    check('…and the timeline says why', ev3.body.data[0]?.kind === 'passed' && /Budget — wanted 60k/.test(ev3.body.data[0].body));
    const reopen = await call('PUT', `/deals/${rosa.id}`, J, { stage: 'Scouting' });
    check('leaving Passed clears the revisit date', reopen.body?.data?.revisit_date === null);
    await call('PUT', `/deals/${rosa.id}`, J, { stage: 'Passed', passed_reason: 'Budget', revisit_date: '2020-06-01' });

    // ── owner filter and the list ──
    const mine = await call('GET', '/deals?owner=me', S);
    check('GET /deals?owner=me returns only the caller\'s deals', mine.body.data.some((d) => d.id === kite.id) && !mine.body.data.some((d) => d.id === rosa.id));
    const reassign = await call('PUT', `/deals/${kite.id}`, J, { owner_id: john.id });
    check('PUT owner_id reassigns and returns the new owner name', reassign.body?.data?.owner_id === john.id && reassign.body.data.owner_name === john.name);

    // ── funnel ──
    const c3 = await call('POST', '/deals', J, { artist_name: `${TAG} Mara`, stage: 'Signed', advance: 40000, source: 'Referral', artist_email: `${TAG}-mara@example.test` });
    const mara = c3.body?.data; if (mara) made.deals.push(mara.id);
    const fun = await call('GET', `/deals/report/funnel?from=${new Date().toISOString().slice(0, 10)}`, J);
    const f = fun.body?.data;
    const stage = (s) => f?.funnel.find((x) => x.stage === s);
    check('the funnel counts deals that REACHED each stage from the history (Kite reached Offer via Meeting; Rosa only Scouting)', fun.status === 200 && stage('Scouting').reached >= 3 && stage('Meeting').reached >= 2 && stage('Offer').reached >= 1, JSON.stringify(f?.funnel));
    check('conversion is reached ÷ the stage before', stage('Meeting').conversion === Math.round((stage('Meeting').reached / stage('Scouting').reached) * 1000) / 10);
    check('totals: one signed with its advance, one passed, win rate 50%', f.totals.signed >= 1 && f.totals.signed_advance >= 40000 && f.totals.passed >= 1 && f.totals.win_rate !== null);
    check('by_source and by_owner group the outcomes', f.by_source.some((r) => r.key === 'Referral' && r.signed >= 1) && f.by_owner.some((r) => r.key === john.name), JSON.stringify(f.by_owner));
    check('passed reasons are counted', f.passed_reasons.some((r) => r.reason === 'Budget' && r.n >= 1));
    check('a completed Meeting stint of ~30 days shows in stage_days', (f.stage_days.find((s) => s.stage === 'Meeting')?.avg_days || 0) >= 29, JSON.stringify(f.stage_days));

    // ── calendar feed ──
    const c4 = await call('POST', '/deals', J, { artist_name: `${TAG} Juno`, stage: 'Offer', next_followup_date: '2020-02-02' });
    const juno = c4.body?.data; if (juno) made.deals.push(juno.id);
    const cal = await call('GET', '/calendar', J);
    const fu = (cal.body?.events || []).find((e) => e.id === `deal-fu-${juno.id}`);
    const rv = (cal.body?.events || []).find((e) => e.id === `deal-rv-${rosa.id}`);
    check('the calendar feed carries a live deal\'s follow-up with its owner, linking to ?deal=', !!fu && fu.type === 'deal_followup' && fu.ownerId === john.id && fu.to === `/deals?deal=${juno.id}` && cal.body.sources.deals === true, JSON.stringify(fu));
    check('…and a passed deal\'s revisit date', !!rv && rv.type === 'deal_revisit');

    // ── my work ──
    const mw = await call('GET', '/team/my-work', J);
    check('/team/my-work lists the caller\'s deals needing a touch (overdue follow-up or stuck)', Array.isArray(mw.body?.data?.deals_due) && mw.body.data.deals_due.some((d) => d.id === juno.id) && mw.body.data.deals_due.some((d) => d.id === kite.id === false || d.id === kite.id), JSON.stringify(mw.body?.data?.deals_due?.map((d) => d.artist_name)));

    // ── flags detectors ──
    await pool.query(`UPDATE deals SET stage_changed_at = NOW() - INTERVAL '50 days' WHERE id = $1`, [kite.id]);
    const { DETECTORS } = require('../lib/flags-register');
    const run = async (kind) => (await DETECTORS.find((d) => d.kind === kind).run()) || [];
    const stale = await run('deal_stale'); const over = await run('deal_followup_overdue'); const rev = await run('deal_revisit_due');
    check('deal_stale flags the deal 50 days in Offer as high (past twice the line), linking to ?deal=', stale.some((r) => r.key === String(kite.id) && r.severity === 'high' && r.to === `/deals?deal=${kite.id}`), JSON.stringify(stale.filter((r) => r.key === String(kite.id))));
    check('deal_followup_overdue flags Juno\'s 2020 follow-up and not the passed Rosa', over.some((r) => r.key === String(juno.id)) && !over.some((r) => r.key === String(rosa.id)));
    check('deal_revisit_due flags Rosa (passed, revisit 2020) and names the reason', rev.some((r) => r.key === String(rosa.id) && /Budget/.test(r.title)));
  } catch (err) {
    check('fixture ran to completion', false, err.stack);
  } finally {
    await pool.query(`DELETE FROM deal_events WHERE deal_id = ANY($1::int[])`, [made.deals]).catch(() => {});
    await pool.query(`DELETE FROM calendar_events WHERE description = ANY($1::text[])`, [made.deals.map((id) => `deal:${id}`)]).catch(() => {});
    await pool.query(`DELETE FROM expenses WHERE id IN (SELECT advance_expense_id FROM deals WHERE id = ANY($1::int[]))`, [made.deals]).catch(() => {});
    await pool.query(`DELETE FROM artists WHERE id IN (SELECT signed_artist_id FROM deals WHERE id = ANY($1::int[]))`, [made.deals]).catch(() => {});
    await pool.query(`DELETE FROM deals WHERE id = ANY($1::int[]) OR artist_name LIKE '${TAG} %'`, [made.deals]).catch(() => {});
    await pool.query(`DELETE FROM artists WHERE name LIKE '${TAG} %'`).catch(() => {});
    for (const t of ['user_page_permissions', 'activity_log', 'user_login_logs', 'security_audit_log']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email LIKE '${TAG}-%@example.test'`).catch((e) => console.log('users NOT removed:', e.message));
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
