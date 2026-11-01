#!/usr/bin/env node
/**
 * uppenv — self-contained conformance suite for the core engine.
 *
 *   node tools/test-uppenv.mjs
 *
 * No test framework, no network, no real host directories: every fixture lives
 * in a throw-away tree under `os.tmpdir()` and is removed in a `finally` block,
 * so the suite is rerunnable and never touches a real ~/.dsh, ~/.workbuddy or
 * ~/.accio.
 *
 * Groups whose module has not been written yet (image.mjs, hosts/*.mjs and the
 * CLI land in parallel) print SKIP instead of crashing; a module that exists but
 * cannot be imported is a FAIL because the delivered tree is broken.
 *
 * Prints one PASS / FAIL / SKIP line per check plus a summary and exits 1 on any
 * FAIL. A hard watchdog keeps a hanging child process from wedging the gate.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WATCHDOG_MS = 120_000
const SUITE_START = Date.now()

const results = []
let currentGroup = 'general'

function describeError(error) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
  return message.split('\n')[0].slice(0, 400)
}

function record(kind, label, detail) {
  results.push({ kind, label, detail })
  console.log(detail ? `${kind.padEnd(4)}  ${label}: ${detail}` : `${kind.padEnd(4)}  ${label}`)
}

/** Run one assertion block, reporting PASS/FAIL without aborting the suite. */
async function check(name, fn) {
  const label = `${currentGroup}: ${name}`
  try {
    await fn()
    record('PASS', label)
  } catch (error) {
    record('FAIL', label, describeError(error))
  }
}

function skip(name, reason) {
  record('SKIP', `${currentGroup}: ${name}`, reason)
}

async function group(title, fn) {
  currentGroup = title
  try {
    await fn()
  } catch (error) {
    record('FAIL', `${title}: group crashed`, describeError(error))
  }
}

