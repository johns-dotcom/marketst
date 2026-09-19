import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { Link2, Ban, Loader, AlertTriangle, FileX, ArrowRight } from 'lucide-react'
import api from '../api'
import { fmt, fmtDate } from '../utils/bankDisplay'
import EmptyState from '../components/EmptyState'

// Standing decisions, kept off the page where the daily work happens.
//
// SETUP is decided once and applies for months; WORK is what you do today.
// Interleaving them buried the work — Bank Matching had grown to nine stacked
// bands above its first transaction row. A rule accepted here changes what
// future statements do.
//
// ── WHAT THIS PAGE ASKS ──────────────────────────────────────────────────────
//
// It is the setup page for BANK MATCHING, whose whole job is tying bank lines to
// invoices. So it is organised around the one question that decides everything:
// **will this line ever have an invoice behind it?** The two answers are
// opposites, and this page used to give the same answer to both.
//
//   it will   → a category rule is a TRAP. Rule-booked rows get
//               match_method='created', which /match refuses, so the rule
//               permanently converts matchable payments into rematch work.
//               These rows offer the MATCH instead, and write no rule.
//   it won't  → a category rule is the right answer, PAIRED with the no-invoice
//               marker. Alone it books future rows into the needs-invoice queue.
//
// It was measured giving the wrong answer at scale: 102 of 120 suggestions were
// category rules; 6 of the top 25 were vendors with invoices already waiting
// unclaimed (Majed LLC offered as "always book as Marketing" with 17 proposals
// in the queue, one per row); 6 of the 10 rules in force were unpaired and
// feeding 137 rows / $26,528 into the queue; and 6 of 14 offers could not fire
// at all, including the top row of the page at 195 rows / $85,508.
//
// Every endpoint here is isStrictAdmin server-side, so this page is admin-only
// in practice regardless of who holds the page grant.
export default function BkRules() {
  const { user } = useAuth()
  const isAdmin = ['Admin', 'Superadmin'].includes(user?.role)

  const [suggestions, setSuggestions] = useState(null)
  const [catRules, setCatRules] = useState([])
  const [dismissRules, setDismissRules] = useState([])
  const [artistRules, setArtistRules] = useState([])
  const [noInvoiceRules, setNoInvoiceRules] = useState([])
  const [candidates, setCandidates] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')

  const load = async () => {
    setError('')
    try {
      const [s, c, d, a, n, comp] = await Promise.all([
        api.get('/statements/rule-suggestions'),
        // annotate=1: also report what each rule is DOING — how many rows it is
        // putting in the needs-invoice queue, and which ledger vendors they
        // resolve to. Opt-in because it costs a scan of every booked debit.
        api.get('/statements/category-rules?annotate=1'),
        api.get('/statements/rules'),
        api.get('/statements/artist-rules'),
        api.get('/statements/no-invoice-rules'),
        api.get('/statements/completion'),
      ])
      setSuggestions(s.data.data || null)
      setCatRules(c.data.data || [])
      setDismissRules(d.data.data || [])
      setArtistRules(a.data.data || [])
      setNoInvoiceRules(n.data.data || [])
      setCandidates(comp.data.data?.category_candidates || [])
    } catch (err) {
      // Surfaced, not swallowed. A silent failure here shows an empty rule list,
      // which reads as "no rules exist" — the opposite of the truth.
      setError(err.response?.data?.error || err.message)
      setSuggestions('error')
    }
  }
  useEffect(() => { if (isAdmin) load() }, [isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  // Accepting a "never invoices" suggestion. ONE call writes both halves — the
  // booking rule and the no-invoice marker — because a category rule on its own
  // feeds the needs-invoice queue, and that is the failure being fixed, not a
  // detail. See POST /statements/category-rules.
  const acceptNoInvoice = async (x) => {
    if (busy) return
    const reach = x.also_matches_count
      ? `\n\nHEADS UP — this pattern also reaches ${x.conflict_rows} row${x.conflict_rows === 1 ? '' : 's'} `
        + `already booked to a different category, on: ${x.also_matches.slice(0, 4).join(', ')}`
        + `${x.also_matches_count > 4 ? '…' : ''}. Those would be recategorised from now on.`
      : ''
    const clash = x.conflicts.length
      ? `\n\nNote: ${x.conflicts.map((c) => `${c.times} were ${c.value}`).join(', ')}. The rule will use "${x.value}" for all of them from now on.`
      : ''
    const partial = x.book_pattern_hits < x.book_pattern_rows
      ? `\n\nThe pattern covers ${x.book_pattern_hits} of this vendor's ${x.book_pattern_rows} lines — the rest arrive under a different descriptor and will still be asked about.`
      : ''
    const clears = x.queue_rows
      ? `\n\n${x.queue_rows} row${x.queue_rows === 1 ? '' : 's'} (${fmt(x.queue_usd)}) leave the needs-invoice queue immediately. `
        + 'Nothing in the ledger changes and no money moves.'
      : ''
    if (!window.confirm(
      `Always book "${x.pattern}" as ${x.value}, and record that ${x.ledger_payee} never sends an invoice?\n\n`
      + `You've made this call ${x.times} times.${clash}${partial}${reach}${clears}\n\n`
      + 'The booking rule applies to future statements only.')) return
    setBusy(x.kind + x.pattern)
    try {
      await api.post('/statements/category-rules', {
        pattern: x.pattern, category: x.value, no_invoice_pattern: x.no_invoice_pattern,
      })
      await load()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  // Same answer, no booking rule — nothing about the descriptors was distinctive
  // enough to write a rule that provably fires, so this only stops the rows being
  // asked about. Future lines from this vendor still need a category.
  const acceptStopAsking = async (x) => {
    if (busy) return
    if (!window.confirm(
      `Record that "${x.pattern}" never sends an invoice?\n\n`
      + `${x.queue_rows} booked row${x.queue_rows === 1 ? '' : 's'} (${fmt(x.queue_usd)}) stop counting as unfinished.\n\n`
      + 'No booking rule is written — these lines arrive under too many different descriptors for one to match '
      + 'reliably, so future ones still need a category. Nothing in the ledger changes and no money moves.')) return
    setBusy(x.kind + x.pattern)
    try {
      await api.post('/statements/no-invoice-rules', { scope: 'vendor', pattern: x.pattern })
      await load()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  const acceptOther = async (x) => {
    if (busy) return
    const reach = x.also_matches_count
      ? `\n\nHEADS UP — this pattern also matches ${x.also_matches_count} other vendor${x.also_matches_count === 1 ? '' : 's'}: `
        + `${x.also_matches.slice(0, 4).join(', ')}${x.also_matches_count > 4 ? '…' : ''}. They would be caught too.`
      : ''
    const clash = x.conflicts.length
      ? `\n\nNote: ${x.conflicts.map((c) => `${c.times} were ${c.value}`).join(', ')}. The rule will use "${x.value}" for all of them from now on.`
      : ''
    if (!window.confirm(
      `Always ${x.kind === 'dismiss' ? 'set aside' : 'attribute'} "${x.pattern}" as ${x.value}?\n\n`
      + `You've made this call ${x.times} times.${clash}${reach}\n\n`
      + 'Applies to future statements only — nothing already recorded changes.')) return
    setBusy(x.kind + x.pattern)
    try {
      if (x.kind === 'dismiss') await api.post('/statements/rules', { pattern: x.pattern })
      else await api.post('/statements/artist-rules', { pattern: x.pattern, artist: x.value })
      await load()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  const markNoInvoice = async (c) => {
    if (busy) return
    if (!window.confirm(`Mark the category "${c.category}" as never having an invoice?\n\n`
      + `${c.n} booked row${c.n === 1 ? '' : 's'} (${fmt(c.value)}) stop counting as unfinished.\n\n`
      + 'Nothing in the ledger changes and no money moves — this only records that no document is coming.')) return
    setBusy('cand' + c.category)
    try { await api.post('/statements/no-invoice-rules', { scope: 'category', pattern: c.category }); await load() }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  // Close the leak on a rule already in force. One call for every ledger vendor
  // its queue rows resolve to — a half-paired rule drops fewer rows than it just
  // promised, which is indistinguishable from the rule not working.
  const pairRule = async (rule) => {
    if (busy) return
    const safe = (rule.ledger_payees || []).filter((p) => p.real_invoices === 0)
    const invoicing = (rule.ledger_payees || []).filter((p) => p.real_invoices > 0)
    if (!safe.length) {
      alert(`Every vendor behind this rule has sent real invoices — ${invoicing.map((p) => `${p.payee} (${p.real_invoices})`).join(', ')}.\n\n`
        + 'Marking them as never invoicing would be wrong. These rows want matching, not an answer: open them from Bank Matching.')
      return
    }
    // `clears`, not `rows`: the no-invoice rule matches the ledger payee OR the
    // bank descriptor, so it also clears rows filed under another name that this
    // rule never touched. Promising only this rule's share under-reports — one
    // accept promised 3 and delivered 14 before this was measured.
    const clears = safe.reduce((s, p) => s + (p.clears ?? p.rows), 0)
    if (!window.confirm(
      `Record that ${safe.map((p) => `"${p.payee}"`).join(', ')} never send an invoice?\n\n`
      + `${clears} row${clears === 1 ? '' : 's'} leave the needs-invoice queue immediately`
      + `${clears > rule.queue_rows ? ` — more than this rule's ${rule.queue_rows}, because the same vendor also arrives under other descriptors` : ''}.`
      + (invoicing.length
        ? `\n\nLeft alone: ${invoicing.map((p) => `${p.payee} (${p.real_invoices} real invoices)`).join(', ')} — those rows want matching, not this answer.`
        : '')
      + '\n\nNothing in the ledger changes and no money moves.')) return
    setBusy('pair' + rule.id)
    try {
      await api.post('/statements/no-invoice-rules', { scope: 'vendor', patterns: safe.map((p) => p.payee) })
      await load()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  const remove = async (path, id, label) => {
    if (busy) return
    if (!window.confirm(`Remove ${label}?\n\nFuture statements stop applying it. Nothing already recorded changes.`)) return
    setBusy(path + id)
    try { await api.delete(`${path}/${id}`); await load() }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-gray-500">
        Upload rules are visible to Admins only.
      </div>
    )
  }

  const totalRules = catRules.length + dismissRules.length + artistRules.length + noInvoiceRules.length
  const sug = suggestions === 'error' || !suggestions ? [] : suggestions.suggestions || []
  const of = (k) => sug.filter((x) => x.kind === k)
  const matchSug = of('match')
  const noInvSug = [...of('category'), ...of('no-invoice')]
  const otherSug = [...of('dismiss'), ...of('artist')]
  const leaking = catRules.filter((r) => (r.queue_rows || 0) > 0)
  const leakRows = leaking.reduce((s, r) => s + r.queue_rows, 0)

  // ONE row treatment for every suggestion — the tag names the answer, not the
  // table the rule lands in. "CATEGORY" told you where it was stored; "NO
  // INVOICE" tells you what you are deciding.
  const Row = ({ tag, tone, pattern, sub, value, meta, note, warn, action, busyKey }) => (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-divider last:border-0 text-[13px] ${
      busy === busyKey ? 'opacity-50' : ''}`}>
      <span className={`text-[11px] font-semibold w-[74px] shrink-0 ${tone}`}>{tag}</span>
      <span className="font-mono font-semibold text-ink truncate max-w-[230px]" title={pattern}>&quot;{pattern}&quot;</span>
      {sub && <span className="text-[11px] text-gray-400 truncate max-w-[150px]" title={sub}>{sub}</span>}
      {value && <><span className="text-gray-400">&rarr;</span><span className="font-semibold text-ink truncate max-w-[170px]">{value}</span></>}
      {meta && <span className="text-[11px] text-gray-500 tabular-nums">{meta}</span>}
      {note && <span className="text-[11px] text-gray-400">{note}</span>}
      {warn && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700" title={warn.title}>
          <AlertTriangle size={11} /> {warn.label}
        </span>
      )}
      <span className="ml-auto shrink-0">{action}</span>
    </div>
  )

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Ban size={20} className="text-ink" />
        <h1 className="text-xl font-extrabold text-ink">Upload Rules</h1>
        {totalRules > 0 && (
          <span className="bg-gray-100 text-gray-600 text-[12px] font-bold px-2.5 py-0.5 rounded-full tabular-nums">{totalRules}</span>
        )}
        <a href="/bk/bank-matching"
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-gray-500 hover:text-ink border border-rule hover:border-gray-300 rounded-lg px-2 py-1">
          <Link2 size={12} /> Bank Matching
        </a>
      </div>
      {/* The question the page answers, rather than a description of where the
          rules are stored. Everything below is one of the two answers to it. */}
      <p className="text-[13px] text-gray-400 mb-4 max-w-[760px]">
        One question decides what a bank line needs: <span className="text-gray-500 font-semibold">will it ever have an
        invoice behind it?</span> If it will, it wants matching — a booking rule would stop that permanently. If it
        never will, it wants a rule <em>and</em> the note that no document is coming.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-alert-bd bg-alert-bg px-3.5 py-2.5 text-[13px] text-ink">
          Couldn&rsquo;t load rules: {error}
          <button onClick={load} className="ml-2 font-bold underline">retry</button>
        </div>
      )}

      {/* ── 1. INVOICES WAITING ──────────────────────────────────────────────
          These lead, because this is the page's job. Every one of them used to
          appear here as "always book this vendor as X" — an offer to un-match a
          vendor whose invoices the ledger already holds. No rule is written from
          this section; the action is to go and work them. */}
      {matchSug.length > 0 && (
        <div className="mb-5 rounded-xl border border-rule bg-card shadow-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-divider">
            <span className="text-sm font-bold text-ink">These have invoices — match them, don&rsquo;t rule them</span>
            <span className="text-[12px] text-gray-400">
              {' '}&mdash; {matchSug.length} vendor{matchSug.length === 1 ? '' : 's'} whose payments are being booked
              past documents the ledger already holds
              {suggestions.waiting_invoices ? `, ${suggestions.waiting_invoices} of them still unclaimed` : ''}.
              A booking rule here would make that permanent.
            </span>
          </div>
          {matchSug.map((x) => (
            <Row key={x.kind + x.pattern} tag="MATCH" tone="text-emerald-700"
              pattern={x.pattern}
              meta={`${x.booked_rows} booked · ${fmt(x.total_usd)}`}
              note={x.waiting_invoices > 0
                ? `${x.waiting_invoices} invoice${x.waiting_invoices === 1 ? '' : 's'} waiting unclaimed`
                : `${x.real_invoices} real invoice${x.real_invoices === 1 ? '' : 's'} on file, all claimed`}
              warn={x.waiting_invoices === 0 ? {
                label: 'may be double-recorded',
                title: 'This vendor invoices, but every invoice is already claimed by another bank row — '
                  + 'so these booked rows may be duplicate records of the same payments.',
              } : null}
              action={(
                <a href={`/bk/bank-matching?q=${encodeURIComponent(x.pattern)}&filter=needs-invoice`}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:underline">
                  Work these <ArrowRight size={11} />
                </a>
              )} />
          ))}
        </div>
      )}

      {/* ── 2. NEVER COME WITH AN INVOICE ────────────────────────────────────
          The category rule is right here — paired, so it stops asking as well as
          booking. Unpaired it books future rows straight into the queue. */}
      {noInvSug.length > 0 && (
        <div className="mb-5 rounded-xl border border-rule bg-card shadow-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-divider">
            <span className="text-sm font-bold text-ink">These never come with an invoice</span>
            <span className="text-[12px] text-gray-400">
              {' '}&mdash; no vendor here has ever sent one. Accepting books future lines <em>and</em> records that no
              document is coming, so they stop counting as unfinished
              {suggestions.clears_queue_rows
                ? ` — ${suggestions.clears_queue_rows} rows leave the queue between them`
                : ''}.
            </span>
          </div>
          {noInvSug.slice(0, 60).map((x) => (
            <Row key={x.kind + x.pattern} tag={x.kind === 'category' ? 'BOOK + NO INV' : 'NO INVOICE'}
              tone="text-gray-500"
              pattern={x.pattern}
              // The rule matches the DESCRIPTOR; the vendor name is the thing a
              // human recognises. Both, when they differ.
              sub={x.kind === 'category' && x.ledger_payee !== x.pattern ? x.ledger_payee : null}
              value={x.kind === 'category' ? x.value : null}
              meta={`${x.times}×${x.total_usd ? ` · ${fmt(x.total_usd)}` : ''}`}
              note={x.queue_rows ? `clears ${x.queue_rows} now` : (x.kind === 'no-invoice' ? null : 'no rule written')}
              warn={
                x.also_matches_count > 0 ? {
                  label: `relabels ${x.conflict_rows} row${x.conflict_rows === 1 ? '' : 's'}`,
                  title: `This pattern also reaches rows booked to a different category, on: ${x.also_matches.join(', ')}`,
                } : x.conflicts.length > 0 ? {
                  label: `but ${x.conflicts[0].times} were ${x.conflicts[0].value}`,
                  title: x.conflicts.map((c) => `${c.times} × ${c.value}`).join(', '),
                } : x.kind === 'category' && x.book_pattern_hits < x.book_pattern_rows ? {
                  label: `covers ${x.book_pattern_hits} of ${x.book_pattern_rows}`,
                  title: 'The rest of this vendor\'s lines arrive under a different descriptor, so the rule '
                    + 'will not catch them and they will still be asked about.',
                } : null
              }
              busyKey={x.kind + x.pattern}
              action={(
                <button onClick={() => (x.kind === 'category' ? acceptNoInvoice(x) : acceptStopAsking(x))}
                  disabled={!!busy}
                  className="text-[11px] font-bold text-ink hover:underline disabled:opacity-40">
                  {x.kind === 'category' ? 'Make it a rule' : 'Stop asking'}
                </button>
              )} />
          ))}
          {noInvSug.length > 60 && (
            <div className="px-4 py-2 border-t border-divider text-[11px] text-gray-400">
              Showing the 60 most-repeated of {noInvSug.length}. Accept some and the rest move up.
            </div>
          )}
        </div>
      )}

      {/* Categories where no vendor has ever invoiced us — the same answer at
          category scope, which reaches vendors too small to earn their own row. */}
      {candidates.length > 0 && (
        <div className="mb-5 rounded-xl border border-rule bg-card shadow-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-divider">
            <span className="text-sm font-bold text-ink">Whole categories that never do</span>
            <span className="text-[12px] text-gray-400">
              {' '}No vendor in these has ever sent us an invoice. Marking one stops its rows
              counting as unfinished &mdash; nothing in the ledger changes.
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 p-3">
            {candidates.map((c) => (
              <button key={c.category} onClick={() => markNoInvoice(c)} disabled={!!busy}
                title={`${c.n} booked rows across ${c.vendors} vendor${c.vendors === 1 ? '' : 's'}, none of which has ever invoiced us`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-rule bg-card hover:border-gray-300 text-[12px] transition disabled:opacity-40">
                <span className="text-gray-600">{c.category}</span>
                <span className="tabular-nums text-[11px] text-gray-400">{c.n}</span>
                <span className="tabular-nums text-[11px] text-ink-faint">{fmt(c.value)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 3. The rest. Neither of these writes a booking, so neither can
          shadow an invoice — they sit below the two answers that can. */}
      {otherSug.length > 0 && (
        <div className="mb-5 rounded-xl border border-rule bg-card shadow-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-divider">
            <span className="text-sm font-bold text-ink">Not spending, and who it was for</span>
            <span className="text-[12px] text-gray-400">
              {' '}&mdash; transfers and fees to keep out of the P&amp;L, and standing artist attribution.
              Neither touches matching.
            </span>
          </div>
          {otherSug.map((x) => (
            <Row key={x.kind + x.pattern}
              tag={x.kind === 'dismiss' ? 'SET ASIDE' : 'ARTIST'}
              tone={x.kind === 'dismiss' ? 'text-gray-500' : 'text-violet-600'}
              pattern={x.pattern}
              value={x.kind === 'artist' ? x.value : null}
              meta={`${x.times}×${x.total_usd ? ` · ${fmt(x.total_usd)}` : ''}`}
              warn={x.also_matches_count > 0 ? {
                label: `also catches ${x.also_matches_count} other vendor${x.also_matches_count === 1 ? '' : 's'}`,
                title: x.also_matches.join(', '),
              } : null}
              busyKey={x.kind + x.pattern}
              action={(
                <button onClick={() => acceptOther(x)} disabled={!!busy}
                  className="text-[11px] font-bold text-ink hover:underline disabled:opacity-40">
                  Make it a rule
                </button>
              )} />
          ))}
        </div>
      )}

      {/* ── In force ─────────────────────────────────────────────────────────
          Now says what each rule is DOING, not just what it says. A category
          rule with no no-invoice partner books rows into the needs-invoice queue
          on every upload; six of ten were doing that, and the list showed only
          the pattern, so a leaking rule looked identical to a working one. */}
      <div className="rounded-xl border border-rule bg-card shadow-card overflow-hidden">
        <div className="px-4 py-2.5 border-b border-divider">
          <span className="text-sm font-bold text-ink">In force &mdash; {totalRules}</span>
          <span className="text-[12px] text-gray-400"> applied to every statement automatically</span>
          {leaking.length > 0 && (
            <span className="text-[12px] text-amber-700">
              {' '}· {leaking.length} {leaking.length === 1 ? 'is' : 'are'} booking {leakRows} row
              {leakRows === 1 ? '' : 's'} into the needs-invoice queue
            </span>
          )}
        </div>
        {totalRules === 0 && (
          <div className="p-3">
            <EmptyState compact
              title="No rules yet"
              body="Rules are standing decisions about recurring bank lines. Accept a suggestion on Bank › For review and it applies to the next statement you upload."
              source={{ label: 'For review', to: '/bk/bank-matching' }}
            />
          </div>
        )}
        {catRules.map((r) => (
          <Row key={`c${r.id}`} tag="BOOK" tone="text-gray-500" pattern={r.pattern} value={r.category}
            meta={`${r.created_by || ''}${r.created_at ? ` · ${fmtDate(r.created_at)}` : ''}`}
            warn={r.queue_rows > 0 ? {
              label: `feeding the queue: ${r.queue_rows} row${r.queue_rows === 1 ? '' : 's'} · ${fmt(r.queue_usd)}`,
              title: 'This rule books rows with no invoice behind them, and nothing records that no invoice is '
                + 'coming — so every one lands in the needs-invoice queue.',
            } : null}
            busyKey={busy === `pair${r.id}` ? `pair${r.id}` : `/statements/category-rules${r.id}`}
            action={(
              <span className="flex items-center gap-3">
                {r.queue_rows > 0 && (
                  <button onClick={() => pairRule(r)} disabled={!!busy}
                    title="Record that these vendors never send an invoice, so the rule stops feeding the queue"
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-ink hover:underline disabled:opacity-40">
                    <FileX size={11} /> never invoice
                  </button>
                )}
                <button onClick={() => remove('/statements/category-rules', r.id, `the rule booking "${r.pattern}" as ${r.category}`)}
                  className="text-[11px] font-semibold text-gray-400 hover:text-rose-600">Remove</button>
              </span>
            )} />
        ))}
        {dismissRules.map((r) => (
          <Row key={`d${r.id}`} tag="SET ASIDE" tone="text-gray-500" pattern={r.pattern}
            meta={`${r.created_by || ''}${r.created_at ? ` · ${fmtDate(r.created_at)}` : ''}`}
            busyKey={`/statements/rules${r.id}`}
            action={(
              <button onClick={() => remove('/statements/rules', r.id, `the rule setting aside "${r.pattern}"`)}
                className="text-[11px] font-semibold text-gray-400 hover:text-rose-600">Remove</button>
            )} />
        ))}
        {artistRules.map((r) => (
          <Row key={`a${r.id}`} tag="ARTIST" tone="text-violet-600" pattern={r.pattern}
            value={r.is_overhead ? 'overhead — no artist' : r.artist}
            meta={`${r.created_by || ''}${r.created_at ? ` · ${fmtDate(r.created_at)}` : ''}`}
            busyKey={`/statements/artist-rules${r.id}`}
            action={(
              <button onClick={() => remove('/statements/artist-rules', r.id, `the artist rule for "${r.pattern}"`)}
                className="text-[11px] font-semibold text-gray-400 hover:text-rose-600">Remove</button>
            )} />
        ))}
        {noInvoiceRules.map((r) => (
          <Row key={`n${r.id}`} tag="NO INVOICE" tone="text-gray-500" pattern={r.pattern}
            note={`${r.scope} scope · never has an invoice`}
            meta={r.created_by || ''}
            busyKey={`/statements/no-invoice-rules${r.id}`}
            action={(
              <button onClick={() => remove('/statements/no-invoice-rules', r.id, `"${r.pattern}" as never having an invoice`)}
                className="text-[11px] font-semibold text-gray-400 hover:text-rose-600">Remove</button>
            )} />
        ))}
      </div>

      {suggestions === null && !error && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-gray-400">
          <Loader size={13} className="animate-spin" /> Looking for decisions you&rsquo;ve made repeatedly…
        </div>
      )}
    </div>
  )
}
