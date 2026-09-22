// The roles, described from the code that enforces them — the STATIC seed,
// read from lib/org.seed.json. The four BASE roles (Superadmin · Admin ·
// Approver · User) are what the API checks in ~90 places; a role a Superadmin
// creates in Settings › Roles & teams is a NAME on top of one of them
// (`base_role`) with its own description and starting presets. The live list
// comes through hooks/useOrg.js; this module is the fallback and what the
// person form reads before the server answers.
import seed from './org.seed.json'

export const BASE_ROLES = ['Superadmin', 'Admin', 'Approver', 'User']
export const ROLES = seed.roles.map((r) => ({ ...r, id: r.key }))
export const roleById = (id, roles = ROLES) => roles.find((r) => r.key === id || r.id === id) || null
/** The base role the API enforces for a role key (custom or base). */
export const baseRoleOf = (key, roles = ROLES) => (BASE_ROLES.includes(key) ? key : (roleById(key, roles)?.base_role || 'User'))
// The three other things people confuse with a role.
export const AXES = seed.axes
