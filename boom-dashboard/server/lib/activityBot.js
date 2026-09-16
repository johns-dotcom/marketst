/**
 * Activity bot — the app's own events, posted into #activity.
 *
 * This is the part a generic Slack cannot do: things that happen across the
 * dashboard (a vendor submission needs approval, an invoice is approved, a deal
 * is signed) show up as a live feed, each one deep-linked to the record it is
 * about.
 *
 * ── The contract with callers ──
 * postEvent() is best-effort and self-contained. Callers fire it AFTER their own
 * write commits and never await it:
 *
 *     postEvent({ text: `…`, icon: 'check', link: `/bk/ledger?entry=${id}` });
 *
 * Every failure inside is caught and logged here, so a caller cannot make its
 * own action fail by forgetting a .catch(). Approving an invoice must not 500
 * because a chat table is missing — and on a database that has not run the chat
 * migrations yet, it otherwise would.
 *
 * ── Message shape ──
 * A bot message is a normal chat_messages row with user_id = NULL (which is why
 * that column is nullable — there is no fake "Market Street Bot" user to keep in sync
 * with the roster), is_system = true, and meta = { icon, link }.
 */
const pool = require('../db');
const rt = require('./realtime');

const TOPIC = 'What the app is doing — approvals, releases, deals';

/**
 * Find-or-create #activity and make sure every real user is in it.
 *
 * ONE definition of "where is #activity" — routes/chat.js imports this rather
 * than running its own `lower(name) = 'activity'` lookup. Two find-or-creates
 * against the same predicate is how you end up with two #activity channels, one
 * of which nobody is reading.
 *
 * The membership backfill runs every time, not just on create: that is how a
 * teammate hired after the channel existed ends up in it. Test accounts are
 * excluded for the same reason they are blocked everywhere else in chat.
 */
async function ensureActivityChannel() {
  let { rows } = await pool.query(
    `SELECT id FROM chat_channels WHERE type = 'channel' AND lower(name) = 'activity' LIMIT 1`
  );
  if (!rows.length) {
    ({ rows } = await pool.query(
      `INSERT INTO chat_channels (name, topic, type, is_private)
       VALUES ('activity', $1, 'channel', FALSE) RETURNING id`,
      [TOPIC]
    ));
  }
  const channelId = rows[0].id;
  await pool.query(
    `INSERT INTO chat_members (channel_id, user_id, last_read_at)
     SELECT $1, u.id, NOW() FROM users u
      WHERE (u.is_test = FALSE OR u.is_test IS NULL)
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [channelId]
  );
  return channelId;
}

/**
 * Post one system message to #activity.
 *
 * @param {object}  event
 * @param {string}  event.text  what happened. `*asterisks*` render bold.
 * @param {string}  event.icon  a short name the client maps to a glyph
 * @param {string}  event.link  in-app path, e.g. '/bk/approvals' — becomes "View →"
 */
async function postEvent({ text, icon, link } = {}) {
  try {
    if (!text) return;
    const channelId = await ensureActivityChannel();
    const body = String(text).slice(0, 2000);
    const meta = { icon: icon || 'zap', link: link || null };

    const { rows } = await pool.query(
      `INSERT INTO chat_messages (channel_id, user_id, body, is_system, meta)
       VALUES ($1, NULL, $2, TRUE, $3::jsonb) RETURNING id, created_at`,
      [channelId, body, JSON.stringify(meta)]
    );

    // Shaped to match routes/chat.js's MSG_SELECT exactly, so a message that
    // arrives over the socket renders identically to one loaded from the API.
    // A missing key here (reactions, attachments) is a client crash on a live
    // event that never reproduces on reload.
    rt.emitToChannel(channelId, 'message:new', {
      id: rows[0].id,
      channel_id: channelId,
      user_id: null,
      body,
      thread_root_id: null,
      is_system: true,
      meta,
      edited_at: null,
      created_at: rows[0].created_at,
      author_name: null,
      reply_count: 0,
      reactions: [],
      attachments: [],
    });
  } catch (e) {
    // Swallowed BY DESIGN, logged so it is never silent. The caller's write has
    // already committed; the only thing that can be lost here is a chat line.
    console.error('[activityBot] postEvent failed:', e.message);
  }
}

/**
 * A calendar date, formatted for an event line. Two traps, both hit while
 * writing this file.
 *
 * 1. node-pg hands back a DATE column as a JS `Date`, so the obvious
 *    `String(d).slice(0, 10)` yields "Tue Dec 01" — a weekday and a day, no
 *    year, and not a date at all.
 *
 * 2. A 'YYYY-MM-DD' STRING is parsed by `new Date()` as UTC midnight, while a
 *    Date from pg is LOCAL midnight. Formatting both the same way makes the
 *    string render one day early everywhere west of UTC: '2026-12-01' printed
 *    as "Nov 30, 2026" on this machine.
 *
 * So the two inputs are read separately and both end up as the calendar date
 * that was written down — one value, one timezone, no drift.
 *
 * Lives here rather than at the one call site because every future event that
 * prints a date walks into exactly these two.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(value) {
  if (!value) return '';
  let y, m, day;
  const iso = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    // Read the digits that were written. No parsing, so no zone to get wrong.
    [, y, m, day] = iso.map(Number);
  } else {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    // LOCAL components: a pg DATE arrives as local midnight, so getUTCDate()
    // would shift it back a day for a process west of UTC.
    y = d.getFullYear(); m = d.getMonth() + 1; day = d.getDate();
  }
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

module.exports = { postEvent, ensureActivityChannel, fmtDate };
