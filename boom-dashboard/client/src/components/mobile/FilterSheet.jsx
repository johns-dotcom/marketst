import BottomSheet from '../ui/BottomSheet'

/**
 * Filters drawer for mobile card views. Filter state stays in the
 * page — pages pass their own selects/inputs as children so there is
 * no prop explosion here. Footer: Clear all + Done.
 */
export default function FilterSheet({ open, onClose, onClearAll, activeCount = 0, children }) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={activeCount > 0 ? `Filters (${activeCount} active)` : 'Filters'}
      footer={
        <div className="flex gap-2">
          <button
            onClick={onClearAll}
            className="flex-1 py-2.5 rounded-xl border border-rule text-sm font-semibold text-gray-600 active:scale-[0.98]"
          >
            Clear all
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-boom-600 text-white text-sm font-semibold active:scale-[0.98]"
          >
            Done
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">{children}</div>
    </BottomSheet>
  )
}

/** Labeled row inside the filter sheet — keeps the stacked selects consistent. */
export function FilterField({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</span>
      {children}
    </label>
  )
}
