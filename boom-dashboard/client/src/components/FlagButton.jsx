import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Flag, X } from 'lucide-react'

// Amber flag toggle with an optional reason popover.
//
// UX summary:
//   • Not flagged: outlined flag icon.
//   • Flagged: filled amber flag.
//   • Click: toggles the flag. If turning ON, the popover opens with
//     the reason input focused; blank reasons are fine.
//   • Click while flagged: opens the popover so the user can edit the
//     reason or unflag via a button inside.
//   • The button stopPropagation's so clicks don't bubble into the
//     parent link/button/row.
//   • `rolledUp` (bool): true when the entity itself isn't flagged but
//     one or more children are. Same amber chip, but the tooltip and
//     popover explain the rollup (used on the ArtistCampaigns artist
//     cards — count of flagged songs).
//   • `size` = 'sm' | 'md'. sm sits inline in dense chips; md is the
//     song-row header size.
export default function FlagButton({
  flagged,
  rolledUp = false,
  reason = '',
  onToggle,
  onSaveReason,
  rolledUpCount = 0,
  rolledUpLabel = '',
  size = 'md',
  className = '',
  alwaysVisible = false,
  // Attribution — who raised the flag and when. Optional; rendered in
  // the popover under the header so a teammate can tell whose review
  // request they're looking at.
  flaggedBy = '',
  flaggedAt = null,
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(reason || '')
  useEffect(() => { setDraft(reason || '') }, [reason, open])
  const btnRef = useRef(null)
  const popRef = useRef(null)
  // Portal position — computed viewport-fixed so ancestor overflow-hidden
  // (SongGroup card, ledger's sticky td, Approvals row, etc.) can't clip
  // the popover. Recomputed on scroll + resize while open.
  //
  // Positioning strategy:
  //   • x: center the popover under the button's x-center, then clamp
  //     to a 16px viewport margin on either side.
  //   • y: place below the button by default; if that would overflow
  //     the bottom of the viewport, flip to above. If both directions
  //     overflow (short viewport + tall popover), fall back to the
  //     direction with more room and clamp to the MARGIN.
  // The height is measured off popRef after the first layout — the
  // fallback estimate is used for the initial paint so the popover
  // doesn't flash into the wrong spot on rows near the bottom.
  const POP_HEIGHT_ESTIMATE = 260
  const [popPos, setPopPos] = useState(null)
  useEffect(() => {
    if (!open) { setPopPos(null); return }
    const compute = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const POP_WIDTH = 288 // matches w-72 in the render below
      const MARGIN = 16
      const popHeight = popRef.current?.offsetHeight || POP_HEIGHT_ESTIMATE

      // Horizontal: centered under button, clamped to viewport.
      const centered = (r.left + r.right) / 2 - POP_WIDTH / 2
      const left = Math.max(
        MARGIN,
        Math.min(centered, window.innerWidth - POP_WIDTH - MARGIN)
      )

      // Vertical: prefer below the button, flip above when it overflows.
      const roomBelow = window.innerHeight - r.bottom - MARGIN
      const roomAbove = r.top - MARGIN
      let top
      if (popHeight + 4 <= roomBelow) {
        top = r.bottom + 4
      } else if (popHeight + 4 <= roomAbove) {
        top = r.top - 4 - popHeight
      } else {
        // Neither direction fits fully — use whichever has more room and
        // clamp to MARGIN so the popover stays fully visible even if the
        // top gets cut a bit.
        top = roomAbove >= roomBelow
          ? Math.max(MARGIN, r.top - 4 - popHeight)
          : Math.min(window.innerHeight - popHeight - MARGIN, r.bottom + 4)
      }
      setPopPos({ top, left })
    }
    // Two-pass: initial compute uses the estimate; a rAF-scheduled second
    // pass reads the real measured height once the popover is mounted, so
    // the flip decision reflects the actual DOM.
    compute()
    const raf = requestAnimationFrame(compute)
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      const inButton = btnRef.current && btnRef.current.contains(e.target)
      const inPopover = popRef.current && popRef.current.contains(e.target)
      if (!inButton && !inPopover) setOpen(false)
    }
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const iconSize = size === 'sm' ? 12 : 14
  const isActive = flagged || rolledUp
  const visibilityClass = (!isActive && !alwaysVisible)
    ? 'opacity-0 group-hover:opacity-70 hover:!opacity-100 focus:!opacity-100'
    : 'opacity-100'
  const tone = isActive
    ? 'text-amber-700 bg-amber-100 ring-1 ring-amber-300'
    : 'text-gray-400 bg-transparent ring-1 ring-gray-300 hover:text-amber-600 hover:ring-amber-400'

  const title = flagged
    ? (reason ? `Flagged for review — ${reason.slice(0, 100)}` : 'Flagged for review')
    : rolledUp
      ? `${rolledUpCount} ${rolledUpLabel || 'item'}${rolledUpCount === 1 ? '' : 's'} flagged for review`
      : 'Click to flag for review'

  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          setOpen(v => !v)
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className={`inline-flex items-center justify-center rounded-full transition-all ${visibilityClass} ${tone}`}
        style={{ width: size === 'sm' ? 20 : 24, height: size === 'sm' ? 20 : 24 }}
        title={title}
        aria-label={title}
      >
        <Flag size={iconSize} className={flagged ? 'fill-amber-500' : ''} strokeWidth={2.25} />
      </button>
      {open && popPos && createPortal(
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            // 80: above the mobile BottomSheet (z-70), below full modals (z-100)
            position: 'fixed', top: popPos.top, left: popPos.left, zIndex: 80,
          }}
          className="w-72 bg-card border border-rule rounded-lg shadow-lg p-3 text-xs"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-gray-900 inline-flex items-center gap-1.5">
              <Flag size={12} className={flagged ? 'fill-amber-500 text-amber-700' : 'text-gray-400'} />
              {flagged ? 'Flagged for review' : (rolledUp ? 'Review flagged' : 'Flag for review')}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(false) }}
              className="text-gray-300 hover:text-gray-600"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          {flagged && (flaggedBy || flaggedAt) && (
            <p className="text-[10px] text-gray-400 mb-2">
              Flagged{flaggedBy ? ` by ${flaggedBy}` : ''}
              {flaggedAt ? ` · ${new Date(flaggedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
            </p>
          )}
          {rolledUp && !flagged && rolledUpCount > 0 && (
            <p className="text-[11px] text-gray-500 mb-2">
              {rolledUpCount} {rolledUpLabel || 'item'}{rolledUpCount === 1 ? '' : 's'} on this artist are flagged.
              You can add an artist-level flag on top if the whole artist
              needs review.
            </p>
          )}
          <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Reason (optional)</label>
          <textarea
            autoFocus={!flagged}
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 500))}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="What needs a second look?"
            rows={2}
            className="w-full border border-rule rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400 resize-y"
          />
          <p className="text-[10px] text-gray-400 mt-1">{draft.length}/500</p>
          <div className="flex items-center justify-between mt-3 gap-2">
            {flagged ? (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation(); e.preventDefault()
                  await onToggle(false)
                  setOpen(false)
                }}
                className="text-[11px] font-semibold text-rose-600 hover:text-rose-700"
              >
                Clear flag
              </button>
            ) : <span />}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(false) }}
                className="text-[11px] font-semibold text-gray-500 hover:text-gray-800 px-2 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation(); e.preventDefault()
                  const trimmed = draft.trim()
                  if (!flagged) {
                    await onToggle(true, trimmed || null)
                  } else if (trimmed !== (reason || '').trim()) {
                    await onSaveReason(trimmed)
                  }
                  setOpen(false)
                }}
                className="text-[11px] font-bold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded"
              >
                {flagged ? 'Save' : 'Flag'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </span>
  )
}
