# Build: team message board (Slack replacement)

Build instructions for the in-app team chat. Read this whole file before writing
code — several decisions below exist because the obvious approach is wrong for
*this* repo, and one of them (§1) will make you delete work if you find it late.

A working reference implementation of this exact feature exists in the sibling
app at `/Users/johnskead/Desktop/DevProjects/cadence` — `server/routes/chat.js`,
`server/lib/realtime.js`, `server/lib/activityBot.js`,
`client/src/pages/Messages.jsx`, `client/src/context/SocketContext.jsx`. Read
those when a detail here is ambiguous. **Do not copy them verbatim**: that app is
multi-tenant and every query there is scoped by `label_id`, a column this repo
does not have. Porting the scoping by find-and-replace is the single most likely
way to produce broken SQL.

---

## 0. What already exists here (read before designing anything)

This repo is **not** starting from zero on chat. It already has a room-based
message store, in production, on three pages:

| Thing | Where | What it is |
|---|---|---|
| `campaign_chat_messages` | `server/index.js` (~line 3019) | `room TEXT`, `user_id`, `body`, `mentions JSONB`, `edited_at`, `deleted`, `created_at`. Soft-delete. |
| `campaign_chat_reads` | `server/index.js`, just below | per-user last-read watermark per room |
| REST | `server/routes/artist-campaigns.js` (~line 655-770) | `GET/POST/PATCH/DELETE /api/artist-campaigns/chat/:room` |
| `CampaignChat.jsx` | `client/src/components/` | floating slide-over, 8s poll, @mention autocomplete |
| `RoomCommentThread.jsx` | `client/src/components/` | inline thread, same store, separate room namespace |
| Mounted on | `ArtistCampaigns.jsx`, `Recoupments.jsx`, `RecoupmentsPlanning.jsx` | |
| `user_mentions` | `server/index.js` (~line 3048) | `user_id, actor_name, room, room_title, room_path, message_id, snippet, read` — **already generic**, already feeds the bell |

**The bell already reads `user_mentions`** (`server/routes/notifications.js`
~line 333, and `POST /api/notifications/mentions/read`). The table's column names
were deliberately written generically "so future chat surfaces can reuse it."
This is that future surface. Use it.

---

## 1. Non-negotiable decisions

These are decided. Don't re-litigate them mid-build; if you think one is wrong,
stop and say so before writing code.

**1.1 — One mention store, not two.** Chat mentions write to the existing
`user_mentions` table with `room = 'chat:<channelId>'`,
`room_path = '/messages/<channelId>'`. Do **not** add a `chat_mentions` table.
Two stores means the bell shows half the mentions and "mark all read" leaves
some unread, which is exactly the drift `navConfig.jsx`'s header warns about.

**1.2 — One message store *eventually*, but not in phase 1.** The new
`chat_messages` table is for the workspace-wide message board.
`campaign_chat_messages` stays untouched through phases 1-4. Phase 5 migrates it.
Until phase 5 ships, the two stores coexist and that is accepted — what is
**not** accepted is adding a *third* room-comment component. If you need a thread
on a record before phase 5, use the existing `RoomCommentThread`.

**1.3 — Real websockets, not polling.** `CampaignChat.jsx`'s header comment says
*"no websocket infra in this app, and Railway makes short polling the pragmatic
choice."* That comment is about to become out of date — Railway supports
websockets fine. A message board that lags 8 seconds does not replace Slack.
Update that comment when you add the transport.

**1.4 — Everyone gets chat.** Page permissions in this app default **closed** for
`role = 'User'` (`server/middleware/pagePermission.js`). A message board that an
admin has to grant per-person is not a message board. `/messages` is
always-allowed — see §4.4 for exactly where.

**1.5 — Test accounts stay blocked.** `server/middleware/testUserGuard.js` 403s
every `/api/*` call for `users.is_test = true` accounts. **Do not add
`/api/chat` to its allowlist** — that would pipe real internal staff
conversations into the demo account. Instead the Messages page must handle the
403 (the error body carries `test_mode: true`) with a "not available in demo
mode" panel. Verify this by logging in as a test user; a white screen or an
endless spinner is a failure.

