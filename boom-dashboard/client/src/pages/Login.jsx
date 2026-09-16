import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GoogleLogin } from '@react-oauth/google'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const [error, setError] = useState('')
  const { googleLogin, login } = useAuth()
  const navigate = useNavigate()
  const expired = new URLSearchParams(window.location.search).get('expired') === '1'

  // Email/password login
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleGoogleSuccess = async (credentialResponse) => {
    setError('')
    const result = await googleLogin(credentialResponse.credential)
    if (result.success) {
      navigate('/')
    } else {
      setError(result.error)
    }
  }

  const handleGoogleError = () => {
    setError('Google sign-in was cancelled or failed. Try again.')
  }

  const handleEmailLogin = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setError('')
    setSubmitting(true)
    const result = await login(email.trim(), password)
    if (result.success) {
      navigate('/')
    } else {
      setError(result.error)
    }
    setSubmitting(false)
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2.5 mb-3">
            <div className="w-10 h-10 bg-boom-600 rounded-xl flex items-center justify-center">
              <span className="text-white font-bold text-lg">B</span>
            </div>
            <span className="text-2xl font-bold text-gray-900 tracking-tight">Market Street</span>
          </div>
          <p className="text-sm text-gray-500">Sign in to your dashboard</p>
        </div>

        {/* Sign-in Card */}
        <div className="card p-6 flex flex-col items-center gap-4">
          <p className="text-xs text-gray-400 text-center">
            Use your Market Street Google account
          </p>

          <GoogleLogin
            onSuccess={handleGoogleSuccess}
            onError={handleGoogleError}
            useOneTap
            theme="outline"
            size="large"
            width="280"
          />

          {/* Divider */}
          <div className="flex items-center gap-3 w-full">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          {/* Email/password form */}
          <form onSubmit={handleEmailLogin} className="w-full space-y-3">
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full text-sm border border-rule rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full text-sm border border-rule rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300"
            />
            <button
              type="submit"
              disabled={submitting || !email.trim() || !password.trim()}
              className="w-full text-sm font-semibold bg-gray-900 text-white py-2.5 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-40"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {expired && !error && (
            <div className="w-full bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
              <p className="text-amber-700 text-xs text-center font-medium">Your session has expired. Please sign in again.</p>
            </div>
          )}
          {error && (
            <div className="w-full bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
              <p className="text-red-600 text-xs text-center">{error}</p>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Market Street Admin Dashboard
        </p>
      </div>
    </div>
  )
}
