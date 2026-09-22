// The Gmail API call, raw HTTPS — one copy (it used to live in
// services/email.js, routes/team.js and routes/requests.js). lib/mail.js is the
// only caller; it supplies the From header for the mailbox it resolved.
const https = require('https');

function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
}
const SEND_TIMEOUT_MS = Number(process.env.GMAIL_SEND_TIMEOUT_MS || 120000);

// Send via Gmail API (raw HTTPS — no SMTP, works on Railway)
// Supports optional attachments: [{ filename, data (base64), mimeType }]
function sendViaGmailAPI(accessToken, { from, replyTo, to, cc, subject, html, attachments }) {
  const fromHeader = from || `market.st <${process.env.GMAIL_USER}>`;
  return new Promise((resolve, reject) => {
    let message;

    if (attachments && attachments.length > 0) {
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const parts = [
        `From: ${fromHeader}`,
        ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
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
        `From: ${fromHeader}`,
        ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
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


module.exports = { sendViaGmailAPI, encodeSubject };