**1.6 — Mutations go over REST, sockets carry only ephemeral signals.** Auth,
validation and permission checks live in the Express routes, once. The socket
layer relays presence and typing, and the REST handlers call emit helpers to fan
out changes. Never let a socket event write to the database directly.

---

## 2. Phase 0 — transport (do this first, it touches the server boot)

**The blocker:** `server/index.js` ends with `app.listen(PORT, ...)`. socket.io
needs the underlying `http.Server`. Change it to:

```js
const http = require('http');
const server = http.createServer(app);
require('./lib/realtime').init(server);          // BEFORE listen
server.listen(PORT, () => { ... same callback ... });
```

Keep the existing `autoSeed().catch(...)` call inside the listen callback exactly
where it is — migrations must still run in the background after boot.

- `cd server && npm install socket.io`
- `cd client && npm install socket.io-client`
- Railway needs no config change for websockets.

**Dev CORS is not the same as the API's CORS.** There is **no Vite proxy** in
this repo — `client/src/api.js` points at `http://localhost:3001/api` directly in
dev. So the socket.io server needs its own dev origin allowlist
(`http://localhost:5173`, `http://localhost:3001`) and the client must connect to
an explicit URL in dev, not a relative path. In production they are same-origin
(Express serves the React build) so `io()` with no URL is correct there.

`helmet` runs with `contentSecurityPolicy: false`, so nothing there blocks the
websocket upgrade. Leave helmet alone.

### `server/lib/realtime.js`

Port cadence's version with these changes:

- **Drop every `label_id`.** Rooms are `user:<id>` and `channel:<id>`. There is no
  `label:<id>` room; the workspace-wide broadcast room is just `all`.
- **The JWT claim here is `id`, not `user_id`** (see `server/middleware/auth.js`).
- Re-verify the token the same way `authMiddleware` does: `jwt.verify`, then
  `SELECT token_version, role, name FROM users WHERE id = $1`, then reject if
  `decoded.tv !== undefined && rows[0].token_version !== decoded.tv`. A socket
  that outlives a forced logout is a session-invalidation hole.
- **Reject `is_test` users at the handshake.** Same reasoning as §1.5.
- Presence is a single `Map(userId -> live socket count)` (no per-tenant nesting).
  Emit `presence:update` only on the 0→1 and 1→0 transitions, not every tab.

Exports: `init(server)`, `emitToChannel`, `emitToUser`, `emitToAll`,
`addUsersToChannelRoom`, `onlineUsers`, `close`.

Socket events — server→client: `presence:list`, `presence:update`, `typing`,
`typing:stop`, `message:new`, `message:update`, `message:delete`, `channel:new`,
`mention`. Client→server: `typing`, `typing:stop`, `channel:subscribe` (so a
freshly created channel gets live messages without a reconnect).

---

## 3. Phase 1 — schema, REST, and the Messages page

### 3.1 Schema

Goes in `runMigrations()` in `server/index.js`, in the existing style: every
statement `IF NOT EXISTS`, each `await pool.query(...)` with its own
`.catch(err => console.error('...', err.message))`.

> **Why the per-statement catch matters:** `runMigrations()` is one promise
> chain. An unguarded throw anywhere aborts every migration after it, and boot
> still "succeeds" with a half-built schema. The file already carries a comment
> about this at ~line 680.

These must be created **after** the `users` table exists. `runMigrations()` runs
after `seed()` on a fresh DB, so the ordering is already safe — but keep the new
block near the other chat tables (~line 3019), not at the top of the function.

```sql
CREATE TABLE IF NOT EXISTS chat_channels (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(80),
  topic       TEXT,
  type        VARCHAR(16) NOT NULL DEFAULT 'channel',  -- channel | dm | object
  entity_type VARCHAR(40),          -- phase 5: 'release', 'deal', 'expense', ...
  entity_id   INTEGER,              -- phase 5
  is_private  BOOLEAN DEFAULT FALSE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_channels_type ON chat_channels (type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_object
  ON chat_channels (entity_type, entity_id) WHERE type = 'object';

CREATE TABLE IF NOT EXISTS chat_members (
  id           SERIAL PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMP,
  muted        BOOLEAN DEFAULT FALSE,
  joined_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id             SERIAL PRIMARY KEY,
  channel_id     INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system/bot
  body           TEXT,
  thread_root_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  is_system      BOOLEAN DEFAULT FALSE,
  meta           JSONB,
  edited_at      TIMESTAMP,
  deleted        BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages (channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread  ON chat_messages (thread_root_id);

CREATE TABLE IF NOT EXISTS chat_reactions (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_reactions (message_id);
```

