// /invite/:token — a new teammate's first screen. Reads who the link is for,
// takes a password twice, signs them in. Every failure is a sentence: not
// valid, already used, expired — never a generic error.
import { useEffect, useState } from 'react'
import api from '../api'
import PasswordInput from '../components/PasswordInput'

export default function SetPassword() {
  const token = window.location.pathname.split('/invite/')[1] || ''
  const [who, setWho] = useState(null)
  const [problem, setProblem] = useState('')
  const [pw, setPw] = useState(''); const [again, setAgain] = useState('')
  const [saving, setSaving] = useState(false); const [err, setErr] = useState('')
  useEffect(() => {
    api.get(`/auth/invite/${encodeURIComponent(token)}`)
      .then((r) => setWho(r.data.data))
      .catch((e) => setProblem(e?.response?.data?.error || 'This invite link is not valid.'))
  }, [token])
  const submit = async (e) => {
    e.preventDefault(); setErr('')
    if (pw.length < 8) return setErr('Choose a password of at least 8 characters.')
    if (pw !== again) return setErr('The two passwords do not match.')
    setSaving(true)
    try {
      const r = await api.post(`/auth/invite/${encodeURIComponent(token)}`, { password: pw })
      localStorage.setItem('token', r.data.data.token)
      window.location.href = '/'
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not set the password'); setSaving(false) }
  }
  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="text-2xl font-bold text-gray-900 tracking-tight">Market Street</span>
          <p className="text-sm text-gray-500 mt-1">{who ? `Welcome, ${who.name.split(' ')[0]}. Set your password.` : 'Set your password'}</p>
        </div>
        <div className="card p-6" data-set-password>
          {problem ? (
            <div className="text-center">
              <p className="text-sm text-gray-700" data-invite-problem>{problem}</p>
              <a href="/login" className="inline-block mt-4 text-xs font-semibold text-boom-600 hover:underline">Go to sign in</a>
            </div>
          ) : !who ? <p className="text-sm text-gray-400 text-center">Checking your link…</p> : (
            <form onSubmit={submit} className="space-y-3">
              <p className="text-xs text-gray-500 text-center">Signing in as <span className="font-semibold text-gray-700">{who.email}</span></p>
              <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password (8+ characters)" autoComplete="new-password" autoFocus className="w-full text-sm border border-rule rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-boom-400" />
              <PasswordInput value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Password again" autoComplete="new-password" className="w-full text-sm border border-rule rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-boom-400" />
              {err && <p className="text-xs text-rose-600" data-invite-error>{err}</p>}
              <button type="submit" disabled={saving} className="w-full text-sm font-semibold bg-gray-900 text-white py-2.5 rounded-lg hover:bg-gray-800 disabled:opacity-40">{saving ? 'Setting…' : 'Set password and sign in'}</button>
              <p className="text-[11px] text-gray-400 text-center">This link works once and expires {new Date(who.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
