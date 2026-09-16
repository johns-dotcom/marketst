/**
 * One Google OAuth token exchange, shared by every Google integration.
 *
 * This lived inside services/email.js. It moved here the moment a second caller
 * appeared (the Sheets export), because the alternative — a second copy of the
 * same exchange against the same credentials — is precisely the pattern that has
 * cost this codebase real money: reversal detection defined twice drifted apart
 * and overstated expense by $326,434.43, and alias resolution defined twice let
 * the matcher and the reports disagree about who a vendor was.
 *
 * The credentials are the GMAIL_* trio. That naming is now a misnomer — the same
 * refresh token carries whatever scopes it was minted with, Gmail and Sheets
 * alike — but renaming the env vars would mean a coordinated Railway change for
 * no functional gain, so the names stay and this comment explains them.
 *
 * DELIBERATELY NOT CACHED. A cache is the obvious improvement here and it is not
 * worth it: email is the incumbent caller, it has no 401 retry, and a stale-token
 * failure would surface as invoices silently not sending. Minting a token costs
 * one round trip against an export that already makes several. Behaviour is
 * byte-identical to what email.js did before the move, which is the whole point
 * of the extraction — the shared helper had to be a pure relocation to be safe.
 */
const https = require('https');

function credentialsPresent() {
  return Boolean(process.env.GMAIL_CLIENT_ID
    && process.env.GMAIL_CLIENT_SECRET
    && process.env.GMAIL_REFRESH_TOKEN);
}

/**
 * Exchange the refresh token, returning the access token AND the scopes Google
 * says it carries.
 *
 * Google reports the granted scopes on every exchange, and knowing them up
 * front turns "403 insufficient scope" — which reads identically whether the
 * token is wrong, the API is switched off, or the caller asked for something it
 * shouldn't — into a statement of what the token actually has. Worth the few
 * lines: the ambiguity cost a round trip of "the APIs are enabled, why is it
 * still failing".
 */
function getAccessTokenInfo() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        if (json.access_token) {
          resolve({
            token: json.access_token,
            scopes: String(json.scope || '').split(/\s+/).filter(Boolean),
          });
        } else {
          reject(new Error(`Token error: ${JSON.stringify(json)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// The plain form every existing caller uses. Unchanged behaviour: one exchange
// per call, resolving to the token string.
async function getAccessToken() {
  return (await getAccessTokenInfo()).token;
}

module.exports = { getAccessToken, getAccessTokenInfo, credentialsPresent };
