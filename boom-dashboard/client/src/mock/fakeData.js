// Fake demo-mode dataset. Presented to any user with `is_test = true` in
// place of real company data. All IDs are in the 900000+ range so they
// cannot collide with real DB rows.
//
// The data here is intentionally generic and safe to show externally — no
// real artist, vendor, or payment details, just plausible-looking strings.

const today = new Date()
const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d) }
const daysAhead = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d) }

// ── Artists ─────────────────────────────────────────────────────────────────
export const FAKE_ARTISTS = [
  { id: 900001, name: 'Nova Blaze',       genre: 'Pop',            total_releases: 4 },
  { id: 900002, name: 'Oaxaca Drift',     genre: 'Latin',          total_releases: 2 },
  { id: 900003, name: 'Mila Varela',      genre: 'R&B',            total_releases: 3 },
  { id: 900004, name: 'Saint Meridian',   genre: 'Indie',          total_releases: 1 },
  { id: 900005, name: 'Frequency 7',      genre: 'Electronic',     total_releases: 2 },
  { id: 900006, name: 'Juno Radić',       genre: 'Pop',            total_releases: 1 },
  { id: 900007, name: 'Brass Theory',     genre: 'Hip-Hop',        total_releases: 3 },
  { id: 900008, name: 'Isla Veil',        genre: 'Indie',          total_releases: 2 },
]

// ── Releases ────────────────────────────────────────────────────────────────
export const FAKE_RELEASES = [
  { id: 910001, artist_id: 900001, artist_name: 'Nova Blaze',    project_name: 'Satellite',         release_date: daysAhead(14), release_type: 'Single',  genre: 'Pop',        priority: 'High',   upc: '884977012345', isrc: 'USBAM2500001', spotify_uri: 'spotify:track:demo1' },
  { id: 910002, artist_id: 900002, artist_name: 'Oaxaca Drift',  project_name: 'Vuelve Al Sur',     release_date: daysAhead(28), release_type: 'EP',      genre: 'Latin',      priority: 'Medium', upc: '884977012346' },
  { id: 910003, artist_id: 900003, artist_name: 'Mila Varela',   project_name: 'Late Message',      release_date: daysAhead(7),  release_type: 'Single',  genre: 'R&B',        priority: 'High' },
  { id: 910004, artist_id: 900004, artist_name: 'Saint Meridian',project_name: 'Ember',             release_date: daysAhead(42), release_type: 'Album',   genre: 'Indie',      priority: 'High' },
  { id: 910005, artist_id: 900005, artist_name: 'Frequency 7',   project_name: 'Prism',             release_date: daysAgo(3),    release_type: 'Single',  genre: 'Electronic', priority: 'Medium' },
  { id: 910006, artist_id: 900001, artist_name: 'Nova Blaze',    project_name: 'Midtown',           release_date: daysAgo(21),   release_type: 'Single',  genre: 'Pop',        priority: 'Medium' },
  { id: 910007, artist_id: 900007, artist_name: 'Brass Theory',  project_name: 'New Order',         release_date: daysAgo(45),   release_type: 'EP',      genre: 'Hip-Hop',    priority: 'High' },
  { id: 910008, artist_id: 900003, artist_name: 'Mila Varela',   project_name: 'For The Time',      release_date: daysAgo(90),   release_type: 'Single',  genre: 'R&B',        priority: 'Low' },
  { id: 910009, artist_id: 900008, artist_name: 'Isla Veil',     project_name: 'Soft Weather',      release_date: daysAhead(60), release_type: 'EP',      genre: 'Indie',      priority: 'Medium' },
  { id: 910010, artist_id: 900007, artist_name: 'Brass Theory',  project_name: 'Cut the Air',       release_date: daysAgo(150),  release_type: 'Single',  genre: 'Hip-Hop',    priority: 'Medium' },
  { id: 910011, artist_id: 900002, artist_name: 'Oaxaca Drift',  project_name: 'Golfo',             release_date: daysAgo(180),  release_type: 'Album',   genre: 'Latin',      priority: 'High' },
  { id: 910012, artist_id: 900006, artist_name: 'Juno Radić',    project_name: 'Elegant Trouble',   release_date: daysAhead(35), release_type: 'Single',  genre: 'Pop',        priority: 'Low' },
]

