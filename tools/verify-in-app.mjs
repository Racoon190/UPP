#!/usr/bin/env node
/**
 * In-app verification: closes the two PoC cells that need the host GUI running.
 *
 *   node tools/verify-in-app.mjs [--pkg <store-or-source-dir>]
 *
 * Read-only: it never installs. It answers "is the host actually running and
 * does it see our skill/MCP server?" and prints the exact command to fix a gap.
 *
 * Exit 0 only when every running-state check passes.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const HOME = homedir();
const argv = process.argv.slice(2);
const pkg = resolve(argv[argv.indexOf('--pkg') + 1] ?? join(HOME, '.upp', 'store', 'hello-upp', '1.0.0'));
const manifest = JSON.parse(readFileSync(join(pkg, 'upp.json'), 'utf8'));
const manifestTools = existsSync(join(pkg, 'runtime', 'tools.json'))
  ? JSON.parse(readFileSync(join(pkg, 'runtime', 'tools.json'), 'utf8'))
  : { serverName: manifest.id, tools: [] };
const serverName = manifestTools.serverName ?? manifest.id;
const skillIds = (manifest.skills ?? [])
  .map((s) => s.id ?? String(s).split('/').pop())
  .filter(Boolean);
if (skillIds.length === 0 && existsSync(join(pkg, 'skills'))) {
  for (const entry of readdirSync(join(pkg, 'skills'), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(pkg, 'skills', entry.name, 'SKILL.md'))) skillIds.push(entry.name);
  }
}
const checks = [];
const record = (name, ok, detail = '') => checks.push({ name, ok, detail });

function probeTcp(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 800 });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(false));
  });
}

function processes() {
  const res = spawnSync('tasklist', [], { encoding: 'utf8', windowsHide: true });
  return String(res.stdout ?? '').toLowerCase();
}

const running = processes();
const wbRunning = /workbuddy|codebuddy/.test(running);
const accioRunning = /accio/.test(running);
const dshRunning = /deepseek harness/.test(running);

record('process.dsh', dshRunning, 'DeepSeek Harness 进程');
record('process.workbuddy', wbRunning, wbRunning ? '运行中' : '未运行 → 手动启动 WorkBuddy');
record('process.accio', accioRunning, accioRunning ? '运行中' : '未运行 → 手动启动 Accio Work');

// ---- DeepSeek Harness: profile registration is enough; tool presence needs a live session
const profileDir = process.env.DSH_PROFILE_DIR || join(HOME, '.dsh', 'profiles', 'desktop');
const profilePkg = existsSync(join(profileDir, 'package.json'))
  ? JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  : {};
const depName =
  manifest.hosts?.dsh?.packageName ??
  Object.keys(profilePkg.dependencies ?? {}).find(
    (n) => n.includes(serverName) || n.includes(manifest.id) || n.endsWith(`/${manifest.id}`),
  );
record('dsh.profile.dependency', Boolean(profilePkg.dependencies?.[depName]), depName ?? '未登记');
record('dsh.profile.bundles', (profilePkg.dsh?.profile?.bundles ?? []).includes(depName), depName ?? '未登记');

// ---- WorkBuddy: skill directory + cache + CLI health check
const wbSkills = join(HOME, '.workbuddy', 'skills');
for (const id of skillIds) {
  record(`workbuddy.skill.${id}`, existsSync(join(wbSkills, id, 'SKILL.md')), join(wbSkills, id));
}
const wbCache = join(HOME, '.workbuddy', '.skill-list-cache.json');
if (existsSync(wbCache)) {
  const cache = readFileSync(wbCache, 'utf8');
  const hit = skillIds.some((id) => cache.includes(`"${id}"`) || cache.includes(id));
  record('workbuddy.skill.cache', hit, hit ? '热加载缓存已收录' : '缓存未收录（GUI 未运行或尚未刷新）');
} else {
  record('workbuddy.skill.cache', false, '无缓存文件');
}
const wbCli = 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
if (wbRunning && existsSync(wbCli)) {
  const res = spawnSync(process.execPath, [wbCli, 'mcp', 'list'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CODEBUDDY_SKIP_GIT_BASH_CHECK: '1' },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  record('workbuddy.mcp.health', /connected/i.test(out) && out.includes(serverName), out.trim().split('\n').slice(-3).join(' | ').slice(0, 300));
} else {
  record('workbuddy.mcp.health', false, 'WorkBuddy 未运行，无法验证 MCP 健康');
}

// ---- Accio: gateway + registered server list
const gateway = await probeTcp(4097);
record('accio.gateway', gateway, gateway ? '127.0.0.1:4097 可连' : '未监听 → 启动 Accio Work');
const accioCli = 'D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs';
if (gateway && existsSync(accioCli)) {
  let env = process.env;
  const accioRoot = join(HOME, '.accio', 'accounts');
  const account = readdirSync(accioRoot).find((d) => /^\d+$/.test(d));
  const gwCfg = account ? join(accioRoot, account, '.accio', 'runtime', 'gateway-cli.json') : null;
  if (gwCfg && existsSync(gwCfg)) {
    try {
      const g = JSON.parse(readFileSync(gwCfg, 'utf8'));
      if (g.password) env = { ...env, ACCIO_GATEWAY_TOKEN: g.password, ACCIO_GATEWAY_USERNAME: g.username ?? 'phoenix', ACCIO_LOCAL_GATEWAY_URL: g.url ?? 'http://localhost:4097' };
    } catch {}
  }
  const res = spawnSync(process.execPath, [accioCli, 'server', 'list'], { encoding: 'utf8', timeout: 60000, env });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  record('accio.mcp.list', out.includes(serverName), out.trim().slice(0, 300));
} else {
  record('accio.mcp.list', false, '跳过：Gateway 不可用');
}
const accounts = join(HOME, '.accio', 'accounts');
record('accio.skills.config', existsSync(accounts), accounts);

const failed = checks.filter((c) => !c.ok);
const report = {
  package: pkg,
  serverName,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
  hints: [
    !dshRunning ? '启动 DeepSeek Harness 后新会话即可用 mcp__' + serverName + '__' + (manifestTools.tools[0]?.name ?? 'tool') : null,
    !wbRunning ? '启动 WorkBuddy；技能面板应出现 ' + skillIds.join(', ') : null,
    !gateway ? '启动 Accio Work 后重跑 `node tools/upp.mjs install --hosts accio`（会自动通过 Gateway 注册 MCP）' : null,
  ].filter(Boolean),
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
