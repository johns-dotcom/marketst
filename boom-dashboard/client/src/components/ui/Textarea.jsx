import { forwardRef } from 'react'

const BASE = 'w-full px-3 py-2 text-sm bg-input-bg text-input-text border border-input-border rounded-lg transition-colors placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)] focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed resize-y'

const Textarea = forwardRef(function Textarea({ className = '', rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`${BASE} ${className}`}
      {...rest}
    />
  )
})

export default Textarea