/** Import a repo module, tolerating "not written yet" and reporting import bugs. */
async function needModule(relPath, label = relPath, { required = false } = {}) {
  const file = path.join(ROOT, ...relPath.split('/'))
  if (!fs.existsSync(file)) {
    if (required) record('FAIL', `${currentGroup}: module`, `${label} is missing (${relPath})`)
    else skip('module', `${label} not written yet (${relPath})`)
    return null
  }
  try {
    return await import(pathToFileURL(file).href)
  } catch (error) {
    record('FAIL', `${currentGroup}: module`, `${label} failed to import: ${describeError(error)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Fake filesystem tree (os.tmpdir only — never a real host home)
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-selftest-'))
const P = (...parts) => path.join(tmpRoot, ...parts)

function mkdirp(...relParts) {
  const dir = P(...relParts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function put(relParts, data) {
  const file = P(...relParts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  return file
}

const watchdog = setTimeout(() => {
  console.error(`\nFAIL  suite: hard timeout after ${WATCHDOG_MS}ms`)
  process.exit(1)
}, WATCHDOG_MS)
if (typeof watchdog.unref === 'function') watchdog.unref()

try {
  // -------------------------------------------------------------------------
  // archive: packImage -> unpackImage round trip (SHA/image integrity)
  // -------------------------------------------------------------------------
  await group('archive', async () => {
    const archive = await needModule('lib/uppenv/core/archive.mjs', 'core/archive.mjs')
    const util = await needModule('lib/uppenv/core/util.mjs', 'core/util.mjs')
    if (!archive || !util) return

    const srcDir = mkdirp('archive', 'src')
    put(['archive', 'src', 'upp.json'], `${JSON.stringify({ name: '离线插件', version: '1.0.0' }, null, 2)}\n`)
    put(['archive', 'src', 'runtime', 'tools.json'], `${JSON.stringify({ serverName: 'fake', tools: [{ name: 'ping' }] }, null, 2)}\n`)
    put(['archive', 'src', 'skills', '技能-示例', 'SKILL.md'], '# 技能\n\n中文内容 round trip ✅\n')
    put(['archive', 'src', 'bin', 'blob.bin'], Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
    put(['archive', 'src', 'empty.txt'], '')
    put(['archive', 'src', 'nested', 'a', 'b', 'deep.txt'], 'deep\n')

    const relOf = (base, abs) => util.posix(path.relative(base, abs))
    const filesBefore = util.walk(srcDir).map((abs) => relOf(srcDir, abs)).sort()
    const digestBefore = util.treeDigest(srcDir)
    const imageFile = P('archive', 'fake-image.upp')
    const outDir = mkdirp('archive', 'out')
    const info = archive.packImage(srcDir, imageFile)

    await check('packImage writes a non-empty deterministic archive', () => {
      assert.equal(info.entries, filesBefore.length)
      assert.ok(info.bytes > 0, 'archive must not be empty')
      assert.equal(fs.statSync(imageFile).size, info.bytes)
    })

    await check('unpackImage restores the same file list', () => {
      archive.unpackImage(imageFile, outDir)
      const filesAfter = util.walk(outDir).map((abs) => relOf(outDir, abs)).sort()
      assert.deepEqual(filesAfter, filesBefore)
    })

    await check('unpackImage restores byte-identical content and SHA digests', () => {
      for (const rel of filesBefore) {
        const before = fs.readFileSync(path.join(srcDir, ...rel.split('/')))
        const after = fs.readFileSync(path.join(outDir, ...rel.split('/')))
        assert.ok(before.equals(after), `content mismatch for ${rel}`)
      }
      assert.equal(util.treeDigest(outDir).digest, digestBefore.digest)
    })

    await check('unpackImage refuses path-traversal entries', () => {
      const evil = P('archive', 'evil.upp')
      archive.writeZip(evil, [{ name: '../escaped.txt', data: 'pwn' }])
      assert.throws(() => archive.unpackImage(evil, P('archive', 'evil-out')), /illegal entry/)
      assert.equal(fs.existsSync(P('archive', 'escaped.txt')), false)
    })
  })

  // -------------------------------------------------------------------------
  // templates: pathToTemplate / expandValue round trip over fake roots
  // -------------------------------------------------------------------------
  await group('templates', async () => {
    const util = await needModule('lib/uppenv/core/util.mjs', 'core/util.mjs')
    if (!util) return
    const { createTemplates, detectRoots } = util
    const fakeHome = mkdirp('home')
    const fakeStore = mkdirp('home', '.upp', 'store')
    const tpl = createTemplates({ HOME: fakeHome, UPP_STORE: fakeStore })

    await check('pathToTemplate maps an exact root', () => {
      assert.equal(tpl.pathToTemplate(fakeHome), '${HOME}')
    })

    await check('pathToTemplate maps a nested path', () => {
      assert.equal(tpl.pathToTemplate(path.join(fakeHome, '.dsh', 'settings.json')), '${HOME}/.dsh/settings.json')
    })

    await check('longest root wins for a path inside UPP_STORE', () => {
      assert.equal(tpl.pathToTemplate(path.join(fakeStore, 'pkg-1.0.0.upp')), '${UPP_STORE}/pkg-1.0.0.upp')
    })

    await check('pathToTemplate returns null outside every root', () => {
      assert.equal(tpl.pathToTemplate(path.join(tmpRoot, 'not-a-root', 'x.txt')), null)
    })

    await check('expandValue round-trips a home path', () => {
      const original = path.join(fakeHome, 'mcp', 'doc-toolkit.json')
      const template = tpl.pathToTemplate(original)
      assert.equal(template, '${HOME}/mcp/doc-toolkit.json')
      assert.equal(path.resolve(tpl.expandValue(template)), path.resolve(original))
    })

    await check('expandValue round-trips a store path', () => {
      const original = path.join(fakeStore, 'images', 'base.upp')
      const template = tpl.pathToTemplate(original)
      assert.equal(template, '${UPP_STORE}/images/base.upp')
      assert.equal(path.resolve(tpl.expandValue(template)), path.resolve(original))
    })

    await check('expandValue expands nested structures', () => {
      const value = tpl.expandValue({
        command: '${HOME}/bin/upp',
        args: ['--store', '${UPP_STORE}/x'],
        enabled: true,
        count: 3,
      })
      assert.equal(path.resolve(value.command), path.resolve(path.join(fakeHome, 'bin', 'upp')))
      assert.equal(path.resolve(value.args[1]), path.resolve(path.join(fakeStore, 'x')))
      assert.equal(value.enabled, true)
      assert.equal(value.count, 3)
    })

    await check('templateValue rewrites a path embedded in a longer string', () => {
      const server = path.join(fakeHome, 'runtime', 'server.mjs')
      const original = `node ${server} --stdio`
      const out = tpl.templateValue(original)
      // The absolute root must become ${HOME} and must not leak; separators that
      // follow the root keep the export platform's shape (templateValue only
      // posix-normalizes the remainder of exact paths), so compare separators
      // loosely and require a faithful round trip on this platform.
      assert.equal(out.includes(fakeHome), false, 'absolute root leaked into the template')
      assert.match(out, /^node \$\{HOME\}[\\/]runtime[\\/]server\.mjs --stdio$/)
      const normalizeSeparators = (text) => text.replace(/\\/g, '/')
      assert.equal(normalizeSeparators(tpl.expandValue(out)), normalizeSeparators(original))
    })

    await check('detectRoots derives every host root from a fake HOME', () => {
      const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome }
      delete env.DSH_HOME
      const roots = detectRoots(env)
      assert.equal(path.resolve(roots.home), path.resolve(fakeHome))
      assert.equal(path.resolve(roots.uppStore), path.resolve(path.join(fakeHome, '.upp')))
      assert.equal(path.resolve(roots.dshHome), path.resolve(path.join(fakeHome, '.dsh')))
      assert.equal(path.resolve(roots.accioHome), path.resolve(path.join(fakeHome, '.accio')))
    })
  })

  // -------------------------------------------------------------------------
  // model: ScanAsset validation, stable digests, payload serialization
  // -------------------------------------------------------------------------
  await group('model', async () => {
    const model = await needModule('lib/uppenv/core/model.mjs', 'core/model.mjs')
    if (!model) return
    const { normalizeScanAsset, digestFileList, assetSlug, toAssetJson, assertImageAsset, describeAsset } = model

    const skillFile = put(['model', 'src', 'SKILL.md'], '# demo\n')
    const scriptFile = put(['model', 'src', 'scripts', 'run.mjs'], 'export const run = () => 1\n')
    const validAsset = () => ({
      kind: 'skill',
      host: 'dsh',
      id: 'demo-skill',
      label: 'Demo',
      version: '1.2.3',
      strategy: 'copy-tree',
      requires: ['node>=22', 7],
      meta: { skillRoot: '${HOME}/skills/demo', files: 2 },
      files: [
        { rel: 'SKILL.md', src: skillFile },
        { rel: 'scripts/run.mjs', src: scriptFile },
      ],
      secrets: { TOKEN: 'masked' },
    })

    await check('normalizeScanAsset fills defaults and deep-clones meta', () => {
      const asset = validAsset()
      const normalized = normalizeScanAsset(asset)
      assert.equal(normalized.kind, 'skill')
      assert.equal(normalized.host, 'dsh')
      assert.equal(normalized.builtin, false)
      assert.deepEqual(normalized.requires, ['node>=22', '7'])
      assert.equal(normalized.files.length, 2)
      assert.equal(normalized.files[0].rel, 'SKILL.md')
      assert.equal(normalized.meta.files, 2)
      assert.deepEqual(normalized.secrets, { TOKEN: 'masked' })
      asset.meta.files = 99
      assert.equal(normalized.meta.files, 2, 'meta must be cloned, not aliased')
    })

    await check('normalizeScanAsset rejects traversal and absolute rel paths', () => {
      for (const rel of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd']) {
        assert.throws(
          () => normalizeScanAsset({ ...validAsset(), files: [{ rel, src: skillFile }] }),
          /illegal rel path/,
          `expected rejection for ${rel}`,
        )
      }
    })

    await check('normalizeScanAsset rejects unknown kind, host and strategy', () => {
      assert.throws(() => normalizeScanAsset({ ...validAsset(), kind: 'weapon' }), /invalid kind/)
      assert.throws(() => normalizeScanAsset({ ...validAsset(), host: 'claude' }), /invalid host/)
      assert.throws(() => normalizeScanAsset({ ...validAsset(), strategy: 'teleport' }), /invalid strategy/)
    })

    await check('normalizeScanAsset rejects missing or illegal ids', () => {
      assert.throws(() => normalizeScanAsset({ ...validAsset(), id: '' }), /asset\.id is required/)
      assert.throws(() => normalizeScanAsset({ ...validAsset(), id: 'bad id!' }), /illegal characters/)
    })

    await check('digestFileList is order-independent and content-sensitive', () => {
      const a = [
        { rel: 'b.mjs', sha256: '2222' },
        { rel: 'a.md', sha256: '1111' },
      ]
      const b = [
        { rel: 'a.md', sha256: '1111' },
        { rel: 'b.mjs', sha256: '2222' },
      ]
      assert.equal(digestFileList(a), digestFileList(b))
      assert.equal(digestFileList([...a, { rel: 'a.md', sha256: '1111' }]), digestFileList(a))
      assert.notEqual(digestFileList([{ rel: 'a.md', sha256: '3333' }, a[0]]), digestFileList(a))
    })

    await check('assetSlug is filesystem-safe', () => {
      assert.equal(assetSlug({ kind: 'plugin', host: 'dsh', id: '@scope/pkg' }), 'plugin__dsh__scope-pkg')
      assert.equal(assetSlug({ kind: 'mcp', host: 'accio', id: 'doc-toolkit' }), 'mcp__accio__doc-toolkit')
    })

    await check('toAssetJson strips sources and records sha256/size/digest', () => {
      const normalized = normalizeScanAsset(validAsset())
      const files = normalized.files.map((file) => ({ ...file, sha256: 'a'.repeat(64), size: 123 }))
      const json = toAssetJson(normalized, files)
      assert.equal(json.files.length, 2)
      for (const file of json.files) {
        assert.equal(file.src, undefined)
        assert.equal(typeof file.sha256, 'string')
        assert.equal(file.size, 123)
      }
      assert.equal(json.digest, digestFileList(files))
      assert.doesNotThrow(() => JSON.stringify(json))
    })

    await check('assertImageAsset requires an absolute extracted dir', () => {
      const payloadDir = mkdirp('model', 'payload')
      const base = { kind: 'skill', host: 'dsh', id: 'x', strategy: 'copy-tree', files: [], dir: payloadDir }
      assert.doesNotThrow(() => assertImageAsset(base))
      assert.throws(() => assertImageAsset({ ...base, dir: 'payload/relative' }), /extracted dir/)
      assert.throws(() => assertImageAsset({ ...base, kind: 'weapon' }), /bad kind/)
    })

    await check('describeAsset names the asset', () => {
      const text = describeAsset({ kind: 'skill', host: 'dsh', id: 'demo-skill', version: '1.2.3', files: [{}, {}, {}] })
      assert.match(text, /skill\/dsh\/demo-skill/)
      assert.match(text, /3 files/)
      assert.match(text, /v1\.2\.3/)
    })
  })

  // -------------------------------------------------------------------------
  // tx: journaled writes + rollback
  // -------------------------------------------------------------------------
  await group('tx', async () => {
    const txMod = await needModule('lib/uppenv/core/tx.mjs', 'core/tx.mjs')
    if (!txMod) return
    const { createTx, rollbackTx } = txMod
    const txRoot = mkdirp('txroot')
    mkdirp('work')

    await check('rollback restores an overwritten file', () => {
      const file = put(['work', 'settings.json'], '{"a":1}\n')
      const tx = createTx(txRoot, { label: 'overwrite' })
      tx.writeText(file, '{"a":2}\n')
      assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n')
      const summary = tx.commit()
      assert.equal(summary.tx, tx.id)
      const result = rollbackTx(tx.dir)
      assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n')
      assert.ok(result.restored >= 1)
    })

    await check('rollback removes a file the transaction created', () => {
      const file = P('work', 'created.txt')
      const tx = createTx(txRoot)
      tx.writeText(file, 'fresh\n')
      assert.equal(fs.existsSync(file), true)
      const result = rollbackTx(tx.dir)
      assert.equal(fs.existsSync(file), false)
      assert.ok(result.removed >= 1)
    })

    await check('rollback restores a removed file', () => {
      const file = put(['work', 'remove-me.txt'], 'keep\n')
      const tx = createTx(txRoot)
      assert.equal(tx.remove(file), true)
      assert.equal(fs.existsSync(file), false)
      const result = rollbackTx(tx.dir)
      // Tx.remove() journals `backup` then `replace`; rollbackTx marks a path
      // seen on the newest entry, so `replace` must not mask the backup.
      assert.equal(
        fs.existsSync(file),
        true,
        `rollback did not restore a removed file (result: ${JSON.stringify(result)})`,
      )
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep\n')
      assert.ok(result.restored >= 1, `expected restored >= 1, got ${JSON.stringify(result)}`)
    })

    await check('rollback restores an overwritten directory tree', () => {
      const destDir = mkdirp('work', 'tree')
      put(['work', 'tree', 'a.txt'], 'A1\n')
      const srcDir = mkdirp('work', 'replacement')
      put(['work', 'replacement', 'b.txt'], 'B1\n')
      const tx = createTx(txRoot)
      assert.equal(tx.replaceTree(destDir, srcDir), true)
      assert.equal(fs.existsSync(path.join(destDir, 'a.txt')), false)
      assert.equal(fs.readFileSync(path.join(destDir, 'b.txt'), 'utf8'), 'B1\n')
      rollbackTx(tx.dir)
      assert.equal(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8'), 'A1\n')
      assert.equal(fs.existsSync(path.join(destDir, 'b.txt')), false)
    })

    await check('a dry-run transaction writes nothing and has no journal', () => {
      const file = put(['work', 'dry.txt'], 'before\n')
      const tx = createTx(txRoot, { dryRun: true })
      assert.equal(tx.writeText(file, 'after\n'), false)
      assert.equal(fs.readFileSync(file, 'utf8'), 'before\n')
      assert.equal(tx.exec('node', ['--version']).skipped, true)
      assert.throws(() => rollbackTx(tx.dir), /no journal/)
    })

    await check('rollbackTx rejects a directory without a journal', () => {
      assert.throws(() => rollbackTx(mkdirp('txroot', 'no-journal')), /no journal/)
    })
  })

  // -------------------------------------------------------------------------
  // apply: idempotent merge/append helpers + deepMerge semantics
  // -------------------------------------------------------------------------
  await group('apply', async () => {
    const apply = await needModule('lib/uppenv/core/apply.mjs', 'core/apply.mjs')
    const txMod = await needModule('lib/uppenv/core/tx.mjs', 'core/tx.mjs')
    if (!apply || !txMod) return
    const { deepMerge, applyMergeJson, applyAppendText, applyWriteText, jsonAction, textAction } = apply
    const { createTx } = txMod
    const txRoot = mkdirp('apply-tx')
    mkdirp('apply-work')

    await check('applyMergeJson creates, then reports noop for the same fragment', () => {
      const file = P('apply-work', 'config.json')
      const tx = createTx(txRoot)
      const fragment = { hosts: { dsh: { enabled: true } }, list: [1, 2] }
      const first = applyMergeJson(tx, file, fragment)
      assert.equal(first.action, 'create')
      const once = fs.readFileSync(file, 'utf8')
      assert.deepEqual(JSON.parse(once), fragment)
      const second = applyMergeJson(tx, file, fragment)
      assert.equal(second.action, 'noop')
      assert.equal(fs.readFileSync(file, 'utf8'), once)
    })

    await check('applyMergeJson honours onConflict: skip and dryRun', () => {
      const file = put(['apply-work', 'conflict.json'], '{"a":1}\n')
      const tx = createTx(txRoot)
      assert.equal(applyMergeJson(tx, file, { a: 2 }, { onConflict: 'skip' }).action, 'skip')
      assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n')
      assert.equal(applyMergeJson(tx, file, { b: 3 }, { dryRun: true }).action, 'update')
      assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n')
    })

    await check('applyWriteText creates, then reports noop', () => {
      const file = P('apply-work', 'memory.md')
      const tx = createTx(txRoot)
      assert.equal(applyWriteText(tx, file, 'hello\n').action, 'create')
      assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n')
      assert.equal(applyWriteText(tx, file, 'hello\n').action, 'noop')
    })

    await check('applyAppendText is idempotent and keeps a single marked block', () => {
      const file = put(['apply-work', 'CLAUDE.md'], '# Host config\n')
      const tx = createTx(txRoot)
      assert.equal(applyAppendText(tx, file, 'rule one\nrule two').action, 'create')
      const once = fs.readFileSync(file, 'utf8')
      assert.ok(once.startsWith('# Host config\n'))
      assert.ok(once.includes('<!-- uppenv:begin -->'))
      assert.ok(once.includes('<!-- uppenv:end -->'))
      assert.equal(applyAppendText(tx, file, 'rule one\nrule two').action, 'noop')
      assert.equal(fs.readFileSync(file, 'utf8'), once)
      assert.equal(applyAppendText(tx, file, 'rule three').action, 'update')
      const twice = fs.readFileSync(file, 'utf8')
      assert.ok(twice.includes('rule three'))
      assert.ok(!twice.includes('rule one'))
      assert.equal(twice.split('<!-- uppenv:begin -->').length - 1, 1)
      assert.equal(twice.split('<!-- uppenv:end -->').length - 1, 1)
      assert.ok(twice.startsWith('# Host config\n'))
    })

    await check('deepMerge merges objects, replaces arrays, respects null/undefined', () => {
      const base = { a: [1, 2], b: { c: 1, d: { e: 2 } }, keep: 'x' }
      const merged = deepMerge(base, { a: [3], b: { d: { f: 4 } } })
      assert.deepEqual(merged, { a: [3], b: { c: 1, d: { e: 2, f: 4 } }, keep: 'x' })
      assert.deepEqual(base, { a: [1, 2], b: { c: 1, d: { e: 2 } }, keep: 'x' }, 'deepMerge must not mutate')
      assert.equal(deepMerge(base, undefined), base)
      assert.equal(deepMerge(base, null), null)
      assert.equal(deepMerge(base, { keep: null }).keep, null)
      assert.equal(deepMerge(base, { keep: undefined }).keep, 'x')
    })

    await check('jsonAction and textAction classify create/noop/update', () => {
      assert.equal(jsonAction(P('apply-work', 'missing.json'), {}), 'create')
      const jsonFile = put(['apply-work', 'state.json'], '{"a":1}\n')
      assert.equal(jsonAction(jsonFile, { a: 1 }), 'noop')
      assert.equal(jsonAction(jsonFile, { a: 2 }), 'update')
      const textFile = put(['apply-work', 'state.txt'], 'hello')
      assert.equal(textAction(textFile, 'hello'), 'noop')
      assert.equal(textAction(textFile, 'bye'), 'update')
    })
  })

  // -------------------------------------------------------------------------
  // mcp-tools: stdio JSON-RPC probe + tool-surface diff (fake servers inline)
  // -------------------------------------------------------------------------
  await group('mcp-tools', async () => {
    const mcp = await needModule('lib/uppenv/core/mcp-tools.mjs', 'core/mcp-tools.mjs', { required: true })
    if (!mcp) return
    const { probeServer, compareToolSurface, formatToolTable } = mcp
    mkdirp('mcp')
    const fixture = (name, source) => {
      const file = P('mcp', name)
      fs.writeFileSync(file, source)
      return file
    }

    // A well-behaved server: noisy stdout, two tools across two cursor pages.
    // It enforces the probe protocol itself (version, clientInfo, handshake
    // order, cursor echo), so a PASS proves the client sent the right messages.
    const fakeServer = fixture(
      'fake-mcp.mjs',
      String.raw`import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (obj) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, obj)) + '\n')