// ── Expenses / Invoices (ledger) ────────────────────────────────────────────
export const FAKE_EXPENSES = [
  { id: 920001, invoice_date: daysAgo(10), payee: 'Harborline Studios LLC', artist: 'Nova Blaze', song: 'Satellite', amount: 2500, currency: 'USD', invoice_number: 'HS-2501', category: 'Recording', boom_rep: 'Demo Marcus',   payment_method: 'ACH',    payment_status: 'Paid',   payment_date: daysAgo(3),  scheduled_payment_date: daysAgo(3),  status: 'approved', has_invoice: true, has_proof: true },
  { id: 920002, invoice_date: daysAgo(14), payee: 'Signal North Mixing',    artist: 'Nova Blaze', song: 'Satellite', amount: 1800, currency: 'USD', invoice_number: '2501',    category: 'Mixing & Mastering', boom_rep: 'Demo Marcus', payment_method: 'Wire',   payment_status: 'Unpaid', payment_date: null,         scheduled_payment_date: daysAhead(7),  status: 'approved', has_invoice: true, has_proof: false },
  { id: 920003, invoice_date: daysAgo(7),  payee: 'Casey Film Co.',         artist: 'Mila Varela', song: 'Late Message', amount: 4800, currency: 'USD', invoice_number: 'CF-88', category: 'Music Video', boom_rep: 'Demo Priya', payment_method: 'ACH',    payment_status: 'Unpaid', payment_date: null,         scheduled_payment_date: daysAhead(3),  status: 'approved', has_invoice: true, has_proof: false },
  { id: 920004, invoice_date: daysAgo(22), payee: 'Edge Digital Marketing', artist: 'Saint Meridian', song: 'Ember', amount: 3500, currency: 'USD', invoice_number: 'EDM-112', category: 'Marketing', boom_rep: 'Demo Alex',  payment_method: 'Wire',   payment_status: 'Paid',   payment_date: daysAgo(5),  scheduled_payment_date: daysAgo(5),  status: 'approved', has_invoice: true, has_proof: true },
  { id: 920005, invoice_date: daysAgo(1),  payee: 'Morgan & Polk PR',       artist: 'Brass Theory', song: 'New Order', amount: 2200, currency: 'USD', invoice_number: 'MP-0419', category: 'PR', boom_rep: 'Georgia',     payment_method: 'Check',  payment_status: 'Unpaid', payment_date: null,         scheduled_payment_date: daysAhead(14), status: 'approved', has_invoice: true, has_proof: false },
  { id: 920006, invoice_date: daysAgo(6),  payee: 'Elan Cover Art',         artist: 'Isla Veil', song: 'Soft Weather', amount: 850,  currency: 'USD', invoice_number: 'EC-221', category: 'Design', boom_rep: 'Demo Marcus',      payment_method: 'ACH',    payment_status: 'Paid',   payment_date: daysAgo(2),  scheduled_payment_date: daysAgo(2),  status: 'approved', has_invoice: true, has_proof: true },
  { id: 920007, invoice_date: daysAgo(18), payee: 'Tri-City Legal Partners',artist: null,         song: null,       amount: 1500, currency: 'USD', invoice_number: 'TCLP-07',  category: 'Legal',  boom_rep: 'John',       payment_method: 'Wire',   payment_status: 'Paid',   payment_date: daysAgo(10), scheduled_payment_date: daysAgo(10), status: 'approved', has_invoice: true, has_proof: true },
  { id: 920008, invoice_date: daysAgo(4),  payee: 'Verso Distribution',     artist: 'Frequency 7', song: 'Prism',    amount: 640,  currency: 'USD', invoice_number: 'VD-550',  category: 'Distribution', boom_rep: 'Demo Chi', payment_method: 'ACH',    payment_status: 'Unpaid', payment_date: null,        scheduled_payment_date: daysAhead(20), status: 'approved', has_invoice: true, has_proof: false },
  { id: 920009, invoice_date: daysAgo(12), payee: 'Harborline Studios LLC', artist: 'Oaxaca Drift', song: 'Vuelve Al Sur', amount: 3200, currency: 'USD', invoice_number: 'HS-2519', category: 'Recording', boom_rep: 'Demo Priya',  payment_method: 'ACH',    payment_status: 'Unpaid', payment_date: null,      scheduled_payment_date: daysAhead(5),  status: 'approved', has_invoice: true, has_proof: false },
  { id: 920010, invoice_date: daysAgo(30), payee: 'Aurelia Travel Agency',  artist: 'Nova Blaze',  song: null,       amount: 1250, currency: 'USD', invoice_number: 'ATA-77',  category: 'Tour/Live', boom_rep: 'Demo Alex',  payment_method: 'Credit Card', payment_status: 'Paid', payment_date: daysAgo(14), scheduled_payment_date: daysAgo(14), status: 'approved', has_invoice: true, has_proof: true },
  { id: 920011, invoice_date: daysAgo(2),  payee: 'Brickhouse Merch Co.',   artist: 'Brass Theory', song: null,      amount: 2400, currency: 'USD', invoice_number: 'BMC-19',  category: 'Merch', boom_rep: 'Demo Marcus',       payment_method: 'Wire',   payment_status: 'Unpaid', payment_date: null,         scheduled_payment_date: daysAhead(10), status: 'approved', has_invoice: true, has_proof: false },
  { id: 920012, invoice_date: daysAgo(40), payee: 'Harborline Studios LLC', artist: 'Juno Radić',  song: 'Elegant Trouble', amount: 1950, currency: 'USD', invoice_number: 'HS-2471', category: 'Recording', boom_rep: 'Demo Marcus', payment_method: 'ACH',    payment_status: 'Paid',   payment_date: daysAgo(25), scheduled_payment_date: daysAgo(25), status: 'approved', has_invoice: true, has_proof: true },
  // Booked straight off a bank statement: `entry_source: 'bank_statement'`, and
  // therefore no invoice number and no invoice file — that combination IS the
  // record type. Without a couple of these the ledger's Bank items view reads
  // as empty for a test user, which is the opposite of the real ledger, where
  // statement-born rows are the majority.
  { id: 920013, invoice_date: daysAgo(8),  payee: 'Sonoma Rehearsal Rooms',  artist: null, song: null, amount: 420,  currency: 'USD', invoice_number: null, category: 'Recording', boom_rep: null, payment_method: 'Credit Card', payment_status: 'Paid', payment_date: daysAgo(8),  scheduled_payment_date: daysAgo(8),  status: 'approved', has_invoice: false, has_proof: false, entry_source: 'bank_statement' },
  { id: 920014, invoice_date: daysAgo(16), payee: 'Delta Air Lines',         artist: 'Nova Blaze', song: null, amount: 738, currency: 'USD', invoice_number: null, category: 'Tour/Live', boom_rep: null, payment_method: 'Credit Card', payment_status: 'Paid', payment_date: daysAgo(16), scheduled_payment_date: daysAgo(16), status: 'approved', has_invoice: false, has_proof: false, entry_source: 'bank_statement' },
]

