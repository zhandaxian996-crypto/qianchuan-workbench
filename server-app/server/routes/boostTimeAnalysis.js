/**
 * boostTimeAnalysis — 追投时段效果分析（可进化）
 *
 * 问题：哪个时间段创建/运行的追投效果最好？
 * 方法：从 material_boost_task 快照取任务，按 assistStartTime（任务开始时间）的小时分组，
 *       统计各时段消耗/GMV/支付ROI/单量。
 *
  * 历史账户专用说明已从试用包移除。
 *   绝不允许作为任何追投决策的依据（不接四验算/盯盘轮/MCP/自动链路）。
 *   原因：时段 ROI 是历史平均，受素材质量/roi_goal/大盘流量/主播状态等强混杂因素影响，
 *   同一时段表现波动大（30天 vs 全历史结论可能相反），不能据此预测未来。
 *   追投决策唯一依据 = 当前任务实时数据 + 操盘纪律（discipline.md）。
 *
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *     或 days 参数（默认 30 天）滚动窗口，每次实时算最新窗口内数据
 *   - 样本门槛：时段任务数 < MIN_TASKS 或 消耗 < MIN_COST → reliable=false，不给结论只给参考
 *   - 快照去重：同一 assistAid 取 stat_date 最新一条，防重复计数
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *     时段 ROI 按「全部 / ai / manual」三组分别统计，返回构成占比，积累期后 AI 段自然露出分身自己的规律。
 *     2026-08-13：作战室前端只展示「全部」不分来源，source 结构保留供接口调用方自取。
  * 历史账户专用说明已从试用包移除。
 *     live_sessions 近窗口真实开播小时分布，标注在卡片上供人工对照
 *
 * GET /api/boost-time-analysis?account=&days=30
 * GET /api/boost-time-analysis?account=&start=2026-08-01&end=2026-08-13
 * 返回：{ ok, account, days, start, end, range:{start,end}, source:{all,ai,manual}, live_slots:[...], summary, reference_only:true }
 */

const { getDB } = require('../lib/db');

// 最小样本门槛：时段任务数 < 3 或 消耗 < 300 元 → 不可靠（样本太少，结论可能误导）
const MIN_TASKS = 3;
const MIN_COST = 300;

