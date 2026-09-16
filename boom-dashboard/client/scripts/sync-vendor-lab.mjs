#!/usr/bin/env node
/**
 * Regenerate src/pages/VendorSubmitLab.jsx from src/pages/VendorSubmit.jsx.
 *
 * ── Why the sandbox is still a separate file ──────────────────────────────
 * VendorSubmitLab's own header made the call and the reasoning still holds:
 * folding the two into one component with a `variant` prop puts every sandbox
 * experiment one prop-check away from `/submit`, a public unauthenticated route
 * real vendors reach from invoice emails. The copy exists so it can be broken.
 *
 * ── Both directions, one list of deltas ───────────────────────────────────
 * The sandbox is somewhere you BUILD, so the interesting direction is the one
 * that carries work out of it:
 *
 *     --promote   sandbox → live. What you tried in the lab becomes the form.
 *     (default)   live → sandbox. Mirror, for when the live form moved first.
 *     --check     reports WHICH is ahead rather than assuming.
 *
 * Originally this only mirrored, which made the lab a preview rather than a
 * sandbox: the one thing you could not do was try a change there first. Both
 * directions read the same DELTAS array — inverted, the `replace` becomes the
 * `find` — so there is a single definition of how the two files differ and no
 * second implementation to drift.
 *
 * Each direction has its own post-condition, and they are opposites. Mirroring
 * must produce a page that CANNOT write; promoting must produce one that can,
 * that does not carry the SANDBOX banner, and that does not hand every vendor
 * the skip-validation toggle. A promote that got any of those wrong would leave
 * a page that works and lies, which is worse than one that crashes.
 *
 * ── Why it is generated instead of hand-copied ────────────────────────────
 * Because the hand-copy drifted, exactly as its header predicted. By 2026-08-27
 * the sandbox was missing the entire payment-coordinates block the real form had
 * gained, and still carried the hard refusal of an invoice with no printed
 * payment instructions that the real form had deliberately DROPPED when those
 * became fields. So the sandbox refused submissions the live form accepts — the
 * worst possible state for the page you look at to see what vendors see, and now
 * the only such page: /admin/vendor-preview is gone.
 *
 * So the copy is now made by applying a SHORT, NAMED list of deltas, and every
 * one of them is anchored. If an anchor stops matching, this exits non-zero and
 * says which delta broke, instead of producing a half-converted file. A failure
 * here means somebody changed the part of VendorSubmit.jsx a delta depends on —
 * read the delta, update its anchor, re-run.
 *
 *     node scripts/sync-vendor-lab.mjs          # rewrite the lab
 *     node scripts/sync-vendor-lab.mjs --check  # exit 1 if it is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '../src/pages/VendorSubmit.jsx')
const OUT = join(here, '../src/pages/VendorSubmitLab.jsx')

const HEADER = `// ── /admin/vendor-lab — the vendor form, safe to break ───────────────────────
//
// EDIT THIS FILE. That is what it is for — try the change here, in a page that
// cannot write, before it exists on the public form. Then promote it:
//
//     node scripts/sync-vendor-lab.mjs --promote   sandbox  → live form
//     node scripts/sync-vendor-lab.mjs             live form → sandbox (mirror)
//     node scripts/sync-vendor-lab.mjs --check     says which one is ahead
//
// Both directions apply ONE list of named deltas (the component name, the
// ?sandbox=1 endpoint, the always-on admin tools, the banner), so the trip out
// and the trip back cannot disagree. Everything outside those four spots is
// carried across verbatim — which is why a change made here arrives on the live
// form as the same change, and not as a re-typing of it.
//
// The mirror direction REFUSES to run while this file is ahead, rather than
// discarding the experiment. Pass --force if discarding is what you want.
//
// Do not hand-edit the four delta regions themselves; --promote anchors on them
// and will fail loudly rather than guess.
//
// A COPY of VendorSubmit.jsx, deliberately. \`/submit\` is a public,
// unauthenticated route that real vendors reach from invoice emails — 418
// submissions from 190 vendors so far — and every submission there creates a real
// ledger row, uploads to R2 and can email people. There is nowhere else to try a
// change.
//
// Two surfaces now, and the difference matters:
//
//   /submit                  the real thing. Public. WRITES.
//   /admin/vendor-lab        this. Admin-only. Submits to ?sandbox=1, which runs
//                            every validation and writes NOTHING.
//
// (/admin/vendor-preview was a third: the real form, admin-only, which still
// wrote. It was deleted on 2026-08-27 — an admin looking at the form should not
// be creating approvals by pressing Submit, and two near-identical entries in a
// 200px rail is how you press the wrong one.)
//
// ── Still a copy, not a variant prop ──
// Folding these into one component would be tidier and is the wrong trade: it
// puts every sandbox experiment one prop-check away from the live public form,
// which is the exact risk this page exists to remove. What changed is that the
// copy is now MADE rather than remembered — see the script's header.
//
// Nothing else in the app should import from this file. If a piece of it becomes
// worth sharing, extract it into a component that BOTH pages use — never import
// the lab.
`

// Each delta is anchored. `find` must appear EXACTLY `count` times in the
// source, or the sync fails rather than guessing.
const DELTAS = [
  {
    name: 'component name + no props',
    find: 'export default function VendorSubmit() {',
    replace: 'export default function VendorSubmitLab() {',
  },
  {
    name: 'submit to the sandbox endpoint',
    find: "      const r = await fetch('/api/vendor/submit', { method: 'POST', body: fd })",
    replace: `      // ?sandbox=1 — every validation the real submission runs, and then nothing
      // written: no ledger row, no R2 object, no email. The endpoint requires a
      // token because it spends real AI calls getting there.
      const r = await fetch('/api/vendor/submit?sandbox=1', {
        method: 'POST',
        headers: { authorization: \`Bearer \${localStorage.getItem('token') || ''}\` },
        body: fd,
      })`,
  },
  {
    name: 'admin tools always on',
    find: `  const adminPreview = (
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('admin_preview') === '1'
  )
  // Guard so vendor state can never flip this on even by accident.
  const setSkipValidation = (v) => { if (adminPreview) setSkipValidationRaw(v) }`,
    replace: `  // Always on here. In VendorSubmit this is gated because a real vendor must
  // never see it; the lab has no real vendors, and the skip-validation toggle is
  // most of what makes poking at the later steps bearable.
  const adminPreview = true
  const setSkipValidation = (v) => setSkipValidationRaw(v)`,
  },
  {
    name: 'the SANDBOX banner',
    find: `        <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs font-semibold py-2 px-5 flex items-center justify-center gap-4 flex-wrap">
          <span>
            Admin preview — submissions here are <b>real</b> and land on Approvals.
            {' '}To try changes without creating anything, use{' '}
            <a href="/admin/vendor-lab" className="underline">/admin/vendor-lab</a>.
          </span>`,
    // The OPPOSITE claim to the one it replaces, and it must not look like it.
    // Indigo, not amber: the banner is the only thing on screen that says whether
    // pressing Submit creates real work.
    replace: `        <div className="bg-indigo-100 border-b-2 border-indigo-400 text-indigo-900 text-xs font-semibold py-2 px-5 flex items-center justify-center gap-4 flex-wrap">
          <span>
            <b>SANDBOX</b> — nothing here is submitted. No approval is created, no file
            is stored, nobody is emailed. Validation still runs in full.
          </span>
          <span className="text-indigo-700 font-normal">
            live form: <a href="/submit" className="underline">/submit</a>
          </span>`,
  },
]

const readOr = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

// ── The two directions ───────────────────────────────────────────────────────
// Same DELTAS array both ways, which is the point: there is one definition of
// how the sandbox differs from the live form, so the trip out and the trip back
// cannot disagree. Each direction anchors the same way — the string it is about
// to replace must appear EXACTLY once, or it fails without writing.

/** live → sandbox. */
function toLab(src) {
  let out = src
  const broken = []
  for (const d of DELTAS) {
    const n = out.split(d.find).length - 1
    if (n !== 1) { broken.push(`${d.name}: live-side anchor matched ${n} times, expected 1`); continue }
    out = out.replace(d.find, d.replace)
  }
  return { out: HEADER + '\n' + out, broken }
}

