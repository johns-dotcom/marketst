// A payee that opens its vendor page — in a NEW TAB, deliberately.
//
// These sit inside review surfaces: the Reports drill, its deck, and the Artist
// Campaigns unattributed queue. Each is a pass over hundreds of rows, and
// navigating away loses the scroll position, the selection and the filter. A
// side-trip to look at one vendor must not cost the review, so it opens beside it.
//
// `stopPropagation` because these live inside rows that are themselves
// clickable — a label, a card, a checkbox row.
//
// A row in a drill, a deck or a queue is a question — whose payment is this, does
// it have an invoice, which artist — and every answer lives on the vendor page:
// its invoices, its bank lines, the attach picker, the artist controls.
//
// Measured before it became a link: all 239 distinct payees in one Reports drill
// open a REAL vendor page, descriptor-shaped ones included ("Online transfer to
// CHK Confirmation"), because the entry booked from that bank line carries it as
// its payee. So there is no dead-end case to special-case.
//
// Extracted from a local definition in Reports.jsx, whose own comment noted the
// copies piling up. Import it rather than writing the anchor again.
//
// `...rest` so the six inline-styled Bk pages can use it. The Bank Ledger's
// payee cell renders this as an icon beside an editable input and needs a
// `style` and hover handlers to match the Artist link two columns over — a
// className alone cannot express that on a page that does not use Tailwind for
// its table chrome. Spread LAST so a caller can override, but after `href` and
// `target`, which are what the component is for and are not negotiable.
export default function PayeeLink({ payee, className = '', title, children, ...rest }) {
  if (!payee) return <span className={className}>—</span>
  return (
    <a
      {...rest}
      href={`/bk/vendors/${encodeURIComponent(payee)}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={title || `Open ${payee}'s vendor page in a new tab — invoices, bank lines and matching. Your place here is kept.`}
      className={`${className} hover:text-indigo-600 hover:underline decoration-dotted underline-offset-2`}
    >
      {children || payee}
    </a>
  )
}
