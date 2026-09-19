// The hand-off prompt.
//
// John, 2026-09-18: when a deal is marked Signed, when a contract is saved,
// when a release is created, when an invoice is paid — the app should hand
// you the next step. This is that hand: one card, bottom-right, a title, one
// sentence, one link that lands on the next page prefilled, and a dismiss.
//
// A PROMPT, never a redirect. The person may have three deals to sign this
// morning; the card waits (about fifteen seconds, or until clicked) and gets
// out of the way. The toast system is text-only, which is why this exists.
//
//   const [nextStep, showNextStep, clearNextStep] = useNextStep()
//   showNextStep({ title: 'Rosa Vale is signed', body: 'Create the contract next.',
//                  to: '/contracts?new=1&artist=Rosa%20Vale', label: 'Create the contract' })
//   …
//   <NextStepPrompt prompt={nextStep} onClose={clearNextStep} />
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, X } from 'lucide-react'

export function useNextStep() {
  const [prompt, setPrompt] = useState(null)
  const show = useCallback((p) => setPrompt({ ...p, key: Date.now() }), [])
  const clear = useCallback(() => setPrompt(null), [])
  return [prompt, show, clear]
}

export default function NextStepPrompt({ prompt, onClose, duration = 15000 }) {
  useEffect(() => {
    if (!prompt || !duration) return undefined
    const t = setTimeout(onClose, duration)
    return () => clearTimeout(t)
  }, [prompt, duration, onClose])
  if (!prompt) return null
  return (
    <div
      className="fixed bottom-6 right-6 z-50 w-[22rem] max-w-[calc(100vw-3rem)] card p-4 shadow-elevated border-l-4 border-l-boom-500"
      role="status"
      data-next-step
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-ink leading-snug">{prompt.title}</p>
          {prompt.body && <p className="text-[12px] text-gray-500 mt-1 leading-snug">{prompt.body}</p>}
          <div className="mt-3 flex items-center gap-3">
            {prompt.to && (
              <Link to={prompt.to} onClick={onClose} data-next-step-link
                className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1.5">
                {prompt.label || 'Next'} <ArrowRight size={12} />
              </Link>
            )}
            {prompt.onAction && (
              <button type="button" onClick={() => { prompt.onAction(); onClose() }} data-next-step-link
                className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1.5">
                {prompt.label || 'Next'} <ArrowRight size={12} />
              </button>
            )}
            <button type="button" onClick={onClose} className="text-[12px] text-gray-400 hover:text-gray-600">Not now</button>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="text-gray-300 hover:text-gray-500 -mt-1 -mr-1 p-1">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
