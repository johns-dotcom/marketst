import { forwardRef } from 'react'

// The focus ring color comes from --color-focus-ring so it picks up the right
// intensity in light vs dark automatically. `focus:border-brand` pairs with
// the ring so the outline reads unambiguously against any surface.

const BASE = 'w-full h-9 px-3 text-sm bg-input-bg text-input-text border border-input-border rounded-lg transition-colors placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)] focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed'

const Input = forwardRef(function Input({ className = '', type = 'text', ...rest }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={`${BASE} ${className}`}
      {...rest}
    />
  )
})

export default Input