const PAGE1 = [{ name: 'echo', description: 'Echo the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
const PAGE2 = [{ name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }]
let initialized = false
process.stdout.write('[fake-mcp] booting\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    if (!msg.params || msg.params.protocolVersion !== '2024-11-05') return send({ id: msg.id, error: { code: -32602, message: 'bad protocolVersion: ' + JSON.stringify(msg.params && msg.params.protocolVersion) } })
    if (!msg.params.clientInfo || msg.params.clientInfo.name !== 'uppenv') return send({ id: msg.id, error: { code: -32602, message: 'bad clientInfo' } })
    send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.1.0' } } })
  } else if (msg.method === 'notifications/initialized') {
    initialized = true
    process.stdout.write('[fake-mcp] initialized\n')
  } else if (msg.method === 'tools/list') {
    if (!initialized) return send({ id: msg.id, error: { code: -32002, message: 'tools/list before notifications/initialized' } })
    if (msg.params && msg.params.cursor === 'page-2') send({ id: msg.id, result: { tools: PAGE2 } })
    else if (msg.params && msg.params.cursor !== undefined) send({ id: msg.id, error: { code: -32602, message: 'unexpected cursor: ' + String(msg.params.cursor) } })
    else send({ id: msg.id, result: { tools: PAGE1, nextCursor: 'page-2' } })
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: 'method not found: ' + String(msg.method) } })
  }
})
`,
    )
    const garbageServer = fixture(
      'garbage.mjs',
      String.raw`process.stdout.write('not json at all: booting...\n'); setInterval(() => {}, 1000)
