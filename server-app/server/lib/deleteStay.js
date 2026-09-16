/**
 * deleteStay — 删除死缓状态机存储（MHS 工程目标文档 §5.1：急性衰退触发后死缓观察）
 *
 * 条目：{ material_id, account, item_id, kill_line, triggered_date（基准日=触发时的昨天）,
 *        check_dates（窗口由 stay_hours 决定，默认48h=T+1/T+2；2026-07-28 起可按账号配72h）,
 *        entered_at, status,
 *        checks:[{date, revived, cost?, net_roi?, why}], resolved_at?, resolve_why?, acute? }
 * 状态流转：staying → revoked（检查日任一日复活撤销）/ executed（期满未复活，已交执行）
 *                  → expired（超 5 天数据未回填，防死条目）/ cancelled（对应建议已被人工处理）
 * 约束：同一素材同一账号同时只允许一条 staying（getStaying 判重，由调用方保证）。
 *
 * 存储：cache/delete_stay.json（小 JSON，参照 lib/pendingOps.js 的 readStore/writeStore 模式）；
 * env DELETE_STAY_STORE 可覆盖路径（测试隔离）。
 */

const fs = require('fs');
const path = require('path');

const STORE_FILE = process.env.DELETE_STAY_STORE || path.join(__dirname, '..', '..', 'cache', 'delete_stay.json');

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (data && Array.isArray(data.entries)) return data;
  } catch { /* 文件不存在或损坏 → 空库 */ }
  return { entries: [] };
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function list({ status, account } = {}) {
  return readStore().entries
    .filter(e => (!status || e.status === status) && (!account || e.account === account))
    .sort((a, b) => String(b.entered_at).localeCompare(String(a.entered_at)));
}

/** 查某素材当前 staying 条目（同素材同时期只允许一条），无则 null */
function getStaying(materialId, account) {
  return readStore().entries.find(e =>
    e.status === 'staying' && String(e.material_id) === String(materialId) && e.account === account
  ) || null;
}

function create(entry) {
  const store = readStore();
  store.entries.push(entry);
  // 只保留最近 200 条，防文件无限增长
  if (store.entries.length > 200) store.entries = store.entries.slice(-200);
  writeStore(store);
  return entry;
}

/** 更新某素材的 staying 条目（只有 staying 态允许流转/累进 checks），无则 null */
function update(materialId, account, patch) {
  const store = readStore();
  const entry = store.entries.find(e =>
    e.status === 'staying' && String(e.material_id) === String(materialId) && e.account === account
  );
  if (!entry) return null;
  Object.assign(entry, patch);
  writeStore(store);
  return entry;
}

module.exports = { list, getStaying, create, update };
