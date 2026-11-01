#!/usr/bin/env node
/**
 * UPP toolchain (reference implementation, zero dependencies).
 *
 *   node tools/upp.mjs detect
 *   node tools/upp.mjs validate --pkg examples/hello-upp
 *   node tools/upp.mjs build    --pkg examples/hello-upp [--check]
 *   node tools/upp.mjs install  --pkg examples/hello-upp [--hosts dsh,workbuddy,accio]
 *   node tools/upp.mjs verify   --pkg examples/hello-upp
 *   node tools/upp.mjs conformance --pkg examples/hello-upp
 *   node tools/upp.mjs pack     --pkg examples/hello-upp [--out dist] [--sign]
 *   node tools/upp.mjs keygen   [--out <dir>]
 *   node tools/upp.mjs verify-signature --from dist/x.upp [--pubkey <pem>]
 *   node tools/upp.mjs bundle-offline --pkg examples/hello-upp [--out dist] [--sign] [--zip]
 *   node tools/upp.mjs setup-cli [--prefix <dir>] [--no-path]
 *   node tools/upp.mjs self-update [--from <upp.mjs|dir>] [--prefix <dir>] [--force]
 *   node tools/upp.mjs env  <command>   # environment images (uppenv)
 *   node tools/upp.mjs tool <command>   # reusable local tools (upptool)
 *   node tools/upp.mjs mem  <command>   # shared agent memory (uppmem)
 *   node tools/upp.mjs --version
 *   node tools/upp.mjs doctor
 *   node tools/upp.mjs uninstall --pkg examples/hello-upp
 *   node tools/upp.mjs import  <path> [--out imports/<id>] [--analyze]
 *   node tools/upp.mjs analyze <path> [--out imports/<id>]
 *   node tools/upp.mjs env <command> [...]   # environment images (delegates to tools/uppenv.mjs)
 *
 * Design rules:
 *  - `upp.json` is the single source of truth; every other manifest is generated.
 *  - Writes are idempotent and preceded by a one-time `<file>.upp-bak-orig` backup.
 *  - Every host write is recorded in `<pkg>/.upp-install.json`, so uninstall is exact.
 *  - No network, no package manager, no host SDK, no npm dependency.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { connect } from 'node:net';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ACCIO_CLI = process.env.UPP_ACCIO_CLI ?? 'D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs';
const DSH_CLI = process.env.UPP_DSH_CLI ?? 'D:/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';
const WB_CLI =
  process.env.UPP_WB_CLI ??
  'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const UPP_HOME = join(HOME, '.upp');
const CLI_DIR = join(UPP_HOME, 'bin');
const VERSION = '1.3.2';
const KEYS_DIR = join(UPP_HOME, 'keys');
const SIGNING_KEY = process.env.UPP_SIGNING_KEY ?? join(KEYS_DIR, 'upp-signing.key.pem');
const SIGNING_PUB = `${SIGNING_KEY.replace(/\.key\.pem$/, '')}.pub.pem`;

const argv = process.argv.slice(2);
const command = argv[0] ?? 'detect';
const flagIndex = (name) => argv.indexOf(`--${name}`);
const flag = (name, fallback = undefined) => {
  const i = flagIndex(name);
  return i === -1 ? fallback : argv[i + 1];
};
const hasFlag = (name) => flagIndex(name) !== -1;

// ------------------------------------------------------------------ helpers
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function backupOnce(file) {
  if (!existsSync(file)) return;
  const bak = `${file}.upp-bak-orig`;
  if (!existsSync(bak)) copyFileSync(file, bak);
}
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  backupOnce(file);
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false;
  writeFileSync(file, text, 'utf8');
  return true;
}
function writeJson(file, data) {
  return writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}
function copyDir(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(full);
  }
  return out;
}
function log(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}
function ok(name, detail = '') {
  return { check: name, ok: true, detail };
}
function fail(name, detail = '') {
  return { check: name, ok: false, detail };
}

// ------------------------------------------------------------------ integrity
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function keyFingerprint(pubPem) {
  const der = createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}
const sigPath = (file) => `${file}.sig.json`;
const shaPath = (file) => `${file}.sha256`;

/** Verify a .upp against its sidecar hash file and (if present) detached ed25519 signature. */
function verifyPackage(file, { required = false, pubkey = null } = {}) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`package not found: ${abs}`);
  const checks = [];
  const hash = sha256File(abs);
  const shaFile = shaPath(abs);
  if (existsSync(shaFile)) {
    const recorded = readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0];
    checks.push(recorded === hash ? ok('sha256.sidecar', hash) : fail('sha256.sidecar', `expected ${recorded}, got ${hash}`));
  } else {
    checks.push(required ? fail('sha256.sidecar', 'missing .sha256 sidecar') : ok('sha256.sidecar', 'absent (optional)'));
  }
  const sf = sigPath(abs);
  if (!existsSync(sf)) {
    checks.push(required ? fail('signature', 'missing .sig.json') : ok('signature', 'absent (optional)'));
    return { file: abs, sha256: hash, signed: false, checks };
  }
  let sig;
  try {
    sig = readJson(sf, null);
  } catch {
    checks.push(fail('signature', 'unreadable .sig.json'));
    return { file: abs, sha256: hash, signed: false, checks };
  }
  if (!sig || sig.format !== 'upp-sig/1' || sig.alg !== 'ed25519') {
    checks.push(fail('signature.format', 'expected format=upp-sig/1 alg=ed25519'));
    return { file: abs, sha256: hash, signed: false, checks };
  }
  checks.push(sig.file === basename(abs) ? ok('signature.file', sig.file) : fail('signature.file', `expected ${basename(abs)}, got ${sig.file}`));
  checks.push(sig.sha256 === hash ? ok('signature.sha256', hash) : fail('signature.sha256', `package hash ${hash} != signed ${sig.sha256}`));
  let verified = false;
  try {
    verified = cryptoVerify(null, readFileSync(abs), createPublicKey(sig.publicKey), Buffer.from(sig.signature, 'base64'));
  } catch (e) {
    checks.push(fail('signature.verify', e.message));
  }
  checks.push(verified ? ok('signature.verify', `ed25519 ${keyFingerprint(sig.publicKey)}`) : fail('signature.verify', 'signature does not match'));
  if (pubkey) {
    const expected = keyFingerprint(readFileSync(pubkey, 'utf8'));
    const actual = keyFingerprint(sig.publicKey);
    checks.push(expected === actual ? ok('signature.pubkey', expected) : fail('signature.pubkey', `expected ${expected}, got ${actual}`));
  }
  return { file: abs, sha256: hash, signed: true, fingerprint: keyFingerprint(sig.publicKey), checks };
}
function assertionsOrExit(result, label = 'signature') {
  const failed = result.checks.filter((c) => !c.ok);
  log({ [label]: result, failed: failed.length });
  if (failed.length) process.exitCode = 1;
  return failed.length === 0;
}

// ------------------------------------------------------------------ manifest
function loadManifest(pkg) {
  const file = join(pkg, 'upp.json');
  const m = readJson(file, null);
  if (!m) throw new Error(`upp.json not found in ${pkg}`);
  m.uppVersion ??= '1.0';
  m.capabilities ??= ['tools', 'skills'];
  m.permissions ??= { network: false, filesystem: 'none', shell: false };
  m.runtime ??= { kind: 'node', entry: 'runtime/server.mjs' };
  m.runtime.kind ??= 'node';
  m.runtime.entry ??= 'runtime/server.mjs';
  m.runtime.manifest ??= 'runtime/tools.json';
  m.tokenBudget ??= {};
  m.hosts ??= {};
  const sanitize = (raw) =>
    String(raw ?? m.id)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 32);
  m.serverName = sanitize(m.hosts.dsh?.serverName ?? m.hosts.workbuddy?.serverName ?? m.hosts.accio?.serverName ?? m.id);
  m.hosts.dsh ??= {};
  m.hosts.dsh.serverName ??= m.serverName;
  m.hosts.workbuddy ??= {};
  m.hosts.workbuddy.serverName ??= m.serverName;
  m.hosts.accio ??= {};
  m.hosts.accio.serverName ??= m.serverName;
  m.hosts.dsh.packageName ??= readJson(join(pkg, 'package.json'), {})?.name ?? `@upp/${m.id}`;
  m.skills = m.skills ?? discoverSkills(pkg);
  const withPath = (list, dir) => (list ?? []).map((item) => ({ ...item, path: item.path ?? `${dir}/${item.id}.md` }));
  m.prompts = withPath(m.prompts ?? discoverMarkdown(pkg, 'prompts'), 'prompts');
  m.agents = withPath(m.agents ?? discoverMarkdown(pkg, 'agents'), 'agents');
  m.i18n = m.i18n ?? readJson(join(pkg, 'i18n.json'), null);
  m.recommend = m.recommend ?? readJson(join(pkg, 'recommend.json'), null);
  m.ui = m.ui ?? null;
  m.hooks = m.hooks ?? [];
  return m;
}

function discoverSkills(pkg) {
  const root = join(pkg, 'skills');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map((e) => ({ id: e.name, path: `skills/${e.name}` }));
}

function discoverMarkdown(pkg, dir) {
  const root = join(pkg, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ id: e.name.replace(/\.md$/i, ''), path: `${dir}/${e.name}` }));
}

/** Split a Markdown file with optional YAML frontmatter into { fm, body }. */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { fm: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: '', body: text };
  const fmEnd = text.indexOf('\n', end + 1);
  return { fm: text.slice(3, end).trim(), body: fmEnd < 0 ? '' : text.slice(fmEnd + 1).replace(/^[\r\n]/, '') };
}

