// Badge — semantic status pill. Tones map to the status tokens from
// utils/darkColors.js so intensity auto-adjusts between light and dark.
//
// The old .badge-* classes in index.css stay in place for existing callers;
// new code should prefer this component.

const TONES = {
  success: 'bg-[rgba(16,185,129,0.12)]  text-success',
  warning: 'bg-[rgba(245,158,11,0.12)]  text-warning',
  danger:  'bg-[rgba(239,68,68,0.1)]    text-danger',
  info:    'bg-[rgba(59,130,246,0.1)]   text-info',
  neutral: 'bg-rule-light              text-ink-muted',
}

export default function Badge({ tone = 'neutral', className = '', children }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        TONES[tone] ?? TONES.neutral
      } ${className}`}
    >
      {children}
    </span>
  )
}