function parseHour(startTime) {
  if (!startTime) return null;
  const m = String(startTime).match(/(?:^| )(\d{2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * 核心聚合（纯函数，可测试）：从原始快照行数组计算时段统计
 * @param {Array} snapRows - material_boost_task 行 [{account_id, stat_date, tasks_json}]
 * @param {string} accountId - 账号过滤
 * @param {string} startStr - 'YYYY-MM-DD' 窗口左端（含）
 * @param {string} endDate - 'YYYY-MM-DD' 窗口右端（含）
 * @returns {object} { hours, summary }
 */
function aggregateByHour(snapRows, accountId, startStr, endDate, aiTaskIds) {
  const aiSet = aiTaskIds || new Set();

  // 快照去重：assistAid -> 最新快照（stat_date 最大）
  const latest = {};
  for (const r of snapRows) {
    if (r.account_id !== accountId) continue;
    let tasks = [];
    try { tasks = JSON.parse(r.tasks_json); } catch (e) { continue; }
    for (const t of tasks) {
      if (!t || !t.assistAid || !t.assistStartTime) continue;
      const d = String(t.assistStartTime).substring(0, 10);
      if (d < startStr || d > endDate) continue; // 只统计窗口内开始的任务
      if (!latest[t.assistAid] || r.stat_date > latest[t.assistAid].snap) {
        latest[t.assistAid] = { snap: r.stat_date, t };
      }
    }
  }

  // 按小时分组（分三组：全部 / ai / manual）
  const mk = () => ({ tasks: 0, cost: 0, gmv: 0, orders: 0 });
  const byHourAll = {}, byHourAi = {}, byHourManual = {};
  for (const k in latest) {
    const { t } = latest[k];
    if (!t) continue;
    const h = parseHour(t.assistStartTime);
    if (h === null) continue;
    const isAi = aiSet.has(String(t.assistAid));
    if (!byHourAll[h]) byHourAll[h] = mk();
    const b = byHourAll[h];
    b.tasks++; b.cost += t.cost || 0; b.gmv += t.gmv || 0; b.orders += t.orders || 0;
    const target = isAi ? byHourAi : byHourManual;
    if (!target[h]) target[h] = mk();
    const c = target[h];
    c.tasks++; c.cost += t.cost || 0; c.gmv += t.gmv || 0; c.orders += t.orders || 0;
  }

  const buildSeries = (byHour) => Object.keys(byHour).map(h => {
    const b = byHour[h];
    return {
      hour: +h,
      tasks: b.tasks,
      cost: round2(b.cost),
      gmv: round2(b.gmv),
      roi: b.cost > 0 ? round2(b.gmv / b.cost) : 0,
      orders: b.orders,
      avgOrderCost: b.orders > 0 ? round2(b.cost / b.orders) : null,
      reliable: b.tasks >= MIN_TASKS && b.cost >= MIN_COST,
    };
  }).sort((a, b) => a.hour - b.hour);

  const hours = buildSeries(byHourAll);
  const hoursAi = buildSeries(byHourAi);
  const hoursManual = buildSeries(byHourManual);

  const summarize = (list) => {
    let tc = 0, tg = 0, tt = 0, to = 0;
    list.forEach(b => { tc += b.cost; tg += b.gmv; tt += b.tasks; to += b.orders; });
    return {
      total_tasks: tt, total_cost: round2(tc), total_gmv: round2(tg),
      total_roi: tc > 0 ? round2(tg / tc) : 0, total_orders: to,
      best_hour: list.filter(h => h.reliable).sort((a, b) => b.roi - a.roi)[0] || null,
      worst_hour: list.filter(h => h.reliable).sort((a, b) => a.roi - b.roi)[0] || null,
    };
  };

  return {
    hours,
    source: { all: summarize(hours), ai: { ...summarize(hoursAi), hours: hoursAi }, manual: { ...summarize(hoursManual), hours: hoursManual } },
    summary: { ...summarize(hours), range: { start: startStr, end: endDate } },
  };
}

/** 直播场次开播小时分布（窗口内真实开播时段，供追投时段对照） */
function liveSlots(liveRows, accountId, startStr, endDate) {
  const byHour = {};
  for (const r of liveRows) {
    if (r.account_id !== accountId || !r.start_time) continue;
    const d = String(r.start_time).substring(0, 10);
    if (d < startStr || d > endDate) continue;
    const h = parseInt(String(r.start_time).substring(11, 13), 10);
    if (Number.isNaN(h)) continue;
    if (!byHour[h]) byHour[h] = { hour: h, sessions: 0 };
    byHour[h].sessions++;
  }
  return Object.values(byHour).sort((a, b) => a.hour - b.hour);
}

function round2(n) { return Math.round(n * 100) / 100; }

async function handleBoostTimeAnalysis(req, res, url) {
  const sendJSON = (r, body, code) => { r.writeHead(code || 200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(body)); };
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  try {
    const account = url.searchParams.get('account') || null;
    if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);

    // 历史账户专用说明已从试用包移除。
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const sp = url.searchParams.get('start'), ep = url.searchParams.get('end');
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let startStr, endDate, days;
    if (sp && ep && dateRe.test(sp) && dateRe.test(ep)) {
      startStr = sp < ep ? sp : ep;          // 防呆：start>end 时交换
      endDate = ep > todayStr ? todayStr : ep; // end 不越过今天（未来无数据）
      days = Math.round((new Date(endDate) - new Date(startStr)) / 86400000) + 1;
    } else {
      days = Math.min(90, Math.max(7, parseInt(url.searchParams.get('days') || '30', 10) || 30));
      endDate = todayStr;
      const sd = new Date(endDate);
      sd.setDate(sd.getDate() - (days - 1));
      startStr = sd.toISOString().slice(0, 10);
    }

    const db = getDB();
    const rows = db.prepare('SELECT account_id, stat_date, tasks_json FROM material_boost_task').all();
    // 历史账户专用说明已从试用包移除。
    const aiRows = db.prepare("SELECT assist_task_id FROM operation_log WHERE action='create_boost' AND success=1 AND assist_task_id IS NOT NULL").all();
    const aiTaskIds = new Set();
    for (const r of aiRows) {
      // 历史账户专用说明已从试用包移除。
      const p = db.prepare("SELECT params FROM operation_log WHERE assist_task_id=?").get(r.assist_task_id);
      if (p && p.params) {
        try {
          const pp = JSON.parse(p.params);
          const name = pp.name || '';
          if (/^(AI-|Agent-)/.test(name)) aiTaskIds.add(String(r.assist_task_id));
        } catch (e) {}
      }
    }
    const liveRows = db.prepare('SELECT account_id, start_time FROM live_sessions').all();
    const { hours, source, summary } = aggregateByHour(rows, account, startStr, endDate, aiTaskIds);
    const live_slots = liveSlots(liveRows, account, startStr, endDate);

    return sendJSON(res, { ok: true, account, days, start: startStr, end: endDate, hours, source, live_slots, summary, reference_only: true, disclaimer: '仅人工参考，禁止作为追投决策依据（2026-08-03 维护者指令）', min_tasks: MIN_TASKS, min_cost: MIN_COST });
  } catch (e) {
    console.error('[boost-time-analysis] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleBoostTimeAnalysis;
module.exports._test = { aggregateByHour, parseHour, liveSlots };
