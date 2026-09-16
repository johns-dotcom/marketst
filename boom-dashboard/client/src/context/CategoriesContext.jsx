// Bookkeeping category vocabularies — pulled from /api/categories once on
// mount and on tab focus. Replaces the static CATEGORIES / INCOME_CATEGORIES
// constants from src/constants.js so categories can be added from Statements
// and Reports without a code deploy.
//
// Deliberately the same shape as BoomRepsContext: the constants stay as a
// last-resort fallback so a failed fetch shows the historical list rather than
// an empty dropdown, and a network blip never blanks a select the user is
// about to change.
//
// ── The off-list problem ──
// expenses.category and artist_income.income_type are FREE TEXT. A row can
// hold a value that isn't in the active list: history predating this table, a
// category since deactivated, or an import. A bare <select> whose value isn't
// among its options renders BLANK — and the user, seeing an empty category,
// picks something and silently recategorizes the row.
//
// withValue() exists to prevent exactly that: it returns the option list with
// the row's current value appended if missing, so every select can render its
// own value. Use it anywhere a stored category is editable.

import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import api from '../api'
import { CATEGORIES as FALLBACK_EXPENSE, INCOME_CATEGORIES as FALLBACK_INCOME } from '../constants'
import { CATEGORY_GROUP_SEED, CATEGORY_GROUPS } from '../constants'

// The same shaping the server does, for the OFFLINE FALLBACK only.
//
// When /api/categories is unreachable the flat vocabulary comes from the
// constants; without this the sections would vanish exactly when the picker is
// already degraded. Mirrors routes/categories.js `shape()`, and returns `order`
// derived from `groups` for the same reason: CategorySelect numbers by index and
// the review decks resolve a keypress by the same index, so two separately-built
// orders drift and have drifted.
function shapeFallback(kind, names) {
  const defs = CATEGORY_GROUPS[kind] || []
  const seed = CATEGORY_GROUP_SEED[kind] || {}
  const groupOf = new Map()
  for (const [key, list] of Object.entries(seed)) {
    for (const n of list) groupOf.set(n.toLowerCase(), key)
  }
  const bucket = new Map(defs.map(([key]) => [key, []]))
  for (const name of names) {
    const key = groupOf.get(String(name).toLowerCase())
    const target = bucket.has(key) ? key : defs[defs.length - 1]?.[0]
    if (target != null) bucket.get(target).push(name)
  }
  const groups = defs
    .map(([key, label]) => ({ key, label, items: bucket.get(key) || [] }))
    .filter((g) => g.items.length > 0)
  return { groups, order: groups.flatMap((g) => g.items) }
}
const FALLBACK_EXPENSE_SHAPE = shapeFallback('expense', FALLBACK_EXPENSE)
const FALLBACK_INCOME_SHAPE = shapeFallback('income', FALLBACK_INCOME)

const CategoriesContext = createContext({
  expense: FALLBACK_EXPENSE,
  income: FALLBACK_INCOME,
  expenseGroups: FALLBACK_EXPENSE_SHAPE.groups,
  expenseOrder: FALLBACK_EXPENSE_SHAPE.order,
  incomeGroups: FALLBACK_INCOME_SHAPE.groups,
  incomeOrder: FALLBACK_INCOME_SHAPE.order,
  custom: [],
  loading: true,
  refresh: () => {},
  create: async () => {},
})

