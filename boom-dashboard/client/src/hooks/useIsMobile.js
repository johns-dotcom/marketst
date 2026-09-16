import { useState, useEffect } from 'react'

/**
 * Media-query hook for the card-vs-table switch on dense pages.
 * Default breakpoint is 767px — BELOW Layout's 1023px chrome breakpoint
 * on purpose: tablets (768–1023) keep the full editing tables, phones
 * get card views.
 */
export default function useIsMobile(query = '(max-width: 767px)') {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (e) => setMatches(e.matches)
    setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
