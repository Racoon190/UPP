#!/usr/bin/env node
/**
 * uppenv round-trip test — export from a synthetic host, import into a second
 * synthetic home, roll the import back, then attack the image and check that
 * the tampered copy is refused. Everything happens under os.tmpdir(); no real
 * host directory is read or written.
 *
 *   node tools/test-roundtrip.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLI = path.join(ROOT, 'tools', 'uppenv.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-roundtrip-'))
const SRC = path.join(TMP, 'source-home')
const DST = path.join(TMP, 'target-home')
const IMG = path.join(TMP, 'roundtrip.uppenv')
const KEYS = path.join(TMP, 'keys')
let pass = 0
let fail = 0

function ok(msg) {
  pass += 1
  process.stdout.write(`PASS ${msg}\n`)
}
function bad(msg, extra) {
  fail += 1
  process.stdout.write(`FAIL ${msg}${extra ? `\n     ${extra}` : ''}\n`)
}
function check(cond, msg, extra) {
  if (cond) ok(msg)
  else bad(msg, extra)
}
function envFor(home, extra = {}) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    DSH_HOME: path.join(home, '.dsh'),
    UPPENV_HOME: path.join(home, '.uppenv'),
    NO_COLOR: '1',
    ...extra,
  }
}
function run(args, home, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: envFor(home, extraEnv),
    encoding: 'utf8',
    timeout: 120000,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, stdout: res.stdout ?? '' }
}
function jsonRun(args, home, extraEnv = {}) {
  const res = run([...args, '--json'], home, extraEnv)
  try {
    return { code: res.code, json: JSON.parse(res.stdout), out: res.out }
  } catch {
    return { code: res.code, json: null, out: res.out }
  }
}

try {
  // ---------------------------------------------------------------- source host
  fs.mkdirSync(path.join(SRC, '.workbuddy', 'skills', 'demo-skill', 'references'), { recursive: true })
  fs.writeFileSync(path.join(SRC, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md'), '# demo skill\nround-trip fixture\n')
  fs.writeFileSync(path.join(SRC, '.workbuddy', 'skills', 'demo-skill', 'references', 'note.md'), 'note body\n')

  // -------------------------------------------------------------------- keygen
  const keygen = jsonRun(['keygen', '--out', KEYS, '--force'], SRC)
  check(keygen.code === 0 && Boolean(keygen.json?.fingerprint), 'keygen creates an ed25519 key', keygen.out.slice(-500))
  const keyFile = path.join(KEYS, 'uppenv-signing.key.pem')
  const pubFile = path.join(KEYS, 'uppenv-signing.pub.pem')
  check(fs.existsSync(keyFile) && fs.existsSync(pubFile), 'key pair written to disk')
  const keygenAgain = run(['keygen', '--out', KEYS], SRC)
  check(keygenAgain.code !== 0, 'keygen refuses to overwrite an existing key')

  // -------------------------------------------------------------------- export
  const exported = run(['export', '-o', IMG, '--host', 'workbuddy', '--kind', 'skill', '--no-probe-tools', '--sign', '--key', keyFile], SRC)
  check(exported.code === 0, 'signed export exits 0', exported.out.slice(-800))
  check(fs.existsSync(IMG), 'image file exists')
  check(fs.existsSync(`${IMG}.sig.json`), 'signature sidecar written')
  check(fs.existsSync(`${IMG}.sha256`), 'sha256 sidecar written')

  // -------------------------------------------------------------------- verify
  const verified = run(['verify', IMG, '--require-signature'], SRC)
  check(verified.code === 0 && /signature ed25519/.test(verified.out), 'verify passes with --require-signature', verified.out.slice(-500))
  const sigJson = jsonRun(['verify-signature', IMG, '--require'], SRC)
  check(sigJson.code === 0 && sigJson.json?.ok === true && sigJson.json?.signed === true, 'verify-signature reports a valid signature', sigJson.out.slice(-500))
  const sig = JSON.parse(fs.readFileSync(`${IMG}.sig.json`, 'utf8'))
  check(sig.format === 'upp-sig/1' && sig.alg === 'ed25519', 'signature sidecar has the documented format')
  check(sig.keyFingerprint === keygen.json.fingerprint, 'signature uses the requested key (--key), not the default')
  check(sig.sha256 === fs.readFileSync(`${IMG}.sha256`, 'utf8').trim().split(/\s+/)[0], 'sha256 sidecar matches the signed digest')
  const pinned = run(['verify-signature', IMG, '--require', '--pubkey', pubFile], SRC)
  check(pinned.code === 0, '--pubkey pins the expected signer')
  const wrongKey = path.join(TMP, 'other.pub.pem')
  const other = jsonRun(['keygen', '--out', path.join(TMP, 'other-keys'), '--force'], SRC)
  fs.copyFileSync(path.join(TMP, 'other-keys', 'uppenv-signing.pub.pem'), wrongKey)
  const wrongPinned = run(['verify-signature', IMG, '--require', '--pubkey', wrongKey], SRC)
  check(Boolean(other.json) && wrongPinned.code !== 0, '--pubkey rejects a different signer')

  const inspected = run(['inspect', IMG], SRC)
  check(/signature ed25519/.test(inspected.out), 'inspect reports the signature')

  // ------------------------------------------------------------- import (fresh)
  fs.mkdirSync(path.join(DST, '.workbuddy', 'skills'), { recursive: true })
  const imported = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--require-signature', '--yes'], DST)
  check(imported.code === 0, 'import exits 0 with --require-signature', imported.out.slice(-800))
  const skillFile = path.join(DST, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md')
  check(fs.existsSync(skillFile), 'skill tree materialized in target home')
  check(fs.existsSync(path.join(DST, '.workbuddy', 'skills', 'demo-skill', 'references', 'note.md')), 'skill nested file materialized')

  // ------------------------------------------------------- conflict: skip
  fs.appendFileSync(skillFile, 'local edit\n')
  const skipped = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--yes', '--on-conflict', 'skip'], DST)
  check(skipped.code === 0 && fs.readFileSync(skillFile, 'utf8').includes('local edit'), '--on-conflict skip keeps the local edit', skipped.out.slice(-400))

  // ------------------------------------------------------- conflict: overwrite
  const overwritten = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--yes', '--on-conflict', 'overwrite'], DST)
  check(overwritten.code === 0 && !fs.readFileSync(skillFile, 'utf8').includes('local edit'), '--on-conflict overwrite replaces the local edit')

  // ---------------------------------------------------------------- rollback
  const rolled = run(['rollback', '--last'], DST)
  check(rolled.code === 0 && /rolled back/.test(rolled.out), 'rollback --last exits 0', rolled.out.slice(-400))
  // There are three transactions now (create, skip, overwrite): unwind them all.
  for (let i = 0; i < 3 && fs.existsSync(path.join(DST, '.workbuddy', 'skills', 'demo-skill')); i++) {
    run(['rollback', '--last'], DST)
  }
  check(!fs.existsSync(path.join(DST, '.workbuddy', 'skills', 'demo-skill')), 'rollback removed the skill tree')

  // ------------------------------------------------------- tamper / wrong file
  const TAMPERED = path.join(TMP, 'tampered.uppenv')
  fs.copyFileSync(IMG, TAMPERED)
  fs.copyFileSync(`${IMG}.sig.json`, `${TAMPERED}.sig.json`)
  const buf = fs.readFileSync(TAMPERED)
  buf[Math.floor(buf.length / 2)] ^= 0xff
  fs.writeFileSync(TAMPERED, buf)
  const tamperedVerify = run(['verify-signature', TAMPERED, '--json'], SRC)
  check(tamperedVerify.code !== 0, 'tampered image fails signature verification')
  const DST2 = path.join(TMP, 'target-home-2')
  fs.mkdirSync(DST2, { recursive: true })
  const tamperedImport = run(['import', TAMPERED, '--host', 'workbuddy', '--kind', 'skill', '--yes'], DST2)
  check(tamperedImport.code !== 0, 'import refuses a tampered image', tamperedImport.out.slice(-300))
  check(!fs.existsSync(path.join(DST2, '.workbuddy', 'skills', 'demo-skill')), 'tampered import wrote nothing')

  // --------------------------------------------- unsigned image + require-signature
  const UNSIGNED = path.join(TMP, 'unsigned.uppenv')
  const unsignedExport = run(['export', '-o', UNSIGNED, '--host', 'workbuddy', '--kind', 'skill', '--no-probe-tools'], SRC)
  check(unsignedExport.code === 0 && !fs.existsSync(`${UNSIGNED}.sig.json`), 'unsigned export writes no .sig.json')
  const unsignedRequire = run(['verify', UNSIGNED, '--require-signature'], SRC)
  check(unsignedRequire.code !== 0, '--require-signature rejects an unsigned image')
  const unsignedImport = run(['import', UNSIGNED, '--host', 'workbuddy', '--kind', 'skill', '--require-signature', '--yes'], DST2)
  check(unsignedImport.code !== 0, 'import --require-signature refuses an unsigned image')

  // -------------------------------------------------------- sign an existing image
  const signExisting = run(['sign', UNSIGNED, '--key', keyFile], SRC)
  check(signExisting.code === 0 && fs.existsSync(`${UNSIGNED}.sig.json`), 'sign stamps an existing image')
  const signedLater = run(['verify-signature', UNSIGNED, '--require'], SRC)
  check(signedLater.code === 0, 'the newly signed image verifies')
} catch (err) {
  bad(`unexpected exception: ${err.message}`)
  process.stdout.write(`${err.stack}\n`)
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

const total = pass + fail
process.stdout.write(`\nround-trip: ${pass} passed, ${fail} failed (${total} checks)\n`)
process.exit(fail ? 1 : 0)