// ── Pending approvals (invoices waiting for review) ─────────────────────────
export const FAKE_APPROVALS = [
  { id: 930001, payee: 'Momentum Visuals LLC',   artist: 'Nova Blaze',    song: 'Satellite',     amount: 3400, currency: 'USD', invoice_number: 'MV-0317', category: 'Music Video', boom_rep: 'Demo Priya',    invoice_date: daysAgo(1), vendor_email: 'accounts@momentumvisuals.demo', vendor_submitted: true, vendor_name: 'Momentum Visuals LLC', status: 'pending', created_at: new Date().toISOString(), has_invoice: true, w9_entry_id: null,
    ai_scan: { discrepancies: [], summary: 'All form fields match the submitted invoice exactly.' } },
  { id: 930002, payee: 'Kino Sound Design',      artist: 'Saint Meridian',song: 'Ember',         amount: 950,  currency: 'USD', invoice_number: 'KSD-44',  category: 'Mixing & Mastering', boom_rep: 'Demo Marcus', invoice_date: daysAgo(2), vendor_email: 'k@kinosound.demo', vendor_submitted: true, vendor_name: 'Kino Sound Design', status: 'pending', created_at: new Date(Date.now()-86400000).toISOString(), has_invoice: true, w9_entry_id: null,
    ai_scan: { discrepancies: [{ field: 'amount', form_value: '$950', document_value: '$1,050', severity: 'high' }], summary: 'Amount on the invoice ($1,050) doesn\'t match the form ($950).' } },
  { id: 930003, payee: 'Dae Park Design',        artist: 'Isla Veil',     song: 'Soft Weather',  amount: 600,  currency: 'USD', invoice_number: 'DP-12',   category: 'Design',       boom_rep: 'Demo Marcus',   invoice_date: daysAgo(0), vendor_email: 'dae@daeparkdesign.demo', vendor_submitted: true, vendor_name: 'Dae Park Design', status: 'pending', created_at: new Date(Date.now()-3600000).toISOString(), has_invoice: true, w9_entry_id: null,
    ai_scan: { discrepancies: [], summary: 'All fields match.' } },
]

