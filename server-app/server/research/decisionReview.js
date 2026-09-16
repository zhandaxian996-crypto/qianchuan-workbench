/**
 * server/lib/decisionReview.js — 决策后验评分
 *
 * 读 op-log（operation_log 表）中的写操作，对每条操作对比其前后窗口的
 * material_daily 数据，给出后验评分（score -2~+2 / verdict 中文一句话 / evidence 量化数据）。
 *
 * 评分口径（2026-07-22 起改为相对口径）：
 *   判胜 = 操作后窗口指标 vs 操作前基线（post ≥ pre，素材级 T+1 数据对比）——
 *   量效双升 +2；量缩效升/效稳升 +1；量效双杀 -1/-2；量升效降 0（换量待观察）。
 *   旧绝对口径（净ROI≥保本线判胜）废弃：保本线 2.0 是支付口径考核线，与"操作是否有效"
 *   无关——绝对口径下大盘自然胜率仅 2.2%，任何策略恒判 0%。
 *   保本线（config manual_config.break_even_roi）仅保留作止损类操作的误伤守卫。
 *   e2e 测试数据通过 operationLog.query 的 excludeSources 排除，不参与后验。
 *
 * 窗口说明：material_daily 是天粒度（T+1 回填），"操作前后24小时"按天取整——
 *   前窗口 = 操作日前一天，后窗口 = 操作日当天；当天数据未回填时标记 pending（score 0）。
 *   止损类操作（暂停/删除）效果体现在次日是否止住流失，另看操作日后一天窗口。
 *
 * 目标定位：target_type=material 时 target_id（逗号分隔）即素材ID；
 *   追投类操作按 assistTaskId 反查 material_boost_task 找所属素材；
 *   都找不到时退化为账号整体口径（evidence.scope='account'）。
 */

// 退役实现：仅供历史审计与隔离测试，在线入口禁止导入。
const { getDB } = require('../lib/db');
const { query: queryOpLog } = require('../lib/operationLog');
const config = require('../lib/config');

// 止损类操作：目的本身是砍掉流失点，评分口径与放量类相反（见 scoreOp）
const STOP_ACTIONS = new Set(['pause', 'delete_boost', 'delete_material']);

// 显著变化阈值：净GMV变动 ≥10% 或 ≥100元才算"增长/下滑"，否则视为无显著变化
const MIN_DELTA_YUAN = 100;
const MIN_DELTA_RATIO = 0.1;

// 保本ROI：与 liveDashboard/liveCollector 同口径，取 config manual_config
function breakEvenRoi() {
  return (config.manual_config && config.manual_config.break_even_roi) || 2.0;
}

/** 本地日期 YYYY-MM-DD */
function localDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 日期字符串 +/- n 天 */
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/**
 * 反查追投任务所属素材：扫 opDate 前后 3 天的 material_boost_task.tasks_json。
 * @returns {string[]} 素材ID数组（找不到返回空）
 */
function findMaterialsByBoostTask(accountId, assistTaskId, opDate) {
  if (!assistTaskId) return [];
  const db = getDB();
  const rows = db.prepare(`
    SELECT material_id, tasks_json FROM material_boost_task
    WHERE account_id = ? AND stat_date >= ? AND stat_date <= ?
  `).all(accountId, shiftDate(opDate, -3), shiftDate(opDate, 1));
  const ids = new Set();
  for (const r of rows) {
    try {
      const tasks = JSON.parse(r.tasks_json || '[]');
      if (Array.isArray(tasks) && tasks.some(t => String(t.id || t.assist_task_id || '') === String(assistTaskId))) {
        ids.add(r.material_id);
      }
    } catch { /* 单行损坏跳过 */ }
  }
  return [...ids];
}

/** 从 op-log 记录解析评分目标（素材ID列表 / 账号整体） */
function resolveScope(op, opDate) {
  if (op.target_type === 'material' && op.target_id) {
    const ids = String(op.target_id).split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length) return { scope: 'material', material_ids: ids };
  }
  const taskId = op.assist_task_id || (op.params && op.params.assistTaskId);
  const ids = findMaterialsByBoostTask(op.account_id, taskId, opDate);
  if (ids.length) return { scope: 'material', material_ids: ids };
  return { scope: 'account', material_ids: [] };
}

/** 汇总某账号某天指定范围（素材集合或全账号）的消耗/净GMV */
function sumDaily(accountId, statDate, materialIds) {
  const db = getDB();
  let rows;
  if (materialIds && materialIds.length) {
    const ph = materialIds.map(() => '?').join(',');
    rows = db.prepare(`
      SELECT COUNT(*) AS row_count, ROUND(SUM(cost),2) AS cost, CASE WHEN COUNT(net_gmv_1h)=COUNT(*) THEN ROUND(SUM(net_gmv_1h),2) ELSE NULL END AS net_gmv
      FROM material_daily
      WHERE account_id = ? AND marketing_goal = 2 AND stat_date = ? AND material_id IN (${ph})
    `).get(accountId, statDate, ...materialIds);
  } else {
    rows = db.prepare(`
      SELECT COUNT(*) AS row_count, ROUND(SUM(cost),2) AS cost, CASE WHEN COUNT(net_gmv_1h)=COUNT(*) THEN ROUND(SUM(net_gmv_1h),2) ELSE NULL END AS net_gmv
      FROM material_daily
      WHERE account_id = ? AND marketing_goal = 2 AND stat_date = ? AND material_id != '__EMPTY__'
    `).get(accountId, statDate);
  }
  const cost = (rows && rows.cost) || 0;
  const netGmv = rows && rows.net_gmv != null ? rows.net_gmv : null;
  return { date: statDate, row_count: rows?.row_count || 0, cost, net_gmv: netGmv, roi: cost > 0 && netGmv != null ? +(netGmv / cost).toFixed(2) : null, has_data: !!(rows && rows.cost != null && netGmv != null) };
}