/** Quote a value for a one-line YAML frontmatter field. */
function yamlString(value) {
  const text = String(value ?? '').replace(/[\r\n]/g, ' ').trim();
  return text === '' || /[:#\-?*&!|>'"%@`{}\[\],]/.test(text) ? JSON.stringify(text) : text;
}

function validateManifest(pkg, m) {
  const checks = [];
  const idOk = /^[a-z][a-z0-9-]{2,63}$/.test(m.id ?? '');
  checks.push(idOk ? ok('manifest.id', m.id) : fail('manifest.id', `"${m.id}" must be kebab-case`));
  checks.push(/^\d+\.\d+\.\d+/.test(m.version ?? '') ? ok('manifest.version', m.version) : fail('manifest.version', m.version));
  checks.push(m.name ? ok('manifest.name', m.name) : fail('manifest.name', 'missing'));
  checks.push(m.description ? ok('manifest.description', m.description) : fail('manifest.description', 'missing'));
  checks.push(
    /^[A-Za-z0-9_-]{1,32}$/.test(m.serverName)
      ? ok('manifest.serverName', m.serverName)
      : fail('manifest.serverName', `"${m.serverName}" must match ^[A-Za-z0-9_-]{1,32}$ (DeepSeek Harness limit)`),
  );
  checks.push(m.uppVersion === '1.0' ? ok('manifest.uppVersion', '1.0') : fail('manifest.uppVersion', m.uppVersion));
  const entry = join(pkg, m.runtime.entry);
  checks.push(existsSync(entry) ? ok('runtime.entry', m.runtime.entry) : fail('runtime.entry', `missing ${entry}`));
  checks.push(
    m.runtime.kind === 'node' ? ok('runtime.kind', 'node') : fail('runtime.kind', `unsupported: ${m.runtime.kind}`),
  );
  const knownCaps = ['tools', 'skills', 'prompts', 'agents', 'i18n', 'recommend', 'clis', 'ui', 'hooks'];
  for (const cap of m.capabilities) {
    if (!knownCaps.includes(cap)) checks.push(fail('capability', `unknown: ${cap}`));
  }
  if (m.capabilities.includes('tools')) {
    checks.push(
      (m.tools ?? []).length > 0 || existsSync(join(pkg, m.runtime.manifest))
        ? ok('capability.tools', `${(m.tools ?? []).length} declared in upp.json`)
        : fail('capability.tools', 'no tools declared and no runtime manifest'),
    );
  }
  if (m.capabilities.includes('skills')) {
    checks.push(
      m.skills.length > 0 ? ok('capability.skills', m.skills.map((s) => s.id).join(',')) : fail('capability.skills', 'no SKILL.md found'),
    );
    for (const skill of m.skills) {
      const file = join(pkg, skill.path, 'SKILL.md');
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const fm = text.startsWith('---') ? text.slice(0, text.indexOf('\n---', 3)) : '';
      checks.push(
        /name:/.test(fm) && /description:/.test(fm)
          ? ok(`skill.${skill.id}`, 'frontmatter name+description')
          : fail(`skill.${skill.id}`, 'SKILL.md needs YAML frontmatter with name and description'),
      );
    }
  }
  for (const item of m.prompts) {
    const file = join(pkg, item.path);
    if (!existsSync(file)) {
      checks.push(fail(`prompt.${item.id}.file`, `missing ${item.path}`));
      continue;
    }
    const { fm } = splitFrontmatter(readFileSync(file, 'utf8'));
    checks.push(
      item.description || /^description:/m.test(fm)
        ? ok(`prompt.${item.id}`, item.description ? 'description in upp.json' : 'frontmatter description')
        : fail(`prompt.${item.id}`, 'prompts/*.md needs frontmatter description: (or description in upp.json)'),
    );
  }
  for (const item of m.agents) {
    const file = join(pkg, item.path);
    if (!existsSync(file)) {
      checks.push(fail(`agent.${item.id}.file`, `missing ${item.path}`));
      continue;
    }
    const { fm } = splitFrontmatter(readFileSync(file, 'utf8'));
    const nameLine = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    checks.push(
      nameLine === item.id && /^description:/m.test(fm)
        ? ok(`agent.${item.id}`, 'frontmatter name+description')
        : fail(`agent.${item.id}`, `agents/${item.id}.md needs frontmatter "name: ${item.id}" and description`),
    );
    for (const skillRef of item.skills ?? []) {
      checks.push(
        m.skills.some((s) => s.id === skillRef.id)
          ? ok(`agent.${item.id}.skills`, skillRef.id)
          : fail(`agent.${item.id}.skills`, `unknown skill ${skillRef.id}`),
      );
    }
  }
  if (m.capabilities.includes('prompts')) {
    checks.push(m.prompts.length > 0 ? ok('capability.prompts', `${m.prompts.length} prompt(s)`) : fail('capability.prompts', 'no prompts/*.md found'));
  }
  if (m.capabilities.includes('agents')) {
    checks.push(m.agents.length > 0 ? ok('capability.agents', `${m.agents.length} agent(s)`) : fail('capability.agents', 'no agents/*.md found'));
  }
  if (!m.capabilities.includes('prompts') && m.prompts.length) {
    checks.push(fail('capability.prompts.undeclared', 'prompts/ exists but capability missing'));
  }
  if (!m.capabilities.includes('agents') && m.agents.length) {
    checks.push(fail('capability.agents.undeclared', 'agents/ exists but capability missing'));
  }
  if (m.i18n) {
    checks.push(
      /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(m.i18n.defaultLocale ?? '')
        ? ok('i18n.defaultLocale', m.i18n.defaultLocale)
        : fail('i18n.defaultLocale', 'missing or invalid defaultLocale'),
    );
    const entries = m.i18n.entries ?? {};
    const keys = Object.keys(entries);
    checks.push(keys.length > 0 ? ok('i18n.entries', `${keys.length} key(s)`) : fail('i18n.entries', 'no entries'));
    const leak = keys.filter((key) => entries[key] && Object.keys(entries[key]).includes(m.i18n.defaultLocale));
    checks.push(
      leak.length === 0
        ? ok('i18n.entries.locale', 'only non-default locales')
        : fail('i18n.entries.locale', `entries must not repeat defaultLocale: ${leak.join(',')}`),
    );
  }
  if (m.recommend) {
    const groups = Array.isArray(m.recommend) ? m.recommend : [];
    const bad = groups.filter((g) => !g?.title || !Array.isArray(g?.prompts) || g.prompts.some((pr) => !pr?.text));
    checks.push(
      groups.length > 0 && bad.length === 0
        ? ok('recommend', `${groups.length} group(s)`)
        : fail('recommend', 'must be [{title, prompts:[{text}]}]'),
    );
  }
  if (m.ui) {
    const ui = normalizeUi(m);
    checks.push(/^[a-z][a-z0-9-]{2,63}$/.test(ui.rendererId) ? ok('ui.rendererId', ui.rendererId) : fail('ui.rendererId', 'must be kebab-case'));
    checks.push(/^[a-z][a-z0-9-]{2,63}$/.test(ui.skillId) ? ok('ui.skillId', ui.skillId) : fail('ui.skillId', 'must be kebab-case'));
    const uiFile = join(pkg, ui.entry);
    if (!existsSync(uiFile)) {
      checks.push(fail('ui.entry', `missing ${ui.entry}`));
    } else {
      const html = readFileSync(uiFile, 'utf8');
      // Accio host reads `data.height` at TOP level and only then acks the handshake
      // (nested {data:{height}} renders the panel but ends in handshake_timeout).
      checks.push(/ui\/resize['"]\s*,\s*height\s*:/.test(html) ? ok('ui.entry.resize', 'ui/resize with top-level height') : fail('ui.entry.resize', 'entry HTML must postMessage {type:"ui/resize", height:<px>} (height top-level)'));
      checks.push(/ui\/ready/.test(html) ? ok('ui.entry.ready', 'ui/ready handshake') : fail('ui.entry.ready', 'entry HTML must postMessage ui/ready'));
      checks.push(/ui\/initialize/.test(html) ? ok('ui.entry.initialize', 'listens for ui/initialize') : fail('ui.entry.initialize', 'entry HTML must handle the host ui/initialize message'));
      if (/\b(?:src|href)\s*=\s*["']https?:/i.test(html)) checks.push(fail('ui.entry.remote', 'no remote scripts/styles (P2-1)'));
      if (/fetch\(\s*["']skill-app:\/\/app\//i.test(html)) checks.push(fail('ui.entry.shared-origin', 'must not fetch skill-app://app (shared origin, no CSP)'));
    }
    checks.push(m.capabilities.includes('ui') ? ok('capability.ui', ui.rendererId) : fail('capability.ui', 'ui block declared but capability missing'));
    if (ui.dsh) {
      checks.push(/^[A-Za-z0-9_.-]{3,80}$/.test(ui.slot) ? ok('ui.dsh.slot', ui.slot) : fail('ui.dsh.slot', 'invalid slot key'));
      checks.push(Number.isInteger(ui.order) ? ok('ui.dsh.order', String(ui.order)) : fail('ui.dsh.order', 'order must be an integer'));
    }
  } else if (m.capabilities.includes('ui')) {
    checks.push(fail('capability.ui.undeclared', 'capability ui without ui block'));
  }
  if ((m.hooks ?? []).length) {
    // P2 pilot: observe-only hooks on non-blocking events. PreToolUse/Stop stay P3.
    const allowed = ['SessionStart', 'SessionEnd', 'PostToolUse'];
    for (const hook of m.hooks) {
      checks.push(/^[a-z][a-z0-9-]{2,63}$/.test(hook.id ?? '') ? ok(`hook.${hook.id}`, 'id') : fail('hook.id', 'hook id must be kebab-case'));
      checks.push(allowed.includes(hook.event) ? ok(`hook.${hook.id}.event`, hook.event) : fail(`hook.${hook.id}.event`, `P2 pilot allows ${allowed.join('/')} only`));
      checks.push((hook.mode ?? 'observe') === 'observe' ? ok(`hook.${hook.id}.mode`, 'observe') : fail(`hook.${hook.id}.mode`, 'only observe mode is generated'));
      checks.push(hook.matcher ? ok(`hook.${hook.id}.matcher`, hook.matcher) : ok(`hook.${hook.id}.matcher`, 'omitted'));
      checks.push((hook.timeoutSeconds ?? 10) <= 60 ? ok(`hook.${hook.id}.timeout`, String(hook.timeoutSeconds ?? 10)) : fail(`hook.${hook.id}.timeout`, 'max 60s'));
    }
    checks.push(m.capabilities.includes('hooks') ? ok('capability.hooks', `${m.hooks.length} hook(s)`) : fail('capability.hooks', 'hooks declared but capability missing'));
  } else if (m.capabilities.includes('hooks')) {
    checks.push(fail('capability.hooks.undeclared', 'capability hooks without hooks[]'));
  }
  const perm = m.permissions;
  const minimal = perm.network !== true && perm.filesystem === 'none' && perm.shell !== true;
  checks.push(
    minimal
      ? ok('permissions.minimal', 'network=false, filesystem=none, shell=false')
      : ok('permissions.extended', JSON.stringify(perm)),
  );
  // Cost contract: the bytes a host must always keep in context (tool surface + skill index).
  const budget = Number(m.tokenBudget?.alwaysLoadedBytes ?? 2048);
  const toolSurface = readJson(join(pkg, m.runtime.manifest), {})?.tools ?? [];
  const toolBytes = Buffer.byteLength(
    JSON.stringify(toolSurface.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))),
  );
  let skillBytes = 0;
  for (const s of m.skills) {
    const fm = splitFrontmatter(readFileSync(join(pkg, s.path, 'SKILL.md'), 'utf8')).fm;
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1] ?? s.id;
    const description = /^description:\s*(.+)$/m.exec(fm)?.[1] ?? '';
    skillBytes += Buffer.byteLength(`${name}\n${description}\n`);
  }
  const alwaysBytes = toolBytes + skillBytes;
  checks.push(
    alwaysBytes <= budget
      ? ok('tokenBudget', `${alwaysBytes}/${budget} B always-loaded`)
      : fail('tokenBudget', `${alwaysBytes} B > tokenBudget.alwaysLoadedBytes ${budget} B`),
  );
  return checks;
}

// ---------------------------------------------------------------- generation
/** Normalise the optional `ui` block (Accio renderer skill; P1.4 pilot). */
function normalizeUi(m) {
  const ui = m.ui ?? {};
  return {
    rendererId: ui.rendererId ?? `${m.id}-panel`,
    skillId: ui.skillId ?? `${m.id}-panel`,
    title: ui.title ?? m.name,
    entry: ui.entry ?? 'ui/app/index.html',
    dsh: ui.dsh === true,
    slot: ui.slot ?? 'conversation.input.dock',
    order: Number.isInteger(ui.order) ? ui.order : 50,
  };
}

/** Accio reads `renderers` from SKILL.md frontmatter; generate that skill contract. */
function panelSkill(m, ui) {
  const lines = [
    '---',
    'name: ' + ui.skillId,
    'description: ' + yamlString(ui.title + ' - inline panel for ' + m.name),
    'renderers:',
    '  ' + ui.rendererId + ':',
    '    description: ' + yamlString(ui.title),
    '    app: app/index.html',
    '---',
    '',
    '# ' + ui.title,
    '',
    'Show the ' + m.name + ' panel inside Accio Work.',
    '',
    '1. Run `node scripts/show.mjs` once with the shell tool.',
    '2. If the host attaches a `:::slot[...]` instruction, echo that marker exactly as given.',
    '3. Never fetch `skill-app://` URLs yourself; the host owns the iframe.',
    '',
  ];
  return lines.join('\n');
}

/** One JSON line with a slot object; the host turns it into `:::slot[...]`. */
function showScript(m, ui) {
  return [
    '#!/usr/bin/env node',
    '// UPP panel slot emitter (generated by upp build). Local only; never touches the network.',
    'const payload = { plugin: ' + JSON.stringify(m.id) + ', name: ' + JSON.stringify(m.name) + ', version: ' + JSON.stringify(m.version) + ' };',
    'const slot = { skillId: ' + JSON.stringify(ui.skillId) + ', renderer: ' + JSON.stringify(ui.rendererId) + ', payload };',
    'process.stdout.write(JSON.stringify({ success: true, data: "UPP panel: " + payload.name + " " + payload.version, slot }) + "\\n");',
    '',
  ].join('\n');
}

/** WorkBuddy hook schema: { hooks: { <Event>: [{ matcher?, hooks: [{type,command,timeout}] }] } }. */
function dshHostHalf() {
  return '/** Host half generated by UPP; rendering lives in client.js. */\nexport function apply() {}\n';
}

/** Client half for DSH: classic script, no import/export, registered via __ModuleLoader__. */
function dshClientScript(m, ui, packageName) {
  const esc = (v) => String(v).replaceAll("'", "\\'");
  const title = esc(ui.title);
  const label = esc(m.name);
  return `// Generated by UPP: DSH client bundle (classic script, no import/export).
window.__ModuleLoader__.load({
  id: '${packageName}',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function UppPanel() {
      return h('div', {
        'data-upp-panel': '${ui.skillId}',
        title: '${title}',
        style: { display: 'flex', flexDirection: 'column', gap: 3, width: '100%',
          padding: '9px 12px', borderRadius: 10,
          border: '1px solid var(--dsh-border, #d5dae2)',
          background: 'var(--dsh-surface-raised, #f7f9fc)',
          fontSize: 12, color: 'var(--dsh-text, #1f2329)', lineHeight: 1.45 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('strong', { style: { fontSize: 12.5 } }, '${label}'),
          h('span', { style: { fontSize: 10, color: '#247bbf', border: '1px solid #247bbf',
            borderRadius: 999, padding: '0 6px' } }, 'UPP · ui panel'),
        ),
        h('div', { style: { fontSize: 11, opacity: 0.75 } },
          'Rendered by the DSH client bundle generated from upp.json (slot: ${ui.slot}).',
        ),
      );
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('${ui.slot}', () => ctx.slots.register({
          name: '${ui.slot}', id: '${ui.skillId}', order: ${ui.order},
        }, UppPanel));
      },
    };
  },
});
`;
}

function hookConfig(m) {
  const events = {};
  for (const hook of m.hooks ?? []) {
    const entry = {
      hooks: [
        {
          type: 'command',
          command: 'node "${CODEBUDDY_PLUGIN_ROOT}/hooks/scripts/' + hook.id + '.mjs"',
          timeout: hook.timeoutSeconds ?? 10,
        },
      ],
    };
    if (hook.matcher) entry.matcher = hook.matcher;
    events[hook.event] ??= [];
    events[hook.event].push(entry);
  }
  return { hooks: events };
}

/** Observe-only hook body: append one JSON line, always exit 0, never write stdout. */
function hookScript(hook) {
  return [
    '#!/usr/bin/env node',
    '// UPP observe hook (' + hook.id + ' on ' + hook.event + '). Always exit 0, never writes stdout.',
    "import { appendFileSync, mkdirSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  try {',
    "    const dir = process.env.CODEBUDDY_PLUGIN_DATA || process.env.TMPDIR || '.';",
    "    const file = join(dir, 'upp-hooks.log');",
    '    mkdirSync(dirname(file), { recursive: true });',
    '    const line = { hook: ' + JSON.stringify(hook.id) + ', event: ' + JSON.stringify(hook.event) + ', at: new Date().toISOString(), bytes: input.length };',
    '    appendFileSync(file, JSON.stringify(line) + "\\n");',
    '  } catch {',
    '    // observe-only hooks must never break the host',
    '  }',
    '  process.exit(0);',
    '});',
    'setTimeout(() => process.exit(0), 2000).unref();',
    '',
  ].join('\n');
}

function generate(pkg, m, { check = false } = {}) {
  const writes = [];
  const plan = (file, text) => writes.push({ file, text });

  plan(
    join(pkg, m.runtime.manifest),
    `${JSON.stringify({ serverName: m.serverName, version: m.version, tools: m.tools ?? readJson(join(pkg, m.runtime.manifest), {}).tools ?? [] }, null, 2)}\n`,
  );

  const p1 = { prompts: m.prompts ?? [], agents: m.agents ?? [], i18n: m.i18n ?? null, recommend: m.recommend ?? null };
  const defaultLocale = p1.i18n?.defaultLocale ?? 'en';
  const i18nEntry = (key) => p1.i18n?.entries?.[key] ?? {};
  const displayName = p1.i18n ? { [defaultLocale]: m.name, ...i18nEntry('plugin.displayName') } : m.name;
  const displayDescription = p1.i18n ? { [defaultLocale]: m.description, ...i18nEntry('plugin.description') } : m.description;
  const plugin = {
    name: m.id,
    displayName,
    version: m.version,
    description: m.description,
    author: typeof m.author === 'string' ? { name: m.author } : (m.author ?? { name: 'UPP' }),
    category: m.category ?? 'devtools',
    tags: m.tags ?? ['upp'],
  };

  // Accio reads a root plugin.json (checked before .claude-plugin/plugin.json).
  const accioPlugin = { ...plugin };
  if (p1.agents.length) {
    accioPlugin.subAgents = p1.agents.map((a) => ({
      id: a.id,
      description: a.description,
      systemPromptFile: `subagents/${a.id}/prompt.md`,
      tools: a.tools ?? 'inherit',
      ...(a.skills ? { skills: a.skills } : {}),
      ...(a.timeoutSeconds ? { timeoutSeconds: a.timeoutSeconds } : {}),
    }));
  }
  if (m.license) accioPlugin.license = m.license;
  plan(join(pkg, 'plugin.json'), `${JSON.stringify(accioPlugin, null, 2)}\n`);
  plan(join(pkg, '.claude-plugin', 'plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`);

  const ui = m.ui ? normalizeUi(m) : null;
  const hooks = m.hooks ?? [];
  const packageName = readJson(join(pkg, 'package.json'), null)?.name ?? m.hosts.dsh.packageName;

  // WorkBuddy contribution points: commands/ (from prompts/) and agents/ (authored .md).
  const wbPlugin = {
    name: m.id,
    displayName: typeof displayName === 'string' ? displayName : m.name,
    version: m.version,
    description: m.description,
    ...(p1.i18n ? { displayDescription } : {}),
    ...(m.skills.length ? { skills: './skills' } : {}),
    ...(p1.prompts.length ? { commands: './commands' } : {}),
    ...(p1.agents.length ? { agents: p1.agents.map((a) => `./agents/${a.id}.md`) } : {}),
    ...(hooks.length ? { hooks: './hooks/hooks.json' } : {}),
  };
  if (typeof plugin.author === 'object' && plugin.author.name) wbPlugin.author = plugin.author;
  plan(join(pkg, '.codebuddy-plugin', 'plugin.json'), `${JSON.stringify(wbPlugin, null, 2)}\n`);

  // Command files (WorkBuddy): description + argument-hint + body, $ARGUMENTS for user input.
  for (const item of p1.prompts) {
    const { fm, body } = splitFrontmatter(readFileSync(join(pkg, item.path), 'utf8'));
    const description = item.description ?? fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? m.description;
    const hint = item.argumentHint ?? fm.match(/^argument-hint:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const lines = [`description: ${yamlString(description)}`];
    if (hint) lines.push(`argument-hint: ${yamlString(hint)}`);
    const text = body.trimEnd();
    const withArgs = /\$ARGUMENTS|\$1/.test(text) ? text : `${text}\n\n$ARGUMENTS`;
    plan(join(pkg, 'commands', `${item.id}.md`), `---\n${lines.join('\n')}\n---\n\n${withArgs}\n`);
  }

  // Accio subagent prompts: subagents/<id>/prompt.md (dual confirmation with subAgents[]).
  for (const item of p1.agents) {
    const { body } = splitFrontmatter(readFileSync(join(pkg, item.path), 'utf8'));
    plan(join(pkg, 'subagents', item.id, 'prompt.md'), body.trimStart());
  }

  if (p1.i18n) {
    plan(
      join(pkg, 'resources', 'i18n.json'),
      `${JSON.stringify({ version: '1.0', defaultLocale, entries: p1.i18n.entries ?? {} }, null, 2)}\n`,
    );
  }
  if (p1.recommend) {
    plan(join(pkg, 'resources', 'recommend.json'), `${JSON.stringify(p1.recommend, null, 2)}\n`);
  }
  if (ui) {
    plan(join(pkg, 'skills', ui.skillId, 'app', 'index.html'), readFileSync(join(pkg, ui.entry), 'utf8'));
    plan(join(pkg, 'skills', ui.skillId, 'scripts', 'show.mjs'), showScript(m, ui));
    plan(join(pkg, 'skills', ui.skillId, 'SKILL.md'), panelSkill(m, ui));
    if (ui.dsh) {
      plan(join(pkg, 'index.js'), dshHostHalf());
      plan(join(pkg, 'client.js'), dshClientScript(m, ui, packageName));
    }
  }
  if (hooks.length) {
    plan(join(pkg, 'hooks', 'hooks.json'), `${JSON.stringify(hookConfig(m), null, 2)}\n`);
    for (const hook of hooks) plan(join(pkg, 'hooks', 'scripts', `${hook.id}.mjs`), hookScript(hook));
  }

  plan(
    join(pkg, '.mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          [m.serverName]: {
            command: 'node',
            args: [`\${CODEBUDDY_PLUGIN_ROOT}/${m.runtime.entry.replaceAll('\\', '/')}`],
            env: { UPP_HOST: 'workbuddy' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const cliId = m.clis?.[0]?.id ?? m.serverName;
  plan(
    join(pkg, 'clis', 'clis.json'),
    `${JSON.stringify(
      {
        tools: [
          {
            id: cliId,
            displayName: `${m.name} CLI`,
            description: `Call ${m.name} from a shell (UPP CLI channel).`,
            verifyArgs: ['--info'],
            usageExamples: [`node ${m.runtime.entry.replaceAll('\\', '/')} --cli ${(m.tools ?? [])[0]?.name ?? 'tool'} --json '{}'`],
            exposure: 'all-agents',
            source: {
              type: 'node-cli',
              entry: m.runtime.entry.replaceAll('\\', '/'),
              commandName: cliId,
              moduleFormat: 'esm',
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const pkgJson = {
    name: packageName,
    version: m.version,
    private: true,
    type: 'module',
    description: `UPP bundle for DeepSeek Harness (${ui?.dsh ? 'host + client UI bundle' : 'config-only MCP bundle'}).`,
    ...(ui?.dsh ? { exports: { '.': './index.js', './client': './client.js' } } : {}),
    files: ['cordis.patch.yml', m.runtime.manifest, m.runtime.entry, ...(ui?.dsh ? ['index.js', 'client.js'] : [])].map((p) => p.replaceAll('\\', '/')),
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...(ui?.dsh ? { client: { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-conversation'] } } : {}),
    },
  };
  plan(join(pkg, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`);

  const tplPath = join(pkg, 'cordis.patch.yml.tpl');
  if (ui?.dsh) {
    const absEntry = join(pkg, m.runtime.entry).replaceAll('\\', '/');
    const patch = [
      '# Generated by UPP: DSH UI bundle (host half + client half) plus the MCP row.',
      '- insert:',
      `    - id: ${m.id}-ui`,
      `      name: '${packageName}'`,
      '- insert:',
      `    - id: ${m.serverName}-mcp`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      `        serverName: ${m.serverName}`,
      '        transport: stdio',
      '        command: node',
      `        args: ['${absEntry}']`,
      '        env:',
      '          UPP_HOST: dsh',
      '        failOnStartupError: false',
      '        toolCallTimeoutMs: 60000',
      '',
    ].join('\n');
    plan(join(pkg, 'cordis.patch.yml'), patch);
  } else if (existsSync(tplPath)) {
    const patch = readFileSync(tplPath, 'utf8')
      .replaceAll('__UPP_SERVER_NAME__', m.serverName)
      .replaceAll('__UPP_PACKAGE_NAME__', pkgJson.name)
      .replaceAll('__UPP_RUNTIME_ENTRY__', join(pkg, m.runtime.entry).replaceAll('\\', '/'));
    plan(join(pkg, 'cordis.patch.yml'), patch);
  } else if (!existsSync(join(pkg, 'cordis.patch.yml'))) {
    throw new Error(`package ${pkg} has neither cordis.patch.yml.tpl nor cordis.patch.yml`);
  }

  const drift = [];
  // Machine-local outputs embed absolute paths (or host credentials): they are
  // regenerated per install and must never be treated as source drift.
  const MACHINE_LOCAL = new Set(['cordis.patch.yml', '.upp-accio-mcp.json']);
  for (const { file, text } of writes) {
    const rel = relative(pkg, file).split(sep).join('/');
    if (MACHINE_LOCAL.has(rel)) continue;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current !== text) drift.push(rel);
  }
  if (!check) for (const { file, text } of writes) writeText(file, text);
  return { files: writes.map((w) => relative(pkg, w.file)), drift };
}

// ------------------------------------------------------------------- hosts
function detectHosts() {
  const profileDir = process.env.DSH_PROFILE_DIR || join(HOME, '.dsh', 'profiles', 'desktop');
  const dshHome = process.env.DSH_HOME || join(HOME, '.dsh');
  const accioAccounts = join(HOME, '.accio', 'accounts');
  let accioAccount = process.env.UPP_ACCIO_ACCOUNT;
  if (!accioAccount && existsSync(accioAccounts)) {
    accioAccount = readdirSync(accioAccounts).find((d) => /^\d+$/.test(d));
  }
  return {
    dsh: {
      id: 'dsh',
      available: existsSync(profileDir),
      profileDir,
      dshHome,
      cli: DSH_CLI,
    },
    workbuddy: {
      id: 'workbuddy',
      available: existsSync(join(HOME, '.workbuddy')) || existsSync(join(HOME, '.codebuddy')),
      skillsDir: join(HOME, '.workbuddy', 'skills'),
      mcpConfig: join(HOME, '.codebuddy', 'mcp.json'),
      // CodeBuddy plugin system (WorkBuddy is a CodeBuddy fork): a local "directory"
      // marketplace + installed_plugins.json + enabledPlugins is the whole install.
      pluginsDir: join(HOME, '.workbuddy', 'plugins'),
      knownMarketplaces: join(HOME, '.workbuddy', 'plugins', 'known_marketplaces.json'),
      installedPlugins: join(HOME, '.workbuddy', 'plugins', 'installed_plugins.json'),
      settingsFiles: [join(HOME, '.workbuddy', 'settings.json'), join(HOME, '.codebuddy', 'settings.json')],
      cli: WB_CLI,
    },
    accio: {
      id: 'accio',
      available: Boolean(accioAccount) && existsSync(join(accioAccounts, accioAccount)),
      accountDir: accioAccount ? join(accioAccounts, accioAccount) : null,
      skillsDir: accioAccount ? join(accioAccounts, accioAccount, 'skills') : null,
      skillsConfig: accioAccount ? join(accioAccounts, accioAccount, 'skills', 'skills_config.json') : null,
      cli: ACCIO_CLI,
    },
  };
}

/**
 * Run `dsh plugin --profile <name> install`. On Windows the CLI is a .cmd shim
 * under a path with spaces, so it must go through ComSpec with the executable
 * quoted — passing an argv array with shell:true mangles the path.
 */
function runDshCli(profileName) {
  const cmd = `"${DSH_CLI}" plugin --profile ${profileName} install`;
  const opts = { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 };
  return spawnSync(cmd, { ...opts, shell: true });
}

/**
 * Register a config-only bundle in a DSH profile without the agent tool:
 * profile package.json gets a `link:<pkg>` dependency plus a dsh.profile.bundles
 * entry, then `dsh plugin --profile <name> install` materializes node_modules.
 * The running app picks the bundle up on its next boot (no hand-edited YAML).
 */
function dshRegister(pkg, hosts, m) {
  const name = m.hosts.dsh.packageName;
  const profileDir = hosts.dsh.profileDir;
  const profileName = basename(profileDir);
  const pkgJsonPath = join(profileDir, 'package.json');
  const pkgJson = readJson(pkgJsonPath, null);
  if (!pkgJson) return { ok: false, detail: `profile package.json missing: ${pkgJsonPath}` };
  const link = `link:${pkg.replaceAll('\\', '/')}`;
  pkgJson.dependencies ??= {};
  const changed = pkgJson.dependencies[name] !== link;
  pkgJson.dependencies[name] = link;
  pkgJson.dsh ??= {};
  pkgJson.dsh.profile ??= {};
  pkgJson.dsh.profile.bundles ??= [];
  if (!pkgJson.dsh.profile.bundles.includes(name)) pkgJson.dsh.profile.bundles.push(name);
  backupOnce(pkgJsonPath);
  writeJson(pkgJsonPath, pkgJson);
  if (!existsSync(hosts.dsh.cli)) {
    return { ok: false, detail: `dsh CLI not found at ${hosts.dsh.cli}; run pnpm install in ${profileDir}`, profileName, name, changed };
  }
  const res = runDshCli(profileName);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return {
    ok: res.status === 0,
    detail: output.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 500),
    profileName,
    name,
    changed,
  };
}

function installDsh(pkg, hosts, m, record) {
  const patchPath = join(pkg, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return { host: 'dsh', ok: false, checks: [fail('dsh.patch', 'run build first')] };
  const reg = dshRegister(pkg, hosts, m);
  // DSH's MCP client comes from the bundle, but its skill scanner does not walk into
  // bundle packages. Mirror skills into the DSH user skill root so the model sees them.
  const skillRoot = join(process.env.DSH_HOME ?? join(HOME, '.dsh'), 'skills');
  const installedSkills = [];
  for (const skill of m.skills) {
    const dest = join(skillRoot, skill.id);
    copyDir(join(pkg, skill.path), dest);
    installedSkills.push(dest);
  }
  // P1 degradation: DSH bundles cannot contribute commands/agents, so prompts and
  // agents are mirrored as skill directories (name-addressable, always loaded cheap).
  const mirrored = [];
  const mirrorMarkdownSkill = (id, description, body) => {
    const dest = join(skillRoot, id);
    mkdirSync(dest, { recursive: true });
    writeText(join(dest, 'SKILL.md'), `---\nname: ${id}\ndescription: ${yamlString(description)}\n---\n\n${body.trim()}\n`);
    mirrored.push(dest);
  };
  for (const item of m.prompts ?? []) {
    const { body } = splitFrontmatter(readFileSync(join(pkg, item.path), 'utf8'));
    mirrorMarkdownSkill(`${m.id}-prompt-${item.id}`, item.description ?? m.description, body);
  }
  for (const item of m.agents ?? []) {
    const { body } = splitFrontmatter(readFileSync(join(pkg, item.path), 'utf8'));
    mirrorMarkdownSkill(`${m.id}-agent-${item.id}`, item.description ?? m.description, body);
  }
  record.dsh = {
    bundle: pkg,
    packageName: m.hosts.dsh.packageName,
    patchPath,
    entry: join(pkg, m.runtime.entry),
    profileDir: hosts.dsh.profileDir,
    skills: installedSkills,
    skillsP1: mirrored,
    installedVia: 'upp install (profile dependency link + dsh plugin install + skill mirror)',
  };
  return {
    host: 'dsh',
    ok: reg.ok,
    checks: [
      ok('dsh.bundle.prepared', patchPath),
      ...installedSkills.map((d) => ok('dsh.skill', d)),
      ...mirrored.map((d) => ok('dsh.skillMirror', d)),
      reg.ok ? ok('dsh.profile.registered', `${reg.name} -> ${reg.profileName}`) : fail('dsh.profile.registered', reg.detail),
    ],
    next: reg.ok
      ? 'DeepSeek Harness loads the MCP server on its next boot; skill/tool use then needs no extra step'
      : `fallback: plugin_manager({action:"install_bundle", target:"${pkg}"})`,
  };
}

const UPP_MARKETPLACE = 'upp-local';

/**
 * Install the same package as a native CodeBuddy/WorkBuddy plugin. The host reads a
 * "directory" marketplace (.codebuddy-plugin/marketplace.json + plugins/<id>/) plus
 * installed_plugins.json and enabledPlugins in settings.json; writing those four
 * files is equivalent to the two UI clicks, so the plugin needs no marketplace upload.
 * Commands/agents/skills then behave exactly like a marketplace-installed plugin.
 */
function installWorkBuddyPlugin(pkg, hosts, m) {
  if (!hosts.workbuddy.pluginsDir) return null;
  const marketplaceDir = join(hosts.workbuddy.pluginsDir, 'marketplaces', UPP_MARKETPLACE);
  const pluginDir = join(marketplaceDir, 'plugins', m.id);
  rmSync(pluginDir, { recursive: true, force: true });
  for (const rel of ['.codebuddy-plugin', 'skills', 'commands', 'agents', 'hooks', '.mcp.json', 'plugin.json', 'runtime', 'resources', 'clis']) {
    const src = join(pkg, rel);
    if (!existsSync(src)) continue;
    const dest = join(pluginDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
  const mfPath = join(marketplaceDir, '.codebuddy-plugin', 'marketplace.json');
  const mf = readJson(mfPath, { name: UPP_MARKETPLACE, description: 'UPP local marketplace (generated by upp CLI)', plugins: [] });
  mf.name ??= UPP_MARKETPLACE;
  mf.plugins = (mf.plugins ?? []).filter((p) => p.name !== m.id);
  mf.plugins.push({ name: m.id, version: m.version, source: `./plugins/${m.id}`, description: m.description });
  writeJson(mfPath, mf);

  const known = readJson(hosts.workbuddy.knownMarketplaces, {});
  known[UPP_MARKETPLACE] = {
    manifestName: UPP_MARKETPLACE,
    type: 'directory',
    source: { source: 'directory', path: marketplaceDir },
    installLocation: marketplaceDir,
    description: 'UPP local marketplace (generated by upp CLI)',
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
    isBuiltIn: false,
  };
  writeJson(hosts.workbuddy.knownMarketplaces, known);

  const key = `${m.id}@${UPP_MARKETPLACE}`;
  const installed = readJson(hosts.workbuddy.installedPlugins, { version: 2, plugins: {} });
  installed.version ??= 2;
  installed.plugins ??= {};
  const now = new Date().toISOString();
  installed.plugins[key] = [{ scope: 'user', installPath: pluginDir, version: m.version, installedAt: now, lastUpdated: now }];
  writeJson(hosts.workbuddy.installedPlugins, installed);

  for (const file of hosts.workbuddy.settingsFiles ?? []) {
    const s = readJson(file, {});
    s.enabledPlugins ??= {};
    s.enabledPlugins[key] = true;
    writeJson(file, s);
  }
  return { marketplaceDir, pluginDir, key };
}

function installWorkBuddy(pkg, hosts, m, record) {
  const installed = [];
  for (const skill of m.skills) {
    const dest = join(hosts.workbuddy.skillsDir, skill.id);
    copyDir(join(pkg, skill.path), dest);
    installed.push(dest);
  }
  const mcp = readJson(hosts.workbuddy.mcpConfig, { mcpServers: {} });
  mcp.mcpServers ??= {};
  mcp.mcpServers[m.serverName] = {
    command: 'node',
    args: [join(pkg, m.runtime.entry)],
    env: { UPP_HOST: 'workbuddy' },
  };
  writeJson(hosts.workbuddy.mcpConfig, mcp);
  const plugin = installWorkBuddyPlugin(pkg, hosts, m);
  record.workbuddy = {
    skills: installed,
    mcpConfig: hosts.workbuddy.mcpConfig,
    serverName: m.serverName,
    plugin,
  };
  const checks = [...installed.map((d) => ok('workbuddy.skill', d)), ok('workbuddy.mcp', `${hosts.workbuddy.mcpConfig}#${m.serverName}`)];
  if (plugin) checks.push(ok('workbuddy.plugin', `${plugin.key} -> ${plugin.pluginDir}`));
  return {
    host: 'workbuddy',
    ok: true,
    checks,
    note: 'Skills hot-reload (~3s); plugin/commands/agents land in a local directory marketplace; MCP is read from mcp.json.',
  };
}

// Accio's Gateway is protected by HTTP basic auth. The CLI gets the token from the
// app environment, but a standalone installer can read the same credentials the app
// writes for its own CLI: <account>/.accio/runtime/gateway-cli.json. This is what makes
// MCP registration a zero-step operation instead of "paste this command into Accio".
function accioGatewayAuth(hosts) {
  const accountDir = hosts?.accio?.accountDir;
  if (!accountDir) return null;
  const file = join(accountDir, '.accio', 'runtime', 'gateway-cli.json');
  if (!existsSync(file)) return null;
  const cfg = readJson(file, {});
  if (!cfg?.password) return null;
  const url = cfg.url ?? 'http://localhost:4097';
  return {
    file,
    url,
    env: {
      ...process.env,
      ACCIO_GATEWAY_TOKEN: cfg.password,
      ACCIO_GATEWAY_USERNAME: cfg.username ?? 'phoenix',
      ACCIO_LOCAL_GATEWAY_URL: url,
    },
  };
}

async function installAccio(pkg, hosts, m, record) {
  if (!hosts.accio.available) return { host: 'accio', ok: false, checks: [fail('accio.account', 'no Accio account found')] };
  const installed = [];
  for (const skill of m.skills) {
    const dest = join(hosts.accio.skillsDir, skill.id);
    copyDir(join(pkg, skill.path), dest);
    installed.push(dest);
  }
  const cfg = readJson(hosts.accio.skillsConfig, {});
  for (const skill of m.skills) {
    cfg[skill.id] = { enabled: true, status: 'installed', installedVersion: m.version };
  }
  writeJson(hosts.accio.skillsConfig, cfg);

  const payload = {
    mcpServers: {
      [m.serverName]: { command: 'node', args: [join(pkg, m.runtime.entry)], env: { UPP_HOST: 'accio' } },
    },
  };
  const payloadPath = join(pkg, '.upp-accio-mcp.json');
  writeJson(payloadPath, payload);

  // If Accio is running, its Gateway (127.0.0.1:4097) is the only writer for MCP
  // config — so register automatically instead of asking the user to paste a command.
  let auto = null;
  const auth = accioGatewayAuth(hosts);
  const gateway = await probeTcp(4097);
  if (gateway && existsSync(hosts.accio.cli)) {
    const res = spawnSync(process.execPath, [hosts.accio.cli, 'server', 'add', '--json-file', payloadPath], {
      encoding: 'utf8',
      timeout: 60000,
      env: auth?.env ?? process.env,
    });
    auto = { ok: res.status === 0, detail: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().slice(0, 500) };
    // Re-installing over an existing registration returns 409 "already exists";
    // the idempotent path is `server update <name> --json-file`.
    if (!auto.ok && /40[1-9]|already exists|conflict/i.test(auto.detail)) {
      const up = spawnSync(process.execPath, [hosts.accio.cli, 'server', 'update', m.serverName, '--json-file', payloadPath], {
        encoding: 'utf8',
        timeout: 60000,
        env: auth?.env ?? process.env,
      });
      auto = { ok: up.status === 0, detail: `${up.stdout ?? ''}${up.stderr ?? ''}`.trim().slice(0, 500) };
    }
    if (auto.ok && auth) {
      const t = spawnSync(process.execPath, [hosts.accio.cli, 'server', 'test', m.serverName], {
        encoding: 'utf8',
        timeout: 60000,
        env: auth.env,
      });
      auto.detail = `${auto.detail} | test: ${`${t.stdout ?? ''}${t.stderr ?? ''}`.trim().slice(0, 200)}`;
      auto.ok = t.status === 0;
    }
  }

  record.accio = { skills: installed, skillsConfig: hosts.accio.skillsConfig, mcpPayload: payloadPath, serverName: m.serverName, registered: Boolean(auto?.ok) };
  const checks = [...installed.map((d) => ok('accio.skill', d)), ok('accio.skills_config', hosts.accio.skillsConfig)];
  if (auto) {
    checks.push(auto.ok ? ok('accio.mcp.registered', auto.detail) : fail('accio.mcp.registered', auto.detail));
  }
  return {
    host: 'accio',
    ok: true,
    checks,
    next: auto?.ok
      ? 'MCP registered through the running Accio Gateway'
      : `Start Accio, then run inside it: node "${hosts.accio.cli}" server add --json-file "${payloadPath}"`,
  };
}

function verifyDsh(pkg, hosts, m) {
  const checks = [];
  const name = m.hosts.dsh.packageName;
  const skillRoot = join(process.env.DSH_HOME ?? join(HOME, '.dsh'), 'skills');
  for (const skill of m.skills) {
    const file = join(skillRoot, skill.id, 'SKILL.md');
    checks.push(existsSync(file) ? ok('dsh.skill', file) : fail('dsh.skill', `missing ${file} (run install --hosts dsh)`));
  }
  for (const item of m.prompts ?? []) {
    const file = join(skillRoot, `${m.id}-prompt-${item.id}`, 'SKILL.md');
    checks.push(existsSync(file) ? ok('dsh.skillMirror', file) : fail('dsh.skillMirror', `missing ${file} (prompt mirror)`));
  }
  for (const item of m.agents ?? []) {
    const file = join(skillRoot, `${m.id}-agent-${item.id}`, 'SKILL.md');
    checks.push(existsSync(file) ? ok('dsh.skillMirror', file) : fail('dsh.skillMirror', `missing ${file} (agent mirror)`));
  }
  const pkgJson = readJson(join(hosts.dsh.profileDir, 'package.json'), {});
  checks.push(
    pkgJson?.dependencies?.[name]
      ? ok('dsh.dependency', `${name}@${pkgJson.dependencies[name]}`)
      : fail('dsh.dependency', `${name} missing in profile package.json`),
  );
  checks.push(
    (pkgJson?.dsh?.profile?.bundles ?? []).includes(name)
      ? ok('dsh.bundles', name)
      : fail('dsh.bundles', `${name} missing in dsh.profile.bundles`),
  );
  const installedDir = join(hosts.dsh.profileDir, 'node_modules', ...name.split('/'));
  const patchPath = join(installedDir, 'cordis.patch.yml');
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  checks.push(
    patch.includes('dsh-mcp-client') && patch.includes(m.serverName)
      ? ok('dsh.bundle.patch', patchPath)
      : fail('dsh.bundle.patch', `no mcp-client row for ${m.serverName}`),
  );
  checks.push(
    /__UPP_/.test(patch) ? fail('dsh.patch.entry', 'placeholder not substituted') : ok('dsh.patch.entry', 'substituted'),
  );
  const liveEntry = /args:\s*\['([^']+)'\]/.exec(patch)?.[1];
  checks.push(
    liveEntry && existsSync(liveEntry) ? ok('dsh.live.entry', liveEntry) : fail('dsh.live.entry', `runtime not found from patch: ${liveEntry}`),
  );
  checks.push(existsSync(installedDir) ? ok('dsh.node_modules', installedDir) : fail('dsh.node_modules', `missing ${installedDir}`));
  if (m.ui?.dsh) {
    const instPkg = readJson(join(installedDir, 'package.json'), {});
    checks.push(instPkg?.dsh?.client?.platform === 'web' ? ok('dsh.ui.client', 'dsh.client.platform=web') : fail('dsh.ui.client', 'dsh.client missing in installed package.json'));
    checks.push(instPkg?.exports?.['./client'] ? ok('dsh.ui.exports', instPkg.exports['./client']) : fail('dsh.ui.exports', 'exports["./client"] missing'));
    checks.push(existsSync(join(installedDir, 'index.js')) ? ok('dsh.ui.index', 'index.js') : fail('dsh.ui.index', 'missing index.js (host half)'));
    checks.push(existsSync(join(installedDir, 'client.js')) ? ok('dsh.ui.bundle', 'client.js') : fail('dsh.ui.bundle', 'missing client.js (client half)'));
    const uiPatchPath = join(installedDir, 'cordis.patch.yml');
    const uiPatch = existsSync(uiPatchPath) ? readFileSync(uiPatchPath, 'utf8') : '';
    checks.push(uiPatch.includes(`name: '${name}'`) ? ok('dsh.ui.row', `${name} self row`) : fail('dsh.ui.row', 'bundle row missing in patch'));
  }
  return checks;
}

function verifyWorkBuddy(hosts, m) {
  const checks = [];
  for (const skill of m.skills) {
    const file = join(hosts.workbuddy.skillsDir, skill.id, 'SKILL.md');
    checks.push(existsSync(file) ? ok('workbuddy.skill', file) : fail('workbuddy.skill', `missing ${file}`));
  }
  const mcp = readJson(hosts.workbuddy.mcpConfig, {});
  const server = mcp?.mcpServers?.[m.serverName];
  checks.push(server ? ok('workbuddy.mcp', `${m.serverName} -> ${server.command} ${(server.args ?? []).join(' ')}`) : fail('workbuddy.mcp', `${m.serverName} missing`));
  const entry = server?.args?.[0];
  checks.push(entry && existsSync(entry) ? ok('workbuddy.mcp.entry', entry) : fail('workbuddy.mcp.entry', `runtime missing: ${entry}`));

  // Native plugin (P1 contribution points: commands/agents/skills via .codebuddy-plugin).
  const marketplaceDir = join(hosts.workbuddy.pluginsDir, 'marketplaces', UPP_MARKETPLACE);
  const pluginDir = join(marketplaceDir, 'plugins', m.id);
  const key = `${m.id}@${UPP_MARKETPLACE}`;
  const manifest = join(pluginDir, '.codebuddy-plugin', 'plugin.json');
  checks.push(existsSync(manifest) ? ok('workbuddy.plugin.manifest', manifest) : fail('workbuddy.plugin.manifest', `missing ${manifest}`));
  const installed = readJson(hosts.workbuddy.installedPlugins, { plugins: {} });
  const rec = installed?.plugins?.[key]?.[0];
  checks.push(
    rec && resolve(rec.installPath) === resolve(pluginDir)
      ? ok('workbuddy.plugin.installed', `${key} v${rec.version}`)
      : fail('workbuddy.plugin.installed', `${key} not in installed_plugins.json`),
  );
  const enabled = (hosts.workbuddy.settingsFiles ?? []).some((f) => readJson(f, {})?.enabledPlugins?.[key] === true);
  checks.push(enabled ? ok('workbuddy.plugin.enabled', key) : fail('workbuddy.plugin.enabled', `enabledPlugins[${key}] not true`));
  for (const item of m.prompts ?? []) {
    const file = join(pluginDir, 'commands', `${item.id}.md`);
    checks.push(existsSync(file) ? ok('workbuddy.command', file) : fail('workbuddy.command', `missing ${file}`));
  }
  for (const item of m.agents ?? []) {
    const file = join(pluginDir, 'agents', `${item.id}.md`);
    checks.push(existsSync(file) ? ok('workbuddy.agent', file) : fail('workbuddy.agent', `missing ${file}`));
  }
  if ((m.hooks ?? []).length) {
    const hooksFile = join(pluginDir, 'hooks', 'hooks.json');
    checks.push(existsSync(hooksFile) ? ok('workbuddy.hooks', hooksFile) : fail('workbuddy.hooks', `missing ${hooksFile}`));
    const wb = readJson(manifest, {});
    checks.push(wb.hooks === './hooks/hooks.json' ? ok('workbuddy.hooks.manifest', wb.hooks) : fail('workbuddy.hooks.manifest', 'plugin.json hooks field missing'));
  }
  return checks;
}

function verifyAccio(hosts, m) {
  const checks = [];
  if (!hosts.accio.available) return [fail('accio.account', 'no Accio account')];
  const cfg = readJson(hosts.accio.skillsConfig, {});
  for (const skill of m.skills) {
    const file = join(hosts.accio.skillsDir, skill.id, 'SKILL.md');
    checks.push(existsSync(file) ? ok('accio.skill', file) : fail('accio.skill', `missing ${file}`));
    checks.push(
      cfg?.[skill.id]?.enabled === true
        ? ok('accio.skills_config', JSON.stringify(cfg[skill.id]))
        : fail('accio.skills_config', `${skill.id} entry missing or disabled`),
    );
  }
  if (m.ui) {
    const ui = normalizeUi(m);
    const file = join(hosts.accio.skillsDir, ui.skillId, 'SKILL.md');
    checks.push(existsSync(file) ? ok('accio.ui', file) : fail('accio.ui', 'renderer skill not installed'));
    if (existsSync(file)) {
      checks.push(/renderers:/.test(readFileSync(file, 'utf8')) ? ok('accio.ui.renderer', ui.rendererId) : fail('accio.ui.renderer', 'frontmatter renderers missing'));
    }
  }
  const payload = join(m.pkgDir ?? '', '.upp-accio-mcp.json');
  checks.push(existsSync(payload) ? ok('accio.mcp.payload', payload) : fail('accio.mcp.payload', 'run install first'));
  return checks;
}

// -------------------------------------------------------------------- zip
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime() {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function writeZip(outFile, entries) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replaceAll('\\', '/'), 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([...locals, centralBuf, end]));
  return { file: outFile, entries: entries.length, bytes: statSync(outFile).size };
}

/**
 * Minimal ZIP reader (deflate/stored), mirroring writeZip. Returns [{name, data}].
 * No dependency, no network: the store copy must be byte-identical to `upp pack`.
 */
function readZip(file) {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 70000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`not a zip: ${file}`);
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`bad central directory at ${ptr}`);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unpackArchive(file, dest) {
  const entries = readZip(file);
  mkdirSync(dest, { recursive: true });
  const root = resolve(dest);
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const out = resolve(join(dest, entry.name));
    if (!out.startsWith(root)) throw new Error(`unsafe entry in ${file}: ${entry.name}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, entry.data);
  }
  return entries.map((e) => e.name);
}

/** Stable install location for a packed .upp package (survives source moves/edits). */
function storeDir(m) {
  return join(HOME, '.upp', 'store', m.id, m.version);
}

function packEntries(pkg) {
  const skipDir = new Set(['node_modules', 'dist', '.git']);
  const skipFile = (name) =>
    name === '.upp-install.json' ||
    name === '.upp-accio-mcp.json' ||
    name.endsWith('.upp-bak-orig');
  const files = walk(pkg).filter((file) => {
    const rel = relative(pkg, file).replaceAll('\\', '/');
    if (rel.split('/').some((part) => skipDir.has(part))) return false;
    return !skipFile(basename(file));
  });
  return files.map((file) => ({ name: relative(pkg, file).replaceAll('\\', '/'), data: readFileSync(file) }));
}

/** Rename every literal template reference (`hello-upp`, keys included) inside a JSON value. */
function deepReplaceId(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => deepReplaceId(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[deepReplaceId(k, from, to)] = deepReplaceId(v, from, to);
    return out;
  }
  return value;
}

/** Scaffold a new package from examples/hello-upp, rewriting identity everywhere. */
function cmdInit(id, dir) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id ?? '')) throw new Error(`invalid id "${id}" (kebab-case, 3-63 chars)`);
  const dest = resolve(dir ?? join(process.cwd(), id));
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`directory not empty: ${dest}`);
  const tpl = join(REPO, 'examples', 'hello-upp');
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(tpl, { withFileTypes: true })) {
    if (['dist'].includes(entry.name) || entry.name.startsWith('.upp-')) continue;
    const src = join(tpl, entry.name);
    const out = join(dest, entry.name);
    if (entry.isDirectory()) cpSync(src, out, { recursive: true, filter: (p) => !p.includes(`${sep}dist`) });
    else if (entry.name !== '.upp-install.json') copyFileSync(src, out);
  }
  const serverName = id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
  const oldSkill = join(dest, 'skills', 'hello-upp');
  if (existsSync(oldSkill)) renameSync(oldSkill, join(dest, 'skills', id));
  const mPath = join(dest, 'upp.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  m.id = id;
  m.name = id;
  m.description = `UPP plugin ${id}.`;
  m.hosts = {
    dsh: { serverName },
    workbuddy: { serverName },
    accio: { serverName, pluginId: id },
  };
  const rewritten = deepReplaceId(m, 'hello-upp', id);
  writeFileSync(mPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  const skillFile = join(dest, 'skills', id, 'SKILL.md');
  const skill = readFileSync(skillFile, 'utf8')
    .replace(/^name: .*$/m, `name: ${id}`)
    .replaceAll('mcp__upp-hello__', `mcp__${serverName}__`)
    .replaceAll('hello-upp', id);
  writeFileSync(skillFile, skill);
  const toolsPath = join(dest, 'runtime', 'tools.json');
  const tools = JSON.parse(readFileSync(toolsPath, 'utf8'));
  tools.serverName = serverName;
  writeFileSync(toolsPath, `${JSON.stringify(tools, null, 2)}\n`);
  generate(dest, loadManifest(dest));
  log({
    created: dest,
    id,
    serverName,
    skill: join(dest, 'skills', id, 'SKILL.md'),
    next: [
      `cd "${dest}"`,
      `node "${join(REPO, 'tools', 'upp.mjs')}" validate --pkg "${dest}"`,
      `node "${join(REPO, 'tools', 'upp.mjs')}" conformance --pkg "${dest}"`,
      `node "${join(REPO, 'tools', 'upp.mjs')}" pack --pkg "${dest}"`,
    ],
  });
}

// ------------------------------------------------------------------ commands
const statePath = (pkg) => join(pkg, '.upp-install.json');
const pkgArg = () => resolve(flag('pkg', join(REPO, 'examples', 'hello-upp')));

function cmdDetect() {
  const hosts = detectHosts();
  log({
    dsh: { available: hosts.dsh.available, profileDir: hosts.dsh.profileDir, cli: hosts.dsh.cli },
    workbuddy: { available: hosts.workbuddy.available, skills: hosts.workbuddy.skillsDir, mcp: hosts.workbuddy.mcpConfig, cli: hosts.workbuddy.cli },
    accio: { available: hosts.accio.available, skills: hosts.accio.skillsDir, cli: hosts.accio.cli },
    node: process.version,
  });
}

function cmdValidate(pkg) {
  const m = loadManifest(pkg);
  const checks = validateManifest(pkg, m);
  log({ package: pkg, id: m.id, version: m.version, serverName: m.serverName, checks, failed: checks.filter((c) => !c.ok).length });
  process.exitCode = checks.some((c) => !c.ok) ? 1 : 0;
}

function cmdBuild(pkg) {
  const m = loadManifest(pkg);
  const check = hasFlag('check');
  const result = generate(pkg, m, { check });
  log({ package: pkg, id: m.id, check, files: result.files, drift: result.drift, upToDate: result.drift.length === 0 });
  if (check && result.drift.length > 0) process.exitCode = 1;
}

/** Unpack a .upp into the stable store (~/.upp/store/<id>/<version>) and return its manifest. */
function unpackToStore(file) {
  const tmp = join(HOME, '.upp', 'tmp-unpack');
  rmSync(tmp, { recursive: true, force: true });
  unpackArchive(resolve(file), tmp);
  const m = loadManifest(tmp);
  const dest = storeDir(m);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(tmp, dest, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  return { dir: dest, id: m.id, version: m.version, serverName: m.serverName };
}

function cmdUnpack(file, dir) {
  const out = resolve(dir ?? file.replace(/\.upp$/i, ''));
  const entries = unpackArchive(resolve(file), out);
  log({ file: resolve(file), dir: out, count: entries.length, entries });
}

async function cmdInstall(pkg) {
  const m = loadManifest(pkg);
  generate(pkg, m);
  const hosts = detectHosts();
  const wanted = (flag('hosts', 'dsh,workbuddy,accio')).split(',').map((s) => s.trim());
  const record = readJson(statePath(pkg), { package: pkg, hosts: {} });
  record.id = m.id;
  record.version = m.version;
  record.serverName = m.serverName;
  record.hosts ??= {};
  const results = [];
  if (wanted.includes('dsh') && hosts.dsh.available) results.push(installDsh(pkg, hosts, m, record.hosts));
  if (wanted.includes('workbuddy') && hosts.workbuddy.available) results.push(installWorkBuddy(pkg, hosts, m, record.hosts));
  if (wanted.includes('accio') && hosts.accio.available) results.push(await installAccio(pkg, hosts, m, record.hosts));
  writeJson(statePath(pkg), record);
  log({ package: pkg, id: m.id, version: m.version, serverName: m.serverName, results });
}

function cmdVerify(pkg, wanted) {
  const m = loadManifest(pkg);
  m.pkgDir = pkg;
  const hosts = detectHosts();
  const smoke = spawnSync(process.execPath, [join(REPO, 'tests', 'mcp-smoke.mjs'), pkg], { encoding: 'utf8' });
  let smokeReport = null;
  try {
    smokeReport = JSON.parse(smoke.stdout);
  } catch {}
  const all = [...verifyDsh(pkg, hosts, m), ...verifyWorkBuddy(hosts, m), ...verifyAccio(hosts, m)];
  const hostOf = (name) => (name.startsWith('dsh.') ? 'dsh' : name.startsWith('workbuddy.') ? 'workbuddy' : name.startsWith('accio.') ? 'accio' : 'shared');
  const checks = wanted?.includes('none')
    ? all.filter((c) => hostOf(c.check) === 'shared')
    : wanted?.length
      ? all.filter((c) => hostOf(c.check) === 'shared' || wanted.includes(hostOf(c.check)))
      : all;
  const offlineSpec = wanted?.includes('none')
    ? validateManifest(pkg, m).map((c) => ({ ...c, check: `spec.${c.check}` }))
    : [];
  const report = {
    package: pkg,
    id: m.id,
    serverName: m.serverName,
    offline: offlineSpec.length ? `${offlineSpec.filter((c) => c.ok).length}/${offlineSpec.length}` : null,
    smoke: smoke.status === 0 ? 'pass' : 'fail',
    smokeChecks: smokeReport?.checks?.map((c) => `${c.name}:${c.ok ? 'ok' : 'FAIL'}`),
    checks: [...offlineSpec, ...checks],
    failed: [...offlineSpec, ...checks].filter((c) => !c.ok).length + (smoke.status === 0 ? 0 : 1),
  };
  log(report);
  process.exitCode = report.failed > 0 ? 1 : 0;
}

function probeTcp(port) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 700 });
    socket.once('connect', () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolveProbe(false);
    });
    socket.once('error', () => resolveProbe(false));
  });
}

async function cmdDoctor() {
  const hosts = detectHosts();
  const checks = [ok('node', process.version)];
  const cliShim = join(CLI_DIR, process.platform === 'win32' ? 'upp.cmd' : 'upp');
  checks.push(existsSync(cliShim) ? ok('cli.shim', cliShim) : fail('cli.shim', 'not installed - run: node tools/upp.mjs setup-cli'));
  const installedVersion = toolchainVersion(join(CLI_DIR, 'upp.mjs'));
  const repoVersion = toolchainVersion(join(REPO, 'tools', 'upp.mjs'));
  checks.push(
    installedVersion && repoVersion && installedVersion === repoVersion
      ? ok('cli.version', installedVersion)
      : fail('cli.version', installedVersion ? `${installedVersion} != ${repoVersion} - run: upp self-update` : 'not installed - run: node tools/upp.mjs setup-cli'),
  );
  // Sub-toolchains live beside the installed CLI (~/.upp/bin/{tools,lib}); without them `upp env|tool|mem` cannot run.
  for (const [name, command] of [['uppenv', 'env'], ['upptool', 'tool'], ['uppmem', 'mem']]) {
    const cliFile = join(CLI_DIR, 'tools', `${name}.mjs`);
    if (!existsSync(cliFile)) {
      checks.push(fail(`cli.${command}`, `missing ${cliFile} - run: upp setup-cli`));
      continue;
    }
    const res = spawnSync(process.execPath, [join(CLI_DIR, 'upp.mjs'), command, 'version'], { encoding: 'utf8', timeout: 30000 });
    checks.push(
      res.status === 0
        ? ok(`cli.${command}`, (res.stdout ?? '').trim().split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0] ?? name)
        : fail(`cli.${command}`, `exit ${res.status} - run: upp setup-cli`),
    );
  }
  const memoryPool = join(HOME, '.uppmem');
  checks.push(
    existsSync(memoryPool)
      ? ok('mem.pool', `${memoryPool} — run: upp mem sync --host dsh,workbuddy,accio --both`)
      : fail('mem.pool', 'no shared pool yet - run: upp mem add "<fact>"'),
  );
  checks.push(hosts.dsh.available ? ok('dsh.profile', hosts.dsh.profileDir) : fail('dsh.profile', 'not found'));
  checks.push(hosts.workbuddy.available ? ok('workbuddy.home', hosts.workbuddy.skillsDir) : fail('workbuddy.home', 'not found'));
  checks.push(hosts.accio.available ? ok('accio.account', hosts.accio.skillsDir) : fail('accio.account', 'not found'));
  if (existsSync(hosts.workbuddy.cli)) {
    const res = spawnSync(process.execPath, [hosts.workbuddy.cli, 'mcp', 'list'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CODEBUDDY_SKIP_GIT_BASH_CHECK: '1' },
    });
    checks.push(
      res.status === 0
        ? ok('workbuddy.cli.mcp', res.stdout.trim().split('\n').slice(-3).join(' | '))
        : fail('workbuddy.cli.mcp', `exit ${res.status}`),
    );
  } else {
    checks.push(fail('workbuddy.cli', `missing ${hosts.workbuddy.cli}`));
  }
  const gateway = await probeTcp(4097);
  checks.push(
    gateway ? ok('accio.gateway', '127.0.0.1:4097 open') : fail('accio.gateway', 'closed — start Accio before MCP registration'),
  );
  const auth = accioGatewayAuth(hosts);
  if (gateway && auth && existsSync(hosts.accio.cli)) {
    const res = spawnSync(process.execPath, [hosts.accio.cli, 'server', 'list'], {
      encoding: 'utf8',
      timeout: 60000,
      env: auth.env,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    checks.push(res.status === 0 ? ok('accio.cli.mcp', out.split('\n').slice(0, 4).join(' | ')) : fail('accio.cli.mcp', out.slice(0, 300)));
  }
  log({ checks, failed: checks.filter((c) => !c.ok).length });
}

async function cmdConformance(pkg) {
  const m = loadManifest(pkg);
  m.pkgDir = pkg;
  const hosts = detectHosts();
  const manifestChecks = validateManifest(pkg, m);
  const build = generate(pkg, m, { check: true });
  const smoke = spawnSync(process.execPath, [join(REPO, 'tests', 'mcp-smoke.mjs'), pkg], { encoding: 'utf8' });
  let smokeReport = null;
  try {
    smokeReport = JSON.parse(smoke.stdout);
  } catch {}
  const checks = [
    ...manifestChecks.map((c) => ({ ...c, check: `spec.${c.check}` })),
    build.drift.length === 0 ? ok('build.upToDate', '') : fail('build.upToDate', build.drift.join(',')),
    smoke.status === 0 ? ok('protocol.smoke', `${smokeReport?.passed ?? 0} checks`) : fail('protocol.smoke', 'mcp-smoke failed'),
  ];
  const smokeChecks = smokeReport?.checks ?? [];
  const result = { package: pkg, id: m.id, serverName: m.serverName, checks, smokeChecks };
  if (hasFlag('hosts')) {
    result.hostChecks = [...verifyDsh(pkg, hosts, m), ...verifyWorkBuddy(hosts, m), ...verifyAccio(hosts, m)];
  }
  const all = [...checks, ...smokeChecks, ...(result.hostChecks ?? [])];
  result.failed = all.filter((c) => !c.ok).length;
  result.passed = all.length - result.failed;
  log(result);
  process.exitCode = result.failed ? 1 : 0;
}

/** Resolve the private signing key (env UPP_SIGNING_KEY, --key, or ~/.upp/keys). */
function signingKey() {
  const path = resolve(flag('key', SIGNING_KEY));
  if (!existsSync(path)) throw new Error(`signing key not found: ${path} (run: node tools/upp.mjs keygen)`);
  return { path, key: createPrivateKey(readFileSync(path, 'utf8')) };
}

/** Write `<pkg>.sha256` and, when a key is requested, `<pkg>.sig.json` (ed25519 detached). */
function stampPackage(outFile) {
  const hash = sha256File(outFile);
  writeText(shaPath(outFile), `${hash}  ${basename(outFile)}\n`);
  let signature = null;
  if (hasFlag('sign') || hasFlag('key')) {
    const { path, key } = signingKey();
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
    const fingerprint = keyFingerprint(publicKey);
    const sig = {
      format: 'upp-sig/1',
      alg: 'ed25519',
      file: basename(outFile),
      sha256: hash,
      keyFingerprint: fingerprint,
      publicKey,
      signature: cryptoSign(null, readFileSync(outFile), key).toString('base64'),
      signedAt: new Date().toISOString(),
    };
    writeJson(sigPath(outFile), sig);
    signature = { file: sigPath(outFile), fingerprint, key: path };
  }
  return { sha256: hash, sha256File: shaPath(outFile), signature };
}

function cmdPack(pkg) {
  const m = loadManifest(pkg);
  const outDir = resolve(flag('out', join(pkg, 'dist')));
  const outFile = join(outDir, `${m.id}-${m.version}.upp`);
  const entries = packEntries(pkg);
  const result = writeZip(outFile, entries);
  log({ package: pkg, id: m.id, version: m.version, ...result, ...stampPackage(outFile), entries: entries.map((e) => e.name) });
}

function cmdKeygen() {
  const keyFile = resolve(flag('key', join(resolve(flag('out', KEYS_DIR)), 'upp-signing.key.pem')));
  if (existsSync(keyFile) && !hasFlag('force')) throw new Error(`refusing to overwrite existing key: ${keyFile} (pass --force)`);
  mkdirSync(dirname(keyFile), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const pubFile = keyFile.replace(/\.key\.pem$/, '.pub.pem');
  writeFileSync(keyFile, privPem, { mode: 0o600 });
  writeFileSync(pubFile, pubPem);
  log({ alg: 'ed25519', key: keyFile, pubkey: pubFile, fingerprint: keyFingerprint(pubPem) });
}

function cmdVerifySignature(file) {
  if (!file) throw new Error('usage: verify-signature --from <x.upp> [--pubkey <pem>] [--require]');
  assertionsOrExit(verifyPackage(file, { required: hasFlag('require'), pubkey: flag('pubkey') }), 'verifySignature');
}

/** One-directory offline installer: .upp + hash + (optional) signature + vendored toolchain + install scripts. */
function ensureUserPath(dir) {
  if (process.platform !== 'win32') return { added: false, hint: `export PATH="${dir}:$PATH"` };
  const read = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -and ($p.Split(';') -contains '${dir}')) { 'present' } else { 'absent' }`;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', read], { encoding: 'utf8' });
  if ((probe.stdout ?? '').trim() === 'present') return { added: true, already: true };
  const write = `$p=[Environment]::GetEnvironmentVariable('Path','User'); $new = if ([string]::IsNullOrEmpty($p)) { '${dir}' } else { $p.TrimEnd(';') + ';${dir}' }; [Environment]::SetEnvironmentVariable('Path', $new, 'User'); 'ok'`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', write], { encoding: 'utf8' });
  const ok = (run.stdout ?? '').trim() === 'ok';
  return { added: ok, already: false, error: ok ? null : (run.stderr ?? '').trim() };
}

/** Read the toolchain version stamped into a upp.mjs copy (null when missing). */
function toolchainVersion(file) {
  if (!file || !existsSync(file)) return null;
  const m = /^const VERSION = '([^']+)';$/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1] : null;
}

/** Strict numeric dotted-version compare: negative when a < b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Write the global launchers into `dir` (shared by setup-cli and self-update). */
function writeShims(dir) {
  writeText(join(dir, 'upp.cmd'), ['@echo off', 'rem UPP global launcher (generated by upp setup-cli)', 'node "%~dp0upp.mjs" %*', ''].join('\r\n'));
  writeText(join(dir, 'upp'), ['#!/bin/sh', 'exec node "$(dirname "$0")/upp.mjs" "$@"', ''].join('\n'));
  try { chmodSync(join(dir, 'upp'), 0o755); } catch {}
  return [join(dir, 'upp.cmd'), join(dir, 'upp')];
}

const SUB_TOOLCHAINS = ['uppenv', 'upptool', 'uppmem'];

/** Copy the sibling sub-toolchains + their lib/ trees next to the installed upp.mjs, so `upp env|tool|mem` work from any cwd. */
function installSubToolchains(dir) {
  const toolsDir = join(dir, 'tools');
  const libDir = join(dir, 'lib');
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  const installed = [];
  for (const name of SUB_TOOLCHAINS) {
    const src = join(REPO, 'tools', `${name}.mjs`);
    if (existsSync(src)) {
      copyFileSync(src, join(toolsDir, `${name}.mjs`));
      installed.push(`tools/${name}.mjs`);
    }
    const libSrc = join(REPO, 'lib', name);
    if (existsSync(libSrc)) {
      cpSync(libSrc, join(libDir, name), { recursive: true, force: true });
      installed.push(`lib/${name}/`);
    }
  }
  return installed;
}

function cmdSetupCli() {
  const dir = resolve(flag('prefix', CLI_DIR));
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'upp.mjs');
  copyFileSync(join(REPO, 'tools', 'upp.mjs'), script);
  const subToolchains = installSubToolchains(dir);
  const shims = writeShims(dir);
  const pathInfo = hasFlag('no-path') ? { added: false, skipped: true } : ensureUserPath(dir);
  const probe = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'sh',
    process.platform === 'win32' ? ['/d', '/c', join(dir, 'upp.cmd'), 'detect'] : [join(dir, 'upp'), 'detect'],
    { encoding: 'utf8', timeout: 30000 },
  );
  const probeOk = probe.status === 0 && (probe.stdout ?? '').includes('"dsh"');
  const delegates = SUB_TOOLCHAINS.map((name) => {
    const command = name === 'uppenv' ? 'env' : name === 'upptool' ? 'tool' : 'mem';
    const res = spawnSync(process.execPath, [script, command, 'version'], { encoding: 'utf8', timeout: 30000 });
    return { toolchain: name, ok: res.status === 0, version: (res.stdout ?? '').trim().split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0] || null };
  });
  const delegatesOk = delegates.every((d) => d.ok);
  log({
    cli: {
      dir,
      script,
      shims,
      subToolchains,
      path: pathInfo,
      probe: probeOk ? 'ok' : 'failed',
      probeStderr: probeOk ? null : (probe.stderr ?? '').trim(),
      delegates,
      ready: probeOk && delegatesOk,
    },
  });
  if (!probeOk || !delegatesOk) process.exitCode = 1;
}

/** In-place toolchain upgrade: upp self-update [--from <upp.mjs|dir>] [--prefix <dir>] [--force] */
function cmdSelfUpdate() {
  const dir = resolve(flag('prefix', CLI_DIR));
  const target = join(dir, 'upp.mjs');
  const fromArg = flag('from');
  let source = join(REPO, 'tools', 'upp.mjs');
  if (fromArg) {
    const p = resolve(fromArg);
    source = existsSync(p)
      ? (statSync(p).isDirectory() ? [join(p, 'tools', 'upp.mjs'), join(p, 'upp.mjs')].find((c) => existsSync(c)) : p)
      : null;
  }
  const fromVersion = toolchainVersion(source);
  if (!fromVersion) {
    log({ error: 'E_NOT_FOUND', message: `no UPP toolchain at ${fromArg ? resolve(fromArg) : source}`, expected: 'a upp.mjs file, or a directory containing tools/upp.mjs' });
    process.exitCode = 1;
    return;
  }
  const currentVersion = toolchainVersion(target);
  const force = hasFlag('force');
  if (currentVersion === fromVersion && !force) {
    log({ selfUpdate: { dir, from: source, current: currentVersion, upToDate: true, hint: 'pass --force to reinstall the same version' } });
    return;
  }
  if (currentVersion && compareVersions(fromVersion, currentVersion) < 0 && !force) {
    log({ error: 'E_DOWNGRADE', message: `refusing to downgrade ${currentVersion} -> ${fromVersion}`, hint: 'pass --force to allow a downgrade' });
    process.exitCode = 1;
    return;
  }
  mkdirSync(dir, { recursive: true });
  const subToolchains = installSubToolchains(dir);
  let backup = null;
  if (existsSync(target)) {
    backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(target, backup);
  }
  copyFileSync(source, target);
  try { chmodSync(target, 0o755); } catch {}
  const shims = writeShims(dir);
  const probe = spawnSync(process.execPath, [target, '--version'], { encoding: 'utf8', timeout: 30000 });
  const probed = (probe.stdout ?? '').trim();
  log({
    selfUpdate: {
      dir, from: source, fromVersion, previousVersion: currentVersion,
      toVersion: toolchainVersion(target), backup, shims,
      probe: probed || `exit ${probe.status}`,
    },
  });
  if (!probed.includes(fromVersion)) process.exitCode = 1;
}

function cmdBundleOffline(pkg) {
  const m = loadManifest(pkg);
  const dist = resolve(flag('out', join(pkg, 'dist')));
  const dir = join(dist, `offline-${m.id}-${m.version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  const outFile = join(dir, `${m.id}-${m.version}.upp`);
  const entries = packEntries(pkg);
  writeZip(outFile, entries);
  const stamp = stampPackage(outFile);
  copyFileSync(join(REPO, 'tools', 'upp.mjs'), join(dir, 'tools', 'upp.mjs'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  copyFileSync(join(REPO, 'tests', 'mcp-smoke.mjs'), join(dir, 'tests', 'mcp-smoke.mjs'));
  const ups = basename(outFile);
  const installCmd = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & exit /b 1)',
    `set "UPP_OFFLINE=%~dp0"`,
    `set "UPP_PACKAGE=%~dp0${ups}"`,
    'node "%~dp0tools\\upp.mjs" verify-signature --from "%~dp0' + ups + '"',
    'if errorlevel 1 echo [upp] signature/hash check failed - aborting & exit /b 1',
    'node "%~dp0tools\\upp.mjs" install --from "%~dp0' + ups + '" --hosts dsh,workbuddy,accio',
    'node "%~dp0tools\\upp.mjs" verify --pkg "%USERPROFILE%\\.upp\\store\\' + m.id + '\\' + m.version + '"',
    'echo.',
    'echo [upp] done. Restart the host app if it does not pick the plugin up automatically.',
    'pause',
    '',
  ].join('\r\n');
  const installSh = [
    '#!/usr/bin/env sh',
    'set -eu',
    'cd "$(dirname "$0")"',
    'command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required"; exit 1; }',
    `node tools/upp.mjs verify-signature --from ${ups}`,
    `node tools/upp.mjs install --from ${ups} --hosts dsh,workbuddy,accio`,
    `node tools/upp.mjs verify --pkg "$HOME/.upp/store/${m.id}/${m.version}"`,
    'echo "[upp] done. Restart the host app if it does not pick the plugin up automatically."',
    '',
  ].join('\n');
  const setupCmd = ['@echo off', 'setlocal', 'cd /d "%~dp0"', 'node "%~dp0tools\\upp.mjs" setup-cli', 'pause', ''].join('\r\n');
  const setupSh = ['#!/usr/bin/env sh', 'set -eu', 'cd "$(dirname "$0")"', 'node tools/upp.mjs setup-cli', ''].join('\n');
  writeText(join(dir, 'install.cmd'), installCmd);
  writeText(join(dir, 'install.sh'), installSh);
  writeText(join(dir, 'setup-cli.cmd'), setupCmd);
  writeText(join(dir, 'setup-cli.sh'), setupSh);
  writeText(
    join(dir, 'README.txt'),
    [
      `UPP offline installer - ${m.id} ${m.version}`,
      '',
      'Windows: double-click install.cmd (or run it from a terminal).',
      'macOS/Linux: sh install.sh',
      '',
      'What it does:',
      '  1. verifies the package hash (and the ed25519 signature when present)',
      '  2. unpacks it into ~/.upp/store/<id>/<version> (stable path)',
      '  3. registers it with every installed UPP host (DSH / WorkBuddy / Accio)',
      '  4. runs the toolchain verify pass',
      '',
      'Requires Node.js 18+ and nothing else. No network, no npm install.',
      '',
      'Optional: run setup-cli.cmd / setup-cli.sh once to install the global',
      '  `upp` command (~/.upp/bin), then use `upp install --from <x.upp>` anywhere.',
      `Signature: ${stamp.signature ? `ed25519 ${stamp.signature.fingerprint}` : 'unsigned (hash only)'}`,
      '',
    ].join('\n'),
  );
  const files = walk(dir).map((file) => ({
    path: relative(dir, file).replaceAll('\\', '/'),
    bytes: statSync(file).size,
    sha256: sha256File(file),
  }));
  writeJson(join(dir, 'OFFLINE-MANIFEST.json'), {
    format: 'upp-offline/1',
    id: m.id,
    version: m.version,
    serverName: m.serverName,
    package: { file: ups, sha256: stamp.sha256, signature: stamp.signature?.fingerprint ?? null },
    install: { windows: 'install.cmd', unix: 'install.sh', cliWindows: 'setup-cli.cmd', cliUnix: 'setup-cli.sh' },
    files,
  });
  let zipFile = null;
  if (hasFlag('zip')) {
    zipFile = `${dir}.zip`;
    writeZip(zipFile, walk(dir).map((file) => ({ name: relative(dir, file).replaceAll('\\', '/'), data: readFileSync(file) })));
  }
  log({ offline: dir, package: ups, entries: entries.length, signature: stamp.signature, zip: zipFile, manifest: join(dir, 'OFFLINE-MANIFEST.json') });
}

function cmdUninstall(pkg) {
  const record = readJson(statePath(pkg), { hosts: {} });
  const removed = [];
  for (const dir of record.hosts?.workbuddy?.skills ?? []) {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  if (record.hosts?.workbuddy) {
    const mcp = readJson(record.hosts.workbuddy.mcpConfig, { mcpServers: {} });
    if (mcp?.mcpServers) delete mcp.mcpServers[record.hosts.workbuddy.serverName ?? record.serverName];
    writeJson(record.hosts.workbuddy.mcpConfig, mcp);
    removed.push(`${record.hosts.workbuddy.mcpConfig}#entry`);
  }
  const wbPlugin = record.hosts?.workbuddy?.plugin;
  if (wbPlugin) {
    rmSync(wbPlugin.pluginDir, { recursive: true, force: true });
    removed.push(wbPlugin.pluginDir);
    const mfPath = join(wbPlugin.marketplaceDir, '.codebuddy-plugin', 'marketplace.json');
    const mf = readJson(mfPath, null);
    if (mf) {
      mf.plugins = (mf.plugins ?? []).filter((p) => p.name !== record.id);
      if (mf.plugins.length) writeJson(mfPath, mf);
      else rmSync(wbPlugin.marketplaceDir, { recursive: true, force: true });
    }
    const installed = readJson(record.hosts.workbuddy.installedPlugins, null);
    if (installed?.plugins) {
      delete installed.plugins[wbPlugin.key];
      writeJson(record.hosts.workbuddy.installedPlugins, installed);
    }
    for (const file of record.hosts.workbuddy.settingsFiles ?? []) {
      const s = readJson(file, null);
      if (s?.enabledPlugins) {
        delete s.enabledPlugins[wbPlugin.key];
        writeJson(file, s);
      }
    }
    removed.push(`${wbPlugin.key} from installed_plugins/settings`);
  }
  for (const dir of record.hosts?.accio?.skills ?? []) {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  if (record.hosts?.accio) {
    const cfg = readJson(record.hosts.accio.skillsConfig, {});
    const ids = record.hosts.accio.skillIds ?? (record.hosts.accio.skills ?? []).map((d) => basename(d));
    for (const id of ids) delete cfg[id];
    writeJson(record.hosts.accio.skillsConfig, cfg);
    removed.push(`${record.hosts.accio.skillsConfig}#entries`);
  }
  if (record.hosts?.dsh) {
    const profileDir = record.hosts.dsh.profileDir ?? join(HOME, '.dsh', 'profiles', 'desktop');
    const name = record.hosts.dsh.packageName;
    const pkgJsonPath = join(profileDir, 'package.json');
    const pj = readJson(pkgJsonPath, null);
    if (pj) {
      if (pj.dependencies) delete pj.dependencies[name];
      if (pj.dsh?.profile?.bundles) pj.dsh.profile.bundles = pj.dsh.profile.bundles.filter((b) => b !== name);
      backupOnce(pkgJsonPath);
      writeJson(pkgJsonPath, pj);
      if (existsSync(DSH_CLI)) runDshCli(basename(profileDir));
      removed.push(`DSH ${name} from ${profileDir} (node_modules pruned)`);
    }
    for (const dir of record.hosts.dsh.skillsP1 ?? []) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  log({ uninstalled: removed });
}

// ---------------------------------------------------------------- import / analyze
// Turn an existing plugin from any host into a UPP package skeleton + fidelity report.
// Zero dependency, no network. `--analyze` additionally writes a low-token replication brief.

const IMPORT_MARKERS = [
  ['upp.json', 'upp'],
  ['.codebuddy-plugin/plugin.json', 'workbuddy'],
  ['.claude-plugin/plugin.json', 'claude'],
  ['plugin.json', 'plugin'],
  ['clis/clis.json', 'accio'],
];

const toPosix = (p) => p.split(sep).join('/');
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'imported';
const uniqBy = (list, keyOf) => {
  const seen = new Set();
  return list.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

function splitMd(text) {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text };
  const raw = text.slice(3, end);
  const fm = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match) fm[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  const bodyStart = text.indexOf('\n', end + 1);
  return { fm, body: bodyStart < 0 ? '' : text.slice(bodyStart + 1).replace(/^[\r\n]+/, '') };
}

function yamlFront(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    const text = String(value ?? '').replace(/[\r\n]/g, ' ').trim();
    if (!text) continue;
    lines.push(`${key}: ${/[:#?*&!|>'"%@`{}\[\],]/.test(text) ? JSON.stringify(text) : text}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function harvestPlugin(root) {
  const found = {
    kind: 'unknown',
    id: basename(root),
    name: basename(root),
    version: '0.1.0',
    description: '',
    license: '',
    skills: [],
    prompts: [],
    agents: [],
    mcpServers: [],
    clis: [],
    i18n: null,
    recommend: null,
    gaps: [],
    evidence: [],
  };
  const at = (...parts) => readJson(join(root, ...parts), null);
  const textAt = (...parts) => {
    try {
      return readFileSync(join(root, ...parts), 'utf8');
    } catch {
      return '';
    }
  };
  const addMcp = (server) => {
    if (server && (server.command || server.url)) found.mcpServers.push(server);
  };
  const mcpFromPatch = (text) => {
    const command = /^\s*command:\s*"?([^"\n]+?)"?\s*$/m.exec(text);
    if (!command) return null;
    const args = /args:\s*\[([^\]]*)\]/s.exec(text);
    return {
      command: command[1].trim(),
      args: args
        ? args[1]
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean)
        : [],
    };
  };

  const upp = at('upp.json');
  if (upp?.uppVersion) {
    found.kind = 'upp';
    found.evidence.push('upp.json');
    found.id = upp.id ?? found.id;
    found.name = upp.name ?? found.id;
    found.version = upp.version ?? found.version;
    found.description = upp.description ?? '';
    found.license = upp.license ?? '';
    for (const skill of upp.skills ?? []) found.skills.push({ id: skill.id, path: skill.path ?? `skills/${skill.id}` });
    for (const prompt of upp.prompts ?? []) found.prompts.push({ id: prompt.id, path: prompt.path ?? `prompts/${prompt.id}.md` });
    for (const agent of upp.agents ?? []) found.agents.push({ id: agent.id, path: agent.path ?? `agents/${agent.id}.md` });
    found.i18n = upp.i18n ?? null;
    found.recommend = upp.recommend ?? null;
    const patch = mcpFromPatch(textAt('cordis.patch.yml'));
    if (patch) addMcp(patch);
    for (const cli of upp.clis ?? []) found.clis.push(cli);
  }

  const manifest =
    at('.codebuddy-plugin', 'plugin.json') ??
    at('.claude-plugin', 'plugin.json') ??
    at('plugin.json');
  if (manifest && found.kind !== 'upp') {
    if (found.kind === 'unknown') {
      if (existsSync(join(root, '.codebuddy-plugin'))) found.kind = 'workbuddy';
      else if (existsSync(join(root, '.claude-plugin'))) found.kind = 'claude';
      else found.kind = existsSync(join(root, 'plugin.json')) ? 'plugin' : 'claude';
    }
    if (existsSync(join(root, '.codebuddy-plugin', 'plugin.json'))) found.evidence.push('.codebuddy-plugin/plugin.json');
    else if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) found.evidence.push('.claude-plugin/plugin.json');
    else found.evidence.push('plugin.json');
    found.id = manifest.name ?? found.id;
    found.name = manifest.displayName ?? manifest.name ?? found.name;
    found.version = manifest.version ?? found.version;
    found.description = manifest.longDescription ?? manifest.description ?? '';
    found.license = manifest.license ?? '';
    for (const server of Object.values(manifest.mcpServers ?? {})) addMcp(server);
    for (const agent of asArray(manifest.subAgents)) {
      if (!agent?.id) continue;
      const bare = String(agent.id).split(':').pop();
      found.agents.push({ id: bare, path: agent.systemPromptFile ?? `subagents/${bare}/prompt.md` });
    }
  }

  for (const file of ['.mcp.json', 'mcp.json', '.claude-plugin/mcp.json']) {
    const conf = at(file);
    if (!conf) continue;
    found.evidence.push(file);
    for (const server of Object.values(conf.mcpServers ?? conf.servers ?? {})) addMcp(server);
  }
  if (found.kind === 'unknown' || found.kind === 'dsh') {
    const patchText = textAt('cordis.patch.yml');
    if (/dsh-mcp-client/.test(patchText)) {
      found.kind = 'dsh';
      found.evidence.push('cordis.patch.yml');
      const patch = mcpFromPatch(patchText);
      if (patch) addMcp(patch);
    }
  }

  const clis = at('clis', 'clis.json');
  if (clis?.tools) {
    found.clis.push(...clis.tools);
    found.evidence.push('clis/clis.json');
    if (found.kind !== 'upp' && found.kind !== 'workbuddy') found.kind = 'accio';
  }

  const skillsRoot = join(root, 'skills');
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md'))) {
        found.skills.push({ id: entry.name, path: `skills/${entry.name}` });
      }
    }
  }
  for (const dir of ['commands', 'prompts']) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        found.prompts.push({ id: entry.name.replace(/\.md$/i, ''), path: `${dir}/${entry.name}` });
      }
    }
  }
  const agentsAbs = join(root, 'agents');
  if (existsSync(agentsAbs)) {
    for (const entry of readdirSync(agentsAbs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        found.agents.push({ id: entry.name.replace(/\.md$/i, ''), path: `agents/${entry.name}` });
      }
    }
  }
  const subAbs = join(root, 'subagents');
  if (existsSync(subAbs)) {
    for (const entry of readdirSync(subAbs, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(subAbs, entry.name, 'prompt.md'))) {
        found.agents.push({ id: entry.name, path: `subagents/${entry.name}/prompt.md` });
      }
    }
  }
  found.i18n ??= at('resources', 'i18n.json') ?? at('i18n.json');
  found.recommend ??= at('resources', 'recommend.json') ?? at('recommend.json');

  for (const [probe, note] of [
    ['hooks/hooks.json', 'hooks（宿主事件钩子）'],
    ['.lsp.json', 'LSP 服务'],
    ['rpa', 'RPA 资产'],
    ['renderers', '原生 UI renderers'],
    ['ui', '原生 UI 资源'],
    ['lsp', 'LSP 服务'],
  ]) {
    if (existsSync(join(root, probe))) found.gaps.push(note);
  }

  found.skills = uniqBy(found.skills, (x) => x.id);
  found.prompts = uniqBy(found.prompts, (x) => x.id);
  found.agents = uniqBy(found.agents, (x) => x.id);
  found.mcpServers = found.mcpServers.filter((s) => s && (s.command || s.url));
  return found;
}

