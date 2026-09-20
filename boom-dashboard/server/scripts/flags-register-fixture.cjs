#!/usr/bin/env node
/**
 * The flag register (lib/flags-register.js) against the real database.
 *
 * What is at risk: the sweep must SEE a stall it was written for and write one
 * register row per flag; a viewer must see only kinds whose page they could
 * open; "new" must be relative to the viewer's last visit; a dismissal must
 * bind to the flagged VALUE and let a changed row back through; assigning must
 * make one task that closes when the flag clears; a row-level dismissal on the
 * old data-quality categories must likewise stop holding once the value moves.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/flags-register-fixture.cjs
 *
 * Seeds its own rows (tagged __flagreg-fixture__), deletes them at the end,
 * and asserts on ITS rows, so it runs against a database holding real data.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = '__flagreg-fixture__';

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const made = { users: [], expenses: [], artists: [], releases: [], contracts: [], tasks: [] };
  try {
    const mkUser = async (name, role, pages) => {
      const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, $3, 'x') RETURNING id, name, email, role`, [name, `${name.toLowerCase()}@flagreg-fixture.test`, role]);
      made.users.push(u.id);
      for (const p of pages || []) await pool.query('INSERT INTO user_page_permissions (user_id, page) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, p]);
      return u;
    };
    const admin = await mkUser('FlagAdmin', 'Superadmin');
    const anr = await mkUser('FlagAnr', 'User', ['/releases', '/flags']);
    const T = tokenFor(admin), A = tokenFor(anr);

    const mkExpense = async (fields) => {
      const cols = Object.keys(fields);
      const { rows: [e] } = await pool.query(`INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, cols.map((c) => fields[c]));
      made.expenses.push(e.id); return e.id;
    };
    const base = { payee: `${TAG} Vendor`, category: 'Marketing', amount: 100, currency: 'USD', invoice_date: '2026-09-01', description: TAG, artist: 'Rosa Vale' };
    const stale = await mkExpense({ ...base, status: 'pending', amount: 250, created_at: new Date(Date.now() - 9 * 86400000) });          // approval_stale (high: 9 days)
    const overdue = await mkExpense({ ...base, status: 'approved', payment_status: 'Unpaid', scheduled_payment_date: day(-3), amount: 400, vendor_email: null }); // payment_overdue + payment_details_missing
    const zero = await mkExpense({ ...base, status: 'approved', payment_status: 'Paid', amount: 0 });                                        // amount_nonpositive
    const { rows: [ar] } = await pool.query(`INSERT INTO artists (name) VALUES ($1) RETURNING id`, [`${TAG} Artist`]); made.artists.push(ar.id);
    const { rows: [rel] } = await pool.query(`INSERT INTO releases (artist_id, project_name, release_date) VALUES ($1, $2, $3) RETURNING id`, [ar.id, `${TAG} Release`, day(10)]); made.releases.push(rel.id); // artist_no_contract + release_unassigned + release_behind
    const { rows: [task] } = await pool.query(`INSERT INTO tasks (user_id, assigned_by, description, due_date, status) VALUES ($1, $1, $2, $3, 'To Do') RETURNING id`, [anr.id, `${TAG} overdue task`, day(-2)]); made.tasks.push(task.id); // task_overdue
    // Data-quality: an off-roster artist nobody has heard of → artist_unknown
    const unknownRow = await mkExpense({ ...base, status: 'approved', payment_status: 'Paid', amount: 55, artist: 'Zzq Nobody Flagreg' });

    // ── 1. the sweep sees what was seeded ──
    const sw = await call('POST', '/flags/sweep', T);
    check('POST /flags/sweep runs for a Superadmin and reports per-kind counts', sw.status === 200 && sw.body?.data?.counts && typeof sw.body.data.counts.approval_stale === 'number', JSON.stringify(sw.body).slice(0, 160));
    check('no detector threw during the sweep', sw.body?.data && Object.keys(sw.body.data.errors || {}).length === 0, sw.body?.data?.errors);
    const swAnr = await call('POST', '/flags/sweep', A);
    check('a User cannot run the sweep (403)', swAnr.status === 403, swAnr.status);
    const { rows: reg } = await pool.query(`SELECT kind, key, severity, resolved_at, first_seen FROM flag_register WHERE key = ANY($1) AND resolved_at IS NULL`, [[String(stale), String(overdue), String(zero), String(rel.id), String(task.id), String(ar.id), String(unknownRow)]]);
    const has = (kind, key) => reg.some((r) => r.kind === kind && r.key === String(key));
    check('approval_stale registered for the 9-day pending row, severity high', has('approval_stale', stale) && reg.find((r) => r.kind === 'approval_stale' && r.key === String(stale)).severity === 'high');
    check('payment_overdue registered', has('payment_overdue', overdue));
    check('amount_nonpositive registered', has('amount_nonpositive', zero));
    check('artist_no_contract registered for the artist with a release', has('artist_no_contract', ar.id));
    check('release_unassigned and release_behind registered for the release in 10 days', has('release_unassigned', rel.id) && has('release_behind', rel.id));
    check('task_overdue registered', has('task_overdue', task.id));
    check('the data-quality detectors join the register too (artist_unknown)', has('artist_unknown', unknownRow));
    const { rows: [pdm] } = await pool.query(`SELECT key, usd FROM flag_register WHERE kind = 'payment_details_missing' AND key LIKE $1 AND resolved_at IS NULL`, [`${TAG.toLowerCase()} vendor|%`]);
    check('payment_details_missing groups by payee and carries the money', !!pdm && Number(pdm.usd) >= 400, pdm);

    // ── 2. GET /flags: register categories, gated by page ──
    const g = await call('GET', '/flags', T);
    const cats = g.body?.data || [];
    const cat = (k) => cats.find((c) => c.kind === k);
    check('GET /flags returns register categories alongside the data-quality ones, plus meta', g.status === 200 && cat('approval_stale')?.register === true && cat('duplicate_invoices') && g.body.meta?.swept_at);
    const staleItem = (cat('approval_stale')?.items || []).find((i) => i.key === String(stale));
    check('a register item carries title, to, usd, age and is_new (never looked → new)', !!staleItem && /waiting 9 days/.test(staleItem.title) && staleItem.to === '/bk/approvals' && staleItem.usd === 250 && staleItem.age_days === 0 && staleItem.is_new === true, staleItem);
    check('data-quality categories carry tracking (new / oldest / owner)', cat('artist_unknown')?.tracking && cat('artist_unknown').tracking.new >= 1, cat('artist_unknown')?.tracking);
    const unk = (cat('artist_unknown')?.items || []).find((i) => i.id === unknownRow);
    check('a data-quality ITEM is stamped first_seen / is_new from the register', !!unk && unk.first_seen && unk.is_new === true);
    const ga = await call('GET', '/flags', A);
    const acats = ga.body?.data || [];
    check('a /releases-only User sees release_unassigned but NO approvals, payments or team kinds', acats.some((c) => c.kind === 'release_unassigned') && !acats.some((c) => ['approval_stale', 'payment_overdue', 'task_overdue', 'label_incomplete', 'artist_no_contract'].includes(c.kind)), acats.filter((c) => c.register).map((c) => c.kind).join(','));

    // ── 3. summary + seen: "new" is relative to the viewer ──
    const s1 = await call('GET', '/flags/summary', T);
    check('summary counts open flags and everything is new to somebody who never looked', s1.body?.data?.count >= 7 && s1.body.data.new === s1.body.data.count, s1.body?.data);
    const loop = await call('GET', '/dashboard/loop', T);
    check('the Home loop carries the same flags section', loop.body?.data?.flags && loop.body.data.flags.count === s1.body.data.count && loop.body.data.flags.to === '/flags');
    const loopAnr = await call('GET', '/dashboard/loop', A);
    check('the Home loop gives the /releases-only User only what they can act on', loopAnr.body?.data?.flags && loopAnr.body.data.flags.count < s1.body.data.count, loopAnr.body?.data?.flags);
    await call('POST', '/flags/seen', T);
    const s2 = await call('GET', '/flags/summary', T);
    check('after "seen", new is 0 while the count is unchanged', s2.body?.data?.new === 0 && s2.body.data.count === s1.body.data.count, s2.body?.data);
    const g2 = await call('GET', '/flags', T);
    const staleItem2 = (g2.body.data.find((c) => c.kind === 'approval_stale')?.items || []).find((i) => i.key === String(stale));
    check('items report is_new false after the viewer looked', staleItem2 && staleItem2.is_new === false);

    // ── 4. dismiss binds to the VALUE ──
    const d1 = await call('POST', '/flags/register/dismiss', T, { kind: 'amount_nonpositive', key: String(zero) });
    check('dismiss a register flag', d1.status === 200);
    const g3 = await call('GET', '/flags', T);
    check('dismissed flag is out of the default list', !(g3.body.data.find((c) => c.kind === 'amount_nonpositive')?.items || []).some((i) => i.key === String(zero)));
    const g3d = await call('GET', '/flags?include_dismissed=1', T);
    const dz = (g3d.body.data.find((c) => c.kind === 'amount_nonpositive')?.items || []).find((i) => i.key === String(zero));
    check('…and back with include_dismissed=1, tagged dismissed with who', dz && dz.dismissed === true && dz.dismissed_by_name === 'FlagAdmin', dz);
    await call('POST', '/flags/sweep', T);
    const g3b = await call('GET', '/flags', T);
    check('a sweep with the SAME value keeps it dismissed', !(g3b.body.data.find((c) => c.kind === 'amount_nonpositive')?.items || []).some((i) => i.key === String(zero)));
    await pool.query(`UPDATE expenses SET amount = -5 WHERE id = $1`, [zero]);
    await call('POST', '/flags/sweep', T);
    const g4 = await call('GET', '/flags', T);
    const back = (g4.body.data.find((c) => c.kind === 'amount_nonpositive')?.items || []).find((i) => i.key === String(zero));
    check('the row CHANGED (0 → -5): the dismissal is dropped and the flag resurfaces, and it is new again', !!back && back.dismissed === false, back);
    const dAnr = await call('POST', '/flags/register/dismiss', A, { kind: 'amount_nonpositive', key: String(zero) });
    check('a viewer who cannot see the kind cannot dismiss it (403)', dAnr.status === 403, dAnr.status);
    // snooze
    const sn = await call('POST', '/flags/register/dismiss', T, { kind: 'payment_overdue', key: String(overdue), until: day(7) });
    const g5 = await call('GET', '/flags', T);
    check('snooze hides the flag until the date', sn.status === 200 && !(g5.body.data.find((c) => c.kind === 'payment_overdue')?.items || []).some((i) => i.key === String(overdue)));
    await pool.query(`UPDATE flag_register SET snooze_until = NOW() - INTERVAL '1 minute' WHERE kind = 'payment_overdue' AND key = $1`, [String(overdue)]);
    const g6 = await call('GET', '/flags', T);
    check('…and it returns once the date passes', (g6.body.data.find((c) => c.kind === 'payment_overdue')?.items || []).some((i) => i.key === String(overdue)));
    const un = await call('POST', '/flags/register/dismiss', T, { kind: 'payment_overdue', key: String(overdue), undo: true });
    check('undo clears dismissal and snooze', un.status === 200);

    // ── 5. assign → a task in My Work, closed when the flag clears ──
    const as1 = await call('POST', '/flags/assign', T, { kind: 'payment_overdue', key: String(overdue), user_id: anr.id, due_date: day(2), title: 'Vendor 3 days past due', to: '/bk/payments', severity: 'high' });
    check('assign a flag makes a task for the assignee, High priority, linked back', as1.status === 200 && as1.body?.data?.id && as1.body.data.user_id === anr.id && as1.body.data.priority === 'High' && as1.body.data.flag_kind === 'payment_overdue' && as1.body.data.flag_key === String(overdue), as1.body?.data);
    if (as1.body?.data?.id) made.tasks.push(as1.body.data.id);
    const g7 = await call('GET', '/flags', T);
    const ov = (g7.body.data.find((c) => c.kind === 'payment_overdue')?.items || []).find((i) => i.key === String(overdue));
    check('the flag shows its owner', ov?.task?.user_name === 'FlagAnr' && ov.task.status === 'To Do', ov?.task);
    const mw = await call('GET', '/team/my-work', A);
    check('the assignee sees the task in My Work with the flag reference', (mw.body?.data?.tasks || []).some((t) => t.id === as1.body.data.id && t.flag_kind === 'payment_overdue'));
    await pool.query(`UPDATE expenses SET payment_status = 'Paid', payment_date = CURRENT_DATE WHERE id = $1`, [overdue]);
    await call('POST', '/flags/sweep', T);
    const { rows: [resolved] } = await pool.query(`SELECT resolved_at FROM flag_register WHERE kind = 'payment_overdue' AND key = $1`, [String(overdue)]);
    const { rows: [t2] } = await pool.query(`SELECT status, notes FROM tasks WHERE id = $1`, [as1.body.data.id]);
    check('paying the invoice resolves the flag on the next sweep', !!resolved?.resolved_at);
    check('…and closes the task with a note saying why', t2?.status === 'Done' && /flag cleared/.test(t2.notes || ''), t2);
    // category-level owner
    const as2 = await call('POST', '/flags/assign', T, { kind: 'artist_unknown', key: '*', user_id: anr.id });
    if (as2.body?.data?.id) made.tasks.push(as2.body.data.id);
    const g8 = await call('GET', '/flags', T);
    check('assigning a data-quality CATEGORY records an owner on it', as2.status === 200 && g8.body.data.find((c) => c.kind === 'artist_unknown')?.tracking?.owner?.user_name === 'FlagAnr', g8.body.data.find((c) => c.kind === 'artist_unknown')?.tracking);
    const rm = await call('DELETE', '/flags/assign?kind=artist_unknown&key=*', T);
    const g9 = await call('GET', '/flags', T);
    const { rows: [t3] } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [as2.body?.data?.id]);
    check('unassign drops the owner and closes their task', rm.status === 200 && !g9.body.data.find((c) => c.kind === 'artist_unknown')?.tracking?.owner && t3?.status === 'Done');

    // ── 6. the OLD row-level dismissal now binds to the value too ──
    const ai1 = await call('GET', '/flags/artist-issues', T);
    check('artist_unknown lists the off-roster row', (ai1.body?.data?.buckets?.unknown || []).some((r) => r.id === unknownRow));
    const dd = await call('POST', '/flags/artist-issues/dismiss', T, { entry_id: unknownRow, flag_kind: 'unknown' });
    const ai2 = await call('GET', '/flags/artist-issues', T);
    check('dismissing it hides it', dd.status === 200 && !(ai2.body?.data?.buckets?.unknown || []).some((r) => r.id === unknownRow));
    await pool.query(`UPDATE expenses SET artist = 'Zzq Somebody Else Flagreg' WHERE id = $1`, [unknownRow]);
    const ai3 = await call('GET', '/flags/artist-issues', T);
    check('changing the artist to a DIFFERENT unknown name brings the row back', (ai3.body?.data?.buckets?.unknown || []).some((r) => r.id === unknownRow));
    const { rows: [fd] } = await pool.query(`SELECT value_fingerprint FROM flag_dismissals WHERE entry_id = $1 AND flag_kind = 'unknown'`, [unknownRow]);
    check('the dismissal stored the value it waved off', !!fd?.value_fingerprint);

    // ── 7. the truncation disclosure and the artist-required categories are data ──
    const { rows: [arq] } = await pool.query(`SELECT COUNT(*)::int AS n FROM bk_categories WHERE kind = 'expense' AND artist_required = TRUE`);
    check('bk_categories.artist_required is seeded (the ten Boom names were a hard-coded list)', arq.n >= 1, arq);
    const trunc = cats.filter((c) => c.truncated);
    check('every capped category says so (truncated + shown) or nothing is capped', trunc.every((c) => typeof c.shown === 'number' && c.shown < c.count), trunc.map((c) => `${c.kind} ${c.shown}/${c.count}`).join(', ') || 'none capped');

    // ── 8. resolved rows leave the open set once their source is gone ──
    await pool.query(`DELETE FROM tasks WHERE id = ANY($1)`, [made.tasks]); made.tasks = [];
    await call('POST', '/flags/sweep', T);
    const { rows: [tr] } = await pool.query(`SELECT resolved_at FROM flag_register WHERE kind = 'task_overdue' AND key = $1`, [String(task.id)]);
    check('a deleted task resolves its task_overdue flag', !!tr?.resolved_at);
    const { rows: [sweeps] } = await pool.query(`SELECT COUNT(*)::int AS n FROM flag_sweeps WHERE trigger LIKE 'manual:%'`);
    check('every manual sweep is recorded in flag_sweeps', sweeps.n >= 5, sweeps);
  } catch (e) {
    console.error('FIXTURE ERROR', e);
    results.push({ name: 'fixture threw', ok: false });
  } finally {
    await pool.query('DELETE FROM flag_assignments WHERE task_id = ANY($1)', [made.tasks]).catch(() => {});
    await pool.query('DELETE FROM tasks WHERE id = ANY($1) OR user_id = ANY($2)', [made.tasks, made.users]).catch(() => {});
    await pool.query('DELETE FROM flag_dismissals WHERE entry_id = ANY($1)', [made.expenses]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1)', [made.expenses]).catch(() => {});
    await pool.query('DELETE FROM contracts WHERE id = ANY($1)', [made.contracts]).catch(() => {});
    await pool.query('DELETE FROM releases WHERE id = ANY($1)', [made.releases]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1)', [made.artists]).catch(() => {});
    await pool.query('DELETE FROM user_page_permissions WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM user_login_logs WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    // Every API call above wrote an activity_log row for the caller; that FK blocks the user delete.
    await pool.query('DELETE FROM activity_log WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM bk_audit_log WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM flag_register WHERE dismissed_by = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]).catch(() => {});
    // Register rows for the seeded sources: the next sweep would resolve them; remove them now so no test row lingers.
    await pool.query(`DELETE FROM flag_register WHERE key = ANY($1) AND kind IN ('approval_stale','payment_overdue','payment_unscheduled','amount_nonpositive','category_missing','attachment_missing','artist_no_contract','release_unassigned','release_behind','task_overdue','artist_unknown','artist_placeholder','artist_missing','ledger_missing_song','ledger_missing_socials','never_signed_in')`,
      [[...made.expenses, ...made.releases, ...made.artists, ...made.users].map(String)]).catch(() => {});
    await pool.query(`DELETE FROM flag_register WHERE kind = 'payment_details_missing' AND key LIKE $1`, [`${TAG.toLowerCase()}%`]).catch(() => {});
    await pool.query(`DELETE FROM flag_register WHERE kind = 'w9_missing' AND key LIKE $1`, [`${TAG.toLowerCase()}%`]).catch(() => {});
    await pool.end();
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
  }
})();
