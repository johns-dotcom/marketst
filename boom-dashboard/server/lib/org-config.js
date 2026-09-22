// Roles, presets and departments as DATA (2026-09-22, John: "I want admin to be
// able to create roles and presets and edit existing ones. same with
// departments").
//
//   nav_presets     key · label · description · paths ('*' = every page) · sort · builtin
//   departments     name · presets (keys) · default_level · sort · builtin
//   role_defs       key · label · base_role · short · who · pages · can · cannot · presets · sort · builtin
//
// Seeded ONCE from client/src/lib/org.seed.json — the same file the client's
// navPresets.js / roles.js read as their offline fallback, so the two cannot
// drift. Builtin rows can be edited (text, paths, defaults) but not deleted;
// the four base roles keep their key and base_role because the API enforces
// those names in ~90 places. A custom role is a NAME on a base role: users.role
// stays the base (enforcement), users.role_key remembers the custom one.
const path = require('path');
const pool = require('../db');

const SEED = require(path.join(__dirname, '..', '..', 'client', 'src', 'lib', 'org.seed.json'));
const BASE_ROLES = ['Superadmin', 'Admin', 'Approver', 'User'];
const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const paths = (v) => (v === '*' ? '*' : Array.isArray(v) ? [...new Set(v.map((p) => String(p || '').trim()).filter((p) => p.startsWith('/') && p.length <= 120))] : null);
const strs = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40) : null);

