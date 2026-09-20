// One rail row, several pages, and NOT ONE URL MOVED.
//
// Recoupments was three sidebar rows for one subject — 8,062 lines across three
// pages sharing five endpoints — and Import was four rows scattered across three
// different nav groups for the single job of putting a file into the app.
//
// The obvious merge is to fold them into one route with internal tab state. This
// deliberately does not. Page permissions are stored BY PATH, and
// lib/pageAccess.js already carries four carve-outs, one for every previous time
// a page moved. Retiring three paths would mean three more, forever, plus dead
// bookmarks and dead deep links.
//
// So each page keeps its own route, its own file and its own URL. This wraps
// them, draws a tab bar, and lets Layout render the family as a single row. The
// change is entirely in the chrome — which is why the whole permission fixture
// (13 accounts × 65 routes) returns byte-identical results before and after.
//
// A WRAPPER rather than a nested <Route element><Outlet/></Route> for two
// reasons that both matter:
//
//   • /recoupments/:artistName renders the same Recoupments page filtered to one
//     artist, and /recoupments/2025 is a routed orphan John wants left exactly as
//     it is. Nesting would sweep both into the family; wrapping touches neither.
//   • A family need not share a path prefix at all — Settings holds /settings,
//     /team, /activity and /admin. Nesting cannot express that. A wrapper can,
//     so every family uses one mechanism instead of two.

import { useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { tabFamily } from '../navConfig'
import { useAuth } from '../context/AuthContext'

/**
 * @param {string} family  the `key` of a `tabbed` entry in navConfig
 * @param {React.ReactNode} children  the page itself
 * @param {Object<string, number>} counts  optional per-path badge, keyed by the
 *   tab's own path. Additive and default-empty on purpose: `counts[t.path]` is
 *   undefined for vendors / import / recoupments, so the badge JSX never
 *   renders and those three families stay byte-identical. Only the banking
 *   family passes it, because only there is "how much is left" a property of
 *   the tab rather than of the page you are already on.
 */
export default function TabbedShell({ family, children, counts = {} }) {
  const { canView, user } = useAuth()
  const location = useLocation()
  const def = tabFamily(family)

  const tabs = useMemo(() => {
    if (!def) return []
    const isSysAdmin = user?.role === 'Admin' || user?.role === 'Superadmin'
    return def.children
      // Same gates the sidebar applies, in the same order. A tab the user
      // would be redirected away from must not be offered — App.jsx bounces an
      // unauthorized path to '/', so an ungated tab is a trapdoor, not a link.
      .filter((c) => !c.hidden)
      .filter((c) => !c.adminOnly || isSysAdmin)
      .filter((c) => canView(c.path))
  }, [def, canView, user])

  // Which tab is current. Longest match wins, so /recoupments/planning selects
  // Planning rather than Overview — every child of this family is also a path
  // descendant of /recoupments, and first-match-wins would light up the wrong one
  // on every page but the first.
  const activePath = useMemo(() => {
    const here = location.pathname
    let best = null, len = -1
    for (const c of tabs) {
      const owns = here === c.path || here.startsWith(c.path + '/')
      if (owns && c.path.length > len) { best = c.path; len = c.path.length }
    }
    return best
  }, [tabs, location.pathname])

  // A family with one reachable tab is not a tab bar, it is a heading with extra
  // steps. Render the page alone. This is the normal case for a user granted
  // exactly one page of a family — a non-admin on Settings sees only Settings.
  if (tabs.length < 2) return children

  return (
    <>
      <div className="flex gap-0 border-b border-divider mb-6 overflow-x-auto" data-tour="family-tabs" data-family={family.key}>
        {tabs.map((t) => {
          const active = t.path === activePath
          const cls = `text-xs font-medium px-4 py-2.5 -mb-px whitespace-nowrap transition-colors ${
            active
              ? 'text-boom-600 border-b-2 border-boom-500'
              : 'text-gray-400 border-b-2 border-transparent hover:text-gray-600'
          }`
          // `external` tabs (the vendor-form sandbox) open in a new window, as
          // the sidebar has always opened them. A <Link> would render the
          // sandbox inside the app shell it exists to stand apart from.
          if (t.external) {
            return (
              <a key={t.path} href={t.path} target="_blank" rel="noopener noreferrer" className={cls}>
                {t.label}
              </a>
            )
          }
          return (
            <Link
              key={t.path}
              to={t.path}
              aria-current={active ? 'page' : undefined}
              className={cls}
            >
              {t.label}
              {counts[t.path] != null && (
                <span className={`ml-1.5 tabular-nums font-normal ${active ? 'text-boom-500' : 'text-gray-400'}`}>
                  {counts[t.path].toLocaleString()}
                </span>
              )}
            </Link>
          )
        })}
      </div>
      {children}
    </>
  )
}
