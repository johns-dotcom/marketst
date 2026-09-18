// Role presets — the starting page set for a kind of teammate. ONE definition,
// pure, read by Settings (the user form and the Permissions editor) and by
// client/scripts/navpresets-fixture.mjs.
//
// ADDITIVE, NOT EXCLUSIVE. John, 2026-09-18: "some people are both marketing
// and a&r". Permissions are stored per user as a list of paths, and a user can
// hold any set, so a preset is a bundle of paths and two presets UNION. There
// is no concept of "the user's role preset" anywhere — only the rows.
//
// Every path here must exist in NAV_PAGES; `unionPaths` filters against it so a
// preset can never grant a page the app no longer has, and the fixture asserts
// the lists are clean so a typo is caught before it is a silent no-op.
//
// Hidden pages (Financials, Salary, …) are deliberately absent from every
// preset except `ops`: they are off the sidebar because nothing at Market
// Street produces their data yet, and a grant to a page nobody can find is a
// support question waiting to happen.

import { NAV_PAGES } from '../navConfig'

const ALL_PATHS = NAV_PAGES.map((p) => p.path)

// What every teammate gets regardless of job. '/' and '/messages' are on the
// BASE_WHITELIST anyway; they are listed so a preset reads as a complete answer.
// Flags is here by John's call (2026-09-18: "Everyone") — its money-shaped
// sections are gated server-side by role, so the row itself is safe to show.
const COMMON = ['/', '/my-work', '/messages', '/calendar', '/flags']

export const PRESETS = [
  {
    key: 'anr',
    label: 'A&R / creative',
    department: 'A&R',
    description: 'Artists, releases, deals, contracts and the document generators. No money pages.',
    paths: [
      ...COMMON,
      '/artists',
      '/releases', '/catalog',
      '/deals', '/contracts', '/pending-contracts', '/renewals',
      '/contracts/create', '/create-nda', '/create-label-waiver', '/create-artist-clearance', '/create-invoice',
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    department: 'Marketing',
    description: 'Releases, the artist spend sheets and campaigns, and the Add tab so they can enter an invoice without seeing the queues.',
    paths: [
      ...COMMON,
      '/artists',
      '/releases', '/catalog',
      '/artist-budgets', '/artist-campaigns', '/bk/advertising',
      '/bk/add',
    ],
  },
  {
    key: 'bookkeeper',
    label: 'Bookkeeper / finance',
    department: 'Finance',
    description: 'Invoices, Bank, Vendors, Reports, Recoupments and Artist Spend. No roster or release tracking.',
    paths: [
      ...COMMON,
      '/bk/approvals', '/bk/payments', '/bk/ledger', '/bk/creators', '/bk/add',
      '/bk/bank-matching', '/bk/bank-ledger', '/bk/statements', '/bk/rules',
      '/bk/vendors', '/bk/1099',
      '/reports',
      '/recoupments', '/recoupments/planning', '/recoupments/audit',
      '/artist-budgets', '/artist-campaigns', '/bk/advertising',
    ],
  },
  {
    key: 'ops',
    label: 'Ops / admin (everything)',
    department: 'Operations',
    description: 'Every page, including the ones hidden from the sidebar. The same set an unrestricted admin sees.',
    paths: ALL_PATHS,
  },
]

// Which presets a department implies when an account is created. A department
// is a single value on the user row, so this is the DEFAULT tick, not the
// ceiling — the form lets an admin tick a second preset before saving.
const DEPARTMENT_PRESETS = {
  'A&R':        ['anr'],
  'Marketing':  ['marketing'],
  'Finance':    ['bookkeeper'],
  'Operations': ['ops'],
}

export const DEPARTMENTS = Object.keys(DEPARTMENT_PRESETS)

export function presetsForDepartment(department) {
  return DEPARTMENT_PRESETS[department] || []
}

export function presetByKey(key) {
  return PRESETS.find((p) => p.key === key) || null
}

/**
 * The union of the named presets' paths, deduped, in NAV_PAGES order, and
 * filtered to pages that exist. Unknown keys contribute nothing.
 */
export function unionPaths(keys) {
  const want = new Set()
  for (const k of keys) for (const p of presetByKey(k)?.paths || []) want.add(p)
  return ALL_PATHS.filter((p) => want.has(p))
}

/** Add a list of paths to an existing selection — the editor's "apply" is this. */
export function addPaths(current, paths) {
  const known = new Set(ALL_PATHS)
  const next = new Set(current)
  for (const p of paths) if (known.has(p)) next.add(p)
  return next
}
