// Recoupment upload plan — a localStorage-backed working set that
// Recoupments (Pending tab) writes to and RecoupmentsPlanning reads
// from. Zero server involvement until "Done" fires on the planning
// page, at which point every planned item is bulk-marked UFR with
// its assigned label.
//
// Plan shape: { [expenseId: number]: labelString }
//   • Key present → item is in the plan
//   • Value = the recoupment_label to apply on Done
//   • Empty string → in plan but unlabeled (ungrouped)
//   • Key absent → not in plan
//
// Kept flat (no group objects) so items with the same label naturally
// render as a group without a second data structure to keep in sync.

const KEY = 'recoupment_plan_v2'

export function loadPlan() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Coerce keys to numeric-string-safe form and drop anything weird.
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(k)
      if (!Number.isFinite(id)) continue
      out[id] = typeof v === 'string' ? v : ''
    }
    return out
  } catch { return {} }
}

export function savePlan(plan) {
  try { localStorage.setItem(KEY, JSON.stringify(plan)) } catch {}
}

export function addToPlan(ids, label = '') {
  const plan = loadPlan()
  for (const id of ids) {
    const n = Number(id)
    if (!Number.isFinite(n)) continue
    // Preserve any existing label if the caller passes '' — that way
    // "Add to plan" a second time doesn't wipe a label you already set.
    if (n in plan && label === '') continue
    plan[n] = label
  }
  savePlan(plan)
  return plan
}

export function removeFromPlan(ids) {
  const plan = loadPlan()
  for (const id of ids) delete plan[Number(id)]
  savePlan(plan)
  return plan
}

export function setLabelForItems(ids, label) {
  const plan = loadPlan()
  const safe = typeof label === 'string' ? label : ''
  for (const id of ids) {
    const n = Number(id)
    if (n in plan) plan[n] = safe
  }
  savePlan(plan)
  return plan
}

export function relabelGroup(oldLabel, newLabel) {
  const plan = loadPlan()
  const safeOld = typeof oldLabel === 'string' ? oldLabel : ''
  const safeNew = typeof newLabel === 'string' ? newLabel : ''
  for (const id of Object.keys(plan)) {
    if (plan[id] === safeOld) plan[id] = safeNew
  }
  savePlan(plan)
  return plan
}

export function clearPlan() {
  savePlan({})
}

// Convenience — is a given id in the plan?
export function isInPlan(plan, id) {
  return Number(id) in plan
}

// Convenience — how many items are currently in the plan?
export function planSize(plan) {
  return Object.keys(plan).length
}
