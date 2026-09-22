#!/usr/bin/env node
/**
 * A Superadmin controls other people's sidebars and each department's nav
 * (2026-09-22). Asserts: My Nav is on the account (PUT /settings/me nav_hidden,
 * GET /auth/me carries it); an Admin sets a User's sidebar but not an Admin's;
 * a department nav is Superadmin-only, IS the page list when applied (members'
 * page rows rewritten, admins untouched, customised sidebars kept unless
 * forced), and seeds a NEW member's pages and sidebar over the client's preset.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/nav-control-fixture.cjs
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
const TAG = 'navfx';
const DEPT = 'navfx Dept';

(async () => {
  const made = { users: [] };
  try {
    const mk = async (name, role, department = DEPT) => { const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, token_version, department) VALUES ($1,$2,$3,'x',0,$4) RETURNING id,name,email,role,department`, [`${TAG} ${name}`, `${TAG}-${name.toLowerCase()}@example.test`, role, department]); made.users.push(u.id); return u; };
    const sup = await mk('Super', 'Superadmin'); const adm = await mk('Admin', 'Admin'); const a = await mk('Alpha', 'User'); const b = await mk('Beta', 'User'); const appr = await mk('Approver', 'Approver');
    const S = tokenFor(sup); const A = tokenFor(adm); const UA = tokenFor(a);

    // ── My Nav on the account ──
    const mine = await call('PUT', '/settings/me', UA, { nav_hidden: ['/calendar', '/brand'] });
    check('PUT /settings/me stores nav_hidden on the account', mine.status === 200 && JSON.stringify(mine.body.data.nav_hidden) === '["/calendar","/brand"]');
    const me = await call('GET', '/auth/me', UA);
    check('GET /auth/me carries it, so the sidebar paints from the account', JSON.stringify(me.body?.data?.nav_hidden) === '["/calendar","/brand"]', JSON.stringify(me.body?.data?.nav_hidden));
    check('a non-array is refused', (await call('PUT', '/settings/me', UA, { nav_hidden: 'nope' })).status === 400);

    // ── another person's sidebar ──
    const read = await call('GET', `/settings/users/${a.id}/nav`, A);
    check('an Admin reads a User\'s sidebar: hidden, granted pages, department', read.status === 200 && JSON.stringify(read.body.data.hidden) === '["/calendar","/brand"]' && Array.isArray(read.body.data.pages) && read.body.data.department === DEPT);
    const setA = await call('PUT', `/settings/users/${a.id}/nav`, A, { hidden: ['/flags'] });
    check('…and sets it', setA.status === 200 && JSON.stringify(setA.body.data.hidden) === '["/flags"]' && JSON.stringify((await call('GET', '/auth/me', UA)).body.data.nav_hidden) === '["/flags"]');
    check('an Admin cannot set another Admin\'s sidebar; a Superadmin can', (await call('PUT', `/settings/users/${adm.id}/nav`, A, { hidden: [] })).status === 403 && (await call('PUT', `/settings/users/${adm.id}/nav`, S, { hidden: ['/brand'] })).status === 200);
    check('a User cannot touch anyone\'s sidebar', (await call('PUT', `/settings/users/${b.id}/nav`, UA, { hidden: [] })).status === 403);
    check('null clears it back to the default', (await call('PUT', `/settings/users/${a.id}/nav`, S, { hidden: null })).body?.data?.hidden === null);

    // ── department navs ──
    check('an Admin cannot write a department nav', (await call('PUT', `/settings/department-navs/${encodeURIComponent(DEPT)}`, A, { pages: ['/'] })).status === 403);
    check('pages must be an array of paths', (await call('PUT', `/settings/department-navs/${encodeURIComponent(DEPT)}`, S, { pages: 'x' })).status === 400);
    // Beta customised their sidebar; Alpha has the default (null)
    await call('PUT', `/settings/users/${b.id}/nav`, S, { hidden: ['/my-work'] });
    await call('PUT', `/settings/permissions/${a.id}`, S, { pages: ['/', '/artists', '/deals'] });
    const saved = await call('PUT', `/settings/department-navs/${encodeURIComponent(DEPT)}`, S, { pages: ['/', '/my-work', '/messages', '/campaigns', '/releases', '/bogus-not-a-path'], hidden: ['/messages', '/not-in-pages'], apply: true });
    check('a Superadmin saves the nav; hidden is trimmed to pages in the nav', saved.status === 200 && saved.body.data.pages.length === 6 && JSON.stringify(saved.body.data.hidden) === '["/messages"]', JSON.stringify(saved.body.data));
    check('apply rewrote the two Users and the Approver, kept Beta\'s own sidebar, left the Admin and Superadmin alone', saved.body.applied === 3 && saved.body.sidebar_set === 2 && saved.body.customised_kept === 1 && saved.body.admins_untouched === 2, JSON.stringify({ applied: saved.body.applied, sidebar_set: saved.body.sidebar_set, kept: saved.body.customised_kept, admins: saved.body.admins_untouched }));
    const aPages = (await call('GET', `/settings/permissions/${a.id}`, S)).body.data;
    check('Alpha\'s page rows ARE the nav now (the old /artists and /deals are gone)', Array.isArray(aPages) && aPages.includes('/campaigns') && !aPages.includes('/artists') && !aPages.includes('/deals'), JSON.stringify(aPages));
    check('Alpha\'s sidebar took the group\'s hidden; Beta kept theirs', JSON.stringify((await call('GET', '/auth/me', UA)).body.data.nav_hidden) === '["/messages"]' && JSON.stringify((await call('GET', '/auth/me', tokenFor(b))).body.data.nav_hidden) === '["/my-work"]');
    const adminPages = (await call('GET', `/settings/permissions/${adm.id}`, S)).body.data;
    check('the Admin has no page rows written (rows would bind them)', adminPages === null || (Array.isArray(adminPages) && adminPages.length === 0), JSON.stringify(adminPages));
    const forced = await call('PUT', `/settings/department-navs/${encodeURIComponent(DEPT)}`, S, { pages: ['/', '/my-work', '/campaigns'], hidden: ['/my-work'], apply: 'force' });
    check('force overrides customised sidebars too', forced.body.customised_kept === 0 && JSON.stringify((await call('GET', '/auth/me', tokenFor(b))).body.data.nav_hidden) === '["/my-work"]');
    const list = await call('GET', '/settings/department-navs', A);
    check('GET /department-navs lists the saved nav and the members with who customised', list.status === 200 && list.body.data.navs.some((n) => n.department === DEPT && n.updated_by_name === sup.name) && (list.body.data.members[DEPT] || []).some((m) => m.id === b.id && m.customised === true) && (list.body.data.members[DEPT] || []).some((m) => m.id === adm.id && m.role === 'Admin'));

    // ── a new member inherits the department nav over the client's preset ──
    const created = await call('POST', '/settings/users', S, { name: `${TAG} Newbie`, email: `${TAG}-newbie@example.test`, role: 'User', department: DEPT, pages: ['/artists', '/deals'] });
    const nb = created.body?.data; if (nb) made.users.push(nb.id);
    const nbPages = (await call('GET', `/settings/permissions/${nb.id}`, S)).body.data;
    check('POST /settings/users seeds the department nav\'s pages (not the client\'s /artists,/deals) and its sidebar', created.status === 201 && nb.pages_from_department_nav === true && JSON.stringify(nbPages) === '["/","/campaigns","/my-work"]' && JSON.stringify((await call('GET', `/settings/users/${nb.id}/nav`, S)).body.data.hidden) === '["/my-work"]', JSON.stringify({ pages: nbPages, from: nb.pages_from_department_nav }));
    const createdAdmin = await call('POST', '/settings/users', S, { name: `${TAG} Newadmin`, email: `${TAG}-newadmin@example.test`, role: 'Admin', department: DEPT, pages: [] });
    if (createdAdmin.body?.data?.id) made.users.push(createdAdmin.body.data.id);
    check('a new Admin in that department is NOT bound by the group nav', createdAdmin.status === 201 && !createdAdmin.body.data.pages_from_department_nav && (await call('GET', `/settings/permissions/${createdAdmin.body.data.id}`, S)).body.data === null);
    check('DELETE removes the department nav', (await call('DELETE', `/settings/department-navs/${encodeURIComponent(DEPT)}`, S)).status === 200 && !(await call('GET', '/settings/department-navs', S)).body.data.navs.some((n) => n.department === DEPT));
  } catch (err) {
    check('fixture ran to completion', false, err.stack);
  } finally {
    await pool.query(`DELETE FROM department_navs WHERE department = $1`, [DEPT]).catch(() => {});
    for (const t of ['user_page_permissions', 'user_visible_reps', 'user_invites', 'activity_log', 'user_login_logs', 'security_audit_log']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM user_invites WHERE created_by = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@example.test`]).catch((e) => console.log('users NOT removed:', e.message));
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
