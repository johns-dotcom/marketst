import { useState, useRef, useEffect } from 'react'
import { Upload, File, Trash2, ExternalLink, Loader, X } from 'lucide-react'
import api from '../api'
import { getFileUrl, formatDate } from '../utils'

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Reusable file attachment panel for contracts, deals, and artists.
 *
 * Props:
 *   entityType  — 'contract' | 'deal' | 'artist'
 *   entityId    — integer ID of the entity
 *   basePath    — API base path, e.g. '/contracts', '/deals', '/artists'
 *   initialFiles — pre-loaded files array (optional, will fetch if omitted)
 *   onCountChange — called with new file count whenever files change (optional)
 */
export default function FilesPanel({ entityType, entityId, basePath, initialFiles, onCountChange }) {
  const [files, setFiles] = useState(initialFiles || [])
  const [loading, setLoading] = useState(!initialFiles)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!initialFiles) fetchFiles()
  }, [entityId])

  useEffect(() => {
    if (initialFiles) setFiles(initialFiles)
  }, [initialFiles])

  const fetchFiles = async () => {
    try {
      setLoading(true)
      const res = await api.get(`${basePath}/${entityId}/files`)
      const fetched = res.data.data || []
      setFiles(fetched)
      onCountChange?.(fetched.length)
    } catch (err) {
      console.error('Failed to fetch files:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async (file) => {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await api.post(`${basePath}/${entityId}/files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const updated = [res.data.data, ...files]
      setFiles(updated)
      onCountChange?.(updated.length)
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (fileId) => {
    if (!window.confirm('Remove this file?')) return
    setDeletingId(fileId)
    try {
      await api.delete(`${basePath}/${entityId}/files/${fileId}`)
      const updated = files.filter(f => f.id !== fileId)
      setFiles(updated)
      onCountChange?.(updated.length)
    } catch (err) {
      console.error('Failed to delete file:', err)
    } finally {
      setDeletingId(null)
    }
  }

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(e.type === 'dragenter' || e.type === 'dragover')
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) handleUpload(file)
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-5 space-y-4">
      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map(f => (
            <div
              key={f.id}
              className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-gray-200 group transition-all"
            >
              <div className="w-8 h-8 bg-boom-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <File size={15} className="text-boom-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{f.original_name}</p>
                <p className="text-xs text-gray-400">
                  {formatBytes(f.file_size)}
                  {f.uploaded_at && <> · {formatDate(f.uploaded_at)}</>}
                  {f.uploaded_by_name && <> · {f.uploaded_by_name}</>}
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <a
                  href={getFileUrl(f.filename)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 text-gray-400 hover:text-boom-600 rounded-lg hover:bg-boom-50 transition-colors"
                  title="Open file"
                >
                  <ExternalLink size={13} />
                </a>
                <button
                  onClick={() => handleDelete(f.id)}
                  disabled={deletingId === f.id}
                  className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                  title="Remove file"
                >
                  {deletingId === f.id
                    ? <Loader size={13} className="animate-spin" />
                    : <Trash2 size={13} />
                  }
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload zone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={`
          relative flex flex-col items-center justify-center gap-2 px-4 py-7
          border-2 border-dashed rounded-xl cursor-pointer transition-all
          ${dragActive
            ? 'border-boom-400 bg-boom-50/50 scale-[1.01]'
            : 'border-gray-200 hover:border-boom-400 hover:bg-boom-50/20'
          }
          ${uploading ? 'pointer-events-none opacity-60' : ''}
        `}
      >
        {uploading ? (
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium text-gray-600">Uploading…</p>
          </div>
        ) : (
          <>
            <Upload size={18} className={dragActive ? 'text-boom-500' : 'text-gray-400'} />
            <div className="text-center">
              <p className="text-sm font-medium text-gray-600">
                {dragActive ? 'Drop to attach' : 'Attach a file'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">drag & drop or click · any file type · max 20 MB</p>
            </div>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }}
          className="hidden"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          <X size={12} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {files.length === 0 && !uploading && (
        <p className="text-xs text-gray-400 text-center -mt-2">No files attached yet</p>
      )}
    </div>
  )
}
