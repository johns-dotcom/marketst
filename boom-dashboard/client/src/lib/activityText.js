// One sentence for an activity_log row. Extracted from ActivityHistory so
// Home's Recent activity and the Activity page say the same thing about the
// same row.
export function humanizeAction(row) {
  const action = (row.action || '')
  const actionLower = action.toLowerCase()
  const endpoint = row.endpoint || ''
  const method = (row.method || '').toUpperCase()

  // Already human-readable actions from backend logger
  if (actionLower.startsWith('viewed') || actionLower.startsWith('signed') || actionLower.startsWith('created') ||
      actionLower.startsWith('updated') || actionLower.startsWith('deleted') || actionLower.startsWith('assigned') ||
      actionLower.startsWith('added') || actionLower.startsWith('approved') || actionLower.startsWith('rejected') ||
      actionLower.startsWith('uploaded') || actionLower.startsWith('removed') || actionLower.startsWith('merged') ||
      actionLower.startsWith('renamed') || actionLower.startsWith('restored') || actionLower.startsWith('split') ||
      actionLower.startsWith('bulk') || actionLower.startsWith('sent') || actionLower.startsWith('exported') ||
      actionLower.startsWith('downloaded') || actionLower.startsWith('ai-') || actionLower.startsWith('ran') ||
      actionLower.startsWith('submitted') || actionLower.startsWith('performed') || actionLower.startsWith('registered')) {
    return action
  }

  // Fallback: unmapped endpoints → translate to readable text
  if (method === 'POST' && endpoint.includes('/file/invoice')) return 'Uploaded invoice document'
  if (method === 'POST' && endpoint.includes('/file/w9')) return 'Uploaded W9'
  if (method === 'POST' && endpoint.includes('/file/proof')) return 'Uploaded proof of payment'
  if (method === 'POST' && endpoint.includes('/file/receipt')) return 'Uploaded receipt'
  if (method === 'DELETE' && endpoint.includes('/file/invoice')) return 'Removed invoice document'
  if (method === 'DELETE' && endpoint.includes('/file/w9')) return 'Removed W9'
  if (method === 'DELETE' && endpoint.includes('/file/proof')) return 'Removed proof of payment'
  if (method === 'DELETE' && endpoint.includes('/file/receipt')) return 'Removed receipt'
  if (method === 'POST' && endpoint.includes('/approve')) return 'Approved invoice'
  if (method === 'POST' && endpoint.includes('/reject')) return 'Rejected invoice'
  if (method === 'POST' && endpoint.includes('/split')) return 'Split invoice between artists'
  if (method === 'DELETE' && endpoint.includes('/splits')) return 'Removed invoice split'
  if (method === 'POST' && endpoint.includes('/restore')) return 'Restored deleted entry'
  if (method === 'POST' && endpoint.includes('/bulk-approve')) return 'Bulk approved invoices'
  if (method === 'POST' && endpoint.includes('/send-confirmation')) return 'Sent payment confirmation'
  if (method === 'PUT' && endpoint.includes('/bk/entries/')) return 'Updated ledger entry'
  if (method === 'PUT' && endpoint.includes('/bk/payments/')) return 'Updated payment status'
  if (method === 'POST' && endpoint.includes('/bk/entries/batch')) return 'Bulk uploaded invoices'
  if (method === 'POST' && endpoint.includes('/bk/entries')) return 'Added invoice to ledger'
  if (method === 'DELETE' && endpoint.includes('/bk/entries/')) return 'Deleted ledger entry'
  if (method === 'POST' && endpoint.includes('/bk/parse')) return 'AI-scanned document'
  if (method === 'PUT' && endpoint.includes('/vendors/rename')) return 'Renamed vendor'
  if (method === 'POST' && endpoint.includes('/vendors/merge')) return 'Merged vendors'
  if (method === 'POST' && endpoint.includes('/vendors/aliases')) return 'Added vendor alias'
  if (method === 'POST' && endpoint.includes('/team/tasks')) return 'Created task'
  if (method === 'PUT' && endpoint.includes('/team/tasks/')) return 'Updated task'
  if (method === 'DELETE' && endpoint.includes('/team/tasks/')) return 'Deleted task'
  if (method === 'POST' && endpoint.includes('/deals')) return 'Added deal'
  if (method === 'PUT' && endpoint.includes('/deals/')) return 'Updated deal'
  if (method === 'DELETE' && endpoint.includes('/deals/')) return 'Deleted deal'
  if (method === 'POST' && endpoint.includes('/contracts')) return 'Added contract'
  if (method === 'PUT' && endpoint.includes('/contracts/')) return 'Updated contract'
  if (method === 'POST' && endpoint.includes('/releases')) return 'Added release'
  if (method === 'PUT' && endpoint.includes('/releases/')) return 'Updated release'
  if (method === 'POST' && endpoint.includes('/settings/users')) return 'Added user'
  if (method === 'PUT' && endpoint.includes('/settings/users/')) return 'Updated user'
  if (method === 'DELETE' && endpoint.includes('/settings/users/')) return 'Removed user'
  if (method === 'PUT' && endpoint.includes('/settings/permissions/')) return 'Updated permissions'
  if (method === 'POST' && endpoint.includes('/auth/impersonate')) return 'Viewing as another user'
  if (method === 'GET' && endpoint.includes('/export')) return 'Exported data'
  if (method === 'GET' && endpoint.includes('/download-files')) return 'Downloaded expense files'
  if (method === 'PUT' && endpoint.includes('/salary/')) return 'Updated salary info'

  // Strip raw HTTP method prefixes
  if (action && !action.startsWith('GET ') && !action.startsWith('POST ') && !action.startsWith('PUT ') && !action.startsWith('DELETE ')) {
    return action
  }

  return 'Activity'
}