export function CategoriesProvider({ children }) {
  const [expense, setExpense] = useState(FALLBACK_EXPENSE)
  const [income, setIncome] = useState(FALLBACK_INCOME)
  // ADDITIVE. `expense` / `income` keep meaning the flat, usage-ranked
  // vocabulary, so the dozen callers that read them are untouched; the grouped
  // shape is adopted per picker.
  const [expenseShape, setExpenseShape] = useState(FALLBACK_EXPENSE_SHAPE)
  const [incomeShape, setIncomeShape] = useState(FALLBACK_INCOME_SHAPE)
  const [custom, setCustom] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/categories')
      const d = res.data?.data
      // Only overwrite on a real non-empty array, same guard as the reps
      // provider — a blip must not empty a dropdown.
      if (Array.isArray(d?.expense) && d.expense.length) setExpense(d.expense)
      if (Array.isArray(d?.income) && d.income.length) setIncome(d.income)
      // Same non-empty guard: a blip must not collapse the sections either. And
      // `order` is taken from the SERVER rather than re-derived here — one
      // flatten, one source, so the numbering can't disagree with the render.
      if (Array.isArray(d?.expense_groups) && d.expense_groups.length) {
        setExpenseShape({ groups: d.expense_groups, order: d.expense_order || [] })
      }
      if (Array.isArray(d?.income_groups) && d.income_groups.length) {
        setIncomeShape({ groups: d.income_groups, order: d.income_order || [] })
      }
      if (Array.isArray(d?.custom)) setCustom(d.custom)
    } catch (err) {
      console.warn('Failed to fetch categories:', err?.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // Refetch on tab focus so a category added in one tab appears in another
    // without a hard refresh. /api/categories is a small table, no joins.
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Create and immediately make available. Returns the created name so the
  // caller can select it in one gesture, which is the whole point of creating
  // a category from the page you're categorizing on.
  //
  // Optimistically inserts into local state before the refetch so the new
  // option is selectable on the very next render — without it, the <select>
  // would briefly have no matching option and blank out.
  const create = useCallback(async (name, kind = 'expense') => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('Name is required')
    const res = await api.post('/categories', { name: clean, kind })
    const created = res.data?.data?.name || clean
    // APPEND, don't sort. The order is the server's, and it is now RANKED BY
    // REAL USAGE (routes/categories.js) with sort_order as the tiebreak — so a
    // brand-new category, having no usage, lands last either way. The review
    // deck's 1-9 hotkeys index this list —
    // alphabetizing here would reorder the options mid-session and silently
    // remap those keys. Custom categories go last, which is also where the
    // server's `sort_order ASC NULLS LAST` puts them.
    const append = (prev) => (prev.some((c) => c.toLowerCase() === created.toLowerCase()) ? prev : [...prev, created])
    // The GROUPED shape needs the same optimistic append, for the same reason the
    // flat one does: a grouped picker renders from `groups`, so without this the
    // category it just created would be missing from the menu until the refetch
    // landed — and a <select> whose value has no option renders BLANK, which is
    // the exact failure this optimism exists to prevent.
    //
    // It goes in the LAST group, which is where the server's `ui_group` default
    // of 'other' will put it a moment later. `order` is re-flattened from the
    // groups so the two never disagree even for that moment.
    const appendShape = (prev) => {
      if (prev.order.some((c) => c.toLowerCase() === created.toLowerCase())) return prev
      const groups = prev.groups.map((g, i) => (
        i === prev.groups.length - 1 ? { ...g, items: [...g.items, created] } : g
      ))
      return { groups, order: groups.flatMap((g) => g.items) }
    }
    if (kind === 'income') { setIncome(append); setIncomeShape(appendShape) }
    else { setExpense(append); setExpenseShape(appendShape) }
    refresh()
    return created
  }, [refresh])

  const value = useMemo(
    () => ({
      expense, income, custom, loading, refresh, create,
      expenseGroups: expenseShape.groups, expenseOrder: expenseShape.order,
      incomeGroups: incomeShape.groups, incomeOrder: incomeShape.order,
    }),
    [expense, income, expenseShape, incomeShape, custom, loading, refresh, create]
  )
  return <CategoriesContext.Provider value={value}>{children}</CategoriesContext.Provider>
}

// Full context — options, loading, refresh, create.
export function useCategoriesContext() {
  return useContext(CategoriesContext)
}

// Expense categories. Always returns an array so callers render unconditionally.
export function useCategories() {
  return useContext(CategoriesContext).expense
}

// Income types.
export function useIncomeCategories() {
  return useContext(CategoriesContext).income
}

// The grouped vocabulary: `{ groups: [{ key, label, items }], order: [...] }`.
//
// ALWAYS use `order` — never a fresh flatten — anywhere options are numbered or
// indexed by position. It is the server's flatten of the very groups being
// rendered, and keeping one source is what stops the menu saying "1 · X" while
// pressing 1 selects Y.
export function useCategoryGroups(kind = 'expense') {
  const ctx = useContext(CategoriesContext)
  return kind === 'income'
    ? { groups: ctx.incomeGroups || [], order: ctx.incomeOrder || [] }
    : { groups: ctx.expenseGroups || [], order: ctx.expenseOrder || [] }
}

// Append `value` to `list` when it isn't already there, so a <select> can
// always render its own current value instead of going blank. Returns the list
// unchanged when the value is empty or already present.
export function withValue(list, value) {
  const v = String(value || '').trim()
  if (!v) return list
  return list.some((c) => c.toLowerCase() === v.toLowerCase()) ? list : [...list, v]
}
