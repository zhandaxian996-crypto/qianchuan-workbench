'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareMcpConfig, publicMcpEntry, run, selectPort } = require('../tools/setup.cjs');

test('默认端口冲突时从 19096 选择空闲端口，不复用陌生服务', async () => {
  const seen = [];
  const selected = await selectPort(18991, {
    inspect: async port => {
      seen.push(port);
      return port === 19097 ? 'free' : 'occupied';
    },
  });
  assert.deepEqual(selected, { port: 19097, state: 'free' });
  assert.deepEqual(seen, [18991, 19096, 19097]);
});

test('已有固定端口遇到陌生服务时拒绝改写或复用', async () => {
  await assert.rejects(
    selectPort(19096, { fixed: true, inspect: async () => 'occupied' }),
    /未连接、未停止，也未改写现有端口配置/,
  );
});

test('已有 MCP、凭据与其他服务器配置保持不变，仅补缺失通用字段', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bootstrap-'));
  const file = path.join(root, '.mcp.json');
  const existing = {
    customTopLevel: { keep: true },
    mcpServers: {
      another: { command: 'other', env: { TOKEN: 'other-secret' } },
      'qianchuan-data-api': {
        transport: 'stdio', command: 'node',
        args: ['--token=argument-secret', path.join(root, 'server-app', 'server', 'mcp', 'index.js')], cwd: root,
        env: { QC_PORT: '23456', COOKIE: 'account-secret', EXTRA_TOKEN: 'keep-me' },
        custom: 'preserve-me',
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(existing));
  const prepared = await prepareMcpConfig({ root, file, inspect: async () => 'free' });
  assert.deepEqual(prepared.config.customTopLevel, existing.customTopLevel);
  assert.deepEqual(prepared.config.mcpServers.another, existing.mcpServers.another);
  assert.equal(prepared.entry.env.COOKIE, 'account-secret');
  assert.equal(prepared.entry.env.EXTRA_TOKEN, 'keep-me');
  assert.equal(prepared.entry.custom, 'preserve-me');
  assert.equal(prepared.entry.env.QC_PORT, '23456');
  assert.equal(prepared.entry.env.QC_TRIAL_READ_ONLY, '1');
  const publicEntry = publicMcpEntry(prepared.entry);
  assert.equal(publicEntry.env.COOKIE, undefined);
  assert.equal(publicEntry.env.EXTRA_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(publicEntry), /account-secret|keep-me|argument-secret/);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(existing));
});

test('现有冲突条目不被覆盖', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bootstrap-conflict-'));
  const file = path.join(root, '.mcp.json');
  const text = JSON.stringify({ mcpServers: { 'qianchuan-data-api': { command: 'node', args: ['elsewhere.js'], env: { COOKIE: 'secret' } } } });
  fs.writeFileSync(file, text);
  await assert.rejects(prepareMcpConfig({ root, file, inspect: async () => 'free' }), /未覆盖该条目/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('不会覆盖或使用显式关闭只读保护的现有配置', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bootstrap-unsafe-'));
  const file = path.join(root, '.mcp.json');
  const value = { mcpServers: { 'qianchuan-data-api': {
    command: 'node', args: [path.join(root, 'server-app', 'server', 'mcp', 'index.js')], cwd: root,
    env: { QC_TRIAL_READ_ONLY: '0', COOKIE: 'secret' },
  } } };
  const text = JSON.stringify(value);
  fs.writeFileSync(file, text);
  await assert.rejects(prepareMcpConfig({ root, file, inspect: async () => 'free' }), /不会覆盖该值或在此配置下启动/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('随包相对路径占位模板升级为绝对入口和只读环境', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bootstrap-template-'));
  const file = path.join(root, '.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'qianchuan-data-api': {
    transport: 'stdio', command: 'node', args: ['server-app/server/mcp/index.js'], cwd: '.',
  } } }));
  const prepared = await prepareMcpConfig({ root, file, inspect: async port => port === 18991 ? 'occupied' : 'free' });
  assert.equal(prepared.entry.command, process.execPath);
  assert.deepEqual(prepared.entry.args, [path.join(root, 'server-app', 'server', 'mcp', 'index.js')]);
  assert.equal(prepared.entry.cwd, root);
  assert.equal(prepared.entry.env.QC_PORT, '19096');
  assert.equal(prepared.entry.env.QC_TRIAL_READ_ONLY, '1');
  assert.equal(prepared.entry.env.QC_DISABLE_BACKGROUND, '1');
});

test('正式初始化写回时保留现有凭据和其他 MCP 条目，输出不泄露凭据', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bootstrap-run-'));
  const file = path.join(root, '.mcp.json');
  const existing = {
    mcpServers: {
      another: { command: 'other', env: { TOKEN: 'other-secret' } },
      'qianchuan-data-api': {
        transport: 'stdio', command: 'node',
        args: [path.join(root, 'server-app', 'server', 'mcp', 'index.js')], cwd: root,
        env: { COOKIE: 'account-secret' },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(existing));
  const environment = { ok: true, node: process.versions.node, nodeOk: true, sqlite: true, missingMcp: [], failures: [] };
  const launcher = {
    checkEnvironment: () => environment,
    checkReport: () => ({ ok: true, environment_ready: true, account_ready: 'not_checked', service_online: 'not_checked', failures: [] }),
    settings: (_serverApp, env) => ({ port: Number(env.QC_PORT), url: `http://127.0.0.1:${env.QC_PORT}` }),
    launch: async config => ({ url: `${config.url}/v4`, pid: 1234, reused: false }),
  };
  const { result, exitCode } = await run({ args: ['--json'], root, file, serverApp: path.join(root, 'server-app'), inspect: async () => 'free', launcher });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(exitCode, 0);
  assert.equal(saved.mcpServers['qianchuan-data-api'].env.COOKIE, 'account-secret');
  assert.deepEqual(saved.mcpServers.another, existing.mcpServers.another);
  assert.equal(saved.mcpServers['qianchuan-data-api'].env.QC_TRIAL_READ_ONLY, '1');
  assert.doesNotMatch(JSON.stringify(result), /account-secret|other-secret/);
});