// ── Deals ──────────────────────────────────────────────────────────────────
export const FAKE_DEALS = [
  { id: 940001, artist_name: 'Milo Varela',   genre: 'Pop',      stage: 'Scouting',  ar_rep: 'Demo Priya', source: 'TikTok',    notes: 'Rising vocalist — strong TikTok traction', added_date: daysAgo(14) },
  { id: 940002, artist_name: 'The Nocturne',  genre: 'Indie',    stage: 'In talks',  ar_rep: 'Demo Chi',   source: 'SXSW',      notes: 'Met at SXSW, following up on demo',        added_date: daysAgo(20) },
  { id: 940003, artist_name: 'Poly Station',  genre: 'Electronic',stage: 'Offer sent',ar_rep: 'Demo Priya', source: 'Agent intro',notes: 'Terms out; waiting on response',          added_date: daysAgo(10) },
  { id: 940004, artist_name: 'Rue Bienvenida',genre: 'Latin',    stage: 'Signed',    ar_rep: 'Demo Alex',  source: 'Cold outreach',notes: 'Contract countersigned',                added_date: daysAgo(45) },
  { id: 940005, artist_name: 'Tidal Memory',  genre: 'R&B',      stage: 'Passed',    ar_rep: 'Demo Chi',   source: 'Manager',   notes: 'Not the right fit',                       added_date: daysAgo(60) },
]

// ── Contracts ──────────────────────────────────────────────────────────────
export const FAKE_CONTRACTS = [
  { id: 950001, artist_id: 900001, artist_name: 'Nova Blaze',    type: '360',        date_signed: daysAgo(180), expiration_date: daysAhead(550), status: 'Active', royalty_split: '50/50', advance: 25000, territory: 'World',     num_releases: 3 },
  { id: 950002, artist_id: 900003, artist_name: 'Mila Varela',   type: 'Distribution', date_signed: daysAgo(120), expiration_date: daysAhead(245), status: 'Active', royalty_split: '80/20', advance: 10000, territory: 'North America', num_releases: 2 },
  { id: 950003, artist_id: 900007, artist_name: 'Brass Theory',  type: 'Exclusive',  date_signed: daysAgo(400), expiration_date: daysAhead(70),  status: 'Active', royalty_split: '60/40', advance: 35000, territory: 'World',     num_releases: 5 },
  { id: 950004, artist_id: 900008, artist_name: 'Isla Veil',     type: 'Single',     date_signed: daysAgo(60),  expiration_date: daysAhead(305), status: 'Active', royalty_split: '70/30', advance: 5000,  territory: 'World',     num_releases: 1 },
]

