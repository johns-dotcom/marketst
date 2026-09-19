#!/usr/bin/env node
/**
 * Signing an artist: what "Deal → Signed" does, once, and what the checklist
 * then says. Against the dev database, server on :3011.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/signing-fixture.cjs
 *
 * Seeds a deal at Offer with terms + contact, moves it to Signed through PUT,
 * reads the roster row, the advance invoice, the calendar marker and the
 * onboarding steps; signs again (no duplicates); a second deal with NO advance;
 * a third deal whose artist is ALREADY on the roster (matched, not duplicated).
 * Deletes everything it made.
 */
require('dotenv').config();
const pool = require('./../db');
const BASE = 'http://localhost:3011';
const EMAIL = 'john@deanst.co';
const TAG = `SignFx${Date.now()}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const made = { deals: [], artists: [], expenses: [], events: [], releases: [] };
  try {
    const login = await api('POST', '/auth/login', null, { email: EMAIL, password: process.env.PW_JOHN });
    const token = login.body?.data?.token; check('login', !!token);

    // ── 1. a deal at Offer, with terms and contact ──
    const name = `${TAG} Rosa Vale`;
    const email = `${TAG.toLowerCase()}@example.test`;
    const created = await api('POST', '/deals', token, { artist_name: name, genre: 'Pop', stage: 'Offer', deal_type: 'Master License' });
    const dealId = created.body?.data?.id; made.deals.push(dealId);
    check('a deal is created at Offer', created.status === 201 && !!dealId);
    const terms = await api('PUT', `/deals/${dealId}`, token, {
      advance: 25000, royalty_split: 50, term_months: 24, territory: 'World', num_releases: 3, option_periods: 1,
      artist_email: email, artist_phone: '+1 555 0100', manager_name: 'Sam Manager', manager_email: 'sam@example.test',
      socials: [{ platform: 'instagram', handle: '@rosavale' }], spotify_url: 'https://open.spotify.com/artist/x',
    });
    const d1 = terms.body?.data;
    check('terms and contact are stored on the deal', terms.status === 200 && Number(d1?.advance) === 25000 && Number(d1?.term_months) === 24 && d1?.artist_email === email && Array.isArray(d1?.socials) && d1.socials[0]?.handle === '@rosavale', JSON.stringify(terms.body).slice(0, 200));
    check('no signing yet at Offer', !terms.body?.signing && !d1?.signed_artist_id);
    const badEmail = await api('PUT', `/deals/${dealId}`, token, { artist_email: 'not-an-email' });
    check('a malformed artist email is refused', badEmail.status === 400);
    const cleared = await api('PUT', `/deals/${dealId}`, token, { option_periods: '' });
    check("'' clears a term (option periods → null)", cleared.body?.data?.option_periods === null);
    const one = await api('GET', `/deals/${dealId}`, token);
    check('GET /deals/:id returns the deal for the contract form', one.status === 200 && one.body?.data?.id === dealId && Number(one.body.data.royalty_split) === 50);

    // ── 2. → Signed ──
    const signed = await api('PUT', `/deals/${dealId}`, token, { stage: 'Signed' });
    const sg = signed.body?.signing;
    check('moving to Signed returns what signing did', signed.status === 200 && !!sg && !sg.error, JSON.stringify(signed.body).slice(0, 300));
    check('…a roster row was created', sg?.created?.artist === true && !!sg?.artist?.id);
    const artistId = sg?.artist?.id; if (artistId) made.artists.push(artistId);
    check('…and the advance invoice', sg?.created?.advance === true && !!sg?.advance_expense_id);
    if (sg?.advance_expense_id) made.expenses.push(sg.advance_expense_id);
    check('…and the calendar marker', sg?.created?.marker === true);
    const { rows: [a] } = await pool.query('SELECT * FROM artists WHERE id = $1', [artistId]);
    check('the roster row carries the contact block and signed_at', a && a.email === email && a.phone === '+1 555 0100' && a.manager_name === 'Sam Manager' && a.spotify_url && a.socials?.[0]?.handle === '@rosavale' && !!a.signed_at && a.signed_deal_id === dealId, JSON.stringify(a).slice(0, 200));
    const { rows: [e] } = await pool.query('SELECT * FROM expenses WHERE id = $1', [sg?.advance_expense_id]);
    check('the advance is an approved, unpaid, Net-30 invoice payable to the artist', e && e.status === 'approved' && e.payment_status === 'Unpaid' && e.payment_terms === 'Net 30' && e.payee === name && e.artist === name && e.category === 'Advance' && Number(e.amount) === 25000, e && `${e.status}/${e.payment_status}/${e.payment_terms}/${e.category}`);
    const dueOk = e && /^\d{4}-\d{2}-\d{2}/.test(String(e.scheduled_payment_date)) && (new Date(String(e.scheduled_payment_date).slice(0, 10)) - new Date(new Date().toISOString().slice(0, 10))) / 86400000 >= 29;
    check('…due about 30 days out, filed by the artist email, recoupable AND reviewed', dueOk && e.vendor_email === email && e.recoupable === true && e.recoup_reviewed === true && e.entry_source === 'signing');
    const { rows: ev } = await pool.query(`SELECT * FROM calendar_events WHERE event_type = 'signed' AND description = $1`, [`deal:${dealId}`]);
    ev.forEach((x) => made.events.push(x.id));
    check('the signed marker sits on today and links to the profile', ev.length === 1 && ev[0].link === `/artists/${artistId}`, ev.length);
    const cal = await api('GET', '/calendar', token);
    const marker = (cal.body?.events || []).find((x) => x.id === `event-${ev[0]?.id}`);
    check('the calendar feed carries it as type signed, not deletable, with its link', marker && marker.type === 'signed' && marker.deletable === false && marker.to === `/artists/${artistId}`);
    const pay = (cal.body?.events || []).find((x) => x.id === `payment-${sg?.advance_expense_id}`);
    check('and the advance is a payment due on the calendar', !!pay && /25,000/.test(pay.title));

    // ── 3. idempotent ──
    const again = await api('POST', `/deals/${dealId}/sign`, token);
    check('signing again creates nothing', again.status === 200 && again.body?.signing?.created?.artist === false && again.body.signing.created.advance === false && again.body.signing.created.marker === false, JSON.stringify(again.body?.signing));
    const { rows: adv } = await pool.query(`SELECT id FROM expenses WHERE payee = $1 AND category = 'Advance'`, [name]);
    check('exactly one advance invoice exists', adv.length === 1, adv.length);
    const againPut = await api('PUT', `/deals/${dealId}`, token, { notes: 'edited after signing' });
    check('editing a Signed deal does not re-run the signing', againPut.status === 200 && !againPut.body?.signing);

    // ── 4. the checklist ──
    const ob = await api('GET', `/artists/${artistId}/onboarding`, token);
    const o = ob.body?.data;
    const step = (k) => (o?.steps || []).find((s) => s.key === k);
    check('GET /artists/:id/onboarding answers five steps', ob.status === 200 && o?.steps?.length === 5 && o.total === 5, JSON.stringify(o).slice(0, 200));
    check('contract: not done, linking to the prefilled form with the deal', step('contract') && !step('contract').done && step('contract').to.includes(`deal=${dealId}`) && step('contract').to.includes('new=1'));
    check('payment: not done — no details, no W-9', step('payment') && !step('payment').done && step('payment').on_file === false && step('payment').w9 === false && step('payment').email === email);
    check('advance: not done, names the amount and the due date', step('advance') && !step('advance').done && /25,000/.test(step('advance').detail) && /due/.test(step('advance').detail));
    check('budget: not done; release: not done', !step('budget').done && !step('release').done);
    check('4 open, not complete, no onboarded_at', o.open === 5 && o.complete === false && !o.onboarded_at);
    const list = await api('GET', '/artists/onboarding', token);
    check('GET /artists/onboarding lists this artist', list.status === 200 && (list.body?.data || []).some((x) => x.artist_id === artistId));
    const loop = await api('GET', '/dashboard/loop', token);
    check('the Home loop has an onboarding section counting them', loop.body?.data?.onboarding && loop.body.data.onboarding.count >= 1 && loop.body.data.onboarding.steps_open >= 5 && loop.body.data.onboarding.to === '/artists?onboarding=1', JSON.stringify(loop.body?.data?.onboarding));

    // ticks from data: pay the advance, add a release, type both budget lines
    await pool.query(`UPDATE expenses SET payment_status = 'Paid', payment_date = CURRENT_DATE WHERE id = $1`, [sg.advance_expense_id]);
    const { rows: [r] } = await pool.query(`INSERT INTO releases (artist_id, project_name, release_date) VALUES ($1, $2, CURRENT_DATE + 40) RETURNING id`, [artistId, `${TAG} Song`]); made.releases.push(r.id);
    await api('PUT', `/artist-budgets/${encodeURIComponent(require('../lib/artist-key').artistBucketKey(name))}/advance`, token, { amount: 25000 });
    await api('PUT', `/artist-budgets/${encodeURIComponent(require('../lib/artist-key').artistBucketKey(name))}/marketing`, token, { amount: 40000 });
    const ob2 = (await api('GET', `/artists/${artistId}/onboarding`, token)).body?.data;
    const s2 = (k) => (ob2?.steps || []).find((s) => s.key === k);
    check('advance paid → ticked, saying paid', s2('advance')?.done === true && /paid/.test(s2('advance').detail));
    check('release added → ticked', s2('release')?.done === true);
    check('both budget lines typed → ticked', s2('budget')?.done === true, s2('budget')?.detail);
    check('2 open (contract, payment), still not onboarded', ob2?.open === 2 && !ob2.onboarded_at);

    // contact PUT
    const contact = await api('PUT', `/artists/${artistId}/contact`, token, { phone: '+1 555 0199', socials: [{ platform: 'tiktok', handle: '@rosa' }] });
    check('PUT /artists/:id/contact updates phone and socials, leaves email', contact.status === 200 && contact.body?.data?.phone === '+1 555 0199' && contact.body.data.email === email && contact.body.data.socials?.[0]?.platform === 'tiktok');
    const badTyped = await api('POST', `/artists/${artistId}/payment-details`, token, { payment_method: 'ACH', payment_account_number: '12' });
    check('typed-in payment details are validated (incomplete ACH refused, or 503 without a key)', badTyped.status === 400 || badTyped.status === 503, badTyped.status);

    // ── 5. a deal with NO advance ──
    const noAdv = await api('POST', '/deals', token, { artist_name: `${TAG} No Advance`, stage: 'Signed', deal_type: 'Distribution' });
    const sg2 = noAdv.body?.signing; if (sg2?.artist?.id) made.artists.push(sg2.artist.id); if (noAdv.body?.data?.id) made.deals.push(noAdv.body.data.id);
    check('a deal created already Signed runs the signing', noAdv.status === 201 && sg2?.created?.artist === true);
    check('no advance → no invoice', sg2?.created?.advance === false && sg2?.advance_expense_id === null);
    const ob3 = (await api('GET', `/artists/${sg2?.artist?.id}/onboarding`, token)).body?.data;
    check('its advance step is done: "No advance on this deal"', ob3?.steps?.find((s) => s.key === 'advance')?.done === true && /No advance/.test(ob3.steps.find((s) => s.key === 'advance').detail));
    check('its payment step asks for an email first', /email/.test(ob3?.steps?.find((s) => s.key === 'payment')?.detail || ''));
    const { rows: ev2 } = await pool.query(`SELECT id FROM calendar_events WHERE description = $1`, [`deal:${noAdv.body?.data?.id}`]); ev2.forEach((x) => made.events.push(x.id));

    // ── 6. an artist already on the roster ──
    const { rows: [pre] } = await pool.query(`INSERT INTO artists (name, genre, email) VALUES ($1, 'Rock', 'kept@example.test') RETURNING id`, [`${TAG} Existing`]); made.artists.push(pre.id);
    const d3 = await api('POST', '/deals', token, { artist_name: `  ${TAG.toLowerCase()} EXISTING `, stage: 'Signed', advance: 100, artist_email: 'fromdeal@example.test' });
    const sg3 = d3.body?.signing; if (d3.body?.data?.id) made.deals.push(d3.body.data.id); if (sg3?.advance_expense_id) made.expenses.push(sg3.advance_expense_id);
    check('a differently-cased, padded name matches the existing roster row', sg3?.artist?.id === pre.id && sg3?.created?.artist === false, JSON.stringify(sg3));
    const { rows: [pre2] } = await pool.query('SELECT email, signed_at FROM artists WHERE id = $1', [pre.id]);
    check("…keeps the email already on the profile (fills only what is empty), stamps signed_at", pre2.email === 'kept@example.test' && !!pre2.signed_at);
    const { rows: ev3 } = await pool.query(`SELECT id FROM calendar_events WHERE description = $1`, [`deal:${d3.body?.data?.id}`]); ev3.forEach((x) => made.events.push(x.id));
    const { rows: allA } = await pool.query(`SELECT id FROM artists WHERE name ILIKE $1`, [`%${TAG}%`]);
    check('the roster holds exactly three fixture artists (no duplicate from case)', allA.length === 3, allA.length);
  } catch (err) {
    console.error('FIXTURE ERROR', err); results.push({ name: 'no exception', ok: false });
  } finally {
    const keys = made.artists.length ? (await pool.query('SELECT name FROM artists WHERE id = ANY($1)', [made.artists])).rows.map((r) => require('../lib/artist-key').artistBucketKey(r.name)) : [];
    if (keys.length) await pool.query(`DELETE FROM artist_budget_sections WHERE artist_key = ANY($1)`, [keys]).catch(() => {});
    await pool.query(`DELETE FROM calendar_events WHERE id = ANY($1)`, [made.events]).catch(() => {});
    await pool.query(`DELETE FROM expenses WHERE id = ANY($1) OR payee ILIKE $2`, [made.expenses, `%${TAG}%`]).catch(() => {});
    await pool.query(`DELETE FROM releases WHERE id = ANY($1)`, [made.releases]).catch(() => {});
    await pool.query(`DELETE FROM deals WHERE id = ANY($1)`, [made.deals]).catch(() => {});
    await pool.query(`DELETE FROM artists WHERE id = ANY($1) OR name ILIKE $2`, [made.artists, `%${TAG}%`]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
