import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'

// Instant hover label for icon-only controls. Native title tooltips take
// ~1s to appear and are easy to miss; this one renders immediately, and
// portals to <body> so ancestor overflow-hidden (e.g. the SongGroup
// cards) can't clip it. Literal dark chrome colors instead of tokens so
// it reads as a tooltip in both themes.
export default function HoverTip({ tip, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const show = () => {
    if (!tip) return
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    // Clamp horizontally so a tooltip near the viewport edge doesn't
    // overflow off-screen (240px max width, centered on the control).
    const left = Math.min(Math.max(r.left + r.width / 2, 130), window.innerWidth - 130)
    setPos({ top: r.top - 7, left })
  }
  return (
    <span ref={ref} className="inline-flex" onMouseEnter={show} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && tip && createPortal(
        <div
          style={{
            position: 'fixed', top: pos.top, left: pos.left,
            transform: 'translate(-50%, -100%)', zIndex: 70,
            background: '#1f2937', color: '#f9fafb', maxWidth: 240,
          }}
          className="pointer-events-none rounded-md px-2 py-1 text-[11px] font-semibold leading-snug shadow-lg text-center"
        >
          {tip}
        </div>,
        document.body
      )}
    </span>
  )
}