`user_id` is nullable on `chat_messages` on purpose — that is how the activity
bot (phase 4) posts without a fake user row. `body` is nullable so phase 3 can
send an attachment with no text.

**Seed `#general` and `#activity`** on first run, and add every non-test user to
both. Do it find-or-create (`WHERE lower(name) = 'general'`), not
insert-on-empty — a workspace that deletes `#general` must get it back.

### 3.2 `server/routes/chat.js`

Mount in `server/index.js` alongside the others:
`app.use('/api/chat', require('./routes/chat'));`

Router-level: `router.use(authMiddleware)`. There is no `withTenant` in this app —
do not invent one.

Every read and every mutation is **membership-gated**, not role-gated. Write one
helper and use it everywhere:

```js
async function membership(channelId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM chat_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );
  return rows.length > 0;
}
```

Endpoints (port the shapes from cadence's `chat.js`, minus tenancy):

| Method | Path | Notes |
|---|---|---|
| GET | `/channels` | channels + DMs the caller belongs to, each with `unread_count` and DM peer name/online. Ensures `#activity` exists. |
| GET | `/channels/public` | joinable public channels the caller is *not* in |
| POST | `/channels` | `{name, topic, is_private, member_ids}`. Creator auto-joins. Name: lowercase, `[a-z0-9-]`, ≤80. |
| POST | `/channels/:id/join` | public channels only |
| POST | `/dm` | `{user_id}` find-or-create. **See landmine L1 — this is the route that crashed the reference app.** |
| GET | `/channels/:id/messages` | `?before=<id>&limit=50`, newest-last. Thread replies excluded from the main pane; `?thread=<rootId>` returns one thread. |
| POST | `/channels/:id/messages` | `{body, thread_root_id}`. Records mentions (§4.2), emits `message:new`. |
| PATCH | `/messages/:id` | author only; sets `edited_at` |
| DELETE | `/messages/:id` | author, or Admin/Superadmin. **Soft delete** (`deleted = TRUE`) — matches `campaign_chat_messages`' existing convention. |
| POST | `/messages/:id/react` | `{emoji}` toggles |
| POST | `/channels/:id/read` | sets `last_read_at = NOW()` |
| POST | `/channels/:id/mute` | toggles `muted`; muted channels are excluded from the nav badge |
| GET | `/unread` | `{ total }` for the nav badge |
| GET | `/search?q=` | ILIKE over `chat_messages`, **joined to `chat_members` for the caller** so it cannot return a message from a channel they aren't in. 40 newest, with channel context. |
| GET | `/users` | roster for the DM picker and @-autocomplete. Exclude `is_test` users. |

All `:id` params: constrain the route (`'/channels/:id(\\d+)/messages'`) **and**
guard with `Number.isInteger`. See landmine L3.

### 3.3 `client/src/context/SocketContext.jsx`

One shared socket for the whole app. Port cadence's. Provides `{ socket, online:
Set<userId>, on(event, handler), emit(event, payload) }`. Mount the provider
inside the authenticated part of the tree in `App.jsx`, below `AuthProvider`.
Connect only when there is a token and the user is not `is_test`; disconnect on
logout.

`on()` must return its own unsubscribe function and components must call it in
their effect cleanup, or navigating between channels stacks duplicate handlers
and every message renders N times.

### 3.4 `client/src/pages/Messages.jsx`

Route `/messages` and `/messages/:channelId` in `App.jsx`.

Layout: left sidebar (channels, DMs, unread bold + count pill, presence dots),
right message pane (grouped by day, consecutive-same-author collapsed, hover
actions for react/reply/edit/delete), composer (Enter sends, Shift+Enter
newline, typing emit debounced), thread panel as a right drawer.

Follow this repo's existing component conventions — `client/src/components/ui`,
the `Skeleton` component, `ToastContext` for errors. Match `CampaignChat.jsx`'s
@-autocomplete behaviour so the two feel like one product.

### 3.5 Nav

Per `CLAUDE.md` § "Adding a New Page":
1. Page in `client/src/pages/Messages.jsx`
2. Route in `App.jsx`
3. Nav entry in **`client/src/navConfig.jsx`** only (`NAV_GROUPS`, the untitled
   top group, next to Dashboard / My Work) — **do not** add a second list
4. Title in `PAGE_LABELS` in `Layout.jsx`
5. + 6. route file and `app.use` as above

Also add it to `client/src/components/BottomNav.jsx` for mobile if there is a
free slot; if there isn't, say so rather than silently dropping one.

---

## 4. Phase 2 — unread, mentions, notifications

**4.1 Nav badge.** Live count from `GET /api/chat/unread`, refetched on the
socket `message:new` event as well as on navigation. Excludes muted channels.

**4.2 Mentions → the existing bell.** On message send, parse `@name` out of the
body, resolve against the user roster, and insert into `user_mentions`:

```
user_id     = mentioned user
actor_name  = sender's name
room        = 'chat:<channelId>'
room_title  = '#<channel name>'  (or the DM peer's name)
room_path   = '/messages/<channelId>'
message_id  = the chat_messages id
snippet     = first ~140 chars of body
```

Read `server/routes/artist-campaigns.js` ~line 706 for the exact insert the
campaign chat already does, and match it. Never mention the sender themselves.
`@channel` / `@here` / `@everyone` notify every member of the channel.

Emit a `mention` socket event to each mentioned user so `NotificationBell.jsx`
refreshes immediately instead of waiting for its poll.

**4.3 Email fallback.** A mentioned user who is **not currently connected**
(check `realtime.onlineUsers()`) also gets an email. The mailer is
**`server/services/email.js`** (nodemailer + resend) — add a `sendChatMentionEmail`
sender there alongside the existing ones rather than calling nodemailer directly.
Best-effort: wrap in try/catch, never block the send, no-op when no provider is
configured. Throttle to at most one email per recipient per 5 minutes.

**4.4 Permissions carve-out.** `/messages` must be viewable by every role.
There is already a mechanism for exactly this: **`BASE_WHITELIST`**, which
currently holds only `/`. It exists in two places that are deliberate mirrors of
each other:

- `client/src/lib/pageAccess.js` — checked first in `allowsExactly()`
- `server/middleware/pagePermission.js` (~line 35) — the server-side mirror

Add `/messages` to **both**. Adding it to one only is how a page renders in the
nav and then 403s on every request. (The file's own comment says: *"A second copy
of these rules is how one of them gets fixed and the other doesn't."*)

`/messages` still goes in `navConfig.jsx`, so it appears in Settings' My Nav — a
user may *hide* it; they may not be *denied* it.

---

## 5. Phase 3 — attachments

`chat_attachments` table: `message_id`, `filename`, `mime`, `size_bytes`,
`r2_key`, `inline_data` (bytea or text, for the no-R2 fallback), `created_at`.

- Use the existing `server/lib/r2.js` (`uploadFile`, `getSignedFileUrl`,
  `loadFileBuffer`, `deleteFile`) and `server/middleware/secureUpload.js` +
  `server/lib/sniffMime.js` — this repo already sniffs MIME on upload; chat must
  not be the one path that doesn't.
- `multer.memoryStorage()`, `upload.array('files', 10)`, 25 MB cap. Attachment-only
  messages (empty body) are allowed.
- The send route becomes multipart. Keep accepting JSON for text-only sends.
- `uploadLimiter` (already defined in `index.js`) applies:
  `app.use('/api/chat/channels', uploadLimiter)` — or scope it to the send route.
- **Serving:** `GET /api/chat/attachments/:id` is membership-gated. For `<img>`
  tags, return a short-lived **signed R2 URL**, do not put the JWT in the `src`.
  This repo's `authMiddleware` does accept `?token=` (it's how `/uploads` static
  works) but putting a session token into an image URL leaks it into referrers
  and history. When R2 is unconfigured, stream the inline fallback through the
  authenticated endpoint instead.
- Client: paperclip button, drag-and-drop, and paste-to-upload in both the main
  and thread composers. Images render inline, everything else as a download chip.

---

## 6. Phase 4 — the activity bot

This is the part a generic Slack cannot do: app events posted into `#activity`,
deep-linked to the record.

`server/lib/activityBot.js`, ported from cadence (drop `postOperatorEvent` — this
app is single-tenant and has no platform console):

```js
postEvent({ text, icon, link })   // find-or-create #activity, insert a
                                  // chat_messages row with user_id = NULL,
                                  // is_system = true, meta = { icon, link },
                                  // then rt.emitToChannel(...)
```

Callers **fire and never await** it, after their own write commits, inside a
try/catch that swallows. A bot failure must never fail the underlying action.

Wire these first (the paths are this repo's):

| Event | File |
|---|---|
| vendor submission needs approval | `server/routes/vendor-submit.js` |
| invoice approved / bulk-approved | `server/routes/bookkeeping.js` |
| deal stage change (🎉 on Signed) | `server/routes/deals.js` |
| new release added | `server/routes/releases.js` |
| new teammate joined | `server/routes/team.js` |

Client renders system messages with a distinct bot avatar, a "Boom · Bot" label,
`*bold*` support, and a "View →" link from `meta.link`. Per-channel **mute** is
what stops `#activity` from dominating the unread badge — ship mute in the same
phase, not later.

---

## 7. Phase 5 — object threads, and retiring the second store

**7.1 Object-anchored threads.** `POST /api/chat/object-thread
{entity_type, entity_id, title}` find-or-creates a `type = 'object'` channel and
joins the caller. `entity_type` is validated against a whitelist map to its table
(`release` → `releases`, `deal` → `deals`, `expense` → `expenses`, `artist` →
`artists`) and the row's existence is checked — an unknown id is a **404, not a
500** (landmine L4). These channels appear in the sidebar under a "Threads"
group.

Reusable `<ObjectDiscussion entityType entityId title />` component (cadence has
one). Wire it into the deal drawer and the ledger entry drawer first.

**7.2 Migrate `campaign_chat_messages`.** Only after 7.1 is working:

- Map each distinct `room` key to an object channel or a named channel.
  `campaigns:<artist>` and `campaigns-notes:<artist>` are *different* rooms today
  and must stay distinguishable.
- Copy messages preserving `created_at`, `edited_at`, `deleted`, `user_id`.
- Copy `campaign_chat_reads` watermarks into `chat_members.last_read_at`.
- Repoint `CampaignChat.jsx` and `RoomCommentThread.jsx` at the chat API, or
  replace their internals with `ObjectDiscussion`, keeping their props
  (`room`, `title`, `path`) so the three mounting pages don't change.
- **Do not drop `campaign_chat_messages`** in the same deploy as the migration.
  Leave it in place for one release, verify counts match, then remove it.
- `user_mentions` rows already written by campaign chat keep working — their
  `room_path` still points at a real page.

---

## 8. Landmines

Every one of these has shipped at least once in one of these two codebases.
Ordered by how silent the failure is.

**L1 — A double `client.release()` kills the whole Node process.** If you use
`pool.connect()` for a transaction (channel create, DM find-or-create), an early
`return` that releases the client *inside* a handler that also has
`finally { client.release() }` makes pg-pool throw from the `finally` — outside
the try, so your catch never sees it, and Node exits. One request takes the
server down for everyone. **Let the `finally` do it, always.** In the reference
app the reachable path was `POST /chat/dm` returning an *already existing* DM —
i.e. opening a DM with anyone you'd DM'd before. Write that route carefully.

**L2 — Never reuse one `$n` against both a column and a literal.**
`SET status = $1, done_at = CASE WHEN $1 = 'Done' ...` makes Postgres deduce two
types for `$1` and raise **42P08 "inconsistent types deduced for parameter"**.
Casting does not help — bind the value twice. Same shape bites
`INSERT ... SELECT $1,$2,$3 WHERE NOT EXISTS (... col = $3)`, which is exactly
the shape a find-or-create channel insert wants to be.

**L3 — A NaN reaches Postgres as a type error, so a bad request becomes a 500.**
`parseInt(req.params.id, 10)` on garbage is `NaN`; `WHERE id = $1` then raises
22P02. Guard with `Number.isInteger` and return 400.

**L4 — An unknown FK is a 404, not a 500.** Posting a message to a deleted
channel raises a foreign-key violation. Use `INSERT ... SELECT ... WHERE EXISTS`
and treat `rowCount === 0` as not-found.

**L5 — `vite build` executes nothing.** It will not catch a component used but
never imported, or a `const` read above its own declaration. Either one renders a
**white screen on every page** if it's in a shared component. `npm run smoke`
from `client/` is the gate — see §9.

**L6 — `runMigrations()` is one promise chain.** Covered in §3.1. Per-statement
`.catch(err => console.error(...))`, and log, never swallow silently.

**L7 — pg returns a `DATE` column as a JS `Date`.** `chat_messages.created_at` is
a `TIMESTAMP`, so this is mostly moot here — but do not `String(d).slice(0,10)`
anywhere; that yields `"Tue Sep 01"`. Use the repo's date helpers in
`client/src/utils.js`.

**L8 — When a route swallows errors by design, a 200 proves nothing.** The
mention write and the activity-bot post are both best-effort. Verify the **row
landed**, not that the request returned 200. The reference app's analytics ping
returned `{success: true}` while writing nothing for weeks because it caught and
discarded a 42P08.

---

## 9. Verification

There is no test runner, linter or formatter in this repo — don't go looking for
one (`CLAUDE.md` §10). Verify manually, every phase:

```bash
# from client/
npm run build                 # parses
npm run smoke                 # renders changed pages under the real provider stack
npm run smoke -- src/pages/Messages.jsx

# from server/
node --check routes/chat.js lib/realtime.js lib/activityBot.js index.js

# both, in separate terminals
npm run dev:server            # :3001 against the dev Neon DB
npm run dev:client            # :5173
```

`npm run smoke` renders with `renderToString` in node — effects never fire, so it
proves the component *body* runs. That is exactly the class of bug that blanks a
page (L5). It is **not** evidence the page works.

**Per-phase acceptance — exercise in a real browser, two accounts, two windows:**

- **P0** — server boots; the websocket connects (Network → WS shows `101
  Switching Protocols`, not a fallback to long-polling); no CORS error in dev.
- **P1** — B sees A's message appear with no reload. Reactions, edit, soft
  delete, threads all round-trip. A user who is not a member of a private
  channel gets 403 on its messages endpoint *and* cannot find its messages via
  `/chat/search`. Test-user login shows the demo panel, not a spinner.
- **P2** — `@name` lands in B's bell within a second (no waiting for the poll),
  `room_path` navigates to the right channel, "mark read" clears it. The nav
  badge drops when B opens the channel, and a muted channel never raises it.
- **P3** — image renders inline, PDF downloads, a 30 MB file is rejected with a
  readable error, and with R2 unconfigured the send still succeeds via the
  inline fallback.
- **P4** — approving an invoice posts to `#activity` within a second, the "View
  →" link opens the entry, and **the approval still succeeds when the bot throws**
  (prove it: temporarily throw inside `postEvent`).
- **P5** — message counts match before and after the migration, old
  `user_mentions` links still resolve, and the three pages mounting
  `CampaignChat` / `RoomCommentThread` show their full history.

Check the deploy log after pushing for `[migration]` lines and any
`migration failed:` errors — a half-built schema boots fine and fails later.

---

## 10. Out of scope

Don't build these; mention them if you think one has become necessary.

- External/guest channels · huddles or voice · Slack import · message pinning ·
  custom emoji · scheduled sends · read receipts beyond the unread watermark ·
  full-text search infrastructure (ILIKE is adequate at this scale) ·
  E2E encryption · a mobile push layer.
- Retention/deletion policy: messages soft-delete and stay. If a real retention
  requirement appears, that is its own build.
