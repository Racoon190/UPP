/* ============================================================================
 * UPP GUI — vanilla ES2022 browser script (no build step, no imports, no deps).
 * Speaks only to the local uppgui API: /api/ping · /api/catalog · /api/status ·
 * POST /api/action · /api/log. Token from ?token=… travels as X-UPP-Token.
 * ========================================================================= */
'use strict';
(() => {
  // ==== 0. tiny helpers ====================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = (s) => new TextEncoder().encode(String(s)).length;
  const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : v == null || v === '' ? '—' : String(v));
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const pick = (obj, keys, dflt = null) => {
    for (const k of keys) { const v = get(obj, k); if (v !== undefined && v !== null && v !== '') return v; }
    return dflt;
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtClock = (ts) => { const d = ts ? new Date(ts) : new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  const fmtDur = (ms) => {
    if (ms == null) return '—';
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  };
  const fmtAge = (v) => {
    if (v == null || v === '') return '—';
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(t)) return String(v);
    const diff = Date.now() - t;
    if (diff < 0) return fmtClock(t);
    const s = Math.round(diff / 1000), m = Math.round(s / 60), h = Math.round(m / 60);
    if (s < 90) return `${s}s 前`;
    if (m < 90) return `${m}m 前`;
    return h < 48 ? `${h}h 前` : new Date(t).toLocaleDateString('zh-CN');
  };
  function stringify(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  function countOf(v) {
    if (v == null) return '—';
    if (typeof v === 'number' || typeof v === 'string') return num(v);
    if (Array.isArray(v)) return num(v.length);
    const n = pick(v, ['count', 'total', 'size', 'length'], null);
    if (n != null) return num(n);
    for (const k of ['entries', 'items', 'tools', 'rows', 'list', 'pool', 'members']) {
      const val = v[k];
      if (typeof val === 'number') return num(val);
      if (Array.isArray(val)) return num(val.length);
    }
    return num(Object.keys(v).length);
  }
  // ==== 1. constants & state ==============================================
  const MEM_KINDS = ['fact', 'preference', 'decision', 'project', 'convention', 'task', 'note'];
  const ENV_KINDS = ['plugin', 'skill', 'mcp', 'tool', 'memory'];
  const HOSTS = ['dsh', 'workbuddy', 'accio'];
  const NAV = [
    { id: 'overview', title: '概览', sub: 'status · doctor', icon: 'overview' }, { id: 'memory', title: '记忆', sub: '共享记忆池 · 跨 DSH / WorkBuddy / Accio', icon: 'memory' },
    { id: 'tools', title: '工具', sub: '本地可复用工具注册表', icon: 'tools' }, { id: 'env', title: '环境镜像', sub: '扫描 · 导出 · 导入 · 回滚', icon: 'env' },
    { id: 'plugin', title: '插件', sub: 'init · validate · verify · pack · install', icon: 'plugin' }, { id: 'agent', title: 'Agent', sub: 'MCP 接入 · upp_action · token 预算', icon: 'agent' },
  ];
  const EXPECTED = {
    overview: ['status', 'doctor'],
    memory: ['mem.list', 'mem.search', 'mem.add', 'mem.update', 'mem.rm', 'mem.stats', 'mem.sync', 'mem.install', 'mem.hosts'],
    tools: ['tool.list', 'tool.show', 'tool.suggest', 'tool.run', 'tool.add', 'tool.stats'],
    env: ['env.scan', 'env.export', 'env.import', 'env.verify', 'env.inspect', 'env.rollback', 'env.tools'],
    plugin: ['plugin.init', 'plugin.validate', 'plugin.verify', 'plugin.pack', 'plugin.install', 'plugin.detect'],
  };
  // semantic param name -> candidate arg names (normalized match, see buildParams)
  const ALIAS = {
    query: ['query', 'q', 'text', 'task', 'keyword', 'term'], limit: ['limit', 'count', 'max', 'top', 'n'],
    kind: ['kind', 'type'], kinds: ['kinds', 'kind', 'types'], text: ['text', 'content', 'body', 'note'],
    key: ['key'], tags: ['tags', 'tag'], ref: ['ref', 'id', 'key', 'entry', 'target'],
    desc: ['desc', 'description', 'summary'],
    id: ['id', 'name', 'plugin'], hosts: ['hosts', 'host'], both: ['both'],
    dryRun: ['dryRun', 'dry-run', 'dry'], remove: ['remove', 'uninstall'],
    out: ['out', 'output', 'file', 'target', 'dest'], path: ['path', 'dir', 'target', 'input', 'file'],
    file: ['file', 'path', 'image', 'source'], from: ['from', 'file', 'path', 'source'],
    dir: ['dir', 'path', 'root', 'target'], tool: ['tool', 'id', 'name'],
    argv: ['args', 'argv', 'tail', 'input'], cwd: ['cwd', 'dir', 'workdir'],
    name: ['name', 'id', 'alias'], sign: ['sign', 'signature', 'signed'],
    probe: ['probe', 'probeTools', 'probe-tools', 'noProbe', 'no-probe-tools'],
    requireSignature: ['requireSignature', 'require-signature', 'require'],
    onConflict: ['onConflict', 'on-conflict', 'conflict'], last: ['last'],
  };
  // toolchain keys -> short labels (status.toolchain renders "uppenv 1.1.0 (schema …)"; keep only versions)
  const TC_LABEL = { upp: 'upp', uppenv: 'env', upptool: 'tool', uppmem: 'mem' };
  const PAYLOAD_RE = /starting \(payload (.+?)\)/;
  const state = { token: '', noAuth: false, payloadDir: '', catalog: null, actions: new Map(), groups: [], full: false, last: null, ping: null, status: null, logs: { since: 0, rows: [], paused: false, busy: false, follow: true, warned: false } };
  const memState = { rows: [], editing: null };
  const toolState = { rows: [] };
  const envState = { rows: [] };
  const CARD_SPECS = new Map();
  let uid = 0;
  const hasAction = (id) => !state.catalog || state.actions.has(id);
  function missingNote(ids) {
    const missing = state.catalog ? ids.filter((id) => !state.actions.has(id)) : [];
    return missing.length ? `<div class="hint">服务端 catalog 缺少：${missing.map((m) => `<span class="mono">${esc(m)}</span>`).join('、')}（对应控件已跳过）</div>` : '';
  }
  function maskToken() { return state.token ? `••••${state.token.slice(-4)}` : '缺失'; }
  // token chip: 无鉴权 (server started with --no-auth) vs masked token vs genuinely missing
  function updateTokenChip() {
    const chip = $('#tokenChip'); if (!chip) return;
    chip.classList.toggle('danger', !state.noAuth && !state.token);
    if (state.noAuth) { chip.textContent = '无鉴权'; chip.className = 'chip'; chip.title = '服务端以 --no-auth 启动：本页无需 token'; }
    else if (state.token) { chip.className = 'chip'; chip.textContent = `token ${maskToken()}`; chip.title = '点击复制 token（地址栏已移除）'; }
    else { chip.className = 'chip danger'; chip.textContent = 'token 缺失'; chip.title = '缺少 token：请用 uppgui open 打开'; }
  }
  // ==== 2. transport (token, 401, errors) =================================
  async function api(path, opts = {}) {
    const headers = { 'X-UPP-Token': state.token, ...(opts.headers || {}) };
    let res;
    try { res = await fetch(path, { ...opts, headers }); }
    catch (err) { throw new Error(`无法连接本地服务 ${path}：${err.message}`); }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (res.status === 401) {
      showAuthBanner();
      throw new Error('unauthorized：token 无效或缺失，请用带 ?token=… 的地址重新打开');
    }
    if (!res.ok) throw new Error((json && (json.error || json.hint)) || `HTTP ${res.status} ${path}`);
    if (!json) throw new Error(`响应不是 JSON：${text.slice(0, 160)}`);
    return { json, text };
  }
  async function apiAction(action, params, full) {
    const { json, text } = await api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params, full }),
    });
    state.last = { action, params, full, at: Date.now(), bytesPretty: bytes(text), bytesCompact: bytes(JSON.stringify(json)), envelope: json };
    cliLog(action, params, full);
    updateAgent();
    if (json.ok === false) throw Object.assign(new Error(json.error || `action ${action} 失败`), { envelope: json });
    return json;
  }
  /** Run one action. Returns {ok, env} or {ok:false, error, hint}. Never throws. */
  async function call(action, wanted = {}, opts = {}) {
    logLocal('ui', `→ ${action} ${JSON.stringify(wanted)}${opts.full || state.full ? ' [full]' : ''}`);
    if (!hasAction(action)) return { ok: false, error: `服务端未提供 action「${action}」（不在 /api/catalog 中）`, missing: true };
    try {
      const env = await apiAction(action, buildParams(action, wanted), opts.full ?? state.full);
      return { ok: true, env };
    } catch (err) {
      const hint = err.envelope && err.envelope.hint;
      logLocal('error', `${action} 失败：${err.message}${hint ? ` · ${hint}` : ''}`);
      return { ok: false, error: err.message, hint };
    }
  }
  // ==== 3. params: semantic name -> real catalog arg, with type coercion ==
  const norm = (s) => String(s).toLowerCase().replace(/[-_\s]/g, '');
  function argsMeta(id) {
    const a = state.actions.get(id);
    if (!a || !Array.isArray(a.args) || !a.args.length) return null;
    const m = new Map();
    for (const arg of a.args) if (arg && arg.name) m.set(norm(arg.name), arg);
    return m.size ? m : null;
  }
  function cast(type, val, sem) {
    if (Array.isArray(val)) return type === 'string' ? val.join(sem === 'tags' ? ',' : ' ') : val;
    if (type === 'number') { const n = Number(val); return Number.isFinite(n) ? n : val; }
    if (type === 'boolean') return Boolean(val);
    if (type === 'array') return String(val).split(/\s+/).filter(Boolean);
    return String(val);
  }
  function buildParams(id, wanted) {
    const meta = argsMeta(id);
    const out = {};
    for (const [sem, raw] of Object.entries(wanted)) {
      if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) continue;
      if (!meta) { out[sem] = raw; continue; }
      let hit = null;
      for (const cand of ALIAS[sem] || [sem]) { const m = meta.get(norm(cand)); if (m) { hit = m; break; } }
      if (!hit) { logLocal('warn', `参数「${sem}」不在 ${id} 的 args 中，已忽略`); continue; }
      let val = cast(hit.type, raw, sem);
      // convention: an arg literally named noX / no-x is the inverse of the semantic flag
      if (hit.type === 'boolean' && /^no([A-Z-])/.test(hit.name)) val = !val;
      out[hit.name] = val;
    }
    return out;
  }
  // ==== 4. toasts / banner / log console ==================================
  function toast(msg, type = 'info', ms = 4200) {
    const box = $('#toasts'); if (!box) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="dot ${type === 'ok' ? 'ok' : type === 'err' ? 'bad' : type === 'warn' ? 'warn' : 'off'}"></span><span class="msg">${esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function showAuthBanner(msg) {
    const b = $('#authBanner'); if (!b) return;
    b.hidden = false;
    $('#authMsg').textContent = msg || 'Token 无效或缺失。请用 uppgui open 重新打开，或访问带 ?token=… 的地址。';
  }
  function logLineHTML(ev, fresh) {
    const lv = String(ev.level || 'info').toLowerCase();
    return `<div class="log-line lv-${esc(lv)}${fresh ? ' fresh' : ''}"><span class="t">${fmtClock(ev.ts)}</span><span class="lv">${esc(lv)}</span><span class="msg">${esc(ev.msg || '')}</span></div>`;
  }
  function appendLog(ev) {
    const body = $('#consoleBody'); if (!body) return;
    const filter = $('#logFilter') ? $('#logFilter').value : 'all';
    const lv = String(ev.level || 'info').toLowerCase();
    if (filter !== 'all' && lv !== filter) return;
    const empty = $('.log-empty', body); if (empty) empty.remove();
    body.insertAdjacentHTML('beforeend', logLineHTML(ev, true));
    const last = body.lastElementChild;
    setTimeout(() => last && last.classList.remove('fresh'), 900);
    while (body.children.length > 400) body.removeChild(body.firstChild);
    if (state.logs.follow) body.scrollTop = body.scrollHeight;
  }
  function pushLog(ev) {
    state.logs.rows.push(ev);
    if (state.logs.rows.length > 800) state.logs.rows.splice(0, state.logs.rows.length - 800);
    const pm = String(ev.msg || '').match(PAYLOAD_RE);
    if (pm && pm[1] !== state.payloadDir) { state.payloadDir = pm[1].trim(); updateAgent(); }
    appendLog(ev);
    updateLogMeta();
    renderMiniLog();
  }
  const logLocal = (level, msg) => pushLog({ ts: Date.now(), level, msg, local: true });
  function updateLogMeta() {
    const el = $('#logMeta'); if (!el) return;
    const last = state.logs.rows[state.logs.rows.length - 1];
    el.textContent = `${state.logs.rows.length} 条${state.logs.paused ? ' · 已暂停' : ` · ${last ? fmtClock(last.ts) : '—'}`}`;
  }
  function redrawLog() {
    const body = $('#consoleBody'); if (!body) return;
    const filter = $('#logFilter').value;
    const rows = state.logs.rows.filter((ev) => filter === 'all' || String(ev.level || 'info').toLowerCase() === filter).slice(-300);
    body.innerHTML = rows.length ? rows.map((ev) => logLineHTML(ev, false)).join('') : '<div class="log-empty">暂无日志 · 每 2s 轮询 /api/log</div>';
    if (state.logs.follow) body.scrollTop = body.scrollHeight;
    updateLogMeta();
  }
  function renderMiniLog() {
    const el = $('#ovLog'); if (!el) return;
    const rows = state.logs.rows.slice(-6);
    el.innerHTML = rows.length ? rows.map((ev) => logLineHTML(ev, false)).join('') : '<div class="log-empty">暂无日志</div>';
  }
  async function pollLog() {
    if (state.logs.paused || state.logs.busy) return;
    state.logs.busy = true;
    try {
      const { json } = await api(`/api/log?since=${state.logs.since}`);
      if (json.next != null) state.logs.since = json.next;
      for (const ev of Array.isArray(json.events) ? json.events : []) pushLog({ ts: ev.ts ?? Date.now(), level: ev.level, msg: ev.msg, seq: ev.seq });
    } catch (err) {
      if (!state.logs.warned && !/unauthorized/i.test(err.message)) {
        state.logs.warned = true;
        pushLog({ ts: Date.now(), level: 'warn', msg: `日志轮询失败：${err.message}` });
      }
    } finally { state.logs.busy = false; }
  }
  function cliLog(action, params, full) {
    const parts = Object.entries(params || {}).map(([k, v]) => `--param ${k}=${Array.isArray(v) ? v.join(',') : v}`);
    logLocal('ui', `uppgui action ${action}${parts.length ? ' ' + parts.join(' ') : ''}${full ? ' --full' : ''}`);
  }
  // ==== 5. render building blocks =========================================
  function jsonBlock(data, collapsed) {
    const txt = stringify(data);
    const pre = `<pre class="json-pre">${esc(txt)}</pre>`;
    return collapsed ? `<details class="json"><summary>JSON · ${bytes(txt)} B · 点击展开</summary>${pre}</details>` : `<div class="json">${pre}</div>`;
  }
  function resultHTML(env) {
    const txt = stringify(env.data);
    const bits = [env.action, env.tookMs != null ? `${env.tookMs}ms` : '', `${bytes(txt)} B`];
    if (env.truncated) bits.push('已截断 · 顶部 full 开关查看全量');
    if (env.note) bits.push(String(env.note));
    const next = Array.isArray(env.next) ? env.next : env.next ? [env.next] : [];
    return `<div class="result"><div class="result-head">${bits.map(esc).join(' · ')}</div>${jsonBlock(env.data, txt.split('\n').length > 40)}${next.length ? `<div class="next-list">${next.map((n) => `<span class="chip" data-copy="${esc(n)}" title="点击复制">${esc(n)}</span>`).join('')}</div>` : ''}</div>`;
  }
  function report(res, el) {
    if (el) el.innerHTML = res.ok ? resultHTML(res.env) : `<div class="errbox"><b>${esc(res.error)}</b>${res.hint ? `<div class="hint">提示：${esc(res.hint)}</div>` : ''}</div>`;
    if (res.ok) toast(`${res.env.action} ok${res.env.tookMs != null ? ` · ${res.env.tookMs}ms` : ''}${res.env.truncated ? ' · truncated' : ''}`, 'ok');
    else toast(res.error, 'err');
  }
  function table(cols, rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return opts.empty === '' ? '' : `<div class="empty">${esc(opts.empty || '暂无数据')}</div>`;
    const head = cols.map((c) => `<th${c.w ? ` style="width:${c.w}"` : ''}>${esc(c.label)}</th>`).join('');
    const body = list.map((raw, i) => {
      const r = raw && typeof raw === 'object' ? raw : { value: raw };
      const tds = cols.map((c) => `<td class="${c.cls || ''}">${c.render ? c.render(r, i) : esc(pick(r, String(c.key || 'value').split('|'), '—'))}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<div class="table-wrap${opts.tall ? ' tall' : ''}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function tagsHTML(tags) {
    const list = Array.isArray(tags) ? tags : String(tags == null ? '' : tags).split(',').filter(Boolean);
    return list.length ? `<div class="tags">${list.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : '';
  }
  /** Pretty for stats envelopes: {stats:{...}, doctor:{checks}} (mem.stats / tool.stats). */
  function statsHTML(d) {
    const stats = pick(d, ['stats'], null) || (d && typeof d === 'object' ? d : {});
    const checks = Array.isArray(pick(d, ['doctor.checks'], null)) ? d.doctor.checks : [];
    const byKind = pick(stats, ['byKind', 'kinds'], null);
    const bits = [];
    if (stats.entries != null) bits.push(`<span class="badge b-info">${esc(num(stats.entries))} 条记忆</span>`);
    if (stats.tools != null) bits.push(`<span class="badge b-info">${esc(num(stats.tools))} 个工具</span>`);
    if (stats.runs != null) bits.push(`<span class="badge">runs ${esc(num(stats.runs))}</span>`);
    if (stats.savedTokens != null) bits.push(`<span class="badge">节省 ${esc(num(stats.savedTokens))} tokens</span>`);
    if (byKind && typeof byKind === 'object') Object.entries(byKind).forEach(([k, v]) => bits.push(`<span class="badge b-kind">${esc(k)} ${esc(v)}</span>`));
    if (Array.isArray(stats.tags) && stats.tags.length) bits.push(`<span class="badge">tags: ${esc(stats.tags.join(', '))}</span>`);
    const sync = pick(stats, ['state.hosts'], null);
    const syncHTML = sync && typeof sync === 'object'
      ? Object.entries(sync).map(([h, s]) => `<div class="hint mono">${esc(h)}: ${esc(s && s.lastSyncAt ? fmtAge(s.lastSyncAt) : '未同步')}${s && s.mode ? ` · ${esc(s.mode)}` : ''}</div>`).join('')
      : '';
    const checksHTML = checks.length
      ? table([
        { label: '检查', cls: 'mono nowrap', render: (r) => esc(pick(r, ['check', 'name'], '—')) },
        { label: '结果', w: '80px', render: (r) => (r.ok === false ? '<span class="badge b-err">warn</span>' : '<span class="badge b-ok">ok</span>') },
        { label: '详情', cls: 'muted', render: (r) => esc(String(pick(r, ['detail'], ''))) },
      ], checks)
      : '';
    return `<div class="toolbar">${bits.join('') || '<span class="muted">—</span>'}</div>${syncHTML}${checksHTML}`;
  }
  function kvHTML(obj) {
    if (obj == null) return '<div class="muted">—</div>';
    if (typeof obj !== 'object') return `<div class="mono">${esc(stringify(obj))}</div>`;
    const rows = Object.entries(obj).map(([k, v]) => {
      const val = v && typeof v === 'object' ? stringify(v).replace(/\s+/g, ' ') : String(v);
      return `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`;
    }).join('');
    return rows ? `<dl class="kv">${rows}</dl>` : '<div class="muted">（空）</div>';
  }
  function fieldHTML(f) {
    const name = f.name;
    const attrs = `data-f="${name}"${f.list ? ` data-list="${f.list}"` : ''}`;
    const lab = `<span>${esc(f.label || name)}${f.req ? ' *' : ''}</span>`;
    if (f.type === 'area') return `<label class="field wide">${lab}<textarea ${attrs} rows="${f.rows || 3}" placeholder="${esc(f.ph || '')}">${esc(f.value || '')}</textarea></label>`;
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => { const [v, t] = Array.isArray(o) ? o : [o.v ?? o, o.t ?? o.v ?? o]; return `<option value="${esc(v)}"${String(f.value) === String(v) ? ' selected' : ''}>${esc(t)}</option>`; }).join('');
      return `<label class="field">${lab}<select ${attrs}>${opts}</select></label>`;
    }
    if (f.type === 'check') return `<label class="toggle field-inline"><input type="checkbox" ${attrs}${f.value ? ' checked' : ''}>${esc(f.label)}</label>`;
    if (f.type === 'chips') {
      const chips = (f.options || []).map((o) => {
        const [v, t] = Array.isArray(o) ? o : [o.v ?? o, o.t ?? o.v ?? o];
        const on = (f.value || []).includes(v);
        return `<label class="chip-check"><input type="checkbox" ${attrs} data-group="1" value="${esc(v)}"${on ? ' checked' : ''}>${esc(t)}</label>`;
      }).join('');
      return `<div class="field wide"><span>${esc(f.label)}</span><div class="chips">${chips}</div>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
    }
    return `<label class="field${f.wide ? ' wide' : ''}">${lab}<input ${attrs} type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.ph || '')}"></label>`;
  }
  function readForm(scope) {
    const out = {};
    $$('[data-f]', scope).forEach((el) => {
      const k = el.dataset.f;
      if (el.type === 'checkbox') {
        if (el.dataset.group) { (out[k] = out[k] || []); if (el.checked) out[k].push(el.value); }
        else out[k] = el.checked;
        return;
      }
      const v = String(el.value).trim();
      if (v === '') return;
      if (el.dataset.list === 'csv') out[k] = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      else if (el.dataset.list === 'argv') out[k] = v.split(/\s+/).filter(Boolean);
      else if (el.type === 'number') out[k] = Number(v);
      else out[k] = v;
    });
    return out;
  }
  function formBlock(spec) {
    const key = `cf${++uid}`;
    CARD_SPECS.set(key, spec);
    return `<div class="form" data-card="${key}">${(spec.fields || []).map(fieldHTML).join('')}${spec.extra || ''}
      <div class="form-actions"><button class="btn ${spec.danger ? 'danger' : 'primary'}" data-submit="${esc(spec.action)}">${esc(spec.submit || '运行')}</button>${spec.note ? `<span class="hint">${esc(spec.note)}</span>` : ''}</div></div>`;
  }
  const cardForm = (spec) => `<section class="card"><header class="card-head"><h2>${esc(spec.title)}</h2>${spec.sub ? `<span class="muted mono">${esc(spec.sub)}</span>` : ''}</header>${formBlock(spec)}${spec.slot ? `<div class="result-slot" id="${esc(spec.slot)}"></div>` : ''}</section>`;
  function armConfirm(btn, msg) {
    if (btn.dataset.armed === '1') {
      delete btn.dataset.armed; btn.classList.remove('armed');
      btn.textContent = btn.dataset.origin || btn.textContent;
      return true;
    }
    btn.dataset.origin = btn.textContent; btn.dataset.armed = '1';
    btn.classList.add('armed'); btn.textContent = msg || '再次点击确认';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      if (btn.dataset.armed === '1') { delete btn.dataset.armed; btn.classList.remove('armed'); btn.textContent = btn.dataset.origin; }
    }, 4000);
    return false;
  }
  function bindCards(scope) {
    $$('[data-card]', scope).forEach((form) => {
      const spec = CARD_SPECS.get(form.dataset.card); if (!spec) return;
      const btn = $('[data-submit]', form); if (!btn) return;
      const fire = async () => {
        const wanted = readForm(form);
        for (const k of spec.required || []) {
          const v = wanted[k];
          if (v == null || v === '' || (Array.isArray(v) && !v.length)) {
            toast(`请填写「${k}」`, 'warn');
            const el = $(`[data-f="${k}"]`, form); if (el) el.focus();
            return;
          }
        }
        if (spec.confirm && !armConfirm(btn, spec.confirm)) return;
        btn.disabled = true;
        try {
          const res = await call(spec.action, wanted);
          report(res, spec.out ? $(spec.out) : null);
          if (res.ok && spec.after) await spec.after(res, form);
        } finally { btn.disabled = false; }
      };
      btn.addEventListener('click', fire);
      form.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); fire(); } });
    });
  }
  function openDialog(title, body, foot) {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = body;
    $('#dlgFoot').innerHTML = foot;
    const dlg = $('#dlg');
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    const first = $('#dlgBody input, #dlgBody textarea'); if (first) first.focus();
  }
  function closeDialog() { const dlg = $('#dlg'); if (dlg.open) dlg.close(); else dlg.removeAttribute('open'); }
  async function copy(text, label) {
    if (text == null) return;
    try { await navigator.clipboard.writeText(String(text)); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = String(text); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(`${label || '已复制'} · ${bytes(text)} B`, 'ok', 2200);
  }
  // ==== 6. nav / routing / status =========================================
  function renderNav() {
    const nav = $('#nav');
    nav.innerHTML = NAV.map((g) => {
      const exp = EXPECTED[g.id];
      let badge = '<span class="nav-count" title="纯 UI 面板：无 action">UI</span>';
      let cls = '';
      let attr = g.title;
      if (exp) {
        const missing = state.catalog ? exp.filter((id) => !state.actions.has(id)) : [];
        const have = exp.length - missing.length;
        badge = `<span class="nav-count" title="本组 ${exp.length} 个操作，已接入 ${state.catalog ? have : '?'}">${state.catalog ? `${have}/${exp.length}` : '?'}</span>`;
        if (state.catalog && have === 0) cls = ' off';
        attr = `${g.title} · 本组 ${exp.length} 个操作${missing.length ? ` · 缺少: ${missing.join(', ')}` : ''}`;
      }
      return `<a class="nav-item${cls}" href="#/${g.id}" data-g="${g.id}" title="${esc(attr)}"><svg class="ic"><use href="#i-${g.icon}"/></svg><span>${esc(g.title)}</span>${badge}</a>`;
    }).join('');
    $$('.nav-item').forEach((a) => { a.classList.toggle('active', a.dataset.g === state.route); });
  }
  function route() {
    const id = (location.hash.match(/^#\/([a-z]+)/) || [])[1] || 'overview';
    state.route = NAV.some((g) => g.id === id) ? id : 'overview';
    const meta = NAV.find((g) => g.id === state.route);
    $('#pageTitle').textContent = meta.title;
    $('#pageSub').textContent = meta.sub;
    $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.g === state.route));
    const view = $('#view');
    view.innerHTML = ''; view.scrollTop = 0;
    CARD_SPECS.clear();
    RENDER[state.route](view);
  }
  function setStatus(ok, label, kind) {
    const cls = `dot ${kind || (ok ? 'ok' : 'bad')}`;
    $('#statusDot').className = cls; $('#railDot').className = cls;
    $('#statusText').textContent = label;
    $('#statusText').title = label;
  }
  async function ping() {
    try {
      const { json } = await api('/api/ping');
      state.ping = json;
      // /api/ping has no noAuth field today: a successful ping without a token can only mean auth is off
      state.noAuth = json.noAuth === true || !state.token;
      updateTokenChip();
      setStatus(true, `${json.app || 'uppgui'} ${json.version || ''}`, 'ok');
      $('#actionCount').textContent = `${json.actionCount ?? state.actionCountLabel ?? '—'} actions`;
      $('#railVersion').textContent = `v${json.version || '—'}`;
      $('#railMeta').textContent = `up ${fmtDur(json.uptimeMs)} · pid ${json.pid ?? '—'}`;
      updateAgent();
      $('#authBanner').hidden = true;
    } catch (err) {
      setStatus(false, err.message, /unauthorized/.test(err.message) ? 'warn' : 'bad');
    }
  }
  async function loadCatalog() {
    try {
      const { json } = await api('/api/catalog');
      state.catalog = json;
      state.groups = Array.isArray(json.groups) ? json.groups : [];
      state.actions.clear();
      for (const g of state.groups) for (const a of g.actions || []) if (a && a.id) state.actions.set(a.id, { ...a, group: g.id });
      $('#actionCount').textContent = `${state.actions.size} actions`;
      state.actionCountLabel = state.actions.size;
    } catch (err) {
      toast(`catalog 加载失败：${err.message}（界面仍会渲染，调用时再报错）`, 'err', 6000);
    }
    renderNav();
  }
  // ==== 7. overview ======================================================
  const QUICK = [['status', '刷新状态'], ['doctor', '体检'], ['mem.stats', '记忆统计'], ['tool.stats', '工具统计'], ['env.scan', '环境扫描'], ['mem.hosts', '记忆宿主']];
  function hostRows(d) {
    const h = pick(d, ['hosts', 'hostAvailability', 'adapters', 'hostList'], null);
    if (!h) return [];
    if (Array.isArray(h)) return h.map((x) => (typeof x === 'string' ? { host: x, available: true } : x || {}));
    return Object.entries(h).map(([host, v]) => (v && typeof v === 'object' ? { host, ...v } : { host, available: v !== false }));
  }
  function versionOf(v) {
    const raw = v && typeof v === 'object' ? String(v.version ?? v.raw ?? v.name ?? '') : String(v ?? '');
    const m = raw.match(/\d+(?:\.\d+)+(?:[-+][\w.]+)?/);
    return m ? m[0] : raw.replace(/^\S+\s+/, '').trim();
  }
  function chainSummary(chain) {
    if (!chain) return 'upp / uppmem / upptool / uppenv';
    if (typeof chain === 'string') return chain;
    if (Array.isArray(chain)) return chain.map((c) => (typeof c === 'string' ? c : `${c.name || c.id} ${versionOf(c)}`.trim())).join(' · ');
    return Object.entries(chain).map(([k, v]) => `${TC_LABEL[k] || k} ${versionOf(v) || '—'}`).join(' · ');
  }
  function kindSummary(mem) {
    const by = pick(mem, ['byKind', 'kinds', 'breakdown'], null);
    if (by && typeof by === 'object') return Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ');
    const updated = pick(mem, ['updatedAt', 'updated'], null);
    return updated ? `更新 ${fmtAge(updated)}` : '';
  }
  function runsSummary(t) {
    if (!t || typeof t !== 'object') return '';
    const runs = pick(t, ['runs', 'totalRuns'], null);
    const saved = pick(t, ['savedTokens', 'tokensSaved'], null);
    return [runs != null ? `runs ${num(runs)}` : '', saved != null ? `节省 ${num(saved)} tokens` : ''].filter(Boolean).join(' · ');
  }
  function renderOverview(view) {
    view.innerHTML = `
      <div class="cards" id="ovCards">${'<div class="skel"></div>'.repeat(5)}</div> <section class="card"><header class="card-head"><h2>快速操作</h2><span class="muted">等价 CLI / MCP 调用写入下方日志</span></header> <div class="quick">${QUICK.map(([id, label]) => `<button class="btn sm" data-quick="${id}"${hasAction(id) ? '' : ' disabled'}>${esc(label)}</button>`).join('')}</div>
        ${missingNote(QUICK.map((q) => q[0]))}
        <div id="ovQuickOut" class="result-slot"></div> </section> <section class="card"><header class="card-head"><h2>doctor 结果</h2><button class="btn sm ghost" id="ovDoctor">重新体检</button></header> <div id="ovDoctorOut" class="muted">正在检查…</div> </section> <section class="card"><header class="card-head"><h2>日志尾部</h2><span class="muted">完整日志见下方控制台</span></header> <div id="ovLog" class="mini-log"><div class="log-empty">暂无日志</div></div> </section>`;
    $$('[data-quick]', view).forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.quick;
      const res = await call(id, {});
      report(res, $('#ovQuickOut'));
      if (res.ok && (id === 'status' || id === 'doctor')) loadCards();
    }));
    $('#ovDoctor').addEventListener('click', () => loadDoctor());
    renderMiniLog();
    loadCards();
    loadDoctor();
  }
  async function loadCards() {
    const wrap = $('#ovCards'); if (!wrap) return;
    if (!state.ping) await ping();
    try { state.status = (await api('/api/status')).json; }
    catch (err) { wrap.innerHTML = `<div class="errbox">/api/status 读取失败：${esc(err.message)}</div>`; return; }
    const d = (state.status && (state.status.data ?? state.status)) || {};
    const hosts = hostRows(d);
    const mem = pick(d, ['memory', 'mem', 'memoryPool'], {}) || {};
    const toolsInfo = pick(d, ['tools', 'toolRegistry', 'tool'], {}) || {};
    const nodeV = pick(d, ['node', 'nodeVersion', 'runtime.node'], null);
    const chain = pick(d, ['toolchain', 'versions', 'components'], null);
    const okHosts = hosts.filter((h) => h.available !== false && h.detected !== false && h.ok !== false).length;
    const p = state.ping || {};
    const cards = [
      ['Node', nodeV == null ? '—' : typeof nodeV === 'object' ? pick(nodeV, ['version'], '—') : String(nodeV), [pick(d, ['platform', 'os'], ''), pick(d, ['arch'], '')].filter(Boolean).join(' ') || (nodeV == null ? 'status 未提供 node' : '')],
      ['工具链', p.version ? `uppgui ${p.version}` : '—', chainSummary(chain)],
      ['三端可用', hosts.length ? `${okHosts}/${hosts.length}` : '—', hosts.length ? hosts.map((h) => `${h.host || '?'}${h.available === false ? '(×)' : ''}`).join(' · ') : 'status 未提供 hosts'],
      ['记忆池', countOf(mem), kindSummary(mem) || 'mem.stats 查看明细'],
      ['工具数', countOf(toolsInfo), runsSummary(toolsInfo) || 'tool.stats 查看明细'],
    ];
    wrap.innerHTML = cards.map(([k, v, s]) => `<div class="stat"><span class="k">${esc(k)}</span><span class="v" title="${esc(v)}">${esc(v)}</span><span class="s clamp2" title="${esc(s)}">${esc(s)}</span></div>`).join('');
  }
  async function loadDoctor() {
    const out = $('#ovDoctorOut'); if (!out) return;
    if (!hasAction('doctor')) { out.innerHTML = '<div class="hint">服务端未提供 doctor action</div>'; return; }
    out.innerHTML = '<span class="muted">正在体检…</span>';
    const res = await call('doctor', {});
    if (!res.ok) { out.innerHTML = `<div class="errbox"><b>doctor 失败：</b>${esc(res.error)}</div>`; return; }
    const d = res.env.data ?? {};
    const checks = Array.isArray(d) ? d : Array.isArray(d.checks) ? d.checks : null;
    if (!checks) { out.innerHTML = jsonBlock(d, false); return; }
    const bad = checks.filter((c) => c && (c.ok === false || c.status === 'fail')).length;
    out.innerHTML = `<div class="toolbar"><span class="badge ${bad ? 'b-warn' : 'b-ok'}">${bad ? `${bad} 项告警` : '全部通过'}</span><span class="muted">共 ${checks.length} 项检查</span></div>
      ${table([
        { label: '检查项', cls: 'mono nowrap', render: (r) => esc(pick(r, ['check', 'name', 'label', 'id'], '—')) },
        { label: '结果', w: '88px', render: (r) => (r.ok === false || r.status === 'fail' ? '<span class="badge b-err">warn</span>' : '<span class="badge b-ok">ok</span>') },
        { label: '详情', cls: 'muted', render: (r) => esc(pick(r, ['detail', 'reason', 'message', 'version'], '')) },
      ], checks)}`;
  }
  // ==== 8. memory ========================================================
  function renderMemory(view) {
    view.innerHTML = `
      <section class="card"><header class="card-head"><h2>记忆检索</h2><span class="muted mono">mem.search · mem.list</span></header> <div class="toolbar"> <input id="memQ" class="grow" data-search type="search" placeholder="关键词…（/ 聚焦，Enter 搜索）" value="${esc(memState.query)}">
          <select id="memKind" class="mini"><option value="">全部 kind</option>${MEM_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}</select> <button class="btn primary" id="memSearch"><svg class="ic"><use href="#i-search"/></svg>搜索</button> <button class="btn ghost" id="memList">最近 50 条</button>
          <label class="toggle"><input type="checkbox" id="memAll"> 显示全文</label> </div> <div id="memTable"><div class="empty">输入关键词开始检索，或点「最近 50 条」。</div></div> <div id="memCount" class="hint"></div> <div id="memRaw" class="result-slot"></div> </section>
      ${missingNote(['mem.search', 'mem.list', 'mem.add', 'mem.update', 'mem.rm', 'mem.sync', 'mem.install', 'mem.stats'])}
      <div class="grid2">
        ${cardForm({
          title: '新增记忆', sub: 'mem.add', action: 'mem.add', submit: '写入记忆池', out: '#memAddOut', slot: 'memAddOut',
          fields: [
            { name: 'kind', label: 'kind', type: 'select', options: MEM_KINDS, value: 'fact' },
            { name: 'text', label: '正文 text', type: 'area', req: true, ph: '要长期记住的事实 / 偏好 / 决策…' },
            { name: 'key', label: '语义 key（可选）', ph: 'pref.reply.lang' },
            { name: 'tags', label: 'tag（逗号分隔，可选）', ph: 'lang,ui', list: 'csv' },
          ],
          required: ['text'],
          after: () => loadMem('list'),
        })}
        <section class="card"><header class="card-head"><h2>同步三端</h2><span class="muted mono">mem.sync</span></header>
          ${formBlock({
            action: 'mem.sync', submit: '开始同步', confirm: '确认同步三端记忆？',
            fields: [
              { name: 'hosts', label: '目标宿主 hosts', type: 'chips', options: HOSTS, value: HOSTS },
              { name: 'direction', label: '方向 direction（both = --both 双向）', type: 'select', options: ['both', 'pull', 'push'], value: 'both' },
              { name: 'dryRun', label: '试运行 dry-run（不写入任何文件）', type: 'check' },
            ],
            required: ['hosts'],
            note: '危险操作：先跑 dry-run 看计划更安全',
          })}
          <div class="divider"></div> <div class="form-sub">注册 MCP</div>
          ${formBlock({
            action: 'mem.install', submit: '写入 MCP 配置',
            fields: [
              { name: 'hosts', label: '写入哪些宿主', type: 'chips', options: HOSTS, value: HOSTS },
              { name: 'remove', label: '移除注册（--remove）', type: 'check' },
              { name: 'dryRun', label: '试运行 dry-run', type: 'check' },
            ],
            required: ['hosts'],
          })}
        </section> </div> <section class="card"><header class="card-head"><h2>统计</h2><span class="muted mono">mem.stats</span><button class="btn sm ghost" id="memStatsBtn">刷新</button></header> <div id="memStats" class="muted">点「刷新」加载</div> </section>`;
    const fireSearch = () => loadMem('search');
    $('#memSearch').addEventListener('click', fireSearch);
    $('#memQ').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); fireSearch(); } });
    $('#memList').addEventListener('click', () => loadMem('list'));
    $('#memKind').addEventListener('change', () => loadMem(memState.query ? 'search' : 'list'));
    $('#memAll').addEventListener('change', renderMemTable);
    $('#memTable').addEventListener('click', (e) => {
      const view = e.target.closest('[data-view]');
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (view) openMemView(Number(view.dataset.view));
      if (edit) openMemEdit(Number(edit.dataset.edit));
      if (del) removeMem(Number(del.dataset.del), del);
    });
    $('#memStatsBtn').addEventListener('click', loadMemStats);
    bindCards(view);
    loadMem('list');
    loadMemStats();
  }
  async function loadMem(mode) {
    const q = ($('#memQ') ? $('#memQ').value : '').trim();
    memState.query = q;
    const kind = $('#memKind') ? $('#memKind').value : '';
    const useSearch = mode === 'search' && Boolean(q);
    const wanted = { limit: 50 };
    if (kind) wanted.kind = kind;
    if (useSearch) wanted.query = q;
    $('#memSearch').disabled = true;
    const res = useSearch ? await call('mem.search', wanted) : await call('mem.list', wanted);
    if ($('#memSearch')) $('#memSearch').disabled = false;
    if (!res.ok) { $('#memTable').innerHTML = `<div class="errbox"><b>读取失败：</b>${esc(res.error)}</div>`; $('#memCount').textContent = ''; return; }
    const rows = pick(res.env.data, ['entries', 'items', 'rows', 'results'], []);
    memState.rows = Array.isArray(rows) ? rows : [];
    renderMemTable();
    $('#memRaw').innerHTML = jsonBlock(res.env.data, true);
    $('#memCount').textContent = `共 ${memState.rows.length} 条${q ? ` · 关键词 “${q}”` : ''}${res.env.truncated ? '（已截断：打开 full 查看全部）' : ''}`;
  }
  function renderMemTable() {
    const all = $('#memAll') && $('#memAll').checked;
    const cols = [
      { label: 'kind', w: '100px', render: (r) => `<span class="badge b-kind">${esc(pick(r, ['kind', 'type'], '—'))}</span>` },
      { label: 'key', w: '16%', cls: 'mono', render: (r) => esc(pick(r, ['key'], '—')) },
      { label: 'text', render: (r) => `<div class="${all ? '' : 'clamp2'}">${esc(pick(r, ['text', 'content', 'value'], ''))}</div>${tagsHTML(r.tags)}` },
      { label: 'updated', w: '100px', cls: 'mono nowrap', render: (r) => esc(fmtAge(pick(r, ['updatedAt', 'updated', 'ts'], null))) },
      { label: '', w: '148px', cls: 'actions', render: (r, i) => `<button class="link-btn" data-view="${i}">查看</button><button class="link-btn" data-edit="${i}">编辑</button><button class="link-btn danger" data-del="${i}">删除</button>` },
    ];
    $('#memTable').innerHTML = table(cols, memState.rows, { empty: '记忆池为空 · 用下方「新增记忆」写入第一条' });
  }
  function openMemEdit(i) {
    const row = memState.rows[i]; if (!row) return;
    memState.editing = row;
    const ref = pick(row, ['id', 'key'], null);
    const fields = [
      { name: 'kind', label: 'kind', type: 'select', options: MEM_KINDS, value: pick(row, ['kind', 'type'], 'fact') },
      { name: 'text', label: '正文 text', type: 'area', rows: 5, value: pick(row, ['text', 'content'], '') },
      { name: 'tags', label: 'tag（逗号分隔）', list: 'csv', value: Array.isArray(row.tags) ? row.tags.join(',') : String(row.tags || '') },
    ];
    openDialog('编辑记忆', `<div class="hint mono">ref: ${esc(ref ?? '—')} · key: ${esc(pick(row, ['key'], '—'))}（key 不可改）</div><div class="form" id="dlgForm">${fields.map(fieldHTML).join('')}</div><div id="dlgOut" class="result-slot"></div>`,
      '<button class="btn" id="dlgCancel">取消</button><button class="btn primary" id="dlgSave">保存</button>');
    $('#dlgCancel').addEventListener('click', closeDialog);
    $('#dlgSave').addEventListener('click', async () => {
      const res = await call('mem.update', { ref: ref ?? undefined, ...readForm($('#dlgForm')) });
      if (!res.ok) { report(res, $('#dlgOut')); return; }
      closeDialog(); toast('已更新', 'ok'); loadMem(memState.query ? 'search' : 'list'); loadMemStats();
    });
  }
  async function openMemView(i) {
    const row = memState.rows[i]; if (!row) return;
    const ref = pick(row, ['id', 'key'], null);
    const res = await call('mem.get', { ref: ref ?? undefined });
    const body = res.ok ? res.env.data : { error: res.error, hint: res.hint };
    openDialog(`记忆详情${ref ? ` · ${ref}` : ''}`, `${jsonBlock(body, true)}<div class="result-slot" id="dlgOut"></div>`,
      '<button class="btn" id="dlgCancel">关闭</button>');
    $('#dlgCancel').addEventListener('click', closeDialog);
  }
  async function removeMem(i, btn) {
    const row = memState.rows[i]; if (!row) return;
    if (!armConfirm(btn, '确认删除？')) return;
    const ref = pick(row, ['id', 'key'], null);
    const res = await call('mem.rm', { ref: ref ?? undefined });
    if (!res.ok) { toast(res.error, 'err'); return; }
    toast('已删除', 'ok');
    loadMem(memState.query ? 'search' : 'list');
    loadMemStats();
  }
  async function loadMemStats() {
    const el = $('#memStats'); if (!el) return;
    const res = await call('mem.stats', {});
    el.innerHTML = res.ok ? statsHTML(res.env.data) : `<div class="errbox">${esc(res.error)}</div>`;
  }
  // ==== 9. tools =========================================================
  function renderTools(view) {
    view.innerHTML = `
      <section class="card"><header class="card-head"><h2>工具清单</h2><span class="muted mono">tool.list</span><button class="btn sm ghost" id="toolRefresh">刷新</button></header> <div id="toolTable"><div class="empty">加载中…</div></div> <div id="toolCount" class="hint"></div> </section>
      ${missingNote(['tool.list', 'tool.show', 'tool.run', 'tool.add', 'tool.suggest', 'tool.stats'])}
      <div class="grid2"> <section class="card"><header class="card-head"><h2>运行工具</h2><span class="muted mono">tool.run</span></header> <div class="form" id="toolRunForm"> <label class="field"><span>工具</span><select id="toolPick"><option value="">— 选择工具 —</option></select></label> <label class="field wide"><span>argv（空格分隔）</span><input id="toolArgv" placeholder="book.xlsx out.csv"></label> <label class="field"><span>cwd（可选）</span><input id="toolCwd" placeholder="H:/work"></label>
            <div class="form-actions"><button class="btn primary" id="toolRunBtn"><svg class="ic"><use href="#i-play"/></svg>运行</button><span class="hint">Ctrl+Enter 也可运行</span></div> </div> <div id="toolOut" class="terminal" hidden></div> </section>
        ${cardForm({
          title: '注册工具', sub: 'tool.add', action: 'tool.add', submit: '注册', out: '#toolAddOut', slot: 'toolAddOut',
          fields: [
            { name: 'path', label: '脚本 / 目录路径', req: true, ph: './scripts/sheet-to-csv.mjs' },
            { name: 'name', label: '工具名（可选）', ph: 'sheet-to-csv' },
            { name: 'tags', label: 'tag（逗号分隔）', ph: 'xlsx,csv', list: 'csv' },
            { name: 'desc', label: '描述（可选）', ph: '把 xlsx 转成 csv' },
          ],
          required: ['path'], after: () => loadTools(),
        })}
      </div> <div class="grid2">
        ${cardForm({
          title: '工具建议', sub: 'tool.suggest', action: 'tool.suggest', submit: '查找', out: '#toolSuggestOut', slot: 'toolSuggestOut',
          fields: [{ name: 'query', label: '任务描述', req: true, ph: '把表格转成 csv' }],
          required: ['query'],
          after: (res) => { const el = $('#toolSuggestOut'); if (el) el.innerHTML = suggestHTML(res.env.data); },
        })}
        <section class="card"><header class="card-head"><h2>统计</h2><span class="muted mono">tool.stats</span><button class="btn sm ghost" id="toolStatsBtn">刷新</button></header> <div id="toolStats" class="muted">加载中…</div> </section> </div>`;
    $('#toolRefresh').addEventListener('click', loadTools);
    $('#toolStatsBtn').addEventListener('click', loadToolStats);
    $('#toolRunBtn').addEventListener('click', runTool);
    $('#toolArgv').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runTool(); } });
    $('#toolTable').addEventListener('click', (e) => {
      const fill = e.target.closest('[data-fill-tool]');
      const show = e.target.closest('[data-show-tool]');
      if (fill) fillTool(fill.dataset.fillTool);
      if (show) showTool(show.dataset.showTool);
    });
    view.addEventListener('click', (e) => {
      const fill = e.target.closest('[data-fill-tool]');
      if (fill && !e.target.closest('#toolTable')) fillTool(fill.dataset.fillTool);
    });
    bindCards(view);
    loadTools();
    loadToolStats();
  }
  async function loadTools() {
    const res = await call('tool.list', {});
    if (!res.ok) { $('#toolTable').innerHTML = `<div class="errbox">${esc(res.error)}</div>`; return; }
    const rows = pick(res.env.data, ['tools', 'entries', 'items', 'rows'], []);
    toolState.rows = Array.isArray(rows) ? rows : [];
    renderToolTable();
  }
  function renderToolTable() {
    const cols = [
      { label: '工具', cls: 'mono', render: (r) => `<b>${esc(pick(r, ['id', 'name'], '—'))}</b>` },
      { label: 'runtime', w: '110px', render: (r) => `<span class="badge">${esc(pick(r, ['runtime', 'kind'], '—'))}</span>` },
      { label: 'runs', w: '72px', cls: 'num', render: (r) => esc(num(pick(r, ['runs'], 0))) },
      { label: '节省 tokens', w: '110px', cls: 'num', render: (r) => esc(num(pick(r, ['savedTokens', 'saved'], 0))) },
      { label: '描述', cls: 'muted', render: (r) => esc(pick(r, ['description', 'desc', 'summary'], '')) },
      { label: '', w: '96px', cls: 'actions', render: (r) => { const id = pick(r, ['id', 'name'], ''); return `<button class="link-btn" data-fill-tool="${esc(id)}">运行</button><button class="link-btn" data-show-tool="${esc(id)}">详情</button>`; } },
    ];
    $('#toolTable').innerHTML = table(cols, toolState.rows, { empty: '还没有注册工具 · upptool add <file> --name x' });
    $('#toolCount').textContent = `共 ${toolState.rows.length} 个工具`;
    const sel = $('#toolPick');
    if (sel) sel.innerHTML = '<option value="">— 选择工具 —</option>' + toolState.rows.map((r) => { const id = pick(r, ['id', 'name'], ''); return `<option value="${esc(id)}">${esc(id)}</option>`; }).join('');
  }
  function fillTool(id) {
    const sel = $('#toolPick'); if (!sel || !id) return;
    if (!Array.from(sel.options).some((o) => o.value === id)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(id)}">${esc(id)}</option>`);
    sel.value = id;
    const argv = $('#toolArgv'); if (argv) argv.focus();
    toast(`已选择 ${id}`, 'info', 1600);
  }
  async function showTool(id) {
    openDialog(`工具详情 · ${id}`, '<div class="muted">加载中…</div>', '<button class="btn" id="dlgCancel">关闭</button>');
    $('#dlgCancel').addEventListener('click', closeDialog);
    const res = await call('tool.show', { id });
    $('#dlgBody').innerHTML = res.ok ? `<div class="result-head">${esc(res.env.action)} · ${res.env.tookMs ?? 0}ms</div>${jsonBlock(res.env.data, false)}` : `<div class="errbox">${esc(res.error)}</div>`;
  }
  async function runTool() {
    const tool = $('#toolPick').value;
    if (!tool) { toast('请选择工具', 'warn'); $('#toolPick').focus(); return; }
    const argv = $('#toolArgv').value.trim();
    const cwd = $('#toolCwd').value.trim();
    const out = $('#toolOut'); out.hidden = false; out.innerHTML = '<div class="ln dim">运行中…</div>';
    const btn = $('#toolRunBtn'); btn.disabled = true;
    const res = await call('tool.run', { id: tool, args: argv ? argv.split(/\s+/).filter(Boolean) : undefined, cwd: cwd || undefined });
    btn.disabled = false;
    if (!res.ok) { out.innerHTML = `<div class="ln bad">错误: ${esc(res.error)}</div>`; toast(res.error, 'err'); return; }
    out.innerHTML = terminalHTML(res.env.data);
    toast('tool.run 完成', 'ok');
    loadTools();
  }
  function terminalHTML(data) {
    const code = pick(data, ['code', 'exitCode', 'status'], null);
    const stdout = String(pick(data, ['stdout', 'out', 'output'], ''));
    const stderr = String(pick(data, ['stderr', 'err'], ''));
    const lines = [];
    if (code != null) lines.push(`<div class="ln meta">exit ${esc(code)}</div>`);
    stdout.split(/\r?\n/).forEach((l) => lines.push(`<div class="ln">${esc(l) || '&nbsp;'}</div>`));
    stderr.trim().split(/\r?\n/).filter(Boolean).forEach((l) => lines.push(`<div class="ln bad">${esc(l)}</div>`));
    if (!lines.length) lines.push('<div class="ln dim">(无输出)</div>');
    const head = lines.length > 400 ? `<div class="ln dim">… 共 ${lines.length} 行，仅显示末尾 400 行（打开 full 获取全量）</div>` : '';
    return head + lines.slice(-400).join('');
  }
  function suggestHTML(data) {
    const rows = Array.isArray(data) ? data : pick(data, ['matches', 'tools', 'entries', 'suggestions', 'results'], []);
    if (!Array.isArray(rows) || !rows.length) return '<div class="empty">没有匹配的工具 · 可用 tool.add 注册新工具</div>';
    return rows.map((r) => {
      const id = pick(r, ['id', 'name'], '—');
      return `<div class="infobox" style="display:flex;gap:8px;align-items:center;margin-top:6px"><b class="mono">${esc(id)}</b><span class="muted">${esc(pick(r, ['desc', 'summary', 'reason'], ''))}</span>${r.score != null ? `<span class="badge b-info">${esc(r.score)}</span>` : ''}<button class="link-btn" data-fill-tool="${esc(id)}" style="margin-left:auto">填入运行</button></div>`;
    }).join('');
  }
  async function loadToolStats() {
    const el = $('#toolStats'); if (!el) return;
    const res = await call('tool.stats', {});
    el.innerHTML = res.ok ? statsHTML(res.env.data) : `<div class="errbox">${esc(res.error)}</div>`;
  }
  // ==== 10. env ==========================================================
  function renderEnv(view) {
    view.innerHTML = `
      <section class="card"><header class="card-head"><h2>资产扫描</h2><span class="muted mono">env.scan · 按 host 分组</span> <button class="btn sm ghost" id="envToolsBtn">MCP 工具面</button> <button class="btn sm ghost" id="envScanBtn">重新扫描</button></header> <div id="envScan"><div class="empty">扫描中…</div></div> <div id="envScanRaw" class="result-slot"></div> </section>
      ${missingNote(['env.scan', 'env.export', 'env.import', 'env.verify', 'env.inspect', 'env.rollback', 'env.tools'])}
      <div class="grid2">
        ${cardForm({
          title: '导出镜像', sub: 'env.export', action: 'env.export', submit: '导出', out: '#envExportOut', slot: 'envExportOut',
          fields: [
            { name: 'out', label: '输出文件', req: true, ph: 'dist/env.uppenv' },
            { name: 'kinds', label: '资产类别 kinds', type: 'chips', options: ENV_KINDS, value: ENV_KINDS, hint: '只导出勾选的类别' },
            { name: 'hosts', label: '宿主 hosts', type: 'chips', options: HOSTS, value: HOSTS },
            { name: 'sign', label: '附加 ed25519 签名（--sign）', type: 'check', value: true },
            { name: 'probe', label: '探测 MCP 工具面（probe tools）', type: 'check', value: true },
          ],
          required: ['out'], after: () => loadEnvScan(),
        })}
        <section class="card"><header class="card-head"><h2>导入 / 校验 / 回滚</h2><span class="muted mono">env.import · verify · inspect · rollback</span></header> <div class="form"> <label class="field wide"><span>镜像文件路径</span><input id="envFile" placeholder="dist/env.uppenv"></label> <div class="form-row three">
              <label class="toggle field-inline"><input type="checkbox" id="envRequireSig"> 需要签名</label> <label class="field"><span>on-conflict</span><select id="envConflict"><option value="skip">skip</option><option value="overwrite">overwrite</option><option value="rename">rename</option></select></label>
              <span class="hint" style="align-self:center">先点「计划预览」最安全</span> </div> <div class="form-row three"> <label class="field wide"><span>回滚事务 tx（留空 = 最近一次 --last）</span><input id="envTx" placeholder="tx_20261101_..."></label> </div> <div class="form-actions">
              <button class="btn primary" id="envPlanBtn">计划预览</button> <button class="btn danger" id="envImportBtn">确认导入</button> <button class="btn ghost" id="envVerifyBtn">校验</button> <button class="btn ghost" id="envInspectBtn">概览</button> <button class="btn ghost" id="envRollbackBtn">回滚</button> </div> </div> <div class="section-sub">计划预览（dry-run payload）</div> <div id="envPlan" class="muted">导入前先点「计划预览」，这里会显示 dry-run 结果。</div> <div id="envImportOut" class="result-slot"></div> </section> </div>`;
    $('#envScanBtn').addEventListener('click', loadEnvScan);
    $('#envToolsBtn').addEventListener('click', async () => {
      const res = await call('env.tools', {});
      if (res.ok) $('#envScanRaw').innerHTML = `<div class="result-head">env.tools</div>${jsonBlock(res.env.data, false)}`;
      else toast(res.error, 'err');
    });
    $('#envPlanBtn').addEventListener('click', () => doImport(true));
    $('#envImportBtn').addEventListener('click', (e) => { if (armConfirm(e.currentTarget, '确认写入环境？')) doImport(false); });
    $('#envVerifyBtn').addEventListener('click', () => fileAction('env.verify', { requireSignature: $('#envRequireSig').checked }));
    $('#envInspectBtn').addEventListener('click', () => fileAction('env.inspect'));
    $('#envRollbackBtn').addEventListener('click', (e) => {
      const tx = ($('#envTx').value || '').trim();
      if (!armConfirm(e.currentTarget, `确认回滚${tx ? `事务 ${tx}` : '最后一次导入'}？`)) return;
      call('env.rollback', tx ? { tx } : {}).then((res) => report(res, $('#envImportOut')));
    });
    bindCards(view);
    loadEnvScan();
  }
  async function loadEnvScan() {
    const el = $('#envScan'); if (!el) return;
    const res = await call('env.scan', {});
    if (!res.ok) { el.innerHTML = `<div class="errbox">${esc(res.error)}</div>`; return; }
    const rows = Array.isArray(res.env.data) ? res.env.data : pick(res.env.data, ['assets', 'items', 'rows', 'entries'], []);
    envState.rows = Array.isArray(rows) ? rows : [];
    $('#envScanRaw').innerHTML = jsonBlock({ hosts: countsBy(envState.rows, 'host'), kinds: countsBy(envState.rows, 'kind'), total: envState.rows.length }, true);
    if (!envState.rows.length) { el.innerHTML = '<div class="empty">没有可导出的资产（本机可能未安装对应宿主）</div>'; return; }
    const byHost = new Map();
    envState.rows.forEach((r) => {
      const host = pick(r, ['host'], 'unknown');
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(r);
    });
    const cols = [
      { label: 'kind', w: '90px', render: (r) => `<span class="badge b-kind">${esc(pick(r, ['kind'], '—'))}</span>` },
      { label: 'id', cls: 'mono', render: (r) => esc(pick(r, ['id', 'name'], '—')) },
      { label: 'version', w: '90px', cls: 'mono', render: (r) => esc(pick(r, ['version'], '—')) },
      { label: 'files', w: '70px', cls: 'num', render: (r) => esc(Array.isArray(r.files) ? r.files.length : num(r.files)) },
      { label: 'strategy', w: '120px', render: (r) => `<span class="badge">${esc(pick(r, ['strategy'], '—'))}</span>` },
      { label: 'source', cls: 'muted mono', render: (r) => esc(pick(r, ['meta.source', 'source'], '')) },
    ];
    el.innerHTML = Array.from(byHost.entries()).map(([host, list]) => `<div class="section-sub">${esc(host)} <span class="badge b-info">${list.length}</span></div>${table(cols, list)}`).join('');
  }
  function countsBy(rows, key) {
    const m = {};
    rows.forEach((r) => { const v = pick(r, [key], '—'); m[v] = (m[v] || 0) + 1; });
    return m;
  }
  async function fileAction(action, extra = {}) {
    const file = ($('#envFile') ? $('#envFile').value : '').trim();
    if (!file) { toast('请填写镜像文件路径', 'warn'); $('#envFile').focus(); return; }
    const res = await call(action, { file, ...extra });
    report(res, $('#envImportOut'));
  }
  async function doImport(dry) {
    const file = ($('#envFile') ? $('#envFile').value : '').trim();
    if (!file) { toast('请填写镜像文件路径', 'warn'); $('#envFile').focus(); return; }
    const wanted = { file, dryRun: dry, requireSignature: $('#envRequireSig').checked, onConflict: $('#envConflict').value };
    const btn = dry ? $('#envPlanBtn') : $('#envImportBtn');
    btn.disabled = true;
    const res = await call('env.import', wanted);
    btn.disabled = false;
    if (dry) {
      if (res.ok) {
        const txt = stringify(res.env.data);
        $('#envPlan').innerHTML = `<div class="result-head">dry-run · ${res.env.tookMs ?? 0}ms · ${bytes(txt)} B${res.env.truncated ? ' · 已截断' : ''}</div>${jsonBlock(res.env.data, false)}`;
        toast('dry-run 完成，未写入任何文件', 'ok');
      } else $('#envPlan').innerHTML = `<div class="errbox"><b>dry-run 失败：</b>${esc(res.error)}</div>`;
      return;
    }
    report(res, $('#envImportOut'));
    if (res.ok) loadEnvScan();
  }
  // ==== 11. plugin =======================================================
  function renderPlugin(view) {
    view.innerHTML = `
      ${missingNote(['plugin.init', 'plugin.validate', 'plugin.verify', 'plugin.pack', 'plugin.install', 'plugin.detect'])}
      <div class="grid2">
        ${cardForm({ title: '初始化插件', sub: 'plugin.init', action: 'plugin.init', submit: '生成骨架', out: '#plugOut', fields: [
          { name: 'id', label: '插件 id', req: true, ph: 'my-plugin' },
          { name: 'dir', label: '输出目录（可选）', ph: 'plugins/my-plugin' },
        ], required: ['id'] })}
        ${cardForm({ title: '校验插件', sub: 'plugin.validate', action: 'plugin.validate', submit: '校验', out: '#plugOut', fields: [
          { name: 'pkg', label: '插件目录 / 清单文件', req: true, ph: 'plugins/my-plugin' },
        ], required: ['pkg'] })}
        ${cardForm({ title: '验证安装', sub: 'plugin.verify', action: 'plugin.verify', submit: '验证', out: '#plugOut', fields: [
          { name: 'pkg', label: '插件目录 / 包文件', req: true, ph: 'plugins/my-plugin' },
        ], required: ['pkg'] })}
        ${cardForm({ title: '打包', sub: 'plugin.pack', action: 'plugin.pack', submit: '打包', out: '#plugOut', fields: [
          { name: 'pkg', label: '插件目录', req: true, ph: 'plugins/my-plugin' },
          { name: 'out', label: '输出文件（可选）', ph: 'dist/my-plugin.uppplugin' },
        ], required: ['pkg'] })}
        ${cardForm({ title: '安装', sub: 'plugin.install', action: 'plugin.install', submit: '安装', out: '#plugOut', danger: true, confirm: '确认安装该插件？', fields: [
          { name: 'from', label: '来源文件 / 目录', req: true, ph: 'dist/my-plugin.uppplugin' },
        ], required: ['from'] })}
        <section class="card"><header class="card-head"><h2>环境检测</h2><span class="muted mono">plugin.detect</span></header> <p class="hint" style="margin-top:0">检测本机插件宿主（DSH / WorkBuddy / Accio）是否可用。</p> <div class="form-actions"><button class="btn primary" id="plugDetectBtn">运行 plugin.detect</button></div>
        </section> </div> <section class="card"><header class="card-head"><h2>执行结果</h2><span class="muted">JSON · 超过 40 行自动折叠</span></header> <div id="plugOut" class="result-slot"><div class="muted">运行任意插件操作后在此显示结果。</div></div> </section>`;
    $('#plugDetectBtn').addEventListener('click', async () => {
      const res = await call('plugin.detect', {});
      report(res, $('#plugOut'));
    });
    bindCards(view);
  }
  // ==== 12. agent bridge panel ===========================================
  const agentLast = () => state.last;
  const winPath = (p) => String(p || '').replace(/\//g, '\\');
  const MCP_TAB = { at: 'packaged' };
  // absolute paths are not exposed by any API; derive them from the server startup log
  // (`uppgui <v> starting (payload <dir>)`) + status.memory.home, else fall back to the env var form.
  function mcpProfile() {
    const dir = winPath(state.payloadDir);
    const sea = /\\UPPGUI\\app$/i.test(dir);
    const st = (state.status && (state.status.data || state.status)) || {};
    const home = String((st.memory && st.memory.home) || '');
    const profile = home ? home.replace(/[\\/][^\\/]+$/, '') : '';
    const exe = sea ? dir.replace(/\\app$/i, '\\uppgui.exe')
      : (profile ? `${winPath(profile)}\\AppData\\Local\\UPPGUI\\uppgui.exe` : '%LOCALAPPDATA%\\UPPGUI\\uppgui.exe');
    const script = dir && !sea ? `${dir}\\tools\\uppgui.mjs` : 'tools\\uppgui.mjs';
    return {
      sea, dir,
      packaged: { mcpServers: { uppgui: { command: exe, args: ['--mcp'] } } },
      dev: { mcpServers: { uppgui: { command: 'node', args: [script, 'mcp'] } } },
    };
  }
  async function ensureStatus() {
    if (state.status) return;
    try { state.status = (await api('/api/status')).json } catch { /* cards already report the error */ }
  }
  const mcpText = (tab) => { const p = mcpProfile(); return stringify(p[tab] || p.packaged); };
  function renderMcp() {
    const pre = $('#mcpSnippet'); if (!pre) return;
    pre.textContent = mcpText(MCP_TAB.at);
    $$('[data-mcp]').forEach((b) => b.classList.toggle('on', b.dataset.mcp === MCP_TAB.at));
    const hint = $('#mcpHint');
    if (hint) hint.innerHTML = `检测到的启动方式：<b>${mcpProfile().sea ? '打包版（SEA）' : '开发版（仓库）'}</b>${state.payloadDir ? ` · payload <span class="mono">${esc(state.payloadDir)}</span>` : ' · 启动日志未到，路径为默认值'}`;
  }
  function renderAgent(view) {
    const want = new URLSearchParams(location.search).get('mcp');
    if (want === 'dev' || want === 'packaged') MCP_TAB.at = want;
    view.innerHTML = `
      <section class="card"><header class="card-head"><h2>接入为 MCP（面向 agent）</h2><span class="muted">只暴露 2 个工具，上下文成本极低</span></header> <p class="muted" style="margin-top:0">任意 MCP 客户端（DSH / WorkBuddy / Accio）都能通过 <span class="mono">upp_action</span> 与 <span class="mono">upp_catalog</span> 操作本实例。把下面配置写进客户端即可。</p> <div class="toolbar" id="mcpTabs"><span class="muted">启动方式</span> <button class="mini-btn on" data-mcp="packaged">打包版 · exe</button> <button class="mini-btn" data-mcp="dev">开发版 · node</button></div>
        <pre class="json-pre" id="mcpSnippet">—</pre> <div class="form-actions"> <button class="btn sm" id="copyMcp">复制配置 JSON</button> <span class="hint" id="mcpHint"></span> </div> <p class="hint">stdio · JSON-RPC 2.0 · protocolVersion 2024-11-05。打包版子命令为 <span class="mono">--mcp</span>；开发版用 <span class="mono">node tools/uppgui.mjs mcp</span>。</p>
      </section> <section class="card"><header class="card-head"><h2>复制为 upp_action 调用</h2><span class="muted">最近一次执行的 action</span></header> <div id="agentLast" class="muted">尚未执行任何 action。</div> <pre class="json-pre" id="agentCallJson">—</pre>
        <div class="form-actions"><button class="btn sm" id="copyCall">复制调用 JSON</button><span class="hint">可直接作为 MCP 工具参数使用。</span></div> </section> <section class="card"><header class="card-head"><h2>Token 预算</h2><span class="muted">最近一次响应的字节体积</span></header> <div class="cards" id="agentBudget"></div>
        <p class="hint">默认 brief：数组截断 10 条、字符串 200 字符。需要全量时勾选顶部 <b>full</b>，或 MCP 调用传 <span class="mono">full:true</span>。</p> </section> <section class="card"><header class="card-head"><h2>连接信息</h2></header><dl class="kv" id="agentConn"></dl></section>`;
    $$('[data-mcp]').forEach((b) => b.addEventListener('click', () => { MCP_TAB.at = b.dataset.mcp; renderMcp(); }));
    $('#copyMcp').addEventListener('click', () => copy(mcpText(MCP_TAB.at), `MCP 配置（${MCP_TAB.at === 'packaged' ? '打包版' : '开发版'}）`));
    $('#copyCall').addEventListener('click', () => {
      const last = agentLast();
      if (!last) { toast('还没有可复制的调用', 'warn'); return; }
      copy(JSON.stringify({ action: last.action, params: last.params, full: last.full }), 'upp_action JSON');
    });
    renderMcp();
    // status.memory.home → LOCALAPPDATA so the packaged exe path is expanded, not the %VAR% form
    if (!state.status) ensureStatus().then(() => { renderMcp(); updateAgent(); });
    updateAgent();
  }
  function updateAgent() {
    const last = agentLast();
    if ($('#mcpSnippet')) renderMcp();
    const callJson = $('#agentCallJson');
    if (callJson) callJson.textContent = last ? JSON.stringify({ action: last.action, params: last.params, full: last.full }) : '—';
    const lastEl = $('#agentLast');
    if (lastEl) lastEl.innerHTML = last ? `<span class="mono">${esc(last.action)}</span> · ${fmtClock(last.at)} · ${num(last.bytesPretty)} B` : '尚未执行任何 action。';
    const budget = $('#agentBudget');
    if (budget) budget.innerHTML = budgetCards(last);
    const conn = $('#agentConn');
    if (conn) conn.innerHTML = connRows();
  }
  function budgetCards(last) {
    if (!last) return '<div class="stat"><span class="k">等待首次调用</span><span class="v">—</span><span class="s">运行任意 action 后显示</span></div>';
    const est = (n) => Math.max(1, Math.round(n / 3.6));
    const pretty = last.bytesPretty || 0, compact = last.bytesCompact || 0;
    const saved = pretty ? Math.round((1 - compact / pretty) * 100) : 0;
    const items = [
      ['响应 pretty', `${num(pretty)} B`, `≈ ${num(est(pretty))} tokens`],
      ['响应 compact', `${num(compact)} B`, `≈ ${num(est(compact))} tokens`],
      ['体积下降', `${saved}%`, 'pretty → compact'],
      ['full 模式', last.full ? '开' : '关', last.full ? '返回全量' : 'brief（10 条 / 200 字符）'],
    ];
    return items.map(([k, v, s]) => `<div class="stat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join('');
  }
  function connRows() {
    const p = state.ping || {};
    const rows = [
      ['服务', p.app ? `${p.app} ${p.version}` : '未连接'],
      ['地址', location.origin],
      ['actions', p.actionCount != null ? String(p.actionCount) : '—'],
      ['运行时长', p.uptimeMs != null ? fmtDur(p.uptimeMs) : '—'],
      ['pid', p.pid != null ? String(p.pid) : '—'],
      ['token', state.noAuth ? '无鉴权（--no-auth）' : state.token ? maskToken() : '缺失'],
      ['full 模式', state.full ? 'on' : 'off'],
    ];
    return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }
  // ==== 13. wiring & boot ================================================
  const RENDER = { overview: renderOverview, memory: renderMemory, tools: renderTools, env: renderEnv, plugin: renderPlugin, agent: renderAgent };
  function readToken() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    const stored = sessionStorage.getItem('uppgui.token');
    state.token = fromUrl || stored || '';
    if (state.token) sessionStorage.setItem('uppgui.token', state.token);
    if (fromUrl) {
      params.delete('token');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    }
    const chip = $('#tokenChip');
    chip.textContent = `token ${state.token ? maskToken() : '缺失'}`;
    chip.title = state.token ? '点击复制 token（地址栏已移除）' : '缺少 token：请用 uppgui open 打开';
    updateTokenChip();
  }
  function initConsole() {
    const con = $('#console');
    if (localStorage.getItem('uppgui.console') === 'collapsed') {
      con.classList.add('collapsed');
      $('#consoleToggle').setAttribute('aria-expanded', 'false');
    }
    $('#consoleToggle').addEventListener('click', () => {
      const collapsed = con.classList.toggle('collapsed');
      $('#consoleToggle').setAttribute('aria-expanded', String(!collapsed));
      localStorage.setItem('uppgui.console', collapsed ? 'collapsed' : 'open');
    });
    $('#logFilter').value = localStorage.getItem('uppgui.filter') || 'all';
    $('#logFilter').addEventListener('change', () => { localStorage.setItem('uppgui.filter', $('#logFilter').value); redrawLog(); });
    $('#logClear').addEventListener('click', () => { state.logs.rows = []; redrawLog(); toast('日志已清空', 'info', 1600); });
    $('#logPause').addEventListener('click', (e) => {
      state.logs.paused = !state.logs.paused;
      e.currentTarget.classList.toggle('on', state.logs.paused);
      e.currentTarget.textContent = state.logs.paused ? '继续' : '暂停';
      updateLogMeta();
    });
    $('#consoleBody').addEventListener('scroll', (e) => {
      const b = e.currentTarget;
      state.logs.follow = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
    });
  }
  function bindGlobal() {
    window.addEventListener('hashchange', route);
    $('#btnRefresh').addEventListener('click', route);
    $('#fullToggle').addEventListener('change', (e) => {
      state.full = e.target.checked;
      localStorage.setItem('uppgui.full', state.full ? '1' : '0');
      logLocal('ui', `full 模式 ${state.full ? '开启：返回完整数据' : '关闭：brief 响应'}`);
    });
    $('#dlgClose').addEventListener('click', closeDialog);
    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]');
      if (c) copy(c.dataset.copy);
    });
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      const dlg = $('#dlg');
      if (e.key === 'Escape') {
        if (dlg.open) { dlg.close(); return; }
        if (typing) document.activeElement.blur();
        return;
      }
      if (e.key === '/' && !typing) {
        const target = $('[data-search]') || $('#view input, #view textarea');
        if (target) { e.preventDefault(); target.focus(); }
      }
      if ((e.key === 'r' || e.key === 'R') && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); route(); }
    });
    $('#authCopy').addEventListener('click', () => copy(`${location.origin}/?token=${state.token}`, '已复制带 token 的地址'));
    $('#tokenChip').addEventListener('click', () => {
      if (state.noAuth) { toast('服务端以 --no-auth 启动，无需 token', 'info'); return; }
      if (state.token) copy(state.token, '已复制 token');
      else toast('当前没有 token', 'warn');
    });
    if (localStorage.getItem('uppgui.full') === '1') { state.full = true; $('#fullToggle').checked = true; }
  }
  async function boot() {
    readToken();
    initConsole();
    bindGlobal();
    renderNav();
    await Promise.all([loadCatalog(), ping()]);
    renderNav();
    route();
    pollLog();
    setInterval(pollLog, 2000);
    setInterval(ping, 15000);
    logLocal('ui', `UPP GUI 就绪 · ${state.actions.size} actions · full ${state.full ? 'on' : 'off'}`);
  }
  boot();
})();