/** 对单条操作评分（相对口径：操作后窗口 vs 操作前基线，post ≥ pre 判胜） */
function scoreOp(op) {
  const opDate = String(op.ts || '').slice(0, 10);
  const be = breakEvenRoi();
  const { scope, material_ids } = resolveScope(op, opDate);
  const before = sumDaily(op.account_id, shiftDate(opDate, -1), scope === 'material' ? material_ids : null);
  const after = sumDaily(op.account_id, opDate, scope === 'material' ? material_ids : null);
  const delta = before.has_data && after.has_data ? +(after.net_gmv - before.net_gmv).toFixed(2) : null;
  const deltaRatio = before.net_gmv > 0 ? delta / before.net_gmv : (delta > 0 ? 1 : 0);
  // 相对口径判胜：操作后净ROI vs 操作前基线。基线 ROI 为 0（前日无消耗/无成交）时
  // "持平"无意义，要求操作后 ROI 为正才算改善（花钱零成交不能判胜）
  const roiDelta = before.roi != null && after.roi != null ? +(after.roi - before.roi).toFixed(2) : null;
  const roiUp = before.roi > 0 ? roiDelta >= 0 : after.roi > 0;
  const isStop = STOP_ACTIONS.has(op.action);

  const evidence = {
    scope, material_ids,
    break_even_roi: be, // 仅作止损误伤守卫参照，不再用于判胜
    before, after,
    delta_net_gmv: delta,
    delta_ratio: +deltaRatio.toFixed(3),
    roi_delta: roiDelta,
  };

  const scopeName = scope === 'material' ? `素材${material_ids.length > 1 ? '×' + material_ids.length : ''}` : '账号整体';
  const fmt = w => `${w.date} 消耗${w.cost}元/净GMV ${w.net_gmv}元/净ROI ${w.roi}`;
  const roiArrow = `${before.roi}→${after.roi}`;

  // 后窗口数据未回填（T+1 延迟）：无法后验，标记 pending
  if (!after.has_data) {
    return { score: 0, verdict: `当日素材数据尚未回填（T+1），暂无法后验`, pending: true, evidence };
  }
  if (!before.has_data) return { score: 0, verdict: '操作前基线缺失，暂无法比较', pending: true, evidence };
  // 前后都无消耗：无从评判
  if (before.cost === 0 && after.cost === 0) {
    return { score: 0, verdict: `操作前后${scopeName}均无消耗，无数据可评`, pending: false, evidence };
  }
  // 止损类（暂停/删除）：效果体现在次日是否止住流失，同口径看次日窗口
  if (isStop) {
    const next = sumDaily(op.account_id, shiftDate(opDate, 1), scope === 'material' ? material_ids : null);
    evidence.next = next;
    // 误伤守卫：保本线在此仅用于判断"操作前是否流失"，不作判胜依据
    if (before.roi >= be && before.cost > 0) {
      return { score: -1, verdict: `疑似误伤：${scopeName}操作前净ROI ${before.roi} ≥ 保本线 ${be}，暂停/删除需复核`, pending: false, evidence };
    }
    if (!next.has_data) {
      // 素材口径下次日无行：若账号整体次日有数据，说明该素材已彻底停消耗——止损成功而非数据缺失
      if (scope === 'material' && next.row_count === 0) {
        const accNext = sumDaily(op.account_id, shiftDate(opDate, 1), null);
        if (accNext.has_data) {
          return { score: 2, verdict: `止损成功：${scopeName}操作前净ROI ${before.roi} 低于保本线 ${be}，次日该素材已无任何消耗`, pending: false, evidence };
        }
      }
      return { score: 0, verdict: `止损方向待确认：${scopeName}操作前净ROI ${before.roi} 低于保本线 ${be}，次日数据未回填`, pending: true, evidence };
    }
    if (next.cost <= before.cost * 0.5) {
      return { score: 2, verdict: `止损成功：${scopeName}操作前净ROI ${before.roi} 低于保本线 ${be}，次日消耗降到 ${next.cost} 元，斩断了流失点`, pending: false, evidence };
    }
    // 相对口径：次日净ROI 回升到操作前基线之上（且为正）记止血见效
    if (next.roi > 0 && next.roi >= before.roi) {
      return { score: 1, verdict: `止血见效：${scopeName}次日净ROI ${before.roi}→${next.roi} 回升到操作前水平之上`, pending: false, evidence };
    }
    return { score: 0, verdict: `止损后仍待观察：${scopeName}次日消耗 ${next.cost} 元、净ROI ${before.roi}→${next.roi} 未见回升`, pending: false, evidence };
  }
  const grown = delta >= MIN_DELTA_YUAN || deltaRatio >= MIN_DELTA_RATIO;
  const shrunk = delta <= -MIN_DELTA_YUAN || deltaRatio <= -MIN_DELTA_RATIO;

  if (grown && roiUp) {
    return { score: 2, verdict: `放量成功：${scopeName}净GMV +${delta}元 且净ROI ${roiArrow} 不降（${fmt(after)}）`, pending: false, evidence };
  }
  if (grown && !roiUp) {
    return { score: 0, verdict: `量升效降：${scopeName}净GMV +${delta}元 但净ROI ${roiArrow} 下滑，换量代价待观察`, pending: false, evidence };
  }
  if (shrunk && roiUp) {
    return { score: 1, verdict: `收口见效：${scopeName}净GMV ${delta}元 缩量，净ROI ${roiArrow} 回升`, pending: false, evidence };
  }
  if (shrunk && !roiUp) {
    const severe = deltaRatio <= -0.3 || (after.cost >= 200 && before.roi > 0 && after.roi < before.roi * 0.5);
    return severe
      ? { score: -2, verdict: `严重失血：${scopeName}净GMV ${delta}元 且净ROI ${roiArrow} 崩塌，钱打了水漂`, pending: false, evidence }
      : { score: -1, verdict: `量效双杀：${scopeName}净GMV ${delta}元，净ROI ${roiArrow} 同步下滑`, pending: false, evidence };
  }
  // 量无显著变化：看净ROI 相对基线
  if (roiUp) {
    return { score: 1, verdict: `有效：${scopeName}净ROI ${roiArrow} 回升/持稳（净GMV变化不显著，${delta >= 0 ? '+' : ''}${delta}元）`, pending: false, evidence };
  }
  return { score: -1, verdict: `效果不佳：${scopeName}净ROI ${roiArrow} 未见改善（${fmt(after)}）`, pending: false, evidence };
}

