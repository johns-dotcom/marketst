
// The refresh-token exchange moved to lib/google-oauth.js when the Sheets export
// became a second caller. Same code, same behaviour (a fresh token per call) —
// the move exists so the two integrations can never drift apart on credentials.
const { sendMail, isConnected } = require('../lib/mail');
const L = require('../lib/email-layout'); // the market.st frame every template renders inside

const APP_URL = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';

function buildWelcomeHtml({ name, email, role, department }) {
  return L.layout({
    title: `Welcome, ${name}`, eyebrow: 'Welcome aboard', accent: 'forest',
    preheader: 'Your market.st dashboard account is ready.',
    body: L.p(`Your account has been created. Sign in with your Google account (${email}) to get started.`) + L.rows([['Role', role || ''], ['Department', department || '']]),
    cta: { label: 'Open the dashboard', href: APP_URL },
  });
}

/**
 * Send a welcome email to a newly created user.
 * Non-fatal — logs errors but never throws.
 */
async function sendWelcomeEmail({ name, email, role, department, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildWelcomeHtml({ name, email, role, department });
        await sendMail({ kind: 'welcome',
      to: toOverride || email,
      cc: ccOverride || undefined,
      subject: subjectOverride || 'Welcome to market.st Dashboard',
      html,
    });
    console.log(`[email] Welcome email sent to ${toOverride || email}`);
  } catch (err) {
    console.error(`[email] Failed to send welcome email to ${email}:`, err.message);
    throw err;
  }
}

function buildVendorApprovedHtml({ vendorName, amount, currency, invoiceNumber, artist, submittedAt }) {
  const fmtAmount = amount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount) : '';
  const submittedDate = submittedAt ? new Date(submittedAt) : new Date();
  const payBy = new Date(submittedDate);
  payBy.setDate(payBy.getDate() + 30);
  const payByStr = payBy.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const name = L.labelInfo().display_name || 'market.st';
  return L.layout({
    title: 'Invoice approved', eyebrow: 'Accounts payable', accent: 'forest',
    preheader: `Your invoice${invoiceNumber ? ` #${invoiceNumber}` : ''} is approved and scheduled for payment.`,
    body: L.p(`Hi ${vendorName},`) + L.p(`Your invoice has been <strong style="color:${L.PALETTE.forest};">approved</strong> and is being processed for payment.`, { raw: true })
      + L.rows([['Invoice #', invoiceNumber, { mono: true }], ['Amount', fmtAmount, { strong: true }], ['Artist', artist]])
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;"><tr><td style="border-left:4px solid ${L.PALETTE.mustard};background:#fff;padding:12px 16px;">
           <p style="margin:0 0 4px;font-family:${L.MONO};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${L.PALETTE.muted};">Payment schedule</p>
           <p style="margin:0;font-family:${L.SANS};font-size:14px;line-height:1.6;color:${L.PALETTE.ink};">${L.esc(name)} pays on a Net 30 schedule. Expect payment by <strong>${payByStr}</strong>.</p></td></tr></table>`
      + L.p("You'll get another email with proof of payment once it has gone out.", { small: true, muted: true }),
  });
}

/**
 * Notify vendor that their invoice has been approved.
 */
async function sendVendorApprovedEmail({ vendorName, vendorEmail, amount, currency, invoiceNumber, artist, attachments, cc, submittedAt, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !vendorEmail) return;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildVendorApprovedHtml({ vendorName, amount, currency, invoiceNumber, artist, submittedAt });
        await sendMail({ kind: 'vendor_approved',
      to: toOverride || vendorEmail,
      subject: subjectOverride || `Invoice Approved - ${vendorName}${invoiceNumber ? ` (#${invoiceNumber})` : ''}`,
      html,
      cc: (ccOverride !== undefined ? ccOverride : cc) || undefined,
      attachments: attachments || [],
    });
    console.log(`[email] Approval notification sent to ${toOverride || vendorEmail}`);
  } catch (err) {
    console.error(`[email] Failed to send approval email to ${vendorEmail}:`, err.message);
    throw err;
  }
}

function buildVendorRejectedHtml({ vendorName, amount, currency, invoiceNumber, reason }) {
  const fmtAmount = amount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount) : '';
  return L.layout({
    title: 'Invoice update', eyebrow: 'Accounts payable', accent: 'brick',
    preheader: `Your invoice${invoiceNumber ? ` #${invoiceNumber}` : ''} could not be approved.`,
    body: L.p(`Hi ${vendorName},`) + L.p('Unfortunately, your invoice could not be approved at this time.')
      + (reason ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;"><tr><td style="border-left:4px solid ${L.PALETTE.brick};background:#fff;padding:12px 16px;">
           <p style="margin:0 0 4px;font-family:${L.MONO};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${L.PALETTE.brick};">Reason</p>
           <p style="margin:0;font-family:${L.SANS};font-size:14px;line-height:1.6;color:${L.PALETTE.ink};">${L.esc(reason)}</p></td></tr></table>` : '')
      + L.rows([['Invoice #', invoiceNumber, { mono: true }], ['Amount', fmtAmount]])
      + L.p('Please review and resubmit your invoice, or reply to this email with questions.', { small: true, muted: true }),
  });
}

