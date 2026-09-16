import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

/**
 * Breadcrumb navigation.
 *
 * <Breadcrumb items={[
 *   { label: 'Finance', path: '/bk/ledger' },
 *   { label: 'Vendors', path: '/bk/vendors' },
 *   { label: 'Christian Reyes Management' },
 * ]} />
 *
 * Last item has no path — it's the current page (not a link).
 */
export default function Breadcrumb({ items }) {
  if (!items || items.length <= 1) return null

  return (
    <nav className="flex items-center gap-1 text-xs text-gray-400 mb-4">
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={11} className="text-gray-300" />}
            {isLast || !item.path ? (
              <span className="text-gray-600 font-medium truncate max-w-[200px]">{item.label}</span>
            ) : (
              <Link to={item.path} className="hover:text-gray-600 transition-colors">
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
