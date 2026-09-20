import { useState, useEffect } from 'react'
import { Loader, Sparkles, Plus, Trash2, Download, Copy, Check } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Breadcrumb from '../components/Breadcrumb'
import useUnsavedWarning from '../hooks/useUnsavedWarning'

const CONTRACT_TYPES = ['Recording', 'Publishing', 'Distribution', 'Management', 'Licensing']
const TERRITORIES = ['Worldwide', 'North America', 'United States', 'Europe', 'United Kingdom', 'Asia', 'Latin America']

export default function CreateContract() {
  const [artists, setArtists] = useState([])
  const [generating, setGenerating] = useState(false)
  const [generatedText, setGeneratedText] = useState('')
  const [copied, setCopied] = useState(false)

  const [form, setForm] = useState({
    artist_name: '',
    type: 'Recording',
    royalty_split: '80',
    advance: '',
    territory: 'Worldwide',
    num_releases: '',
    duration_years: '1',
    notes: '',
    financial_terms: [],
  })

  useUnsavedWarning(!!form.artist_name || !!form.advance || !!form.notes)

  useEffect(() => {
    api.get('/artists?limit=500').then(res => setArtists(res.data.data || [])).catch(() => {})
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const addTerm = () => {
    set('financial_terms', [...form.financial_terms, { label: '', amount: '', recoupable: true, note: '' }])
  }
  const updateTerm = (i, field, val) => {
    const terms = [...form.financial_terms]
    terms[i] = { ...terms[i], [field]: val }
    set('financial_terms', terms)
  }
  const removeTerm = (i) => {
    set('financial_terms', form.financial_terms.filter((_, idx) => idx !== i))
  }

  const handleGenerate = async () => {
    if (!form.artist_name || !form.type) return
    setGenerating(true)
    setGeneratedText('')
    try {
      const res = await api.post('/contracts/generate', form)
      setGeneratedText(res.data.data.text)
    } catch (err) {
      setGeneratedText('Failed to generate contract. ' + (err.response?.data?.error || err.message))
    } finally {
      setGenerating(false)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([generatedText], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${form.type}_Contract_${form.artist_name.replace(/\s+/g, '_')}.txt`
    a.click()
  }

  return (
    <div className="space-y-6">
      <div>
        <span className="inline-flex items-center px-3 py-1 bg-amber-200 text-amber-900 rounded-full text-xs font-bold tracking-wider uppercase">
          Work in progress
        </span>
      </div>
      <Breadcrumb items={[
        { label: 'Contracts', path: '/contracts' },
        { label: 'Create Contract' },
      ]} />

      <PageHeader tour="create-contract-header"
        title="Create Contract"
        subtitle="AI generates a contract draft using your existing contracts as reference"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Form */}
        <div className="space-y-4">
          <div className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">Contract Details</h2>

            {/* Artist */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Artist</label>
              <input
                type="text"
                list="artist-list"
                value={form.artist_name}
                onChange={e => set('artist_name', e.target.value)}
                placeholder="Type or select artist..."
                className="input-base"
              />
              <datalist id="artist-list">
                {artists.map(a => <option key={a.id} value={a.name} />)}
              </datalist>
            </div>

            {/* Type */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Contract Type</label>
              <select value={form.type} onChange={e => set('type', e.target.value)} className="select-base w-full">
                {CONTRACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {/* Royalty + Advance */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Artist Royalty %</label>
                <input type="number" value={form.royalty_split} onChange={e => set('royalty_split', e.target.value)} placeholder="80" className="input-base" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Advance ($)</label>
                <input type="number" value={form.advance} onChange={e => set('advance', e.target.value)} placeholder="0" className="input-base" />
              </div>
            </div>

            {/* Territory + Duration */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Territory</label>
                <select value={form.territory} onChange={e => set('territory', e.target.value)} className="select-base w-full">
                  {TERRITORIES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Duration (years)</label>
                <input type="number" value={form.duration_years} onChange={e => set('duration_years', e.target.value)} placeholder="1" className="input-base" />
              </div>
            </div>

            {/* Num releases */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Number of Releases</label>
              <input type="text" value={form.num_releases} onChange={e => set('num_releases', e.target.value)} placeholder="e.g. 3 singles + 1 album" className="input-base" />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Additional Notes / Requirements</label>
              <textarea value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Any specific clauses, requirements, or context..." className="input-base" rows={3} />
            </div>
          </div>

          {/* Financial Terms */}
          <div className="card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Financial Obligations</h2>
              <button onClick={addTerm} className="text-xs font-semibold text-boom-600 hover:text-boom-700 flex items-center gap-1">
                <Plus size={12} /> Add
              </button>
            </div>
            {form.financial_terms.length === 0 && (
              <p className="text-xs text-gray-400 py-2">No financial terms added. AI will use standard terms for this contract type.</p>
            )}
            {form.financial_terms.map((term, i) => (
              <div key={i} className="flex gap-2 items-start">
                <input type="text" value={term.label} onChange={e => updateTerm(i, 'label', e.target.value)} placeholder="e.g. Recording Fund" className="input-base flex-1" />
                <input type="text" value={term.amount} onChange={e => updateTerm(i, 'amount', e.target.value)} placeholder="$50,000 or 15%" className="input-base w-28" />
                <label className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap mt-2.5">
                  <input type="checkbox" checked={term.recoupable} onChange={e => updateTerm(i, 'recoupable', e.target.checked)} style={{ accentColor: '#334155' }} />
                  Recoup
                </label>
                <button onClick={() => removeTerm(i)} className="text-gray-300 hover:text-red-500 mt-2.5"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={generating || !form.artist_name || !form.type}
            className="w-full btn-primary py-3 text-base gap-2"
          >
            {generating ? (
              <><Loader size={18} className="animate-spin" /> Generating contract...</>
            ) : (
              <><Sparkles size={18} /> Generate Contract with AI</>
            )}
          </button>
        </div>

        {/* Right: Generated output */}
        <div className="card p-5 flex flex-col min-h-[600px]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Generated Contract</h2>
            {generatedText && (
              <div className="flex items-center gap-2">
                <button onClick={handleCopy} className="btn-secondary text-xs gap-1.5">
                  {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
                <button onClick={handleDownload} className="btn-secondary text-xs gap-1.5">
                  <Download size={12} /> Download
                </button>
              </div>
            )}
          </div>

          {generating ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <Loader size={28} className="animate-spin text-boom-500" />
              <p className="text-sm text-gray-400">AI is drafting your contract...</p>
              <p className="text-xs text-gray-300">Reading existing contracts for reference</p>
            </div>
          ) : generatedText ? (
            <div className="flex-1 overflow-auto">
              <pre className="whitespace-pre-wrap text-sm text-gray-700 leading-relaxed font-sans">{generatedText}</pre>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center">
              <Sparkles size={32} className="text-gray-200 mb-3" />
              <p className="text-sm text-gray-400 text-center">Fill in the details and click Generate.</p>
              <p className="text-xs text-gray-300 text-center mt-1">AI will reference your existing contracts to match your style and terms.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
