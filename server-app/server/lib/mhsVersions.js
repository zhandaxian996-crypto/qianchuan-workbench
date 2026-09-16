/**
 * server/lib/mhsVersions.js — MHS 公式版本管理（§七-6 写入侧）
 *
 * 存储：cache/mhs_versions.json（读取侧已在 lib/mhs.js：loadVersions/getActiveVersion，勿改结构）：
 *   { versions: [{ version, account|null, params, birth:{sample_size, time_range, precision, recall,
 *     applicable, invalid_when}, status:'candidate'|'active'|'archived', created_at, activated_at|null, note }] }
 *
 * 纪律（§九）：本模块只做登记/激活/对照，不设定任何业务数值；
 *   参数合法性由 lib/mhs.js validateMhsParams 把关。
 * 回滚机制：激活旧版本即回滚——同 scope（同 account 或全局）下其余版本自动降 archived。
 *
 * 测试隔离：storePath 参数 > 环境变量 MHS_VERSIONS_STORE > 默认 cache/mhs_versions.json。
 */

const fs = require('fs');
const path = require('path');
const { validateMhsParams } = require('./mhs');
const { writeJsonAtomic } = require('./api-helpers');

const DEFAULT_STORE = path.join(__dirname, '..', '..', 'cache', 'mhs_versions.json');

/** 解析存储文件路径：显式参数 > env > 默认（默认必须与 lib/mhs.js 的 VERSIONS_FILE 一致） */
function resolveStore(storePath) {
  return storePath || process.env.MHS_VERSIONS_STORE || DEFAULT_STORE;
}

/** 读版本库（文件缺失/损坏 → 空库） */
function load(storePath) {
  try {
    const data = JSON.parse(fs.readFileSync(resolveStore(storePath), 'utf8'));
    if (data && Array.isArray(data.versions)) return data;
  } catch { /* 空库 */ }
  return { versions: [] };
}

/** 写版本库（原子写，防中断损坏——mhs.js 读取侧不容忍坏文件） */
function save(data, storePath) {
  writeJsonAtomic(resolveStore(storePath), data);
}

/** scope 归一：account 空值统一为 null（全局版本） */
function scopeOf(account) {
  return account || null;
}

/**
 * 登记候选版本。
 * @param {object} input - { version, account?, params, birth, note? }
 * @param {string} [storePath]
 * @returns {object} 新登记的版本对象
 * @throws {Error} 参数非法 / 参数校验未过 / 同 scope 重名
 */
function registerVersion(input, storePath) {
  const { version, params, birth, note } = input || {};
  const account = scopeOf(input && input.account);
  if (!version || typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
    throw new Error('version 必填且只允许字母数字._-（≤64 字符）');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params 必填且必须是对象');
  }
  const errors = validateMhsParams(params);
  if (errors.length) {
    throw new Error('参数校验未过：' + errors.join('；'));
  }
  if (!birth || typeof birth !== 'object' || Array.isArray(birth)) {
    throw new Error('birth 必填（出生证明：sample_size/time_range/precision/recall/applicable/invalid_when）');
  }

  const data = load(storePath);
  const dup = data.versions.find(v => v.version === version && scopeOf(v.account) === account);
  if (dup) {
    throw new Error(`版本 ${version}（scope: ${account || '全局'}）已存在，拒绝重复登记`);
  }

  const rec = {
    version,
    account,
    params,
    birth: {
      sample_size: birth.sample_size != null ? birth.sample_size : null,
      time_range: birth.time_range != null ? birth.time_range : null,
      precision: birth.precision != null ? birth.precision : null,
      recall: birth.recall != null ? birth.recall : null,
      applicable: birth.applicable != null ? birth.applicable : null,
      invalid_when: birth.invalid_when != null ? birth.invalid_when : null,
    },
    status: 'candidate',
    created_at: new Date().toISOString(),
    activated_at: null,
    note: note || '',
  };
  data.versions.push(rec);
  save(data, storePath);
  return rec;
}

/**
 * 激活版本（回滚 = 激活旧版本）：目标版本置 active，
 * 同 scope（同 account 或全局）其余版本自动降 archived。
 * @param {object} input - { version, account? }
 * @param {string} [storePath]
 * @returns {{activated: object, archived: string[]}}
 * @throws {Error} 版本不存在
 */
function activateVersion(input, storePath) {
  const { version } = input || {};
  const account = scopeOf(input && input.account);
  if (!version) throw new Error('version 必填');

  const data = load(storePath);
  const target = data.versions.find(v => v.version === version && scopeOf(v.account) === account);
  if (!target) {
    throw new Error(`版本不存在: ${version}（scope: ${account || '全局'}）`);
  }
  const archived = [];
  for (const v of data.versions) {
    if (v === target) continue;
    if (scopeOf(v.account) === account && v.status === 'active') {
      v.status = 'archived';
      archived.push(v.version);
    }
  }
  target.status = 'active';
  target.activated_at = new Date().toISOString();
  save(data, storePath);
  return { activated: target, archived };
}

/**
 * 两版参数逐项对照。
 * @param {string} a - 版本名 A
 * @param {string} b - 版本名 B
 * @param {object} [opts] - { account, storePath }（account 限定 scope 查找，缺省按名字首个匹配）
 * @returns {{a: string, b: string, same: object, different: object, only_in_a: object, only_in_b: object}}
 * @throws {Error} 任一版本不存在
 */
function diffVersions(a, b, opts = {}) {
  const data = load(opts.storePath);
  const scope = scopeOf(opts.account);
  const find = (name) => data.versions.find(v =>
    v.version === name && (opts.account === undefined || scopeOf(v.account) === scope));
  const va = find(a);
  const vb = find(b);
  if (!va) throw new Error(`版本不存在: ${a}`);
  if (!vb) throw new Error(`版本不存在: ${b}`);

  const same = {}, different = {}, onlyA = {}, onlyB = {};
  const keysA = Object.keys(va.params || {});
  const keysB = new Set(Object.keys(vb.params || {}));
  for (const k of keysA) {
    if (keysB.has(k)) {
      const x = va.params[k], y = vb.params[k];
      if (JSON.stringify(x) === JSON.stringify(y)) same[k] = x;
      else different[k] = { a: x, b: y };
    } else {
      onlyA[k] = va.params[k];
    }
  }
  for (const k of keysB) {
    if (!(k in (va.params || {}))) onlyB[k] = vb.params[k];
  }
  return {
    a: va.version, b: vb.version,
    account_a: scopeOf(va.account), account_b: scopeOf(vb.account),
    same, different, only_in_a: onlyA, only_in_b: onlyB,
  };
}

/** 取当前激活版本（account 指定时：账号专属优先，其次全局——与 lib/mhs.js getActiveVersion 同口径） */
function getActive(account, storePath) {
  const { versions } = load(storePath);
  const actives = versions.filter(v => v.status === 'active');
  if (account === undefined) return actives;
  return actives.find(v => scopeOf(v.account) === account)
    || actives.find(v => v.account == null)
    || null;
}

module.exports = {
  DEFAULT_STORE,
  resolveStore,
  load,
  save,
  registerVersion,
  activateVersion,
  diffVersions,
  getActive,
};
