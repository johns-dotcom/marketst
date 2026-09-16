import { forwardRef } from 'react'

const VARIANTS = {
  primary:   'bg-brand text-white hover:bg-brand-hover active:bg-brand-active',
  secondary: 'bg-card text-ink border border-rule hover:bg-row-hover',
  ghost:     'bg-transparent text-ink hover:bg-row-hover',
  danger:    'bg-danger text-white hover:opacity-90',
}

const SIZES = {
  sm: 'h-8  px-3 text-xs',
  md: 'h-9  px-4 text-sm',
  lg: 'h-11 px-5 text-base',
}

const BASE = 'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]'

const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', className = '', type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${BASE} ${VARIANTS[variant] ?? VARIANTS.primary} ${SIZES[size] ?? SIZES.md} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
})

export default Button
