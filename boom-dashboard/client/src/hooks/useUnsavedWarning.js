import { useEffect } from 'react'

/**
 * Warns user before leaving the page if there are unsaved changes.
 * @param {boolean} hasChanges - whether the form has unsaved data
 */
export default function useUnsavedWarning(hasChanges) {
  useEffect(() => {
    if (!hasChanges) return
    const handler = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasChanges])
}
