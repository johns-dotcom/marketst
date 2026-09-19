// The one empty state.
//
// John, 2026-09-18: a new label's app is a set of empty tables, and a blank
// table teaches nothing. Every page that can be empty says the same three
// things in the same order: what fills this page, one button that makes it,
// and — when the data is born somewhere else — where.
//
//   <EmptyState
//     title="Nothing due yet"
//     body="Approved invoices land here on their due date."
//     action={{ label: 'Add invoice', to: '/bk/add' }}
//     source={{ label: 'Approvals', to: '/bk/approvals' }}
//   />
//
// `action` takes `to` (a Link) or `onClick` (a button). `source` is a page,
// rendered as "or go to Approvals →". Either may be omitted. Nothing here
// knows about permissions: a caller that would link to a page the user cannot
// open should not pass it (use canView at the call site).
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

export default function EmptyState({ title, body, action, source, icon: Icon, compact = false, children }) {
  return (
    <div className={`card text-center ${compact ? 'p-5' : 'p-8'}`} data-empty-state>
      {Icon && <Icon size={compact ? 18 : 22} strokeWidth={1.5} className="mx-auto text-gray-300 mb-2" />}
      <p className={`font-semibold text-ink ${compact ? 'text-[13px]' : 'text-[14px]'}`}>{title}</p>
      {body && <p className="text-[12.5px] text-gray-500 mt-1 max-w-md mx-auto leading-snug">{body}</p>}
      {(action || source || children) && (
        <div className="mt-4 flex items-center justify-center gap-3 flex-wrap">
          {action && (action.to ? (
            <Link to={action.to} className="btn-primary text-[12.5px] px-3 py-1.5 inline-flex items-center gap-1.5" data-empty-action>
              {action.label}
            </Link>
          ) : (
            <button type="button" onClick={action.onClick} className="btn-primary text-[12.5px] px-3 py-1.5 inline-flex items-center gap-1.5" data-empty-action>
              {action.label}
            </button>
          ))}
          {source && (
            <Link to={source.to} className="text-[12px] text-gray-500 hover:text-ink inline-flex items-center gap-1" data-empty-source>
              {action ? 'or go to ' : 'Go to '}{source.label} <ArrowRight size={12} />
            </Link>
          )}
          {children}
        </div>
      )}
    </div>
  )
}
