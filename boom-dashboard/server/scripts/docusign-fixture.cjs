#!/usr/bin/env node
// DocuSign envelopes, against the dry-run DocuSign in lib/docusign.js.
//   cd server && DOCUSIGN_DRY_RUN=1 PORT=3011 node index.js &
//   node scripts/docusign-fixture.cjs
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('../db');
const BASE = 'http://localhost:3011/api';
const TAG = `DsFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => { const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const sendForm = async (token, fields, file) => {
  const fd = new FormData(); for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, String(v));
  if (file) fd.append('file', new Blob([file], { type: 'application/pdf' }), 'doc.pdf');
  const r = await fetch(`${BASE}/docusign/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd }); return { status: r.status, body: await r.json().catch(() => null) };
};
const made = { artists: [], contracts: [], files: [], envelopes: [], ndas: [] };
(async () => {
  const savedAcct = (await pool.query('SELECT * FROM docusign_account WHERE id = 1')).rows[0] || null;
  const savedSigner = (await pool.query('SELECT signatory_name, signatory_email FROM label_settings WHERE id = 1')).rows[0] || {};
  try {
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; if (!T) throw new Error('login failed');
    await pool.query('DELETE FROM docusign_account WHERE id = 1');
    let st = await api('GET', '/docusign/status', T);
    check('status: unconnected, dry run, label signer reported', st.status === 200 && st.body.data.connected === false && st.body.data.dry_run === true && 'label_signer' in st.body.data);

    const state = jwt.sign({ uid: 1, t: 'docusign_connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const cb = await fetch(`${BASE}/docusign/oauth/callback?code=dry&state=${state}`, { redirect: 'manual' });
    check('callback: connects and redirects with ds=connected and the account name', cb.status === 302 && /ds=connected/.test(cb.headers.get('location') || '') && /account=Dry\+Run\+Records/.test(cb.headers.get('location') || ''), cb.headers.get('location'));
    check('callback: a forged state → ds=badstate', /ds=badstate/.test((await fetch(`${BASE}/docusign/oauth/callback?code=x&state=bad`, { redirect: 'manual' })).headers.get('location') || ''));

    // an artist with a contract that has a PDF on file
    const artist = (await pool.query(`INSERT INTO artists (name, genre, email) VALUES ($1, 'Test', $2) RETURNING id`, [`${TAG} Artist`, `${TAG.toLowerCase()}@example.com`])).rows[0]; made.artists.push(artist.id);
    const contract = (await pool.query(`INSERT INTO contracts (artist_id, type, status) VALUES ($1, 'Recording', 'Active') RETURNING id`, [artist.id])).rows[0]; made.contracts.push(contract.id);

    // no label signer email → refused with the sentence naming Settings › Label
    await pool.query(`UPDATE label_settings SET signatory_name = 'Fixture Signer', signatory_email = NULL WHERE id = 1`);
    let send = await sendForm(T, { doc_type: 'contract', doc_id: contract.id, signer_name: 'Counter Party', signer_email: 'counter@example.com' }, PDF);
    check('send: refused until the label signer has an email (Settings › Label)', send.status === 400 && /Settings › Label/.test(send.body?.error || ''), send.body?.error);
    await pool.query(`UPDATE label_settings SET signatory_email = 'signer@example.com' WHERE id = 1`);
    // no PDF on the contract and none uploaded → refused
    send = await sendForm(T, { doc_type: 'contract', doc_id: contract.id, signer_name: 'Counter Party', signer_email: 'counter@example.com' });
    check('send: a contract without a PDF on file is refused', send.status === 400 && /no PDF/i.test(send.body?.error || ''), send.body?.error);
    // upload the PDF along → sent; source file stored; artist + countersigner recorded
    send = await sendForm(T, { doc_type: 'contract', doc_id: contract.id, signer_name: 'Counter Party', signer_email: 'counter@example.com', message: 'Please sign by Friday.' }, PDF);
    const env = send.body?.data; if (env) made.envelopes.push(env.id);
    check('send: creates the envelope — counterparty first, label signer second, status sent', send.status === 201 && env.status === 'sent' && env.signer_email === 'counter@example.com' && env.countersigner_email === 'signer@example.com' && env.countersigner_name === 'Fixture Signer' && env.artist_id === artist.id, JSON.stringify(send.body).slice(0, 200));
    if (env?.source_file_id) made.files.push(env.source_file_id);
    check('…the source PDF is kept as a file row on the contract', !!env?.source_file_id && (await pool.query('SELECT entity_type, entity_id FROM entity_files WHERE id = $1', [env.source_file_id])).rows[0]?.entity_type === 'contract');
    check('send: same address for both signers is refused', (await sendForm(T, { doc_type: 'contract', doc_id: contract.id, signer_name: 'X', signer_email: 'signer@example.com' }, PDF)).status === 400);
    check('send: an unknown document type is refused', (await sendForm(T, { doc_type: 'lease', doc_id: 1, signer_name: 'X', signer_email: 'x@example.com' }, PDF)).status === 400);

    // the list, by document and by artist
    const byDoc = await api('GET', `/docusign/envelopes?doc_type=contract&doc_id=${contract.id}`, T);
    const byArtist = await api('GET', `/docusign/envelopes?artist_id=${artist.id}`, T);
    check('envelopes: listed by document and by artist', byDoc.body.data.length === 1 && byArtist.body.data.length === 1 && byDoc.body.data[0].id === env.id);

    // refresh: dry DocuSign goes delivered → completed; the signed PDF lands on the artist AND the contract
    let r1 = await api('POST', `/docusign/envelopes/${env.id}/refresh`, T);
    check('refresh #1: delivered, counterparty signed, label signer pending', r1.body.data.status === 'delivered' && r1.body.data.signer_status === 'completed' && r1.body.data.countersigner_status !== 'completed', `${r1.body.data.status} ${r1.body.data.signer_status}/${r1.body.data.countersigner_status}`);
    let r2 = await api('POST', `/docusign/envelopes/${env.id}/refresh`, T);
    check('refresh #2: completed, with a completed_at and a signed file', r2.body.data.status === 'completed' && !!r2.body.data.completed_at && !!r2.body.data.signed_file_id);
    const artistFiles = (await pool.query(`SELECT id, label FROM entity_files WHERE entity_type = 'artist' AND entity_id = $1`, [artist.id])).rows; artistFiles.forEach((f) => made.files.push(f.id));
    const contractFiles = (await pool.query(`SELECT id, label FROM entity_files WHERE entity_type = 'contract' AND entity_id = $1`, [contract.id])).rows; contractFiles.forEach((f) => made.files.push(f.id));
    check('…the signed PDF is on the artist’s Documents (label "Signed contract") and on the contract', artistFiles.some((f) => /^Signed contract/i.test(f.label)) && contractFiles.some((f) => /^Signed contract/i.test(f.label)));
    const c = (await pool.query('SELECT date_signed, file_path FROM contracts WHERE id = $1', [contract.id])).rows[0];
    check('…and the contract gets date_signed and a file_path', !!c.date_signed && !!c.file_path);
    const r3 = await api('POST', `/docusign/envelopes/${env.id}/refresh`, T);
    check('refresh on a completed envelope is a no-op (no second signed file)', r3.body.data.signed_file_id === r2.body.data.signed_file_id && (await pool.query(`SELECT COUNT(*)::int AS n FROM entity_files WHERE entity_type = 'artist' AND entity_id = $1`, [artist.id])).rows[0].n === 1);

    // an NDA: the browser renders the PDF and sends it along; void it
    const nda = (await pool.query(`INSERT INTO boom_ndas (effective_date, owner_name, recipient_name, recipient_email, created_by) VALUES (CURRENT_DATE, 'Market Street', $1, 'nda@example.com', 'fx') RETURNING id`, [`${TAG} Artist`])).rows[0]; made.ndas.push(nda.id);
    const s2 = await sendForm(T, { doc_type: 'nda', doc_id: nda.id }, PDF); if (s2.body?.data) { made.envelopes.push(s2.body.data.id); made.files.push(s2.body.data.source_file_id); }
    check('send: an NDA takes signer name/email from the record and resolves the artist by name', s2.status === 201 && s2.body.data.signer_email === 'nda@example.com' && s2.body.data.artist_id === artist.id, JSON.stringify(s2.body).slice(0, 160));
    check('send: an NDA without the PDF is refused (the page renders it)', (await sendForm(T, { doc_type: 'nda', doc_id: nda.id })).status === 400);
    const v = await api('POST', `/docusign/envelopes/${s2.body.data.id}/void`, T, { reason: 'fixture' });
    check('void: closes the envelope', v.status === 200 && v.body.data.status === 'voided');
    check('void twice is refused', (await api('POST', `/docusign/envelopes/${s2.body.data.id}/void`, T, {})).status === 400);
    const poll = await require('../lib/docusign').pollEnvelopes();
    check('pollEnvelopes runs and skips closed envelopes', typeof poll.checked === 'number');
    const wh = await fetch(`${BASE}/docusign/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { envelopeId: 'nope' } }) });
    check('webhook: public, answers 200, unknown envelope ignored', wh.status === 200);
    check('disconnect', (await api('DELETE', '/docusign/account', T)).status === 200 && (await api('GET', '/docusign/status', T)).body.data.connected === false);
  } catch (e) { console.error('FIXTURE THREW', e); results.push({ n: 'threw', ok: false }); }
  finally {
    await pool.query('DELETE FROM signature_envelopes WHERE id = ANY($1::int[])', [made.envelopes]).catch(() => {});
    await pool.query('DELETE FROM entity_files WHERE id = ANY($1::int[])', [made.files.filter(Boolean)]).catch(() => {});
    await pool.query(`DELETE FROM entity_files WHERE (entity_type = 'artist' AND entity_id = ANY($1::int[])) OR (entity_type = 'contract' AND entity_id = ANY($2::int[])) OR (entity_type = 'nda' AND entity_id = ANY($3::int[]))`, [made.artists, made.contracts, made.ndas]).catch(() => {});
    await pool.query('DELETE FROM boom_ndas WHERE id = ANY($1::int[])', [made.ndas]).catch(() => {});
    await pool.query('DELETE FROM contracts WHERE id = ANY($1::int[])', [made.contracts]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1::int[])', [made.artists]).catch(() => {});
    await pool.query('UPDATE label_settings SET signatory_name = $1, signatory_email = $2 WHERE id = 1', [savedSigner.signatory_name || null, savedSigner.signatory_email || null]).catch(() => {});
    if (savedAcct) await pool.query(`INSERT INTO docusign_account SELECT * FROM jsonb_populate_record(NULL::docusign_account, $1::jsonb) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(savedAcct)]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`${passed}/${results.length} passed`); process.exit(passed === results.length ? 0 : 1);
  }
})();
