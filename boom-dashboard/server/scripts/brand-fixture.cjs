#!/usr/bin/env node
/** Brand assets: upload · list · download bytes · category · delete gate. Server on :3011 (no R2 → legacy column). */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('./../db');
const BASE = 'http://localhost:3011';
const TAG = `BrandFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const made = { users: [] };
  try {
    const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) }).then((r) => r.json());
    const T = login.data?.token; check('login', !!T);
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, 'User', 'x') RETURNING id, email, name, role`, [`${TAG} User`, `${TAG.toLowerCase()}@example.test`]); made.users.push(u.id);
    const U = jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const up = async (token, name, cat, bytes = PNG, type = 'image/png') => {
      const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), name); fd.append('category', cat);
      const r = await fetch(`${BASE}/api/brand`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const a = await up(U, `${TAG}-logo.png`, 'logo');
    check('a User can upload a logo (201)', a.status === 201 && a.body.data.category === 'logo' && a.body.data.original_name === `${TAG}-logo.png`, JSON.stringify(a.body).slice(0, 140));
    const b = await up(T, `${TAG}-photo.jpg`, 'photo', PNG, 'image/jpeg');
    check('the Superadmin uploads a photo', b.status === 201 && b.body.data.category === 'photo');
    const bad = await up(T, `${TAG}-page.html`, 'other', Buffer.from('<script>1</script>'), 'text/html');
    check('an HTML file is refused (400) with a sentence', bad.status === 400 && /not a brand asset/.test(bad.body?.error || ''));
    const weird = await up(T, `${TAG}-x.png`, 'banner');
    check('an unknown category files as other', weird.status === 201 && weird.body.data.category === 'other');
    const list = await fetch(`${BASE}/api/brand`, { headers: { authorization: `Bearer ${U}` } }).then((r) => r.json());
    const mine = list.data.filter((f) => f.original_name.startsWith(TAG));
    check('GET /brand lists the three, newest first, with uploader names', mine.length === 3 && mine[0].original_name === `${TAG}-x.png` && mine.some((f) => f.uploaded_by_name === `${TAG} User`));
    const dl = await fetch(`${BASE}/uploads/${a.body.data.filename}?token=${encodeURIComponent(U)}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    check('the file downloads through /uploads with the same bytes', dl.status === 200 && bytes.equals(PNG), `${dl.status} ${bytes.length}b`);
    const svg = await up(U, `${TAG}-mark.svg`, 'logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml');
    check('an SVG logo is accepted', svg.status === 201 && svg.body.data.mime_type === 'image/svg+xml');
    const dsvg = await fetch(`${BASE}/uploads/${svg.body.data.filename}?token=${encodeURIComponent(U)}`);
    const cd = dsvg.headers.get('content-disposition') || ''; const ct = dsvg.headers.get('content-type') || '';
    check('…and is served as an ATTACHMENT, never rendered on our origin', dsvg.status === 200 && /attachment/i.test(cd) && !/svg/i.test(ct), `${ct} | ${cd}`);
    const delOther = await fetch(`${BASE}/api/brand/${b.body.data.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${U}` } });
    check("a User cannot remove someone else's file (403)", delOther.status === 403);
    const delOwn = await fetch(`${BASE}/api/brand/${a.body.data.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${U}` } });
    check('…but can remove their own', delOwn.status === 200);
    const delAdmin = await fetch(`${BASE}/api/brand/${svg.body.data.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${T}` } });
    check("an admin removes anyone's", delAdmin.status === 200);
  } catch (err) { console.error('FIXTURE ERROR', err); results.push({ n: 'no exception', ok: false }); }
  finally {
    await pool.query(`DELETE FROM entity_files WHERE entity_type = 'brand' AND original_name LIKE $1`, [`${TAG}%`]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