function probeMcp(server, cwd) {
  return new Promise((resolveProbe) => {
    const result = { tools: [], serverInfo: null, error: null };
    let child;
    try {
      child = spawn(server.command, server.args ?? [], {
        cwd: server.cwd ?? cwd,
        env: { ...process.env, ...(server.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(server.command),
      });
    } catch (error) {
      result.error = String(error?.message ?? error);
      resolveProbe(result);
      return;
    }
    let buffer = '';
    let finished = false;
    const timer = setTimeout(() => finish(result.tools.length ? null : 'upstream did not answer initialize/tools/list in 8s'), 8000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) result.error = error;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolveProbe(result);
    }
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        /* ignore */
      }
    };
    child.on('error', (error) => finish(String(error?.message ?? error)));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          result.serverInfo = message.result?.serverInfo ?? null;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          result.tools = message.result?.tools ?? [];
          finish(null);
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upp-import', version: '1.0.0' } },
    });
  });
}

function proxyRuntime(server, serverName) {
  const upstream = { command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd: server.cwd ?? null };
  const lines = [
    '#!/usr/bin/env node',
    '// Generated by `upp import` — transparent MCP stdio proxy to the original server.',
    "import { spawn } from 'node:child_process';",
    '',
    `const UPSTREAM = ${JSON.stringify(upstream)};`,
    `const SERVER_NAME = ${JSON.stringify(serverName)};`,
    'const startedAt = Date.now();',
    'function spawnChild() {',
    '  return spawn(UPSTREAM.command, UPSTREAM.args, {',
    '    cwd: UPSTREAM.cwd ?? process.cwd(),',
    '    env: { ...process.env, ...UPSTREAM.env },',
    '    stdio: ["pipe", "pipe", "pipe"],',
    '    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(UPSTREAM.command),',
    '  });',
    '}',
    'function runCli(toolName, input) {',
    '  const child = spawnChild();',
    '  let buffer = "";',
    '  let finished = false;',
    '  const send = (message) => { try { child.stdin.write(JSON.stringify(message) + "\\n"); } catch {} };',
    '  const finish = (code, payload) => {',
    '    if (finished) return;',
    '    finished = true;',
    '    try { child.kill(); } catch {}',
    '    process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");',
    '    process.exit(code);',
    '  };',
    '  child.on("error", (error) => finish(1, { ok: false, error: { code: "UPSTREAM_ERROR", message: String(error?.message ?? error) } }));',
    '  child.stderr.on("data", (chunk) => process.stderr.write(chunk));',
    '  child.stdout.on("data", (chunk) => {',
    '    buffer += chunk.toString("utf8");',
    '    for (;;) {',
    '      const index = buffer.indexOf("\\n");',
    '      if (index < 0) break;',
    '      const line = buffer.slice(0, index).trim();',
    '      buffer = buffer.slice(index + 1);',
    '      if (!line) continue;',
    '      let message;',
    '      try { message = JSON.parse(line); } catch { continue; }',
    '      if (message.id === 1) {',
    '        send({ jsonrpc: "2.0", method: "notifications/initialized" });',
    '        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });',
    '      } else if (message.id === 2) {',
    '        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: input } });',
    '      } else if (message.id === 3) {',
    '        if (message.error) finish(2, { ok: false, error: { code: "UPSTREAM_ERROR", message: message.error.message ?? "upstream error", data: message.error.data } });',
    '        const result = message.result ?? {};',
    '        const text = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");',
    '        let data = text;',
    '        try { data = JSON.parse(text); } catch {}',
    '        if (data && typeof data === "object" && "ok" in data && "data" in data) data = data.data;',
    '        finish(result.isError ? 2 : 0, { ok: !result.isError, data, channel: "cli", host: process.env.UPP_HOST ?? "unknown", elapsedMs: Date.now() - startedAt });',
    '      }',
    '    }',
    '  });',
    '  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "upp-proxy", version: "1.0.0" } } });',
    '}',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--cli") {',
    '  const rest = args.slice(2);',
    '  let input = {};',
    '  const jsonIndex = rest.indexOf("--json");',
    '  if (jsonIndex >= 0) {',
    '    try { input = JSON.parse(rest[jsonIndex + 1] ?? "{}"); } catch { process.exit(2); }',
    '  } else {',
    '    for (let i = 0; i + 1 < rest.length; i += 2) input[rest[i].replace(/^--/, "")] = rest[i + 1];',
    '  }',
    '  runCli(args[1] ?? "", input);',
    '} else {',
    '  const child = spawnChild();',
    '  process.stdin.pipe(child.stdin);',
    '  child.stderr.pipe(process.stderr);',
    '  let buffer = "";',
    '  child.stdout.on("data", (chunk) => {',
    '    buffer += chunk.toString("utf8");',
    '    for (;;) {',
    '      const index = buffer.indexOf("\\n");',
    '      if (index < 0) break;',
    '      const line = buffer.slice(0, index);',
    '      buffer = buffer.slice(index + 1);',
    '      let message;',
    '      try { message = JSON.parse(line); } catch { process.stdout.write(line + "\\n"); continue; }',
    '      if (message && message.result && message.result.serverInfo) message.result.serverInfo.name = SERVER_NAME;',
    '      process.stdout.write(JSON.stringify(message) + "\\n");',
    '    }',
    '  });',
    '  child.on("exit", (code) => process.exit(code ?? 0));',
    '  process.on("SIGTERM", () => child.kill());',
    '  process.on("SIGINT", () => child.kill());',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

function describeRuntime(m) {
  return `#!/usr/bin/env node
// Generated by \`upp import\` — fallback runtime for a plugin without an MCP upstream.
import { createInterface } from 'node:readline';
const startedAt = Date.now();
const TOOL = {
  name: 'describe',
  description: 'Describe this imported plugin package.',
  inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } }, additionalProperties: false },
};
const RESULT = ${JSON.stringify({
    package: m.id,
    version: m.version,
    name: m.name,
    description: m.description,
    capabilities: m.capabilities,
    note: 'Business logic of the original plugin lives in skills/commands; re-expose it as MCP tools to make it portable.',
  })};
function run(tool, input, channel) {
  if (tool !== TOOL.name) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'unknown tool ' + tool } };
  }
  return { ok: true, data: input?.verbose ? { ...RESULT, input } : RESULT, channel: channel ?? 'mcp', host: process.env.UPP_HOST ?? 'unknown', elapsedMs: Date.now() - startedAt };
}
if (process.argv.includes('--info')) {
  process.stdout.write(JSON.stringify({ package: RESULT.package, version: RESULT.version, tools: [TOOL.name] }, null, 2) + '\\n');
} else if (process.argv.includes('--list')) {
  process.stdout.write(JSON.stringify([TOOL], null, 2) + '\\n');
} else if (process.argv.includes('--cli')) {
  const args = process.argv.slice(2);
  const tool = args[args.indexOf('--cli') + 1];
  const jsonIndex = args.indexOf('--json');
  let input = {};
  if (jsonIndex >= 0) { try { input = JSON.parse(args[jsonIndex + 1] ?? '{}'); } catch { process.exit(2); } }
  const envelope = run(tool, input, 'cli');
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\\n');
  process.exit(0);
} else {
  const rl = createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: RESULT.package, version: RESULT.version } } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [TOOL] } });
    } else if (message.method === 'tools/call') {
      const envelope = run(message.params?.name, message.params?.arguments);
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: envelope.ok === false } });
    } else if (message.id != null) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
    }
  });
}
`;
}

function copyCapabilities(root, dest, found) {
  const copied = [];
  mkdirSync(join(dest, 'prompts'), { recursive: true });
  mkdirSync(join(dest, 'agents'), { recursive: true });
  for (const skill of found.skills) {
    const src = join(root, skill.path);
    if (!existsSync(src)) continue;
    rmSync(join(dest, 'skills', skill.id), { recursive: true, force: true });
    cpSync(src, join(dest, 'skills', skill.id), { recursive: true });
    copied.push(`skills/${skill.id}`);
  }
  for (const prompt of found.prompts) {
    const src = join(root, prompt.path);
    if (!existsSync(src)) continue;
    const { fm, body } = splitMd(readFileSync(src, 'utf8'));
    const description = fm.description ?? `Imported prompt: ${prompt.id}`;
    const text = `${yamlFront({ name: prompt.id, description })}${body.trimEnd()}\n`;
    writeFileSync(join(dest, 'prompts', `${prompt.id}.md`), text, 'utf8');
    copied.push(`prompts/${prompt.id}.md`);
  }
  for (const agent of found.agents) {
    const src = join(root, agent.path);
    if (!existsSync(src)) continue;
    const { fm, body } = splitMd(readFileSync(src, 'utf8'));
    const description = fm.description ?? `Imported agent: ${agent.id}`;
    writeFileSync(join(dest, 'agents', `${agent.id}.md`), `${yamlFront({ name: agent.id, description })}${body.trimEnd()}\n`, 'utf8');
    copied.push(`agents/${agent.id}.md`);
  }
  if (found.i18n) {
    writeJson(join(dest, 'i18n.json'), found.i18n);
    copied.push('i18n.json');
  }
  if (found.recommend) {
    writeJson(join(dest, 'recommend.json'), found.recommend);
    copied.push('recommend.json');
  }
  if (found.clis.length) {
    writeJson(join(dest, 'clis', 'clis.json'), { tools: found.clis });
    copied.push('clis/clis.json');
  }
  return copied;
}

function importReport(m, found, probed, copied) {
  const lines = [];
  lines.push(`# Import report: ${m.id}`, '');
  lines.push(`- Source kind: **${found.kind}**`);
  lines.push(`- Source plugin id: \`${found.id}\` (v${found.version})`);
  lines.push(`- Imported at: ${new Date().toISOString()}`);
  lines.push(`- Evidence: ${found.evidence.length ? found.evidence.join(', ') : '(none)'}`, '');
  lines.push('## Extracted capabilities', '');
  lines.push('| capability | count | notes |', '| --- | --- | --- |');
  lines.push(`| skills | ${m.skills.length} | copied verbatim |`);
  lines.push(`| prompts | ${m.prompts.length} | commands/*.md 与 prompts/*.md → prompts/ |`);
  lines.push(`| agents | ${m.agents.length} | agents/*.md 与 subagents/<id>/prompt.md → agents/ |`);
  lines.push(`| tools | ${(m.tools ?? []).length} | ${probed ? 'upstream MCP probe' : 'no MCP upstream (describe stub)'}  |`);
  lines.push(`| i18n | ${m.i18n ? 'yes' : 'no'} | ${m.i18n ? `defaultLocale=${m.i18n.defaultLocale}` : ''} |`);
  lines.push(`| recommend | ${m.recommend ? 'yes' : 'no'} | ${m.recommend ? `${m.recommend.length} group(s)` : ''} |`);
  lines.push(`| clis | ${m.clis?.length ?? 0} | copied as clis/clis.json |`, '');
  if (found.mcpServers.length) {
    lines.push('## Upstream MCP servers', '');
    for (const server of found.mcpServers) lines.push(`- \`${server.command ?? server.url}\` ${(server.args ?? []).join(' ')}`);
    lines.push('', 'Imported runtime is a transparent stdio proxy: the original business code executes unchanged, and UPP only adds the cross-host contract (tools.json, CLI, skills).', '');
  } else {
    lines.push('## Runtime', '', 'No MCP upstream was found. `runtime/server.mjs` exposes one `describe` tool so the 3-channel contract still works; the real logic stays in skills/commands and must be re-exposed as MCP tools for full portability.', '');
  }
  lines.push('## Copied files', '', copied.length ? copied.map((item) => `- ${item}`).join('\n') : '- (none)', '');
  if (found.gaps.length) {
    lines.push('## Not portable (P2, dropped by design)', '', found.gaps.map((item) => `- ${item}`).join('\n'), '');
  }
  lines.push('## Next steps', '');
  lines.push('1. `node tools/upp.mjs validate --pkg <this>`');
  lines.push('2. Review tools.json: rename tools to stable `snake_case` names if the upstream uses unstable names.');
  lines.push('3. `node tools/upp.mjs build --pkg <this>` then `install` / `verify` / `conformance`.');
  return `${lines.join('\n')}\n`;
}

function analysisBrief(m, found) {
  const tools = m.tools ?? [];
  const brief = {
    contractVersion: '1.0',
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } })),
    skillIds: m.skills.map((skill) => skill.id),
    promptIds: m.prompts.map((prompt) => prompt.id),
    agentIds: m.agents.map((agent) => agent.id),
    cli: (m.clis ?? []).map((cli) => ({ id: cli.id, commandName: cli.source?.commandName ?? cli.id, entry: cli.source?.entry ?? null })),
    runtime: m.runtime,
    serverName: m.serverName,
    permissions: m.permissions,
    replication: [
      '实现一个 stdio JSON-RPC 2.0 server：initialize / tools/list / tools/call，信封 {ok,data,channel,host,elapsedMs}。',
      'tools.json 是唯一工具契约；参数校验用 inputSchema，错误码 INVALID_ARGS/NOT_FOUND/PERMISSION_DENIED/TIMEOUT/UPSTREAM_ERROR/INTERNAL。',
      '同时提供 --cli <tool> --json 模式，退出码 0/2/1。',
      '把 skillIds 对应的技能文本原样放进技能目录；prompt/agent 由宿主适配器派生。',
      '不要声称移植 P2 能力（UI/hooks/RPA/LSP）。',
    ],
  };
  const json = JSON.stringify(brief, null, 2);
  return {
    brief,
    text: `# Replication brief: ${m.id}\n\n> 低 token 复刻契约（约 ${Math.ceil(json.length / 4)} tokens）。按此实现即可在 DSH / WorkBuddy / Accio 三端等价运行。\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    tokens: Math.ceil(json.length / 4),
  };
}

const POLISH_SECTION = '## LLM 增强摘要（可选，不属于契约）';

function llmConfig() {
  const baseUrl = process.env.UPP_LLM_BASE_URL;
  const apiKey = process.env.UPP_LLM_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: process.env.UPP_LLM_MODEL ?? 'deepseek-chat',
    timeoutMs: Number(process.env.UPP_LLM_TIMEOUT_MS ?? 30000),
  };
}

function polishPrompt(brief) {
  const compact = {
    id: brief.id,
    name: brief.name,
    version: brief.version,
    description: brief.description,
    tools: (brief.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    skillIds: brief.skillIds,
    cli: brief.cli,
  };
  return [
    'You are a plugin portability analyst. Given a UPP replication brief (JSON), return STRICT JSON with exactly these keys:',
    '{"summary": string, "toolDescriptions": {"<tool name>": string}, "replicationHints": [string], "risks": [string]}',
    'Rules: summary <= 400 characters; toolDescriptions only for the listed tools; 2-5 replicationHints; 0-3 risks;',
    'never invent tools or capabilities that are not present; no markdown fences; output JSON only.',
    '',
    JSON.stringify(compact),
  ].join('\n');
}

async function chatJson(cfg, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Return strict JSON only. No prose, no markdown.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? '';
    const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(stripped);
  } finally {
    clearTimeout(timer);
  }
}

function applyPolish(dest, brief, data, cfg) {
  const allowed = new Set((brief.tools ?? []).map((tool) => tool.name));
  const rawDescriptions = data.toolDescriptions && typeof data.toolDescriptions === 'object' ? data.toolDescriptions : {};
  const toolDescriptions = {};
  for (const [name, value] of Object.entries(rawDescriptions)) {
    if (allowed.has(name) && typeof value === 'string' && value.trim()) toolDescriptions[name] = value.trim();
  }
  const hints = Array.isArray(data.replicationHints) ? data.replicationHints.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8) : [];
  const risks = Array.isArray(data.risks) ? data.risks.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8) : [];
  const summary = typeof data.summary === 'string' ? data.summary.trim().slice(0, 400) : '';
  const lines = ['', POLISH_SECTION, ''];
  if (summary) lines.push(summary, '');
  if (Object.keys(toolDescriptions).length) {
    lines.push('| tool | 增强描述 |', '| --- | --- |');
    for (const [name, value] of Object.entries(toolDescriptions)) lines.push(`| \`${name}\` | ${value.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (hints.length) lines.push('复刻提示：', ...hints.map((item) => `- ${item}`), '');
  if (risks.length) lines.push('风险提示：', ...risks.map((item) => `- ${item}`), '');
  lines.push(`> 由 \`${cfg.model}\` 生成，仅作参考；契约以 contract.json 与 tools.json 为准。`, '');
  appendFileSync(join(dest, 'ANALYSIS.md'), lines.join('\n'), 'utf8');

  const contractPath = join(dest, 'contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  contract.llm = { model: cfg.model, generatedAt: new Date().toISOString(), summary, toolDescriptions, replicationHints: hints, risks };
  writeJson(contractPath, contract);
  return { model: cfg.model, summaryChars: summary.length, toolDescriptions: Object.keys(toolDescriptions).length, hints: hints.length, risks: risks.length };
}

