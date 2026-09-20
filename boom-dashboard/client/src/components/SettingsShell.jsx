// Settings as one place with a left rail (2026-09-19, John: "flow and look").
//
// Two headed groups — My settings for everyone, Label settings for admins —
// and the content beside them. Pages that are really their own routes
// (People /team, Activity /activity, Admin docs /admin) render INSIDE this
// shell with their rail item lit, so opening People never drops you out of
// Settings and the way back is always on screen. NOT ONE PATH MOVED: every
// item is a Link to the path the page already had, so grants stored by path
// are untouched. The Sandbox stays an external link — it is a page that
// deliberately stands apart from the app shell.
import { Link, useLocation } from 'react-router-dom'
import { UserCircle2, KeyRound, Bell, Mail, Sun, SlidersHorizontal, Users, Building2, Plug, ScrollText, ShieldCheck, Send, FolderArchive, ExternalLink } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export const MY_ITEMS = [
  { id: 'profile',       label: 'Profile',       icon: UserCircle2,       to: '/settings?tab=profile' },
  { id: 'signin',        label: 'Sign-in',       icon: KeyRound,          to: '/settings?tab=signin' },
  { id: 'notifications', label: 'Notifications', icon: Bell,              to: '/settings?tab=notifications' },
  { id: 'mailbox',       label: 'My mailbox',    icon: Mail,              to: '/settings?tab=mailbox' },
  { id: 'theme',         label: 'Theme',         icon: Sun,               to: '/settings?tab=theme' },
  { id: 'mynav',         label: 'My Nav',        icon: SlidersHorizontal, to: '/settings?tab=mynav' },
]
export const LABEL_ITEMS = [
  { id: 'people',       label: 'People',       icon: Users,       to: '/team',    path: '/team' },
  { id: 'label',        label: 'Label',        icon: Building2,   to: '/settings?tab=label' },
  { id: 'integrations', label: 'Integrations', icon: Plug,        to: '/settings?tab=integrations' },
  { id: 'roles',        label: 'Roles',        icon: KeyRound,    to: '/settings?tab=roles' },
  { id: 'activity',     label: 'Activity',     icon: ScrollText,  to: '/activity', path: '/activity' },
  { id: 'admin',        label: 'Admin docs',   icon: ShieldCheck, to: '/admin',    path: '/admin', strict: true },
  { id: 'sandbox',      label: 'Sandbox',      icon: Send,        to: '/admin/vendor-lab', external: true },
  { id: 'archive',      label: 'Archive',      icon: FolderArchive, to: '/settings?tab=archive', superOnly: true },
]

export function activeSettingsItem(pathname, search, isAdmin) {
  const tab = new URLSearchParams(search).get('tab')
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    const all = [...MY_ITEMS, ...LABEL_ITEMS]
    return (all.find((i) => i.id === tab && !i.path) || MY_ITEMS[0]).id
  }
  for (const i of LABEL_ITEMS) if (i.path && (pathname === i.path || pathname.startsWith(i.path + '/'))) return i.id
  return null
}

export default function SettingsShell({ children }) {
  const { user, canView } = useAuth()
  const location = useLocation()
  const role = user?.role
  const isAdmin = role === 'Admin' || role === 'Superadmin'
  const labelItems = isAdmin
    ? LABEL_ITEMS.filter((i) => (!i.superOnly || role === 'Superadmin') && (!i.path || canView(i.path) || i.strict))
    : []
  const active = activeSettingsItem(location.pathname, location.search, isAdmin)

  const Item = ({ item }) => {
    const Icon = item.icon; const on = active === item.id
    const cls = `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${on ? 'bg-boom-50 text-boom-800 font-semibold' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`
    if (item.external) return <a href={item.to} target="_blank" rel="noopener noreferrer" className={cls} data-tab={item.id}><Icon size={15} strokeWidth={1.5} className={on ? 'text-boom-600' : 'text-gray-400'} />{item.label}<ExternalLink size={11} className="ml-auto text-gray-300" /></a>
    return <Link to={item.to} className={cls} data-tab={item.id} aria-current={on ? 'page' : undefined}><Icon size={15} strokeWidth={on ? 2 : 1.5} className={on ? 'text-boom-600' : 'text-gray-400'} />{item.label}</Link>
  }
  const Group = ({ title, items }) => (
    <div data-settings-section={title}>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 mb-1.5">{title}</p>
      <nav className="flex lg:flex-col gap-0.5 overflow-x-auto">{items.map((i) => <Item key={i.id} item={i} />)}</nav>
    </div>
  )

  return (
    <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10" data-settings-shell>
      <aside className="mb-6 lg:mb-0 lg:sticky lg:top-6 lg:self-start space-y-5">
        <Group title="My settings" items={MY_ITEMS} />
        {labelItems.length > 0 && <Group title="Label settings" items={labelItems} />}
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
