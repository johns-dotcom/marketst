#!/usr/bin/env node
// The Cadence port log, as a command. Reads and writes CADENCE-PORT-LOG.md
// next to this repo's root; safe to run from either repo (the path is absolute).
//
//   node tools/port-log.mjs                       every `todo` row, oldest first
//   node tools/port-log.mjs all                   every row
//   node tools/port-log.mjs add <ms-commit> [tag] [§] [--commit]
//        append a row from the Market Street commit message; --commit stages the log and
//        commits it on its own ("Port log: …") — a row needs the hash, which exists only
//        AFTER the commit, and amending would change it, so the row rides in a follow-up.
//        Port-log commits themselves never get a row.
//   node tools/port-log.mjs done <ms-commit> <cadence-commit>
//   node tools/port-log.mjs skip <ms-commit> "reason"
//
// Rows are a markdown table: | # | Date | Commit | Update | Tag | § | Status |
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'CADENCE-PORT-LOG.md')
const argv = process.argv.slice(2).filter((x) => x !== '--commit')
const COMMIT = process.argv.includes('--commit')
const [cmd = 'todo', a, b, c] = argv

const text = fs.readFileSync(FILE, 'utf8')
const lines = text.split('\n')
const isRow = (l) => /^\| \d+ \| \d{4}-\d{2}-\d{2} \| [0-9a-f]{7,} \|/.test(l)
const parse = (l) => { const cells = l.split('|').slice(1, -1).map((x) => x.trim()); return { n: Number(cells[0]), date: cells[1], commit: cells[2], update: cells[3], tag: cells[4], section: cells[5], status: cells[6] } }
const rows = lines.filter(isRow).map(parse)
const write = (next) => fs.writeFileSync(FILE, next.join('\n'))
const show = (r) => console.log(`${String(r.n).padStart(3)}  ${r.date}  ${r.commit}  [${r.tag}] §${r.section}  ${r.update}\n     ${r.status}`)

if (cmd === 'todo') {
  const todo = rows.filter((r) => /^todo/.test(r.status))
  console.log(`${todo.length} of ${rows.length} rows still to port into Cadence (oldest first):\n`)
  for (const r of todo) show(r)
  console.log(`\nFor each: BOOM-DIFFERENCES.md §N for the why, then \`git -C ${ROOT} show <commit>\`. Mark it: node tools/port-log.mjs done <ms-commit> <cadence-commit>`)
} else if (cmd === 'all') {
  for (const r of rows) show(r)
} else if (cmd === 'add') {
  if (!a) { console.error('add needs a Market Street commit'); process.exit(2) }
  const [sha, date, subject] = execFileSync('git', ['-C', ROOT, 'show', '-s', '--format=%h|%ad|%s', '--date=short', a], { encoding: 'utf8' }).trim().split('|')
  if (rows.some((r) => r.commit === sha)) { console.log(`${sha} is already row ${rows.find((r) => r.commit === sha).n}`); process.exit(0) }
  const n = (rows[rows.length - 1]?.n || 0) + 1
  const row = `| ${n} | ${date} | ${sha} | ${subject.replace(/\|/g, '/')} | ${b || 'PORT'} | ${c || '—'} | todo |`
  const last = lines.map((l, i) => (isRow(l) ? i : -1)).filter((i) => i >= 0).pop()
  lines.splice(last + 1, 0, row); write(lines); console.log('added:', row)
  if (COMMIT) {
    execFileSync('git', ['-C', ROOT, 'add', 'CADENCE-PORT-LOG.md'], { stdio: 'inherit' })
    execFileSync('git', ['-C', ROOT, 'commit', '-q', '-m', `Port log: row ${n} for ${sha} — ${subject.slice(0, 60)}`], { stdio: 'inherit' })
    console.log('committed the row')
  }
} else if (cmd === 'done' || cmd === 'skip') {
  if (!a || !b) { console.error(`${cmd} needs <ms-commit> and ${cmd === 'done' ? '<cadence-commit>' : '"reason"'}`); process.exit(2) }
  const i = lines.findIndex((l) => isRow(l) && parse(l).commit.startsWith(a))
  if (i < 0) { console.error(`no row for ${a}`); process.exit(1) }
  const cells = lines[i].split('|'); cells[7] = ` ${cmd === 'done' ? `done ${b}` : `skip — ${b}`} `
  lines[i] = cells.join('|'); write(lines); console.log('updated:', lines[i])
} else { console.error('unknown command'); process.exit(2) }
