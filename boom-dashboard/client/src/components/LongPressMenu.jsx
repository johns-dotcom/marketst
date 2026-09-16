import { useState, useRef, useCallback } from 'react'

/**
 * Wraps children with long-press detection. Shows a context menu on long press.
 *
 * <LongPressMenu actions={[
 *   { label: 'Edit', onClick: () => ... },
 *   { label: 'Pin', onClick: () => ... },
 *   { label: 'Delete', onClick: () => ..., danger: true },
 * ]}>
 *   <div>...task row...</div>
 * </LongPressMenu>
 */
export default function LongPressMenu({ actions, children }) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const timer = useRef(null)
  const moved = useRef(false)

  const handleTouchStart = useCallback((e) => {
    moved.current = false
    const touch = e.touches[0]
    timer.current = setTimeout(() => {
      if (!moved.current) {
        setPos({ x: touch.clientX, y: touch.clientY })
        setShow(true)
        // Haptic feedback if available
        if (navigator.vibrate) navigator.vibrate(20)
      }
    }, 500)
  }, [])

  const handleTouchMove = useCallback(() => {
    moved.current = true
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return (
    <>
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onContextMenu={e => e.preventDefault()}
      >
        {children}
      </div>

      {show && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setShow(false)} />
          <div
            className="fixed z-50 bg-white rounded-xl shadow-2xl border border-gray-200 py-1 min-w-[160px] overflow-hidden"
            style={{
              left: Math.min(pos.x, window.innerWidth - 180),
              top: Math.min(pos.y, window.innerHeight - (actions.length * 44 + 10)),
            }}
          >
            {actions.map((a, i) => (
              <button
                key={i}
                onClick={() => { setShow(false); a.onClick?.() }}
                className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors ${
                  a.danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}
