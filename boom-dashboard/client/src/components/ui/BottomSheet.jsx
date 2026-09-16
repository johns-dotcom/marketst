import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * Slide-up bottom drawer for mobile surfaces (detail views, action
 * menus, filter panels). Portals to document.body so it escapes any
 * overflow/stacking context on the page. Closes on backdrop tap or
 * Escape; locks body scroll while open.
 *
 * Uses semantic token aliases (bg-card / text-ink / border-rule /
 * bg-overlay) so it is dark-mode native even inside inline-styled pages.
 */
export default function BottomSheet({ open, onClose, title, children, footer }) {
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="absolute bottom-0 left-0 right-0 bg-card rounded-t-2xl shadow-2xl max-h-[85dvh] flex flex-col animate-sheet-up"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1 shrink-0" onClick={onClose}>
          <div className="w-9 h-1 rounded-full bg-gray-300" />
        </div>

        {(title || onClose) && (
          <div className="flex items-center justify-between px-4 pb-2 shrink-0 border-b border-divider">
            <div className="text-sm font-bold text-ink truncate">{title}</div>
            <button
              onClick={onClose}
              className="p-1.5 -mr-1.5 rounded-lg text-gray-400 hover:text-gray-600"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}

        <div className="overflow-y-auto px-4 py-3 flex-1" style={{ WebkitOverflowScrolling: 'touch' }}>
          {children}
        </div>

        {footer && (
          <div className="shrink-0 px-4 py-3 border-t border-divider bg-card">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
