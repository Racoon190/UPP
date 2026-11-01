/**
 * Ed25519 signing for `.uppenv` images — reuses the UPP detached-signature
 * format (`upp-sig/1` + `<file>.sha256` + `<file>.sig.json`), so one key signs
 * both artifacts and `upp verify-signature --from env.uppenv` can validate an
 * image with no extra tooling.
 *
 * Key resolution order:
 *   UPPENV_SIGNING_KEY  -> explicit private key
 *   UPP_SIGNING_KEY     -> shared with the UPP toolchain
 *   <UPPENV_HOME>/keys/uppenv-signing.key.pem  -> `uppenv keygen`
 *   ~/.upp/keys/upp-signing.key.pem            -> `upp keygen`
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sha256File } from './util.mjs'

export const SIG_FORMAT = 'upp-sig/1'
export const SIG_ALG = 'ed25519'
export const SIG_VERSION = '1.0.0'

const sigPath = (file) => `${file}.sig.json`
const shaPath = (file) => `${file}.sha256`

function home(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir()
}

function upenvHome(env = process.env) {
  return env.UPPENV_HOME || path.join(home(env), '.uppenv')
}

/** Candidate private-key paths, most specific first. */
export function keyCandidates(env = process.env) {
  const list = []
  if (env.UPPENV_SIGNING_KEY) list.push({ path: path.resolve(env.UPPENV_SIGNING_KEY), source: 'UPPENV_SIGNING_KEY' })
  if (env.UPP_SIGNING_KEY) list.push({ path: path.resolve(env.UPP_SIGNING_KEY), source: 'UPP_SIGNING_KEY' })
  list.push({ path: path.join(upenvHome(env), 'keys', 'uppenv-signing.key.pem'), source: 'uppenv-home' })
  list.push({ path: path.join(home(env), '.upp', 'keys', 'upp-signing.key.pem'), source: 'upp-home' })
  return list
}

/** First existing signing key, or null. */
export function resolveSigningKey(env = process.env) {
  for (const cand of keyCandidates(env)) {
    if (fs.existsSync(cand.path)) return cand
  }
  return null
}

