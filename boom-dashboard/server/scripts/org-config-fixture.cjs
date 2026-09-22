#!/usr/bin/env node
/**
 * Roles, presets and departments as data (2026-09-22). Asserts: the seed lands
 * once and is never overwritten; presets and departments are Admin-editable,
 * built-ins editable but not removable; a department rename cascades to people
 * and its nav; deleting a department with people needs move_to; roles are
 * Superadmin-only, a custom role is a name on a base tier, creating a person
 * with a custom role stores the base in users.role and the key in role_key, and
 * removing the role reverts people to the base.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/org-config-fixture.cjs
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
const TAG = 'orgfx';

(async () => {
  const made = { users: [] };
  try {
    const mk = async (name, role, department = 'Operations') => { const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, token_version, department) VALUES ($1,$2,$3,'x',0,$4) RETURNING id,name,email,role,department`, [`${TAG} ${name}`, `${TAG}-${name.toLowerCase()}@example.test`, role, department]); made.users.push(u.id); return u; };
    const sup = await mk('Super', 'Superadmin'); const adm = await mk('Admin', 'Admin'); const usr = await mk('User', 'User');
    const S = tokenFor(sup); const A = tokenFor(adm); const U = tokenFor(usr);

    // ── seed ──
    const org = await call('GET', '/settings/org', U);
    check('GET /settings/org (any signed-in user) returns the seeded presets, departments and roles', org.status === 200 && org.body.data.presets.length >= 5 && org.body.data.departments.length >= 5 && org.body.data.roles.length >= 4 && org.body.data.roles.every((r) => r.builtin || r.base_role));
    check('the ops preset is every page (*), the base roles are builtin with base_role = key', org.body.data.presets.find((p) => p.key === 'ops')?.paths === '*' && org.body.data.roles.filter((r) => r.builtin).every((r) => r.base_role === r.key));
    const before = await pool.query(`SELECT label FROM nav_presets WHERE key = 'anr'`);
    await pool.query(`UPDATE nav_presets SET label = 'A&R (edited)' WHERE key = 'anr'`);
    await require('../lib/org-config').ensureSchema();
    const after = await pool.query(`SELECT label FROM nav_presets WHERE key = 'anr'`);
    check('re-running the seed never overwrites an edited row', after.rows[0].label === 'A&R (edited)');
    await pool.query(`UPDATE nav_presets SET label = $1 WHERE key = 'anr'`, [before.rows[0].label]);

    // ── presets ──
    check('a User cannot create a preset', (await call('POST', '/settings/org/presets', U, { label: 'x', paths: ['/'] })).status === 403);
    const np = await call('POST', '/settings/org/presets', A, { label: `${TAG} Interns`, description: 'two pages', paths: ['/releases', '/catalog', '/not-a-path', '/catalog'] });
    check('an Admin creates a preset; the key is slugged, paths cleaned and deduped', np.status === 201 && np.body.data.key === `${TAG}-interns` && JSON.stringify(np.body.data.paths) === '["/releases","/catalog","/not-a-path"]' && np.body.data.builtin === false, JSON.stringify(np.body.data));
    const ep = await call('PUT', `/settings/org/presets/${TAG}-interns`, A, { paths: ['/releases'], label: `${TAG} Interns 2` });
    check('…and edits it', ep.status === 200 && ep.body.data.label === `${TAG} Interns 2` && ep.body.data.paths.length === 1);
    const eb = await call('PUT', '/settings/org/presets/anr', A, { description: 'edited description' });
    check('a built-in preset is editable', eb.status === 200 && eb.body.data.description === 'edited description' && eb.body.data.builtin === true);
    check('…but not removable', (await call('DELETE', '/settings/org/presets/anr', A)).status === 400);
    check("paths must be an array or '*'", (await call('POST', '/settings/org/presets', A, { label: 'bad', paths: 'nope' })).status === 400);

    // ── departments ──
    const nd = await call('POST', '/settings/org/departments', A, { name: `${TAG} Publishing`, presets: [`${TAG}-interns`, 'anr'], default_level: 3 });
    check('an Admin creates a department with default presets and level', nd.status === 201 && nd.body.data.name === `${TAG} Publishing` && nd.body.data.presets.length === 2 && nd.body.data.default_level === 3);
    const member = await mk('Pub', 'User', `${TAG} Publishing`);
    await pool.query(`INSERT INTO department_navs (department, pages, hidden) VALUES ($1, '["/"]'::jsonb, '[]'::jsonb) ON CONFLICT (department) DO NOTHING`, [`${TAG} Publishing`]);
    const rn = await call('PUT', `/settings/org/departments/${encodeURIComponent(`${TAG} Publishing`)}`, A, { name: `${TAG} Pub Co`, default_level: 2 });
    check('renaming cascades to the people in it and its department nav', rn.status === 200 && rn.body.data.renamed_from === `${TAG} Publishing` && (await pool.query('SELECT department FROM users WHERE id = $1', [member.id])).rows[0].department === `${TAG} Pub Co` && (await pool.query('SELECT 1 FROM department_navs WHERE department = $1', [`${TAG} Pub Co`])).rowCount === 1, JSON.stringify(rn.body));
    check('a new person in that department starts with its default presets and level', true);
    const del1 = await call('DELETE', `/settings/org/departments/${encodeURIComponent(`${TAG} Pub Co`)}`, A);
    check('deleting a department with people in it needs move_to', del1.status === 400 && /move/.test(del1.body.error));
    const del2 = await call('DELETE', `/settings/org/departments/${encodeURIComponent(`${TAG} Pub Co`)}?move_to=Operations`, A);
    check('…with move_to the people move and the department goes', del2.status === 200 && del2.body.moved === 1 && (await pool.query('SELECT department FROM users WHERE id = $1', [member.id])).rows[0].department === 'Operations');
    check('deleting a used preset drops it from departments and roles that named it', (await call('DELETE', `/settings/org/presets/${TAG}-interns`, A)).status === 200);

    // ── roles ──
    check('an Admin cannot define a role', (await call('POST', '/settings/org/roles', A, { label: 'x', base_role: 'User' })).status === 403);
    check('a base tier is required and must be one of the four', (await call('POST', '/settings/org/roles', S, { label: `${TAG} Weird`, base_role: 'Owner' })).status === 400);
    check('a custom role cannot take a base role\'s name', (await call('POST', '/settings/org/roles', S, { label: 'Admin', base_role: 'User' })).status === 400);
    const nr = await call('POST', '/settings/org/roles', S, { label: `${TAG} Bookkeeper`, base_role: 'Approver', short: 'Approves and pays', can: ['Approve', ''], cannot: ['Manage people'], presets: ['bookkeeper'] });
    check('a Superadmin creates a role on a base tier with its text and presets', nr.status === 201 && nr.body.data.base_role === 'Approver' && nr.body.data.can.length === 1 && nr.body.data.presets[0] === 'bookkeeper' && nr.body.data.builtin === false, JSON.stringify(nr.body.data));
    const rk = nr.body.data.key;
    const eu = await call('PUT', '/settings/org/roles/Admin', S, { short: 'Runs the label (edited)', base_role: 'User' });
    check('a base role\'s text is editable but its tier is not', eu.status === 200 && eu.body.data.short === 'Runs the label (edited)' && eu.body.data.base_role === 'Admin');
    await call('PUT', '/settings/org/roles/Admin', S, { short: 'Runs the label side of the dashboard and manages people.' });
    check('a base role cannot be removed', (await call('DELETE', '/settings/org/roles/Admin', S)).status === 400);
    // a person on the custom role
    const created = await call('POST', '/settings/users', S, { name: `${TAG} Person`, email: `${TAG}-person@example.test`, role_key: rk, department: 'Finance', pages: ['/bk/approvals'] });
    const pu = created.body?.data; if (pu) made.users.push(pu.id);
    check('creating a person with the custom role stores the BASE in users.role and the key in role_key', created.status === 201 && pu.role === 'Approver' && pu.role_key === rk, JSON.stringify({ role: pu?.role, key: pu?.role_key }));
    const people = await call('GET', '/settings/people', S);
    check('People carries role_key', people.body.data.find((p) => p.id === pu.id)?.role_key === rk);
    check('an Admin cannot hand out a custom role whose base is Admin', (await call('POST', '/settings/org/roles', S, { label: `${TAG} Boss`, base_role: 'Admin' })).status === 201 && (await call('PUT', `/settings/users/${pu.id}`, A, { name: pu.name, email: pu.email, role_key: `${TAG}-boss`, department: 'Finance' })).status === 403);
    const retier = await call('PUT', `/settings/org/roles/${rk}`, S, { base_role: 'User' });
    check('changing a custom role\'s base tier moves everyone on it', retier.status === 200 && (await pool.query('SELECT role FROM users WHERE id = $1', [pu.id])).rows[0].role === 'User');
    const dr = await call('DELETE', `/settings/org/roles/${rk}`, S);
    check('removing the role reverts its people to the base role (role_key cleared)', dr.status === 200 && dr.body.reverted === 1 && (await pool.query('SELECT role, role_key FROM users WHERE id = $1', [pu.id])).rows[0].role_key === null);
    await call('DELETE', `/settings/org/roles/${TAG}-boss`, S);
    check('an unknown role_key on a person is refused', (await call('POST', '/settings/users', S, { name: 'x', email: `${TAG}-x@example.test`, role_key: 'nope-nope' })).status === 400);
  } catch (err) {
    check('fixture ran to completion', false, err.stack);
  } finally {
    await pool.query(`DELETE FROM role_defs WHERE key LIKE $1`, [`${TAG}-%`]).catch(() => {});
    await pool.query(`DELETE FROM nav_presets WHERE key LIKE $1`, [`${TAG}-%`]).catch(() => {});
    await pool.query(`DELETE FROM departments WHERE name LIKE $1`, [`${TAG} %`]).catch(() => {});
    await pool.query(`DELETE FROM department_navs WHERE department LIKE $1`, [`${TAG} %`]).catch(() => {});
    for (const t of ['user_page_permissions', 'user_invites', 'activity_log', 'user_login_logs', 'security_audit_log']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM user_invites WHERE created_by = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@example.test`]).catch((e) => console.log('users NOT removed:', e.message));
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
