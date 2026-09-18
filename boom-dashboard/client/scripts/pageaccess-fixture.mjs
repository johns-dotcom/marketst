// Proves the prefix-aware canView is a STRICT WIDENING of the exact-match one,
// against every real account's production permission rows × every real route.
import { fileURLToPath } from 'node:url'
import fs from 'fs'
import { canViewPath, allowsExactly, ancestorsOf, BASE_WHITELIST, approverFallback }
  from '../src/lib/pageAccess.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
let fail = 0
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++ }

// ── the OLD rule, verbatim from git, so the comparison is against what shipped ──
function oldCanView(path, { role, pagePermissions }) {
  if (!role) return false
  if (role === 'Superadmin' || role === 'Admin') return true
  if (BASE_WHITELIST.has(path)) return true
  if (pagePermissions === null) return role === 'Approver' ? approverFallback(path) : false
  if (pagePermissions.includes(path)) return true
  if (path === '/recoupments/planning' && pagePermissions.includes('/recoupments')) return true
  if (path === '/flags' && pagePermissions.includes('/duplicates')) return true
  if (path === '/bk/bank-matching' && pagePermissions.includes('/bk/statements')) return true
  if (path === '/bk/bank-ledger' && pagePermissions.includes('/bk/ledger')) return true
  return false
}

// ── every route the app registers ──
const app = fs.readFileSync(ROOT + '/client/src/App.jsx', 'utf8')
// ONLY the routes inside <Route element={<Layout />}> are permission-gated.
// /submit, /privacy, /eula and /manual are declared above it and are reachable
// by anyone signed in — counting them made the flip look 4 pages worse than it
// is, and would have had me report a loss that cannot happen.
const guarded = app.slice(app.indexOf('<Route element={<Layout />}>'))
const routes = [...guarded.matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]).filter(p => p !== '*')
const ungated = [...app.slice(0, app.indexOf('<Route element={<Layout />}>'))
  .matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1])
console.log(`ungated (outside the Layout guard, reachable by anyone): ${ungated.join(', ')}`)
const params = routes.filter(r => r.includes(':'))
// Concrete instances of the parameterized routes, as a browser would produce.
const concrete = params.map(r => r.replace(/:[A-Za-z]+/g, (s, i) => ({
  ':id': '9', ':vendorName': 'EDUARDO%20ROHSLER', ':artistName': 'Jerri', ':artistKey': 'jerri',
  ':songName': 'Song%20A', ':month': '2026-01', ':template': 'standard',
}[s] || 'x')))
const universe = [...new Set([...routes.filter(r => !r.includes(':')), ...concrete])]
console.log(`universe: ${universe.length} concrete paths (${params.length} parameterized routes instantiated)\n`)

// knownPages exactly as AuthContext supplies it — the paths the nav registers.
const navRaw = fs.readFileSync(ROOT + '/client/src/navConfig.jsx', 'utf8')
const navIcons = [...new Set([...navRaw.matchAll(/icon: ([A-Za-z0-9]+)/g)].map(m => m[1]))]
const navMod = await import('data:text/javascript;base64,' + Buffer.from(
  navRaw.replace(/import\s*\{[\s\S]*?\}\s*from\s*'lucide-react'/,
    navIcons.map(i => `const ${i} = '${i}'`).join('; '))).toString('base64'))
const knownPages = new Set(navMod.NAV_PAGES.map(p => p.path))

const accounts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  .map(a => ({ ...a, ctx: { role: a.role, pagePermissions: a.pages, knownPages } }))

// 1 ── STRICT WIDENING: no account loses a single path.
console.log('1. no NON-ADMIN account loses access to anything')
console.log('   (the two configured admins are expected to change — that is section 7)')
let gained = 0
for (const a of accounts.filter(a => a.role !== 'Admin')) {
  const ctx = a.ctx
  const lost = universe.filter(p => oldCanView(p, ctx) && !canViewPath(p, ctx))
  const got  = universe.filter(p => !oldCanView(p, ctx) && canViewPath(p, ctx))
  gained += got.length
  ok(lost.length === 0, `${a.name.padEnd(8)} ${String(a.role).padEnd(11)} rows=${String(a.pages === null ? 'none' : a.pages.length).padEnd(4)} lost ${lost.length}, gained ${got.length}` +
     (lost.length ? `  ← ${lost.slice(0,4).join(', ')}` : ''))
}
ok(gained > 0, `the fix actually changes something (${gained} newly-reachable paths in total)`)

// 2 ── everything gained is a DETAIL route, never a new top-level page.
console.log('\n2. every gain is a detail route under a page already granted')
for (const a of accounts.filter(a => a.role !== 'Admin')) {
  const ctx = a.ctx
  const got = universe.filter(p => !oldCanView(p, ctx) && canViewPath(p, ctx))
  const bad = got.filter(p => !ancestorsOf(p).some(anc => oldCanView(anc, ctx)))
  ok(bad.length === 0, `${a.name.padEnd(8)} ${got.length} gains, ${bad.length} without a granted parent` +
     (bad.length ? `  ← ${bad.slice(0,3).join(', ')}` : ''))
}

