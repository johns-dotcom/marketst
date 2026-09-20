// One small HTTPS helper for the integrations: JSON in, JSON (or bytes) out,
// with the status code, so a caller can tell 401 (refresh the token) from
// 400 (fix the payload). No dependencies.
const https = require('https');

function request(url, { method = 'GET', headers = {}, body, form, raw = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let payload = null;
    const h = { Accept: raw ? '*/*' : 'application/json', ...headers };
    if (form) { payload = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['Content-Type'] = h['Content-Type'] || 'application/json'; }
    if (payload !== null) h['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, headers: res.headers, buffer: buf });
        const text = buf.toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out calling ${u.hostname}`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

module.exports = { request, basic };
