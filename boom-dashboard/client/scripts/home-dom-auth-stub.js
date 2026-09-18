// Auth, stubbed, with a CONFIGURABLE canView. The shared mywork stub answers
// true for every path, which cannot test the one thing the Home page must get
// right: a tile renders only for somebody who can open its destination.
// The entry sets window.__HOME_ALLOW__ (a Set of paths) before render; absent
// means everything is allowed.
export const useAuth = () => ({
  user: { id: 1, name: 'John', email: 'john@deanst.co', role: globalThis.__HOME_ROLE__ || 'Superadmin' },
  token: 'test',
  pagePermissions: null,
  canView: (p) => !globalThis.__HOME_ALLOW__ || globalThis.__HOME_ALLOW__.has(p),
  logout() {}, login: async () => {}, isImpersonating: false,
})
export const AuthProvider = ({ children }) => children