/**
 * Notify vendor that their invoice has been rejected.
 */
async function sendVendorRejectedEmail({ vendorName, vendorEmail, amount, currency, invoiceNumber, reason, attachments, cc, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !vendorEmail) return;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildVendorRejectedHtml({ vendorName, amount, currency, invoiceNumber, reason });
        await sendMail({ kind: 'vendor_rejected',
      to: toOverride || vendorEmail,
      subject: subjectOverride || `Invoice Update - ${vendorName}${invoiceNumber ? ` (#${invoiceNumber})` : ''}`,
      html,
      cc: (ccOverride !== undefined ? ccOverride : cc) || undefined,
      attachments: attachments || [],
    });
    console.log(`[email] Rejection notification sent to ${toOverride || vendorEmail}`);
  } catch (err) {
    console.error(`[email] Failed to send rejection email to ${vendorEmail}:`, err.message);
    throw err;
  }
}

/**
 * Send payment confirmation to vendor with invoice + proof attached.
 */
// Escape user-supplied text before injecting into the HTML template.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Defaults for the three editable text blocks the Payment Dashboard modal
// exposes. Exported so the client can pre-fill its textareas without
// re-implementing the strings.
function defaultGreeting(vendorName) {
  return `Hi ${vendorName},`;
}
const DEFAULT_INTRO_PLAIN  = 'Your invoice has been paid. Please find the details and proof of payment attached.';
const DEFAULT_CLOSING_PLAIN = 'If you have any questions about this payment, please reply to this email.';

// Render a plain-text override as HTML paragraphs. Splits on blank lines
// (\n\n) so the user can hit Enter twice to get a paragraph break; single
// newlines become <br/>. Always HTML-escaped, never raw HTML.
function paragraphsFromText(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => escapeHtml(p).replace(/\n/g, '<br/>'))
    .join('');
}

// Build the HTML body for a single-invoice payment confirmation. Exported so
// the preview endpoint can render the same template the send path will use.
//
// Editable text blocks (all optional — undefined / empty falls back to default):
//   • greeting        — replaces "Hi <vendor>,"
//   • intro           — replaces the body paragraph that says "Your invoice
//                       has been paid..." Renders as one or more <p> tags
//                       (split on blank lines).
//   • personalMessage — extra note inserted between intro and the details
//                       table. Stays for back-compat; functionally a 2nd
//                       paragraph if the user doesn't want to touch the
//                       intro line.
//   • closing         — replaces the muted footer paragraph.
function buildPaymentConfirmationHtml({ vendorName, amount, currency, invoiceNumber, paymentDate, paymentMethod, personalMessage, greeting, intro, closing }) {
  const fmtAmount = amount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount) : '';
  const fmtDate = paymentDate ? new Date(paymentDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A';

  const greetingText = (greeting && String(greeting).trim()) || defaultGreeting(vendorName);
  const greetingHtml = L.p(greetingText);

  // Intro paragraph(s). Default keeps the "paid" word green via a hand-
  // rolled inline span; user overrides render as plain escaped text so
  // they can't inject HTML.
  const introTrimmed = intro && String(intro).trim();
  const introHtml = introTrimmed
    ? `<div style="margin:0 0 20px;font-size:14px;color:#444;">${
        paragraphsFromText(introTrimmed).replace(/^/, '').split('</p>').filter(Boolean)
          .map(s => s + '</p>').join('') ||
        `<p>${escapeHtml(introTrimmed).replace(/\n/g, '<br/>')}</p>`
      }</div>`
    : L.p(`Your invoice has been <strong style="color:${L.PALETTE.forest};">paid</strong>. Please find the details and proof of payment attached.`, { raw: true });

  const noteHtml = personalMessage && String(personalMessage).trim()
    ? L.p(escapeHtml(personalMessage).replace(/\n/g, '<br/>'), { raw: true, pre: true })
    : '';

  const closingText = (closing && String(closing).trim()) || DEFAULT_CLOSING_PLAIN;
  const closingHtml = L.p(escapeHtml(closingText).replace(/\n/g, '<br/>'), { raw: true, pre: true, small: true, muted: true });

  return L.layout({
    title: 'Payment confirmation', eyebrow: 'Accounts payable', accent: 'forest',
    preheader: `${fmtAmount ? `${fmtAmount} paid` : 'Paid'}${invoiceNumber ? ` on invoice #${invoiceNumber}` : ''}.`,
    body: greetingHtml + introHtml + noteHtml
      + L.rows([['Invoice #', invoiceNumber, { mono: true }], ['Amount paid', fmtAmount, { strong: true, color: L.PALETTE.forest }], ['Payment date', fmtDate], ['Method', paymentMethod]])
      + closingHtml,
  });
}

