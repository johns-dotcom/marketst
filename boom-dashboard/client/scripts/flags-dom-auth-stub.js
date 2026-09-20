// Auth for the Flags harness: role and hierarchy level per scenario, and a
// canView that follows the scenario (a /releases-only User for `user`).
export const useAuth = () => {
  const sc = globalThis.__FLAGS_SCENARIO__ || 'admin'
  const user = sc === 'user'
    ? { id: 3, name: 'Rosa Lind', email: 'rosa@example.test', role: 'User', hierarchy_level: 4 }
    : { id: 1, name: 'John Skead', email: 'john@deanst.co', role: 'Superadmin', hierarchy_level: 1 }
  const allow = sc === 'user' ? new Set(['/', '/my-work', '/messages', '/calendar', '/flags', '/releases', '/catalog']) : null
  return {
    user, token: 'test', pagePermissions: null,
    canView: (p) => !allow || allow.has(p),
    logout() {}, login: async () => {}, isImpersonating: false,
  }
}
export const AuthProvider = ({ children }) => children
