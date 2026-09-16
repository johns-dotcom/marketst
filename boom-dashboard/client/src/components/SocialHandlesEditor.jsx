// The vendor's handles — editable, and addable.
//
// One editor, two surfaces: the Approvals review deck (where a change is a PUT
// on a saved row) and Add Invoice's review (where it is a draft that has not
// been created yet). Persistence is the PARENT's job — this component only ever
// hands back the next list.
//
// ── The whole row travels ──────────────────────────────────────────────────
// A social row may also hold `artist` (which artist of a split invoice the
// handle belongs to) and `amount` (the per-creator carve-out of the total).
// Neither is shown here. Rebuilding rows as {platform, handle} is exactly how
// that scoping was lost once before, which is why lib/socials.js
// normalizeSocialRows exists as the one shape on the server — so edits patch the
// existing object rather than replacing it.
//
// Props:
//   rows      the list. [] renders the empty state, which still offers Add —
//             "the handle the vendor forgot" is the case an absent section hid.
//   onChange  (nextRows) — every edit, add and remove
//   onCommit  optional; called on blur and after a remove, for a parent that
//             persists. Given the NEXT rows on a remove, because a parent that
//             read them back out of state would run on the previous render's
//             copy and write the removed row straight back.
//   note      optional line above the list (e.g. the vendor's explicit "N/A")

const PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'X', 'Facebook', 'Twitch', 'Snapchat']

const profileUrl = (platform, handle) => {
  const at = String(handle || '').trim().replace(/^@/, '')
  if (!at) return null
  const p = String(platform || '')
  // Linked only where the platform is one we can build a URL for — guessing a
  // domain sends somebody to a page that does not exist.
  if (/instagram/i.test(p)) return `https://instagram.com/${at}`
  if (/tiktok/i.test(p)) return `https://tiktok.com/@${at}`
  if (/twitter|^x$/i.test(p)) return `https://x.com/${at}`
  if (/youtube/i.test(p)) return `https://youtube.com/@${at}`
  return null
}

export const realHandles = (rows = []) => rows.filter((x) => {
  const h = String(x?.handle || '').trim()
  // A vendor with none types the literal "N/A", so an explicit "no socials" and
  // a blank field are different things and must not be counted the same.
  return h && !/^n\/?a$/i.test(h)
})

export default function SocialHandlesEditor({
  rows = [],
  onChange,
  onCommit,
  disabled = false,
  listId = 'social-platforms',
  currency = 'USD',
}) {
  const real = realHandles(rows)
  const saidNone = rows.length > 0 && real.length === 0

  const edit = (i, patch) => {
    const next = [...rows]
    next[i] = { ...next[i], ...patch }
    onChange?.(next)
  }
  const add = () => onChange?.([...rows, { platform: '', handle: '' }])
  const remove = (i) => {
    const next = rows.filter((_, n) => n !== i)
    onChange?.(next)
    onCommit?.(next)
  }
  const money = (a) => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(a || 0) }
    catch { return String(a) }
  }

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Socials</span>
        {real.length > 0 && <span className="text-[10px] text-gray-300">{real.length}</span>}
        <button type="button" onClick={add} disabled={disabled}
          className="ml-auto text-[11px] font-semibold text-gray-400 hover:text-ink disabled:opacity-40">
          + Add
        </button>
      </div>
      {saidNone && (
        <p className="text-[11px] text-gray-400 mb-1.5">
          Vendor answered <b>N/A</b> — they told us they have none, which is not the same as
          leaving it blank. Editing one below replaces that answer.
        </p>
      )}
      {rows.length === 0 && (
        <p className="text-[11px] text-gray-400">
          None on file. Add one if the vendor sent it another way.
        </p>
      )}
      <div className="space-y-1">
        {rows.map((x, i) => {
          const handle = String(x?.handle ?? '')
          const platform = String(x?.platform ?? '')
          const href = profileUrl(platform, handle)
          return (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={platform}
                onChange={(e) => edit(i, { platform: e.target.value })}
                onBlur={() => onCommit?.(rows)}
                disabled={disabled}
                list={listId}
                placeholder="Platform"
                className="w-[104px] shrink-0 px-2 py-1 text-[11px] border border-rule rounded-md bg-card text-gray-600" />
              <input
                value={handle}
                onChange={(e) => edit(i, { handle: e.target.value })}
                onBlur={() => onCommit?.(rows)}
                disabled={disabled}
                placeholder="@handle"
                className="flex-1 min-w-0 px-2 py-1 text-[11px] font-semibold border border-rule rounded-md bg-card text-gray-700" />
              {/* The per-artist scope and the per-creator carve-out travel with
                  the row untouched — this editor does not show them. */}
              {(x?.artist || x?.amount != null) && (
                <span className="shrink-0 text-[10px] text-gray-300"
                  title={`Kept on this handle: ${[x.artist, x.amount != null ? money(x.amount) : null].filter(Boolean).join(' · ')}`}>
                  {x.artist || money(x.amount)}
                </span>
              )}
              {href && (
                <a href={href} target="_blank" rel="noreferrer" title="Open the profile"
                  className="shrink-0 text-[11px] text-gray-400 hover:text-ink">↗</a>
              )}
              <button type="button" onClick={() => remove(i)} disabled={disabled}
                title="Remove this handle"
                className="shrink-0 w-5 text-[13px] leading-none text-gray-300 hover:text-rose-600 disabled:opacity-40">×</button>
            </div>
          )
        })}
      </div>
      <datalist id={listId}>
        {PLATFORMS.map((pl) => <option key={pl} value={pl} />)}
      </datalist>
    </div>
  )
}
