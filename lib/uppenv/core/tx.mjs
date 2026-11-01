/**
 * Transaction layer for `uppenv import`.
 *
 * Every mutation an adapter performs MUST go through the Tx object so that
 * `uppenv rollback <txid>` can undo the whole import. The journal is append-only
 * JSONL; backups are stored once per original path under `backup/<n>/`.
 *
 * Ops:
 *   backup  — a pre-existing path was copied into the tx store before mutation
 *   create  — path did not exist before the import
 *   replace — path existed and was replaced (backup available)
 *   exec    — a host CLI command ran (recorded for the human, not auto-undone)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { posix, rmrf, walk } from './util.mjs'

const JOURNAL = 'journal.jsonl'

export class Tx {
  constructor(dir, { dryRun = false, label = '' } = {}) {
    this.dir = dir
    this.dryRun = dryRun
    this.label = label
    this.actions = []
    this.backups = new Map()
    this.created = []
    this.counter = 0
    if (!dryRun) {
      fs.mkdirSync(path.join(dir, 'backup'), { recursive: true })
      this.journalFile = path.join(dir, JOURNAL)
    }
  }

  get id() {
    return path.basename(this.dir)
  }

  journal(entry) {
    if (this.dryRun) return
    fs.appendFileSync(this.journalFile, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`)
  }

  /** Record one import action for the final report. */
  log(action) {
    this.actions.push(action)
    return action
  }

  /** Snapshot a path (file, dir or symlink) before it is modified. Idempotent. */
  backup(target) {
    const abs = path.resolve(target)
    if (this.backups.has(abs)) return this.backups.get(abs)
    if (!fs.existsSync(abs)) {
      this.backups.set(abs, null)
      return null
    }
    this.counter += 1
    const slot = path.join('backup', String(this.counter).padStart(4, '0'))
    const store = path.join(this.dir, slot)
    fs.mkdirSync(store, { recursive: true })
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) {
      for (const file of walk(abs)) {
        const rel = posix(path.relative(abs, file))
        const dest = path.join(store, 'tree', ...rel.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(file, dest)
      }
      fs.writeFileSync(path.join(store, 'kind'), 'dir')
    } else if (st.isSymbolicLink()) {
      fs.writeFileSync(path.join(store, 'link'), fs.readlinkSync(abs))
    } else {
      fs.copyFileSync(abs, path.join(store, 'file'))
      fs.writeFileSync(path.join(store, 'kind'), 'file')
    }
    this.backups.set(abs, { slot, abs })
    this.journal({ op: 'backup', path: abs, slot })
    return { slot, abs }
  }

  writeFile(target, data) {
    const abs = path.resolve(target)
    if (this.dryRun) return false
    const existed = fs.existsSync(abs)
    if (existed) this.backup(abs)
    else this.journal({ op: 'create', path: abs })
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.uppenv-tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, abs)
    return true
  }

  writeText(target, text) {
    return this.writeFile(target, Buffer.from(String(text), 'utf8'))
  }

  /** Move a path aside (used by --on-conflict rename); undoable via journal. */
  rename(target, to) {
    const abs = path.resolve(target)
    const dest = path.resolve(to)
    if (this.dryRun) return false
    if (!fs.existsSync(abs)) return false
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(abs, dest)
    this.journal({ op: 'rename', from: abs, to: dest })
    return true
  }

  /** Replace a directory tree wholesale (backup first, then rm -rf + copy). */
  replaceTree(target, srcDir) {
    const abs = path.resolve(target)
    if (this.dryRun) return false
    const existed = fs.existsSync(abs)
    if (existed) this.backup(abs)
    else this.journal({ op: 'create', path: abs })
    rmrf(abs)
    fs.mkdirSync(abs, { recursive: true })
    for (const file of walk(srcDir)) {
      const rel = posix(path.relative(srcDir, file))
      const dest = path.join(abs, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(file, dest)
    }
    if (!existed) this.created.push(abs)
    return true
  }

  remove(target) {
    const abs = path.resolve(target)
    if (this.dryRun) return false
    if (!fs.existsSync(abs)) return false
    this.backup(abs)
    this.journal({ op: 'replace', path: abs })
    fs.rmSync(abs, { recursive: true, force: true })
    return true
  }

  /**
   * Record (and unless dry-run, execute) a host command. Adapters use this for
   * `upp install`, `dsh plugin add`, pnpm install, accio gateway calls, etc.
   */
  exec(command, args = [], { cwd, env, timeout = 120000 } = {}) {
    const display = [command, ...args].join(' ')
    const action = { op: 'exec', command: display, cwd, dryRun: this.dryRun }
    if (this.dryRun) return { ...action, skipped: true }
    this.journal({ op: 'exec', command: display, cwd })
    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const res = isWin
      ? spawnSync(shell, ['/d', '/s', '/c', display], { cwd, env: { ...process.env, ...env }, timeout, encoding: 'utf8' })
      : spawnSync(shell, ['-c', display], { cwd, env: { ...process.env, ...env }, timeout, encoding: 'utf8' })
    return {
      ...action,
      status: res.status,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
      error: res.error ? String(res.error.message) : undefined,
    }
  }

  commit(extra = {}) {
    if (this.dryRun) return { dryRun: true, actions: this.actions }
    const summary = {
      tx: this.id,
      label: this.label,
      finishedAt: new Date().toISOString(),
      actions: this.actions,
      created: this.created,
      ...extra,
    }
    fs.writeFileSync(path.join(this.dir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`)
    return summary
  }
}

// (spawn is imported at the top so the module stays dependency-free)

export function createTx(txRoot, { dryRun = false, label = '' } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(txRoot, `${stamp}-${Math.random().toString(36).slice(2, 6)}`)
  return new Tx(dir, { dryRun, label })
}

/** Undo an import using its journal, newest entry first. */
export function rollbackTx(txDir) {
  const journalFile = path.join(txDir, JOURNAL)
  if (!fs.existsSync(journalFile)) throw new Error(`no journal in ${txDir}`)
  const lines = fs
    .readFileSync(journalFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const result = { tx: path.basename(txDir), restored: 0, removed: 0, renamed: 0, skipped: [] }
  // Pass 1 (chronological): what was the FIRST thing that happened to each path?
  // A path that uppenv created must be deleted on rollback even if a *later*
  // asset (e.g. the second MCP server merged into the same config file) backed
  // it up in between — restoring that intermediate state would leave files behind.
  const info = new Map()
  const order = []
  const renames = []
  for (const e of lines) {
    if (e.op === 'exec') {
      result.skipped.push(`exec: ${e.command}`)
      continue
    }
    if (e.op === 'rename') {
      renames.push(e)
      continue
    }
    if (e.op !== 'backup' && e.op !== 'create') continue
    let rec = info.get(e.path)
    if (!rec) {
      rec = { earliest: e.op, backup: e.op === 'backup' ? e.slot : undefined }
      info.set(e.path, rec)
      order.push(e.path)
    } else if (rec.earliest !== 'create' && e.op === 'backup' && !rec.backup) {
      rec.backup = e.slot
    }
  }
  // Undo renames newest-first.
  for (let i = renames.length - 1; i >= 0; i--) {
    const e = renames[i]
    if (fs.existsSync(e.to)) {
      rmrf(e.from)
      fs.renameSync(e.to, e.from)
      result.renamed += 1
    }
  }
  // Pass 2 (reverse chronological): undo per path exactly once.
  for (let i = order.length - 1; i >= 0; i--) {
    const p = order[i]
    const rec = info.get(p)
    if (rec.earliest === 'create') {
      rmrf(p)
      result.removed += 1
    } else if (rec.backup) {
      restoreSlot(txDir, rec.backup, p)
      result.restored += 1
    }
  }
  fs.writeFileSync(path.join(txDir, 'rolled-back.json'), `${JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2)}\n`)
  return result
}

function restoreSlot(txDir, slot, target) {
  const store = path.join(txDir, slot)
  const kindFile = path.join(store, 'kind')
  const kind = fs.existsSync(kindFile) ? fs.readFileSync(kindFile, 'utf8').trim() : null
  if (fs.existsSync(path.join(store, 'link'))) {
    rmrf(target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(fs.readFileSync(path.join(store, 'link'), 'utf8'), target)
    return
  }
  if (kind === 'dir' || fs.existsSync(path.join(store, 'tree'))) {
    rmrf(target)
    fs.mkdirSync(target, { recursive: true })
    const tree = path.join(store, 'tree')
    if (fs.existsSync(tree)) {
      for (const file of walk(tree)) {
        const rel = posix(path.relative(tree, file))
        const dest = path.join(target, ...rel.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(file, dest)
      }
    }
    return
  }
  const file = path.join(store, 'file')
  if (fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
  }
}
