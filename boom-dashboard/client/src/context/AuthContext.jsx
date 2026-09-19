import React, { createContext, useContext, useState, useEffect, useMemo } from 'react'
import api from '../api'
import { canViewPath } from '../lib/pageAccess'
import { NAV_PAGES } from '../navConfig'

const AuthContext = createContext()

export const AuthProvider = ({ children }) => {
  const [user, setUser]   = useState(null)
  const [token, setToken] = useState(localStorage.getItem('token'))
  const [loading, setLoading] = useState(true)
  const [pagePermissions, setPagePermissions] = useState(null) // null = unrestricted

  // Impersonation — stash real admin token in a separate key while viewing as someone else
  const [impersonating, setImpersonating] = useState(!!localStorage.getItem('admin_token'))
  const [adminUser, setAdminUser]         = useState(null)

  useEffect(() => {
    if (token) {
      fetchUser()
    } else {
      setLoading(false)
    }
  }, [token])

  const fetchUser = async () => {
    try {
      const response = await api.get('/auth/me')
      const userData = response.data.data
      setUser(userData)
      setPagePermissions(userData.pagePermissions ?? null)
      // Cache the role on localStorage so the api.js interceptor can
      // decide whether to route through the mock adapter before React state
      // is available on the next boot.
      try {
        localStorage.setItem('boom_user_cache', JSON.stringify({
          id: userData.id, role: userData.role,
        }))
      } catch {}
    } catch (error) {
      console.error('Failed to fetch user:', error)
      logout()
    } finally {
      setLoading(false)
    }
  }

  const login = async (email, password) => {
    try {
      const response = await api.post('/auth/login', { email, password })
      const { token: newToken, user: userData } = response.data.data
      localStorage.setItem('token', newToken)
      try {
        localStorage.setItem('boom_user_cache', JSON.stringify({
          id: userData.id, role: userData.role,
        }))
      } catch {}
      setToken(newToken)
      setUser(userData)
      return { success: true }
    } catch (error) {
      const status = error.response?.status
      const serverMsg = error.response?.data?.error || error.response?.data?.message
      const detail = serverMsg
        ? `${serverMsg} (${status})`
        : error.message || 'Login failed'
      return { success: false, error: detail }
    }
  }

  const googleLogin = async (credential) => {
    try {
      const response = await api.post('/auth/google', { credential })
      const { token: newToken, user: userData } = response.data.data
      localStorage.setItem('token', newToken)
      try {
        localStorage.setItem('boom_user_cache', JSON.stringify({
          id: userData.id, role: userData.role,
        }))
      } catch {}
      setToken(newToken)
      setUser(userData)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Google sign-in failed'
      }
    }
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('admin_token')
    localStorage.removeItem('boom_user_cache')
    setToken(null)
    setUser(null)
    setPagePermissions(null)
    setImpersonating(false)
    setAdminUser(null)
  }

  // Swap into another user's session — stores the real token so we can come back.
  //
  // Critically: after the token swap, we re-fetch via /auth/me so the AuthContext
  // gets the TARGET user's full profile + pagePermissions. Without that
  // refetch, pagePermissions stayed at the admin's value (null = unrestricted),
  // so view-as'd users saw EVERY nav item even when their real account had
  // restricted permissions. Same flow login + exitImpersonation use.
  const impersonate = async (targetUserId) => {
    try {
      const res = await api.post(`/auth/impersonate/${targetUserId}`)
      const { token: impToken, user: impUser } = res.data.data
      localStorage.setItem('admin_token', localStorage.getItem('token'))
      setAdminUser(user)
      localStorage.setItem('token', impToken)
      setToken(impToken)
      setImpersonating(true)
      // Optimistic: paint the basic user we got back, then refetch the
      // full record (page permissions, boom_rep, ...).
      setUser(impUser)
      try {
        const me = await api.get('/auth/me')
        const userData = me.data.data
        setUser(userData)
        setPagePermissions(userData.pagePermissions ?? null)
        // Update boom_user_cache so the mock-adapter routing matches the
        // impersonated identity.
        try {
          localStorage.setItem('boom_user_cache', JSON.stringify({
            id: userData.id, role: userData.role,
          }))
        } catch {}
      } catch (meErr) {
        console.error('Impersonate /auth/me refetch failed:', meErr)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.response?.data?.error || 'Failed to impersonate' }
    }
  }

  // Return to your own session. Refetches /auth/me so pagePermissions
  // (and any other per-user state on the response) is restored to the
  // admin's own values rather than the impersonated user's.
  const exitImpersonation = () => {
    const adminToken = localStorage.getItem('admin_token')
    if (!adminToken) { logout(); return }
    localStorage.setItem('token', adminToken)
    localStorage.removeItem('admin_token')
    setToken(adminToken)
    setImpersonating(false)
    setAdminUser(null)
    api.get('/auth/me').then(res => {
      const userData = res.data.data
      setUser(userData)
      setPagePermissions(userData.pagePermissions ?? null)
      try {
        localStorage.setItem('boom_user_cache', JSON.stringify({
          id: userData.id, role: userData.role,
        }))
      } catch {}
    }).catch(() => logout())
  }

  // Page access rules live in lib/pageAccess.js — pure, so the whole matrix of
  // (account × route) can be asserted in node instead of by logging in as
  // somebody and clicking. App.jsx REDIRECTS on a false answer, so a mistake
  // here doesn't degrade a page, it removes it.
  // The paths the nav registers. Passed to canViewPath so a page that is itself
  // grantable never inherits access from a page that merely shares its prefix.
  const knownPages = useMemo(() => new Set(NAV_PAGES.map(p => p.path)), [])

  const canView = (path) =>
    user ? canViewPath(path, { role: user.role, pagePermissions, knownPages }) : false

  return (
    <AuthContext.Provider value={{ user, token, loading, login, googleLogin, logout, impersonate, exitImpersonation, impersonating, adminUser, pagePermissions, canView, refreshUser: fetchUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