// 非实际生效动作：预检/被拦截的记录不改变投放状态，不参与后验
const SKIP_ACTIONS = new Set(['delete_material_precheck', 'pause_blocked']);

/** 汇总一组 op-log 记录为评分结果 */
function reviewOps(ops, meta) {
  const items = ops
    .filter(op => op.success && (!op.params?.receipt || op.params.receipt.effect_status === 'confirmed'))
    .filter(op => !SKIP_ACTIONS.has(op.action))
    .map(op => {
      const r = scoreOp(op);
      return {
        op: {
          id: op.id, ts: op.ts, action: op.action, account_id: op.account_id,
          target_type: op.target_type, target_id: op.target_id,
          primary_ad_id: op.primary_ad_id, assist_task_id: op.assist_task_id,
          params: op.params, source: op.source,
        },
        score: r.score,
        verdict: r.verdict,
        pending: r.pending,
        evidence: r.evidence,
      };
    });
  const judged = items.filter(i => !i.pending);
  return {
    ok: true,
    ...meta,
    break_even_roi: breakEvenRoi(),
    count: items.length,
    items,
    summary: {
      judged: judged.length,
      pending: items.length - judged.length,
      plus: judged.filter(i => i.score > 0).length,
      minus: judged.filter(i => i.score < 0).length,
      total_score: judged.reduce((s, i) => s + i.score, 0),
    },
  };
}

/**
 * 后验近 N 小时的写操作（默认 48 小时）。
 * @param {object} [opts]
 * @param {number} [opts.hours=48]
 * @param {string} [opts.accountId] - 不传则两个账号都评
 */
function reviewOperations(opts = {}) {
  const hours = opts.hours || 48;
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  // op-log 的 ts 是本地时间 "YYYY-MM-DD HH:MM:SS"，cutoff 也用本地时间比较（不能用 toISOString，是 UTC）
  const cutoff = localDate(start) + ' ' + String(start.getHours()).padStart(2, '0') + ':' +
    String(start.getMinutes()).padStart(2, '0') + ':' + String(start.getSeconds()).padStart(2, '0');
  const ops = queryOpLog({
    startDate: localDate(start),
    endDate: localDate(end),
    accountId: opts.accountId,
    excludeSources: ['e2e'], // 排除 E2E 测试写操作，不污染后验
    limit: 500,
  }).filter(op => op.ts >= cutoff);
  return reviewOps(ops, { window_hours: hours, generated_at: end.toISOString() });
}

/**
 * 后验某一天（YYYY-MM-DD）的全部写操作（老板评审每日评定的输入）。
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} [accountId] - 不传则两个账号都评
 */
function reviewDay(dateStr, accountId) {
  const ops = queryOpLog({ startDate: dateStr, endDate: dateStr, accountId, excludeSources: ['e2e'], limit: 500 });
  return reviewOps(ops, { date: dateStr, generated_at: new Date().toISOString() });
}

module.exports = {
  reviewOperations,
  reviewDay,
  breakEvenRoi,
};
