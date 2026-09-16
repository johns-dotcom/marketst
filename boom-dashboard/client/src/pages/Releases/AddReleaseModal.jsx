import { useState } from 'react'
import { X } from 'lucide-react'
import api from '../../api'
import { BLANK_RELEASE } from './constants'

/**
 * Self-contained "Add Release" modal.
 *
 * Owns its own form state and the POST. The parent stays free of Add-Release-
 * specific state — it just renders <AddReleaseModal show onClose onCreated
 * artists /> and handles the new row via the `onCreated` callback.
 */
export default function AddReleaseModal({ show, onClose, onCreated, artists }) {
  const [form, setForm]     = useState(BLANK_RELEASE)
  const [saving, setSaving] = useState(false)

  if (!show) return null

  const update = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const response = await api.post('/releases', {
        ...form,
        artist_name: form.artist_name || null,
      })
      onCreated(response.data.data)
      setForm(BLANK_RELEASE)
      onClose()
    } catch {
      alert('Failed to create release')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-overlay backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl shadow-modal max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-divider">
          <h2 className="text-lg font-semibold text-gray-900">Add New Release</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Artist Name</label>
              <input type="text" value={form.artist_name} onChange={e => update('artist_name', e.target.value)} list="artist-list-new" required className="input-base" placeholder="Artist or band name" />
              <datalist id="artist-list-new">{artists.map(a => <option key={a.id} value={a.name} />)}</datalist>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Project Name</label>
              <input type="text" value={form.project_name} onChange={e => update('project_name', e.target.value)} required className="input-base" placeholder="Album or single title" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Release Date</label>
              <input type="date" value={form.release_date} onChange={e => update('release_date', e.target.value)} required className="input-base" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Release Type</label>
              <select value={form.release_type} onChange={e => update('release_type', e.target.value)} className="select-base w-full">
                <option value="">Select type</option>
                <option value="Single">Single</option>
                <option value="EP">EP</option>
                <option value="Album">Album</option>
                <option value="Compilation">Compilation</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Genre</label>
              <input type="text" value={form.genre} onChange={e => update('genre', e.target.value)} className="input-base" placeholder="e.g. Hip-Hop" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Priority</label>
              <select value={form.priority} onChange={e => update('priority', e.target.value)} className="select-base w-full">
                <option value="standard">Standard</option>
                <option value="priority">Priority</option>
                <option value="high priority">High Priority</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">UPC</label>
              <input type="text" value={form.upc} onChange={e => update('upc', e.target.value)} className="input-base" placeholder="UPC code" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">ISRC</label>
              <input type="text" value={form.isrc} onChange={e => update('isrc', e.target.value)} className="input-base" placeholder="ISRC code" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Producer</label>
              <input type="text" value={form.producer} onChange={e => update('producer', e.target.value)} className="input-base" placeholder="Producer name" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Featured Artists</label>
              <input type="text" value={form.featured_artists} onChange={e => update('featured_artists', e.target.value)} className="input-base" placeholder="Comma-separated" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Notes</label>
            <textarea value={form.notes} onChange={e => update('notes', e.target.value)} className="input-base resize-none" rows={2} placeholder="Internal notes..." />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? 'Creating...' : 'Create Release'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
