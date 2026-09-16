'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_APP = path.join(ROOT, 'server-app');
const MCP_NAME = 'qianchuan-data-api';
const SAFE_ENV_KEYS = [
  'NODE_PATH', 'QC_PORT', 'QC_HOST', 'QC_RUNTIME_CONFIG_ROOT',
  'QC_RUNTIME_DATA_ROOT', 'QC_OFFICIAL_SKILL_DIR', 'QC_TRIAL_READ_ONLY',
  'QC_DISABLE_BACKGROUND', 'AGENT_MEMORY_DIR', 'FLOW_BASELINE_CACHE_DIR',
];

function readJson(file, io = fs) {
  if (!io.existsSync(file)) return null;
  try { return JSON.parse(io.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${path.basename(file)} 不是有效 JSON；为保护现有配置，未作修改。`); }
}

function defaultEnv(root = ROOT, port = 18991) {
  const runtime = path.join(root, 'private-runtime');
  return {
    NODE_PATH: '',
    QC_PORT: String(port),
    QC_HOST: '127.0.0.1',
    QC_RUNTIME_CONFIG_ROOT: runtime,
    QC_RUNTIME_DATA_ROOT: runtime,
    QC_OFFICIAL_SKILL_DIR: path.join(root, 'skills', 'qianchuan-ops'),
    QC_TRIAL_READ_ONLY: '1',
    QC_DISABLE_BACKGROUND: '1',
    AGENT_MEMORY_DIR: path.join(runtime, 'agent-memory'),
    FLOW_BASELINE_CACHE_DIR: path.join(runtime, 'cache'),
  };
}

function resolveEntryFile(entry, root = ROOT) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.command !== 'string' || !entry.command.trim() || !Array.isArray(entry.args)) return null;
  const script = entry.args.find(arg => typeof arg === 'string' && /(?:^|[\\/])server[\\/]mcp[\\/]index\.js$/i.test(arg));
  if (!script) return null;
  const cwd = typeof entry.cwd === 'string' ? path.resolve(root, entry.cwd) : root;
  return path.resolve(cwd, script);
}

function isLocalMcpEntry(entry, root = ROOT) {
  const resolved = resolveEntryFile(entry, root);
  const expected = path.join(root, 'server-app', 'server', 'mcp', 'index.js');
  return resolved != null && path.normalize(resolved).toLowerCase() === path.normalize(expected).toLowerCase();
}

function isPackagedPlaceholder(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.env != null) return false;
  const keys = Object.keys(entry).sort();
  if (keys.some(key => !['args', 'command', 'cwd', 'transport'].includes(key))) return false;
  return entry.command === 'node' && entry.cwd === '.' && entry.transport === 'stdio' &&
    Array.isArray(entry.args) && entry.args.length === 1 &&
    entry.args[0].replace(/\\/g, '/') === 'server-app/server/mcp/index.js';
}

function portFromEntry(entry) {
  const value = Number(entry?.env?.QC_PORT || 18991);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error('现有 MCP 配置中的 QC_PORT 应为 1024～65535 的整数；未覆盖原值。');
  }
  return value;
}

function canListen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function inspectPort(port, options = {}) {
  if (await (options.canListen || canListen)(port)) return 'free';
  const launcher = options.launcher || require('../server-app/scripts/start-workbench');
  const url = `http://127.0.0.1:${port}`;
  try {
    const value = await (options.health || launcher.health)(url);
    return launcher.verifyHealth(value, path.join(SERVER_APP, 'server.js')) ? 'ours' : 'occupied';
  } catch { return 'occupied'; }
}

async function selectPort(preferred, options = {}) {
  const first = await (options.inspect || inspectPort)(preferred, options);
  if (first === 'free' || first === 'ours') return { port: preferred, state: first };
  if (options.fixed) throw new Error(`端口 ${preferred} 已有其他或旧版服务；未连接、未停止，也未改写现有端口配置。`);
  for (let port = 19096; port <= 65535; port += 1) {
    const state = await (options.inspect || inspectPort)(port, options);
    if (state === 'free' || state === 'ours') return { port, state };
  }
  throw new Error('从 19096 起未找到可用本机端口；未修改配置。');
}

async function prepareMcpConfig(options = {}) {
  const root = options.root || ROOT;
  const file = options.file || path.join(root, '.mcp.json');
  const current = readJson(file, options.io || fs) || {};
  if (current.mcpServers != null && (typeof current.mcpServers !== 'object' || Array.isArray(current.mcpServers))) {
    throw new Error('现有 .mcp.json 的 mcpServers 格式无效；为保护配置，未作修改。');
  }
  const existing = current.mcpServers?.[MCP_NAME];
  if (existing && !isLocalMcpEntry(existing, root)) {
    throw new Error(`现有 ${MCP_NAME} 条目不指向本项目；为保护配置，未覆盖该条目。`);
  }
  for (const key of ['QC_TRIAL_READ_ONLY', 'QC_DISABLE_BACKGROUND']) {
    if (existing?.env?.[key] != null && String(existing.env[key]) !== '1') {
      throw new Error(`现有 ${MCP_NAME} 的 ${key} 不是 1；只读试用包不会覆盖该值或在此配置下启动。`);
    }
  }
  const fixedPort = Boolean(existing?.env && Object.prototype.hasOwnProperty.call(existing.env, 'QC_PORT'));
  const selected = await selectPort(existing ? portFromEntry(existing) : 18991, { ...options, fixed: fixedPort });
  const defaults = defaultEnv(root, selected.port);
  const placeholder = isPackagedPlaceholder(existing);
  const entry = placeholder ? {
    transport: 'stdio', command: process.execPath,
    args: [path.join(root, 'server-app', 'server', 'mcp', 'index.js')], cwd: root, env: defaults,
  } : existing ? {
    ...existing,
    env: { ...defaults, ...(existing.env || {}) },
  } : {
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(root, 'server-app', 'server', 'mcp', 'index.js')],
    cwd: root,
    env: defaults,
  };
  const config = { ...current, mcpServers: { ...(current.mcpServers || {}), [MCP_NAME]: entry } };
  return { config, entry, selected, changed: JSON.stringify(config) !== JSON.stringify(current), existed: Boolean(existing), file };
}

function saveJson(file, value, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.setup-${process.pid}-${Date.now()}.tmp`;
  io.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  io.renameSync(temporary, file);
}

function publicMcpEntry(entry) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (entry.env?.[key] != null) env[key] = String(entry.env[key]);
  const script = entry.args.find(arg => typeof arg === 'string' && /(?:^|[\\/])server[\\/]mcp[\\/]index\.js$/i.test(arg));
  return {
    transport: entry.transport || 'stdio', command: entry.command,
    args: [script], ...(entry.cwd ? { cwd: entry.cwd } : {}), env,
  };
}

function outputShape(report, prepared, extra = {}) {
  const port = portFromEntry(prepared.entry);
  return {
    ...report,
    url: `http://127.0.0.1:${port}/v4`,
    onboarding_url: `http://127.0.0.1:${port}/v4#/onboarding`,
    mcp: { name: MCP_NAME, entry: publicMcpEntry(prepared.entry), config_file: prepared.file },
    skill: { scope: 'project', entry: path.join(path.dirname(prepared.file), 'skills', 'qianchuan-ops', 'SKILL.md') },
    skill_entry: path.join(path.dirname(prepared.file), 'skills', 'qianchuan-ops', 'SKILL.md'),
    next_step: 'setup_account status',
    next: { tool: 'setup_account', action: 'status', user_action: '本人登录后选择账户；随后仅按 next_questions 补充必要信息。' },
    ...extra,
  };
}

