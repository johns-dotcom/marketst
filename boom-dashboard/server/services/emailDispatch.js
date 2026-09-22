/**
 * Email dispatch — central preview + send dispatcher used by /api/email.
 *
 * Each `kind` represents one email template across the app (welcome, vendor
 * approved, task assignment, etc.). Two operations:
 *
 *   prepareEmail(kind, context)         → { to, cc, subject, html, attachments }
 *   dispatchSend(kind, context, override) → fires the underlying send function
 *                                            with html/to/cc/subject overrides.
 *
 * Context is template-specific. Where data needs to be loaded (e.g. an expense
 * row by id), the prepare/dispatch functions do that lookup so the client only
 * has to ship lightweight references — not full payloads.
 */
const pool = require('../db');

// Resolve a mix of expense IDs (parents + children, possibly from the same
// split families) into one row per family root, with the family total
// pre-summed. Splits (per-song / fee-vs-reimb / artist-breakdown) are an
// internal accounting construct — the vendor was invoiced once and should
// see one line per real invoice in the confirmation email.
//
// Returns an array of root rows, each with `family_amount` populated.
// Order: by id ASC (matches the legacy bulk-confirmation query).
async function loadFamilyRoots(entryIds) {
  if (!Array.isArray(entryIds) || !entryIds.length) return [];
  const ids = entryIds.map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `WITH roots AS (
       SELECT DISTINCT COALESCE(parent_id, id) AS root_id
         FROM expenses
        WHERE id = ANY($1::int[])
          AND (deleted = false OR deleted IS NULL)
     )
     SELECT p.id, p.payee, p.vendor_email, p.vendor_name, p.currency,
            p.invoice_number, p.payment_date, p.payment_method, p.boom_rep,
            p.confirmation_sent,
            p.invoice_data, p.invoice_r2_key, p.invoice_filename,
            p.proof_data, p.proof_r2_key, p.proof_filename,
            (p.amount + COALESCE(
              (SELECT SUM(c.amount) FROM expenses c
                WHERE c.parent_id = p.id
                  AND (c.deleted = false OR c.deleted IS NULL)), 0)
            ) AS family_amount
       FROM roots r
       JOIN expenses p ON p.id = r.root_id
      WHERE (p.deleted = false OR p.deleted IS NULL)
      ORDER BY p.id`,
    [ids]
  );
  return rows;
}
const {
  // Builders
  buildWelcomeHtml,
  buildTestUserInvitationHtml,
  buildVendorApprovedHtml,
  buildVendorRejectedHtml,
  buildPaymentConfirmationHtml,
  buildPaymentConfirmationSubject,
  buildBulkPaymentConfirmationHtml,
  buildBulkPaymentConfirmationSubject,
  buildTaskAssignmentHtml,
  buildTaskAssignmentSubject,
  buildInternalRequestHtml,
  // Senders
  sendWelcomeEmail,
  sendTestUserInvitationEmail,
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
  sendPaymentConfirmationEmail,
  sendBulkPaymentConfirmationEmail,
  sendTaskAssignmentEmail,
  sendInternalRequestEmail,
} = require('./email');
const { loadFileBase64 } = require('../lib/r2');
const { mergeVendorCc } = require('../lib/vendorEmails');

// Pull invoice + proof attachments off an expense row, in base64. Used by
// vendor-confirmation flows. Skipped silently when blobs are missing.
async function loadExpenseAttachments(expense, { include = ['invoice', 'proof'] } = {}) {
  const out = [];
  if (include.includes('invoice') && expense.invoice_filename && (expense.invoice_r2_key || expense.invoice_data)) {
    const data = await loadFileBase64(expense.invoice_r2_key, expense.invoice_data);
    if (data) {
      const fname = expense.invoice_filename;
      const mime = fname.match(/\.pdf$/i) ? 'application/pdf' : fname.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
      out.push({ filename: fname, data, mimeType: mime });
    }
  }
  if (include.includes('proof') && expense.proof_filename && (expense.proof_r2_key || expense.proof_data)) {
    const data = await loadFileBase64(expense.proof_r2_key, expense.proof_data);
    if (data) {
      const fname = expense.proof_filename;
      const mime = fname.match(/\.pdf$/i) ? 'application/pdf' : fname.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
      out.push({ filename: fname, data, mimeType: mime });
    }
  }
  return out;
}

