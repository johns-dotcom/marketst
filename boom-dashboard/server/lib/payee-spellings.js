/**
 * Every way a bank might PRINT one payee, so the name test has something to hit.
 *
 * ── Why this is not a sixth name matcher ──
 * `lib/vendorMatch.js` and `lib/funding-pairs.js` already hold five definitions
 * of "do these name the same party", and adding another is how they drift. The
 * problem here is different: the matcher is fine, it is being handed the wrong
 * STRING. So this file generates the alternative spellings and the existing
 * `namesRecipient` / `descriptorMentions` judge them unchanged.
 *
 * Two sources, both measured against live BofA descriptors on 2026-08-19.
 *
 * ── 1. The email handle ──
 * A "PAYPAL DES:… ID:XXXX" run is USUALLY NOT A NAME. It is the recipient's
 * PayPal handle, which is their email's local part, truncated by the bank to 15
 * characters:
 *
 *   ID:AJAYININI7        ajayinini7@…            Nini Ajayi        exact
 *   ID:DIEGOADRIANPERE   diegoadrianperez123@…   diego perez       15-char prefix
 *   ID:JORDANKALEBARRE   jordankalebarrett@…     Jordan Barrett    15-char prefix
 *   ID:ALWAYSJREAMING    Alwaysjreaming@…        Jonathan Lopez    exact
 *
 * No name test can reach these — "perez" is not in "DIEGOADRIANPERE" and
 * "Alwaysjreaming" is not a name at all — and the truncation is already handled
 * by namesRecipient's existing 10-character squashed-prefix branch. Identity by
 * email equality is evidence this codebase already treats as conclusive
 * (`payeeFromEmail` in routes/statements.js resolves a booking payee from it).
 *
 * ── 2. Pinyin, surname first ──
 * A Han name is stored given-name-first ("志斌 姜") and the bank prints the
 * pinyin surname first, one token per character ("JIANG ZHI BIN"). Every
 * reading below is confirmed by a descriptor that actually printed it — nothing
 * here is guessed:
 *
 *   建 房      -> FANG JIAN         #4610 #4629 #4665 #1645
 *   涛 汪      -> WANG TAO          #2044
 *   志斌 姜    -> JIANG ZHI BIN     #1924
 *   翠芳 姜    -> JIANG CUI FANG    #4651
 *   龍大 青木  -> QING MU LONG DA   #1970
 *
 * The last is a Japanese-looking name the bank romanized as MANDARIN, which is
 * why this table is pinyin only: PayPal transliterates by character, not by the
 * holder's language. `AOKI` and `RYUTA` appear on no statement.
 *
 * ── Extending the table ──
 * It covers the 13 characters in live payee names, not the language. A new Han
 * payee needs its characters added — the failure mode is a missed match, never a
 * wrong one, because an unknown character suppresses the romanization entirely
 * rather than guessing at it.
 */

// The Han blocks that appear in payee names. Deliberately not \p{Script=Han}:
// this must agree with the CJK detection used where the readings are looked up.
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

const HAN_PINYIN = {
  涛: 'tao', 汪: 'wang', 龍: 'long', 大: 'da', 青: 'qing', 木: 'mu',
  志: 'zhi', 斌: 'bin', 姜: 'jiang', 建: 'jian', 房: 'fang', 翠: 'cui', 芳: 'fang',
};

/**
 * Pinyin for a Han name, in both name orders.
 *
 * Reversed by WHITESPACE GROUP, never character by character: "志斌 姜" is the
 * given name 志斌 plus the surname 姜, so the bank's order is
 * jiang + zhibin ("JIANGZHIBIN"). Reversing the characters instead gives
 * "jiangbinzhi", which matches nothing.
 */
function pinyinSpellings(name) {
  const raw = String(name || '').trim();
  if (!raw || !HAN.test(raw)) return [];
  const groups = raw.split(/\s+/).filter(Boolean);
  const out = [];
  for (const g of groups) {
    let syllables = '';
    for (const ch of g) {
      if (!HAN.test(ch)) continue;
      // One unknown character and the whole romanization is abandoned. A partial
      // reading is a shorter, looser string — exactly the kind that matches
      // somebody else's descriptor.
      if (!HAN_PINYIN[ch]) return [];
      syllables += HAN_PINYIN[ch];
    }
    if (!syllables) return [];
    out.push(syllables);
  }
  if (!out.length) return [];

  // SQUASHED, never space-separated — and this is the whole safety argument.
  //
  // Pinyin syllables are short and nest inside one another: "jian" is a
  // substring of "jiang". Emitted as "fang jian", namesRecipient tokenizes it and
  // its every-token test found BOTH inside "JIANG CUI FANG" — so 建 房 matched
  // 翠芳 姜's pull. As one token "fangjian" it is a contiguous test, and
  // "jiangcuifang" does not contain it.
  //
  // Character order is unknown (a Han name is stored given-first, the bank prints
  // the surname first), so both orders are offered; the unspaced case has no
  // surname boundary at all, so the split is tried after the first character and
  // before the last.
  const chars = [...raw].filter((ch) => HAN.test(ch)).map((ch) => HAN_PINYIN[ch]);
  const spellings = new Set([out.join(''), [...out].reverse().join('')]);
  if (groups.length === 1 && chars.length >= 2) {
    for (const cut of [1, chars.length - 1]) {
      const head = chars.slice(0, cut).join('');
      const tail = chars.slice(cut).join('');
      spellings.add(head + tail);
      spellings.add(tail + head);
    }
  }
  // Six characters is the floor. A two-syllable reading can be as short as
  // "liwang", and a 5-character run appears inside unrelated descriptor text far
  // too easily to call it identity.
  return [...spellings].filter((sp) => sp.length >= 6);
}

