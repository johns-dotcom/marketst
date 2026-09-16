/**
 * /api/chat — the team message board.
 *
 * Reads and writes chat_channels / chat_members / chat_messages / chat_reactions
 * (created in runMigrations()). Mentions do NOT get a table here: they go into
 * the existing `user_mentions`, the same store the notification bell already
 * reads, with room = 'chat:<channelId>'. Two mention stores would mean the bell
 * shows half the mentions and "mark all read" leaves some unread.
 *
 * ── The gate is MEMBERSHIP, not role ──
 * There is no requirePagePermission here and there shouldn't be: /messages is
 * on the BASE_WHITELIST, so every role can open the page. What bounds you is
 * which channels you are a member of. `membership()` below is that gate, and
 * every read and every mutation goes through it — including /search, which
 * JOINs chat_members so it can't surface a line from a private channel you
 * aren't in.
 *
 * ── Mutations are REST-only ──
 * Sockets carry presence and typing. Everything that writes comes through here,
 * where auth and validation live once, and the handler then calls lib/realtime
 * to fan the change out. See lib/realtime.js.
 *
 * This app is single-tenant. The reference implementation this was ported from
 * scopes every query by `label_id`; that column does not exist in this repo and
 * find-and-replacing it away is the fastest route to broken SQL.
 */
const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const rt = require('../lib/realtime');
const { sendChatMentionEmail } = require('../services/email');
const multer = require('multer');
const { secureFileFilter } = require('../middleware/secureUpload');
const { sniffMime } = require('../lib/sniffMime');
const r2 = require('../lib/r2');
const { ensureActivityChannel } = require('../lib/activityBot');

const router = express.Router();

// authMiddleware also runs testUserGuard, which 403s every /api/* call from a
// `users.is_test` account with { test_mode: true }. /api/chat is deliberately
// NOT on that allowlist — a demo account must not see internal staff
// conversation. The Messages page renders a demo panel for that case.
router.use(authMiddleware);

const BODY_MAX = 8000;
const MENTION_ALL = /@(channel|here|everyone)\b/i;

// ── attachments ─────────────────────────────────────────────────────────────
// memoryStorage because the bytes go straight to R2 or to a base64 column —
// nothing here ever wants a temp file on a Railway dyno's ephemeral disk.
// secureFileFilter is the SAME allowlist every other upload in this app uses;
// chat must not be the one path that accepts a .html or a .jar.
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;   // per file
const ATTACH_MAX_FILES = 10;
// When R2 is off the bytes live in Postgres, so the ceiling is much lower —
// a 25 MB base64 blob is ~34 MB of TEXT in a row every message read would
// otherwise have to be careful not to select.
const INLINE_MAX_BYTES = 2 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACH_MAX_BYTES, files: ATTACH_MAX_FILES },
  fileFilter: secureFileFilter,
});

// Types a browser can render without being able to execute anything. Anything
// else is served as a download, never inline — the stored mime came from an
// upload, and this mirrors what index.js already does for /uploads.
const INLINE_SAFE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp))$/i;
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