function buildPaymentConfirmationSubject({ vendorName, invoiceNumber }) {
  return `Payment Confirmation - ${vendorName}${invoiceNumber ? ` (#${invoiceNumber})` : ''}`;
}

// Minimal sanitizer for admin-supplied HTML override on the payment-confirmation
// preview. The Payment Dashboard is admin-only, so this is defense-in-depth, not
// the primary trust boundary. Strips <script>/<style> blocks, on* event-handler
// attributes, and javascript: URLs.
function sanitizeEmailHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

async function sendPaymentConfirmationEmail({ vendorName, vendorEmail, amount, currency, invoiceNumber, paymentDate, paymentMethod, cc, attachments, to, subject, personalMessage, htmlOverride }) {
  try {
    const recipient = to || vendorEmail;
    if (!recipient) return;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildPaymentConfirmationHtml({ vendorName, amount, currency, invoiceNumber, paymentDate, paymentMethod, personalMessage });
    const subj = subject || buildPaymentConfirmationSubject({ vendorName, invoiceNumber });

        await sendMail({ kind: 'payment_confirmation',
      to: recipient,
      cc: cc || undefined,
      subject: subj,
      html,
      attachments: attachments || [],
    });
    console.log(`[email] Payment confirmation sent to ${recipient}${cc ? ` (cc: ${cc})` : ''}`);
  } catch (err) {
    console.error(`[email] Failed to send payment confirmation:`, err.message);
    // Rethrow (matching the bulk sender) — swallowing meant callers marked
    // confirmation_sent = TRUE and reported success while the vendor got
    // nothing (e.g. an expired Gmail refresh token).
    throw err;
  }
}

function buildBulkPaymentConfirmationHtml({ vendorName, items }) {
  const fmtMoney = (amount, currency) => amount
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)
    : '';
  const fmtDate = (d) => d
    ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'N/A';

  const totals = {};
  for (const it of items) {
    const cur = it.currency || 'USD';
    totals[cur] = (totals[cur] || 0) + (Number(it.amount) || 0);
  }
  const totalLine = Object.entries(totals)
    .map(([cur, amt]) => fmtMoney(amt, cur))
    .filter(Boolean)
    .join(' + ');

  const rowsHtml = items.map((it, i) => `
      <tr>
        <td style="padding:9px 12px;background:#fff;border-bottom:${i < items.length - 1 ? `1px solid ${L.PALETTE.rule}` : 'none'};font-family:${L.SANS};font-size:13px;color:${L.PALETTE.ink};">
          ${it.invoiceNumber ? `<strong style="font-family:${L.MONO};">#${escapeHtml(it.invoiceNumber)}</strong>` : `Invoice ${i + 1}`}
          ${it.paymentMethod ? ` <span style="color:${L.PALETTE.muted};font-size:11px;">· ${escapeHtml(it.paymentMethod)}</span>` : ''}
          <div style="font-size:11px;color:${L.PALETTE.muted};margin-top:2px;">Paid ${fmtDate(it.paymentDate)}</div>
        </td>
        <td style="padding:9px 12px;background:#fff;border-bottom:${i < items.length - 1 ? `1px solid ${L.PALETTE.rule}` : 'none'};text-align:right;font-family:${L.MONO};font-size:14px;font-weight:700;color:${L.PALETTE.ink};white-space:nowrap;">${fmtMoney(it.amount, it.currency)}</td>
      </tr>`).join('');
  return L.layout({
    title: `Payment confirmation — ${items.length} invoice${items.length === 1 ? '' : 's'}`, eyebrow: 'Accounts payable', accent: 'forest',
    preheader: `${totalLine} paid across ${items.length} invoice${items.length === 1 ? '' : 's'}.`,
    body: L.p(`Hi ${vendorName},`) + L.p(`The following ${items.length} invoice${items.length === 1 ? ' has' : 's have'} been <strong style="color:${L.PALETTE.forest};">paid</strong>. Proof of payment is attached.`, { raw: true })
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 12px;border:1px solid ${L.PALETTE.rule};">${rowsHtml}</table>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:2px solid ${L.PALETTE.forest};"><tr>
           <td style="padding:10px 14px;font-family:${L.MONO};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${L.PALETTE.forest};">Total paid</td>
           <td style="padding:10px 14px;text-align:right;font-family:${L.MONO};font-size:16px;font-weight:700;color:${L.PALETTE.forest};">${totalLine}</td></tr></table>`
      + L.p('If you have any questions about these payments, reply to this email.', { small: true, muted: true }),
  });
}

