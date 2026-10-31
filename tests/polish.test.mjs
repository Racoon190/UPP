#!/usr/bin/env node
// Offline test for `analyze --polish`: a local mock of an OpenAI-compatible
// /chat/completions endpoint. Proves the optional LLM path works without network,
// that it is opt-in, and that strict mode fails loudly.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const UPP = join(REPO, 'tools', 'upp.mjs');
const SRC = join(REPO, 'fixtures', 'upp-min');
const TMP = join(HERE, '.tmp-polish');

const checks = [];
const check = (name, ok, detail) => checks.push({ check: name, ok: Boolean(ok), detail });

function runUpp(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [UPP, ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => done({ code, out }));
  });
}

const GOOD = {
  summary: '跨端示例插件，一个 ping 工具，同时提供技能与 CLI。',
  toolDescriptions: { ping: '检查运行时是否存活并回显一条备注。', bogus_tool: 'should be filtered' },
  replicationHints: ['先实现 tools.json 契约', '再补 --cli 模式'],
  risks: ['无上游 MCP 时只有 describe 兜底'],
};

let mode = 'good';
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'bad') {
      res.end(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
  });
});
await new Promise((ready) => mock.listen(0, '127.0.0.1', ready));
const port = mock.address().port;
const base = `http://127.0.0.1:${port}/v1`;
const env = { UPP_LLM_BASE_URL: base, UPP_LLM_API_KEY: 'test-key', UPP_LLM_MODEL: 'mock-model' };

try {
  rmSync(TMP, { recursive: true, force: true });

  // 1. happy path
  const out1 = join(TMP, 'happy');
  const first = await runUpp(['analyze', '--src', SRC, '--out', out1, '--polish', '--strict-polish'], env);
  const analysis = existsSync(join(out1, 'ANALYSIS.md')) ? readFileSync(join(out1, 'ANALYSIS.md'), 'utf8') : '';
  const contract = existsSync(join(out1, 'contract.json')) ? JSON.parse(readFileSync(join(out1, 'contract.json'), 'utf8')) : {};
  check('polish.exit0', first.code === 0, `exit=${first.code}`);
  check('polish.section', analysis.includes('## LLM 增强摘要'), 'ANALYSIS.md has section');
  check('polish.summary', contract?.llm?.summary === GOOD.summary, contract?.llm?.summary ?? 'missing');
  check('polish.tool.filtered', Object.keys(contract?.llm?.toolDescriptions ?? {}).join(',') === 'ping', JSON.stringify(contract?.llm?.toolDescriptions ?? {}));
  check('polish.hints', (contract?.llm?.replicationHints ?? []).length === 2, `hints=${(contract?.llm?.replicationHints ?? []).length}`);

  // 2. opt-in: no key => strict fails, non-strict skips without touching contract
  const out2 = join(TMP, 'nokey');
  const strict = await runUpp(['analyze', '--src', SRC, '--out', out2, '--polish', '--strict-polish'], { UPP_LLM_BASE_URL: base, UPP_LLM_API_KEY: '' });
  check('polish.strict-missing-env', strict.code === 1, `exit=${strict.code}`);
  const out3 = join(TMP, 'nokey-lenient');
  const lenient = await runUpp(['analyze', '--src', SRC, '--out', out3, '--polish'], { UPP_LLM_BASE_URL: base, UPP_LLM_API_KEY: '' });
  const lenientAnalysis = existsSync(join(out3, 'ANALYSIS.md')) ? readFileSync(join(out3, 'ANALYSIS.md'), 'utf8') : '';
  check('polish.lenient-skip', lenient.code === 0 && !lenientAnalysis.includes('## LLM 增强摘要'), `exit=${lenient.code}`);

  // 3. malformed completion => strict fails, no partial section written
  mode = 'bad';
  const out4 = join(TMP, 'badjson');
  const bad = await runUpp(['analyze', '--src', SRC, '--out', out4, '--polish', '--strict-polish'], env);
  const badAnalysis = existsSync(join(out4, 'ANALYSIS.md')) ? readFileSync(join(out4, 'ANALYSIS.md'), 'utf8') : '';
  check('polish.bad-json-strict', bad.code === 1 && !badAnalysis.includes('## LLM 增强摘要'), `exit=${bad.code}`);

  // 4. default analyze must not call the model
  mode = 'good';
  const before = checks.length;
  const out5 = join(TMP, 'noflag');
  const plain = await runUpp(['analyze', '--src', SRC, '--out', out5], env);
  const plainAnalysis = existsSync(join(out5, 'ANALYSIS.md')) ? readFileSync(join(out5, 'ANALYSIS.md'), 'utf8') : '';
  check('polish.default-off', plain.code === 0 && !plainAnalysis.includes('## LLM 增强摘要') && checks.length === before, `exit=${plain.code}`);
} finally {
  mock.close();
}

const failed = checks.filter((item) => !item.ok).length;
process.stdout.write(`${JSON.stringify({ checks, passed: checks.length - failed, failed }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
