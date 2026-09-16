import { useEffect } from 'react'

const KEY_DISPLAY = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Enter: '↵', Escape: 'Esc', ' ': 'Space',
}

function Kbd({ shortcut }) {
  const parts = []
  if (shortcut.meta) parts.push(navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl')
  if (shortcut.shift) parts.push('⇧')
  const display = KEY_DISPLAY[shortcut.key] || shortcut.key.toUpperCase()
  parts.push(display)
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {parts.map((p, i) => (
        <kbd key={i} style={{
          background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4,
          padding: '2px 6px', fontSize: 11, fontWeight: 700, fontFamily: 'system-ui, sans-serif',
          color: '#374151', lineHeight: '16px', minWidth: 20, textAlign: 'center',
          boxShadow: '0 1px 0 #d1d5db',
        }}>{p}</kbd>
      ))}
    </span>
  )
}

const SHORTCUT_GROUPS = [
  {
    title: 'Global',
    shortcuts: [
      { key: '?', label: 'Show this help' },
      { key: '/', label: 'Focus search' },
      { key: 'k', meta: true, label: 'Focus search' },
      { key: 'Escape', label: 'Close modal / panel' },
    ],
  },
  {
    title: 'Releases',
    shortcuts: [
      { key: 'n', label: 'New release' },
      { key: 'j', label: 'Next release' },
      { key: 'k', label: 'Previous release' },
      { key: 'Enter', label: 'Expand / collapse release' },
      { key: '1', label: 'Checklist tab' },
      { key: '2', label: 'Metadata tab' },
      { key: '3', label: 'DSP tab' },
      { key: '4', label: 'Budget tab' },
      { key: '5', label: 'Activity tab' },
      { key: '6', label: 'Comments tab' },
      { key: '7', label: 'Details tab' },
      { key: 'v', label: 'Toggle list / calendar view' },
    ],
  },
  {
    title: 'Ledger',
    shortcuts: [
      { key: 'z', label: 'Undo last change' },
      { key: 'c', label: 'Toggle columns panel' },
      { key: 'x', label: 'Export Excel' },
    ],
  },
  {
    title: 'Deal Pipeline',
    shortcuts: [
      { key: 'n', label: 'New deal' },
    ],
  },
  {
    title: 'Approvals',
    shortcuts: [
      { key: 'j', label: 'Next entry' },
      { key: 'k', label: 'Previous entry' },
      { key: 'a', label: 'Approve focused entry' },
      { key: 'r', label: 'Reject focused entry' },
      { key: 'a', shift: true, label: 'Bulk approve all' },
    ],
  },
  {
    title: 'Create Invoice',
    shortcuts: [
      { key: 'Enter', meta: true, label: 'Create / update invoice' },
      { key: 'l', meta: true, shift: true, label: 'Add line item' },
      { key: 'p', meta: true, label: 'Print / PDF' },
    ],
  },
  {
    title: 'Calendar',
    shortcuts: [
      { key: 'ArrowLeft', label: 'Previous month' },
      { key: 'ArrowRight', label: 'Next month' },
      { key: 't', label: 'Jump to today' },
      { key: 'n', label: 'New event' },
    ],
  },
  {
    title: 'Catalog',
    shortcuts: [
      { key: 's', label: 'Sync artwork' },
      { key: '1', label: 'All time' },
      { key: '2', label: 'This year' },
      { key: '3', label: '6 months' },
      { key: '4', label: '12 months' },
      { key: '5', label: '2 years' },
      { key: '6', label: 'Custom range' },
    ],
  },
  {
    title: 'Other Pages',
    shortcuts: [
      { key: 'n', label: 'New item (Contracts, Team, Settings)' },
      { key: 'r', label: 'Refresh (Dashboard)' },
      { key: 's', label: 'Toggle sort (Activity History)' },
      { key: '1', label: 'Tab / view 1' },
      { key: '2', label: 'Tab / view 2' },
      { key: '3', label: 'Tab / view 3' },
    ],
  },
]

export default function KeyboardShortcutsHelp({ open, onClose }) {
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, width: 640, maxHeight: '80vh',
          overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)',
        }}
      >
        <div style={{
          padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, background: '#fff', borderRadius: '12px 12px 0 0', zIndex: 1,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            style={{
              background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '4px 10px',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#6b7280',
            }}
          >
            ESC
          </button>
        </div>

        <div style={{ padding: '8px 24px 24px' }}>
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.title} style={{ marginTop: 16 }}>
              <h3 style={{
                fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: '#9ca3af', marginBottom: 8,
              }}>{group.title}</h3>
              <div style={{
                background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f0',
                overflow: 'hidden',
              }}>
                {group.shortcuts.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderBottom: i < group.shortcuts.length - 1 ? '1px solid #f0f0f0' : 'none',
                  }}>
                    <span style={{ fontSize: 13, color: '#374151' }}>{s.label}</span>
                    <Kbd shortcut={s} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