function buildBulkPaymentConfirmationSubject({ vendorName, items }) {
  return items.length === 1
    ? `Payment Confirmation - ${vendorName}${items[0].invoiceNumber ? ` (#${items[0].invoiceNumber})` : ''}`
    : `Payment Confirmation - ${vendorName} (${items.length} invoices)`;
}

/**
 * Send a single payment-confirmation email covering multiple invoices for
 * the same vendor. items: [{ invoiceNumber, amount, currency, paymentDate,
 * paymentMethod, attachments: [...] }, ...]
 *
 * The body lists each invoice in a row with a per-line total; attachments
 * are flattened into one array.
 */
async function sendBulkPaymentConfirmationEmail({ vendorName, vendorEmail, items, cc, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !vendorEmail) return;
    if (!Array.isArray(items) || items.length === 0) return;

    // Flatten attachments and dedupe by filename — the same invoice PDF
    // shouldn't ride along twice if two split rows reference it.
    const seen = new Set();
    const attachments = [];
    for (const it of items) {
      for (const a of (it.attachments || [])) {
        const key = (a.filename || '') + ':' + (a.data ? a.data.length : 0);
        if (seen.has(key)) continue;
        seen.add(key);
        attachments.push(a);
      }
    }

    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildBulkPaymentConfirmationHtml({ vendorName, items });
    const subject = subjectOverride || buildBulkPaymentConfirmationSubject({ vendorName, items });

        await sendMail({ kind: 'bulk_payment_confirmation',
      to: toOverride || vendorEmail,
      cc: (ccOverride !== undefined ? ccOverride : cc) || undefined,
      subject,
      html,
      attachments,
    });
    console.log(`[email] Bulk payment confirmation sent to ${toOverride || vendorEmail} (${items.length} invoices)`);
  } catch (err) {
    console.error(`[email] Failed to send bulk payment confirmation to ${vendorEmail}:`, err.message);
    throw err;
  }
}

/**
 * Task assignment notification — fired when an admin assigns a task. Extracted
 * here so the preview/send pipeline has a single template registry to dispatch
 * against.
 */
