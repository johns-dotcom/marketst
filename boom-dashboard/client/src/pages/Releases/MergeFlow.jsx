import { useState } from 'react'
import { Copy } from 'lucide-react'
import api from '../../api'
import { formatDate } from '../../utils'

/**
 * Merge flow — floating action bar + modal. The parent owns the selection map
 * (so the per-row checkbox in the list can toggle it). This component owns
 * the modal visibility, the target-selection radio, and the POST. On success
 * it hands the parent the source ids to drop from its releases state.
 */
export default function MergeFlow({ selectedForMerge, onClearSelection, onMerged }) {
  const [mergeModalOpen, setMergeModalOpen] = useState(false)
  const [mergeTargetId,  setMergeTargetId]  = useState(null)
  const [merging,        setMerging]        = useState(false)

  const selectedCount = Object.keys(selectedForMerge).length

  const confirmMerge = async () => {
    if (!mergeTargetId) return
    const ids = Object.keys(selectedForMerge).map(Number)
    const sourceIds = ids.filter(id => id !== mergeTargetId)
    if (sourceIds.length === 0) return
    setMerging(true)
    try {
      await api.post('/releases/merge', { target_id: mergeTargetId, source_ids: sourceIds })
      onMerged(sourceIds)
      onClearSelection()
      setMergeModalOpen(false)
      setMergeTargetId(null)
    } catch (err) {
      alert('Merge failed: ' + (err.response?.data?.error || err.message))
    } finally {
      setMerging(false)
    }
  }

  return (
    <>
      {/* Floating merge action bar — appears when 2+ releases are checkbox-selected */}
      {selectedCount >= 2 && !mergeModalOpen && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-gray-900 text-white rounded-full shadow-xl px-5 py-2.5 flex items-center gap-3">
          <Copy size={14} className="text-rose-300" />
          <span className="text-sm font-semibold">{selectedCount} selected</span>
          <button
            onClick={() => { setMergeTargetId(null); setMergeModalOpen(true) }}
            className="text-xs font-semibold bg-rose-600 hover:bg-rose-700 px-3 py-1.5 rounded-full transition-colors"
          >
            Merge into one…
          </button>
          <button
            onClick={onClearSelection}
            className="text-xs text-gray-300 hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {/* Merge modal — pick which release to keep */}
      {mergeModalOpen && (
        <div className="fixed inset-0 bg-overlay z-50 flex items-center justify-center p-4" onClick={() => !merging && setMergeModalOpen(false)}>
          <div className="bg-card rounded-2xl shadow-xl max-w-xl w-full p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-bold text-gray-900 mb-1">Merge {selectedCount} releases</h2>
            <p className="text-xs text-gray-500 mb-4">Pick which one to keep. The others will be permanently deleted and their metadata, comments, tasks, and budget items will be folded into the one you keep.</p>
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {Object.values(selectedForMerge).map(r => {
                const isTarget = mergeTargetId === r.id
                return (
                  <label
                    key={r.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                      isTarget ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-100 hover:border-gray-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="merge-target"
                      checked={isTarget}
                      onChange={() => setMergeTargetId(r.id)}
                      className="text-emerald-600 focus:ring-emerald-500"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{r.project_name || '—'} <span className="text-xs font-normal text-gray-500">· {r.artist_name}</span></p>
                      <div className="flex items-center gap-2.5 text-[11px] text-gray-400 mt-0.5 flex-wrap">
                        {r.release_date && <span>{formatDate(r.release_date)}</span>}
                        {r.upc && <span className="font-mono">UPC {r.upc}</span>}
                        {r.isrc && <span className="font-mono">ISRC {r.isrc}</span>}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setMergeModalOpen(false)}
                disabled={merging}
                className="text-xs font-semibold px-3.5 py-2 rounded-lg text-gray-500 hover:text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmMerge}
                disabled={!mergeTargetId || merging}
                className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {merging ? 'Merging…' : mergeTargetId ? 'Confirm merge' : 'Pick one to keep'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
