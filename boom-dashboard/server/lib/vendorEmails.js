const pool = require('../db');

// Saved vendor email addresses (vendor_emails table), alias-aware.
//
// Emails are stored under the vendor's canonical payee name, but lookups
// walk vendor_aliases in both directions so a payee that is an alias (or
// has aliases) still surfaces every saved address. Mirrors the W9
// alias-walk convention used across the vendor endpoints.

// Resolve the full set of names this payee is known by: itself, its
// primary (if the payee is an alias), and every alias of that primary.
async function vendorNameSet(payee) {
  const name = String(payee || '').trim();
  if (!name) return [];
  const names = new Set([name.toLowerCase()]);
  try {
    const { rows: asAlias } = await pool.query(
      'SELECT primary_name FROM vendor_aliases WHERE LOWER(alias) = LOWER($1)', [name]
    );
    const primary = asAlias.length ? asAlias[0].primary_name : name;
    names.add(primary.toLowerCase());
    const { rows: aliases } = await pool.query(
      'SELECT alias FROM vendor_aliases WHERE LOWER(primary_name) = LOWER($1)', [primary]
    );
    for (const a of aliases) names.add(a.alias.toLowerCase());
  } catch { /* alias walk is best-effort — fall back to the bare name */ }
  return [...names];
}

// All saved email rows for a vendor (any name in its alias family).
async function getVendorEmailRows(payee) {
  const names = await vendorNameSet(payee);
  if (!names.length) return [];
  const { rows } = await pool.query(
    `SELECT id, vendor_name, email, label, created_by, created_at
       FROM vendor_emails
      WHERE LOWER(vendor_name) = ANY($1)
      ORDER BY created_at ASC, id ASC`,
    [names]
  );
  return rows;
}

// Just the addresses, deduped case-insensitively and excluding any in
// `exclude` (e.g. the To recipient) — ready to merge into a CC list.
async function getVendorCcEmails(payee, exclude = []) {
  const rows = await getVendorEmailRows(payee);
  const skip = new Set(
    (Array.isArray(exclude) ? exclude : [exclude])
      .filter(Boolean)
      .map(e => String(e).trim().toLowerCase())
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r.email || '').trim().toLowerCase();
    if (!key || seen.has(key) || skip.has(key)) continue;
    seen.add(key);
    out.push(r.email.trim());
  }
  return out;
}

// Merge saved vendor emails into an existing CC string (comma-separated),
// preserving whatever is already there. Returns the combined string.
async function mergeVendorCc(payee, existingCc, toEmail) {
  const existing = String(existingCc || '')
    .split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  const exclude = [toEmail, ...existing];
  const extra = await getVendorCcEmails(payee, exclude);
  return [...existing, ...extra].join(', ');
}

module.exports = { vendorNameSet, getVendorEmailRows, getVendorCcEmails, mergeVendorCc };
