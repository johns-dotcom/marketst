import { useState, useEffect, useRef } from 'react'
import { Trash2, Download, Plus, Loader, FileText, Eye, Table2, LayoutGrid, X, Pencil } from 'lucide-react'
import { jsPDF } from 'jspdf'
import api from '../api'
import useHotkeys from '../hooks/useHotkeys'
import Skeleton from '../components/Skeleton'
import { CURRENCIES } from '../constants'

// TODO(marketst): replace every placeholder below with Market Street's real
// remittance details before issuing an invoice. These print on the PDF.
const BOOM_INFO = {
  company: 'MARKET STREET',
  address: ['STREET ADDRESS', 'CITY STATE ZIP USA'],
  contact: 'JOHN SKEAD',
  phone: '',
  email: 'john@deanst.co',
  ein: 'XX-XXXXXXX',
  bank: {
    name: 'BANK NAME',
    address: ['BANK ADDRESS'],
    accountName: 'MARKET STREET',
    type: 'CHECKING',
    swift: 'SWIFT (for funds sent in USD)',
    routingWire: 'ROUTING (WIRE)',
    routingAch: 'ROUTING (ACH)',
    account: 'ACCOUNT NUMBER',
  },
}

function padInvoiceNumber(num) {
  return String(num).padStart(4, '0')
}

function formatCurrency(amount, currency = 'USD') {
  const cur = String(currency || 'USD').toUpperCase()
  const n = Number(amount)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number.isFinite(n) ? n : 0)
  } catch {
    // Unknown ISO code — fall back to a plain number with the code suffix
    // so the invoice still renders something sensible (e.g. "1,234.56 XYZ").
    return `${Number.isFinite(n) ? n : 0}`
      + (n === 0 ? '.00' : '')
      + ' ' + cur
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const LA_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
})
function laDay(v) {
  const d = new Date(v || Date.now())
  return Number.isNaN(d.getTime()) ? null : LA_DAY.format(d)
}

// The date the invoice bears, printed from the server's `invoice_date` —
// 'YYYY-MM-DD' in the company's timezone, and the same day its DUE BY line was
// counted from.
//
// It used to be `new Date(created_at).toLocaleDateString(...)`, which renders a
// timestamp in the READER's timezone. Pacific is UTC-7, so an invoice raised after
// 5pm printed the previous day while its deadline was counted from the UTC one: a
// Net 45 document dated 46 days before its own due date. Five live invoices already
// print a day earlier than the day they were anchored on.
//
// Formatted from the string parts through Date.UTC — parsing 'YYYY-MM-DD' with the
// local constructor would reintroduce exactly the shift this removes.
function invoiceDay(invoice) {
  return /^\d{4}-\d{2}-\d{2}$/.test(invoice?.invoice_date || '')
    ? invoice.invoice_date
    // No `invoice_date` means a server too old to send one. Pin the timezone
    // rather than falling back to the reader's, so the printed date is the same
    // day for a client reading it in Berlin.
    : laDay(invoice?.created_at)
}

function formatInvoiceDate(invoice) {
  const day = invoiceDay(invoice)
  if (!day) return ''
  const [y, m, d] = day.split('-').map(Number)
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${wd}, ${MONTHS[m - 1]} ${d}, ${y}`
}

// The same day, abbreviated for the list. Both readers go through invoiceDay so
// the table cannot name a different date than the document it opens.
function shortInvoiceDate(invoice) {
  const day = invoiceDay(invoice)
  if (!day) return ''
  const [y, m, d] = day.split('-').map(Number)
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`
}


function BoomLogo({ compact }) {
  return (
    <svg viewBox="0 0 220 50" className={compact ? 'h-8' : 'h-11'} aria-label="Market Street">
      <text x="0" y="42" fontFamily="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fontSize="34" fontWeight="900" fill="#334155" letterSpacing="-1">MARKET STREET</text>
    </svg>
  )
}

