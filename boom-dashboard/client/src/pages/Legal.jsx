import { Scale } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/PageHeader'

export default function Legal() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'Admin' || user?.role === 'Superadmin'

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center">
        <h1 className="text-xl font-bold text-gray-900 mb-2">Not authorized</h1>
        <p className="text-sm text-gray-500">The Legal page is restricted to admins and superadmins.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <span className="inline-flex items-center px-3 py-1 bg-amber-200 text-amber-900 rounded-full text-xs font-bold tracking-wider uppercase">
          Work in progress
        </span>
      </div>
      <PageHeader
        title="Legal"
        subtitle="NDAs and miscellaneous legal documents"
      />

      <div className="card p-12 flex flex-col items-center justify-center text-center text-gray-400">
        <Scale className="w-10 h-10 mb-3 text-gray-300" />
        <p className="text-sm font-medium text-gray-500">Document storage coming soon</p>
        <p className="text-xs mt-1">This page will house NDAs, contractor agreements, and other legal records.</p>
      </div>
    </div>
  )
}