/** sandbox → live. The inverse, using the same deltas read right-to-left. */
function toLive(lab) {
  const broken = []
  const prefix = HEADER + '\n'
  if (!lab.startsWith(prefix)) {
    return { out: null, broken: ['the lab no longer starts with the generated header — restore it, or re-sync from the live form'] }
  }
  let out = lab.slice(prefix.length)
  for (const d of DELTAS) {
    const n = out.split(d.replace).length - 1
    if (n !== 1) { broken.push(`${d.name}: sandbox-side anchor matched ${n} times, expected 1`); continue }
    out = out.replace(d.replace, d.find)
  }
  return { out, broken }
}

// ── Post-conditions, one per direction ───────────────────────────────────────
// The OUTPUT is checked, not just the input, because a delta applied to a spot
// that is no longer what it was named for leaves a file that LOOKS converted.
// Each direction has one thing that must never be wrong, and they are opposites.

/** The sandbox must not be able to write. */
function checkLab(out) {
  const problems = []
  const submits = out.match(/\/api\/vendor\/submit[^'"`]*/g) || []
  if (submits.length !== 1 || !submits[0].includes('sandbox=1')) {
    problems.push('it does not submit to ?sandbox=1 — found: ' + (submits.join(', ') || '(no submit call at all)'))
  }
  return problems
}

/**
 * The live form must be LIVE, and must not carry the sandbox's affordances.
 * Three ways promoting could go wrong, each worse than a crash because each
 * leaves a page that works and lies:
 *   • posting to ?sandbox=1     — /submit would validate, report success, and
 *                                 write nothing. Vendors get a thank-you page
 *                                 and the invoice never arrives.
 *   • the SANDBOX banner        — tells a real vendor nothing was submitted
 *                                 while it submits.
 *   • adminPreview = true       — hands every vendor the skip-validation toggle.
 */
function checkLive(out) {
  const problems = []
  const submits = out.match(/\/api\/vendor\/submit[^'"`]*/g) || []
  if (submits.length !== 1) {
    problems.push('expected exactly one submit call, found ' + (submits.join(', ') || 'none'))
  } else if (submits[0].includes('sandbox=1')) {
    problems.push('the LIVE form would post to ?sandbox=1 — it would write nothing while telling vendors it worked')
  }
  if (out.includes('<b>SANDBOX</b>')) {
    problems.push('the SANDBOX banner survived — the live form would tell vendors nothing is submitted')
  }
  if (/const adminPreview = true/.test(out)) {
    problems.push('adminPreview is hardcoded true — every vendor would get the skip-validation toggle')
  }
  if (!out.includes('export default function VendorSubmit() {')) {
    problems.push('the component is not named VendorSubmit')
  }
  return problems
}

const die = (title, lines) => {
  console.error(title + '\n')
  for (const l of lines) console.error('  • ' + l)
  console.error('\nNothing was written.')
  process.exit(1)
}

const live = readOr(SRC)
const lab = readOr(OUT)
if (live == null) die('sync-vendor-lab FAILED — cannot read VendorSubmit.jsx', [SRC])

const generated = toLab(live)
const inSync = lab != null && lab === generated.out

// Is the sandbox carrying work that is not in the live form yet? That is the
// state this script used to have no name for, and the state the sandbox exists
// to make possible.
//
// ── It cannot actually tell WHICH ONE is ahead, and it used to claim it could ──
// This test is "they differ and the inversion is clean". That is true when the
// sandbox is ahead AND when the LIVE FORM is ahead, and the script reported both
// as "the lab is AHEAD — promote it". On 2026-09-15 the live form carried an
// uncommitted fix the lab did not have and --check said exactly that, so
// following its own advice would have PROMOTED THE LAB OVER IT and deleted the
// fix with no diff to read afterwards.
//
// There is no content in either file that says which edit happened later, so the
// honest answer is to report that they differ, show WHERE, and let the person
// who made one of the edits decide. `--promote` and `--force` both still do
// exactly what they say; what changed is that neither is recommended blind.
const inverted = lab == null ? { out: null, broken: ['no lab file'] } : toLive(lab)
const theyDiffer = !inSync && inverted.out != null && !inverted.broken.length && inverted.out !== live

/**
 * The first place the two disagree, with a little context either side.
 *
 * A line number and one line of text is enough to recognise your own edit —
 * which is the whole question being asked — without printing a diff of a
 * 2,000-line file into a terminal.
 */
function firstDivergence(a, b) {
  const A = a.split('\n'); const B = b.split('\n')
  const n = Math.max(A.length, B.length)
  for (let i = 0; i < n; i++) {
    if (A[i] !== B[i]) {
      return { line: i + 1, live: A[i] ?? '(end of file)', lab: B[i] ?? '(end of file)' }
    }
  }
  return null
}

// ── promote: sandbox → live ──────────────────────────────────────────────────
if (process.argv.includes('--promote')) {
  if (lab == null) die('sync-vendor-lab FAILED — there is no lab to promote', [OUT])
  if (inverted.broken.length) {
    die('sync-vendor-lab FAILED — the lab could not be converted back to the live form:', inverted.broken.concat([
      'A delta anchor was edited in the sandbox. Read the delta, fix its `replace` string here, re-run.',
    ]))
  }
  const problems = checkLive(inverted.out)
  if (problems.length) die('sync-vendor-lab REFUSED to promote — the result would not be a safe live form:', problems)
  if (inverted.out === live) { console.log('nothing to promote — the live form already matches the sandbox'); process.exit(0) }

  const before = live.split('\n').length
  const after = inverted.out.split('\n').length
  writeFileSync(SRC, inverted.out)
  console.log(`promoted the sandbox into src/pages/VendorSubmit.jsx (${before} → ${after} lines)`)
  console.log('the PUBLIC form has changed on disk. Review `git diff` before pushing — a deploy makes it live.')
  // Re-sync so the lab is byte-identical to what the live form now generates.
  // Without this the next --check reports the lab as ahead of a form it just
  // wrote, which reads as an unexplained failure.
  const after2 = toLab(inverted.out)
  if (!after2.broken.length && !checkLab(after2.out).length) {
    writeFileSync(OUT, after2.out)
    console.log('and re-synced the lab so the two are consistent again')
  }
  process.exit(0)
}

// ── check: report which way they differ ──────────────────────────────────────
if (process.argv.includes('--check')) {
  if (inSync) { console.log('vendor lab is in sync'); process.exit(0) }
  if (theyDiffer) {
    const d = firstDivergence(live, inverted.out)
    console.error('the vendor lab and the live form DIFFER, and which one is ahead')
    console.error('cannot be read off the files — only you know which you edited last.\n')
    if (d) {
      console.error(`  first difference, line ${d.line}:`)
      console.error(`    live form  ${d.live.trim().slice(0, 96) || '(blank)'}`)
      console.error(`    sandbox    ${d.lab.trim().slice(0, 96) || '(blank)'}`)
      console.error('')
    }
    console.error('  full diff:   node scripts/sync-vendor-lab.mjs --diff')
    console.error('  sandbox is right, take it to the public form:  --promote')
    console.error('  live form is right, overwrite the sandbox:     --force')
    process.exit(1)
  }
  console.error('vendor lab is OUT OF DATE — run: node scripts/sync-vendor-lab.mjs')
  process.exit(1)
}

// ── diff: what actually differs, in live-form terms ──────────────────────────
// The lab is compared through its inversion, so the four deltas never show up as
// differences — what prints is the WORK, which is the only thing worth deciding
// about.
if (process.argv.includes('--diff')) {
  if (inSync) { console.log('vendor lab is in sync — nothing differs'); process.exit(0) }
  if (inverted.broken.length) die('cannot compare — the lab does not invert cleanly:', inverted.broken)
  const A = live.split('\n'); const B = inverted.out.split('\n')
  console.log('--- live form (src/pages/VendorSubmit.jsx)')
  console.log('+++ sandbox  (src/pages/VendorSubmitLab.jsx, read as if promoted)\n')
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] === B[i]) continue
    if (A[i] !== undefined) console.log(`-${String(i + 1).padStart(5)}  ${A[i]}`)
    if (B[i] !== undefined) console.log(`+${String(i + 1).padStart(5)}  ${B[i]}`)
  }
  process.exit(1)
}

// ── default: live → sandbox ──────────────────────────────────────────────────
// Guarded now. This direction OVERWRITES the sandbox, and the sandbox is
// somewhere work happens — so it refuses when that work has not been promoted.
// The old version had no such guard and its own --check failure message told you
// to run this command, which would have silently discarded the experiment.
if (theyDiffer && !process.argv.includes('--force')) {
  die('sync-vendor-lab REFUSED — the sandbox differs from the live form:', [
    'This direction OVERWRITES the sandbox, and it cannot tell whether what is',
    'in there is unpromoted work or simply an older copy.',
    '',
    'see what differs:  node scripts/sync-vendor-lab.mjs --diff',
    'sandbox is right:  node scripts/sync-vendor-lab.mjs --promote',
    'live is right:     node scripts/sync-vendor-lab.mjs --force',
  ])
}
if (generated.broken.length) {
  die('sync-vendor-lab FAILED — VendorSubmit.jsx changed under a delta:', generated.broken.concat([
    'Open scripts/sync-vendor-lab.mjs, fix the anchor, re-run.',
  ]))
}
const labProblems = checkLab(generated.out)
if (labProblems.length) die('sync-vendor-lab FAILED — the generated lab does not submit to the sandbox:', labProblems)

if (inSync) { console.log('vendor lab already in sync — nothing written') }
else {
  writeFileSync(OUT, generated.out)
  console.log(`wrote ${OUT.split('/').slice(-3).join('/')} (${generated.out.split('\n').length} lines) from VendorSubmit.jsx`)
}
