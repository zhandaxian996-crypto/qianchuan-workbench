/**
 * 已退役：历史版本管理实现，仅保留离线审计，禁止注册在线路由。
 * /api/mhs/versions — MHS 公式版本管理（§七-6）
 *
 * GET  /api/mhs/versions[?account=]        版本列表 + 每版出生证明 + 当前激活版本
 * POST /api/mhs/versions                   登记候选版 {version, account?, params, birth, note?}（写鉴权）
 * POST /api/mhs/versions/activate          激活版本 {version, account?}——同 scope 其余自动降 archived（回滚=激活旧版）
 * GET  /api/mhs/versions/diff?a=X&b=Y      两版参数逐项对照（同值/异值/单侧独有）
 *
 * 存储结构由 lib/mhs.js loadVersions/getActiveVersion 读取，写入侧在 lib/mhsVersions.js。
 */

const { sendJSON, readJsonBody, requireWriteAuth } = require('../lib/utils');
const mhsVersions = require('../lib/mhsVersions');

async function handleMhsVersions(req, res, url) {
  const pathname = url.pathname;

  // ── 版本列表 ──
  if (req.method === 'GET' && pathname === '/api/mhs/versions') {
    const account = url.searchParams.get('account') || undefined;
    const { versions } = mhsVersions.load();
    // 带 account：看该 scope 的版本 + 全局版本（与 getMhsParams 的合并口径一致）
    const filtered = account
      ? versions.filter(v => v.account === account || v.account == null)
      : versions;
    return sendJSON(res, {
      ok: true,
      account: account || null,
      count: filtered.length,
      versions: filtered,
      active: mhsVersions.getActive(account),
    });
  }

  // ── 参数对照 ──
  if (req.method === 'GET' && pathname === '/api/mhs/versions/diff') {
    const a = url.searchParams.get('a');
    const b = url.searchParams.get('b');
    if (!a || !b) return sendJSON(res, { ok: false, error: 'a、b 两个版本名参数必填' }, 400);
    const account = url.searchParams.get('account') || undefined;
    try {
      return sendJSON(res, { ok: true, diff: mhsVersions.diffVersions(a, b, { account }) });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 404);
    }
  }

  // ── 登记候选版 ──
  if (req.method === 'POST' && pathname === '/api/mhs/versions') {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
    try {
      const rec = mhsVersions.registerVersion(data);
      return sendJSON(res, { ok: true, version: rec });
    } catch (e) {
      const isDup = /已存在/.test(e.message);
      return sendJSON(res, { ok: false, error: e.message }, isDup ? 409 : 400);
    }
  }

  // ── 激活 / 回滚 ──
  if (req.method === 'POST' && pathname === '/api/mhs/versions/activate') {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
    try {
      const r = mhsVersions.activateVersion(data);
      return sendJSON(res, { ok: true, activated: r.activated, archived: r.archived });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 404);
    }
  }

  return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
}

module.exports = handleMhsVersions;
