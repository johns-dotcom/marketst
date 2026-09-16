/**
 * Reusable skeleton loading placeholders.
 * Usage:
 *   <Skeleton.Line />           — single text line
 *   <Skeleton.Line w="w-32" />  — short line
 *   <Skeleton.Block h="h-40" /> — rectangular block
 *   <Skeleton.Circle />         — avatar circle
 *   <Skeleton.Card />           — stat card
 *   <Skeleton.Table rows={6} cols={5} /> — table
 *   <Skeleton.PageHeader />     — page title + subtitle
 */

const base = 'skeleton-shimmer rounded'

function Line({ w = 'w-full', h = 'h-3', className = '' }) {
  return <div className={`${base} ${w} ${h} ${className}`} />
}

function Block({ w = 'w-full', h = 'h-32', className = '' }) {
  return <div className={`${base} ${w} ${h} rounded-xl ${className}`} />
}

function Circle({ size = 'w-10 h-10' }) {
  return <div className={`${base} ${size} rounded-full`} />
}

function Card() {
  return (
    <div className="card px-5 py-4 space-y-2">
      <Line w="w-20" h="h-2" />
      <Line w="w-16" h="h-6" />
      <Line w="w-12" h="h-2" />
    </div>
  )
}

function TableRow({ cols = 5 }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3.5">
          <Line w={i === 0 ? 'w-16' : i === 1 ? 'w-32' : 'w-20'} h="h-3" />
        </td>
      ))}
    </tr>
  )
}

function Table({ rows = 6, cols = 5 }) {
  return (
    <div className="space-y-0">
      {/* Header */}
      <div className="flex gap-6 px-4 py-3 border-b border-gray-100">
        {Array.from({ length: cols }).map((_, i) => (
          <Line key={i} w="w-16" h="h-2" />
        ))}
      </div>
      {/* Rows */}
      <table className="w-full">
        <tbody className="divide-y divide-gray-50">
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i} cols={cols} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PageHeader() {
  return (
    <div className="space-y-2">
      <Line w="w-48" h="h-7" />
      <Line w="w-64" h="h-3" />
    </div>
  )
}

function StatCards({ count = 4 }) {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-${count} gap-4`}>
      {Array.from({ length: count }).map((_, i) => <Card key={i} />)}
    </div>
  )
}

function TaskList({ count = 5 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-lg border border-gray-100">
          <div className={`${base} w-5 h-5 rounded-full`} />
          <div className={`${base} w-1.5 h-1.5 rounded-full`} />
          <div className="flex-1 space-y-1.5">
            <Line w={i % 2 === 0 ? 'w-3/4' : 'w-1/2'} h="h-3" />
            <Line w="w-20" h="h-2" />
          </div>
          <Line w="w-16" h="h-3" />
        </div>
      ))}
    </div>
  )
}

function KanbanBoard({ cols = 6, cards = 2 }) {
  return (
    <div className={`grid grid-cols-${cols} gap-3`}>
      {Array.from({ length: cols }).map((_, ci) => (
        <div key={ci} className="rounded-xl border border-gray-200 bg-white p-3 min-h-[16rem]">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100">
            <div className={`${base} w-2 h-2 rounded-full`} />
            <Line w="w-16" h="h-3" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: ci < 2 ? cards : 0 }).map((_, ri) => (
              <div key={ri} className="p-2.5 rounded-lg border border-gray-100 space-y-2">
                <Line w="w-full" h="h-3" />
                <Line w="w-16" h="h-2" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ArtistProfile() {
  return (
    <div className="space-y-6">
      <Line w="w-24" h="h-3" />
      <div className="flex items-start gap-5">
        <div className={`${base} w-20 h-20 rounded-xl`} />
        <div className="flex-1 space-y-2">
          <Line w="w-48" h="h-8" />
          <Line w="w-32" h="h-3" />
        </div>
      </div>
      <StatCards count={5} />
      <div className="flex gap-4 border-b border-gray-200 pb-0">
        {['w-20','w-24','w-20','w-24'].map((w, i) => <Line key={i} w={w} h="h-4" className="mb-2" />)}
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Block h="h-48" />
        <Block h="h-48" />
      </div>
    </div>
  )
}

const Skeleton = { Line, Block, Circle, Card, Table, TableRow, PageHeader, StatCards, TaskList, KanbanBoard, ArtistProfile }
export default Skeleton