// TEN characters, the same floor namesRecipient already uses for a squashed-name
// prefix. Measured: "lucas@beeprapp.com" is on exactly one vendor, is not our
// domain, and its local part still matched an unrelated wire descriptor — the
// length is the only thing that stops it. All four handles this rule exists for
// clear it comfortably: ajayinini7 (10), Alwaysjreaming (14), jordankalebarrett
// (17), diegoadrianperez123 (19).
const MIN_HANDLE = 10;

/**
 * The handle a bank would print — the local part of an email, or a bare handle
 * that has already had its domain removed.
 *
 * Accepts both because both are passed: a PayPal row carries a full
 * `payee_email`, while buildEmailIndex below hands back local parts. An earlier
 * version required the "@" and silently returned '' for the index's output, so
 * no payee was ever named by their handle and every contested pull stayed
 * contested — a failure that looked exactly like the rule not working.
 */
const emailLocal = (e) => {
  const s = String(e || '').trim();
  const at = s.indexOf('@');
  const local = at > 0 ? s.slice(0, at) : s;
  // A handle must not contain the leftovers of an address: "@x" alone is not one.
  if (!local || local.includes('@')) return '';
  return local.length >= MIN_HANDLE ? local : '';
};

/**
 * Which vendor emails may stand in for identity — and it is far from all of them.
 *
 * Measured over 290 live vendor emails on 2026-08-19. Two whole classes have to
 * go, and using the raw column would have been actively harmful:
 *
 *   OUR OWN ADDRESSES sit on vendor records. `john@deanst.co` is on 39
 *   vendors; its local part "johns" matched KYRAJOHNSON, "Gary Johnson Jr" and
 *   "John Skead" descriptors — 39 wrong claims from one field.
 *
 *   SHARED ADDRESSES cannot pick between the vendors that share them.
 *   `chasemann8@gmail.com` is on FIVE (Chase Mann, plus Abigail Mendez, Sophie
 *   Thomas, Wadson Devalcin, Aaron Deitz), so Aaron Deitz would have claimed all
 *   eleven of Chase Mann's pulls. `vibessxdgood@gmail.com` is on both Angel
 *   Melendez and Gioangeli Sol Salas Avile — who are already contesting a pull.
 *
 * @param {Array} rows  `{ vendor, email }` pairs, as loaded from expenses /
 *                      vendor_emails. Duplicates are fine.
 * @returns {Map} lowercased vendor name -> usable local parts
 */
function buildEmailIndex(rows, { ownDomains = ['deanst.co'] } = {}) {
  const lc = (v) => String(v || '').trim().toLowerCase();
  const owners = new Map();   // email -> Set(vendor)
  for (const r of rows) {
    const email = lc(r.email);
    const vendor = lc(r.vendor);
    if (!email.includes('@') || !vendor) continue;
    if (ownDomains.some((d) => email.endsWith(`@${lc(d)}`))) continue;
    if (!emailLocal(email)) continue;
    if (!owners.has(email)) owners.set(email, new Set());
    owners.get(email).add(vendor);
  }
  const out = new Map();
  for (const [email, vendors] of owners) {
    if (vendors.size !== 1) continue;   // shared -> identifies nobody
    const vendor = [...vendors][0];
    const local = emailLocal(email);
    const list = out.get(vendor) || [];
    if (!list.includes(local)) list.push(local);
    out.set(vendor, list);
  }
  return out;
}

/**
 * Every spelling worth testing for one payee.
 *
 * @param {string} name    the payee as stored (a bank payee_guess or a ledger vendor)
 * @param {object} opts    `emails`: any addresses known for this payee
 * @returns {string[]}     unique, non-empty; always includes `name` itself
 */
function spellingsOf(name, { emails = [] } = {}) {
  const out = [];
  const push = (v) => { const s = String(v || '').trim(); if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s); };
  push(name);
  for (const e of [].concat(emails)) push(emailLocal(e));
  for (const p of pinyinSpellings(name)) push(p);
  return out;
}

module.exports = { spellingsOf, pinyinSpellings, emailLocal, buildEmailIndex, MIN_HANDLE, HAN, HAN_PINYIN };