// 3 ── the prefix match is not naive. THESE ARE THE REGRESSIONS THAT MATTER.
console.log('\n3. a partial segment is never a prefix')
const one = (granted, path) => canViewPath(path, { role: 'User', pagePermissions: granted, knownPages })
ok(!one(['/bk/rules'], '/bk/rules-admin'),      "/bk/rules does NOT admit /bk/rules-admin")
ok(!one(['/artists'],  '/artist-budgets'),      "/artists does NOT admit /artist-budgets")
ok(!one(['/bk/ledger'],'/bk/ledger-matching'),  "/bk/ledger does NOT admit /bk/ledger-matching")
ok(!one(['/budget'],   '/budgets'),             "/budget does NOT admit /budgets")
ok( one(['/artists'],  '/artists/9'),           "/artists DOES admit /artists/9")
ok( one(['/bk/vendors'],'/bk/vendors/ACME%20LLC'), "/bk/vendors DOES admit an encoded vendor name")
ok( one(['/financials'],'/financials/month/2026-01'), "/financials DOES admit a two-level descendant")
ok(!one(['/contracts'], '/contracts/create'), "/contracts does NOT confer Create Contract — a grantable page never inherits from a page that merely shares its prefix")
ok( one(['/contracts','/contracts/create'], '/contracts/create'), "...but an explicit grant does")
ok(!one(['/recoupments'], '/recoupments/audit'), "/recoupments does NOT confer the Audit page (it is its own grantable page)")
ok( one(['/recoupments'], '/recoupments/planning'), "...while Planning still rides on /recoupments via its carve-out")

// 4 ── the Dashboard whitelist must not become a universal grant.
console.log('\n4. the root is not a prefix for everything')
const rowless = { role: 'User', pagePermissions: [], knownPages }
ok(canViewPath('/', rowless), 'a rowless User still gets the Dashboard')
const leaked = universe.filter(p => p !== '/' && p !== '/settings' && canViewPath(p, rowless))
ok(leaked.length === 0, `a rowless User reaches ${leaked.length} pages beyond / and /settings` +
   (leaked.length ? `  ← ${leaked.slice(0,5).join(', ')}` : ''))

// 5 ── carve-outs survive, and now extend to their detail routes.
console.log('\n5. the four carve-outs still hold')
ok(one(['/recoupments'], '/recoupments/planning'), '/recoupments still covers Planning')
ok(one(['/duplicates'],  '/flags'),                'an old /duplicates grant still covers /flags')
ok(one(['/bk/statements'],'/bk/bank-matching'),    '/bk/statements still covers Bank Matching')
ok(one(['/bk/ledger'],   '/bk/bank-ledger'),       '/bk/ledger still covers the Bank Ledger')
ok(one(['/recoupments'], '/recoupments/Jerri'),    'and /recoupments now covers an artist drill')

// 6 ── Superadmin can never be locked out.
// 7 ── the Admin flip: who is actually affected, and how.
console.log('\n7. Admin follows curated rows; unconfigured admins are grandfathered')
for (const a of accounts.filter(a => a.role === 'Admin' || a.role === 'Superadmin')) {
  const reach = universe.filter(p => canViewPath(p, a.ctx)).length
  const rows = a.pages === null ? 'no rows' : `${a.pages.length} rows`
  const before = universe.length
  ok(a.pages === null ? reach === before : true,
     `${a.name.padEnd(8)} ${String(a.role).padEnd(11)} ${rows.padEnd(9)} reaches ${reach}/${before}` +
     (reach < before ? `  ← ${before - reach} FEWER than today, because those rows now bind` : '  (unchanged)'))
}
const unconfigured = accounts.filter(a => a.role === 'Admin' && a.pages === null)
ok(unconfigured.every(a => universe.every(p => canViewPath(p, a.ctx))),
   `all ${unconfigured.length} unconfigured admins still reach every page — the flip is a no-op for them`)

console.log('\n6. Superadmin is never locked out')
const sa = { role: 'Superadmin', pagePermissions: [], knownPages }
ok(universe.every(p => canViewPath(p, sa)), `Superadmin with ZERO rows reaches all ${universe.length} paths`)
const saBoxed = { role: 'Superadmin', pagePermissions: ['/settings'], knownPages }
ok(universe.every(p => canViewPath(p, saBoxed)),
   'Superadmin reaches everything even with ONE restrictive row — cannot be locked out of the app that administers roles')
const adminBoxed = { role: 'Admin', pagePermissions: ['/settings'], knownPages }
ok(!canViewPath('/bk/ledger', adminBoxed) && canViewPath('/settings', adminBoxed),
   'an Admin with one row follows it — this is the behaviour change')

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed')
process.exit(fail ? 1 : 0)