// Anti email-bomb throttle: recipientId -> ms of the last mention email.
//
// One @channel in a busy room is N emails, and a back-and-forth that keeps
// naming someone is N more. The in-app bell still fires every single time —
// this rate-limits only the MAIL, which is the part that gets a domain filtered.
// In-process, therefore per-dyno: the right trade for a courtesy notification
// whose worst-case failure is one extra email.
const MENTION_EMAIL_WINDOW_MS = 5 * 60 * 1000;
const mentionEmailAt = new Map();

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The caller's membership row for a channel, joined to the channel itself, or
 * null. ONE gate, used by every route below.
 *
 * Returns the row rather than a bare boolean so the send path can label a
 * mention ('#general' vs a DM peer's name) without a second round trip — the
 * gate semantics are identical, `if (!mem) return 403`.
 */
async function membership(channelId, userId) {
  const { rows } = await pool.query(
    `SELECT m.channel_id, m.last_read_at, m.muted,
            c.type, c.name, c.is_private, c.entity_type, c.entity_id
       FROM chat_members m
       JOIN chat_channels c ON c.id = m.channel_id
      WHERE m.channel_id = $1 AND m.user_id = $2`,
    [channelId, userId]
  );
  return rows[0] || null;
}

/**
 * A positive integer from a route param or query value, or null.
 *
 * parseInt('abc') is NaN, and a NaN bound to `WHERE id = $1` raises 22P02 in
 * Postgres — so an obviously-bad request turns into a 500 instead of a 400.
 * The routes also carry a (\d+) constraint; this is the second half of that.
 */
function intOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Message shape: author, reaction rollup, thread reply count. No attachments —
// those arrive in phase 3.
const MSG_SELECT = `
  SELECT m.id, m.channel_id, m.user_id, m.body, m.thread_root_id,
         m.is_system, m.meta, m.edited_at, m.created_at,
         u.name AS author_name,
         (SELECT COUNT(*)::int FROM chat_messages r
           WHERE r.thread_root_id = m.id AND r.deleted = FALSE) AS reply_count,
         COALESCE((
           SELECT json_agg(json_build_object('emoji', e.emoji, 'count', e.cnt, 'users', e.users))
             FROM (SELECT emoji, COUNT(*)::int AS cnt, json_agg(user_id) AS users
                     FROM chat_reactions WHERE message_id = m.id GROUP BY emoji) e
         ), '[]'::json) AS reactions,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', at.id, 'filename', at.filename, 'mime', at.mime,
                    'size_bytes', at.size_bytes,
                    'stored', CASE WHEN at.r2_key IS NOT NULL THEN 'r2' ELSE 'inline' END,
                    -- Selected only so signAttachments() can presign without a
                    -- query per attachment. STRIPPED there — it must never
                    -- reach a client.
                    'r2_key', at.r2_key
                  ) ORDER BY at.id)
             FROM chat_attachments at WHERE at.message_id = m.id
         ), '[]'::json) AS attachments
    FROM chat_messages m
    LEFT JOIN users u ON u.id = m.user_id`;

/**
 * Attach a short-lived signed R2 URL to each attachment that has one.
 *
 * An <img src> cannot carry an Authorization header, and this repo's
 * authMiddleware does accept ?token= — which is exactly the trap. A session
 * token in an image URL leaks into Referer headers, browser history, and any
 * proxy log on the way. A presigned R2 URL is scoped to ONE object and expires;
 * a session token is scoped to the whole account and lasts eight hours.
 *
 * Membership was already enforced to read the message, so minting the
 * capability here is safe. Inline-stored files get no URL — the client fetches
 * those through the authenticated endpoint below and makes a blob URL.
 */
async function signAttachments(msg) {
  if (!msg || !Array.isArray(msg.attachments) || !msg.attachments.length) return msg;
  const configured = r2.isConfigured();
  msg.attachments = await Promise.all(msg.attachments.map(async (raw) => {
    // r2_key rides along on the aggregate purely so this can presign without a
    // round trip per attachment. Destructured OFF here so it cannot be returned
    // by any caller: an object key is not a secret on its own, but it is not the
    // client's business and it is the one input a presigned URL is built from.
    const { r2_key: key, ...a } = raw;
    if (!configured || !key) return a;
    const url = await r2.getSignedFileUrl(key, 6 * 3600).catch(() => null);
    return url ? { ...a, url } : a;
  }));
  return msg;
}

async function fetchMessage(id) {
  const { rows } = await pool.query(`${MSG_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? signAttachments(rows[0]) : null;
}

// The unread expression, written once.
//
// COALESCE(last_read_at, joined_at) matters: last_read_at is NULL until the
// first read, and `created_at > NULL` is NULL, not TRUE — so a brand-new member
// would show ZERO unread forever instead of everything-since-joining. Falling
// back to joined_at also means joining #general doesn't dump years of backlog
// into the badge.
//
// Own messages don't count (you wrote them), thread replies don't count toward
// the channel badge (they live behind the thread drawer), and `user_id IS NULL`
// — the activity bot — does count.
const UNREAD_EXPR = `
  (SELECT COUNT(*)::int FROM chat_messages msg
    WHERE msg.channel_id = m.channel_id
      AND msg.deleted = FALSE
      AND msg.thread_root_id IS NULL
      AND msg.created_at > COALESCE(m.last_read_at, m.joined_at)
      AND (msg.user_id <> $1 OR msg.user_id IS NULL))`;

/**
 * Find-or-create a seeded channel by name and make sure the caller is in it.
 *
 * Find-or-create on lower(name), never insert-when-empty: a workspace that
 * deletes #general has to get it back. This runs on every GET /channels, which
 * is also how a teammate hired after the migration ran ends up in both rooms.
 */
async function ensureSeedChannel(name, topic, userId) {
  let { rows } = await pool.query(
    `SELECT id FROM chat_channels WHERE type = 'channel' AND lower(name) = $1 LIMIT 1`,
    [name]
  );
  if (!rows.length) {
    ({ rows } = await pool.query(
      `INSERT INTO chat_channels (name, topic, type, is_private, created_by)
       VALUES ($1, $2, 'channel', FALSE, $3) RETURNING id`,
      [name, topic, userId]
    ));
  }
  const channelId = rows[0].id;
  await pool.query(
    `INSERT INTO chat_members (channel_id, user_id, last_read_at)
     VALUES ($1, $2, NOW()) ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [channelId, userId]
  );
  return channelId;
}

/**
 * Persist @mentions into `user_mentions` — the SAME table the bell reads, with
 * the same column meanings the campaign chat writes (routes/artist-campaigns.js).
 *
 *   room       'chat:<channelId>'
 *   room_title '#general', or the DM peer's name
 *   room_path  '/messages/<channelId>'
 *
 * Names are resolved against the live roster rather than trusting a client-sent
 * id list: this is the server's own parse of the body it just stored, so the
 * row in the bell can never disagree with the text on screen.
 *
 * Returns the set of notified user ids. Never notifies the sender.
 */
async function recordMentions({ channelId, messageId, roomTitle, body, actor }) {
  const notify = new Set();
  if (!body) return notify;

  const { rows: roster } = await pool.query(
    `SELECT id, name FROM users
      WHERE (is_test = FALSE OR is_test IS NULL) AND name IS NOT NULL AND name <> ''`
  );
  const lower = body.toLowerCase();
  // Longest name first, so "@Chase Bank" is not consumed by a user called
  // "Chase" sitting earlier in the roster.
  for (const u of [...roster].sort((a, b) => b.name.length - a.name.length)) {
    if (u.id === actor.id) continue;
    if (lower.includes('@' + u.name.toLowerCase())) notify.add(u.id);
  }

  // @channel / @here / @everyone reach every member of the channel.
  if (MENTION_ALL.test(body)) {
    const { rows } = await pool.query(
      `SELECT user_id FROM chat_members WHERE channel_id = $1 AND user_id <> $2`,
      [channelId, actor.id]
    );
    for (const r of rows) notify.add(r.user_id);
  }
  if (!notify.size) return notify;

  const room = `chat:${channelId}`;
  const roomPath = `/messages/${channelId}`;
  const snippet = body.slice(0, 140);
  for (const uid of notify) {
    await pool.query(`
      INSERT INTO user_mentions (user_id, actor_name, room, room_title, room_path, message_id, snippet)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [uid, actor.name, room, roomTitle, roomPath, messageId, snippet])
      .catch(err => console.error('chat mention insert failed:', err.message));
  }
  return notify;
}

/**
 * Email the mentioned people who are NOT currently connected.
 *
 * Someone with the app open already got the live `mention` event and the bell;
 * mailing them as well is how a chat feature becomes the reason people filter
 * your domain. `rt.onlineUsers()` is the socket layer's presence map, so
 * "offline" here means "has no live socket", not "logged out".
 *
 * Entirely best-effort: failures are logged and swallowed, and the whole thing
 * no-ops when no mail provider is configured. The message is already stored and
 * the bell already has the mention before this runs.
 */
async function emailOfflineMentions({ notified, channelLabel: label, body, actor, channelId }) {
  const ids = [...notified];
  if (!ids.length) return 0;

  const onlineSet = new Set((rt.onlineUsers() || []).map(Number));
  const offline = ids.filter(id => !onlineSet.has(Number(id)));
  if (!offline.length) return 0;

  const { rows } = await pool.query(
    `SELECT id, name, email FROM users
      WHERE id = ANY($1::int[]) AND email IS NOT NULL AND email <> ''`,
    [offline]
  );

  const origin = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
  const link = `${origin}/messages/${channelId}`;
  const snippet = body.slice(0, 280);
  const nowMs = Date.now();
  let sent = 0;

  for (const r of rows) {
    if (nowMs - (mentionEmailAt.get(r.id) || 0) < MENTION_EMAIL_WINDOW_MS) continue;
    mentionEmailAt.set(r.id, nowMs);
    const ok = await sendChatMentionEmail({
      recipientName: r.name,
      recipientEmail: r.email,
      actorName: actor.name,
      channelLabel: label,
      snippet,
      link,
    }).catch((e) => {
      // Logged, never silently discarded. A best-effort path that swallows its
      // own reason is how a notification stops working for weeks while every
      // request keeps returning 200.
      console.error(`[chat] mention email to ${r.email} failed:`, e.message);
      return false;
    });
    if (ok) sent += 1;
  }
  // Unbounded growth is a slow leak in a long-lived process. The window is five
  // minutes, so dropping the map costs at most one extra email per recipient.
  if (mentionEmailAt.size > 5000) mentionEmailAt.clear();
  return sent;
}

/**
 * Persist one uploaded file for a message — R2 when configured, base64 in the
 * database when it is not.
 *
 * The MIME stored is the SNIFFED one, not the browser-supplied one. multer's
 * `file.mimetype` is whatever the client claimed; this repo already sniffs
 * magic bytes everywhere else it takes an upload, and chat is not going to be
 * the one path that lets a .exe through by calling itself an image/png.
 * A file whose bytes match no recognised format is rejected rather than stored
 * as octet-stream — that is the entire point of sniffing.
 *
 * Returns { ok: true } or { ok: false, error } with a message fit to show a user.
 */
async function storeAttachment(messageId, file) {
  const sniffed = sniffMime(file.buffer);
  if (!sniffed) {
    return { ok: false, error: `"${file.originalname}" isn't a file type we can accept` };
  }
  // The sniff is authoritative, but it must ALSO be on the allowlist: sniffMime
  // recognises formats (bmp) the upload allowlist doesn't, and the narrower
  // list wins.
  if (!INLINE_SAFE.test(sniffed)) {
    return { ok: false, error: `"${file.originalname}" is a ${sniffed}, which isn't allowed here` };
  }

  const safeName = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
  let r2Key = null;
  let inlineData = null;

  if (r2.isConfigured()) {
    try {
      const key = `entity_files/chat_attachment/${messageId}/${Date.now()}-${safeName}`;
      await r2.uploadFile(key, file.buffer, sniffed);
      r2Key = key;
    } catch (e) {
      // Fall through to inline rather than lose the file — R2 being briefly
      // unreachable should not drop an attachment someone just sent.
      console.error('[chat] R2 upload failed, falling back to inline:', e.message);
    }
  }
  if (!r2Key) {
    if (file.buffer.length > INLINE_MAX_BYTES) {
      return {
        ok: false,
        error: `"${file.originalname}" is too large to send while object storage is unconfigured (limit ${Math.floor(INLINE_MAX_BYTES / (1024 * 1024))} MB)`,
      };
    }
    inlineData = file.buffer.toString('base64');
  }

  await pool.query(
    `INSERT INTO chat_attachments (message_id, filename, mime, size_bytes, r2_key, inline_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [messageId, String(file.originalname || 'file').slice(0, 255), sniffed, file.buffer.length, r2Key, inlineData]
  );
  return { ok: true };
}

/**
 * A channel's label for a mention's `room_title`.
 *
 * The bell renders this as "<actor> mentioned you in <room_title>", so the
 * string is read by the RECIPIENT, not written for the sender. A DM therefore
 * cannot be labelled with "the other participant": computed from the sender's
 * side that resolves to the recipient's OWN name, and the bell reads
 * "John mentioned you in A&R Intern". Perspective-independent wording is the
 * only thing that is correct for every reader of the same row.
 */
function channelLabel(mem) {
  if (mem.type === 'dm') return 'a direct message';
  if (mem.type === 'object') return mem.name || 'a thread';
  return mem.name ? `#${mem.name}` : 'a channel';
}

// ── channels ────────────────────────────────────────────────────────────────

// GET /api/chat/channels — every channel + DM the caller belongs to, with
// unread counts, a last-message preview, and (for DMs) the peer.
router.get('/channels', async (req, res) => {
  try {
    const uid = req.user.id;

    // Bootstrap the two seeded rooms. Non-fatal: a failure here must not take
    // the whole sidebar out.
    //
    // #activity is found-or-created by lib/activityBot.js, NOT by a second
    // lower(name) = 'activity' lookup here. The bot has to be able to create it
    // from a background write with no user in scope, so it owns the definition;
    // two find-or-creates against the same predicate is how a workspace ends up
    // with two #activity channels and nobody reading one of them.
    try {
      await ensureSeedChannel('general', 'Company-wide chatter', uid);
      const activityId = await ensureActivityChannel();
      await pool.query(
        `INSERT INTO chat_members (channel_id, user_id, last_read_at)
         VALUES ($1, $2, NOW()) ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [activityId, uid]
      );
    } catch (e) { console.error('chat seed channels:', e.message); }

    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.topic, c.type, c.is_private, c.entity_type, c.entity_id,
             c.created_by, c.created_at,
             m.last_read_at, m.muted,
             ${UNREAD_EXPR} AS unread,
             (SELECT json_build_object(
                       'body', x.body, 'created_at', x.created_at,
                       'author_name', u2.name, 'is_system', x.is_system)
                FROM chat_messages x LEFT JOIN users u2 ON u2.id = x.user_id
               WHERE x.channel_id = c.id AND x.thread_root_id IS NULL AND x.deleted = FALSE
               ORDER BY x.id DESC LIMIT 1) AS last_message
        FROM chat_members m
        JOIN chat_channels c ON c.id = m.channel_id
       WHERE m.user_id = $1
    `, [uid]);

    // Participants — needed to label a DM and to show who's in a channel.
    const ids = rows.map(r => r.id);
    const membersByChannel = {};
    if (ids.length) {
      const { rows: mem } = await pool.query(
        `SELECT cm.channel_id, cm.user_id, u.name, u.email
           FROM chat_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.channel_id = ANY($1::int[])`,
        [ids]
      );
      for (const r of mem) {
        (membersByChannel[r.channel_id] ||= []).push({ id: r.user_id, name: r.name, email: r.email });
      }
    }

    const data = rows.map(c => {
      const members = membersByChannel[c.id] || [];
      const peers = members.filter(m => m.id !== uid);
      return {
        ...c,
        members,
        display_name: c.type === 'dm' ? (peers.map(p => p.name).join(', ') || 'You') : c.name,
        peer: c.type === 'dm' ? (peers[0] || null) : null,
      };
    });

    // Most recently active first.
    data.sort((a, b) => {
      const ta = new Date(a.last_message?.created_at || a.created_at).getTime();
      const tb = new Date(b.last_message?.created_at || b.created_at).getTime();
      return tb - ta;
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/chat/channels:', err);
    res.status(500).json({ success: false, error: 'Could not load channels' });
  }
});

// GET /api/chat/channels/public — joinable public channels the caller isn't in.
router.get('/channels/public', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.topic,
             (SELECT COUNT(*)::int FROM chat_members m2 WHERE m2.channel_id = c.id) AS member_count
        FROM chat_channels c
       WHERE c.type = 'channel' AND c.is_private = FALSE
         AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $1)
       ORDER BY c.name
    `, [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/chat/channels/public:', err);
    res.status(500).json({ success: false, error: 'Could not load channels' });
  }
});

// POST /api/chat/channels — { name, topic, is_private, member_ids }
router.post('/channels', async (req, res) => {
  const name = String(req.body?.name || '')
    .trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase()
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 80);
  if (!name) return res.status(400).json({ success: false, error: 'Channel name required (letters, numbers and dashes)' });
  const topic = String(req.body?.topic || '').trim().slice(0, 500) || null;
  const isPrivate = !!req.body?.is_private;
  const invited = (Array.isArray(req.body?.member_ids) ? req.body.member_ids : [])
    .map(Number).filter(Number.isInteger);

  // ONE release, in ONE finally, and nowhere else. An early release inside the
  // handler makes the finally throw from OUTSIDE the try — the catch never sees
  // it and the process exits, taking the server down for everyone.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO chat_channels (name, topic, type, is_private, created_by)
       VALUES ($1, $2, 'channel', $3, $4) RETURNING *`,
      [name, topic, isPrivate, req.user.id]
    );
    const channel = rows[0];

    // Creator always joins. Invited ids are validated against real, non-test
    // users rather than trusted off the request.
    const memberIds = new Set([req.user.id]);
    if (invited.length) {
      const { rows: valid } = await client.query(
        `SELECT id FROM users WHERE id = ANY($1::int[]) AND (is_test = FALSE OR is_test IS NULL)`,
        [invited]
      );
      valid.forEach(r => memberIds.add(r.id));
    }
    for (const memberId of memberIds) {
      await client.query(
        `INSERT INTO chat_members (channel_id, user_id, last_read_at)
         VALUES ($1, $2, NOW()) ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channel.id, memberId]
      );
    }
    await client.query('COMMIT');

    const ids = [...memberIds];
    rt.addUsersToChannelRoom(channel.id, ids);
    ids.forEach(id => rt.emitToUser(id, 'channel:new', { id: channel.id }));
    res.json({ success: true, data: { ...channel, display_name: channel.name, members: [], unread: 0 } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/chat/channels:', err);
    res.status(500).json({ success: false, error: 'Could not create channel' });
  } finally {
    client.release();
  }
});

// POST /api/chat/channels/:id/join — public channels only.
router.post('/channels/:id(\\d+)/join', async (req, res) => {
  const channelId = intOrNull(req.params.id);
  if (!channelId) return res.status(400).json({ success: false, error: 'Invalid channel' });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM chat_channels WHERE id = $1 AND type = 'channel' AND is_private = FALSE`,
      [channelId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Channel not found' });
    await pool.query(
      `INSERT INTO chat_members (channel_id, user_id, last_read_at)
       VALUES ($1, $2, NOW()) ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [channelId, req.user.id]
    );
    rt.addUsersToChannelRoom(channelId, [req.user.id]);
    res.json({ success: true, data: { id: channelId } });
  } catch (err) {
    console.error('POST /api/chat/channels/:id/join:', err);
    res.status(500).json({ success: false, error: 'Could not join channel' });
  }
});

// POST /api/chat/dm — { user_id }, find-or-create a 1:1 DM.
//
// ── The route that took a server down ──
// In the reference app this handler acquired a pool client, and the
// already-exists path released it AND fell through to a `finally` that released
// it again. pg-pool throws on the second release, from inside the finally,
// which is outside the try — so the catch never ran and the Node process
// exited. The reachable trigger was "open a DM with anyone you've DM'd before",
// i.e. constantly.
//
// Here the lookup runs on the POOL, with no client at all, and returns before
// one is ever acquired. The client exists only on the create path, and exactly
// one `finally` releases it.
router.post('/dm', async (req, res) => {
  const target = intOrNull(req.body?.user_id);
  if (!target || target === req.user.id) {
    return res.status(400).json({ success: false, error: 'Pick someone else to message' });
  }
  try {
    const { rows: who } = await pool.query(
      `SELECT id, name FROM users WHERE id = $1 AND (is_test = FALSE OR is_test IS NULL)`,
      [target]
    );
    if (!who.length) return res.status(404).json({ success: false, error: 'User not found' });

    // An existing DM = a 'dm' channel whose member set is exactly the two of us.
    const existing = await pool.query(`
      SELECT c.id FROM chat_channels c
       WHERE c.type = 'dm'
         AND (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id) = 2
         AND EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $1)
         AND EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $2)
       LIMIT 1
    `, [req.user.id, target]);
    if (existing.rows.length) {
      return res.json({ success: true, data: { id: existing.rows[0].id } });
    }
  } catch (err) {
    console.error('POST /api/chat/dm lookup:', err);
    return res.status(500).json({ success: false, error: 'Could not open conversation' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize both directions of the same pair, so two people pressing
    // "message" at the same instant get one DM instead of two. Transaction-
    // scoped: released by COMMIT/ROLLBACK, never by hand.
    const [lo, hi] = [req.user.id, target].sort((a, b) => a - b);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lo, hi]);

    // Re-check inside the lock — the other request may have won the race
    // between our pool lookup above and this transaction.
    const again = await client.query(`
      SELECT c.id FROM chat_channels c
       WHERE c.type = 'dm'
         AND (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id) = 2
         AND EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $1)
         AND EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $2)
       LIMIT 1
    `, [req.user.id, target]);

    let channelId;
    if (again.rows.length) {
      channelId = again.rows[0].id;
      await client.query('COMMIT');
    } else {
      const { rows } = await client.query(
        `INSERT INTO chat_channels (type, created_by) VALUES ('dm', $1) RETURNING id`,
        [req.user.id]
      );
      channelId = rows[0].id;
      for (const uid of [req.user.id, target]) {
        await client.query(
          `INSERT INTO chat_members (channel_id, user_id, last_read_at)
           VALUES ($1, $2, NOW()) ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channelId, uid]
        );
      }
      await client.query('COMMIT');
      rt.addUsersToChannelRoom(channelId, [req.user.id, target]);
      [req.user.id, target].forEach(uid => rt.emitToUser(uid, 'channel:new', { id: channelId }));
    }
    res.json({ success: true, data: { id: channelId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/chat/dm:', err);
    res.status(500).json({ success: false, error: 'Could not open conversation' });
  } finally {
    client.release();
  }
});

// POST /api/chat/channels/:id/read — advance the read watermark.
router.post('/channels/:id(\\d+)/read', async (req, res) => {
  const channelId = intOrNull(req.params.id);
  if (!channelId) return res.status(400).json({ success: false, error: 'Invalid channel' });
  try {
    await pool.query(
      `UPDATE chat_members SET last_read_at = NOW() WHERE channel_id = $1 AND user_id = $2`,
      [channelId, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/chat/channels/:id/read:', err);
    res.status(500).json({ success: false, error: 'Could not mark read' });
  }
});

// POST /api/chat/channels/:id/mute — toggle. Muted channels are excluded from
// the nav badge (GET /unread), which is what keeps #activity from owning it.
router.post('/channels/:id(\\d+)/mute', async (req, res) => {
  const channelId = intOrNull(req.params.id);
  if (!channelId) return res.status(400).json({ success: false, error: 'Invalid channel' });
  try {
    const { rows } = await pool.query(
      `UPDATE chat_members SET muted = NOT COALESCE(muted, FALSE)
        WHERE channel_id = $1 AND user_id = $2 RETURNING muted`,
      [channelId, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ success: false, error: 'Not a member of this channel' });
    res.json({ success: true, data: { muted: rows[0].muted } });
  } catch (err) {
    console.error('POST /api/chat/channels/:id/mute:', err);
    res.status(500).json({ success: false, error: 'Could not update channel' });
  }
});

// ── messages ────────────────────────────────────────────────────────────────

// GET /api/chat/channels/:id/messages?before=<id>&limit=50&thread=<rootId>
// Newest-last. Thread replies are excluded from the main pane; ?thread returns
// one thread's replies instead.
router.get('/channels/:id(\\d+)/messages', async (req, res) => {
  const channelId = intOrNull(req.params.id);
  if (!channelId) return res.status(400).json({ success: false, error: 'Invalid channel' });
  try {
    const mem = await membership(channelId, req.user.id);
    if (!mem) return res.status(403).json({ success: false, error: 'Not a member of this channel' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = intOrNull(req.query.before);
    const thread = intOrNull(req.query.thread);

    const params = [channelId];
    let where = 'm.channel_id = $1 AND m.deleted = FALSE';
    if (thread) { params.push(thread); where += ` AND m.thread_root_id = $${params.length}`; }
    else { where += ' AND m.thread_root_id IS NULL'; }
    if (before) { params.push(before); where += ` AND m.id < $${params.length}`; }
    params.push(limit);

    const { rows } = await pool.query(
      `${MSG_SELECT} WHERE ${where} ORDER BY m.id DESC LIMIT $${params.length}`,
      params
    );
    // Sign EVERY row, not just the ones that come back from fetchMessage().
    // Missing this is invisible in a live session — the socket payload is
    // signed, so a message that arrives while you're watching renders fine —
    // and then every image is broken the moment anyone reloads the page.
    const signed = await Promise.all(rows.reverse().map(signAttachments));
    // `has_more` so the client knows whether to offer "load earlier".
    res.json({ success: true, data: signed, has_more: rows.length === limit });
  } catch (err) {
    console.error('GET /api/chat/channels/:id/messages:', err);
    res.status(500).json({ success: false, error: 'Could not load messages' });
  }
});

// POST /api/chat/channels/:id/messages — { body, thread_root_id }
router.post('/channels/:id(\\d+)/messages', upload.array('files', ATTACH_MAX_FILES), async (req, res) => {
  const channelId = intOrNull(req.params.id);
  if (!channelId) return res.status(400).json({ success: false, error: 'Invalid channel' });
  try {
    const mem = await membership(channelId, req.user.id);
    if (!mem) return res.status(403).json({ success: false, error: 'Not a member of this channel' });

    // multer populates req.body for multipart too, so a text-only JSON send and
    // a multipart send read identically from here down.
    const body = String(req.body?.body || '').trim();
    const files = req.files || [];
    // An attachment with no caption is a normal thing to send.
    if (!body && !files.length) return res.status(400).json({ success: false, error: 'Message is empty' });
    if (body.length > BODY_MAX) return res.status(400).json({ success: false, error: `Message is too long (max ${BODY_MAX} characters)` });

    // A reply's root must live in THIS channel — otherwise a crafted id could
    // graft a reply onto a thread in a channel the caller can't see.
    let root = intOrNull(req.body?.thread_root_id);
    if (root) {
      const { rows } = await pool.query(
        `SELECT id FROM chat_messages WHERE id = $1 AND channel_id = $2 AND deleted = FALSE`,
        [root, channelId]
      );
      if (!rows.length) root = null;
    }

    // INSERT ... SELECT ... WHERE EXISTS, so a channel deleted between the
    // membership check and this write comes back as a 404 rather than a
    // foreign-key violation rendered as a 500.
    //
    // $1 and $5 are the SAME value bound TWICE on purpose. Using one parameter
    // in both the SELECT list and `WHERE id = $1` makes Postgres deduce two
    // types for it and raise 42P08 "inconsistent types deduced for parameter";
    // a cast does not fix it, a second binding does.
    const ins = await pool.query(`
      INSERT INTO chat_messages (channel_id, user_id, body, thread_root_id)
      SELECT $1::int, $2::int, $3::text, $4::int
       WHERE EXISTS (SELECT 1 FROM chat_channels WHERE id = $5)
      RETURNING id
    `, [channelId, req.user.id, body, root, channelId]);
    if (!ins.rowCount) return res.status(404).json({ success: false, error: 'Channel no longer exists' });
    const messageId = ins.rows[0].id;

    // Stored AFTER the message row exists — the FK needs it. A file that cannot
    // be stored fails the whole send loudly and takes the row back out:
    // silently dropping one leaves the sender believing they shared something.
    for (const f of files) {
      const stored = await storeAttachment(messageId, f);
      if (!stored.ok) {
        await pool.query('DELETE FROM chat_messages WHERE id = $1', [messageId]).catch(() => {});
        return res.status(400).json({ success: false, error: stored.error });
      }
    }

    const msg = await fetchMessage(messageId);

    // Your own message must not make your own channel unread.
    await pool.query(
      `UPDATE chat_members SET last_read_at = NOW() WHERE channel_id = $1 AND user_id = $2`,
      [channelId, req.user.id]
    ).catch(() => {});

    rt.emitToChannel(channelId, 'message:new', msg);

    // Mentions are best-effort — a mention that fails to persist must not fail
    // the send. Logged, never swallowed silently: a route that returns 200
    // while writing nothing is invisible for weeks.
    try {
      const roomTitle = channelLabel(mem);
      const notified = await recordMentions({
        channelId, messageId, roomTitle, body,
        actor: { id: req.user.id, name: req.user.name },
      });
      // Push the bell immediately instead of making the mentioned user wait for
      // NotificationBell's 5-minute poll.
      notified.forEach(uid => rt.emitToUser(uid, 'mention', { channelId, messageId: msg.id }));

      // Fire-and-forget. Mail is slower than this request should be and the
      // send has already succeeded by here, so it is never awaited and can
      // never fail the response.
      emailOfflineMentions({
        notified, channelLabel: roomTitle, body, channelId,
        actor: { id: req.user.id, name: req.user.name },
      }).catch(e => console.error('chat mention email:', e.message));
    } catch (e) {
      console.error('chat mentions:', e.message);
    }

    res.json({ success: true, data: msg });
  } catch (err) {
    console.error('POST /api/chat/channels/:id/messages:', err);
    res.status(500).json({ success: false, error: 'Could not send message' });
  }
});

// PATCH /api/chat/messages/:id — author only.
router.patch('/messages/:id(\\d+)', async (req, res) => {
  const messageId = intOrNull(req.params.id);
  if (!messageId) return res.status(400).json({ success: false, error: 'Invalid message' });
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ success: false, error: 'Message is empty' });
    if (body.length > BODY_MAX) return res.status(400).json({ success: false, error: `Message is too long (max ${BODY_MAX} characters)` });

    const { rows } = await pool.query(
      `UPDATE chat_messages SET body = $1, edited_at = NOW()
        WHERE id = $2 AND user_id = $3 AND deleted = FALSE AND is_system = FALSE
        RETURNING channel_id`,
      [body, messageId, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ success: false, error: 'You can only edit your own messages' });

    const msg = await fetchMessage(messageId);
    rt.emitToChannel(rows[0].channel_id, 'message:update', msg);
    res.json({ success: true, data: msg });
  } catch (err) {
    console.error('PATCH /api/chat/messages/:id:', err);
    res.status(500).json({ success: false, error: 'Could not edit message' });
  }
});

// DELETE /api/chat/messages/:id — author, or Admin/Superadmin. SOFT delete,
// matching the convention campaign_chat_messages already set.
router.delete('/messages/:id(\\d+)', async (req, res) => {
  const messageId = intOrNull(req.params.id);
  if (!messageId) return res.status(400).json({ success: false, error: 'Invalid message' });
  try {
    // Branch in JS rather than binding a boolean into `($3 = TRUE OR user_id = $4)`.
    // Two SQL strings are cheaper to reason about than a parameter Postgres has
    // to type-deduce from a literal comparison.
    const isModerator = ['Admin', 'Superadmin'].includes(req.user?.role);
    const { rows } = await pool.query(
      isModerator
        ? `UPDATE chat_messages SET deleted = TRUE WHERE id = $1 AND deleted = FALSE RETURNING channel_id`
        : `UPDATE chat_messages SET deleted = TRUE WHERE id = $1 AND user_id = $2 AND deleted = FALSE RETURNING channel_id`,
      isModerator ? [messageId] : [messageId, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ success: false, error: 'You can only delete your own messages' });

    // Best-effort cleanup of the stored objects. The rows themselves stay put:
    // the message is SOFT-deleted (the repo's convention), so dropping the
    // attachment rows would make an undelete impossible. Only the R2 objects go,
    // because those cost money to keep and the message is not coming back
    // through any UI that exists today.
    const { rows: att } = await pool.query(
      'SELECT r2_key FROM chat_attachments WHERE message_id = $1 AND r2_key IS NOT NULL',
      [messageId]
    );
    for (const a of att) r2.deleteFile(a.r2_key).catch(e => console.error('[chat] attachment cleanup:', e.message));

    rt.emitToChannel(rows[0].channel_id, 'message:delete', { id: messageId, channel_id: rows[0].channel_id });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/chat/messages/:id:', err);
    res.status(500).json({ success: false, error: 'Could not delete message' });
  }
});

// POST /api/chat/messages/:id/react — { emoji }, toggles.
router.post('/messages/:id(\\d+)/react', async (req, res) => {
  const messageId = intOrNull(req.params.id);
  if (!messageId) return res.status(400).json({ success: false, error: 'Invalid message' });
  try {
    const emoji = String(req.body?.emoji || '').trim().slice(0, 16);
    if (!emoji) return res.status(400).json({ success: false, error: 'No emoji' });

    // The message has to be in a channel the caller belongs to — the same gate
    // as everything else, expressed as a join because we only have a message id.
    const { rows: found } = await pool.query(
      `SELECT msg.channel_id FROM chat_messages msg
         JOIN chat_members cm ON cm.channel_id = msg.channel_id AND cm.user_id = $2
        WHERE msg.id = $1 AND msg.deleted = FALSE`,
      [messageId, req.user.id]
    );
    if (!found.length) return res.status(403).json({ success: false, error: 'Not allowed' });
    const channelId = found[0].channel_id;

    const del = await pool.query(
      `DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, req.user.id, emoji]
    );
    if (!del.rowCount) {
      await pool.query(
        `INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [messageId, req.user.id, emoji]
      );
    }

    const msg = await fetchMessage(messageId);
    rt.emitToChannel(channelId, 'message:update', msg);
    res.json({ success: true, data: msg });
  } catch (err) {
    console.error('POST /api/chat/messages/:id/react:', err);
    res.status(500).json({ success: false, error: 'Could not react' });
  }
});

// ── attachments ─────────────────────────────────────────────────────────────

// GET /api/chat/attachments/:id — membership-gated download.
//
// Two ways an attachment reaches the browser, and the split is deliberate:
//
//   R2 configured  → the message payload already carries a short-lived PRESIGNED
//                    URL (see signAttachments). An <img src> uses that directly.
//                    Hitting this endpoint redirects to a freshly-signed one.
//   R2 unconfigured → the bytes live in the database, so they stream through
//                    HERE, behind the normal Authorization header.
//
// What it never does is accept a session token in the query string. authMiddleware
// would allow that — it is how /uploads works for plain <a href> links — but a
// JWT in an <img src> leaks into Referer headers, browser history and proxy logs,
// and it is scoped to the whole account for eight hours. A presigned URL is
// scoped to one object and expires.
router.get('/attachments/:id(\\d+)', async (req, res) => {
  const attachmentId = intOrNull(req.params.id);
  if (!attachmentId) return res.status(400).json({ success: false, error: 'Invalid attachment' });
  try {
    // The JOIN to chat_members for the caller IS the gate — same rule as
    // /search. Without it any authenticated user could walk the id space and
    // pull every file anyone has ever posted in a private channel.
    const { rows } = await pool.query(
      `SELECT a.r2_key, a.inline_data, a.mime, a.filename
         FROM chat_attachments a
         JOIN chat_messages m  ON m.id = a.message_id
         JOIN chat_members cm  ON cm.channel_id = m.channel_id AND cm.user_id = $2
        WHERE a.id = $1 AND m.deleted = FALSE`,
      [attachmentId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Attachment not found' });
    const a = rows[0];

    if (a.r2_key) {
      const url = await r2.getSignedFileUrl(a.r2_key, 6 * 3600).catch(() => null);
      if (url) return res.redirect(url);
    }
    const buf = await r2.loadFileBuffer(a.r2_key, a.inline_data);
    if (!buf) return res.status(404).json({ success: false, error: 'Attachment not found' });

    // Only render inline for types a browser can't execute script from;
    // everything else downloads. Mirrors the /uploads handler in index.js.
    const mime = a.mime || 'application/octet-stream';
    const inline = INLINE_SAFE.test(mime);
    const safeName = String(a.filename || 'file').replace(/[\r\n"\\]/g, '_');
    res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    console.error('GET /api/chat/attachments/:id:', err);
    res.status(500).json({ success: false, error: 'Could not load attachment' });
  }
});

// ── search, unread, roster ──────────────────────────────────────────────────

// GET /api/chat/search?q= — ILIKE, 40 newest, with channel context.
//
// The JOIN to chat_members FOR THE CALLER is the access control. Without it
// this endpoint is a hole straight through every private channel and DM in the
// company, and it looks completely normal in review.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    const { rows } = await pool.query(`
      SELECT m.id, m.channel_id, m.body, m.created_at, m.is_system,
             u.name AS author_name,
             c.type AS channel_type, c.name AS channel_name,
             (SELECT u2.name FROM chat_members cm2 JOIN users u2 ON u2.id = cm2.user_id
               WHERE cm2.channel_id = c.id AND cm2.user_id <> $1 LIMIT 1) AS dm_peer
        FROM chat_messages m
        JOIN chat_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
        JOIN chat_channels c ON c.id = m.channel_id
        LEFT JOIN users u ON u.id = m.user_id
       WHERE m.deleted = FALSE AND m.body ILIKE $2
       ORDER BY m.id DESC LIMIT 40
    `, [req.user.id, `%${q.replace(/[%_\\]/g, ch => '\\' + ch)}%`]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/chat/search:', err);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

// GET /api/chat/unread — { total } for the nav badge. Muted channels excluded.
router.get('/unread', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(t.unread), 0)::int AS total
        FROM (SELECT ${UNREAD_EXPR} AS unread
                FROM chat_members m
               WHERE m.user_id = $1 AND COALESCE(m.muted, FALSE) = FALSE) t
    `, [req.user.id]);
    res.json({ success: true, data: { total: rows[0]?.total || 0 } });
  } catch (err) {
    console.error('GET /api/chat/unread:', err);
    res.status(500).json({ success: false, error: 'Could not load unread count' });
  }
});

// GET /api/chat/users — roster for the DM picker and @-autocomplete.
// Test accounts are excluded: they can't connect a socket and can't call this
// API, so listing them would only offer a DM that can never be answered.
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role FROM users
        WHERE (is_test = FALSE OR is_test IS NULL) AND name IS NOT NULL AND name <> ''
        ORDER BY name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/chat/users:', err);
    res.status(500).json({ success: false, error: 'Could not load people' });
  }
});

/**
 * multer's own errors — size, count, and the allowlist rejection from
 * secureFileFilter — arrive here as thrown errors, NOT as a normal response.
 *
 * Without this they fall through to the app-level handler and surface as a
 * generic 500, so "your 30 MB file is too big" reads to the user as "the app is
 * broken". An error-handling middleware (four arguments) placed after the
 * routes is the only thing that can catch them.
 */
router.use((err, req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      error: `That file is too large — the limit is ${Math.floor(ATTACH_MAX_BYTES / (1024 * 1024))} MB per file.`,
    });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ success: false, error: `You can attach at most ${ATTACH_MAX_FILES} files to one message.` });
  }
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ success: false, error: 'Unexpected upload field.' });
  }
  // secureFileFilter rejects with a plain Error carrying a readable message.
  if (err && /not allowed/i.test(err.message || '')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  console.error('chat router error:', err);
  res.status(500).json({ success: false, error: 'Something went wrong' });
});

module.exports = router;
