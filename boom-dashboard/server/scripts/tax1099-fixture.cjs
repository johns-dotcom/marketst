#!/usr/bin/env node
/**
 * Can this app produce a 1099 filing?
 *
 * Before this, no: `GET /bk/1099` got the money right — payment basis, alias
 * rollup, locked FX, reimbursements excluded, the 2026 $2,000 threshold — and
 * then reported that all 222 reportable vendors needed a manual entity check,
 * because nothing had ever read line 3 or the TIN off the 299 W-9s on file.
 *
 * What is asserted here is the arithmetic and the RULES, not the AI: the
 * extraction is exercised separately against pure functions in lib/w9-tax.js
 * (a fixture that called Claude 299 times to check a threshold would be
 * measuring the weather). The tax fields are written straight into the database
 * exactly as the scan writes them, and then the questions are:
 *
 *   · does a corporation drop out of the run, with a reason?
 *   · does a corporation paid for LEGAL work stay in? (attorney payments are
 *     reportable whatever the entity — the exception that makes a blanket
 *     "skip corporations" wrong)
 *   · does a foreign W-8 payee drop out?
 *   · does an individual stay in, and count once when filed under two names?
 *   · is a reportable vendor with no TIN reported as unfilable rather than
 *     quietly filed or quietly dropped?
 *   · does the workbook put rent on MISC and fees on NEC, for the SAME vendor?
 *   · does the masked export leak a TIN?
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/tax1099-fixture.cjs
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');
const paymentCrypto = require('../lib/payment-crypto');
const { normalizeTin, normalizeClassification, exemptionFor, parseW9Tax } = require('../lib/w9-tax');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const YEAR = 2031;                    // a year of its own, so live data cannot move these numbers
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const token = jwt.sign(
  { id: 1, email: 'john@deanst.co', name: 'John', role: 'Superadmin', tv: 0 },
  process.env.JWT_SECRET, { expiresIn: '1h' });

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};

const get = async (path, raw) => {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const made = [];
  try {
    // ── the pure rules, first: they are what the endpoint leans on ──────────
    check('an EIN is read as an EIN', normalizeTin('12-3456789').type === 'EIN'
      && normalizeTin('12-3456789').digits === '123456789');
    check('an SSN is read as an SSN', normalizeTin('123-45-6789').type === 'SSN');
    check('the box the vendor was asked wins over the punctuation',
      normalizeTin('123456789', 'EIN').type === 'EIN');
    check('eight digits is refused, not filed', normalizeTin('12-345678').digits === null,
      normalizeTin('12-345678').issue);
    check('nine identical digits is refused', normalizeTin('111-11-1111').digits === null);
    check('a blank TIN says so', /no TIN printed/.test(normalizeTin('').issue || ''));
    check('an LLC that elected S-corp is not a pass-through',
      normalizeClassification('LLC', 'S') === 'LLC (S corporation)');
    check('a plain LLC stays an LLC', normalizeClassification('limited liability company', '') === 'LLC');
    check('a W-8 is classified foreign', normalizeClassification('anything', null, 'W-8BEN') === 'Foreign (W-8)');
    check('a C corporation is exempt', exemptionFor('C corporation', ['Marketing'])?.exempt === true);
    check('…unless it was paid for legal work',
      exemptionFor('C corporation', ['Legal'])?.exempt === false
      && exemptionFor('C corporation', ['Legal'])?.code === 'corp_but_reportable');
    check('an individual is never exempt', exemptionFor('Individual/sole proprietor', ['Marketing']) === null);
    check('an unread form is not treated as exempt', exemptionFor(null, ['Marketing']) === null);
    check('a partnership is not exempt', exemptionFor('Partnership', ['Marketing']) === null);
    const badRead = parseW9Tax({ tin_printed: '12-34', tax_classification: null, signed: false });
    check('a bad read lists every issue rather than the first', badRead.issues.length === 3,
      badRead.issues.join(' | '));

    if (!paymentCrypto.isConfigured()) {
      check('PAYMENT_DETAILS_KEY is set so a TIN can be stored', false, 'not configured — the rest is skipped');
      throw new Error('no PAYMENT_DETAILS_KEY');
    }

    // ── the fixture vendors ─────────────────────────────────────────────────
    const mk = async ({ payee, amount, category, cls, tin, w9 = true, foreign = false, unstored = false, kind = null }) => {
      const { rows: [e] } = await pool.query(
        `INSERT INTO expenses
           (invoice_date, payee, category, artist, amount, currency, payment_method, status,
            payment_status, payment_date, w9_filename, w9_r2_key, vendor_address, vendor_email,
            w9_tin_enc, w9_tin_last4, w9_tin_type, w9_tax_classification, w9_tax_scanned_at, created_by)
         VALUES ($1, $2, $3, 'Jerri', $4, 'USD', 'ACH', 'approved',
                 'Paid', $1, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), 'tax-fixture')
         RETURNING id`,
        [`${YEAR}-06-01`, payee, category, amount,
         w9 ? 'w9.pdf' : null, w9 ? `fixture/${crypto.randomUUID()}` : null,
         '1 Test Street, Los Angeles CA 90001', `${payee.replace(/\W+/g, '.').toLowerCase()}@example.com`,
         tin && !unstored ? paymentCrypto.encrypt(tin) : null, tin ? tin.slice(-4) : null,
         tin ? (foreign ? null : (kind || 'EIN')) : null, cls]);
      made.push(e.id);
      return e.id;
    };

    await mk({ payee: 'TAXFIX Individual', amount: 5000, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: '111223333' });
    await mk({ payee: 'TAXFIX Corp', amount: 9000, category: 'Marketing',
      cls: 'C corporation', tin: '222334444' });
    await mk({ payee: 'TAXFIX Law Corp', amount: 7000, category: 'Legal',
      cls: 'S corporation', tin: '333445555' });
    await mk({ payee: 'TAXFIX Foreign', amount: 4000, category: 'Marketing',
      cls: 'Foreign (W-8)', tin: null, foreign: true });
    await mk({ payee: 'TAXFIX No TIN', amount: 6000, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: null });
    await mk({ payee: 'TAXFIX Under', amount: 100, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: '444556666' });
    // Rent AND fees to one vendor — two forms, one recipient.
    const bothA = await mk({ payee: 'TAXFIX Both', amount: 3000, category: 'Rent',
      cls: 'Individual/sole proprietor', tin: '555667777' });
    await mk({ payee: 'TAXFIX Both', amount: 2500, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: '555667777' });
    // The same person under a second spelling, folded by an alias.
    await mk({ payee: 'TAXFIX Alias Spelling', amount: 1500, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: '111223333' });
    await pool.query(
      `INSERT INTO vendor_aliases (alias, primary_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      ['TAXFIX Alias Spelling', 'TAXFIX Individual']).catch(() => {});

    // ── the endpoint ────────────────────────────────────────────────────────
    const r = await get(`/bk/1099?year=${YEAR}`);
    const rows = (r.body?.data || []).filter((v) => v.payee.startsWith('TAXFIX'));
    const meta = r.body?.meta || {};
    const by = (n) => rows.find((v) => v.payee === n);

    check('the endpoint answers', r.status === 200, r.status);
    check('entity type now comes off the form', meta.entity_type_captured === true);

    check('an individual over the threshold is reportable',
      by('TAXFIX Individual')?.needs_1099 === true && by('TAXFIX Individual')?.exempt === false);
    check('two spellings are ONE recipient at the combined total',
      by('TAXFIX Individual')?.total === 6500 && !by('TAXFIX Alias Spelling'),
      `total ${by('TAXFIX Individual')?.total}`);
    check('a C corporation is excluded, with a reason',
      by('TAXFIX Corp')?.exempt === true && /not 1099-reportable/.test(by('TAXFIX Corp')?.exempt_reason || ''));
    check('a corporation paid for legal work stays IN',
      by('TAXFIX Law Corp')?.exempt === false
      && by('TAXFIX Law Corp')?.exempt_code === 'corp_but_reportable',
      by('TAXFIX Law Corp')?.exempt_reason);
    check('a foreign W-8 payee is excluded', by('TAXFIX Foreign')?.exempt === true
      && by('TAXFIX Foreign')?.exempt_code === 'foreign');
    check('under the threshold is not reportable', by('TAXFIX Under')?.needs_1099 === false);
    check('a reportable vendor with no TIN is flagged, not dropped',
      by('TAXFIX No TIN')?.needs_1099 === true && by('TAXFIX No TIN')?.has_tin === false);
    check('the last 4 travel but the number does not',
      by('TAXFIX Individual')?.tin_last4 === '3333'
      && !JSON.stringify(rows).includes('111223333'),
      `last4 ${by('TAXFIX Individual')?.tin_last4}`);

    // ── the workbook ────────────────────────────────────────────────────────
    const ExcelJS = require('exceljs');
    const masked = await get(`/bk/1099/export?year=${YEAR}`, true);
    check('the masked export downloads', masked.status === 200 && masked.buf.length > 5000,
      `${masked.status}, ${masked.buf.length} bytes`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(masked.buf);
    const sheet = (n) => wb.getWorksheet(n);
    check('it has all four sheets',
      !!sheet('Filing') && !!sheet('1096 Summary') && !!sheet('Needs attention') && !!sheet('Excluded'),
      wb.worksheets.map((w) => w.name).join(', '));

    const filing = [];
    sheet('Filing').eachRow((row, i) => {
      if (i === 1) return;
      filing.push({ form: row.getCell(1).value, box: String(row.getCell(2).value || ''),
        payee: row.getCell(3).value, tin: String(row.getCell(4).value || ''),
        amount: Number(row.getCell(9).value) || 0, missing: String(row.getCell(11).value || '') });
    });
    const fx = filing.filter((f) => String(f.payee || '').startsWith('TAXFIX'));
    const both = fx.filter((f) => f.payee === 'TAXFIX Both');
    check('one vendor paid rent and fees produces TWO filing rows', both.length === 2,
      both.map((b) => `${b.form} ${b.amount}`).join(' + '));
    check('the rent goes on 1099-MISC box 1',
      both.some((b) => b.form === '1099-MISC' && /Rents/.test(b.box) && b.amount === 3000));
    check('and the fees on 1099-NEC box 1',
      both.some((b) => b.form === '1099-NEC' && b.amount === 2500));
    check('an excluded corporation is NOT on the filing sheet',
      !fx.some((f) => f.payee === 'TAXFIX Corp'));
    check('the legal corporation IS', fx.some((f) => f.payee === 'TAXFIX Law Corp'));
    check('a missing TIN is named on the row',
      /TIN/.test(fx.find((f) => f.payee === 'TAXFIX No TIN')?.missing || ''));
    // PARSED, not grepped. An .xlsx is a zip, so searching the raw bytes for a
    // TIN finds nothing whether or not the file contains one — the first
    // version of this check passed for that reason and proved nothing. The
    // masked case has to be read out of the cell, and so does the unmasked one.
    check('the masked export contains no full TIN',
      fx.length > 0 && fx.every((f) => !/^\d{9}$/.test(f.tin.replace(/\D/g, ''))),
      fx.map((f) => f.tin).filter(Boolean).slice(0, 3).join(' '));

    const chase = [];
    sheet('Needs attention').eachRow((row, i) => { if (i > 1) chase.push(row.getCell(1).value); });
    check('the chase list names the vendor with no TIN', chase.includes('TAXFIX No TIN'), chase.join(', '));
    const exRows = [];
    sheet('Excluded').eachRow((row, i) => { if (i > 1) exRows.push(`${row.getCell(1).value}`); });
    check('the excluded sheet names both exclusions and the exception',
      exRows.includes('TAXFIX Corp') && exRows.includes('TAXFIX Foreign') && exRows.includes('TAXFIX Law Corp'),
      exRows.join(', '));

    // ── the deliberate act ──────────────────────────────────────────────────
    const withTin = await get(`/bk/1099/export?year=${YEAR}&include_tin=1`, true);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(withTin.buf);
    const tinCells = [];
    wb2.getWorksheet('Filing').eachRow((row, i) => {
      if (i === 1) return;
      if (String(row.getCell(3).value || '').startsWith('TAXFIX')) {
        tinCells.push({ payee: row.getCell(3).value, tin: String(row.getCell(4).value || '') });
      }
    });
    check('include_tin=1 writes the real number', withTin.status === 200
      && tinCells.some((c) => c.payee === 'TAXFIX Individual' && c.tin === '111223333'),
      tinCells.map((c) => `${c.payee}=${c.tin}`).join(' '));
    check('…and every filed vendor with a TIN gets the whole number',
      tinCells.filter((c) => c.tin).every((c) => /^\d{9}$/.test(c.tin)),
      tinCells.map((c) => c.tin).join(' '));
    const { rows: audit } = await pool.query(
      `SELECT details FROM bk_audit_log WHERE action = '1099_exported' ORDER BY ts DESC LIMIT 1`);
    check('and says so in the audit log', /WITH FULL TINs/.test(audit[0]?.details || ''),
      (audit[0]?.details || '').slice(0, 90));

    // ── "TIN" must leave the missing column once EITHER kind is on file ─────
    //
    // John, 2026-09-02: "make sure if it has the ein or ssn, tin gets removed
    // from the what is missing column." An EIN and an SSN are the same field —
    // TIN is the umbrella term — so both have to clear it, and the page and the
    // workbook must agree about that. Asserted here with the page's own
    // expression rather than by eye.
    await mk({ payee: 'TAXFIX EIN Co', amount: 5000, category: 'Marketing',
      cls: 'Partnership', tin: '987654321', kind: 'EIN' });
    await mk({ payee: 'TAXFIX SSN Person', amount: 5000, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: '123456789', kind: 'SSN' });
    // A number that was READ but could not be STORED. The row shows ••4321 and
    // still cannot be filed, so "TIN" alone would read as the column ignoring
    // the number beside it.
    await mk({ payee: 'TAXFIX Unstored', amount: 5000, category: 'Marketing',
      cls: 'Individual/sole proprietor', tin: '555554321', kind: 'SSN', unstored: true });

    const missingFor = (v) => [
      v.w9_on_file ? null : 'W-9',
      v.has_tin ? null : (v.tin_last4 ? 'TIN read but not stored' : 'TIN'),
      v.address ? null : 'address',
      v.entity_type_known ? null : 'line 3',
    ].filter(Boolean);
    const withKinds = await get(`/bk/1099?year=${YEAR}`);
    const kindRows = (withKinds.body?.data || []);
    const ein = kindRows.find((v) => v.payee === 'TAXFIX EIN Co');
    const ssn = kindRows.find((v) => v.payee === 'TAXFIX SSN Person');
    const uns = kindRows.find((v) => v.payee === 'TAXFIX Unstored');
    check('an EIN clears TIN from the missing column',
      ein?.tin_type === 'EIN' && ein?.has_tin === true && !missingFor(ein).includes('TIN'),
      `${ein?.tin_type} ••${ein?.tin_last4} → missing: ${missingFor(ein).join(', ') || '(nothing)'}`);
    check('an SSN clears it too',
      ssn?.tin_type === 'SSN' && ssn?.has_tin === true && !missingFor(ssn).includes('TIN'),
      `${ssn?.tin_type} ••${ssn?.tin_last4} → missing: ${missingFor(ssn).join(', ') || '(nothing)'}`);
    check('a read-but-unstored number says so rather than just "TIN"',
      uns?.tin_last4 === '4321' && uns?.has_tin === false
      && missingFor(uns).includes('TIN read but not stored'),
      missingFor(uns).join(', '));
    // And the workbook agrees with the page — two places, one rule.
    const kindBook = await get(`/bk/1099/export?year=${YEAR}`, true);
    const wb3 = new ExcelJS.Workbook();
    await wb3.xlsx.load(kindBook.buf);
    const bookMissing = new Map();
    wb3.getWorksheet('Filing').eachRow((row, i) => {
      if (i === 1) return;
      bookMissing.set(String(row.getCell(3).value || ''), String(row.getCell(11).value || ''));
    });
    check('the workbook does not ask for a TIN it already has',
      !/TIN/.test(bookMissing.get('TAXFIX EIN Co') || '') && !/TIN/.test(bookMissing.get('TAXFIX SSN Person') || ''),
      `EIN row: "${bookMissing.get('TAXFIX EIN Co')}" · SSN row: "${bookMissing.get('TAXFIX SSN Person')}"`);
    check('…and flags the unstored one distinctly',
      /NOT STORED/.test(bookMissing.get('TAXFIX Unstored') || ''),
      bookMissing.get('TAXFIX Unstored'));

    // ── every path a W-9 arrives by writes the same thing ───────────────────
    //
    // Before this, only the backfill did — so a vendor who submitted a form
    // today stayed unfilable until somebody re-ran a chore. Four callers, one
    // writer; what is asserted here is the WRITER, given a read (the reads
    // themselves are one Claude call each and are not what can silently drift).
    const { storeW9Tax } = require('../services/w9Tax');
    const arrivalPayee = 'TAXFIX Arrival';
    await mk({ payee: arrivalPayee, amount: 8000, category: 'Marketing', cls: null, tin: null });
    // A read shaped exactly as the vendor-submit and rescan prompts now return.
    const asSubmitted = {
      form_type: 'W-9', w9_name: arrivalPayee, tin_printed: '98-7654321', tin_kind: 'EIN',
      tax_classification: 'Partnership', llc_tax_class: null, signed: true,
      discrepancies: [], summary: 'looks fine',
    };
    const w1 = await storeW9Tax({ payee: arrivalPayee, parsed: asSubmitted, userName: 'fixture' });
    check('a submitted form stores its tax identity', w1.stored === true
      && w1.tin_last4 === '4321' && w1.tax_classification === 'Partnership',
      JSON.stringify({ ...w1, issues: undefined }));
    const { rows: [arr] } = await pool.query(
      `SELECT w9_tin_last4, w9_tin_type, w9_tax_classification,
              (w9_tin_enc IS NOT NULL) AS enc, w9_tax_scanned_at IS NOT NULL AS stamped
         FROM expenses WHERE LOWER(TRIM(payee)) = LOWER(TRIM($1)) LIMIT 1`, [arrivalPayee]);
    check('…encrypted, stamped, and readable as last 4',
      arr.enc === true && arr.stamped === true && arr.w9_tin_last4 === '4321' && arr.w9_tin_type === 'EIN',
      JSON.stringify(arr));
    check('…and the plain number is nowhere in the row',
      !JSON.stringify(arr).includes('987654321'));

    // A second, WORSE read must not erase the first. A re-scan that cannot make
    // out the TIN is not evidence the earlier one was wrong, and a blanked TIN
    // silently moves a vendor back onto the "cannot file" list.
    const w2 = await storeW9Tax({ payee: arrivalPayee, userName: 'fixture',
      parsed: { form_type: 'W-9', tin_printed: null, tax_classification: null, signed: true } });
    const { rows: [after2] } = await pool.query(
      `SELECT w9_tin_last4, w9_tax_classification FROM expenses
        WHERE LOWER(TRIM(payee)) = LOWER(TRIM($1)) LIMIT 1`, [arrivalPayee]);
    check('a failed re-read does not erase what was already stored',
      after2.w9_tin_last4 === '4321' && after2.w9_tax_classification === 'Partnership',
      JSON.stringify(after2));
    check('…and still reports the issues it found', (w2.issues || []).length >= 1, (w2.issues || []).join('; '));

    // The vendor whose form arrived is now in the run, with an entity type.
    const after = await get(`/bk/1099?year=${YEAR}`);
    const arrRow = (after.body?.data || []).find((v) => v.payee === arrivalPayee);
    check('the arriving vendor is reportable with a known entity type',
      arrRow?.needs_1099 === true && arrRow?.entity_type_known === true
      && arrRow?.has_tin === true && arrRow?.exempt === false,
      JSON.stringify({ known: arrRow?.entity_type_known, tin: arrRow?.has_tin, cls: arrRow?.tax_classification }));

    // The single-vendor read is audited too.
    const tinRead = await get(`/bk/vendors/${encodeURIComponent('TAXFIX Individual')}/tin`);
    check('the TIN route returns the number to an admin',
      tinRead.status === 200 && tinRead.body?.data?.tin === '111223333', tinRead.status);
    const { rows: viewed } = await pool.query(
      `SELECT details FROM bk_audit_log WHERE action = 'w9_tin_viewed' ORDER BY ts DESC LIMIT 1`);
    check('…and logs the read without logging the number',
      /TAXFIX Individual/.test(viewed[0]?.details || '') && !/111223333/.test(viewed[0]?.details || ''),
      viewed[0]?.details);
  } catch (err) {
    check('the fixture ran to completion', false, err.message);
  } finally {
    if (made.length) {
      await pool.query('DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])', [made]).catch(() => {});
      await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made]).catch(() => {});
    }
    await pool.query("DELETE FROM bk_audit_log WHERE action IN ('1099_exported','w9_tin_viewed') AND entry_payee LIKE 'TAXFIX%'").catch(() => {});
    await pool.query("DELETE FROM bk_audit_log WHERE action = '1099_exported' AND details LIKE '%2031%'").catch(() => {});
    await pool.query("DELETE FROM vendor_aliases WHERE alias LIKE 'TAXFIX%'").catch(() => {});
    await pool.end();
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