export function keyFingerprint(pubPem) {
  const key = crypto.createPublicKey(pubPem)
  const der = key.export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/** Load the private key (explicit path wins, then the candidate chain). */
export function loadSigningKey({ keyPath = null, env = process.env } = {}) {
  let target = null
  if (keyPath) target = { path: path.resolve(keyPath), source: '--key' }
  else target = resolveSigningKey(env)
  if (!target) {
    const tried = keyCandidates(env).map((c) => c.path).join('\n  ')
    throw new Error(`no signing key found; tried:\n  ${tried}\ncreate one with: uppenv keygen  (or: upp keygen)`)
  }
  const pem = fs.readFileSync(target.path, 'utf8')
  const key = crypto.createPrivateKey(pem)
  const pubPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' })
  return { path: target.path, source: target.source, key, publicKey: pubPem, fingerprint: keyFingerprint(pubPem) }
}

/** Generate a fresh ed25519 key pair (0600 private key). */
export function generateKey({ dir = null, force = false, env = process.env } = {}) {
  const outDir = dir ? path.resolve(dir) : path.join(upenvHome(env), 'keys')
  const keyFile = path.join(outDir, 'uppenv-signing.key.pem')
  const pubFile = path.join(outDir, 'uppenv-signing.pub.pem')
  if (fs.existsSync(keyFile) && !force) {
    throw new Error(`refusing to overwrite existing key: ${keyFile} (pass --force)`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
  fs.writeFileSync(keyFile, privPem, { mode: 0o600 })
  fs.writeFileSync(pubFile, pubPem)
  return { keyFile, pubFile, fingerprint: keyFingerprint(pubPem) }
}

/** Sign an image in place: writes `<image>.sha256` and `<image>.sig.json`. */
export function signImage(file, { keyPath = null, env = process.env, tool = null } = {}) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new Error(`image not found: ${abs}`)
  const { key, publicKey, fingerprint, path: usedKey } = loadSigningKey({ keyPath, env })
  const bytes = fs.readFileSync(abs)
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  const sig = {
    format: SIG_FORMAT,
    alg: SIG_ALG,
    kind: 'uppenv-image',
    file: path.basename(abs),
    size: bytes.length,
    sha256: hash,
    keyFingerprint: fingerprint,
    publicKey,
    signature: crypto.sign(null, bytes, key).toString('base64'),
    signedAt: new Date().toISOString(),
    tool: tool ?? { name: 'uppenv', version: SIG_VERSION },
  }
  fs.writeFileSync(sigPath(abs), `${JSON.stringify(sig, null, 2)}\n`)
  fs.writeFileSync(shaPath(abs), `${hash}  ${path.basename(abs)}\n`)
  return { file: abs, sha256: hash, sha256File: shaPath(abs), signatureFile: sigPath(abs), fingerprint, key: usedKey }
}

/** Read `<image>.sig.json` (null when unsigned / unreadable). */
export function readSignature(file) {
  const sf = sigPath(path.resolve(file))
  if (!fs.existsSync(sf)) return null
  try {
    return JSON.parse(fs.readFileSync(sf, 'utf8'))
  } catch {
    return null
  }
}

const ok = (check, detail = '') => ({ check, ok: true, detail })
const bad = (check, detail = '') => ({ check, ok: false, detail })

/**
 * Verify an image's detached signature (and the optional .sha256 sidecar).
 * `require` turns "unsigned" into a failure; `pubkey` pins the signer.
 */
export function verifySignature(file, { require = false, pubkey = null } = {}) {
  const abs = path.resolve(file)
  const checks = []
  if (!fs.existsSync(abs)) {
    return { ok: false, signed: false, checks: [bad('file', `not found: ${abs}`)], problems: [`not found: ${abs}`] }
  }
  const sha = sha256File(abs)
  const shaFile = shaPath(abs)
  if (fs.existsSync(shaFile)) {
    const recorded = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]
    checks.push(recorded === sha ? ok('sha256.sidecar', sha) : bad('sha256.sidecar', `recorded ${recorded}, actual ${sha}`))
  } else {
    checks.push(require ? bad('sha256.sidecar', 'missing .sha256 sidecar') : ok('sha256.sidecar', 'absent (optional)'))
  }

  const sig = readSignature(abs)
  if (!sig) {
    checks.push(require ? bad('signature', 'missing .sig.json') : ok('signature', 'absent (optional)'))
    const problems = checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`)
    return { ok: problems.length === 0, signed: false, sha256: sha, checks, problems }
  }
  if (sig.format !== SIG_FORMAT || sig.alg !== SIG_ALG) {
    checks.push(bad('signature.format', `expected format=${SIG_FORMAT} alg=${SIG_ALG}, got ${sig.format}/${sig.alg}`))
  } else {
    checks.push(ok('signature.format', `${sig.format} ${sig.alg}`))
  }
  checks.push(
    sig.file === path.basename(abs) ? ok('signature.file', sig.file) : bad('signature.file', `expected ${path.basename(abs)}, got ${sig.file}`),
  )
  checks.push(sig.sha256 === sha ? ok('signature.sha256', sha) : bad('signature.sha256', `signed ${sig.sha256}, actual ${sha}`))
  let fingerprint = null
  try {
    fingerprint = keyFingerprint(sig.publicKey)
    const verified = crypto.verify(null, fs.readFileSync(abs), crypto.createPublicKey(sig.publicKey), Buffer.from(sig.signature, 'base64'))
    checks.push(verified ? ok('signature.verify', `ed25519 ${fingerprint}`) : bad('signature.verify', 'signature does not match'))
  } catch (err) {
    checks.push(bad('signature.verify', err.message))
  }
  if (pubkey) {
    const expected = keyFingerprint(fs.readFileSync(path.resolve(pubkey), 'utf8'))
    checks.push(expected === fingerprint ? ok('signature.pubkey', expected) : bad('signature.pubkey', `expected ${expected}, got ${fingerprint}`))
  }
  const problems = checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`)
  return { ok: problems.length === 0, signed: true, sha256: sha, fingerprint, checks, problems }
}

export { sigPath, shaPath }
