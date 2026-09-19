/**
 * Consistent page header used across all pages.
 *
 * <PageHeader
 *   title="Payment Dashboard"
 *   subtitle="Track, filter, and mark invoices paid"
 *   actions={<button>Export</button>}
 *   badge={27}
 * />
 */
export default function PageHeader({ title, subtitle, actions, badge, back, tour }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4 mb-6" data-tour={tour}>
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">{title}</h1>
          {badge != null && badge > 0 && (
            <span className="bg-boom-100 text-boom-700 text-xs font-bold px-2.5 py-0.5 rounded-full">
              {badge}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="text-sm text-gray-400 mt-1">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          {actions}
        </div>
      )}
    </div>
  )
}