function installDependencies(options = {}) {
  const runner = options.spawnSync || spawnSync;
  // Windows 不能用 shell:false 直接执行 .cmd；固定命令经 cmd 启动，不拼接用户输入。
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npm';
  const args = windows ? ['/d', '/s', '/c', 'npm install --no-audit --no-fund'] : ['install', '--no-audit', '--no-fund'];
  const result = runner(command, args, {
    cwd: options.serverApp || SERVER_APP, shell: false, windowsHide: true,
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`npm install 无法启动：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`npm install 未完成${detail ? `：${detail}` : '。'}`);
  }
}

async function run(options = {}) {
  const args = options.args || process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const launcher = options.launcher || require('../server-app/scripts/start-workbench');
  let prepared;
  try {
    prepared = await prepareMcpConfig({ ...options, inspect: checkOnly ? async () => 'free' : options.inspect });
  } catch (error) {
    const environment = launcher.checkEnvironment(options.environmentOptions);
    const report = launcher.checkReport(environment, null, error);
    return { result: { ...report, failures: [...report.failures, { code: 'invalid_mcp_config', message: error.message, next: '请检查本机 .mcp.json；脚本不会覆盖冲突条目或已有凭据。' }] }, exitCode: 1 };
  }
  let environment = launcher.checkEnvironment(options.environmentOptions);
  if (!checkOnly && !environment.ok && environment.missingMcp.length && environment.nodeOk && environment.sqlite) {
    installDependencies(options);
    environment = launcher.checkEnvironment(options.environmentOptions);
  }
  const env = { ...process.env, ...prepared.entry.env, QC_TRIAL_READ_ONLY: '1', QC_DISABLE_BACKGROUND: '1' };
  let config = null, configError = null;
  try { config = launcher.settings(options.serverApp || SERVER_APP, env); } catch (error) { configError = error; }
  const report = launcher.checkReport(environment, config, configError);
  if (checkOnly || !report.ok) {
    return { result: outputShape(report, prepared, { mode: 'check', config: { changed: false, would_write: prepared.changed } }), exitCode: report.ok ? 0 : 1 };
  }
  if (prepared.changed) saveJson(prepared.file, prepared.config, options.io || fs);
  const launched = await launcher.launch(config, { env, ...(options.launchOptions || {}) });
  return {
    result: outputShape(report, prepared, {
      ok: true, service_online: true, url: launched.url,
      config: { changed: prepared.changed, preserved_existing_entry: prepared.existed },
      service: { reused: launched.reused, pid: launched.pid },
    }),
    exitCode: 0,
  };
}

async function main() {
  const json = process.argv.includes('--json');
  try {
    const { result, exitCode } = await run();
    if (json) console.log(JSON.stringify(result));
    else console.log(result.ok ? `工作台已就绪：${result.url}` : result.failures.map(item => item.message).join('\n'));
    if (exitCode === 0 && result.service_online === true && process.argv.includes('--open')) {
      const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe') : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', result.onboarding_url] : [result.onboarding_url];
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
      child.on('error', () => process.stderr.write('请在浏览器中打开上方工作台地址。\n'));
      child.unref();
    }
    process.exitCode = exitCode;
  } catch (error) {
    const result = { ok: false, error: { code: 'setup_failed', message: error.message } };
    if (json) console.log(JSON.stringify(result)); else console.error(`初始化未完成：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { defaultEnv, isLocalMcpEntry, isPackagedPlaceholder, portFromEntry, selectPort, prepareMcpConfig, publicMcpEntry, installDependencies, run };
