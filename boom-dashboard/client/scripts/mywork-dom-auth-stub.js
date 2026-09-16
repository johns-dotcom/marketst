// Auth, stubbed: the real provider reads localStorage and talks to the network,
// neither of which is what is under test here.
export const useAuth = () => ({
  user: { id: 1, name: 'John', email: 'john@deanst.co', role: 'Superadmin' },
  token: 'test', pagePermissions: null, canView: () => true,
  logout() {}, login: async () => {}, isImpersonating: false,
})
export const AuthProvider = ({ children }) => children
