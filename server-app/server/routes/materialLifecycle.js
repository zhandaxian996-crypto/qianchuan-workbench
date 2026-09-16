const { sendJSON, getLocalDateStr, daysAgo, num } = require('../lib/utils');
const { getRangeHistory } = require('../lib/db');
const { buildThresholds, getLatestMaterialsAll } = require('../lib/liveCollector');
const { fetchLiveMaterials } = require('../lib/qianchuanTabs');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');

/**
 * GET /api/material-lifecycle?account=xxx
 *
 * 素材生命周期看板（设计稿 v2 四列：探索期 / 验证中 / S级·长寿 / 衰退期）。
 *
 * 数据源：
 *   - material_history.db 的 material_daily 表（当月累计聚合 + 近90天逐日明细算历史峰值）
 *   - liveCollector 今日实时增量（今天上线的新素材也要出现）
 *
 * 分层规则（P=客单价，R=保本ROI，阈值复用 liveCollector.buildThresholds）：
 *   explore    累计 cost < P×1.5
 *   declining  近7日ROI较历史峰值跌 ≥50%（优先级高于 s_level）
 *   s_level    累计 cost ≥ P×2 且 ROI ≥ R×1.3
 *   verifying  其余
 *
 * ROI 口径：累计 net_gmv ÷ 累计 cost（净成交ROI）
 *
 * 返回：{ ok, account, thresholds, columns: { explore: [], verifying: [], s_level: [], declining: [] } }
 *   每条素材：{ material_id, name, cost_total, roi, days_live, spark7d }
 *   declining 列另加：{ peak_roi, decline_days }
 */
