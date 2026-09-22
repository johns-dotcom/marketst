#!/usr/bin/env node
/**
 * The CEO's list (2026-09-22): contract terms, deliverables, options, signature
 * status, release flags and status, the four alerts, the team seed.
 * Against the dev database, server on :3011 (MAIL_DRY_RUN=1).
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/ceo-list-fixture.cjs
 *
 * Seeds an artist with an Active contract signed 300 days ago on a 1-year term
 * with 3 deliverables and 2 options, then reads what the terms, the alerts,
 * the Home panel, the Flags sweep and the email schedule say — before and after
 * a release, a "does not count" tick, and an exercised option. Deletes what it made.
 */
require('dotenv').config();
const pool = require('./../db');
const BASE = 'http://localhost:3011';
const TAG = `CeoFx${Date.now()}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const made = { artists: [], contracts: [], releases: [] };
  try {
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const token = login.body?.data?.token; check('login', !!token);

    // ── 1. an artist with a contract: 3 deliverables, 2 options, 1-year term, signed 300 days ago ──
    const art = await api('POST', '/artists', token, { name: `${TAG} Vera Lune`, genre: 'Indie' });
    const artistId = art.body?.data?.id; if (artistId) made.artists.push(artistId);
    check('artist created', art.status === 201 && !!artistId);
    const c = await api('POST', '/contracts', token, { artist_id: artistId, type: 'Master License', status: 'Active', date_signed: daysAgo(300), royalty_split: 60, advance: 10000, territory: 'World', num_releases: 3, options_total: 2, term_years: 1, marketing_budget: 20000, signature_status: 'sent' });
    const contract = c.body?.data; const cid = contract?.id; if (cid) made.contracts.push(cid);
    check('contract created with terms', c.status === 201 && !!cid, JSON.stringify(c.body).slice(0, 200));
    const t0 = contract?.terms;
    check('terms: 3 deliverables, 0 delivered, 3 remaining', t0?.deliverables_total === 3 && t0?.delivered === 0 && t0?.remaining === 3, JSON.stringify(t0));
    check('terms: 2 options, none exercised, period 1 of 3', t0?.options_total === 2 && t0?.options_exercised === 0 && t0?.options_remaining === 2 && t0?.current_period === 1);
    check('terms: expiry defaulted to signed + 1 year (period ends in ~65 days)', t0?.days_to_period_end >= 63 && t0?.days_to_period_end <= 67, t0?.days_to_period_end);
    check('terms: artist 60 / label 40, marketing budget, advance, term', t0?.artist_split === 60 && t0?.label_split === 40 && Number(t0?.marketing_budget) === 20000 && Number(t0?.advance) === 10000 && Number(t0?.term_years) === 1);
    check('terms: signature status by hand = sent', t0?.signature === 'sent' && t0?.signature_source === 'manual');
    const sig = await api('PUT', `/contracts/${cid}`, token, { signature_status: 'fully_executed' });
    check('signature status moves to fully executed', sig.status === 200 && sig.body?.data?.terms?.signature === 'fully_executed');
    const badSig = await api('PUT', `/contracts/${cid}`, token, { signature_status: 'wet-ink' });
    check('an unknown signature status is refused', badSig.status === 400);

    // ── 2. the alerts before any release ──
    const alertsLib = require('../lib/deal-alerts');
    let all = await alertsLib.alerts();
    const mine = (kind) => all.filter((a) => a.kind === kind && a.artist_id === artistId);
    check('alert: release gap (nothing released since signing 300 days ago)', mine('release_gap').length === 1 && mine('release_gap')[0].days >= 299 && mine('release_gap')[0].severity === 'high', JSON.stringify(mine('release_gap')[0]));
    check('alert: option period ending within 90 days, medium', mine('option_expiring').length === 1 && mine('option_expiring')[0].severity === 'medium' && mine('option_expiring')[0].to === `/contracts?focus=${cid}`);
    check('alert: 3 deliverables still owed as the period ends', mine('deliverable_due').length === 1 && /3 of 3/.test(mine('deliverable_due')[0].title));
    check('no advance alert (no signed deal behind this contract)', mine('advance_triggered').length === 0);
    const due = await alertsLib.dueEmails();
    const dueMine = due.filter((d) => d.alert.artist_id === artistId);
    check('emails due: release gap bucket 5 (300 / 60), option threshold 90, deliverables 90', dueMine.some((d) => d.period === `${artistId}:5` && d.alert.kind === 'release_gap') && dueMine.some((d) => d.period === `${cid}:90` && d.alert.kind === 'option_expiring') && dueMine.some((d) => d.period === `${cid}:90` && d.alert.kind === 'deliverable_due'), dueMine.map((d) => `${d.alert.kind}@${d.period}`).join(' '));
    const rcpt = await alertsLib.recipients(mine('release_gap')[0]);
    check('recipients: the always-to address (soli@market.st) with no deal owner', rcpt.length === 1 && rcpt[0].email === 'soli@market.st', JSON.stringify(rcpt));
    const home = await api('GET', '/dashboard/alerts', token);
    check('GET /dashboard/alerts lists the three for a Superadmin, worst first', home.status === 200 && home.body?.data?.filter((a) => a.artist_id === artistId).length === 3 && home.body.data[0].severity === 'high' && home.body.withheld.length === 0);

    // ── 3. a release that counts → delivered 1; untick → 0; a scheduled + ingested one ──
    const r1 = await api('POST', '/releases', token, { artist_id: artistId, project_name: `${TAG} First Light`, release_date: daysAgo(10), release_type: 'Single' });
    const rel1 = r1.body?.data?.id || r1.body?.id; if (rel1) made.releases.push(rel1);
    check('release created', (r1.status === 201 || r1.status === 200) && !!rel1, JSON.stringify(r1.body).slice(0, 160));
    let cs = await api('GET', '/contracts', token); let cc = cs.body?.data?.find((x) => x.id === cid);
    check('a released song counts: delivered 1, remaining 2', cc?.terms?.delivered === 1 && cc?.terms?.remaining === 2, JSON.stringify(cc?.terms?.deliverables));
    const list = await api('GET', '/releases', token); const lr = (list.body?.data || []).find((x) => x.id === rel1);
    check('release status = Released (date in the past), counts_toward_deal defaults true', lr?.status === 'Released' && lr?.counts_toward_deal === true, JSON.stringify({ s: lr?.status, c: lr?.counts_toward_deal }));
    const un = await api('PUT', `/releases/${rel1}`, token, { counts_toward_deal: false });
    check('PUT counts_toward_deal=false is stored', un.status === 200 && un.body?.data?.counts_toward_deal === false);
    cs = await api('GET', '/contracts', token); cc = cs.body?.data?.find((x) => x.id === cid);
    check('…and the deliverable count drops back to 0 of 3', cc?.terms?.delivered === 0 && cc?.terms?.remaining === 3);
    const r2 = await api('POST', '/releases', token, { artist_id: artistId, project_name: `${TAG} Second Sun`, release_date: daysAhead(20), release_type: 'Single' });
    const rel2 = r2.body?.data?.id; if (rel2) made.releases.push(rel2);
    const sched = (await api('GET', '/releases', token)).body?.data?.find((x) => x.id === rel2);
    check('a future release reads Scheduled', sched?.status === 'Scheduled');
    const ing = await api('PUT', `/releases/${rel2}`, token, { ingested: true });
    check('marking it ingested → status Ingested', ing.status === 200 && ing.body?.data?.ingested === true && ing.body?.data?.status === 'Ingested', JSON.stringify({ i: ing.body?.data?.ingested, s: ing.body?.data?.status }));
    cs = await api('GET', '/contracts', token); cc = cs.body?.data?.find((x) => x.id === cid);
    check('terms count the scheduled one separately (scheduled 1, delivered 0)', cc?.terms?.scheduled === 1 && cc?.terms?.delivered === 0);
    all = await alertsLib.alerts();
    check('release gap alert clears once something was released (10 days ago)', mine('release_gap').length === 0);

    // ── 4. exercise an option → period 2, expiry +1 year, option alert gone ──
    const ex = await api('POST', `/contracts/${cid}/exercise-option`, token);
    const t2 = ex.body?.data?.terms;
    check('exercise option: exercised 1, remaining 1, period 2 of 3', ex.status === 200 && t2?.options_exercised === 1 && t2?.options_remaining === 1 && t2?.current_period === 2, JSON.stringify(t2));
    check('…the period end moved a year out (~430 days)', t2?.days_to_period_end >= 425 && t2?.days_to_period_end <= 435, t2?.days_to_period_end);
    all = await alertsLib.alerts();
    check('option and deliverable alerts clear after exercising', mine('option_expiring').length === 0 && mine('deliverable_due').length === 0);
    await api('POST', `/contracts/${cid}/exercise-option`, token);
    const ex3 = await api('POST', `/contracts/${cid}/exercise-option`, token);
    check('a third exercise is refused (no options left)', ex3.status === 400, ex3.body?.error);

    // ── 5. Flags detectors run as part of the sweep ──
    const c2 = await api('POST', '/contracts', token, { artist_id: artistId, type: 'Single License', status: 'Active', date_signed: daysAgo(340), term_years: 1, num_releases: 1 });
    const cid2 = c2.body?.data?.id; if (cid2) made.contracts.push(cid2);
    const flags = require('../lib/flags-register');
    await flags.sweep({ trigger: 'fixture' });
    const { rows: fr } = await pool.query(`SELECT kind, key FROM flag_register WHERE resolved_at IS NULL AND kind LIKE 'alert_%' AND key = ANY($1)`, [[String(cid2), String(artistId)]]);
    check('the sweep registers alert_option_expiring for the 25-days-left contract', fr.some((f) => f.kind === 'alert_option_expiring' && f.key === String(cid2)), JSON.stringify(fr));
    check('…and alert_deliverable_due for it too', fr.some((f) => f.kind === 'alert_deliverable_due' && f.key === String(cid2)));
    const dueNow = (await alertsLib.dueEmails()).filter((d) => d.alert.contract_id === cid2);
    check('emails due for it fall in the 30-day threshold', dueNow.some((d) => d.alert.kind === 'option_expiring' && d.period === `${cid2}:30`) && dueNow.some((d) => d.alert.kind === 'deliverable_due' && d.period === `${cid2}:30`), dueNow.map((d) => d.period).join(' '));

    // ── 6. the team ──
    const { rows: team } = await pool.query(`SELECT email, role, department, title, password_hash IS NULL AS no_pw, (SELECT COUNT(*)::int FROM user_invites i WHERE i.user_id = u.id AND i.used_at IS NULL) AS invites FROM users u WHERE email IN ('soli@market.st','london@market.st','chase@market.st') ORDER BY email`);
    check('three team accounts exist, no password, one open invite each', team.length === 3 && team.every((u) => u.no_pw && u.invites >= 1), JSON.stringify(team));
    const by = Object.fromEntries(team.map((u) => [u.email, u]));
    check('Soli: Superadmin · Executive · Founder / President', by['soli@market.st']?.role === 'Superadmin' && by['soli@market.st']?.department === 'Executive' && by['soli@market.st']?.title === 'Founder / President');
    check('London: Admin · Operations · Head of Operations', by['london@market.st']?.role === 'Admin' && by['london@market.st']?.department === 'Operations');
    check('Chase: User · Marketing · Digital Coordinator, with the Marketing pages', by['chase@market.st']?.role === 'User' && by['chase@market.st']?.department === 'Marketing' && (await pool.query(`SELECT COUNT(*)::int AS n FROM user_page_permissions p JOIN users u ON u.id = p.user_id WHERE u.email = 'chase@market.st'`)).rows[0].n > 3);
    const { rows: [lab] } = await pool.query(`SELECT alerts_to FROM label_settings WHERE id = 1`);
    check("label alerts_to defaults to soli@market.st", lab?.alerts_to === 'soli@market.st');
    const { rows: dep } = await pool.query(`SELECT name FROM departments WHERE name = 'Interns'`);
    check("an 'Interns' department exists", dep.length === 1);
    const { rows: [john] } = await pool.query(`SELECT title FROM users WHERE email = 'john@deanst.co'`);
    check("John's title is Backend / Books", john?.title === 'Backend / Books');
    const people = await api('GET', '/settings/people', token);
    const soli = (people.body?.data || people.body || []).find?.((p) => p.email === 'soli@market.st');
    check('People lists Soli with the invite pending', !!soli && (soli.invite_pending === true || soli.invite_pending === 1 || soli.pending === true), JSON.stringify(soli || people.body).slice(0, 200));
  } catch (e) { console.error('fixture threw:', e); results.push({ name: 'threw', ok: false }); }
  finally {
    for (const id of made.releases) await pool.query('DELETE FROM releases WHERE id = $1', [id]).catch(() => {});
    for (const id of made.contracts) { await pool.query('DELETE FROM contracts WHERE id = $1', [id]).catch(() => {}); await pool.query(`DELETE FROM flag_register WHERE key = $1 AND kind LIKE 'alert_%'`, [String(id)]).catch(() => {}); }
    for (const id of made.artists) { await pool.query('DELETE FROM artists WHERE id = $1', [id]).catch(() => {}); await pool.query(`DELETE FROM flag_register WHERE key = $1 AND kind LIKE 'alert_%'`, [String(id)]).catch(() => {}); }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    await pool.end();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
