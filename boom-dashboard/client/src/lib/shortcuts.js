// THE keyboard vocabulary (2026-09-20, John: "what other keyboard shortcuts
// would be useful?" — his calls: g-then-letter chords for navigation, ONE
// vocabulary on every list page even where it renames an old key, keys on
// Flags / Payments / Approvals / Ledger / Vendors / Roster / Contracts / forms,
// and discovery by a context-aware ? help, hover hints, a one-time toast and
// a step in every page tour).
//
// One file, three readers: hooks/usePageShortcuts binds a page's handlers to
// THESE keys and labels; components/KeyboardShortcutsHelp lists the current
// page's group; tours/index.js appends a "Keys on this page" step from the
// same list. A page cannot advertise a key it does not bind, or bind one the
// help does not know.
//
// The vocabulary (a key means the same thing on every page that has it):
//   j / k        next / previous row          Enter   open the focused row
//   e            edit the focused row          x       select the focused row
//   f            focus the filter box          n       new (whatever the page makes)
//   .            refresh / run the checks now  s       sort          y   sync
//   [ / ]        previous / next section       z, ⌘Z   undo
//   Esc          close a modal or clear        ?       this help    /  ⌘K  search
//   g then …     go to a page (GOTO below)

// 'meta+shift+l' → { key: 'l', meta: true, shift: true }. Named keys keep their case.
export function parseKey(spec) {
  const parts = String(spec).split('+')
  const key = parts.pop()
  return { key, meta: parts.includes('meta'), shift: parts.includes('shift'), spec }
}

const K = (spec, label) => ({ ...parseKey(spec), label })
const LIST = [K('j', 'Next row'), K('k', 'Previous row')]

export const PAGE_KEYS = {
  '/': [K('.', 'Refresh'), K('1', 'Open the first loop tile'), K('2', 'Second tile'), K('3', 'Third tile'), K('4', 'Fourth tile'), K('5', 'Fifth tile'), K('6', 'Sixth tile')],
  '/my-work': [K('n', 'New task (focus the composer)')],
  '/flags': [...LIST, K('Enter', 'Open where the focused flag is resolved'), K('a', 'Assign the focused flag'), K('d', 'Dismiss it'), K('s', 'Snooze it'), K('[', 'Previous category'), K(']', 'Next category'), K('f', 'Focus the filter'), K('.', 'Check now (admins) or reload')],
  '/bk/approvals': [...LIST, K('a', 'Approve the focused invoice'), K('r', 'Reject it'), K('shift+a', 'Approve everything listed (opens the checklist deck)'), K('f', 'Focus the search'), K('.', 'Reload')],
  '/bk/payments': [...LIST, K('p', 'Mark the focused invoice paid'), K('h', 'Put it on hold'), K('u', 'Request a rush'), K('x', 'Select it'), K('Enter', 'Edit it'), K('f', 'Focus the search'), K('.', 'Reload')],
  '/bk/ledger': [...LIST, K('Enter', 'Open the focused row'), K('x', 'Select the focused row'), K('c', 'Toggle the columns panel'), K('shift+x', 'Export what is on screen to Excel'), K('z', 'Undo the last change'), K('f', 'Focus the search')],
  '/bk/vendors': [...LIST, K('Enter', 'Open the focused vendor'), K('f', 'Focus the search')],
  '/artists': [...LIST, K('Enter', 'Open the focused artist'), K('n', 'Add an artist'), K('f', 'Focus the search')],
  '/contracts': [...LIST, K('Enter', 'Open the focused contract'), K('n', 'New contract'), K('f', 'Focus the search')],
  '/releases': [K('n', 'New release'), K('v', 'Toggle list / calendar'), ...LIST, K('Enter', 'Expand / collapse the focused release'), K('1', 'Checklist tab'), K('2', 'Metadata tab'), K('3', 'DSP tab'), K('4', 'Budget tab'), K('5', 'Activity tab'), K('6', 'Comments tab'), K('7', 'Details tab')],
  '/catalog': [K('y', 'Sync artwork from Spotify'), K('1', 'All time'), K('2', 'This year'), K('3', 'Six months'), K('4', 'Twelve months'), K('5', 'Two years'), K('6', 'Custom range'), K('f', 'Focus the search')],
  '/calendar': [K('ArrowLeft', 'Previous month'), K('ArrowRight', 'Next month'), K('t', 'Today'), K('n', 'New event')],
  '/deals': [K('n', 'New deal')],
  '/team': [K('n', 'New task for someone'), K('1', 'First view'), K('2', 'Second view'), K('3', 'Third view'), K('4', 'Fourth view')],
  '/activity': [K('s', 'Flip the sort'), K('f', 'Focus the search')],
  '/create-invoice': [K('meta+Enter', 'Create or update the invoice'), K('meta+shift+l', 'Add a line item'), K('meta+p', 'Print / PDF')],
  '/messages': [K('meta+Enter', 'Send')],
}

// g-then-letter. Filtered by canView where it is offered.
export const GOTO = [
  ['h', '/', 'Home'], ['m', '/my-work', 'My Work'], ['f', '/flags', 'Flags'], ['c', '/calendar', 'Calendar'], ['i', '/messages', 'Messages'],
  ['t', '/artists', 'Roster'], ['r', '/releases', 'Releases'], ['d', '/deals', 'Deals'], ['k', '/contracts', 'Contracts'],
  ['a', '/bk/approvals', 'Approvals'], ['p', '/bk/payments', 'Payments'], ['l', '/bk/ledger', 'Ledger'], ['b', '/bk/bank-matching', 'Bank'], ['v', '/bk/vendors', 'Vendors'],
  ['e', '/reports', 'Reports'], ['o', '/recoupments', 'Recoupments'], ['s', '/settings', 'Settings'],
]

export const GLOBAL_KEYS = [
  K('?', 'This help'), K('/', 'Search'), K('meta+k', 'Search'), K('g', 'then a letter: go to a page (see below)'), K('meta+z', 'Undo the last undoable change on the page'), K('Escape', 'Close a modal or panel'),
]

const DISPLAY = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: '↵', Escape: 'Esc', ' ': 'Space' }
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '')
export const keyLabel = (k) => [k.meta ? (isMac ? '⌘' : 'Ctrl') : null, k.shift ? '⇧' : null, DISPLAY[k.key] || (k.key.length === 1 ? k.key.toUpperCase() : k.key)].filter(Boolean).join('')

// One sentence for a tour step or a hint: "j / k move, Enter opens, …".
export function keysSentence(path) {
  const list = PAGE_KEYS[path] || []
  if (!list.length) return ''
  return list.map((k) => `${keyLabel(k)} ${k.label.charAt(0).toLowerCase()}${k.label.slice(1)}`).join(' · ')
}