function buildTaskAssignmentHtml({ assigneeName, assignerName, description, priority, due_date }) {
  const due = due_date ? new Date(due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  return L.layout({
    title: 'New task for you', eyebrow: 'Team', accent: 'royal',
    preheader: `${assignerName || 'A teammate'} assigned you: ${description || ''}`.slice(0, 140),
    body: L.p(`Hi ${escapeHtml(assigneeName || '')}, <strong>${escapeHtml(assignerName || '')}</strong> assigned you a task:`, { raw: true })
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;"><tr><td style="border-left:4px solid ${L.PALETTE.royal};background:#fff;padding:14px 16px;font-family:${L.SANS};font-size:16px;font-weight:600;line-height:1.5;color:${L.PALETTE.ink};">${escapeHtml(description || '')}</td></tr></table>`
      + L.rows([['Priority', priority || 'Medium'], ['Due', due], ['Assigned by', assignerName || '']]),
    cta: { label: 'Open My Work', href: `${APP_URL}/my-work` },
  });
}

function buildTaskAssignmentSubject({ assignerName, description }) {
  const d = String(description || '');
  return `[market.st Dashboard] New task from ${assignerName}: ${d.slice(0, 60)}${d.length > 60 ? '…' : ''}`;
}

async function sendTaskAssignmentEmail({ assigneeName, assigneeEmail, assignerName, description, priority, due_date, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !assigneeEmail) return;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildTaskAssignmentHtml({ assigneeName, assignerName, description, priority, due_date });
        await sendMail({ kind: 'task_assigned',
      to: toOverride || assigneeEmail,
      cc: ccOverride || undefined,
      subject: subjectOverride || buildTaskAssignmentSubject({ assignerName, description }),
      html,
    });
    console.log(`[email] Task assignment notification sent to ${toOverride || assigneeEmail}`);
  } catch (err) {
    console.error(`[email] Failed to send task assignment email:`, err.message);
    throw err;
  }
}

/**
 * Internal feedback / bug / request email (POST /api/requests). Sent to the
 * dashboard owner inbox.
 */
function buildInternalRequestHtml({ typeLabel, userName, userEmail, userRole, page, title, details, timestamp }) {
  return L.layout({
    title: typeLabel, eyebrow: 'From the dashboard', accent: 'mustard',
    preheader: `${userName}: ${title}`.slice(0, 140),
    body: L.rows([['From', `${userName} <${userEmail}>`], ['Role', userRole || '—'], ['Type', typeLabel], ['Page', page], ['Submitted', `${timestamp} ET`]])
      + `<p style="margin:0 0 6px;font-family:${L.MONO};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${L.PALETTE.muted};">Subject</p>`
      + `<p style="margin:0 0 16px;font-family:${L.SANS};font-size:16px;font-weight:600;color:${L.PALETTE.ink};">${escapeHtml(title)}</p>`
      + `<p style="margin:0 0 6px;font-family:${L.MONO};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${L.PALETTE.muted};">Details</p>`
      + `<div style="background:#fff;border:1px solid ${L.PALETTE.rule};padding:14px 16px;font-family:${L.SANS};font-size:14px;line-height:1.6;color:${L.PALETTE.ink};white-space:pre-wrap;">${escapeHtml(details)}</div>`,
  });
}

async function sendInternalRequestEmail({ typeLabel, userName, userEmail, userRole, page, title, details, timestamp, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildInternalRequestHtml({ typeLabel, userName, userEmail, userRole, page, title, details, timestamp });
        await sendMail({ kind: 'internal_request',
      to: toOverride || 'john@deanst.co',
      cc: ccOverride || undefined,
      subject: subjectOverride || `[Dashboard] ${typeLabel} from ${userName}: ${title}`,
      html,
    });
    console.log(`[email] Internal request sent (${typeLabel} from ${userEmail})`);
  } catch (err) {
    console.error(`[email] Failed to send internal request email:`, err.message);
    throw err;
  }
}

