// Card — semantic container that follows the design-system tokens.
// Accepts optional header/footer slots. Passes through extra props to the
// outer div so callers can attach onClick / role / ref / etc. if needed.
//
// Existing className-based `.card` class in index.css stays for backwards
// compatibility; prefer this component in new code.

export default function Card({
  header,
  footer,
  className = '',
  bodyClassName = '',
  children,
  ...rest
}) {
  return (
    <div
      className={`bg-card border border-rule rounded-xl ${className}`}
      {...rest}
    >
      {header != null && (
        <div className="px-5 py-3 border-b border-rule-light">
          {header}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
      {footer != null && (
        <div className="px-5 py-3 border-t border-rule-light">
          {footer}
        </div>
      )}
    </div>
  )
}
