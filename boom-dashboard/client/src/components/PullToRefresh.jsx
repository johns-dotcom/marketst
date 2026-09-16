import { useState, useRef, useCallback } from 'react'

/**
 * Wrap any scrollable content to add pull-to-refresh on mobile.
 * <PullToRefresh onRefresh={async () => { await fetchData() }}>
 *   <div>...content...</div>
 * </PullToRefresh>
 */
export default function PullToRefresh({ onRefresh, children }) {
  const [pulling, setPulling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(0)
  const pullDist = useRef(0)

  const handleTouchStart = useCallback((e) => {
    const scrollTop = e.currentTarget.scrollTop
    if (scrollTop <= 0) {
      startY.current = e.touches[0].clientY
    } else {
      startY.current = 0
    }
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (!startY.current || refreshing) return
    const diff = e.touches[0].clientY - startY.current
    if (diff > 0 && diff < 120) {
      pullDist.current = diff
      setPulling(diff > 50)
    }
  }, [refreshing])

  const handleTouchEnd = useCallback(async () => {
    if (pulling && !refreshing && onRefresh) {
      setRefreshing(true)
      try { await onRefresh() } catch {} finally {
        setRefreshing(false)
      }
    }
    setPulling(false)
    pullDist.current = 0
    startY.current = 0
  }, [pulling, refreshing, onRefresh])

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="flex-1 overflow-auto"
    >
      {(pulling || refreshing) && (
        <div className="ptr-indicator">
          <div className="ptr-spinner" />
        </div>
      )}
      {children}
    </div>
  )
}
