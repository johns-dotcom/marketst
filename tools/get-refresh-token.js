/**
 * One-time script to mint the Google refresh token (Gmail + Drive).
 * Run from the Dashboard folder: node get-refresh-token.js
 * Then copy the printed token into GMAIL_REFRESH_TOKEN on Railway.
 *
 * ── THIS SCRIPT DOES NOT WORK AS-IS WITH THE CURRENT OAUTH CLIENT ───────────
 *
 * Verified 2026-08-07: the client in client_secret_*.json is a **Web
 * application** type whose only registered redirect URI is
 *
 *     https://developers.google.com/oauthplayground
 *
 * It has never had http://localhost:3000 registered, so this script has always
 * failed with `Error 400: redirect_uri_mismatch` — the existing Gmail token was
 * minted through the OAuth Playground, not from here.
 *
 * Two ways forward:
 *
 *   A. Use the Playground (no Cloud Console change):
 *      https://developers.google.com/oauthplayground → gear icon →
 *      "Use your own OAuth credentials" → paste the client_id / client_secret
 *      from client_secret_*.json → put BOTH scopes below in the scope box →
 *      Authorize → "Exchange authorization code for tokens" → copy the refresh
 *      token. Set Access type = Offline and Force prompt = Consent, or Google
 *      returns an access token with no refresh token.
 *
 *   B. Make this script work: add http://localhost:3000 to the client's
 *      Authorized redirect URIs in the Cloud Console (Credentials → the OAuth
 *      client → Authorized redirect URIs). Nothing here needs changing then.
 *
 * Either way the scopes must be BOTH of the ones in SCOPE below — see the note
 * there about why dropping Gmail would break every email the server sends.
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const fs   = require('fs');
const path = require('path');

// Google downloads the credentials as `client_secret_<id>.apps.googleusercontent.com.json`,
// so the old hardcoded `client_secret.json` never matched what is actually on
// disk. Find it instead of asking anyone to copy a credential file around —
// there should be exactly one copy of this, and it must never be committed.
const SECRET_FILE = fs.readdirSync(__dirname)
  .filter((f) => /^client_secret.*\.json$/.test(f))
  .sort()[0];
if (!SECRET_FILE) {
  console.error('No client_secret*.json found in this folder. Download the OAuth client credentials from the Google Cloud console first.');
  process.exit(1);
}
const secret = JSON.parse(fs.readFileSync(path.join(__dirname, SECRET_FILE), 'utf8'));
const creds  = secret.installed || secret.web;

const CLIENT_ID     = creds.client_id;
const CLIENT_SECRET = creds.client_secret;
const REDIRECT_URI  = 'http://localhost:3000';

// BOTH scopes, space-separated. One refresh token serves every Google
// integration in this app, so minting it with only Drive would silently break
// every email the server sends — invoices, payment confirmations, vendor
// notifications. Gmail stays first; drive.file was added for the Reports →
// Google Sheets export.
//
// drive.file is least privilege: create files, and manage ONLY files this app
// created. It cannot read the rest of the Drive. Do not widen it to `drive` or
// `spreadsheets`.
const SCOPE = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n── Gmail Refresh Token Setup ──────────────────────────\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for Google to redirect back...\n');

const server = http.createServer((req, res) => {
  const url  = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  const err  = url.searchParams.get('error');

  if (err) {
    res.end(`<h2>Error: ${err}</h2>`);
    console.error('\nAuthorization error:', err);
    server.close();
    return;
  }

  if (!code) { res.end('Waiting...'); return; }

  res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>✅ Done! Check your terminal for the refresh token.</h2></body></html>');

  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  }).toString();

  const req2 = https.request(
    {
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    },
    (res2) => {
      let data = '';
      res2.on('data', c => data += c);
      res2.on('end', () => {
        const tokens = JSON.parse(data);
        if (!tokens.refresh_token) {
          console.error('\nNo refresh token returned. Try revoking app access at');
          console.error('https://myaccount.google.com/permissions and run this script again.\n');
        } else {
          console.log('── Copy these into Railway ────────────────────────────\n');
          console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
          console.log('(GMAIL_USER should be the Google account you just authorized)\n');
        }
        server.close();
      });
    }
  );
  req2.on('error', e => { console.error('Token exchange error:', e); server.close(); });
  req2.write(body);
  req2.end();
});

server.listen(3000, '127.0.0.1', () => {
  console.log('Listening on http://localhost:3000 — open the URL above now.\n');
});