async function ensureSchema() {
  const run = (sql, params) => pool.query(sql, params).catch((e) => console.error('[org-config] schema:', e.message));
  await run(`CREATE TABLE IF NOT EXISTS nav_presets (key TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT, paths JSONB NOT NULL DEFAULT '[]'::jsonb, sort INTEGER NOT NULL DEFAULT 0, builtin BOOLEAN NOT NULL DEFAULT FALSE, updated_by INTEGER, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await run(`CREATE TABLE IF NOT EXISTS departments (name TEXT PRIMARY KEY, presets JSONB NOT NULL DEFAULT '[]'::jsonb, default_level INTEGER, sort INTEGER NOT NULL DEFAULT 0, builtin BOOLEAN NOT NULL DEFAULT FALSE, updated_by INTEGER, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await run(`CREATE TABLE IF NOT EXISTS role_defs (key TEXT PRIMARY KEY, label TEXT NOT NULL, base_role TEXT NOT NULL, short TEXT, who TEXT, pages TEXT, can JSONB NOT NULL DEFAULT '[]'::jsonb, cannot JSONB NOT NULL DEFAULT '[]'::jsonb, presets JSONB NOT NULL DEFAULT '[]'::jsonb, sort INTEGER NOT NULL DEFAULT 0, builtin BOOLEAN NOT NULL DEFAULT FALSE, updated_by INTEGER, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role_key TEXT`);
  // seed: INSERT … ON CONFLICT DO NOTHING — an edited row is never overwritten by a deploy
  for (const p of SEED.presets) await run(`INSERT INTO nav_presets (key, label, description, paths, sort, builtin) VALUES ($1,$2,$3,$4::jsonb,$5,TRUE) ON CONFLICT (key) DO NOTHING`, [p.key, p.label, p.description || null, JSON.stringify(p.paths), p.sort || 0]);
  for (const d of SEED.departments) await run(`INSERT INTO departments (name, presets, default_level, sort, builtin) VALUES ($1,$2::jsonb,$3,$4,TRUE) ON CONFLICT (name) DO NOTHING`, [d.name, JSON.stringify(d.presets || []), d.default_level || null, d.sort || 0]);
  for (const r of SEED.roles) await run(`INSERT INTO role_defs (key, label, base_role, short, who, pages, can, cannot, presets, sort, builtin) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,TRUE) ON CONFLICT (key) DO NOTHING`, [r.key, r.label, r.base_role, r.short || null, r.who || null, r.pages || null, JSON.stringify(r.can || []), JSON.stringify(r.cannot || []), JSON.stringify(r.presets || []), r.sort || 0]);
}

async function read() {
  const [p, d, r] = await Promise.all([
    pool.query('SELECT * FROM nav_presets ORDER BY sort, key'),
    pool.query('SELECT * FROM departments ORDER BY sort, name'),
    pool.query('SELECT * FROM role_defs ORDER BY sort, key'),
  ]);
  const { rows: counts } = await pool.query(`SELECT department, COALESCE(role_key, role) AS role_key, COUNT(*)::int AS n FROM users GROUP BY department, COALESCE(role_key, role)`).catch(() => ({ rows: [] }));
  const byDept = {}; const byRole = {};
  for (const c of counts) { byDept[c.department] = (byDept[c.department] || 0) + c.n; byRole[c.role_key] = (byRole[c.role_key] || 0) + c.n; }
  return {
    presets: p.rows,
    departments: d.rows.map((x) => ({ ...x, members: byDept[x.name] || 0 })),
    roles: r.rows.map((x) => ({ ...x, members: byRole[x.key] || 0 })),
    base_roles: BASE_ROLES,
    axes: SEED.axes,
  };
}

// ── presets ──
async function upsertPreset(key, b, user) {
  const k = key ? slug(key) : slug(b.key || b.label);
  if (!k) throw Object.assign(new Error('A preset needs a key or a label'), { status: 400 });
  const { rows: [cur] } = await pool.query('SELECT * FROM nav_presets WHERE key = $1', [k]);
  if (!cur && key) throw Object.assign(new Error('Preset not found'), { status: 404 });
  const ps = b.paths === undefined ? (cur ? cur.paths : []) : paths(b.paths);
  if (ps === null) throw Object.assign(new Error("paths must be an array of page paths, or '*'"), { status: 400 });
  const label = b.label === undefined ? cur?.label : String(b.label || '').trim();
  if (!label) throw Object.assign(new Error('A preset needs a label'), { status: 400 });
  const { rows: [out] } = await pool.query(
    `INSERT INTO nav_presets (key, label, description, paths, sort, builtin, updated_by, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,FALSE,$6,NOW())
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, paths = EXCLUDED.paths, sort = EXCLUDED.sort, updated_by = EXCLUDED.updated_by, updated_at = NOW() RETURNING *`,
    [k, label, b.description === undefined ? cur?.description || null : (String(b.description || '').trim() || null), JSON.stringify(ps), b.sort === undefined ? (cur?.sort ?? 99) : Number(b.sort) || 0, user?.id || null]);
  return out;
}
async function deletePreset(key) {
  const { rows: [cur] } = await pool.query('SELECT * FROM nav_presets WHERE key = $1', [key]);
  if (!cur) throw Object.assign(new Error('Preset not found'), { status: 404 });
  if (cur.builtin) throw Object.assign(new Error('A built-in preset can be edited but not removed'), { status: 400 });
  await pool.query('DELETE FROM nav_presets WHERE key = $1', [key]);
  // departments and roles that named it drop the key
  await pool.query(`UPDATE departments SET presets = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements_text(presets) x WHERE x <> $1) WHERE presets ? $1`, [key]).catch(() => {});
  await pool.query(`UPDATE role_defs SET presets = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements_text(presets) x WHERE x <> $1) WHERE presets ? $1`, [key]).catch(() => {});
}

// ── departments ──
async function upsertDepartment(name, b, user) {
  const cur = name ? (await pool.query('SELECT * FROM departments WHERE name = $1', [name])).rows[0] : null;
  if (name && !cur) throw Object.assign(new Error('Department not found'), { status: 404 });
  const newName = String((b.name !== undefined ? b.name : name) || '').trim().slice(0, 60);
  if (!newName) throw Object.assign(new Error('A department needs a name'), { status: 400 });
  const presets = b.presets === undefined ? (cur ? cur.presets : []) : strs(b.presets);
  if (presets === null) throw Object.assign(new Error('presets must be an array of preset keys'), { status: 400 });
  const level = b.default_level === undefined ? (cur ? cur.default_level : null) : (b.default_level === null || b.default_level === '' ? null : Number(b.default_level));
  if (cur && newName !== cur.name) {
    // rename cascades: people, the department's nav
    const { rows: [clash] } = await pool.query('SELECT 1 FROM departments WHERE name = $1', [newName]);
    if (clash) throw Object.assign(new Error('A department with that name already exists'), { status: 409 });
    await pool.query('UPDATE departments SET name = $2 WHERE name = $1', [cur.name, newName]);
    await pool.query('UPDATE users SET department = $2 WHERE department = $1', [cur.name, newName]);
    await pool.query('UPDATE department_navs SET department = $2 WHERE department = $1', [cur.name, newName]).catch(() => {});
  }
  const { rows: [out] } = await pool.query(
    `INSERT INTO departments (name, presets, default_level, sort, builtin, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4,FALSE,$5,NOW())
     ON CONFLICT (name) DO UPDATE SET presets = EXCLUDED.presets, default_level = EXCLUDED.default_level, sort = EXCLUDED.sort, updated_by = EXCLUDED.updated_by, updated_at = NOW() RETURNING *`,
    [newName, JSON.stringify(presets), level, b.sort === undefined ? (cur?.sort ?? 99) : Number(b.sort) || 0, user?.id || null]);
  return { ...out, renamed_from: cur && newName !== cur.name ? cur.name : null };
}
async function deleteDepartment(name, moveTo) {
  const { rows: [cur] } = await pool.query('SELECT * FROM departments WHERE name = $1', [name]);
  if (!cur) throw Object.assign(new Error('Department not found'), { status: 404 });
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE department = $1', [name]);
  if (n > 0) {
    if (!moveTo) throw Object.assign(new Error(`${n} ${n === 1 ? 'person is' : 'people are'} in ${name}. Say which department they move to (move_to).`), { status: 400 });
    const { rows: [target] } = await pool.query('SELECT 1 FROM departments WHERE name = $1', [moveTo]);
    if (!target) throw Object.assign(new Error('move_to is not a department'), { status: 400 });
    await pool.query('UPDATE users SET department = $2 WHERE department = $1', [name, moveTo]);
  }
  await pool.query('DELETE FROM department_navs WHERE department = $1', [name]).catch(() => {});
  await pool.query('DELETE FROM departments WHERE name = $1', [name]);
  return { moved: n };
}

// ── roles ──
async function upsertRole(key, b, user) {
  const cur = key ? (await pool.query('SELECT * FROM role_defs WHERE key = $1', [key])).rows[0] : null;
  if (key && !cur) throw Object.assign(new Error('Role not found'), { status: 404 });
  const label = b.label === undefined ? cur?.label : String(b.label || '').trim().slice(0, 60);
  if (!label) throw Object.assign(new Error('A role needs a name'), { status: 400 });
  let k = cur ? cur.key : slug(b.key || label);
  if (!cur && BASE_ROLES.map((x) => x.toLowerCase()).includes(k)) throw Object.assign(new Error('That name is a base role'), { status: 400 });
  let base = cur ? cur.base_role : b.base_role;
  if (cur?.builtin) base = cur.base_role;            // a base role's tier is the code's, not editable
  else if (b.base_role !== undefined && !cur?.builtin) base = b.base_role;
  if (!BASE_ROLES.includes(base)) throw Object.assign(new Error(`base_role must be one of ${BASE_ROLES.join(', ')}`), { status: 400 });
  const can = b.can === undefined ? cur?.can || [] : strs(b.can) || [];
  const cannot = b.cannot === undefined ? cur?.cannot || [] : strs(b.cannot) || [];
  const presets = b.presets === undefined ? cur?.presets || [] : strs(b.presets) || [];
  const { rows: [out] } = await pool.query(
    `INSERT INTO role_defs (key, label, base_role, short, who, pages, can, cannot, presets, sort, builtin, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,FALSE,$11,NOW())
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, base_role = EXCLUDED.base_role, short = EXCLUDED.short, who = EXCLUDED.who, pages = EXCLUDED.pages, can = EXCLUDED.can, cannot = EXCLUDED.cannot, presets = EXCLUDED.presets, sort = EXCLUDED.sort, updated_by = EXCLUDED.updated_by, updated_at = NOW() RETURNING *`,
    [k, label, base, b.short === undefined ? cur?.short || null : (String(b.short || '').trim() || null), b.who === undefined ? cur?.who || null : (String(b.who || '').trim() || null), b.pages === undefined ? cur?.pages || null : (String(b.pages || '').trim() || null), JSON.stringify(can), JSON.stringify(cannot), JSON.stringify(presets), b.sort === undefined ? (cur?.sort ?? 99) : Number(b.sort) || 0, user?.id || null]);
  // a custom role's base changed → every person on it moves tier
  if (cur && !cur.builtin && cur.base_role !== base) await pool.query('UPDATE users SET role = $2 WHERE role_key = $1', [k, base]);
  return out;
}
async function deleteRole(key) {
  const { rows: [cur] } = await pool.query('SELECT * FROM role_defs WHERE key = $1', [key]);
  if (!cur) throw Object.assign(new Error('Role not found'), { status: 404 });
  if (cur.builtin) throw Object.assign(new Error('A base role cannot be removed — the API enforces it'), { status: 400 });
  const { rowCount } = await pool.query('UPDATE users SET role_key = NULL WHERE role_key = $1', [key]);   // they keep the base role
  await pool.query('DELETE FROM role_defs WHERE key = $1', [key]);
  return { reverted: rowCount };
}

// Resolve what a person form sent: `role_key` (custom or base) → { role (base), role_key }.
async function resolveRole(roleKey, fallbackRole) {
  if (!roleKey) return { role: fallbackRole || 'User', role_key: null };
  if (BASE_ROLES.includes(roleKey)) return { role: roleKey, role_key: null };
  const { rows: [r] } = await pool.query('SELECT key, base_role FROM role_defs WHERE key = $1', [roleKey]);
  if (!r) throw Object.assign(new Error('Unknown role'), { status: 400 });
  return { role: r.base_role, role_key: r.key };
}

module.exports = { ensureSchema, read, upsertPreset, deletePreset, upsertDepartment, deleteDepartment, upsertRole, deleteRole, resolveRole, BASE_ROLES, SEED };
