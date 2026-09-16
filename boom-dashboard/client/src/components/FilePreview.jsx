import { useState } from 'react'
import { X, ExternalLink, Loader, Download, ChevronLeft, ChevronRight } from 'lucide-react'
import useFileBlob, { isPdfMime, isImageMime } from '../hooks/useFileBlob'

/**
 * File preview modal. Shows PDFs in an iframe, images inline.
 *
 * Single-file mode:
 *   <FilePreview url="..." filename="..." onClose={...} />
 *
 * Multi-file mode (lets the user page through several attachments):
 *   <FilePreview files={[{url, filename}, ...]} onClose={...} />
 */
export default function FilePreview({ url, filename, files, onClose }) {
  const list = Array.isArray(files) && files.length ? files : (url ? [{ url, filename }] : [])
  const [index, setIndex] = useState(0)
  const safeIndex = Math.min(index, Math.max(list.length - 1, 0))
  const current = list[safeIndex] || { url: null, filename: null }
  const currentUrl = current.url
  const currentFilename = current.filename

  // The fetch lives in useFileBlob, shared with the decks' inline panel. Same
  // four states as before; the hook adds an abort per url, a last-write-wins
  // guard (paging with ← / → could otherwise land an earlier file on a later
  // one) and revocation of the blob it actually created — the old cleanup read
  // `blobUrl` from a closure that was not in its dep array, so it revoked a
  // stale value and leaked the current one.
  const { loading, blobUrl, mimeType, error } = useFileBlob(currentUrl)

  const isPdf = isPdfMime(mimeType)
  const isImage = isImageMime(mimeType)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="min-w-0 flex items-center gap-3">
            {list.length > 1 && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setIndex(i => Math.max(0, i - 1))}
                  disabled={safeIndex === 0}
                  title="Previous file"
                  className="p-1 text-gray-500 hover:text-gray-900 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-xs font-semibold text-gray-500 tabular-nums">
                  {safeIndex + 1} / {list.length}
                </span>
                <button
                  onClick={() => setIndex(i => Math.min(list.length - 1, i + 1))}
                  disabled={safeIndex === list.length - 1}
                  title="Next file"
                  className="p-1 text-gray-500 hover:text-gray-900 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            <p className="text-sm font-semibold text-gray-900 truncate">{currentFilename || 'File Preview'}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={currentUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <ExternalLink size={12} /> Open
            </a>
            <a
              href={currentUrl}
              download={currentFilename}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <Download size={12} /> Download
            </a>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-gray-50 flex items-center justify-center min-h-[400px]">
          {loading && (
            <div className="flex flex-col items-center gap-2">
              <Loader size={24} className="animate-spin text-gray-400" />
              <p className="text-xs text-gray-400">Loading preview...</p>
            </div>
          )}
          {error && (
            <div className="text-center">
              <p className="text-sm text-gray-500 mb-2">Could not load preview</p>
              <a href={currentUrl} target="_blank" rel="noreferrer" className="text-xs text-boom-600 hover:text-boom-700 font-semibold">
                Open in new tab
              </a>
            </div>
          )}
          {!loading && !error && blobUrl && isPdf && (
            <iframe
              src={blobUrl}
              className="w-full h-full min-h-[70vh]"
              title="File preview"
            />
          )}
          {!loading && !error && blobUrl && isImage && (
            <img
              src={blobUrl}
              alt={currentFilename}
              className="max-w-full max-h-[80vh] object-contain"
            />
          )}
          {!loading && !error && blobUrl && !isPdf && !isImage && (
            <div className="text-center">
              <p className="text-sm text-gray-500 mb-2">Preview not available for this file type</p>
              <a href={currentUrl} target="_blank" rel="noreferrer" className="text-xs text-boom-600 hover:text-boom-700 font-semibold">
                Open in new tab
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
