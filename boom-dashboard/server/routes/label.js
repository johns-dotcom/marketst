// The label's own details — Settings › Label.
//
//   GET  /label             every signed-in screen: masked (EIN and account as last four)
//   PUT  /label             Admin/Superadmin; the EIN and bank account NUMBER only from a Superadmin
//   GET  /label/remittance  bookkeeping roles: the decrypted block the invoice PDF prints,
//                           one bk_audit_log row per read — like the vendor-details read
//
// Replaces BOOM_INFO / BOOM_DEFAULTS / the TODO(marketst) placeholders that
// used to print on real documents from code. A blank field here is a visible
// gap on the Label tab; a placeholder in code was a wrong string on a PDF.
const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const paymentCrypto = require('../lib/payment-crypto');

const router = express.Router();
const BK_ROLES = new Set(['Admin', 'Superadmin', 'Approver']);
const isAdmin = (r) => r === 'Admin' || r === 'Superadmin';

const PLAIN = ['legal_name', 'display_name', 'address_line1', 'address_line2', 'contact_name', 'contact_email', 'contact_phone',
  'bank_name', 'bank_address', 'bank_account_name', 'bank_account_type', 'bank_routing_ach', 'bank_routing_wire', 'bank_swift',
  'signatory_name', 'signatory_title', 'default_payment_terms'];
const str = (v) => (v === undefined ? undefined : (v === null ? null : (String(v).trim() || null)));
const last4 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d ? d.slice(-4) : String(v).slice(-4); };

async function readRow() {
  const { rows: [r] } = await pool.query('SELECT * FROM label_settings WHERE id = 1');
  return r || null;
}
const BANK_FIELDS = ['bank_name', 'bank_address', 'bank_account_name', 'bank_account_type', 'bank_routing_ach', 'bank_routing_wire', 'bank_swift', 'bank_account_last4', 'ein_last4'];
// Everyone signed in may read the label's identity and contact lines; the bank
// block (routing numbers, SWIFT, the account name, the last four) is for the
// bookkeeping roles, who reach the full remittance read anyway.
const masked = (r, user) => {
  if (!r) return null;
  const { ein_enc, bank_account_enc, ...rest } = r;
  if (!BK_ROLES.has(user?.role)) for (const k of BANK_FIELDS) delete rest[k];
  return { ...rest, ein_set: !!ein_enc, bank_account_set: !!bank_account_enc };
};

router.get('/', authMiddleware, async (req, res) => {
  try { res.json({ success: true, data: masked(await readRow(), req.user) }); }
  catch (err) { console.error('label read error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.put('/', authMiddleware, async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return res.status(403).json({ success: false, error: 'Only an Admin can edit the label' });
    const b = req.body || {};
    const sets = []; const vals = [];
    for (const k of PLAIN) if (b[k] !== undefined) { vals.push(str(b[k])); sets.push(`${k} = $${vals.length}`); }
    if (b.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.contact_email))) return res.status(400).json({ success: false, error: 'Contact email is not an email address' });
    // Secrets: Superadmin only, write-only ('' clears). Encrypted at rest.
    for (const [field, enc, l4] of [['ein', 'ein_enc', 'ein_last4'], ['bank_account_number', 'bank_account_enc', 'bank_account_last4']]) {
      if (b[field] === undefined) continue;
      if (req.user.role !== 'Superadmin') return res.status(403).json({ success: false, error: `Only a Superadmin can change the ${field === 'ein' ? 'EIN' : 'bank account number'}` });
      const v = str(b[field]);
      if (v === null) { vals.push(null); sets.push(`${enc} = $${vals.length}`); vals.push(null); sets.push(`${l4} = $${vals.length}`); continue; }
      if (!paymentCrypto.isConfigured()) return res.status(503).json({ success: false, error: 'Encryption key not configured; the EIN and account number cannot be stored' });
      vals.push(paymentCrypto.encrypt(v)); sets.push(`${enc} = $${vals.length}`);
      vals.push(last4(v)); sets.push(`${l4} = $${vals.length}`);
    }
    if (!sets.length) return res.json({ success: true, data: masked(await readRow(), req.user) });
    vals.push(req.user.id);
    await pool.query(`UPDATE label_settings SET ${sets.join(', ')}, updated_at = NOW(), updated_by = $${vals.length} WHERE id = 1`, vals);
    res.json({ success: true, data: masked(await readRow(), req.user) });
  } catch (err) { console.error('label update error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// The decrypted remittance block for the invoice generator. Audited per read.
router.get('/remittance', authMiddleware, async (req, res) => {
  try {
    if (!BK_ROLES.has(req.user?.role)) return res.status(403).json({ success: false, error: 'Bookkeeping roles only' });
    const r = await readRow();
    if (!r) return res.json({ success: true, data: null });
    let ein = null, account = null;
    try { ein = r.ein_enc ? paymentCrypto.decrypt(r.ein_enc) : null; account = r.bank_account_enc ? paymentCrypto.decrypt(r.bank_account_enc) : null; }
    catch (e) { console.error('label decrypt failed:', e.message); }
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1, 'label_remittance_read', NULL, $2, 'remittance', NULL, NULL, 'decrypted EIN + account for an invoice')`,
      [req.user.name || req.user.email, r.legal_name || r.display_name || 'label']).catch(() => {});
    res.json({ success: true, data: { ...masked(r, req.user), ein, bank_account_number: account } });
  } catch (err) { console.error('label remittance error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

module.exports = router;