function cmdImport(source, outDir, analyze, polish = false) {
  const root = resolve(source);
  if (!existsSync(root)) throw new Error(`no such path: ${root}`);
  const found = harvestPlugin(root);
  const id = slug(found.id);
  const dest = resolve(outDir ?? join(REPO, 'imports', id));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const upstream = found.mcpServers.find((server) => server.command) ?? null;
  const serverName = id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
  const capabilities = [];
  const m = {
    uppVersion: '1.0',
    id,
    name: found.name,
    version: found.version,
    description: found.description,
    license: found.license || 'UNKNOWN',
    runtime: { kind: 'node', entry: 'runtime/server.mjs', manifest: 'runtime/tools.json' },
    capabilities,
    permissions: { network: Boolean(found.mcpServers.some((server) => server.url)), filesystem: 'none', shell: Boolean(upstream) },
    hosts: { dsh: { serverName }, workbuddy: { serverName }, accio: { serverName } },
    tokenBudget: { alwaysLoadedBytes: 900, briefBytes: 4200 },
    import: { sourceKind: found.kind, sourcePath: root, importedAt: new Date().toISOString(), upstream },
  };

  return (async () => {
    let probed = false;
    let tools = [];
    if (upstream) {
      const probe = await probeMcp(upstream, root);
      probed = true;
      tools = probe.tools;
      m.import.upstreamProbe = { serverInfo: probe.serverInfo, toolCount: tools.length, error: probe.error };
      if (probe.error) m.import.gaps = [`上游 MCP 探测失败：${probe.error}`];
    }
    if (!tools.length && upstream) {
      tools = [{ name: 'describe', description: 'Describe this imported plugin package.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
    }
    if (!tools.length && found.kind === 'upp') {
      const priorManifest = join(root, 'runtime', 'tools.json');
      const prior = existsSync(priorManifest) ? readJson(priorManifest, null) : null;
      if (prior && Array.isArray(prior.tools) && prior.tools.length) {
        tools = prior.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
        m.import.reusedTools = true;
      }
    }
    if (!tools.length && !upstream) {
      tools = [{ name: 'describe', description: 'Describe this imported plugin package.', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } }, additionalProperties: false } }];
    }
    m.tools = tools;
    capabilities.push('tools');
    if (found.skills.length) capabilities.push('skills');
    if (found.prompts.length) capabilities.push('prompts');
    if (found.agents.length) capabilities.push('agents');
    if (found.i18n) capabilities.push('i18n');
    if (found.recommend) capabilities.push('recommend');
    if (found.clis.length) capabilities.push('clis');
    m.skills = found.skills.map((skill) => ({ id: skill.id, path: `skills/${skill.id}` }));
    m.prompts = found.prompts.map((prompt) => ({ id: prompt.id, path: `prompts/${prompt.id}.md` }));
    m.agents = found.agents.map((agent) => ({ id: agent.id, path: `agents/${agent.id}.md` }));
    m.i18n = found.i18n ?? null;
    m.recommend = found.recommend ?? null;
    m.clis = found.clis;

    const copied = copyCapabilities(root, dest, found);
    mkdirSync(join(dest, 'runtime'), { recursive: true });
    const sourceRuntime = join(root, 'runtime', 'server.mjs');
    if (found.kind === 'upp' && existsSync(sourceRuntime)) {
      copyFileSync(sourceRuntime, join(dest, 'runtime', 'server.mjs'));
      m.import.reusedRuntime = 'runtime/server.mjs';
    } else {
      writeFileSync(join(dest, 'runtime', 'server.mjs'), upstream ? proxyRuntime(upstream, serverName) : describeRuntime(m), 'utf8');
    }
    writeJson(join(dest, 'runtime', 'tools.json'), { serverName, version: m.version, tools });
    writeJson(join(dest, 'upp.json'), m);
    copyFileSync(join(REPO, 'examples', 'hello-upp', 'cordis.patch.yml.tpl'), join(dest, 'cordis.patch.yml.tpl'));
    writeFileSync(join(dest, 'IMPORT-REPORT.md'), importReport(m, found, probed, copied), 'utf8');
    const analyzeResult = analyze ? analysisBrief(m, found) : null;
    if (analyzeResult) {
      writeFileSync(join(dest, 'ANALYSIS.md'), analyzeResult.text, 'utf8');
      writeJson(join(dest, 'contract.json'), analyzeResult.brief);
    }
    let polished = null;
    let polishSkipped = null;
    if (analyzeResult && polish) {
      const cfg = llmConfig();
      if (!cfg) {
        polishSkipped = 'UPP_LLM_BASE_URL / UPP_LLM_API_KEY not set';
        log({ polish: { skipped: true, reason: polishSkipped } });
        if (hasFlag('strict-polish')) process.exit(1);
      } else {
        try {
          polished = applyPolish(dest, analyzeResult.brief, await chatJson(cfg, polishPrompt(analyzeResult.brief)), cfg);
        } catch (error) {
          log({ polish: { failed: true, error: String(error.message ?? error) } });
          if (hasFlag('strict-polish')) process.exit(1);
        }
      }
    }
    log({
      imported: { source: root, kind: found.kind, id, out: dest, upstream: upstream ? `${upstream.command} ${(upstream.args ?? []).join(' ')}` : null },
      counts: { skills: m.skills.length, prompts: m.prompts.length, agents: m.agents.length, tools: tools.length, clis: m.clis.length },
      analyze: analyzeResult ? { file: join(dest, 'ANALYSIS.md'), tokens: analyzeResult.tokens } : null,
      polish: polished ?? polishSkipped ?? null,
      next: `node tools/upp.mjs validate --pkg "${toPosix(dest)}"`,
    });
  })();
}

