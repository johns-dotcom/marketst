// The one email frame — Market Street's look, in email-safe HTML.
//
// The public vendor form's theme (client/src/styles/marketst-form.css) is the
// reference: warm paper, a green MARKET ST street sign, flat colour bars
// (brick · royal · forest · mustard), monospace headings. Every template in
// services/email.js, lib/notifier.js, lib/invites.js and routes/team.js
// renders its body INSIDE this frame, so one change here changes every email.
//
//   layout({ title, eyebrow, body, cta: { label, href }, accent, preheader, footerNote })
//
// `body` is trusted HTML the caller has already escaped. The footer reads the
// label's display name, address and contact from Settings › Label (cached 5 min).
const pool = require('../db');

const APP_URL = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
const PALETTE = {
  paper: '#F1EBDD', card: '#FBF8F1', ink: '#1C1A17', muted: '#6B6455', rule: '#D9CFB8',
  brick: '#D6482F', royal: '#2E47B8', forest: '#2F7A62', sign: '#1F6B4E', mustard: '#C99A2F',
};
const ACCENT = { brick: PALETTE.brick, royal: PALETTE.royal, forest: PALETTE.forest, mustard: PALETTE.mustard, sign: PALETTE.sign };
const MONO = "'IBM Plex Mono', Menlo, Consolas, 'Courier New', monospace";
const SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The label's details, cached so `layout` can stay synchronous (every
// builder is sync and the preview modal calls them inline). Primed on load,
// refreshed every five minutes, and by routes/label.js after a save.
let labelCache = {};
async function refreshLabel() {
  try {
    const { rows: [l] } = await pool.query('SELECT display_name, legal_name, address_line1, address_line2, contact_email, contact_phone FROM label_settings WHERE id = 1');
    labelCache = l || {};
  } catch { /* keep what we had */ }
  return labelCache;
}
const labelInfo = () => labelCache;
setTimeout(() => refreshLabel().catch(() => {}), 5000);
setInterval(() => refreshLabel().catch(() => {}), 5 * 60 * 1000).unref?.();
const labelName = (l) => l?.display_name || l?.legal_name || 'Market Street';

// A key/value table in the house style — used by most templates.
function rows(pairs, { valueStyle = '' } = {}) {
  const list = pairs.filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== '');
  if (!list.length) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;border:1px solid ${PALETTE.rule};">
    ${list.map(([k, v, opts = {}], i) => `<tr>
      <td style="padding:9px 12px;background:${PALETTE.paper};border-bottom:${i < list.length - 1 ? `1px solid ${PALETTE.rule}` : 'none'};font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${PALETTE.muted};width:38%;vertical-align:top;">${esc(k)}</td>
      <td style="padding:9px 12px;background:#fff;border-bottom:${i < list.length - 1 ? `1px solid ${PALETTE.rule}` : 'none'};font-family:${SANS};font-size:14px;color:${PALETTE.ink};${opts.mono ? `font-family:${MONO};` : ''}${opts.strong ? 'font-weight:700;' : ''}${opts.color ? `color:${opts.color};` : ''}${valueStyle}">${opts.raw ? v : esc(v)}</td>
    </tr>`).join('')}
  </table>`;
}
const p = (text, opts = {}) => `<p style="margin:0 0 14px;font-family:${SANS};font-size:${opts.small ? 13 : 15}px;line-height:1.6;color:${opts.muted ? PALETTE.muted : PALETTE.ink};${opts.pre ? 'white-space:pre-wrap;' : ''}">${opts.raw ? text : esc(text)}</p>`;
const button = (label, href, accent = 'sign') => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;"><tr><td style="background:${ACCENT[accent] || ACCENT.sign};">
  <a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-family:${MONO};font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#fff;text-decoration:none;">${esc(label)}</a></td></tr></table>`;

function layout({ title, eyebrow, body, cta, accent = 'forest', preheader, footerNote }) {
  const l = labelInfo();
  const name = labelName(l);
  const bar = ACCENT[accent] || ACCENT.forest;
  const address = [l?.address_line1, l?.address_line2].filter(Boolean).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${PALETTE.paper};">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PALETTE.paper};">${esc(preheader)}</div>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PALETTE.paper};padding:28px 12px;"><tr><td align="center">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
    <!-- the street sign -->
    <tr><td style="padding:0 0 14px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${PALETTE.sign};padding:9px 16px 8px;border:2px solid #16543d;">
          <span style="font-family:${MONO};font-size:15px;font-weight:700;letter-spacing:3px;color:#fff;text-transform:uppercase;">${esc(name.toUpperCase() === 'MARKET STREET' ? 'MARKET ST' : name)}</span>
        </td>
        <td style="width:10px;"></td>
        <td style="font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${PALETTE.muted};">${esc(eyebrow || 'Label dashboard')}</td>
      </tr></table>
    </td></tr>
    <!-- the card -->
    <tr><td style="background:${PALETTE.card};border:1px solid ${PALETTE.rule};border-top:6px solid ${bar};padding:26px 28px 22px;">
      <h1 style="margin:0 0 16px;font-family:${MONO};font-size:20px;line-height:1.3;font-weight:700;color:${PALETTE.ink};letter-spacing:-0.2px;">${esc(title)}</h1>
      ${body}
      ${cta ? button(cta.label, cta.href, accent) : ''}
    </td></tr>
    <!-- the footer -->
    <tr><td style="padding:16px 4px 0;">
      <p style="margin:0 0 4px;font-family:${MONO};font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${PALETTE.muted};">${esc(name)}${address ? ` · ${esc(address)}` : ''}</p>
      <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${PALETTE.muted};">${footerNote ? esc(footerNote) + ' ' : ''}${l?.contact_email ? `Questions: <a href="mailto:${esc(l.contact_email)}" style="color:${PALETTE.forest};">${esc(l.contact_email)}</a>. ` : ''}Sent from the <a href="${esc(APP_URL)}" style="color:${PALETTE.forest};">${esc(name)} dashboard</a>.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

module.exports = { layout, rows, p, button, esc, PALETTE, ACCENT, MONO, SANS, labelInfo, refreshLabel, APP_URL };
