import { useLocation, Link } from 'react-router-dom'
import { LayoutDashboard, Briefcase, Music, DollarSign, Menu } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const TABS = [
  { path: '/',          label: 'Home',     icon: LayoutDashboard },
  { path: '/my-work',   label: 'My Work',  icon: Briefcase },
  { path: '/releases',  label: 'Releases', icon: Music },
  { path: '/bk/ledger', label: 'Finance',  icon: DollarSign },
]

/**
 * Fixed bottom navigation bar — visible on mobile only.
 * Shows the 4 primary tabs THAT THE USER CAN VIEW + a "More" button
 * to open the sidebar. Tabs a User doesn't have permission for are
 * hidden so the mobile nav can't advertise pages the user would just
 * bounce off of on click.
 */
export default function BottomNav({ onOpenSidebar }) {
  const location = useLocation()
  const { canView } = useAuth()
  const visibleTabs = TABS.filter(t => canView(t.path))

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 sm:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-around h-14">
        {visibleTabs.map(tab => {
          const Icon = tab.icon
          const isActive = location.pathname === tab.path || (tab.path !== '/' && location.pathname.startsWith(tab.path))
          return (
            <Link
              key={tab.path}
              to={tab.path}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${
                isActive ? 'text-boom-600' : 'text-gray-400'
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 2 : 1.5} />
              <span className="text-[10px] font-semibold">{tab.label}</span>
            </Link>
          )
        })}
        <button
          onClick={onOpenSidebar}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-gray-400"
        >
          <Menu size={20} strokeWidth={1.5} />
          <span className="text-[10px] font-semibold">More</span>
        </button>
      </div>
    </nav>
  )
}