let pkg = pkgArg();
if (command === 'install' && flag('from')) {
  const from = flag('from');
  const verdict = verifyPackage(from, { required: hasFlag('require-signature'), pubkey: flag('pubkey') });
  const bad = verdict.checks.filter((c) => !c.ok);
  if (bad.length) {
    log({ installFrom: resolve(from), rejected: true, checks: verdict.checks });
    process.exit(1);
  }
  log({ installFrom: resolve(from), integrity: verdict.signed ? `ed25519 ${verdict.fingerprint}` : `${verdict.sha256.slice(0, 16)}… (unsigned)` });
  const info = unpackToStore(from);
  pkg = info.dir;
  log({ installedFrom: resolve(from), store: info.dir, id: info.id, version: info.version });
}
if (command === '--version' || command === '-v' || command === 'version') {
  log({ toolchain: VERSION, node: process.version, script: HERE });
} else switch (command) {
  case 'import':
  case 'analyze':
    await cmdImport(flag('src') ?? argv[1], flag('out'), command === 'analyze' || hasFlag('analyze'), hasFlag('polish'));
    break;
  case 'detect':
    cmdDetect();
    break;
  case 'validate':
    cmdValidate(pkg);
    break;
  case 'build':
    cmdBuild(pkg);
    break;
  case 'unpack':
    cmdUnpack(flag('from'), flag('dir'));
    break;
  case 'init': {
    // `upp init my-plugin [../dir]` is the beginner spelling; `--id/--dir` still work.
    const first = argv[1] && !argv[1].startsWith('-') ? argv[1] : undefined;
    const second = argv[2] && !argv[2].startsWith('-') ? argv[2] : undefined;
    cmdInit(flag('id') ?? first, flag('dir') ?? second);
    break;
  }
  case 'install':
    await cmdInstall(pkg);
    break;
  case 'verify': {
    // Before install there is nothing to verify on the hosts, so default to the offline checks.
    const hostsFlag = flag('hosts');
    const installed = existsSync(statePath(pkg));
    const wanted = hostsFlag
      ? hostsFlag.split(',').map((s) => s.trim())
      : installed
        ? ['dsh', 'workbuddy', 'accio']
        : ['none'];
    cmdVerify(pkg, wanted);
    break;
  }
  case 'conformance':
    await cmdConformance(pkg);
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  case 'pack':
    cmdPack(pkg);
    break;
  case 'keygen':
    cmdKeygen();
    break;
  case 'verify-signature':
    cmdVerifySignature(flag('from') ?? argv[1]);
    break;
  case 'setup-cli':
    cmdSetupCli();
    break;
  case 'self-update':
    cmdSelfUpdate();
    break;
  case 'bundle-offline':
    cmdBundleOffline(pkg);
    break;
  case 'uninstall':
    cmdUninstall(pkg);
    break;
  case 'env':
  case 'tool':
  case 'mem': {
    // Delegate to a sibling toolchain (same directory), forwarding argv verbatim.
    const cliName = command === 'env' ? 'uppenv.mjs' : command === 'tool' ? 'upptool.mjs' : 'uppmem.mjs'
    const toolLabel = command === 'env' ? 'uppenv' : command === 'tool' ? 'upptool' : 'uppmem'
    const cliPath = [join(HERE, 'tools', cliName), join(HERE, cliName)].find((c) => existsSync(c));
    if (!cliPath) {
      log({ error: `${toolLabel} toolchain not found`, expected: toPosix(join(HERE, 'tools', cliName)), hint: `restore tools/${cliName} + lib/${toolLabel}/, then run: upp setup-cli` });
      process.exitCode = 1;
      break;
    }
    const child = spawnSync(process.execPath, [cliPath, ...argv.slice(1)], { stdio: 'inherit' });
    if (child.error) {
      log({ error: `${toolLabel} failed to start: ${child.error.message}` });
      process.exitCode = 1;
      break;
    }
    process.exitCode = child.status ?? 1;
    break;
  }
  default:
    log(`unknown command: ${command} (detect|init|import|analyze|validate|build|install|unpack|verify|conformance|pack|doctor|uninstall|env|tool|mem)`);
    process.exitCode = 2;
}