// Look up the rep's email by name. Returns null if no match — same fallback
// behavior used elsewhere in the codebase.
async function lookupRepEmail(name) {
  if (!name) return null;
  try {
    const r = await pool.query('SELECT email FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1', [name]);
    return r.rows[0]?.email || null;
  } catch { return null; }
}

// Render a preview payload for a given kind + context. Lightweight — no
// attachments fetched (preview doesn't need bytes, just labels).
async function prepareEmail(kind, ctx = {}) {
  ctx = ctx || {};
  switch (kind) {
    case 'welcome': {
      const { name = '', email = '', role = '', department = '' } = ctx;
      return {
        to: email, cc: '',
        subject: 'Welcome to market.st Dashboard',
        html: buildWelcomeHtml({ name, email, role, department }),
        attachmentLabels: [],
      };
    }

    case 'test_invitation': {
      const { name = '', email = '', password = '', role = '' } = ctx;
      return {
        to: email, cc: '',
        subject: 'Your market.st demo account is ready',
        html: buildTestUserInvitationHtml({ name, email, password, role }),
        attachmentLabels: [],
      };
    }

    case 'vendor_approved':
    case 'vendor_rejected': {
      if (!ctx.entryId) throw new Error(`${kind}: entryId required`);
      const { rows } = await pool.query(
        `SELECT id, payee, vendor_email, vendor_name, amount, currency, invoice_number,
                artist, created_at, boom_rep, invoice_filename, proof_filename,
                invoice_r2_key, proof_r2_key
           FROM expenses WHERE id = $1`,
        [ctx.entryId]
      );
      if (!rows.length) throw new Error('Entry not found');
      const e = rows[0];
      const vendorName = e.vendor_name || e.payee;
      let cc = ctx.cc || '';
      if (ctx.cc_rep && e.boom_rep && !cc) {
        const repEmail = await lookupRepEmail(e.boom_rep);
        if (repEmail) cc = repEmail;
      }
      if (kind === 'vendor_approved') {
        return {
          to: e.vendor_email || '', cc,
          subject: `Invoice Approved - ${vendorName}${e.invoice_number ? ` (#${e.invoice_number})` : ''}`,
          html: buildVendorApprovedHtml({
            vendorName, amount: e.amount, currency: e.currency,
            invoiceNumber: e.invoice_number, artist: e.artist, submittedAt: e.created_at,
          }),
          attachmentLabels: [e.invoice_filename, e.proof_filename].filter(Boolean),
        };
      }
      return {
        to: e.vendor_email || '', cc,
        subject: `Invoice Update - ${vendorName}${e.invoice_number ? ` (#${e.invoice_number})` : ''}`,
        html: buildVendorRejectedHtml({
          vendorName, amount: e.amount, currency: e.currency,
          invoiceNumber: e.invoice_number, reason: ctx.reason,
        }),
        attachmentLabels: [e.invoice_filename].filter(Boolean),
      };
    }

    case 'task_assigned': {
      const { assigneeName = '', assigneeEmail = '', assignerName = '', description = '', priority = 'Medium', due_date = null } = ctx;
      return {
        to: assigneeEmail, cc: '',
        subject: buildTaskAssignmentSubject({ assignerName, description }),
        html: buildTaskAssignmentHtml({ assigneeName, assignerName, description, priority, due_date }),
        attachmentLabels: [],
      };
    }

    case 'internal_request': {
      const { typeLabel = 'Feedback', userName = '', userEmail = '', userRole = '', page = '', title = '', details = '', timestamp = new Date().toLocaleString() } = ctx;
      return {
        to: 'john@deanst.co', cc: '',
        subject: `[Dashboard] ${typeLabel} from ${userName}: ${title}`,
        html: buildInternalRequestHtml({ typeLabel, userName, userEmail, userRole, page, title, details, timestamp }),
        attachmentLabels: [],
      };
    }

    case 'payment_confirmation': {
      // Single-row confirmation. Resolve to the family root and use the
      // family total so a split invoice shows the vendor's original billed
      // amount, not just one share.
      if (!ctx.entryId) throw new Error('payment_confirmation: entryId required');
      const [root] = await loadFamilyRoots([ctx.entryId]);
      if (!root) throw new Error('Entry not found');
      const vendorName = root.vendor_name || root.payee;
      let cc = ctx.cc || '';
      if (ctx.cc_rep && root.boom_rep && !cc) {
        const repEmail = await lookupRepEmail(root.boom_rep);
        if (repEmail) cc = repEmail;
      }
      // Saved vendor emails (vendor_emails table) default into CC — the
      // preview modal shows them as removable chips before anything sends.
      cc = await mergeVendorCc(root.payee, cc, root.vendor_email);
      return {
        to: root.vendor_email || '', cc,
        subject: buildPaymentConfirmationSubject({ vendorName, invoiceNumber: root.invoice_number }),
        html: buildPaymentConfirmationHtml({
          vendorName, amount: root.family_amount, currency: root.currency,
          invoiceNumber: root.invoice_number, paymentDate: root.payment_date,
          paymentMethod: root.payment_method, personalMessage: ctx.message,
        }),
        attachmentLabels: [root.invoice_filename, root.proof_filename].filter(Boolean),
      };
    }

    case 'bulk_payment_confirmation': {
      if (!Array.isArray(ctx.entryIds) || !ctx.entryIds.length) throw new Error('bulk_payment_confirmation: entryIds required');
      // Dedupe by family root so each real invoice is one line in the email
      // (selecting both parent + child of the same split shouldn't double-up).
      const roots = await loadFamilyRoots(ctx.entryIds);
      if (!roots.length) throw new Error('Entries not found');
      const first = roots[0];
      const vendorName = first.vendor_name || first.payee;
      const items = roots.map(e => ({
        invoiceNumber: e.invoice_number, amount: e.family_amount, currency: e.currency,
        paymentDate: e.payment_date, paymentMethod: e.payment_method,
      }));
      let cc = ctx.cc || '';
      if (ctx.cc_rep && first.boom_rep && !cc) {
        const repEmail = await lookupRepEmail(first.boom_rep);
        if (repEmail) cc = repEmail;
      }
      cc = await mergeVendorCc(first.payee, cc, first.vendor_email);
      return {
        to: first.vendor_email || '', cc,
        subject: buildBulkPaymentConfirmationSubject({ vendorName, items }),
        html: buildBulkPaymentConfirmationHtml({ vendorName, items }),
        attachmentLabels: roots.flatMap(r => [r.invoice_filename, r.proof_filename]).filter(Boolean),
      };
    }

    default:
      throw new Error(`Unknown email kind: ${kind}`);
  }
}

// Fire the underlying send function with whatever overrides the user supplied
// in the preview modal. Returns the recipients used so the caller can echo
// them back to the UI for the success toast.
async function dispatchSend(kind, ctx = {}, override = {}) {
  const { to, cc, subject, html_override } = override;
  ctx = ctx || {};
  switch (kind) {
    case 'welcome': {
      await sendWelcomeEmail({
        name: ctx.name, email: ctx.email, role: ctx.role, department: ctx.department,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      return { to: to || ctx.email, cc };
    }
    case 'test_invitation': {
      await sendTestUserInvitationEmail({
        name: ctx.name, email: ctx.email, password: ctx.password, role: ctx.role,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      return { to: to || ctx.email, cc };
    }
    case 'vendor_approved': {
      if (!ctx.entryId) throw new Error('vendor_approved: entryId required');
      const { rows } = await pool.query(
        `SELECT payee, vendor_email, vendor_name, amount, currency, invoice_number,
                artist, created_at, invoice_data, invoice_r2_key, invoice_filename,
                proof_data, proof_r2_key, proof_filename
           FROM expenses WHERE id = $1`,
        [ctx.entryId]
      );
      if (!rows.length) throw new Error('Entry not found');
      const e = rows[0];
      const attachments = await loadExpenseAttachments(e, { include: ['invoice', 'proof'] });
      await sendVendorApprovedEmail({
        vendorName: e.vendor_name || e.payee,
        vendorEmail: e.vendor_email,
        amount: e.amount, currency: e.currency,
        invoiceNumber: e.invoice_number, artist: e.artist,
        submittedAt: e.created_at, attachments,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      return { to: to || e.vendor_email, cc };
    }
    case 'vendor_rejected': {
      if (!ctx.entryId) throw new Error('vendor_rejected: entryId required');
      const { rows } = await pool.query(
        `SELECT payee, vendor_email, vendor_name, amount, currency, invoice_number,
                invoice_data, invoice_r2_key, invoice_filename
           FROM expenses WHERE id = $1`,
        [ctx.entryId]
      );
      if (!rows.length) throw new Error('Entry not found');
      const e = rows[0];
      const attachments = await loadExpenseAttachments(e, { include: ['invoice'] });
      await sendVendorRejectedEmail({
        vendorName: e.vendor_name || e.payee,
        vendorEmail: e.vendor_email,
        amount: e.amount, currency: e.currency,
        invoiceNumber: e.invoice_number, reason: ctx.reason,
        attachments,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      return { to: to || e.vendor_email, cc };
    }
    case 'task_assigned': {
      await sendTaskAssignmentEmail({
        assigneeName: ctx.assigneeName, assigneeEmail: ctx.assigneeEmail,
        assignerName: ctx.assignerName, description: ctx.description,
        priority: ctx.priority, due_date: ctx.due_date,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      return { to: to || ctx.assigneeEmail, cc };
    }
    case 'internal_request': {
      await sendInternalRequestEmail({
        typeLabel: ctx.typeLabel, userName: ctx.userName, userEmail: ctx.userEmail,
        userRole: ctx.userRole, page: ctx.page, title: ctx.title, details: ctx.details,
        timestamp: ctx.timestamp,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      return { to: to || 'john@deanst.co', cc };
    }
    case 'payment_confirmation': {
      // Resolve to family root + total so split invoices show their real
      // billed amount and the right attachments (which live on the root).
      if (!ctx.entryId) throw new Error('payment_confirmation: entryId required');
      const [root] = await loadFamilyRoots([ctx.entryId]);
      if (!root) throw new Error('Entry not found');
      const attachments = await loadExpenseAttachments(root, { include: ['invoice', 'proof'] });
      // The sender's params are bare to/cc/subject (NOT *Override like the
      // bulk sender) — the old *Override names were silently ignored, so
      // edits made in the preview modal AND the vendor's saved CC list
      // never reached the actual email.
      await sendPaymentConfirmationEmail({
        vendorName: root.vendor_name || root.payee,
        vendorEmail: root.vendor_email,
        amount: root.family_amount, currency: root.currency,
        invoiceNumber: root.invoice_number, paymentDate: root.payment_date,
        paymentMethod: root.payment_method, attachments,
        personalMessage: override.message,
        to, cc, subject, htmlOverride: html_override,
      });
      // Mark the whole family confirmed so siblings stop showing the button.
      await pool.query(
        `UPDATE expenses SET confirmation_sent = TRUE
          WHERE (id = $1 OR parent_id = $1)
            AND (deleted = false OR deleted IS NULL)`,
        [root.id]
      );
      return { to: to || root.vendor_email, cc };
    }
    case 'bulk_payment_confirmation': {
      if (!Array.isArray(ctx.entryIds) || !ctx.entryIds.length) throw new Error('bulk_payment_confirmation: entryIds required');
      const roots = await loadFamilyRoots(ctx.entryIds);
      if (!roots.length) throw new Error('Entries not found');
      const first = roots[0];
      const items = [];
      for (const e of roots) {
        const att = await loadExpenseAttachments(e, { include: ['invoice', 'proof'] });
        items.push({
          invoiceNumber: e.invoice_number, amount: e.family_amount, currency: e.currency,
          paymentDate: e.payment_date, paymentMethod: e.payment_method, attachments: att,
        });
      }
      await sendBulkPaymentConfirmationEmail({
        vendorName: first.vendor_name || first.payee,
        vendorEmail: first.vendor_email, items,
        toOverride: to, ccOverride: cc, subjectOverride: subject, htmlOverride: html_override,
      });
      // Mark every member of every selected family as confirmed — covers the
      // case where the caller passed a child id but the parent (and siblings)
      // also need confirmation_sent flipped.
      const rootIds = roots.map(r => r.id);
      await pool.query(
        `UPDATE expenses SET confirmation_sent = TRUE
          WHERE (id = ANY($1::int[]) OR parent_id = ANY($1::int[]))
            AND (deleted = false OR deleted IS NULL)`,
        [rootIds]
      );
      return { to: to || first.vendor_email, cc, entryIds: rootIds };
    }
    default:
      throw new Error(`Unknown email kind: ${kind}`);
  }
}

module.exports = { prepareEmail, dispatchSend };