`,
    )
    const exitServer = fixture(
      'exit-3.mjs',
      String.raw`process.stdout.write('starting\n'); process.exit(3)
`,
    )
    const initErrorServer = fixture(
      'init-error.mjs',
      String.raw`import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom from fake server' } }) + '\n')
})
`,
    )

    await check('probeServer completes initialize + paginated tools/list despite stdout noise', async () => {
      const result = await probeServer({ command: process.execPath, args: [fakeServer] }, { timeoutMs: 8_000 })
      assert.equal(result.ok, true, `probe failed: ${result.error}`)
      assert.equal(result.error, null)
      assert.equal(result.server.name, 'fake-mcp')
      assert.equal(result.server.version, '0.1.0')
      assert.deepEqual(
        result.tools.map((tool) => tool.name),
        ['echo', 'add'],
        'both cursor pages must be merged',
      )
      assert.equal(result.tools[0].inputSchema.type, 'object')
      assert.equal(result.tools[1].description, 'Add two numbers')
    })

    await check('probeServer reports a spawn failure as a structured error', async () => {
      const result = await probeServer({ command: P('mcp', 'definitely-not-a-server') }, { timeoutMs: 5_000 })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'spawn-failed')
      assert.equal(result.server, null)
      assert.deepEqual(result.tools, [])
    })

    await check('probeServer times out without hanging on a silent server', async () => {
      const startedAt = Date.now()
      const result = await probeServer({ command: process.execPath, args: [garbageServer] }, { timeoutMs: 800 })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'timeout')
      assert.ok(Date.now() - startedAt < 5_000, 'timeout must be enforced')
    })

    await check('probeServer surfaces a non-zero exit code', async () => {
      const result = await probeServer({ command: process.execPath, args: [exitServer] }, { timeoutMs: 5_000 })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'server-exit')
      assert.match(result.error.message, /code 3/)
    })

    await check('probeServer surfaces a JSON-RPC error from initialize', async () => {
      const result = await probeServer({ command: process.execPath, args: [initErrorServer] }, { timeoutMs: 5_000 })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'initialize-error')
      assert.match(result.error.message, /boom from fake server/)
    })

    await check('probeServer never throws and always returns a structured error', async () => {
      for (const bad of [null, {}, { command: '' }, { command: 42 }, { command: 'node', args: 'not-an-array' }]) {
        const result = await probeServer(bad, { timeoutMs: 1_500 })
        assert.equal(result.ok, false, `expected failure for ${JSON.stringify(bad)}`)
        assert.equal(typeof result.error.code, 'string')
        assert.equal(typeof result.error.message, 'string')
        assert.equal(result.server, null)
        assert.ok(Array.isArray(result.tools))
      }
    })

    const baseTools = [
      { name: 'alpha', description: 'A', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
      { name: 'beta', description: 'B', inputSchema: { type: 'object', properties: {} } },
    ]

    await check('compareToolSurface reports identical surfaces as same', () => {
      const diff = compareToolSurface(
        baseTools,
        baseTools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
      )
      assert.equal(diff.same, true)
      assert.deepEqual(diff.added, [])
      assert.deepEqual(diff.removed, [])
      assert.deepEqual(diff.changed, [])
    })

    await check('compareToolSurface detects added, removed and changed tools', () => {
      const after = [
        { name: 'alpha', description: 'A (changed)', inputSchema: baseTools[0].inputSchema },
        { name: 'gamma', description: 'G', inputSchema: { type: 'object', properties: {} } },
      ]
      const diff = compareToolSurface(baseTools, after)
      assert.equal(diff.same, false)
      assert.deepEqual(diff.added, ['gamma'])
      assert.deepEqual(diff.removed, ['beta'])
      assert.deepEqual(diff.changed.map((entry) => entry.name), ['alpha'])
      assert.deepEqual(diff.changed[0].fields, ['description'])
    })

    await check('compareToolSurface ignores inputSchema key order', () => {
      const before = [{ name: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }]
      const after = [{ name: 'x', inputSchema: { properties: { a: { type: 'string' } }, type: 'object' } }]
      assert.equal(compareToolSurface(before, after).same, true)
    })

    await check('formatToolTable renders a deterministic text table', () => {
      const table = formatToolTable(baseTools)
      assert.equal(typeof table, 'string')
      assert.match(table, /NAME/)
      assert.match(table, /DESCRIPTION/)
      assert.match(table, /alpha/)
      assert.match(table, /beta/)
      assert.equal(table, formatToolTable(baseTools))
    })

    await check('formatToolTable handles an empty tool list', () => {
      const table = formatToolTable([])
      assert.equal(typeof table, 'string')
      assert.match(table, /no tools/i)
    })
  })

  // -------------------------------------------------------------------------
  // hosts: adapters owned by other teammates — structural CONTRACT v1 checks
  // -------------------------------------------------------------------------
  await group('hosts', async () => {
    for (const hostName of ['dsh', 'workbuddy', 'accio']) {
      const relPath = `lib/uppenv/hosts/${hostName}.mjs`
      const file = path.join(ROOT, ...relPath.split('/'))
      if (!fs.existsSync(file)) {
        skip(`adapter ${hostName}`, `not written yet (${relPath})`)
        continue
      }
      await check(`adapter ${hostName} matches CONTRACT v1`, async () => {
        const mod = await import(pathToFileURL(file).href)
        const adapter = mod.default
        assert.ok(adapter && typeof adapter === 'object', `${hostName}.mjs must default-export an adapter object`)
        assert.equal(adapter.name, hostName)
        for (const method of ['detect', 'scan', 'apply']) {
          assert.equal(typeof adapter[method], 'function', `${hostName}.${method}() is required by CONTRACT v1`)
        }
        for (const optional of ['plan', 'verify']) {
          if (adapter[optional] !== undefined) {
            assert.equal(typeof adapter[optional], 'function', `${hostName}.${optional}() must be a function when present`)
          }
        }
      })
    }
  })

  // -------------------------------------------------------------------------
  // image: owned by the Lead — only a load-level smoke check
  // -------------------------------------------------------------------------
  await group('image', async () => {
    const relPath = 'lib/uppenv/image.mjs'
    const file = path.join(ROOT, ...relPath.split('/'))
    if (!fs.existsSync(file)) {
      skip('module', `image.mjs not written yet (${relPath})`)
      return
    }
    await check('image.mjs loads and exports a callable API', async () => {
      const mod = await import(pathToFileURL(file).href)
      const functions = Object.entries(mod).filter(([, value]) => typeof value === 'function')
      assert.ok(functions.length >= 1, 'image.mjs exports no functions')
    })
  })

  // -------------------------------------------------------------------------
  // cli: owned by the Lead — --help must terminate (no hang, no silent crash)
  // -------------------------------------------------------------------------
  await group('cli', async () => {
    const relPath = 'tools/uppenv.mjs'
    const file = path.join(ROOT, ...relPath.split('/'))
    if (!fs.existsSync(file)) {
      skip('entrypoint', `not written yet (${relPath})`)
      return
    }
    await check('--help terminates and prints usage', () => {
      const result = spawnSync(process.execPath, [file, '--help'], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, NO_COLOR: '1' },
      })
      assert.ifError(result.error)
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      assert.ok(output.length > 0, 'CLI printed nothing for --help')
      assert.match(output, /uppenv/i)
    })
  })
} finally {
  clearTimeout(watchdog)
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const count = (kind) => results.filter((entry) => entry.kind === kind).length
const passed = count('PASS')
const failed = count('FAIL')
const skipped = count('SKIP')
const seconds = ((Date.now() - SUITE_START) / 1000).toFixed(2)

console.log('')
console.log(
  `uppenv self-test: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} checks, ${seconds}s)`,
)
if (failed > 0) {
  console.log('status: FAIL')
  for (const entry of results.filter((item) => item.kind === 'FAIL')) console.log(`  failed: ${entry.label}`)
} else {
  console.log('status: OK')
}
process.exitCode = failed > 0 ? 1 : 0