// ── Team + tasks ───────────────────────────────────────────────────────────
export const FAKE_TEAM = [
  { id: 901, name: 'Demo Alex',    role: 'Admin', department: 'Operations', email: 'alex@demo.boom',   hierarchy_level: 1 },
  { id: 902, name: 'Demo Priya',   role: 'User',  department: 'A&R',        email: 'priya@demo.boom',  hierarchy_level: 3 },
  { id: 903, name: 'Demo Marcus',  role: 'User',  department: 'Marketing',  email: 'marcus@demo.boom', hierarchy_level: 3 },
  { id: 904, name: 'Demo Chi',     role: 'User',  department: 'Operations', email: 'chi@demo.boom',    hierarchy_level: 3 },
]
export const FAKE_TASKS = [
  { id: 960001, user_id: 902, description: 'Book studio time for Satellite overdubs', priority: 'High',   status: 'In progress', due_date: daysAhead(3) },
  { id: 960002, user_id: 903, description: 'Draft rollout plan for Prism',            priority: 'Medium', status: 'Pending',     due_date: daysAhead(5) },
  { id: 960003, user_id: 901, description: 'Review Q2 budget',                         priority: 'Low',    status: 'Pending',     due_date: daysAhead(7) },
  { id: 960004, user_id: 904, description: 'Tour/venue outreach for Brass Theory',     priority: 'Medium', status: 'In progress', due_date: daysAhead(2) },
]

// ── Vendors (from expenses, summarised) ────────────────────────────────────
export const FAKE_VENDORS = [
  { payee: 'Harborline Studios LLC', invoice_count: 3, total_spent: 7650, last_invoice: daysAgo(10), w9_on_file: true,  vendor_email: 'ap@harborline.demo', alias_count: 0 },
  { payee: 'Edge Digital Marketing', invoice_count: 1, total_spent: 3500, last_invoice: daysAgo(22), w9_on_file: true,  vendor_email: 'billing@edge.demo',  alias_count: 0 },
  { payee: 'Casey Film Co.',         invoice_count: 1, total_spent: 4800, last_invoice: daysAgo(7),  w9_on_file: false, vendor_email: 'casey@casey.demo',   alias_count: 0 },
  { payee: 'Signal North Mixing',    invoice_count: 1, total_spent: 1800, last_invoice: daysAgo(14), w9_on_file: true,  vendor_email: 'signal@north.demo',  alias_count: 0 },
  { payee: 'Morgan & Polk PR',       invoice_count: 1, total_spent: 2200, last_invoice: daysAgo(1),  w9_on_file: false, vendor_email: 'pr@morganpolk.demo', alias_count: 0 },
]

// ── Dashboard stats ────────────────────────────────────────────────────────
export const FAKE_DASHBOARD_STATS = {
  upcoming_releases: FAKE_RELEASES.filter(r => r.release_date >= iso(today)).length,
  active_contracts:  FAKE_CONTRACTS.filter(c => c.status === 'Active').length,
  open_tasks:        FAKE_TASKS.filter(t => t.status !== 'Done').length,
  pending_approvals: FAKE_APPROVALS.length,
  total_unpaid:      FAKE_EXPENSES.filter(e => e.payment_status === 'Unpaid').reduce((s, e) => s + e.amount, 0),
  total_paid:        FAKE_EXPENSES.filter(e => e.payment_status === 'Paid').reduce((s, e) => s + e.amount, 0),
}
export const FAKE_NOTIFICATIONS = [
  { id: 970001, type: 'approval',    message: '3 invoices pending your approval',          created_at: new Date(Date.now()-3600000).toISOString(), read: false, link: '/bk/approvals' },
  { id: 970002, type: 'release',     message: 'Satellite releases in 14 days',              created_at: new Date(Date.now()-86400000).toISOString(), read: false, link: '/releases' },
  { id: 970003, type: 'contract',    message: 'Brass Theory contract expires in 70 days',   created_at: new Date(Date.now()-172800000).toISOString(), read: true,  link: '/renewals' },
]
export const FAKE_ACTIVITY = [
  { id: 980001, user_name: 'Demo Alex',   action: 'approved',   detail: 'Harborline Studios LLC invoice HS-2501', created_at: new Date(Date.now()-3600000).toISOString() },
  { id: 980002, user_name: 'Demo Priya',  action: 'created',    detail: 'deal for Milo Varela',                    created_at: new Date(Date.now()-7200000).toISOString() },
  { id: 980003, user_name: 'Demo Marcus', action: 'updated',    detail: 'rollout plan for Prism',                  created_at: new Date(Date.now()-14400000).toISOString() },
]
