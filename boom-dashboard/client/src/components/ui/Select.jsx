import { forwardRef } from 'react'

// Native <select> styled to match the rest of the form primitives.
// `appearance-none` + a trailing padding makes room for a caret drawn via a
// background-image, so the element still looks like ours in dark mode where
// the OS-native caret clashes with our surface colors.
const CARET = "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22 viewBox=%220 0 10 6%22 fill=%22none%22><path d=%22M1 1L5 5L9 1%22 stroke=%22currentColor%22 stroke-width=%221.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>')] bg-no-repeat bg-[right_0.75rem_center]"

const BASE = `w-full h-9 pl-3 pr-8 text-sm bg-input-bg text-input-text border border-input-border rounded-lg transition-colors appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)] focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed ${CARET}`

const Select = forwardRef(function Select({ className = '', children, ...rest }, ref) {
  return (
    <select ref={ref} className={`${BASE} ${className}`} {...rest}>
      {children}
    </select>
  )
})

export default Select