function buildTestUserInvitationHtml({ name, email, password, role }) {
  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">market.st Dashboard — Demo</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Welcome, ${escapeHtml(name)}</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;font-size:14px;color:#444;">You've been given a demo account for the market.st Dashboard. You'll see the ${role === 'Admin' ? 'Admin' : 'User'} experience with sample data — no real company data is accessible from this account.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;width:110px;">Email</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(email)}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Password</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(password)}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Role</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;">${escapeHtml(role || '')}</td>
            </tr>
          </table>
          <a href="${APP_URL}/login" style="display:inline-block;background:#334155;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Log in to Dashboard</a>
          <p style="margin:20px 0 0;font-size:12px;color:#888;">This is a demo account. All data you see is mocked for demonstration purposes only.</p>
        </div>
      </div>`;
}

/**
 * Welcome email for a demo/test user. Unlike real users (who sign in with
 * Google), test users authenticate with an email+password that the superadmin
 * sets manually — so it's intended that we include the password here.
 */
async function sendTestUserInvitationEmail({ name, email, password, role, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildTestUserInvitationHtml({ name, email, password, role });
        await sendMail({ kind: 'test_invitation',
      to: toOverride || email,
      cc: ccOverride || undefined,
      subject: subjectOverride || 'Your market.st demo account is ready',
      html,
    });
    console.log(`[email] Test-user invitation sent to ${toOverride || email}`);
  } catch (err) {
    console.error(`[email] Failed to send test-user invitation to ${email}:`, err.message);
    throw err;
  }
}

/**
 * @mention in the team message board (/messages).
 *
 * Sent ONLY to a mentioned person who is not currently connected — someone with
 * the app open already got the live in-app notification, and mailing them as
 * well is how a chat feature becomes the reason people filter your domain.
 * routes/chat.js decides who is offline (realtime.onlineUsers()) and throttles
 * per recipient; this file only knows how to compose and send.
 *
 * Unlike every other sender here, this one NO-OPS when no mail provider is
 * configured instead of throwing. A mention email is a courtesy on a best-effort
 * path — a dev box with no GMAIL_* credentials must not fill its logs with a
 * failure for every message anyone types.
 */
function buildChatMentionHtml({ recipientName, actorName, channelLabel, snippet, link }) {
  return L.layout({
    title: 'You were mentioned', eyebrow: 'Messages', accent: 'royal',
    preheader: `${actorName || 'Someone'} mentioned you in ${channelLabel || 'a conversation'}.`,
    body: L.p(`Hi ${escapeHtml(recipientName || '')}, <strong>${escapeHtml(actorName || 'Someone')}</strong> mentioned you in <strong>${escapeHtml(channelLabel || 'a conversation')}</strong>:`, { raw: true })
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px;"><tr><td style="border-left:4px solid ${L.PALETTE.royal};background:#fff;padding:14px 16px;font-family:${L.SANS};font-size:14px;line-height:1.6;color:${L.PALETTE.ink};white-space:pre-wrap;">${escapeHtml(snippet || '')}</td></tr></table>`
      + L.p("You're getting this because you weren't online when it was posted. Mentions always appear in the app too.", { small: true, muted: true }),
    cta: { label: 'Open the conversation', href: link || APP_URL },
  });
}

function buildChatMentionSubject({ actorName, channelLabel }) {
  return `[market.st Dashboard] ${actorName || 'Someone'} mentioned you in ${channelLabel || 'a conversation'}`;
}

async function sendChatMentionEmail({ recipientName, recipientEmail, actorName, channelLabel, snippet, link, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !recipientEmail) return false;
    // No provider configured → silently do nothing. See the note above.
    if (!(await isConnected('team'))) return false;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildChatMentionHtml({ recipientName, actorName, channelLabel, snippet, link });
        await sendMail({ kind: 'chat_mention',
      to: toOverride || recipientEmail,
      cc: ccOverride || undefined,
      subject: subjectOverride || buildChatMentionSubject({ actorName, channelLabel }),
      html,
    });
    console.log(`[email] Chat mention notification sent to ${toOverride || recipientEmail}`);
    return true;
  } catch (err) {
    // Swallowed, not rethrown: the message is already stored and the bell
    // already has the mention. A mail failure must never surface as a failed send.
    console.error('[email] Failed to send chat mention email:', err.message);
    return false;
  }
}

/**
 * Generic email sender — use for one-off flows where the HTML is composed by the caller.
 */
async function sendEmail({ to, cc, subject, html, attachments, purpose = 'team', kind, entity }) {
  await sendMail({ purpose, kind, to, cc: cc || undefined, subject, html, attachments: attachments || [], entity });
}

module.exports = {
  // Senders
  sendWelcomeEmail,
  sendTestUserInvitationEmail,
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
  sendPaymentConfirmationEmail,
  sendBulkPaymentConfirmationEmail,
  sendTaskAssignmentEmail,
  sendInternalRequestEmail,
  sendChatMentionEmail,
  sendEmail,
  // Template builders + subject helpers (for /api/email/preview)
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
  buildChatMentionHtml,
  buildChatMentionSubject,
  // Utilities
  sanitizeEmailHtml,
  escapeHtml,
};