async function handleMaterialLifecycle(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  const account = url.searchParams.get('account') || url.searchParams.get('accountId');
  if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);

  try {
    const today = getLocalDateStr();
    const monthStart = today.slice(0, 7) + '-01';
    const thresholds = buildThresholds(account) || {};
    const P = thresholds.avg_order_price || 50;   // 客单价（兜底50，与 diagnose 一致）
    const R = thresholds.break_even_roi || 2.0;   // 保本ROI

    // 近7日日期列表（spark7d，升序，今天在最后）
    const last7Dates = [];
    for (let i = 6; i >= 0; i--) last7Dates.push(daysAgo(i));

    // 1. DB 逐日明细（近90天，足够覆盖"历史峰值"语义）
    const rows = getRangeHistory(daysAgo(89), today, account);

    // 2. 主计划当前素材母集。生命周期页的“全部素材/在投素材”必须以千川
    // list-required 为准；material_history 只包含已经产生历史数据的子集，不能
    // 把“有消耗样本”误写成“在投素材”。上游不可用时才降级为历史库范围。
    let planRows = [];
    let planScopeComplete = false;
    try {
      const acc = QIANCHUAN_ACCOUNTS.find(item => item.id === account);
      if (acc && acc.anchorId) {
        const planResult = await fetchLiveMaterials(acc.anchorId, {
          accountId: account,
          startDate: today,
          endDate: today,
          status: '1',
          pageSize: 500,
        });
        planRows = planResult.rows || [];
        planScopeComplete = planResult.totalCountReliable === true
          && planRows.length >= Number(planResult.totalCount || 0);
      }
    } catch (e) {
      console.warn(`[material-lifecycle] 主计划素材母集读取失败，降级为历史范围: ${e.message}`);
    }

    // 3. 今日实时增量（大屏，延迟几分钟）
    let liveMats = [];
    try { liveMats = getLatestMaterialsAll(account) || []; } catch (e) { liveMats = []; }
    // key 规约：真实 material_id；占位 id（'-'/'-2'，AIGC集合）用 NAME::名称 避免互相串数据
    const liveById = new Map();   // material_id → { cost, netGmv }
    const liveByName = new Map(); // name → { cost, netGmv }
    for (const m of liveMats) {
      const cost = num(m.cost);
      if (cost <= 0) continue;
      const netGmv = num(m.gmvSettle);
      const id = m.material_id && m.material_id !== '-' && m.material_id !== '-2' ? String(m.material_id) : null;
      if (id) {
        const prev = liveById.get(id) || { cost: 0, netGmv: 0, name: m.name || '' };
        prev.cost += cost; prev.netGmv += netGmv;
        if (!prev.name && m.name) prev.name = m.name;
        liveById.set(id, prev);
      } else if (m.name) {
        const prev = liveByName.get(m.name) || { cost: 0, netGmv: 0 };
        prev.cost += cost; prev.netGmv += netGmv;
        liveByName.set(m.name, prev);
      }
    }

    // 4. 按素材聚合（DB 部分只累计到昨天；今天用实时增量，避免 T+1 未回传造成缺失/双计）
    const byMat = new Map(); // material_id → agg
    for (const r of rows) {
      if (!r.material_id || r.material_id === '__EMPTY__') continue;
      let a = byMat.get(r.material_id);
      if (!a) {
        a = {
          material_id: r.material_id,
          name: r.material_name || r.material_id,
          created_at: null,
          firstDate: r.stat_date,
          monthCost: 0,     // 当月累计（不含今天）
          monthNetGmv: 0,
          dailyMap: new Map(), // date → { cost, netGmv }（含今天 DB 行，作实时缺失时的兜底）
        };
        byMat.set(r.material_id, a);
      }
      if (r.material_name && (!a.name || a.name === a.material_id)) a.name = r.material_name;
      if (r.created_at && (!a.created_at || String(r.created_at) < String(a.created_at))) a.created_at = r.created_at;
      if (r.stat_date < a.firstDate) a.firstDate = r.stat_date;
      // 净成交口径：1h 结算优先（真净成交扣退款）；老数据无 1h 列时回退 net_gmv（实付口径，标脏混合期）
      const net1h = num(r.net_gmv_1h) || num(r.net_gmv);
      a.dailyMap.set(r.stat_date, { cost: num(r.cost), netGmv: net1h });
      if (r.stat_date >= monthStart && r.stat_date < today) {
        a.monthCost += num(r.cost);
        a.monthNetGmv += net1h;
      }
    }

    // 将千川主计划清单并入聚合母集，包括当天尚未产生消耗的素材。
    // 这些素材仍然是“投放中”，不能因为 cost=0 从生命周期页面消失。
    const planIds = new Set();
    for (const row of planRows) {
      const d = row.dimensions || {};
      const m = row.metrics || {};
      const id = d.materialId && !['0', '-', '-2'].includes(String(d.materialId))
        ? String(d.materialId)
        : null;
      if (!id) continue;
      planIds.add(id);
      let a = byMat.get(id);
      if (!a) {
        a = {
          material_id: id,
          name: d.roi2MaterialVideoName || id,
          created_at: d.roi2MaterialUploadTime || null,
          firstDate: today,
          monthCost: 0,
          monthNetGmv: 0,
          dailyMap: new Map(),
        };
        byMat.set(id, a);
      }
      a.in_plan = true;
      if (d.roi2MaterialVideoName) a.name = d.roi2MaterialVideoName;
      if (!a.created_at && d.roi2MaterialUploadTime) a.created_at = d.roi2MaterialUploadTime;
      // list-required 同时返回本自然日的权威实时指标。此前只合并 ID，导致
      // 页面虽然能显示完整素材数，累计消耗仍停留在本地采集子集（约 70 元）。
      a.todayLive = {
        cost: num(m.statCostForRoi2),
        netGmv: num(m.totalOrderSettleAmountForRoi21H),
      };
    }

    // 名称反查（AIGC:: 合成 id 的素材按 name 匹配实时增量）
    const idByName = new Map();
    for (const a of byMat.values()) {
      if (a.name && !idByName.has(a.name)) idByName.set(a.name, a.material_id);
    }

    // 5. 合并今日实时增量
    const touched = new Set();
    for (const [id, v] of liveById) {
      let a = byMat.get(id);
      if (!a) {
        a = { material_id: id, name: v.name || id, created_at: null, firstDate: today, monthCost: 0, monthNetGmv: 0, dailyMap: new Map() };
        byMat.set(id, a);
      }
      // 主计划清单完整时，优先使用同一次 list-required 返回的全量实时指标；
      // 大屏采集只作为上游清单不可用时或非计划素材的回退。
      if (!(planScopeComplete && a.in_plan && a.todayLive)) {
        a.todayLive = { cost: v.cost, netGmv: v.netGmv };
      }
      touched.add(id);
    }
    for (const [name, v] of liveByName) {
      const id = idByName.get(name);
      if (id && !touched.has(id)) {
        const a = byMat.get(id);
        a.todayLive = { cost: v.cost, netGmv: v.netGmv };
        touched.add(id);
      } else if (!id) {
        // 今天新上线、DB 还没有的素材（占位 id → 用名称合成稳定 key 展示）
        const synthId = `LIVE::${name}`;
        if (!byMat.has(synthId)) {
          byMat.set(synthId, {
            material_id: synthId, name, created_at: null, firstDate: today,
            monthCost: 0, monthNetGmv: 0, dailyMap: new Map(),
            todayLive: { cost: v.cost, netGmv: v.netGmv },
          });
        }
      }
    }

    // 6. 组装每条素材的输出 + 分层
    const columns = { explore: [], verifying: [], s_level: [], declining: [], archived: [] };

    // 占位素材：AIGC 功能开关 / 直播间集合，不是单条素材，不参与单素材生命周期分层
    // 2026-07-30 审计统一：与 materialScorecards.isAigcRow 同口径——LIVE 仅认 id 的 "LIVE::" 前缀，
    // 名字里含 "LIVE" 字样的真实素材不再被误剔（此前 /AIGC|LIVE/ 匹配 id+name 整体，误杀真素材）
    const isPlaceholder = (id, name) => {
      return /^(AIGC|LIVE)::/.test(String(id || ''))
        || ['-', '-2'].includes(String(id));
    };

    // —— 第一遍：收集所有素材基础指标，用于计算动态阈值 ——
    const pool = [];
    for (const a of byMat.values()) {
      // 主计划清单完整时，它是当前“投放中”的权威范围；历史库里已经移出
      // 主计划的旧素材不再混入本页。读取失败时保留原有历史降级能力。
      if (planScopeComplete && !a.in_plan) continue;
      const dbToday = a.dailyMap.get(today);
      const todayCost = a.todayLive ? a.todayLive.cost : (dbToday ? dbToday.cost : 0);
      const todayNetGmv = a.todayLive ? a.todayLive.netGmv : (dbToday ? dbToday.netGmv : 0);

      const costTotal = a.monthCost + todayCost;
      const netGmvTotal = a.monthNetGmv + todayNetGmv;
      if (costTotal <= 0 && !a.in_plan) continue;

      const roi = costTotal > 0 ? netGmvTotal / costTotal : 0;

      const start90 = daysAgo(89);
      let cost90 = 0;
      for (const [d, v] of a.dailyMap) { if (d >= start90 && d <= today) cost90 += v.cost; }

      let cost7 = 0, netGmv7 = 0;
      for (const d of last7Dates) {
        if (d === today) { cost7 += todayCost; netGmv7 += todayNetGmv; }
        else {
          const dayRow = a.dailyMap.get(d);
          if (dayRow) { cost7 += dayRow.cost; netGmv7 += dayRow.netGmv; }
        }
      }

      const placeholder = isPlaceholder(a.material_id, a.name);

      let daysLive = placeholder ? null : 1;
      if (!placeholder) {
        const createdRaw = a.created_at ? String(a.created_at).slice(0, 10) : (a.firstDate || today);
        if (/^\d{4}-\d{2}-\d{2}$/.test(createdRaw)) {
          daysLive = Math.max(1, Math.floor((new Date(today + 'T00:00:00') - new Date(createdRaw + 'T00:00:00')) / 86400000) + 1);
        }
      }

      const spark7d = last7Dates.map(d => {
        if (d === today) return +todayCost.toFixed(2);
        const dayRow = a.dailyMap.get(d);
        return +(dayRow ? dayRow.cost : 0).toFixed(2);
      });

      let activeDays = 0;
      for (const v of a.dailyMap.values()) { if ((v.cost || 0) >= 10) activeDays++; }
      if (todayCost >= 10) activeDays++;

      pool.push({
        material_id: a.material_id,
        name: a.name,
        cost_total: +costTotal.toFixed(2),
        roi: +roi.toFixed(2),
        days_live: daysLive,
        active_days: activeDays,
        spark7d,
        is_placeholder: placeholder,
        cost90,
        cost7,
        netGmv7,
        dailyMap: a.dailyMap,
        in_plan: a.in_plan === true,
      });
    }

    // —— 动态稳定期算法：账号自适应 ——
    // 1. 消耗线：覆盖账号总消耗 70% 的头部素材中，消耗最低的那一条
    const sortedByCost = pool.filter(m => !m.is_placeholder).sort((a, b) => b.cost_total - a.cost_total);
    const totalCost = sortedByCost.reduce((s, m) => s + m.cost_total, 0);
    let cum = 0, stableCostLine = 0, stableTopN = 0;
    for (let i = 0; i < sortedByCost.length; i++) {
      cum += sortedByCost[i].cost_total;
      if (cum / totalCost >= 0.7) {
        stableTopN = i + 1;
        stableCostLine = sortedByCost[i].cost_total;
        break;
      }
    }
    if (!stableCostLine) stableCostLine = sortedByCost.length ? sortedByCost[sortedByCost.length - 1].cost_total : 0;

    // 2. 活跃线：该账号有效活跃天数 p60（即 60% 素材的活跃天数不超过这个值）
    const activeVals = sortedByCost.map(m => m.active_days).sort((a, b) => a - b);
    let stableActiveLine = activeVals.length ? Math.max(3, activeVals[Math.floor(activeVals.length * 0.6)] || 3) : 5; // 2026-08-01 冒烟修复：原为 const，下方兜底分支重赋值直接 500（素材<10 条才触发的老 bug）

    // 3. 兜底：素材太少时回退到固定值
    if (sortedByCost.length < 10) {
      stableCostLine = Math.max(stableCostLine, P * 2);
      stableActiveLine = 5;
    }

    // 把动态阈值透给前端
    thresholds.stable_cost_line = +stableCostLine.toFixed(2);
    thresholds.stable_active_line = stableActiveLine;
    thresholds.stable_top_n = stableTopN;
    thresholds.stable_share = 0.7;

    // —— 第二遍：按动态阈值分层 ——
    for (const item of pool) {
      const { material_id, name, cost_total, roi, days_live, active_days, spark7d, is_placeholder, cost90, cost7, netGmv7, dailyMap } = item;

      // 僵尸素材：上线久、不活跃、近7日几乎无消耗 → 归档
      if (!is_placeholder && days_live > 60 && active_days <= 2 && cost7 < 10) {
        columns.archived.push(item);
        continue;
      }

      // 探索期：近90天累计消耗未过探索线，且必须是新素材或占位素材（老素材一律不进探索期）
      if (cost90 < P * 1.5 && (days_live == null || days_live <= 30)) {
        columns.explore.push(item);
        continue;
      }

      // 衰退判定：近7日ROI 较历史峰值跌 ≥50%
      let peakRoi = 0;
      for (const [d, v] of dailyMap) {
        if (d >= today) continue;
        if (v.cost >= P * 0.5) {
          const dayRoi = v.netGmv / v.cost;
          if (dayRoi > peakRoi) peakRoi = dayRoi;
        }
      }
      const roi7 = cost7 > 0 ? netGmv7 / cost7 : 0;

      let isDeclining = false;
      let declineDays = 0;
      if (peakRoi > 0 && cost7 > 0 && roi7 <= peakRoi * 0.5) {
        isDeclining = true;
        for (const d of last7Dates) {
          let dc, dn;
          if (d === today) { dc = item.todayLive ? item.todayLive.cost : 0; dn = item.todayLive ? item.todayLive.netGmv : 0; }
          else {
            const dayRow = dailyMap.get(d);
            dc = dayRow ? dayRow.cost : 0; dn = dayRow ? dayRow.netGmv : 0;
          }
          if (dc > 0 && dn / dc <= peakRoi * 0.5) declineDays++;
        }
      }

      if (isDeclining) {
        columns.declining.push({ ...item, peak_roi: +peakRoi.toFixed(2), decline_days: declineDays });
      } else if (cost_total >= stableCostLine && active_days >= stableActiveLine) {
        columns.s_level.push(item);
      } else {
        columns.verifying.push(item);
      }
    }

    // 每列按累计消耗降序
    for (const key of Object.keys(columns)) {
      columns[key].sort((x, y) => y.cost_total - x.cost_total);
    }

    return sendJSON(res, {
      ok: true,
      account,
      thresholds,
      columns,
      scope: {
        source: planScopeComplete ? 'qianchuan_plan_live' : 'history_fallback',
        complete: planScopeComplete,
        in_plan_total: planScopeComplete ? planIds.size : null,
      },
    });
  } catch (e) {
    console.error('[material-lifecycle] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleMaterialLifecycle;
