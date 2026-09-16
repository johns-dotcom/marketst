const https = require('https');

// The refresh-token exchange moved to lib/google-oauth.js when the Sheets export
// became a second caller. Same code, same behaviour (a fresh token per call) —
// the move exists so the two integrations can never drift apart on credentials.
const { getAccessToken, credentialsPresent } = require('../lib/google-oauth');

const APP_URL = process.env.FRONTEND_URL || 'https://marketst-dashboard.up.railway.app';

// Encode subject line for non-ASCII characters (RFC 2047)
function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject; // pure ASCII, no encoding needed
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
}

// How long to wait for Gmail before giving up on one message. Attachments are
// inlined base64 in the request body, so a multi-MB invoice + proof is a slow
// upload; this is not a latency budget, it is a backstop against a socket that
// never answers.
const SEND_TIMEOUT_MS = Number(process.env.GMAIL_SEND_TIMEOUT_MS || 120000);

// Send via Gmail API (raw HTTPS — no SMTP, works on Railway)
// Supports optional attachments: [{ filename, data (base64), mimeType }]
function sendViaGmailAPI(accessToken, { to, cc, subject, html, attachments }) {
  return new Promise((resolve, reject) => {
    let message;

    if (attachments && attachments.length > 0) {
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const parts = [
        `From: Market Street <${process.env.GMAIL_USER}>`,
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${encodeSubject(subject)}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        html,
      ]
      for (const att of attachments) {
        const mime = att.mimeType || 'application/pdf'
        parts.push(
          `--${boundary}`,
          `Content-Type: ${mime}; name="${att.filename}"`,
          `Content-Disposition: attachment; filename="${att.filename}"`,
          `Content-Transfer-Encoding: base64`,
          ``,
          att.data,
        )
      }
      parts.push(`--${boundary}--`)
      message = parts.join('\r\n')
    } else {
      message = [
        `From: Market Street <${process.env.GMAIL_USER}>`,
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${encodeSubject(subject)}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        html,
      ].join('\r\n')
    }

    const encoded = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const body = JSON.stringify({ raw: encoded });

    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path:     '/gmail/v1/users/me/messages/send',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // The STATUS decides, not the body. This used to be a bare
        // `JSON.parse(data)` on the first line: a non-JSON body — Google's HTML
        // error page, a truncated response — threw INSIDE this handler, which is
        // not a rejection. The promise never settled, so the caller waited
        // forever and the work after it (marking the row confirmed) never ran,
        // while the message may well have been accepted.
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || { raw: data });
        else reject(new Error(`Gmail API error ${res.statusCode}: ${json ? JSON.stringify(json) : data.slice(0, 300)}`));
      });
    });
    // A hung socket is the other way this promise never settles, and it costs
    // the same thing: the send is neither confirmed nor recorded, and the row
    // keeps offering Send with the email already gone. Generous — big
    // attachments upload slowly — but finite, so it fails instead of hanging.
    req.setTimeout(SEND_TIMEOUT_MS, () => {
      req.destroy(new Error(`Gmail API did not respond within ${SEND_TIMEOUT_MS / 1000}s — `
        + 'the message may or may not have been sent; check the sent folder before resending.'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildWelcomeHtml({ name, email, role, department }) {
  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street Dashboard</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Welcome, ${escapeHtml(name)}</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 20px;font-size:14px;color:#444;">Your account has been created. Sign in with your Google account (<strong>${escapeHtml(email)}</strong>) to get started.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;width:110px;">Role</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;font-size:14px;">${escapeHtml(role || '')}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Department</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;">${escapeHtml(department || '')}</td>
            </tr>
          </table>
          <a href="${APP_URL}" style="display:inline-block;background:#334155;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Log in to Dashboard</a>
        </div>
      </div>`;
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
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
      to: toOverride || email,
      cc: ccOverride || undefined,
      subject: subjectOverride || 'Welcome to Market Street Dashboard',
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
  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Invoice Approved</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;font-size:14px;color:#444;">Hi ${escapeHtml(vendorName)},</p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;">Your invoice has been <strong style="color:#16a34a;">approved</strong> and is being processed for payment.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            ${invoiceNumber ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:120px;">Invoice #</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;font-size:14px;">${escapeHtml(invoiceNumber)}</td>
            </tr>` : ''}
            ${fmtAmount ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:120px;">Amount</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;font-weight:700;">${fmtAmount}</td>
            </tr>` : ''}
            ${artist ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:120px;">Artist</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;">${escapeHtml(artist)}</td>
            </tr>` : ''}
          </table>
          <div style="background:#fff;border:1px solid #e5e5e5;border-left:3px solid #334155;padding:12px 16px;margin:0 0 16px;border-radius:0 6px 6px 0;">
            <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:0.5px;">Payment Schedule</p>
            <p style="margin:0;font-size:13px;color:#444;">Market Street operates on a Net 30 payment schedule. You can expect your payment to hit by <strong>${payByStr}</strong>.</p>
          </div>
          <p style="margin:0;font-size:13px;color:#888;">You'll receive another email with proof of payment once the payment has been completed.</p>
        </div>
      </div>`;
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
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Invoice Update</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;font-size:14px;color:#444;">Hi ${escapeHtml(vendorName)},</p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;">Unfortunately, your invoice could not be approved at this time.</p>
          ${reason ? `
          <div style="background:#fef2f2;border-left:3px solid #dc2626;padding:12px 16px;margin:0 0 20px;border-radius:0 6px 6px 0;">
            <p style="margin:0;font-size:12px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Reason</p>
            <p style="margin:0;font-size:14px;color:#991b1b;">${escapeHtml(reason)}</p>
          </div>` : ''}
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            ${invoiceNumber ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:120px;">Invoice #</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;font-size:14px;">${escapeHtml(invoiceNumber)}</td>
            </tr>` : ''}
            ${fmtAmount ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:120px;">Amount</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;">${fmtAmount}</td>
            </tr>` : ''}
          </table>
          <p style="margin:0;font-size:13px;color:#888;">Please review and resubmit your invoice, or contact us directly if you have questions.</p>
        </div>
      </div>`;
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
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
  const greetingHtml = `<p style="margin:0 0 16px;font-size:14px;color:#444;">${escapeHtml(greetingText)}</p>`;

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
    : `<p style="margin:0 0 20px;font-size:14px;color:#444;">Your invoice has been <strong style="color:#16a34a;">paid</strong>. Please find the details and proof of payment attached.</p>`;

  const noteHtml = personalMessage && String(personalMessage).trim()
    ? `<p style="margin:0 0 16px;font-size:14px;color:#444;white-space:pre-wrap;">${escapeHtml(personalMessage).replace(/\n/g, '<br/>')}</p>`
    : '';

  const closingText = (closing && String(closing).trim()) || DEFAULT_CLOSING_PLAIN;
  const closingHtml = `<p style="margin:0;font-size:13px;color:#888;white-space:pre-wrap;">${escapeHtml(closingText).replace(/\n/g, '<br/>')}</p>`;

  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Payment Confirmation</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          ${greetingHtml}
          ${introHtml}
          ${noteHtml}
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            ${invoiceNumber ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:130px;">Invoice #</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;font-size:14px;">${escapeHtml(invoiceNumber)}</td>
            </tr>` : ''}
            ${fmtAmount ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:130px;">Amount Paid</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;font-weight:700;color:#16a34a;">${fmtAmount}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:130px;">Payment Date</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;">${fmtDate}</td>
            </tr>
            ${paymentMethod ? `<tr>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-top:none;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;width:130px;">Method</td>
              <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;border-left:none;border-top:none;font-size:14px;">${escapeHtml(paymentMethod)}</td>
            </tr>` : ''}
          </table>
          ${closingHtml}
        </div>
      </div>`;
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

    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
        <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;${i > 0 ? 'border-top:none;' : ''}font-size:13px;color:#444;">
          ${it.invoiceNumber ? `<strong>#${escapeHtml(it.invoiceNumber)}</strong>` : `Invoice ${i + 1}`}
          ${it.paymentMethod ? ` <span style="color:#999;font-size:11px;">· ${escapeHtml(it.paymentMethod)}</span>` : ''}
          <div style="font-size:11px;color:#999;margin-top:2px;">Paid ${fmtDate(it.paymentDate)}</div>
        </td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e5e5e5;${i > 0 ? 'border-top:none;' : ''}border-left:none;font-size:14px;font-weight:700;color:#16a34a;text-align:right;white-space:nowrap;">
          ${fmtMoney(it.amount, it.currency)}
        </td>
      </tr>`).join('');

  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Payment Confirmation — ${items.length} invoice${items.length === 1 ? '' : 's'}</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;font-size:14px;color:#444;">Hi ${escapeHtml(vendorName)},</p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;">The following ${items.length} invoice${items.length === 1 ? '' : 's'} ${items.length === 1 ? 'has' : 'have'} been <strong style="color:#16a34a;">paid</strong>. Proofs of payment are attached.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${rowsHtml}</table>
          <div style="background:#fff;border:1.5px solid #16a34a;border-radius:6px;padding:10px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px;">Total Paid</span>
            <span style="font-size:16px;font-weight:800;color:#16a34a;">${totalLine}</span>
          </div>
          <p style="margin:0;font-size:13px;color:#888;">If you have any questions about these payments, please reply to this email.</p>
        </div>
      </div>`;
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

    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">New Task Assigned</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 20px;font-size:14px;color:#444;">Hi ${escapeHtml(assigneeName || '')}, <strong>${escapeHtml(assignerName || '')}</strong> assigned you a task:</p>
          <div style="background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <p style="margin:0;font-size:16px;font-weight:600;color:#111;">${escapeHtml(description || '')}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:6px 0;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;width:100px;">Priority</td>
              <td style="padding:6px 0;font-size:14px;color:#111;">${escapeHtml(priority || 'Medium')}</td>
            </tr>
            ${due ? `<tr>
              <td style="padding:6px 0;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Due</td>
              <td style="padding:6px 0;font-size:14px;color:#111;">${due}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:6px 0;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Assigned by</td>
              <td style="padding:6px 0;font-size:14px;color:#111;">${escapeHtml(assignerName || '')}</td>
            </tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#aaa;">Log in to the Market Street Dashboard to view and manage your tasks.</p>
        </div>
      </div>`;
}

function buildTaskAssignmentSubject({ assignerName, description }) {
  const d = String(description || '');
  return `[Market Street Dashboard] New task from ${assignerName}: ${d.slice(0, 60)}${d.length > 60 ? '…' : ''}`;
}

async function sendTaskAssignmentEmail({ assigneeName, assigneeEmail, assignerName, description, priority, due_date, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !assigneeEmail) return;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildTaskAssignmentHtml({ assigneeName, assignerName, description, priority, due_date });
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
  return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #111;">
        <div style="background: #111; padding: 24px 32px; border-radius: 12px 12px 0 0;">
          <p style="margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #999; text-transform: uppercase;">Market Street Dashboard</p>
          <h1 style="margin: 8px 0 0; font-size: 22px; font-weight: 700; color: #fff;">${escapeHtml(typeLabel)}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <tr>
              <td style="padding: 8px 0; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px; width: 120px;">From</td>
              <td style="padding: 8px 0; font-size: 14px; color: #111;">${escapeHtml(userName)} &lt;${escapeHtml(userEmail)}&gt;</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Role</td>
              <td style="padding: 8px 0; font-size: 14px; color: #111;">${escapeHtml(userRole || '—')}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Type</td>
              <td style="padding: 8px 0; font-size: 14px; color: #111;">${escapeHtml(typeLabel)}</td>
            </tr>
            ${page ? `<tr>
              <td style="padding: 8px 0; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Page</td>
              <td style="padding: 8px 0; font-size: 14px; color: #111;">${escapeHtml(page)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding: 8px 0; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Submitted</td>
              <td style="padding: 8px 0; font-size: 14px; color: #111;">${escapeHtml(timestamp)} ET</td>
            </tr>
          </table>
          <div style="margin-bottom: 16px;">
            <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Subject</p>
            <p style="margin: 0; font-size: 16px; font-weight: 600; color: #111;">${escapeHtml(title)}</p>
          </div>
          <div>
            <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Details</p>
            <div style="background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.6; color: #333; white-space: pre-wrap;">${escapeHtml(details)}</div>
          </div>
        </div>
      </div>
    `;
}

async function sendInternalRequestEmail({ typeLabel, userName, userEmail, userRole, page, title, details, timestamp, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildInternalRequestHtml({ typeLabel, userName, userEmail, userRole, page, title, details, timestamp });
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street Dashboard — Demo</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">Welcome, ${escapeHtml(name)}</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;font-size:14px;color:#444;">You've been given a demo account for the Market Street Dashboard. You'll see the ${role === 'Admin' ? 'Admin' : 'User'} experience with sample data — no real company data is accessible from this account.</p>
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
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
      to: toOverride || email,
      cc: ccOverride || undefined,
      subject: subjectOverride || 'Your Market Street demo account is ready',
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
  return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">You were mentioned</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 20px;font-size:14px;color:#444;">Hi ${escapeHtml(recipientName || '')}, <strong>${escapeHtml(actorName || 'Someone')}</strong> mentioned you in ${escapeHtml(channelLabel || 'a conversation')}:</p>
          <div style="background:#fff;border:1px solid #e5e5e5;border-left:3px solid #334155;border-radius:10px;padding:16px 20px;margin-bottom:22px;">
            <p style="margin:0;font-size:14px;line-height:1.6;color:#111;white-space:pre-wrap;">${escapeHtml(snippet || '')}</p>
          </div>
          <a href="${escapeHtml(link || APP_URL)}" style="display:inline-block;background:#334155;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;">Open the conversation</a>
          <p style="margin:22px 0 0;font-size:12px;color:#aaa;">You're getting this because you weren't online when it was posted. Mentions always appear in the dashboard's notification bell.</p>
        </div>
      </div>`;
}

function buildChatMentionSubject({ actorName, channelLabel }) {
  return `[Market Street Dashboard] ${actorName || 'Someone'} mentioned you in ${channelLabel || 'a conversation'}`;
}

async function sendChatMentionEmail({ recipientName, recipientEmail, actorName, channelLabel, snippet, link, htmlOverride, toOverride, ccOverride, subjectOverride }) {
  try {
    if (!toOverride && !recipientEmail) return false;
    // No provider configured → silently do nothing. See the note above.
    if (!credentialsPresent()) return false;
    const html = htmlOverride
      ? sanitizeEmailHtml(htmlOverride)
      : buildChatMentionHtml({ recipientName, actorName, channelLabel, snippet, link });
    const accessToken = await getAccessToken();
    await sendViaGmailAPI(accessToken, {
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
async function sendEmail({ to, cc, subject, html, attachments }) {
  const accessToken = await getAccessToken();
  await sendViaGmailAPI(accessToken, { to, cc: cc || undefined, subject, html, attachments: attachments || [] });
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
