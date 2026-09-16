import { ExternalLink, Download, Loader, FileText } from 'lucide-react'
import useFileBlob, { isPdfMime, isImageMime } from '../hooks/useFileBlob'

// The document, in the review deck, without clicking into it.
//
// A PANEL, not an overlay — FilePreview is a modal that covers the card, which is
// exactly what a reviewer does not want when the question is "does this invoice
// settle this bank line?". Both viewers share useFileBlob, so a fetch fix lands in
// one place.
//
// Every state is explicit, and "no document" is the one that matters most: on a
// matched row it is real signal, not an empty slot. Same reasoning as DocButton
// rendering a "no doc" chip rather than hiding itself.
//
// `url` null means fetch nothing — the caller passes null when the panel is hidden
// or the card has no file, so the 8% of cards without one cost no request.
export default function InlineFilePreview({ url, filename, label, meta, emptyText }) {
  const { loading, blobUrl, mimeType, error } = useFileBlob(url)
  const isPdf = isPdfMime(mimeType)
  const isImage = isImageMime(mimeType)

  return (
    <div className="flex flex-col h-full min-h-0 rounded-2xl border border-rule bg-card overflow-hidden shadow-2xl">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-divider shrink-0">
        <FileText size={13} className="text-gray-400 shrink-0" />
        <span className="min-w-0 flex-1">
          {label && (
            <span className="block text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</span>
          )}
          <span className="block text-[12px] font-semibold text-ink truncate">
            {filename || (url ? 'Document' : 'No document')}
          </span>
          {meta && <span className="block text-[11px] text-gray-500 truncate">{meta}</span>}
        </span>
        {url && (
          <span className="flex items-center gap-1 shrink-0">
            <a href={url} target="_blank" rel="noreferrer" title="Open in a new tab"
              className="p-1.5 text-gray-400 hover:text-ink rounded-lg hover:bg-gray-100 transition-colors">
              <ExternalLink size={13} />
            </a>
            <a href={url} download={filename || undefined} title="Download"
              className="p-1.5 text-gray-400 hover:text-ink rounded-lg hover:bg-gray-100 transition-colors">
              <Download size={13} />
            </a>
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 bg-gray-50 flex items-center justify-center">
        {!url && (
          <p className="px-6 text-center text-[12px] text-gray-400">
            {emptyText || 'No document on this row.'}
          </p>
        )}
        {url && loading && (
          <span className="flex flex-col items-center gap-2">
            <Loader size={20} className="animate-spin text-gray-400" />
            <span className="text-[11px] text-gray-400">Loading…</span>
          </span>
        )}
        {url && !loading && error && (
          <p className="px-6 text-center text-[12px] text-gray-500">
            Could not load this file.{' '}
            <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-boom-600 hover:text-boom-700">
              Open it in a new tab
            </a>
          </p>
        )}
        {url && !loading && !error && blobUrl && isPdf && (
          // #view=FitH so a letter-size invoice arrives readable rather than
          // zoomed to whatever the viewer last used.
          <iframe src={`${blobUrl}#view=FitH`} title={filename || 'Document'} className="w-full h-full border-0" />
        )}
        {url && !loading && !error && blobUrl && isImage && (
          <img src={blobUrl} alt={filename || 'Document'} className="max-w-full max-h-full object-contain" />
        )}
        {url && !loading && !error && blobUrl && !isPdf && !isImage && (
          <p className="px-6 text-center text-[12px] text-gray-500">
            Can’t preview this file type.{' '}
            <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-boom-600 hover:text-boom-700">
              Open it in a new tab
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