function InvoicePreview({ invoice, compact }) {
  const t = compact ? 'text-xs' : 'text-[13px]'
  const tSm = compact ? 'text-[10px]' : 'text-xs'

  return (
    <div className={`bg-card border border-rule rounded-lg shadow-sm ${compact ? 'p-6 py-5' : 'p-10 py-8'} font-sans`}>
      {/* Logo */}
      <BoomLogo compact={compact} />

      {/* INVOICE title */}
      <h1 className={`${compact ? 'text-3xl mt-2' : 'text-[44px] mt-3'} font-black tracking-tight text-gray-900 leading-none`}>INVOICE</h1>
      <p className={`${tSm} text-gray-500 mt-1.5`}>NO.: {padInvoiceNumber(invoice.invoice_number)}</p>
      <p className={`${tSm} text-gray-500`}>PURCHASE ORDER #: {invoice.purchase_order || 'N/A'}</p>

      <hr className="border-gray-300 my-5" />

      {/* Bill To + Funds Payable To */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div>
          <p className={`${t} font-bold text-gray-900 mb-1`}>Bill To:</p>
          <div className={`${t} text-gray-700`}>
            {invoice.bill_to.split('\n').map((line, i) => <p key={i}>{line}</p>)}
          </div>
          {invoice.bill_to_address && (
            <div className={`${t} text-gray-500 leading-relaxed`}>
              {invoice.bill_to_address.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            </div>
          )}
        </div>
        <div>
          <p className={`${t} font-bold text-gray-900 mb-1`}>FUNDS PAYABLE TO:</p>
          <div className={`${t} text-gray-700 leading-relaxed`}>
            <p>{BOOM_INFO.company}</p>
            {BOOM_INFO.address.map((line, i) => <p key={i}>{line}</p>)}

            <div className="mt-4">
              <p>CONTACT: {BOOM_INFO.contact}</p>
              <p>PHONE: {BOOM_INFO.phone}</p>
              <p>EMAIL: {BOOM_INFO.email}</p>
            </div>

            <div className="mt-4 pt-4 border-t border-rule">
              <p>EIN: {BOOM_INFO.ein}</p>
            </div>

            <div className="mt-4 pt-4 border-t border-rule">
              <p>BANK: {BOOM_INFO.bank.name}</p>
              <p>ADDRESS: {BOOM_INFO.bank.address[0]}, {BOOM_INFO.bank.address[1]}</p>
              <p>NAME: {BOOM_INFO.bank.accountName}</p>
              <p>TYPE: {BOOM_INFO.bank.type}</p>
              <p>SWIFT: {BOOM_INFO.bank.swift}</p>
              <p>ROUTING: {BOOM_INFO.bank.routingWire}</p>
              <p className="pl-[72px]">{BOOM_INFO.bank.routingAch}</p>
              <p>ACCOUNT: {BOOM_INFO.bank.account}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Due By */}
      <div className="mb-5">
        <span className={`${t} font-bold text-gray-900`}>DUE BY:</span>
        <span className={`${t} text-gray-700 ml-3`}>{invoice.due_by || 'UPON RECEIPT'}</span>
      </div>

      <hr className="border-gray-300 mb-3" />

      {/* Line Items Header */}
      <div className="flex justify-between mb-2">
        <span className={`${t} font-bold text-gray-900`}>Description</span>
        <span className={`${t} font-bold text-gray-900`}>Amount Due</span>
      </div>

      <hr className="border-rule mb-1" />

      {/* Line Items */}
      {(invoice.line_items || [{ description: invoice.description, amount: invoice.amount }]).map((li, i) => (
        <div key={i} className="flex justify-between py-1">
          <span className={`${t} text-gray-700`}>{li.description}</span>
          <span className={`${t} text-gray-700`}>{formatCurrency(li.amount, invoice.currency)}</span>
        </div>
      ))}

      <hr className="border-gray-300 my-3" />

      {/* Total */}
      <div className="flex justify-between py-1">
        <span className={`${t} font-bold text-gray-900`}>TOTAL DUE</span>
        <span className={`${t} font-bold text-gray-900`}>{formatCurrency(invoice.amount, invoice.currency)}</span>
      </div>

      <hr className="border-gray-300 my-3" />

      {/* Date */}
      <p className={`${tSm} text-gray-400 mt-1`}>
        {formatInvoiceDate(invoice)}
      </p>
    </div>
  )
}

const PAID_BADGE = {
  Paid:    'bg-green-100 text-green-800',
  Unpaid:  'bg-red-100 text-red-800',
  Partial: 'bg-yellow-100 text-yellow-800',
}
const PAID_CYCLE = ['Unpaid', 'Paid', 'Partial']

export default function CreateInvoice() {
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [nextNumber, setNextNumber] = useState(0)
  // Payment terms. `due` is what the SERVER says the choice means — asked for
  // rather than computed here, so the date in the preview is the date that gets
  // saved. Computing it client-side would put a second implementation of the same
  // arithmetic on the other side of a timezone.
  const [form, setForm] = useState({ bill_to: '', bill_to_address: '', currency: 'USD', payment_terms: 'Net 30', due_date: '', invoice_date: '' })
  const [termOptions, setTermOptions] = useState([])
  const [due, setDue] = useState({ due_by: null, due_date: null, invoice_date: null, error: null })
  useEffect(() => {
    api.get('/invoices/terms')
      .then(({ data }) => setTermOptions(data?.data?.terms || []))
      .catch(() => setTermOptions([]))
  }, [])
  const [lineItems, setLineItems] = useState([{ description: '', amount: '' }])
  const [editingInvoice, setEditingInvoice] = useState(null)
  // The invoice's date comes from the SERVER, with the deadline, in one answer —
  // an edit anchors on the invoice's own issue date (`invoice_id`), a new one on
  // today in the company's timezone. This page deliberately computes no date at
  // all: when it derived the anchor itself it used the UTC day while the document
  // printed the reader's day, and after 5pm Pacific those are not the same day.
  //
  // The reference to editingInvoice sits BELOW its declaration on purpose. It was
  // above, and reading a `const` before its declaration is a temporal-dead-zone
  // ReferenceError on every render — the page went pure white. `vite build`
  // compiles it happily, because the identifier exists; it just does not exist
  // YET. A successful build is not evidence a page renders.
  useEffect(() => {
    const params = {
      terms: form.payment_terms,
      // `date` WINS over `invoice_id` server-side, which is what makes the
      // preview follow the date being typed instead of the one on file.
      ...(form.invoice_date ? { date: form.invoice_date } : {}),
      ...(editingInvoice?.id ? { invoice_id: editingInvoice.id } : {}),
      ...(form.due_date ? { custom: form.due_date } : {}),
    }
    api.get('/invoices/due-date', { params })
      .then(({ data }) => setDue(data?.data || { due_by: null, due_date: null, invoice_date: null, error: null }))
      .catch(() => setDue({ due_by: null, due_date: null, invoice_date: null, error: null }))
  }, [form.payment_terms, form.due_date, form.invoice_date, editingInvoice?.id])
  const [viewMode, setViewMode] = useState('table')
  const [previewInv, setPreviewInv] = useState(null)
  const previewRef = useRef(null)
  const formRef = useRef(null)

  useHotkeys([
    { key: 'Enter', meta: true, handler: () => formRef.current?.requestSubmit() },
    { key: 'l', meta: true, shift: true, handler: () => setLineItems(prev => [...prev, { description: '', amount: '' }]) },
    { key: 'p', meta: true, handler: () => {
      if (previewInv) handleDownload(previewInv)
      else if (invoices.length) handleDownload(invoices[0])
    }},
  ])

  const fetchInvoices = async () => {
    try {
      const res = await api.get('/invoices')
      setInvoices(res.data.data)
    } catch { /* ignore */ }
  }

  const fetchNextNumber = async () => {
    try {
      const res = await api.get('/invoices/next-number')
      setNextNumber(res.data.data.next_number)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    Promise.all([fetchInvoices(), fetchNextNumber()]).then(() => setLoading(false))
  }, [])

  const startEdit = (inv) => {
    setEditingInvoice(inv)
    setForm({ bill_to: inv.bill_to || '', bill_to_address: inv.bill_to_address || '', currency: (inv.currency || 'USD').toUpperCase(),
      payment_terms: inv.payment_terms || 'Due on receipt', due_date: (inv.due_date || '').slice(0, 10),
      // The server already hands every row its `invoice_date` as 'YYYY-MM-DD'.
      // Taken as-is: re-deriving it here from created_at is the exact mistake
      // that printed a Net 45 document 46 days before its own due date.
      invoice_date: invoiceDay(inv) })
    const items = Array.isArray(inv.line_items) && inv.line_items.length
      ? inv.line_items.map(li => ({ description: li.description || '', amount: String(li.amount ?? '') }))
      : [{ description: inv.description || '', amount: String(inv.amount || '') }]
    setLineItems(items)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelEdit = () => {
    setEditingInvoice(null)
    setForm({ bill_to: '', bill_to_address: '', currency: 'USD', payment_terms: 'Net 30', due_date: '', invoice_date: '' })
    setLineItems([{ description: '', amount: '' }])
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    // In-flight guard — Cmd+Enter fires requestSubmit() regardless of the
    // button's disabled state, so a double press created duplicate invoices.
    if (creating) return
    // Filter on !== '' (not truthiness) so legitimate $0 lines (comps,
    // no-charge items) survive the edit round-trip.
    const validItems = lineItems.filter(li => li.description && li.amount !== '')
    if (!form.bill_to || !validItems.length) return
    const totalAmount = validItems.reduce((s, li) => s + parseFloat(li.amount || 0), 0)

    setCreating(true)
    try {
      if (editingInvoice) {
        await api.put(`/invoices/${editingInvoice.id}`, {
          bill_to: form.bill_to,
          bill_to_address: form.bill_to_address,
          description: validItems.map(li => li.description).join(', '),
          amount: totalAmount,
          line_items: JSON.stringify(validItems.map(li => ({ description: li.description, amount: parseFloat(li.amount) }))),
          currency: (form.currency || 'USD').toUpperCase(),
          payment_terms: form.payment_terms,
          ...(form.invoice_date ? { invoice_date: form.invoice_date } : {}),
          ...(form.due_date ? { due_date: form.due_date } : {}),
        })
        setEditingInvoice(null)
      } else {
        await api.post('/invoices', {
          bill_to: form.bill_to,
          bill_to_address: form.bill_to_address,
          description: validItems.map(li => li.description).join(', '),
          amount: totalAmount,
          line_items: validItems.map(li => ({ description: li.description, amount: parseFloat(li.amount) })),
          currency: (form.currency || 'USD').toUpperCase(),
          payment_terms: form.payment_terms,
          ...(form.invoice_date ? { invoice_date: form.invoice_date } : {}),
          ...(form.due_date ? { due_date: form.due_date } : {}),
        })
      }
      setForm({ bill_to: '', bill_to_address: '', currency: 'USD', payment_terms: 'Net 30', due_date: '', invoice_date: '' })
      setLineItems([{ description: '', amount: '' }])
      await Promise.all([fetchInvoices(), fetchNextNumber()])
    } catch { /* ignore */ }
    setCreating(false)
  }

  const cyclePaymentStatus = async (inv) => {
    const cur = inv.payment_status || 'Unpaid'
    const next = PAID_CYCLE[(PAID_CYCLE.indexOf(cur) + 1) % PAID_CYCLE.length]
    try {
      await api.put(`/invoices/${inv.id}`, { payment_status: next })
      setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, payment_status: next } : i))
    } catch { /* ignore */ }
  }

  const handleDelete = async (id) => {
    try {
      await api.delete(`/invoices/${id}`)
      await Promise.all([fetchInvoices(), fetchNextNumber()])
    } catch { /* ignore */ }
  }

  // Generate the invoice as a real PDF and trigger a browser download —
  // no print dialog. Renders text directly with jsPDF so the output is
  // selectable / searchable (not a flattened raster) and small.
  // Layout mirrors the on-screen InvoicePreview / the previous print HTML.
  const handleDownload = (invoice) => {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' })
    const W = doc.internal.pageSize.getWidth()
    const H = doc.internal.pageSize.getHeight()
    const M = 50                              // page margin
    const colGap = 28
    const rightX = M + (W - M * 2 + colGap) / 2  // start of right column

    const RULE = [204, 204, 204]
    const RULE_LIGHT = [229, 229, 229]
    const INK = [17, 17, 17]
    const MUTED = [102, 102, 102]
    const FAINT = [153, 153, 153]
    const SUB = [85, 85, 85]
    const RED = [229, 32, 23]

    const setColor = ([r, g, b]) => doc.setTextColor(r, g, b)
    const setRuleColor = ([r, g, b]) => doc.setDrawColor(r, g, b)
    const text = (s, x, y) => doc.text(String(s ?? ''), x, y)
    const rightAlign = (s, x, y) => {
      const str = String(s ?? '')
      doc.text(str, x - doc.getTextWidth(str), y)
    }
    const rule = (y, color = RULE) => {
      setRuleColor(color)
      doc.setLineWidth(0.6)
      doc.line(M, y, W - M, y)
    }

    // Header: boom. logo
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(30)
    setColor(RED)
    text('MARKET STREET', M, 75)

    // INVOICE title
    doc.setFontSize(38)
    setColor(INK)
    text('INVOICE', M, 120)

    // Meta lines
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    setColor(MUTED)
    text(`NO.: ${padInvoiceNumber(invoice.invoice_number)}`, M, 142)
    text(`PURCHASE ORDER #: ${invoice.purchase_order || 'N/A'}`, M, 156)

    rule(176)

    // Two-column body
    let yL = 198
    let yR = 198
    const LH = 14

    // ── Left column: Bill To ──────────────────────────────────────────
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    setColor(INK)
    text('Bill To:', M, yL); yL += LH + 4

    doc.setFont('helvetica', 'normal')
    setColor([51, 51, 51])
    ;(invoice.bill_to || '').split('\n').forEach(line => {
      if (line.trim()) { text(line, M, yL); yL += LH }
    })
    if (invoice.bill_to_address) {
      setColor(SUB)
      invoice.bill_to_address.split('\n').forEach(line => {
        if (line.trim()) { text(line, M, yL); yL += LH }
      })
    }

    // ── Right column: Funds Payable To ────────────────────────────────
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    setColor(INK)
    text('FUNDS PAYABLE TO:', rightX, yR); yR += LH + 4

    doc.setFont('helvetica', 'normal')
    setColor([51, 51, 51])
    text(BOOM_INFO.company, rightX, yR); yR += LH
    BOOM_INFO.address.forEach(l => { text(l, rightX, yR); yR += LH })

    yR += 10
    text(`CONTACT: ${BOOM_INFO.contact}`, rightX, yR); yR += LH
    text(`PHONE: ${BOOM_INFO.phone}`,     rightX, yR); yR += LH
    text(`EMAIL: ${BOOM_INFO.email}`,     rightX, yR); yR += LH

    yR += 8
    setRuleColor(RULE_LIGHT); doc.setLineWidth(0.5)
    doc.line(rightX, yR, W - M, yR); yR += LH
    text(`EIN: ${BOOM_INFO.ein}`, rightX, yR); yR += LH

    yR += 8
    doc.line(rightX, yR, W - M, yR); yR += LH
    text(`BANK: ${BOOM_INFO.bank.name}`, rightX, yR); yR += LH
    text(`ADDRESS: ${BOOM_INFO.bank.address[0]}, ${BOOM_INFO.bank.address[1]}`, rightX, yR); yR += LH
    text(`NAME: ${BOOM_INFO.bank.accountName}`, rightX, yR); yR += LH
    text(`TYPE: ${BOOM_INFO.bank.type}`,         rightX, yR); yR += LH
    text(`SWIFT: ${BOOM_INFO.bank.swift}`,       rightX, yR); yR += LH
    text(`ROUTING: ${BOOM_INFO.bank.routingWire}`, rightX, yR); yR += LH
    // Second routing line is indented under "ROUTING:" so the values stack.
    text(BOOM_INFO.bank.routingAch, rightX + 56, yR); yR += LH
    text(`ACCOUNT: ${BOOM_INFO.bank.account}`, rightX, yR); yR += LH

    // ── Below the two columns ────────────────────────────────────────
    let y = Math.max(yL, yR) + 14

    doc.setFontSize(11)
    setColor(INK)
    doc.setFont('helvetica', 'bold')
    text('DUE BY:', M, y)
    doc.setFont('helvetica', 'normal')
    text(invoice.due_by || 'UPON RECEIPT', M + 56, y)
    y += 14
    rule(y); y += 18

    // Description / Amount Due header
    doc.setFont('helvetica', 'bold')
    text('Description', M, y)
    rightAlign('Amount Due', W - M, y)
    y += 8
    rule(y, RULE_LIGHT); y += 14

    // Line items
    doc.setFont('helvetica', 'normal')
    const items = (invoice.line_items && invoice.line_items.length)
      ? invoice.line_items
      : [{ description: invoice.description, amount: invoice.amount }]
    for (const li of items) {
      // Wrap long descriptions to the column width so they don't run into
      // the right-aligned amount.
      const maxDescW = (W - M) - M - 90
      const lines = doc.splitTextToSize(String(li.description || ''), maxDescW)
      lines.forEach((line, i) => {
        text(line, M, y + i * LH)
      })
      rightAlign(formatCurrency(li.amount, invoice.currency), W - M, y)
      y += LH * Math.max(lines.length, 1)
    }
    y += 4
    rule(y); y += 18

    // TOTAL DUE
    doc.setFont('helvetica', 'bold')
    text('TOTAL DUE', M, y)
    rightAlign(formatCurrency(invoice.amount, invoice.currency), W - M, y)
    y += 14
    rule(y); y += 16

    // Footer date
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    setColor(FAINT)
    text(formatInvoiceDate(invoice), M, y)

    // Match the legacy filename pattern (no extension was added before;
    // jsPDF will append .pdf automatically).
    const safePayee = (invoice.bill_to || '').split('\n')[0].replace(/[^a-zA-Z0-9]/g, '')
    const filename = `MarketStreet-Invoice#${padInvoiceNumber(invoice.invoice_number)}-${safePayee}.pdf`
    doc.save(filename)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.Block h="h-24" />
        <Skeleton.Block h="h-64" />
      </div>
    )
  }

  const validPreviewItems = lineItems.filter(li => li.description || li.amount)
  const previewInvoice = {
    invoice_number: editingInvoice ? editingInvoice.invoice_number : nextNumber,
    bill_to: form.bill_to || 'Client Name',
    bill_to_address: form.bill_to_address || '',
    line_items: validPreviewItems.length ? validPreviewItems.map(li => ({ description: li.description || 'Item', amount: parseFloat(li.amount) || 0 })) : [{ description: 'Description', amount: 0 }],
    amount: validPreviewItems.reduce((s, li) => s + parseFloat(li.amount || 0), 0),
    currency: form.currency || 'USD',
    purchase_order: 'N/A',
    // Was hardcoded to 'UPON RECEIPT' — the page had no way to say anything else.
    due_by: due.due_by || 'UPON RECEIPT',
    // The date the DUE BY line above was counted from, so the preview cannot
    // print one day and bill from another.
    invoice_date: due.invoice_date || null,
    created_at: editingInvoice?.created_at || new Date().toISOString(),
  }

  return (
    <div className="space-y-8">
      {/* Create Form + Live Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        {/* Form */}
        <div className="bg-card rounded-lg border border-rule shadow-sm p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingInvoice ? `Edit Invoice #${padInvoiceNumber(editingInvoice.invoice_number)}` : 'New Invoice'}
            </h2>
            {editingInvoice && (
              <button
                type="button"
                onClick={cancelEdit}
                className="text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancel edit
              </button>
            )}
          </div>
          <p className="text-sm text-gray-500 mb-6">
            {editingInvoice
              ? `Editing invoice for ${editingInvoice.bill_to?.split('\n')[0]}`
              : `Invoice #${padInvoiceNumber(nextNumber)} will be created`}
          </p>

          <form ref={formRef} onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bill To</label>
              <textarea
                value={form.bill_to}
                onChange={e => setForm(f => ({ ...f, bill_to: e.target.value }))}
                placeholder="Company name&#10;Contact name"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none resize-vertical"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
              <textarea
                value={form.bill_to_address}
                onChange={e => setForm(f => ({ ...f, bill_to_address: e.target.value }))}
                placeholder="Street address, city, state, zip"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none resize-vertical"
              />
            </div>
            {/* ── The date the invoice bears ────────────────────────────────
                Editable, and it is the anchor everything else counts from: Net 30
                means thirty days from THIS day, so changing it moves the deadline
                shown below and the deadline that gets stored. The server does that
                arithmetic and this page asks for the answer, which is why the
                preview cannot drift from what is saved.

                Blank means "today, in the company's timezone" — decided by the
                server at save, not here, so an invoice raised at 5pm Pacific is
                not dated tomorrow. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Invoice Date</label>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="date"
                  value={form.invoice_date}
                  onChange={e => setForm(prev => ({ ...prev, invoice_date: e.target.value }))}
                  aria-label="Invoice date"
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
                {form.invoice_date ? (
                  <button
                    type="button"
                    onClick={() => setForm(prev => ({ ...prev, invoice_date: '' }))}
                    className="text-xs text-gray-400 hover:text-gray-700 underline"
                  >
                    {editingInvoice ? 'reset' : "use today's date"}
                  </button>
                ) : (
                  <span className="text-xs text-gray-500">
                    Dated {due.invoice_date || 'today'} unless you pick another day
                  </span>
                )}
              </div>
            </div>
            {/* Payment terms — what the invoice tells the client, and the date it
                works out to. Both are shown because "Net 30" makes a client count
                and a bare date gives them nothing to check.
                The date comes from the server (GET /invoices/due-date) rather than
                being worked out here: this preview has to be the document that
                gets saved, and two implementations of "add 30 days" on opposite
                sides of a timezone is how a deadline moves by a day with nothing
                saying so. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Payment Terms</label>
              <div className="flex items-center gap-2">
                <select
                  value={form.payment_terms}
                  onChange={e => setForm(prev => ({ ...prev, payment_terms: e.target.value, due_date: '' }))}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none bg-white"
                >
                  {(termOptions.length ? termOptions : [{ label: 'Net 30' }]).map(t => (
                    <option key={t.label} value={t.label}>{t.label}</option>
                  ))}
                </select>
                {/* A custom date cannot precede the invoice's own date, which the
                    server reports alongside the deadline and also enforces. */}
                {form.payment_terms === 'Custom' ? (
                  <input
                    type="date"
                    value={form.due_date}
                    min={due.invoice_date || undefined}
                    onChange={e => setForm(prev => ({ ...prev, due_date: e.target.value }))}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                  />
                ) : null}
                {/* What the invoice will actually print. An error is stated rather
                    than swallowed — a Custom term with no date would otherwise be
                    refused only on submit. */}
                <span className={`text-xs ${due.error ? 'text-amber-700' : 'text-gray-500'}`}>
                  {due.error ? due.error : due.due_by ? `Due ${due.due_by}` : 'Due upon receipt'}
                </span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">Line Items</label>
                {/* Currency picker — applies to every line item + the total
                    on this invoice. Defaults to USD; the saved row carries
                    the chosen code into the preview, PDF, table, and grid
                    so the invoice renders in the chosen currency
                    everywhere. */}
                <label className="flex items-center gap-2 text-xs text-gray-500">
                  Currency
                  <select
                    value={form.currency}
                    onChange={e => setForm(prev => ({ ...prev, currency: e.target.value }))}
                    className="px-2 py-1 border border-gray-300 rounded-md text-xs font-semibold focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none bg-white"
                  >
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
              <div className="space-y-2">
                {lineItems.map((li, idx) => (
                  <div key={idx} className="flex gap-2 items-start">
                    <input
                      type="text"
                      value={li.description}
                      onChange={e => setLineItems(prev => prev.map((item, i) => i === idx ? { ...item, description: e.target.value } : item))}
                      placeholder="Description"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={li.amount}
                      onChange={e => setLineItems(prev => prev.map((item, i) => i === idx ? { ...item, amount: e.target.value } : item))}
                      placeholder="0.00"
                      className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                    />
                    {lineItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setLineItems(prev => prev.filter((_, i) => i !== idx))}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setLineItems(prev => [...prev, { description: '', amount: '' }])}
                className="mt-2 flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                <Plus size={13} /> Add item
              </button>
              {lineItems.filter(li => li.amount).length > 0 && (
                <div className="mt-2 text-right text-sm font-semibold text-gray-900">
                  Total: {formatCurrency(lineItems.reduce((s, li) => s + parseFloat(li.amount || 0), 0), form.currency)}
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={creating}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {creating ? <Loader className="animate-spin" size={16} /> : editingInvoice ? <Pencil size={16} /> : <Plus size={16} />}
              {editingInvoice ? 'Update Invoice' : 'Create Invoice'}
            </button>
          </form>
        </div>

        {/* Live Preview */}
        <div ref={previewRef}>
          <InvoicePreview invoice={previewInvoice} />
        </div>
      </div>

      {/* Saved Invoices */}
      {invoices.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Saved Invoices ({invoices.length})</h2>
            <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'table' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Table2 size={13} />
                Table
              </button>
              <button
                onClick={() => setViewMode('card')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'card' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <LayoutGrid size={13} />
                Cards
              </button>
            </div>
          </div>

          {/* Table View */}
          {viewMode === 'table' && (
            <div className="bg-card rounded-lg border border-rule shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-rule">
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Invoice #</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Bill To</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Description</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Amount</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Date</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Status</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {invoices.map(inv => (
                    <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className="text-sm font-semibold text-gray-900">#{padInvoiceNumber(inv.invoice_number)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-700">{inv.bill_to}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-500">{inv.description}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-sm font-medium text-gray-900">{formatCurrency(inv.amount, inv.currency)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-500">
                          {/* The date the document bears, not the reader's render of
                              a timestamp — the list and the invoice must agree. */}
                          {shortInvoiceDate(inv)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => cyclePaymentStatus(inv)}
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold cursor-pointer border-none ${PAID_BADGE[inv.payment_status] || PAID_BADGE.Unpaid}`}
                          title="Click to change status"
                        >
                          {inv.payment_status || 'Unpaid'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => startEdit(inv)}
                            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => setPreviewInv(inv)}
                            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                            title="Preview"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={() => handleDownload(inv)}
                            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                            title="Download PDF"
                          >
                            <Download size={14} />
                          </button>
                          <button
                            onClick={() => handleDelete(inv.id)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Card View */}
          {viewMode === 'card' && (
            <div className="space-y-4">
              {invoices.map(inv => (
                <div key={inv.id} className="bg-card rounded-lg border border-rule shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-3 bg-gray-50 border-b border-rule">
                    <div className="flex items-center gap-3">
                      <FileText size={16} className="text-gray-400" />
                      <span className="text-sm font-semibold text-gray-900">Invoice #{padInvoiceNumber(inv.invoice_number)}</span>
                      <button
                        onClick={() => cyclePaymentStatus(inv)}
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold cursor-pointer border-none ${PAID_BADGE[inv.payment_status] || PAID_BADGE.Unpaid}`}
                        title="Click to change status"
                      >
                        {inv.payment_status || 'Unpaid'}
                      </button>
                      <span className="text-xs text-gray-500">— {inv.bill_to}</span>
                      <span className="text-xs font-medium text-gray-700">{formatCurrency(inv.amount, inv.currency)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => startEdit(inv)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                      >
                        <Pencil size={13} />
                        Edit
                      </button>
                      <button
                        onClick={() => handleDownload(inv)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                      >
                        <Download size={13} />
                        Download
                      </button>
                      <button
                        onClick={() => handleDelete(inv.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="p-6">
                    <InvoicePreview invoice={inv} compact />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Preview Modal */}
      {previewInv && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8 overflow-y-auto bg-overlay" onClick={() => setPreviewInv(null)}>
          <div className="relative w-full max-w-3xl mx-4" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setPreviewInv(null)}
              className="absolute -top-2 -right-2 z-10 p-1.5 bg-card rounded-full shadow-lg text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X size={16} />
            </button>
            <InvoicePreview invoice={previewInv} />
            <div className="flex justify-center gap-3 mt-4">
              <button
                onClick={() => handleDownload(previewInv)}
                className="flex items-center gap-2 px-4 py-2 bg-card text-sm font-medium text-gray-700 rounded-lg border border-rule shadow-sm hover:bg-gray-50 transition-colors"
              >
                <Download size={14} />
                Download
              </button>
              <button
                onClick={() => setPreviewInv(null)}
                className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-sm font-medium text-white rounded-lg shadow-sm hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
