#!/usr/bin/env node
/**
 * The two ways a payment-confirmation send could finish in NO state at all.
 *
 * Both end the same way for the person using the app: the vendor has the email,
 * the row still says "Send", and the caller is never told either. They are not
 * hypotheticals — every send goes through this one function, and neither case
 * was handled:
 *
 *   1. A 2xx whose body is not JSON. `JSON.parse(data)` sat on the first line of
 *      the response handler, so a throw there was NOT a rejection: it escaped
 *      into the 'end' event, the promise never settled, and the UPDATE that
 *      marks the row confirmed never ran.
 *
 *   2. A socket that never answers. There was no timeout of any kind, so the
 *      promise simply waited — for the request, for the page, forever.
 *
 * Run:  node scripts/gmail-transport-fixture.cjs        (from server/)
 *
 * Nothing leaves this process. `https.request` and the OAuth token exchange are
 * both replaced before services/email.js is loaded, so this exercises the REAL
 * the Gmail transport against a scripted https.request rather than a copy
 * of it — a copy would only prove the copy.
 */
const { EventEmitter } = require('events');

process.env.GMAIL_SEND_TIMEOUT_MS = '1200';   // also proves the override is read
process.env.GMAIL_USER = 'test@deanst.co';

// Patch BEFORE requiring email.js: it destructures getAccessToken at load time,
// so a later assignment on the module object would not be seen.
const oauth = require('../lib/google-oauth');
oauth.getAccessToken = async () => 'fake-access-token';

const https = require('https');
const realRequest = https.request;

// A scripted response. `mode` decides what the transport does with the request.
let mode = 'json-200';
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.setTimeout = (ms, fn) => { req._timeoutMs = ms; req._onTimeout = fn; };
  req.destroy = (err) => { if (err) req.emit('error', err); };
  req.end = () => {
    if (mode === 'silent') {
      // Never respond — exactly what a hung socket does. The only thing that
      // can end this is the timeout the code under test is supposed to set.
      if (req._onTimeout) setTimeout(() => req._onTimeout(), req._timeoutMs);
      return;
    }
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = mode === 'html-500' ? 500 : 200;
      cb(res);
      const body = mode === 'json-200' ? '{"id":"18f0c"}'
        : mode === 'html-200' ? '<html><title>Moved</title></html>'
          : mode === 'empty-200' ? ''
            : '<html>500 Internal Server Error</html>';
      if (body) res.emit('data', body);
      res.emit('end');
    });
  };
  return req;
};

// The transport moved to lib/gmail-transport.js (2026-09-19, connected
// mailboxes); the senders now route through lib/mail.js, which needs a mailbox
// row. This fixture is about the TRANSPORT, so it calls it directly.
const { sendViaGmailAPI } = require('../lib/gmail-transport');

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};

// Settle-or-time-out: the bug being fixed is a promise that NEVER settles, so
// every case is raced against a deadline. Without this the fixture would hang
// on a regression instead of reporting one, which is the same failure the code
// had.
const settles = (p, ms = 4000) => Promise.race([
  p.then(() => ({ state: 'resolved' }), (e) => ({ state: 'rejected', message: e.message })),
  new Promise((r) => setTimeout(() => r({ state: 'HUNG' }), ms)),
]);

const send = () => sendViaGmailAPI('fake-access-token', {
  from: 'Market Street <test@deanst.co>', to: 'accounts@salmonstudios.net',
  subject: 'Payment confirmation — SS-1611', html: '<p>Paid.</p>',
});

(async () => {
  mode = 'json-200';
  let r = await settles(send());
  check('a normal 200 resolves', r.state === 'resolved', r.state);

  // The case that used to throw inside the response handler.
  mode = 'html-200';
  r = await settles(send());
  check('a 2xx with a non-JSON body resolves instead of hanging', r.state === 'resolved',
    `${r.state}${r.message ? ': ' + r.message : ''}`);

  mode = 'empty-200';
  r = await settles(send());
  check('a 2xx with an empty body resolves', r.state === 'resolved', r.state);

  // An error still has to be an error — the guard must not swallow failures,
  // or callers mark rows sent for messages Gmail refused.
  mode = 'html-500';
  r = await settles(send());
  check('a non-2xx still REJECTS', r.state === 'rejected', r.state);
  check('and the refusal quotes the body it could not parse',
    r.state === 'rejected' && /500/.test(r.message || ''), (r.message || '').slice(0, 80));

  // The case that used to wait forever.
  mode = 'silent';
  const t0 = Date.now();
  r = await settles(send(), 6000);
  const waited = Date.now() - t0;
  check('a silent socket rejects rather than hanging', r.state === 'rejected', `${r.state} after ${waited}ms`);
  check('and it gives up on the configured timeout, not eventually',
    r.state === 'rejected' && waited < 3000, `${waited}ms with GMAIL_SEND_TIMEOUT_MS=1200`);
  check('and it says the message may already have gone',
    r.state === 'rejected' && /may or may not/.test(r.message || ''), (r.message || '').slice(0, 90));

  https.request = realRequest;
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
