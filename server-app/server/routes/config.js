const fs = require('fs');
const path = require('path');
const { sendJSON, readJsonBody, requireWriteAuth, checkBodyKeys } = require('../lib/utils');

/**
 * GET  /api/config                 — 读可调参数（manual_config 白名单）
 * POST /api/config { key, value }  — 改 manual_config（内存即时生效 + 落盘 config.json）
 *
 * 白名单（其余 config 项一律不接受在线修改）：
 *   gmv_target_monthly     月度考核 GMV 目标（元），经营目标进度分母
 *   break_even_roi         保本 ROI（净口径）
 *   avg_order_price        客单价（阈值体系 P）
 *   live_start_date        开播日期(YYYY-MM-DD)，记录直播间启用时间
 */
const EDITABLE = {
  gmv_target_monthly: { type: 'number', min: 0, label: '月度考核GMV目标(元)' },
  break_even_roi: { type: 'number', min: 0.1, label: '保本ROI(净口径)' },
  avg_order_price: { type: 'number', min: 0, label: '客单价(元)' },
  live_start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', label: '开播日期(YYYY-MM-DD)' },
  system_launch_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', label: '系统上线日期(YYYY-MM-DD，价值看板锚点)' },
};
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.json');

async function handleConfig(req, res, url) {
  const { manual_config } = require('../lib/config');

  if (req.method === 'GET') {
    const { getAccountParams } = require('../lib/api-helpers');
    const account = url.searchParams.get('account');
    const params = getAccountParams(account);
    const out = {};
    for (const k of Object.keys(EDITABLE)) out[k] = manual_config[k] ?? null;
    return sendJSON(res, {
      ok: true,
      editable: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, v.label])),
      manual_config: out,
      account_params: account ? { account, break_even_roi: params.break_even_roi, avg_order_price: params.avg_order_price, gmv_target_monthly: params.gmv_target_monthly, live_start_date: params.live_start_date } : null,
    });
  }

  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修）
  const bodyCheck = checkBodyKeys(data, ['key', 'value', 'account'], '/api/config');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

  const { key, value, account } = data || {};
  const spec = EDITABLE[key];
  if (!spec) {
    return sendJSON(res, { ok: false, error: `不可编辑的 key: ${key}（白名单：${Object.keys(EDITABLE).join('/')}）` }, 400);
  }

  let v = value;
  if (spec.type === 'number') {
    v = Number(value);
    if (!Number.isFinite(v) || v < (spec.min ?? 0)) {
      return sendJSON(res, { ok: false, error: `${key} 必须为 ≥${spec.min ?? 0} 的数字` }, 400);
    }
  } else if (spec.type === 'bool') {
    v = value === true || value === 'true' || value === 1 || value === '1';
  } else if (spec.type === 'string') {
    v = String(value == null ? '' : value);
    if (spec.pattern && !(new RegExp(spec.pattern).test(v))) {
      return sendJSON(res, { ok: false, error: `${key} 格式不正确（要求：${spec.label}）` }, 400);
    }
  }

  // 按账号写入 account_config（如果传了 account），否则写全局 manual_config
  try {
    if (account) {
      // 账号白名单（2026-08-11 审查修复）：拼错账号会写进 account_config 产生幽灵配置
      try { require('../lib/api-helpers').validateAccount(account); } catch (e) {
        return sendJSON(res, { ok: false, error: e.message }, 400);
      }
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (account) {
      if (!raw.account_config) raw.account_config = {};
      if (!raw.account_config[account]) raw.account_config[account] = {};
      raw.account_config[account][key] = v;
      // 内存同步
      const { account_config } = require('../lib/config');
      if (!account_config[account]) account_config[account] = {};
      account_config[account][key] = v;
      console.log(`[config] account_config.${account}.${key} = ${JSON.stringify(v)}（内存+落盘已生效）`);
    } else {
      manual_config[key] = v;
      raw.manual_config = { ...(raw.manual_config || {}), [key]: v };
      console.log(`[config] manual_config.${key} = ${JSON.stringify(v)}（内存+落盘已生效）`);
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), 'utf8');
  } catch (e) {
    return sendJSON(res, { ok: false, error: `内存已生效但落盘失败: ${e.message}` }, 500);
  }
  return sendJSON(res, { ok: true, key, value: v, account: account || null, manual_config });
}

module.exports = handleConfig;
