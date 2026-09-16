const fs = require('fs');
const path = require('path');
const http = require('http');
const { sendJSON, getLocalDateStr, daysAgo, num } = require('../lib/utils');
const { readQcCookie, isCookieProbablyValid, resolveQcAccount } = require('../lib/cookie');
const { fetchLiveStatus, fetchBoostTaskReport, fetchLiveSessions } = require('../lib/qianchuanTabs');
const { getBoostMetricsToday } = require('../lib/metricsService');
const { judgeResumeTask, judgePostLiveTask } = require('../lib/boostGuard');
const { createTTLCache } = require('../lib/cache');
const { handleApiError } = require('../lib/handleApiError');
const { STORAGE_DIR } = require('../lib/config');
const { normalizeFunnel, normalizeChannels, buildLiveFinancialBasis } = require('../lib/decisionContext');
const { loadAccountProfile, toDecisionProfile } = require('../lib/accountProfile');
const { attachRoiGoalContract } = require('../lib/roiBasis');


const cache = createTTLCache(30 * 1000); // 30秒缓存（采集节拍30s，对齐后全链路数据滞后<1分钟）
const balanceCache = createTTLCache(5 * 60 * 1000); // 余额5分钟缓存（直播盯盘需较新值，1分钟主缓存已先挡大部分重复拉取）
const _cachedAdListMap = new Map(); // 全域计划列表日级缓存，按账号分别缓存（计划ID一天内不变；空结果不缓存，避免接口空窗锁死一整天）

function fieldOf(value, ...keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) if (value[key] != null) return value[key];
  return undefined;
}
function finiteValue(value) {
  const raw = typeof value === 'object' && value ? (value.value ?? value.Value ?? value.ValueStr) : value;
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim().replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}
function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}
function buildPlatformRoiRecommendation(suggestion, date, retrievedAt, unavailableReason = null) {
  const source = suggestion?.data || suggestion?.Data || suggestion;
  // Only accept the platform's pure/net recommendation, even when a wrapper
  // changes its casing. Do not substitute the plan's ordinary ROI target.
  const value = finiteValue(fieldOf(source, 'pureEcpRoi2Goal', 'pure_ecp_roi2_goal', 'pureEcpRoi2GoalValue'));
  const empty = boolValue(fieldOf(source, 'isEmpty', 'is_empty'));
  const valid = !unavailableReason
    && source && empty !== true
    && value != null && value > 0;
  return {
    date: date || null,
    net_roi_goal: valid ? value : null,
    roi_goal_basis: 'platform_net_1h',
    refresh_cycle: 'daily',
    source: 'qianchuan_plan_list_optional',
    retrieved_at: retrievedAt || null,
    data_valid: valid,
    reason: valid ? null : (unavailableReason || 'not_returned'),
  };
}

function buildEffectiveDelivery(raw, date, retrievedAt, unavailableReason = null) {
  const data = raw?.data || raw?.Data || raw || null;
  const roi = fieldOf(data, 'effectiveDeliveryPureRoiInfo', 'effective_delivery_pure_roi_info');
  const spend = fieldOf(data, 'effectiveDeliveryCostInfo', 'effective_delivery_cost_info');
  const duration = fieldOf(data, 'effectiveDeliveryProportion', 'effective_delivery_proportion');
  const roiMatch = boolValue(fieldOf(roi, 'isMatch', 'is_match'));
  const spendMatch = boolValue(fieldOf(spend, 'isMatch', 'is_match'));
  const durationMatch = boolValue(fieldOf(duration, 'isMatch', 'is_match'));
  const valid = !unavailableReason && data && roi && spend && duration && roiMatch != null && spendMatch != null && durationMatch != null;
  const numberOrNull = value => finiteValue(value);
  const suggested = numberOrNull(fieldOf(roi, 'suggestRoi', 'suggest_roi'));
  const weighted = numberOrNull(fieldOf(roi, 'weightedRoi', 'weighted_roi'));
  const cost = numberOrNull(fieldOf(spend, 'cost', 'value'));
  const proportion = numberOrNull(fieldOf(duration, 'proportion', 'value'));
  return {
    date: date || null,
    achieved: valid ? Boolean(roiMatch && spendMatch && durationMatch) : null,
    platform_status_code: finiteValue(fieldOf(data, 'roi2EffectiveDelivery', 'roi2_effective_delivery')),
    roi_goal: { achieved: valid ? roiMatch : null, weighted_value: weighted, recommended_max: suggested > 0 ? suggested : null,
      recommendation_available: suggested > 0, roi_goal_basis: 'platform_net_1h' },
    spend: { achieved: valid ? spendMatch : null, value: cost, required: 200 },
    // Platform uses fractions for numeric values (1 => 100%), but sometimes
    // returns a displayed string such as "5%". Preserve that explicit unit.
    duration: { achieved: valid ? durationMatch : null, coverage_percent: (() => {
      const raw = fieldOf(duration, 'proportion', 'value');
      if (raw == null || String(typeof raw === 'object' ? (raw.Value ?? raw.value ?? raw.ValueStr ?? '') : raw).trim() === '') return null;
      const shownPercent = /%\s*$/.test(String(typeof raw === 'object' ? (raw.Value ?? raw.value ?? raw.ValueStr ?? '') : raw));
      return shownPercent ? proportion : +(proportion * 100).toFixed(2);
    })(), required_percent: 50 },
    source: 'qianchuan_effective_delivery', source_at: retrievedAt || null,
    dataValid: Boolean(valid), reason: valid ? null : (unavailableReason || 'not_returned'),
  };
}
const _btrCache = createTTLCache(5 * 60 * 1000); // boost-task-report 状态修正缓存，5分钟
const _slowCache = createTTLCache(10 * 60 * 1000); // 慢数据子缓存（plan/boost/balance）：主缓存30s必然过期，fast path 从这里合并最近一次完整数据，消灭前端"加载中"闪烁
const _effectiveDeliveryCache = createTTLCache(60 * 1000); // 官方有效投放状态分钟级刷新，避免前端轮询重复打上游
const _decisionContextCache = createTTLCache(60 * 1000); // Profile 很小但读取是同步IO；每账号最多每分钟读取一次
const _dashboardCacheKeyByAccount = new Map(); // account -> account|roomId|startTime，切场立即失效

function decisionContextFromProfile(profile) {
  const safeProfile = profile ? toDecisionProfile(profile) : null;
  return safeProfile ? {
    profile_available: true,
    profile_version: safeProfile.profile_version || null,
    calibration_status: safeProfile.status || null,
    execution_mode: safeProfile.execution_mode || 'recommendation_only',
    roi_basis: safeProfile.metrics && safeProfile.metrics.roi_basis || 'unknown',
    funnel_baseline: safeProfile.funnel_baseline || null,
    channel_baseline: safeProfile.channel_baseline || null,
    sustainable_capacity: safeProfile.flow && safeProfile.flow.sustainable_capacity || null,
    sample_thresholds: safeProfile.sample_thresholds || null,
    comparability: safeProfile.comparability || null,
    profile_error: null,
  } : {
    profile_available: false,
    profile_version: null,
    calibration_status: 'missing',
    execution_mode: 'recommendation_only',
    roi_basis: 'unknown',
    funnel_baseline: null,
    channel_baseline: null,
    sustainable_capacity: null,
    sample_thresholds: null,
    comparability: null,
    profile_error: { code: 'profile_missing', retryable: false },
  };
}

function readDecisionContext(account) {
  const cached = _decisionContextCache.get(account);
  if (cached) return cached;
  let context;
  try {
    context = decisionContextFromProfile(loadAccountProfile(account));
  } catch (error) {
    context = {
      profile_available: false,
      profile_version: null,
      calibration_status: 'invalid',
      execution_mode: 'recommendation_only',
      roi_basis: 'unknown',
      funnel_baseline: null,
      channel_baseline: null,
      sustainable_capacity: null,
      sample_thresholds: null,
      comparability: null,
      // HTTP/MCP 只需要稳定错误码；底层路径、解析内容等异常细节不向决策响应透出。
      profile_error: { code: 'profile_unavailable', retryable: true },
    };
  }
  _decisionContextCache.set(account, context);
  return context;
}

// ===== 今日场次对接（直播复盘落盘 → 作战室）=====
// 作战室需要知道"今天播了几场/当前第几场"，且下播后 today 不能落空（否则误报"今日未直播"）。
// 数据源与直播复盘同一份：storage/replay/sessions_<account>_<date>.json。
// 内存 5 分钟缓存 + 落盘 10 分钟新鲜度，避免每次轮询都打 statQuery 队列。
const REPLAY_DIR = path.join(STORAGE_DIR, 'replay');
const _todaySessCache = new Map(); // account -> { ts, date, sessions }
async function getTodaySessions(account, today, signal, cacheOnly = false) {
  const hit = _todaySessCache.get(account);
  if (hit && hit.date === today && Date.now() - hit.ts < 5 * 60 * 1000) return hit.sessions;
  const safeAccount = /^[a-zA-Z0-9_-]+$/.test(account) ? account : 'unknown';
  const fp = path.join(REPLAY_DIR, `sessions_${safeAccount}_${today}.json`);
  let sessions = null, fresh = false, refreshFailed = false;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (j && j.ok && Array.isArray(j.sessions)) sessions = j.sessions;
    fresh = fs.statSync(fp).mtimeMs > Date.now() - 10 * 60 * 1000;
  } catch { /* 无落盘 */ }
  if (cacheOnly) return sessions || (hit?.date === today ? hit.sessions : []);
  if (!sessions || !fresh) {
    try {
      const r = await fetchLiveSessions(today, { accountId: account, signal });
      if (r && !r.error && Array.isArray(r.sessions)) {
        sessions = r.sessions.map(s => ({ ...s, account }));
        try { require('../lib/api-helpers').writeJsonAtomic(fp, { ok: true, account, date: today, sessions }); } catch { /* 落盘失败不阻塞 */ }
      } else refreshFailed = true;
    } catch (e) { refreshFailed = true; /* 接口失败用落盘旧值 */ }
  }
  sessions = sessions || [];
  // 失败空帧不进缓存；若有旧落盘值可返回，但下一请求仍会主动重采。
  if (!refreshFailed || fresh) _todaySessCache.set(account, { ts: Date.now(), date: today, sessions });
  return sessions;
}

// 尝试从 liveCollector 复用已采集数据，避免重复拉取（省 statQuery 队列）
function getCollectorData(account) {
  try {
    const { getLatestWatch } = require('../lib/liveCollector');
    const all = getLatestWatch();
    const found = all.find(a => a.accountId === account);
    // 返回任何找到的账号数据（包括 no_data 状态），
    // 快速路径需要 isLive=false 的情况来避免不必要的千川 API 调用
    if (found) return found;
  } catch (e) { /* liveCollector 不可用，降级自己拉 */ }
  return null;
}

/**
 * GET /api/live-dashboard?account=xxx
 *
 * 直播决策看板 —— 给 AI Agent 每15分钟轮询用。
 * 一次调用聚合：直播状态 + 今日消耗/ROI + 各追投任务实时效果 + 余额。
 *
 * 返回结构：
 *   {
 *     ok, account, server_time,
 *     live: { isLive, rooms: [...] },
 *     today: { cost, gmv, roi, netGmv, netRoi, orderCount },
 *     balance: { total_yuan },
 *     boost_tasks: [{ id, name, status, cost, gmv, roi, budget, roi_goal, ... }],
 *     boost_summary: { total_cost, total_gmv, total_roi, total_orders, count },
 *     suggestions: [...],  // 系统级自动告警（追投0成交/ROI过低等）
 *     decisions: { redList, blackList },  // 红黑榜 enrich：hasBoost / comm{ cost_month,pct,protect,tier,reward } / 黑榜 exempt
 *     plan: { budget, spent_pct, roi_goal, boost_count, boost_max, quota_left } | null,  // 主计划卡
 *     balance: { total_yuan, days_left } | null,  // days_left = 余额 ÷ 近7日日均消耗
 *   }
 */
async function handleLiveDashboard(req, res, url) {
  const account = url.searchParams.get('account') || url.searchParams.get('accountId');
  if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  // 账号白名单：拼错的 account 会静默回落到默认账号 cookie，拿错账号数据做决策（2026-07-25 审查修复）
  const { validateAccount } = require('../lib/api-helpers');
  try { validateAccount(account); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message + '（合法账号见 config.qianchuan_accounts）' }, 400);
  }

  // 历史账户专用说明已从试用包移除。
  // 提纯函数：缓存命中分支与完整流程分支共用，保证 slim 请求不被缓存吞掉
  const slimDashboard = (result, account) => {
    const decisionContext = result.decision_context || readDecisionContext(account);
    const mats = result.materials_top || [];
    const seen = new Set();
    const materials = [];
    for (const m of [...mats.filter(x => x.orders > 0), ...mats.slice(0, 5)]) {
      if (!m || seen.has(m.material_id)) continue;
      seen.add(m.material_id);
      materials.push(m);
      if (materials.length >= 8) break;
    }
    return {
      ok: true, account, slim: true,
      server_time: result.server_time || new Date().toISOString(),
      session_key: result.session_key || null,
      fetchedAt: result.fetchedAt || null,
      component_times: result.component_times || null,
      liveCheckedAt: result.liveCheckedAt || null,
      boost_source_at: result.boost_source_at || null,
      boost_data_valid: result.boost_data_valid === true,
      boost_window: result.boost_window || null,
      boost_truncated: result.boost_truncated === true,
      boost_coverage: result.boost_coverage || null,
      age_ms: result.age_ms ?? null,
      stale: result.stale === true,
      dataValid: result.dataValid === true,
      partial: result.partial === true,
      errors: result.errors || [],
      source: result.source_type || result.today_source || null,
      live: result.live ? {
        isLive: result.live.isLive,
        rooms: (result.live.rooms || []).map(r => ({ roomId: r.roomId, startTime: r.startTime, cost: r.cost })),
      } : null,
      today: result.today || null,
      financial_basis: buildLiveFinancialBasis(),
      funnel: normalizeFunnel(result.funnel, {
        sourceAt: result.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.funnel_baseline,
      }),
      channels: normalizeChannels(result.channels || (Array.isArray(result.source) ? result.source : []), {
        sourceAt: result.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.channel_baseline,
      }),
      decision_context: decisionContext,
      balance: result.balance || null,
      break_even_roi: result.break_even_roi ?? null,
      riskAlerts: result.riskAlerts || [],
      suggestions: (result.suggestions || []).slice(0, 6),
      decisions: result.decisions ? {
        redList: result.decisions.redList || [],
        blackList: result.decisions.blackList || [],
        potentialList: (result.decisions.potentialList || []).slice(0, 3),
        aigc: result.decisions.aigc || null,
      } : null,
      plan: result.plan ? {
        source_at: result.plan.source_at || null,
        action_limits: require('../lib/actionLimits').safeActionLimits(account, result.plan.primary_ad_id),
        primary_ad_id: result.plan.primary_ad_id,
        roi_goal: result.plan.roi_goal, budget: result.plan.budget,
        roi_goal_basis: result.plan.roi_goal_basis || 'unknown',
        platform_recommendation: result.plan.platform_recommendation || null,
        effective_delivery: result.plan.effective_delivery || null,
        flow_control: result.plan.flow_control || null,
        boost_count: result.plan.boost_count, boost_max: result.plan.boost_max,
        quota_left: result.plan.quota_left, quota_exceeded: result.plan.quota_exceeded,
      } : null,
      boost_summary: result.boost_summary || null,
      boost_tasks: (result.boost_tasks || []).map(t => ({
        ...require('../lib/mcpClean').slimBoostTask(t),
        id: t.id, name: t.name, status: t.status, roi_goal: t.roi_goal,
        roi_goal_basis: t.roi_goal_basis || 'unknown',
        roi_basis_source: t.roi_basis_source || null,
        optimization: t.optimization || null,
        budget: t.budget, cost: t.cost, net_roi: t.net_roi, order_count: t.order_count,
        metric_roi_basis: t.metric_roi_basis || { roi: 'payment', net_roi: 'platform_net_1h' },
        settlement_window: t.settlement_window || { net_roi: '1h' },
      })),
      materials_top: materials,
      context: result.context || null,
    };
  };

  const slimMode = url.searchParams.get('slim') === '1';

  try {  // 最外层 try-catch：防止 cookie_expired 逃逸导致未捕获异常

  const cacheCollector = getCollectorData(account);
  const currentSessionKey = cacheCollector?.session_key || null;
  // offline 只用于内部缓存分区，不能作为对外场次 ID；否则 Agent 会把“account|offline|”当成真实场次留痕。
  const dashboardCacheKey = `${account}|${currentSessionKey || 'offline'}`;
  const previousDashboardKey = _dashboardCacheKeyByAccount.get(account);
  if (previousDashboardKey && previousDashboardKey !== dashboardCacheKey) cache.delete(previousDashboardKey);
  _dashboardCacheKeyByAccount.set(account, dashboardCacheKey);

  // 缓存按账号+直播场次隔离；roomId 相同但 startTime 变化也不会命中旧帧。
  const cached = cache.get(dashboardCacheKey);
  if (cached && url.searchParams.get('full') !== '1') {
    const fresh = require('../lib/liveFreshness').refreshDashboardCore(cached, cacheCollector);
    if (slimMode) return sendJSON(res, { ...slimDashboard(fresh, account), from_cache: true });
    return sendJSON(res, { ...fresh, from_cache: true });
  }

  // full=1 时跳过快速路径，强制走完整千川 API 流程（后台异步刷新用）
  const forceFull = url.searchParams.get('full') === '1';

  // 快速路径：liveCollector 有内存态数据时，先用采集器数据秒返，
  // 追投/余额/计划等慢查询走后台刷新（避免 130s 卡死前端）
  if (!forceFull) {
  const collectorData0 = getCollectorData(account);
  if (collectorData0 && (collectorData0.status !== 'no_data' || collectorData0.isLive === false)) {
    const decisionContext = readDecisionContext(account);
    // 采集器有数据 → 组装快速响应（< 100ms）
    const fastResult = {
      ok: true,
      account,
      server_time: new Date().toISOString(),
      session_key: collectorData0.session_key || null,
      fetchedAt: collectorData0.fetchedAt || null,
      component_times: collectorData0.component_times || null,
      liveCheckedAt: collectorData0.liveCheckedAt || null,
      age_ms: collectorData0.age_ms ?? null,
      stale: collectorData0.stale === true,
      dataValid: collectorData0.dataValid === true,
      partial: collectorData0.partial === true,
      errors: collectorData0.errors || [],
      source_type: collectorData0.source_type || 'collector_memory',
      from_fast_path: true,
      collecting: !!collectorData0.collecting, // 新场次骨架帧（首轮采集中）：前端勿用旧数据回填冒充本场
      live: collectorData0.room ? {
        isLive: collectorData0.isLive,
        rooms: [{
          roomId: collectorData0.room.room_id || collectorData0.room.roomId || '',
          roomName: collectorData0.room.room_name || collectorData0.room.roomName || '',
          startTime: collectorData0.room.start_time || collectorData0.room.startTime || '',
          cost: collectorData0.live_metrics ? collectorData0.live_metrics.cost : null,
        }],
      } : { isLive: typeof collectorData0.isLive === 'boolean' ? collectorData0.isLive : null, rooms: [] },
      live_metrics: collectorData0.live_metrics || null,
      today: collectorData0.dataValid === true && collectorData0.live_metrics ? {
        cost: Number(collectorData0.live_metrics.cost),
        gmv: collectorData0.live_metrics.gmv != null ? Number(collectorData0.live_metrics.gmv) : null,
        roi: collectorData0.live_metrics.roi != null ? Number(collectorData0.live_metrics.roi) : null,
        netGmv: Number(collectorData0.live_metrics.gmvSettle),
        netRoi: collectorData0.live_metrics.roiSettle != null ? Number(collectorData0.live_metrics.roiSettle) : null,
        orderCount: Number(collectorData0.live_metrics.orders),
        orderCountPay: collectorData0.live_metrics.ordersPay != null ? +collectorData0.live_metrics.ordersPay : null,
        roi_basis: { roi: 'payment', netRoi: 'platform_net_1h' },
        settlement_window: '1h',
      } : null,
      balance: null,
      boost_tasks: [],
      boost_summary: { total_cost: 0, total_gmv: 0, total_roi: 0, count: 0 },
      materials_top: collectorData0.materialsTop ? collectorData0.materialsTop.map(m => ({ ...m })) : [],
      source: collectorData0.source || [], // 成交渠道构成（各渠道观看/支付）
      channels: normalizeChannels(collectorData0.channels || collectorData0.source || [], {
        sourceAt: collectorData0.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.channel_baseline,
      }),
      riskAlerts: collectorData0.riskAlerts || [],
      suggestions: [],
      decisions: collectorData0.decisions || { redList: [], blackList: [], potentialList: [] },
      plan: null,
      funnel: normalizeFunnel(collectorData0.funnel, {
        sourceAt: collectorData0.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.funnel_baseline,
      }),
      financial_basis: buildLiveFinancialBasis(),
      decision_context: decisionContext,
      account_info: (() => { const a = resolveQcAccount(account); return a ? { aavid: a.aavid || '', anchorId: a.anchorId || '' } : null; })(),
      thresholds: { break_even_roi: require('../lib/api-helpers').getAccountParams(account).break_even_roi },
    };

    // 异步刷新慢数据（追投/余额/计划），写入缓存供下一轮使用
    // 2026-08-18 提速：异步刷新节流 5min（30s 轮询每轮触发 79s 重活=队列风暴，追投永远刷不出；慢数据 5min 粒度足够）
    const _arTs = global.__dashAsyncRefreshTs || (global.__dashAsyncRefreshTs = {});
    if (_arTs[account] && Date.now() - _arTs[account] < 300000) { /* 5min 内已刷新过，跳过 */ }
    else {
      _arTs[account] = Date.now();
    // 不阻塞当前响应 — 通过自身 URL 带 ?full=1 跳过快速路径，走完整流程
    setImmediate(async () => {
      const fs2 = require('fs');
      try {
        const fullUrl = `http://127.0.0.1:${require('../lib/config').PORT || 18991}/api/live-dashboard?account=${account}&full=1`;
        const r = await fetch(fullUrl, { signal: AbortSignal.timeout(55000) });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok) console.log(`[dash-async] ${account} 完整刷新完成`);
        else console.warn(`[dash-async] ${account} 完整刷新失败: ` + JSON.stringify(j).slice(0,200));
      } catch (e) {
        console.warn(`[dash-async] ${account} 完整刷新异常: ` + e.message);
      }
    });
    }

    // 如果缓存里有过往慢数据（追投/余额/计划），合并进来
    // 注意：主缓存已过期（否则第55行就return了），但子缓存（余额5min、追投列表5min）可能还有
    // 这些子缓存在完整流程中会复用，这里也尝试复用
    try {
      const prevBal = balanceCache.get(account);
      if (prevBal) fastResult.balance = { ...prevBal };
    } catch (e) {}
    try {
      // 主缓存（30s）在快速路径必然已过期——真正管用的是慢数据子缓存（10min），
      // 保留主缓存读取仅为兼容极端竞态（full=1 刚写完）
      const prevFull = cache.get(dashboardCacheKey) || _slowCache.get(account);
      // Slow cache is account-scoped for performance, never session-scoped for facts.
      // A new room (including the same room restarted later) must not inherit prior
      // boost totals, comparisons, audit flags, or their apparent freshness.
      const sameSession = prevFull && prevFull.session_key && prevFull.session_key === fastResult.session_key;
      if (sameSession) {
        for (const key of ['boost_source_at', 'boost_data_valid', 'boost_window', 'boost_truncated', 'boost_coverage']) fastResult[key] = prevFull[key];
        if (prevFull.plan) fastResult.plan = prevFull.plan;
        if (prevFull.boost_tasks && prevFull.boost_tasks.length) fastResult.boost_tasks = prevFull.boost_tasks;
        if (prevFull.boost_summary && prevFull.boost_summary.count) fastResult.boost_summary = prevFull.boost_summary;
        if (!fastResult.balance && prevFull.balance) fastResult.balance = prevFull.balance;
        if (prevFull.chengfang) fastResult.chengfang = prevFull.chengfang;  // 乘方段随慢数据合并（2026-07-30）
        if (prevFull.uni_product) fastResult.uni_product = prevFull.uni_product;  // 全域商品计划段随慢数据合并（2026-07-30）
      } else if (prevFull && fastResult.session_key) {
        fastResult.boost_data_valid = false;
        fastResult.boost_window = { scope: 'current_session', session_key: fastResult.session_key };
        fastResult.boost_coverage = { complete: false, reason: 'slow_cache_session_mismatch' };
      }
    } catch (e) {}
    // 乘方段兜底：重启后慢缓存为空时，从 chengfang 模块 60s 缓存同步 peek 补齐（不触发网络），
    // 否则重启后直到下一次完整流程前作战室乘方卡会丢（2026-07-30 实测发现）
    if (!fastResult.chengfang) {
      try {
        const cfLib = require('../lib/chengfang');
        const peeked = cfLib.buildDashboardSection(cfLib.peekOverviewCache(account));
        if (peeked) fastResult.chengfang = peeked;
      } catch (e) {}
    }
    // 全域商品计划段兜底：同乘方 peek 逻辑（2026-07-30）
    if (!fastResult.uni_product) {
      try {
        const cfLib = require('../lib/chengfang');
        const peeked = cfLib.buildUniProductSection(cfLib.peekUniProductCache(account));
        if (peeked) fastResult.uni_product = peeked;
      } catch (e) {}
    }

    // 今日场次对接（直播复盘落盘）：collector 空态/下播时 today 用场次聚合兜底，
    // 并附 today_sessions（作战室显示"今日第 N 场/已播 N 场"）——修复"播过却显示今日未直播"
    try {
      const todayStr = getLocalDateStr();
      const sessions = await getTodaySessions(account, todayStr, req.signal, true);
      if (!fastResult.today && !collectorData0.collecting) {
        const valid = sessions.filter(s => +s.cost > 0);
        if (valid.length) {
          const cost = valid.reduce((a, s) => a + (+s.cost || 0), 0);
          const netGmv = valid.reduce((a, s) => a + (+s.netGmv || 0), 0);
          fastResult.today = {
            cost: +cost.toFixed(2), gmv: null, roi: null,
            netGmv: +netGmv.toFixed(2),
            netRoi: null, // 场次聚合没有平台当日 ROI，不用聚合金额自行复算。
            orderCount: null, orderCountPay: null,
            roi_basis: { roi: 'unknown', netRoi: 'platform_net_1h' },
            settlement_window: '1h',
          };
          fastResult.today_source = 'sessions';
        }
      } else {
        fastResult.today_source = 'live_board';
      }
      const sorted = [...sessions].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
      const liveIdx = sorted.findIndex(s => String(s.status) === '2');
      fastResult.today_sessions = {
        count: sorted.length,
        live_index: liveIdx >= 0 ? liveIdx + 1 : null,
        ended_count: sorted.filter(s => String(s.status) !== '2').length,
        list: sorted.map(s => ({ roomId: s.roomId, startTime: s.startTime, endTime: s.endTime, status: s.status, cost: s.cost, netRoi: s.netRoi })),
      };
    } catch (e) { /* 场次对接失败不影响快速返回 */ }

    const fresh = require('../lib/liveFreshness').refreshDashboardCore(fastResult, getCollectorData(account));
    return sendJSON(res, slimMode ? slimDashboard(fresh, account) : fresh);
  }
  } // end if (!forceFull)

  // 无采集器数据 → 走完整流程（千川 API）
  // 有采集器数据但走完整刷新时也复用这段

  if (!isCookieProbablyValid(readQcCookie(account))) {
    return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
  }

  const today = getLocalDateStr();
  const decisionContext = readDecisionContext(account);
  const result = {
    ok: true,
    account,
    server_time: new Date().toISOString(),
    session_key: cacheCollector?.session_key || null,
    fetchedAt: cacheCollector?.fetchedAt || null,
    liveCheckedAt: cacheCollector?.liveCheckedAt || null,
    age_ms: cacheCollector?.age_ms ?? null,
    stale: cacheCollector?.stale === true,
    dataValid: cacheCollector?.dataValid === true,
    partial: false,
    errors: [],
    source_type: cacheCollector?.source_type || 'dashboard_aggregate',
    live: null,
    live_metrics: null,
    today: null,
    balance: null,
    boost_tasks: [],
    boost_summary: { total_cost: 0, total_gmv: 0, total_roi: 0, count: 0 },
    materials_top: [],
    riskAlerts: [],
    suggestions: [],
    decisions: { redList: [], blackList: [], potentialList: [] },
    plan: null,
    funnel: null,
    channels: null,
    financial_basis: buildLiveFinancialBasis(),
    decision_context: decisionContext,
  };

  try {
    // 1. 直播状态 — 优先从 liveCollector 复用（省一次 statQuery）
    const collectorData = getCollectorData(account);
    if (collectorData && collectorData.room) {
      result.live = {
        isLive: typeof collectorData.isLive === 'boolean' ? collectorData.isLive : null,
        rooms: [{
          roomId: collectorData.room.room_id,
          roomName: collectorData.room.room_name,
          startTime: collectorData.room.start_time,
          cost: collectorData.live_metrics ? collectorData.live_metrics.cost : null,
        }],
      };
      // 同时复用直播间实时指标（大屏数据）
      if (collectorData.live_metrics) {
        result.live_metrics = { ...collectorData.live_metrics };
      }
      result.session_key = collectorData.session_key || result.session_key;
      result.fetchedAt = collectorData.fetchedAt || null;
      result.liveCheckedAt = collectorData.liveCheckedAt || null;
      result.age_ms = collectorData.age_ms ?? null;
      result.stale = collectorData.stale === true;
      result.dataValid = collectorData.dataValid === true;
      result.partial = collectorData.partial === true;
      result.errors.push(...(collectorData.errors || []));
      // 复用素材 TOP5
      if (collectorData.materialsTop) {
        result.materials_top = collectorData.materialsTop.map(m => ({ ...m }));
      }
      // 复用漏斗（曝光→观看→点击→成交）
      if (collectorData.funnel) result.funnel = normalizeFunnel(collectorData.funnel, {
        sourceAt: collectorData.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.funnel_baseline,
      });
      // 复用成交渠道构成（各渠道观看/支付，前端环形图用）
      if (collectorData.source) result.source = collectorData.source;
      result.channels = normalizeChannels(collectorData.channels || collectorData.source || [], {
        sourceAt: collectorData.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.channel_baseline,
      });
      // 账号大屏链接参数（作战室/复盘的大屏入口用）
      const acc = resolveQcAccount(account);
      if (acc) result.account_info = { aavid: acc.aavid || '', anchorId: acc.anchorId || '' };
      // 修正 heatStatus：大屏接口 material_heat_status_v2 对已暂停/已删除的追投任务仍返回"追投中"，
      // 用 boost-task-report 的真实任务状态覆盖（5分钟缓存，避免每轮都调）
      // 注意：已暂停/已删除的任务今天可能没消耗，不出现在今天的报表里，
      // 所以查近30天范围，把所有历史追投任务都拉出来建索引
      try {
        const today = getLocalDateStr();
        const cacheKey = `btr_${account}_${today}`;
        let taskMap = _btrCache.get(cacheKey);
        if (!taskMap) {
          const startDay = (() => { const d = new Date(); d.setDate(d.getDate() - 29); return getLocalDateStr(d); })();
          const btr = await fetchBoostTaskReport(startDay, today, account);
          taskMap = {};
          if (btr && btr.tasks) {
            for (const t of btr.tasks) {
              if (t.materialTitle) {
                // 同一素材可能对应多个任务：有在跑标在跑；都停了取 startTime 最新一条的状态
                // （2026-07-28 修复：原先先到先得，老“已删除”任务占坑盖过新“已暂停”，误报素材被删）
                const existing = taskMap[t.materialTitle];
                if (!existing
                  || (t.isRunning && !existing.isRunning)
                  || (!t.isRunning && !existing.isRunning && String(t.startTime || '') > String(existing.startTime || ''))) {
                  taskMap[t.materialTitle] = { statusStr: t.statusStr, isRunning: t.isRunning, startTime: t.startTime || '' };
                }
              }
            }
          }
          _btrCache.set(cacheKey, taskMap, 5 * 60 * 1000);
        }
        if (result.materials_top && Object.keys(taskMap).length) {
          for (const mt of result.materials_top) {
            const ts = taskMap[mt.name];
            if (ts) {
              // 大屏说"追投中"但实际任务已暂停/已删除 → 覆盖
              if (mt.heatStatus === '追投中' && !ts.isRunning) {
                mt.heatStatus = ts.statusStr === '已删除' ? '追投已删' : '追投暂停';
              }
              // 实际在追投但大屏没标 → 补上
              if (mt.heatStatus !== '追投中' && ts.isRunning) {
                mt.heatStatus = '追投中';
              }
            }
          }
        }
      } catch (e) {
        // 修正失败不影响主流程，用大屏原始值
        console.log(`[liveDashboard] heatStatus修正跳过: ${e.message}`);
      }
    } else {
      // 降级：liveCollector 无数据，沿用 HTTP 请求的 AbortSignal；底层会销毁上游 socket。
      const liveStatus = await fetchLiveStatus(account, { signal: req.signal });
      if (liveStatus.error) {
        const err = new Error(liveStatus.error);
        err.code = liveStatus.code;
        err.statusCode = liveStatus.statusCode;
        err.retryable = liveStatus.retryable;
        throw err;
      }
      result.live = { isLive: liveStatus.isLive, rooms: liveStatus.rooms || [] };
      result.liveCheckedAt = new Date().toISOString();
    }
    if (result.live.isLive === false) {
      result.suggestions.push({ level: 'info', msg: '当前未在直播，无需操盘' });
    }
    // 缺失值保持 null；真实 0 只在 dataValid=true 时出现。
    if (!result.materials_top) result.materials_top = [];
    if (!result.riskAlerts) result.riskAlerts = [];
  } catch (e) {
    if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;  // 必须向上抛
    result.live = { isLive: null, error: e.message };
    result.live_metrics = null;
    result.materials_top = [];
    result.riskAlerts = [];
    result.partial = true;
    result.errors.push({ component: 'live_status', code: e.code || 'live_status_error', error: e.message });
  }

  // 新场次骨架帧标记（首轮采集中）：today 不用旧场次聚合回填，下游勿把今日累计当"本场"
  try { const c0 = getCollectorData(account); result.collecting = !!(c0 && c0.collecting); } catch (e) { result.collecting = false; }

  // 2. 今日概览
  //    优先复用 liveCollector 大屏数据（已有 cost/gmv/roi），省掉浏览器采集（最慢的一步）
  //    大屏数据只覆盖直播期间的消耗，非直播消耗可能缺失 → 下播后用今日场次聚合兜底
  try {
    if (result.dataValid === true && result.live_metrics && result.live_metrics.cost != null) {
      const m = result.live_metrics;
      result.today = {
        cost: num(m.cost),
        gmv: num(m.gmv),
        roi: num(m.roi),
        netGmv: num(m.gmvSettle),
        netRoi: num(m.roiSettle),
        orderCount: num(m.orders),
        orderCountPay: m.ordersPay != null ? num(m.ordersPay) : null, // 整体成交订单数(含退款，同千川后台头条口径)
        settleRate: m.gmv > 0 ? +(num(m.gmvSettle) / num(m.gmv) * 100).toFixed(1) : 0,
        roi_basis: { roi: 'payment', netRoi: 'platform_net_1h' },
        settlement_window: '1h',
      };
      result.today_source = 'live_board'; // 标记数据来源
    } else {
      // 无大屏数据（不在直播/collector 内存态丢失）：对接直播复盘的今日场次落盘聚合，
      // 修复"今天播过但下播后显示今日未直播"（2026-07-29）。场次口径只有 cost/netGmv，无支付gmv/订单数。
      const sessions = await getTodaySessions(account, today, req.signal);
      const valid = sessions.filter(s => +s.cost > 0);
      if (valid.length && !result.collecting) { // 新场次首轮采集中不回填：今日累计会被前端当"本场"展示
        const cost = valid.reduce((a, s) => a + (+s.cost || 0), 0);
        const netGmv = valid.reduce((a, s) => a + (+s.netGmv || 0), 0);
        result.today = {
          cost: +cost.toFixed(2),
          gmv: null,
          roi: null,
          netGmv: +netGmv.toFixed(2),
          netRoi: null, // 场次聚合没有平台当日 ROI，不用聚合金额自行复算。
          orderCount: null,
          orderCountPay: null,
          roi_basis: { roi: 'unknown', netRoi: 'platform_net_1h' },
          settlement_window: '1h',
        };
        result.today_source = 'sessions'; // 场次聚合口径（推直播间，含全日多场）
      }
    }
  } catch (e) {
    result.today = { error: e.message };
    result.partial = true;
    result.errors.push({ component: 'today', code: e.code || 'today_error', error: e.message });
  }

  // 2.5 今日场次信息（作战室显示"今日第 N 场 / 已播 N 场"）：与 today 同源，直播中也要
  try {
    const sessions = await getTodaySessions(account, today, req.signal);
    const sorted = [...sessions].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    const liveIdx = sorted.findIndex(s => String(s.status) === '2');
    result.today_sessions = {
      count: sorted.length,
      live_index: liveIdx >= 0 ? liveIdx + 1 : null, // 当前是今日第几场（1 起），不在播=null
      ended_count: sorted.filter(s => String(s.status) !== '2').length,
      list: sorted.map(s => ({ roomId: s.roomId, startTime: s.startTime, endTime: s.endTime, status: s.status, cost: s.cost, netRoi: s.netRoi })),
    };
  } catch (e) { /* 场次信息缺失不影响主流程 */ }

  // 3. 抖店电商罗盘 —— 客单价暖缓存（每天拉一次 7 天均值；不拉当天，波动大且不完整）。
  //    真正的阈值组装在下方 3.5 统一走 buildThresholds，此处只为让 peekAvgOrderPriceCache 有值可读
  try {
    const { getCachedAvgOrderPrice } = require('../lib/doudian');
    await getCachedAvgOrderPrice(account).catch(() => null);
  } catch (e) {
    // 罗盘挂了不影响主流程，客单价兜底走 config
  }

  // 3.5 客单价与动态阈值：统一走 liveCollector.buildThresholds（2026-07-30 审计去重——
  // 此前此处内联实现与之双轨，price_source 硬编码 'doudian_today' 会谎报 7 天兜底来源 doudian_7d_avg）。
  // 上面的 getCachedAvgOrderPrice 调用承担暖缓存职责，buildThresholds 内经 peekAvgOrderPriceCache 同步读到。
  try {
    const th = require('../lib/liveCollector').buildThresholds(account);
    if (th) {
      result.thresholds = th;
      if (result.today) {
        result.today.break_even_roi = th.break_even_roi;
        if (th.avg_order_price) result.today.avg_order_price = th.avg_order_price;
      }
    }
  } catch (e) {
    console.warn('[liveDashboard] 阈值计算失败:', e.message);
  }

  // 4. 余额（5分钟缓存 — 余额随消耗渐进变化，但盯盘需要较新值）
  try {
    const cachedBal = balanceCache.get(account);
    if (cachedBal) {
      result.balance = { ...cachedBal }; // 克隆，避免 days_left 污染缓存对象
    } else {
      const { getAccountBalance } = require('../lib/qianchuan');
      const balResult = await getAccountBalance(account);
      const infos = balResult && balResult.data && balResult.data.balanceInfos;
      if (infos && Object.keys(infos).length) {
        const main = infos['1'];
        result.balance = { total_yuan: main ? parseInt(main.total) / 100000 : 0 };
        balanceCache.set(account, result.balance);
      } else {
        // 接口异常/无余额数据：不静默返回 0（否则 Agent 误判"余额为0"或"钱无限"），置 null 让前端区分
        result.balance = null;
        result.balance_error = balResult && balResult.message ? balResult.message : '余额拉取异常';
      }
    }
  } catch (e) {
    // 拉取失败不掩盖整体 ok，但余额置 null 并附错误信息
    result.balance = null;
    result.balance_error = e.message;
    result.partial = true;
    result.errors.push({ component: 'balance', code: e.code || 'balance_error', error: e.message });
  }

  // 4.1 余额可烧天数：total_yuan ÷ 近7日日均消耗（material_daily 完整7天，不可得则 null）
  try {
    if (result.balance && typeof result.balance.total_yuan === 'number') {
      const { aggregateByDate } = require('../lib/db');
      const rows7 = aggregateByDate(daysAgo(7), daysAgo(1), account);
      const sum7 = rows7.reduce((s, r) => s + num(r.cost), 0);
      result.balance.days_left = (rows7.length > 0 && sum7 > 0)
        ? +(result.balance.total_yuan / (sum7 / rows7.length)).toFixed(1)
        : null;
    }
  } catch (e) {
    if (result.balance) result.balance.days_left = null;
  }

  // 云图 5A 人群板块已从看板移除（T+1 数据实时性差，手动通过 /api/yuntu-distribution 拉取即可）

  // 4. 追投任务列表 + 汇总
  //    指标口径统一走 metricsService.getBoostMetricsToday（取舍逻辑收拢在该模块）：
  //      - 任务级+汇总：boost-task-report 今日报表（gmv/cost 与 ROI 同口径，与千川后台一致）
  //      - 兜底：fetchBoostSummary（口径偏窄，ROI 需另算）/ 素材明细 / adStatsMap（恒空）
  //    额度占用（quota.in_use / quota.paused_deleted_cost）也由服务返回，供下方主计划卡使用
  try {
    // 全域计划列表 — 日级缓存（计划ID一天内不变，省掉每轮一次 statQuery）
    const {
      fetchUniPromAdList,
      fetchUniPromPlanOptional,
      fetchUniPromPlanRecommendations,
      fetchEffectiveDeliveryInfo,
    } = require('../lib/qianchuanTabs');
    const todayStr = today;
    let adInfos;
    let suggestedRoi2GoalMap = {};
    let optionalAdInfos = [];
    let planOptionalRetrievedAt = null;
    let planOptionalError = null;
    const cachedEntry = _cachedAdListMap.get(account);
    // 历史账户专用说明已从试用包移除。
    // 历史账户专用说明已从试用包移除。
    const ADLIST_TTL_MS = 60 * 1000;
    if (cachedEntry && cachedEntry.date === todayStr && (Date.now() - (cachedEntry.fetchedAt || 0)) < ADLIST_TTL_MS) {
      adInfos = cachedEntry.adInfos;
      suggestedRoi2GoalMap = cachedEntry.suggestedRoi2GoalMap || {};
      optionalAdInfos = cachedEntry.optionalAdInfos || [];
      planOptionalRetrievedAt = cachedEntry.planOptionalRetrievedAt || null;
      planOptionalError = cachedEntry.planOptionalError || null;
    } else {
      const adList = await fetchUniPromAdList(today, today, account);
      adInfos = (adList && adList.data && adList.data.adInfos) || [];
      suggestedRoi2GoalMap = (adList && adList.data && adList.data.suggestedRoi2GoalMap) || {};
      const sessionId = adList && adList.data
        && (adList.data.sessionId || adList.data.SessionID || adList.data.sessionID);
      planOptionalRetrievedAt = new Date().toISOString();
      if (Object.keys(suggestedRoi2GoalMap).length > 0) {
        planOptionalError = null;
      } else {
        try {
          const recommendationResult = await fetchUniPromPlanRecommendations(today, today, account);
          suggestedRoi2GoalMap = (recommendationResult && recommendationResult.data
            && recommendationResult.data.suggestedRoi2GoalMap) || {};
        } catch (recommendationError) {
          planOptionalError = recommendationError.code || 'recommendation_unavailable';
        }
      }
      if (sessionId) {
        try {
          const optional = await fetchUniPromPlanOptional(sessionId, account);
          optionalAdInfos = (optional && optional.data && optional.data.adInfos) || [];
          if (Object.keys(suggestedRoi2GoalMap).length === 0) {
            suggestedRoi2GoalMap = (optional && optional.data && optional.data.suggestedRoi2GoalMap) || {};
          }
          if (Object.keys(suggestedRoi2GoalMap).length > 0) planOptionalError = null;
        } catch (optionalError) {
          if (!planOptionalError) planOptionalError = optionalError.code || 'optional_unavailable';
        }
      }
      // 清理旧日期条目，防止 Map 无限增长
      for (const [k, v] of _cachedAdListMap) {
        if (v.date !== todayStr) _cachedAdListMap.delete(k);
      }
      // 空列表不缓存（可能是接口空窗/异常），否则空结果会锁死一整天
      if (adInfos.length > 0) _cachedAdListMap.set(account, {
        date: todayStr,
        adInfos,
        suggestedRoi2GoalMap,
        optionalAdInfos,
        planOptionalRetrievedAt,
        planOptionalError,
        fetchedAt: Date.now(),
      });
    }

    // 从大屏素材数据提取追投素材明细（heatStatus=追投中 的素材有 assistCost）
    const boostMaterials = (result.materials_top || []).filter(m => m.heatStatus === '追投中');

    // 追投指标：任务级 + 汇总 + 额度占用（直播中才逐任务拉素材明细，省 statQuery）
    const boostMetrics = await getBoostMetricsToday(account, {
      sessionKey: result.session_key,
      adInfos,
      fetchMaterialDetail: !!(result.live && result.live.isLive),
      isLive: !!(result.live && result.live.isLive), // 2026-07-31：「关联直播间未开播」+未在播=正常等待态，metricsService 据此豁免看板
      today,
    });
    result.boost_tasks = boostMetrics.tasks;
    result.boost_source_at = boostMetrics.source_at;
    result.boost_data_valid = boostMetrics.data_valid;
    result.boost_window = boostMetrics.window;
    result.boost_truncated = boostMetrics.truncated;
    result.boost_coverage = boostMetrics.coverage;
    result.boost_summary = boostMetrics.summary;
    const quotaInUseBudget = boostMetrics.quota.in_use;
    const quotaPausedDeletedCost = boostMetrics.quota.paused_deleted_cost;

    // 把追投素材明细附到看板（Agent 可看每条追投素材的消耗/ROI）
    if (boostMaterials.length > 0) {
      result.boost_materials = boostMaterials;
    }

    // 5. 系统告警（基于追投任务的真实消耗数据）
    for (const t of result.boost_tasks) {
      const evidence = { task_id: t.id, target_id: t.id, target_type: 'boost_task',
        window: t.window || { start: today, end: today, scope: 'daily' }, source_at: t.source_at || null,
        evidence: { cost: t.cost, net_roi: t.net_roi, orders: t.order_count, budget: t.budget, status: t.status,
          financial_checks: t.financial_checks, source: 'getBoostMetricsToday' } };
      // 被动停摆（系统强停：任务预算不足/计划组超出预算/关联直播间未开播）优先告警——
      // 非手动暂停，是"想跑但跑不了"：任务预算不足→加任务预算；未开播→开播；计划组超出预算→加主计划预算或等次日重置
      if (t.passive_stop) {
        result.suggestions.push({
          level: 'warning',
          msg: `追投「${t.name}」${t.status}（系统强制停，非手动暂停）——想跑但跑不了，按因处理：加任务预算 / 开播 / 加主计划预算或等次日重置`,
          task_id: t.id,
          ...evidence, code: 'BOOST_SYSTEM_STOP', metric: 'status', value: t.status,
        });
        continue; // 停摆任务不再走 0成交/贴线 ROI 告警（跑不了，那些告警无意义）
      }
      const isPausedOrDeleted = t.status && /暂停|删除|完成/.test(String(t.status));
      const pLine = (result.thresholds || {}).avg_order_price
        || (require('../lib/config').manual_config || {}).avg_order_price
        || 79.5;
      const checkCostLimit = +(pLine * 0.6).toFixed(2);
      const breakEven = (result.thresholds || {}).break_even_roi
        || require('../lib/api-helpers').getAccountParams(account).break_even_roi;
      const shopNetRoi = (result.today || {}).netRoi || 0;
      const avgPrice = pLine;

      // 盘中复苏恢复建议：在大播在播且追投暂停时评估
      if (result.live && result.live.isLive && isPausedOrDeleted) {
        const rv = judgeResumeTask({ cost: t.cost, netRoi: t.net_roi, status: t.status }, { shopNetRoi, breakEven, avgPrice });
        if (rv.verdict === 'suggest_resume') {
          result.suggestions.push({
            level: 'info',
            msg: `复苏恢复建议：追投「${t.name}」` + rv.reason,
            task_id: t.id,
            action_type: 'resume_boost',
            ...evidence, code: 'BOOST_RESUME_CANDIDATE', metric: 'net_roi', value: t.net_roi, threshold: breakEven,
          });
        }
      }

      // 下播追投归档清算建议：在下播非直播期间评估
      if (result.live?.isLive === false) {
        const pv = judgePostLiveTask({ cost: t.cost, netRoi: t.net_roi, orderCount: t.order_count, budget: t.budget }, { breakEven, avgPrice });
        if (pv.verdict === 'suggest_delete') {
          result.suggestions.push({
            level: 'warning',
            msg: `下播死刑清算：追投「${t.name}」` + pv.reason,
            task_id: t.id,
            action_type: 'delete_boost',
            ...evidence, code: 'BOOST_POST_LIVE_CANDIDATE', metric: 'net_roi', value: t.net_roi, threshold: breakEven,
          });
        }
      }

      if (isPausedOrDeleted) continue;

      if (t.cost > 0 && t.order_count === 0) {
        // thresholds 无 explore_line（客单价不可得）时跳过该告警，否则 || 0 会把所有 0 成交追投误报 warning
        const exploreLine = (result.thresholds||{}).explore_line;
        if (exploreLine != null) {
          const level = t.cost >= exploreLine ? 'warning' : 'info';
          result.suggestions.push({
            level,
            msg: `追投"${t.name}"消耗${t.cost}元，0成交（探索线${exploreLine}元）`,
            task_id: t.id,
            ...evidence, code: 'BOOST_ZERO_ORDER', metric: 'cost', value: t.cost, threshold: exploreLine,
          });
        }
      }

      const netRoi = t.net_roi != null ? +t.net_roi : null;
      if (netRoi != null && netRoi > 0 && netRoi <= breakEven && t.cost >= checkCostLimit) {
        result.suggestions.push({
          level: 'danger',
          msg: `追投"${t.name}"消耗${t.cost}元（过探量线 ${checkCostLimit}元），净ROI仅${netRoi.toFixed(2)}（≤ 保本线 ${breakEven}），护栏建议暂停（动作收归盯盘轮）`,
          task_id: t.id,
          ...evidence, code: 'BOOST_BELOW_BREAK_EVEN', metric: 'net_roi', value: netRoi, threshold: breakEven,
        });
      } else if (t.net_roi > 0 && t.net_roi < ((result.thresholds||{}).stop_loss_roi || 1.0)) {
        result.suggestions.push({
          level: 'warning',
          msg: `追投"${t.name}"净ROI仅${t.net_roi}（低于止损线${(result.thresholds||{}).stop_loss_roi || 1.0}）`,
          task_id: t.id,
          ...evidence, code: 'BOOST_LOW_ROI', metric: 'net_roi', value: t.net_roi, threshold: (result.thresholds||{}).stop_loss_roi || 1.0,
        });
      }
      if (t.roi_goal > 10) {
        result.suggestions.push({
          level: 'info',
          msg: `追投"${t.name}"ROI目标${t.roi_goal}异常偏高（保本ROI ${(result.thresholds||{}).break_even_roi || 2.0}）`,
          task_id: t.id,
          ...evidence, code: 'BOOST_HIGH_GOAL', metric: 'roi_goal', value: t.roi_goal, threshold: 10,
        });
      }
    }

    // 素材出血闸建议并入（boostGuard 30分钟评估快照：主计划通道出血素材——当日观察 info / 持续候选 warning，
    // 历史账户专用说明已从试用包移除。
    try {
      const bleedFile = path.join(__dirname, '..', '..', 'cache', `bleeding_suggestions_${account}.json`);
      if (fs.existsSync(bleedFile)) {
        const bleed = JSON.parse(fs.readFileSync(bleedFile, 'utf8'));
        if (bleed && bleed.date === today && Array.isArray(bleed.items)) {
          for (const b of bleed.items) result.suggestions.push(b);
        }
      }
    } catch (e) { /* 快照不可读不阻塞主流程 */ }

    if (result.boost_tasks.length === 0 && result.live && result.live.isLive) {
      result.suggestions.push({ level: 'info', msg: '直播中但无追投任务' });
    }

    // 5.1 主计划卡：budget(微→元)/roi_goal 取全域计划列表（_cachedAdListMap 日级缓存，本段开头已保证 adInfos 就绪）
    //     quota_left 按官方口径估算：近14日直播日均消耗×30% − 在投控成本任务预算 − 已暂停/已删除任务当天消耗
    try {
      const todayCostForPlan = (result.today && num(result.today.cost)) || 0;
      const plans = adInfos || [];
      const totalBudgetMicro = plans.reduce((s, ad) => s + num(ad.budget), 0);
      const budget = totalBudgetMicro > 0 ? +(totalBudgetMicro / 100000).toFixed(2) : null;
      // 历史账户专用说明已从试用包移除。
      // 历史账户专用说明已从试用包移除。
      const mainAd = plans.reduce((best, ad) => (!best || num(ad.budget) > num(best.budget) ? ad : best), null);
      const roiGoal = mainAd ? num(mainAd.ecpRoi2Goal) : null;
      const roiGoalContract = attachRoiGoalContract(mainAd);
      const recommendation = buildPlatformRoiRecommendation(
        mainAd && suggestedRoi2GoalMap[String(mainAd.id)],
        todayStr,
        planOptionalRetrievedAt,
        planOptionalError,
      );
      recommendation.current_roi_goal = roiGoal;
      recommendation.meets_recommendation = recommendation.data_valid && Number.isFinite(roiGoal)
        ? roiGoal <= recommendation.net_roi_goal
        : null;
      const effectiveCacheKey = `${account}:${mainAd && mainAd.id}`;
      let effectiveDelivery = _effectiveDeliveryCache.get(effectiveCacheKey);
      if (!effectiveDelivery) {
        const effectiveRetrievedAt = new Date().toISOString();
        try {
          const accountConfig = resolveQcAccount(account);
          const response = await fetchEffectiveDeliveryInfo(
            mainAd && mainAd.id,
            accountConfig && accountConfig.anchorId,
            account,
          );
          effectiveDelivery = buildEffectiveDelivery(response, todayStr, effectiveRetrievedAt);
        } catch (effectiveError) {
          effectiveDelivery = buildEffectiveDelivery(
            null,
            todayStr,
            effectiveRetrievedAt,
            effectiveError.code || 'effective_delivery_unavailable',
          );
        }
        _effectiveDeliveryCache.set(effectiveCacheKey, effectiveDelivery);
      }
      const otherPlans = plans.filter(ad => ad !== mainAd)
        .map(ad => ({ name: String(ad.name || ''), roi_goal: num(ad.ecpRoi2Goal), budget: +(num(ad.budget) / 100000).toFixed(2) }));

      let quotaLeft = null;
      let quotaDetail = null;
      let quotaSource = null;
      // 真值优先：追投调控额度接口（2026-07-29 探针逆向，直播间/计划维度，周一平台重算数值）；
      // 失败回退 近14日直播日均×30% 估算（标注 source 供前端区分）
      try {
        const { fetchBoostQuota } = require('../lib/qianchuan');
        const q = await fetchBoostQuota(mainAd.id, account, { marGoal: num(mainAd.marGoal) || 2 });
        quotaLeft = q.left;
        quotaDetail = { daily: q.total, in_use: q.in_use, used_cost: q.deleted_cost, current_budget: q.current_budget, current_cost: q.current_cost };
        quotaSource = 'api';
      } catch (e) {
        try {
          const { aggregateByDate } = require('../lib/db');
          const rows14 = aggregateByDate(daysAgo(14), daysAgo(1), account);
          // 官方口径：近14日【直播日】日均消耗×30%（零消耗的停投日不算直播日；平台实际每周一更新，此处为实时估算）
          const activeRows = rows14.filter(r => num(r.cost) > 0);
          const sum14 = activeRows.reduce((s, r) => s + num(r.cost), 0);
          if (activeRows.length > 0 && sum14 > 0) {
            const avg14 = sum14 / activeRows.length;
            const dailyQuota = +(avg14 * 0.3).toFixed(2);
            quotaLeft = Math.max(0, +(dailyQuota - quotaInUseBudget - quotaPausedDeletedCost).toFixed(2));
            quotaDetail = { daily: dailyQuota, in_use: +quotaInUseBudget.toFixed(2), used_cost: +quotaPausedDeletedCost.toFixed(2) };
            quotaSource = 'estimate';
          }
        } catch (e2) { /* 日均不可得 → quota_left 保持 null */ }
      }

      // 追投额度用完判断：近1小时内有创建追投失败且 quota_exceeded=true 的记录（比 quota_left 估算更准）
      let quotaExceeded = false;
      try {
        const opLog = require('../lib/operationLog');
        const recentFails = opLog.query({ accountId: account, action: 'create_boost', limit: 10 });
        const now = Date.now();
        quotaExceeded = recentFails.some(l => !l.success && (now - new Date(l.ts).getTime()) < 3600000
          && l.result_msg && /额度|预算不足|daily.?budget|exceed|超限|不足/i.test(l.result_msg));
      } catch (e) { /* 查询失败不影响主流程 */ }

      result.plan = {
        source_at: planOptionalRetrievedAt,
        primary_ad_id: mainAd && mainAd.id != null ? String(mainAd.id) : null,
        budget,
        spent_pct: (budget && budget > 0) ? +(todayCostForPlan / budget * 100).toFixed(1) : null,
        roi_goal: roiGoal,
        roi_goal_basis: roiGoalContract.roi_goal_basis,
        roi_basis_source: roiGoalContract.roi_basis_source,
        platform_recommendation: recommendation,
        effective_delivery: effectiveDelivery,
        flow_control: (() => {
          const optionalPlan = optionalAdInfos.find(item => String(item.id) === String(mainAd && mainAd.id));
          return require('./flowControl').parseFlowControlState(optionalPlan || mainAd);
        })(),
        boost_count: result.boost_tasks.length,
        boost_max: 40,
        quota_left: quotaLeft,
        quota_detail: quotaDetail,
        quota_source: quotaSource, // api=接口真值 / estimate=近14日均×30%估算下限
        quota_exceeded: quotaExceeded, // 实际创建失败判断的额度用完标记
        plan_count: plans.length,
        other_plans: otherPlans.length ? otherPlans : undefined, // 多计划账号透出其余计划，避免误以为只有一个出价
      };
    } catch (e) {
      result.plan = null;
    }

  } catch (e) {
    if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;  // cookie 失效必须向上抛，不能吞成 boost_error
    result.boost_error = e.message;
    result.partial = true;
    result.errors.push({ component: 'boost_tasks', code: e.code || 'boost_error', error: e.message });
  }

  // 5.5 红黑榜建议 + enrich（hasBoost / 黑榜豁免 exempt）
  //     数据源：liveCollector 本轮采集的 decisions；任何 enrich 失败都降级为原始条目
  try {
    const collector = getCollectorData(account);
    const raw = (collector && collector.decisions) || { redList: [], blackList: [], potentialList: [] };
    const boostNames = new Set((result.materials_top || []).filter(m => m.heatStatus === '追投中').map(m => m.name));

    const P = (result.thresholds && result.thresholds.avg_order_price) || 50;

    // 黑榜豁免：上线未满3天且今日消耗 < P×2（created_at 查 material_history.db，查不到/失败 → false，不拖垮主流程）
    const checkExempt = (materialId, todayCost) => {
      try {
        const { getDB } = require('../lib/db');
        const row = getDB().prepare(`
          SELECT MIN(created_at) AS created FROM material_daily
          WHERE account_id = ? AND material_id = ? AND created_at IS NOT NULL AND created_at != ''
        `).get(account, materialId);
        const created = row && row.created ? String(row.created).slice(0, 10) : null;
        if (!created || !/^\d{4}-\d{2}-\d{2}$/.test(created)) return false;
        const ageDays = Math.floor((new Date(today + 'T00:00:00') - new Date(created + 'T00:00:00')) / 86400000);
        return ageDays < 3 && num(todayCost) < P * 2;
      } catch (e) {
        return false;
      }
    };

    const enrich = (entry, isBlack) => {
      try {
        const out = { ...entry };
        out.hasBoost = boostNames.has(entry.name);
        if (isBlack) out.exempt = checkExempt(entry.material_id, entry.todayCost);
        return out;
      } catch (e) {
        return entry; // enrich 失败返回原始数据
      }
    };

    result.decisions = {
      redList: (raw.redList || []).map(e => enrich(e, false)),
      blackList: (raw.blackList || []).map(e => enrich(e, true)),
      potentialList: (raw.potentialList || []).map(e => enrich(e, false)),
      aigc: raw.aigc || null,  // 历史账户专用说明已从试用包移除。
    };

  } catch (e) {
    result.decisions = { redList: [], blackList: [], potentialList: [] };
  }

  // 6. 加载上一轮快照做环比对比（Agent的"记忆"）
  //    按账号隔离：优先 agent-memory/<account>/context.json（与 agentMemory.js getMemoryPaths 对齐），
  //    不存在则回退旧的共享文件 agent-memory/context.json（兼容历史数据）
  try {
    const memBase = path.join(__dirname, '..', '..', 'agent-memory');
    let contextPath = path.join(memBase, account, 'context.json');
    if (!fs.existsSync(contextPath)) {
      contextPath = path.join(memBase, 'context.json');
    }
    if (fs.existsSync(contextPath)) {
      const prev = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      const changes = {};
      if (prev.today && result.today) {
        if (prev.today.cost != null) changes.cost_delta = result.today.cost - prev.today.cost;
        if (prev.today.netRoi != null && result.today.netRoi != null) changes.roi_delta = +(result.today.netRoi - prev.today.netRoi).toFixed(2);
      }
      // 追投环比
      if (prev.boost_tasks && result.boost_tasks.length > 0) {
        changes.boost_changes = [];
        for (const t of result.boost_tasks) {
          const prevTask = prev.boost_tasks.find(p => p.id === t.id);
          if (prevTask) {
            changes.boost_changes.push({
              task_id: t.id,
              name: t.name,
              cost_delta: t.cost - (prevTask.cost || 0),
              roi_delta: t.roi !== 0 || prevTask.roi !== 0 ? +(t.roi - prevTask.roi).toFixed(2) : 0,
            });
          }
        }
      }
      changes.prev_time = prev.time || null;
      result.context = changes;  // Agent用这个做趋势判断
    } else {
      result.context = { msg: '首轮运行，无历史对比数据' };
    }
  } catch (e) {
    result.context = { error: e.message };
  }

  // 乘方（全域升级版·推商品）只读透出（2026-07-30 盲区接入）：盯盘轮读 dashboard 即可见乘方计划。
  // 历史账户专用说明已从试用包移除。
  try {
    const { getOverview, buildDashboardSection } = require('../lib/chengfang');
    result.chengfang = buildDashboardSection(await getOverview(account));
  } catch (e) {
    result.chengfang = { error: e.message };
    result.partial = true;
    result.errors.push({ component: 'chengfang', code: e.code || 'chengfang_error', error: e.message });
  }

  // 历史账户专用说明已从试用包移除。
  // 历史账户专用说明已从试用包移除。
  try {
    const { getUniProductOverview, buildUniProductSection } = require('../lib/chengfang');
    result.uni_product = buildUniProductSection(await getUniProductOverview(account));
  } catch (e) {
    result.uni_product = { error: e.message };
    result.partial = true;
    result.errors.push({ component: 'uni_product', code: e.code || 'uni_product_error', error: e.message });
  }

  // 完整刷新可能等待多个慢接口；输出/缓存前必须再次拿核心内存态，不退回请求开始时的旧帧。
  Object.assign(result, require('../lib/liveFreshness').refreshDashboardCore(result, getCollectorData(account)));
  // 主缓存不接受失败帧；下一轮必须重新采集，不能把一次失败固化 30 秒。
  if (!result.partial && (result.live?.isLive === false || result.dataValid === true)) {
    cache.set(dashboardCacheKey, result);
  }
  // 慢数据按子项独立更新。失败/null 子项不覆盖此前成功值。
  const previousSlow = _slowCache.get(account) || {};
  const nextSlow = { ...previousSlow };
  if (result.plan) nextSlow.plan = result.plan;
  if (Array.isArray(result.boost_tasks) && !result.boost_error) nextSlow.boost_tasks = result.boost_tasks;
    if (!result.boost_error) for (const key of ['boost_source_at', 'boost_data_valid', 'boost_window', 'boost_truncated', 'boost_coverage']) nextSlow[key] = result[key];
  if (result.boost_summary && !result.boost_error) nextSlow.boost_summary = result.boost_summary;
  if (result.balance && !result.balance_error) nextSlow.balance = result.balance;
  if (result.chengfang && !result.chengfang.error) nextSlow.chengfang = result.chengfang;
  if (result.uni_product && !result.uni_product.error) nextSlow.uni_product = result.uni_product;
  _slowCache.set(account, nextSlow);

  // 历史账户专用说明已从试用包移除。
  if (slimMode) {
    return sendJSON(res, slimDashboard(result, account));
  }

  return sendJSON(res, { ...result, from_cache: false });

  } catch (e) {
    return handleApiError(res, e);
  }
}

// 主计划缓存主动失效：写操作（改ROI/预算/状态）成功后调用，下轮 dashboard 即拉真值
// （三级全清：日级计划列表 + 主缓存 + 慢缓存——后两者含 plan 段旧帧，fast path 会拿它兜底）
function invalidatePlanCache(accountId) {
  if (!accountId) return;
  _cachedAdListMap.delete(accountId);
  _effectiveDeliveryCache.clear();
  const dashboardKey = _dashboardCacheKeyByAccount.get(accountId);
  if (dashboardKey) cache.delete(dashboardKey);
  cache.delete(accountId); // 兼容升级前/测试注入的旧账号键，确保写操作后无旧帧残留
  _dashboardCacheKeyByAccount.delete(accountId);
  _slowCache.delete(accountId);
}

// 只读窥视：供 live-cockpit 复用最近一次已验证的主计划 ROI/预算，绝不触发网络请求。
// 无缓存返回 null，座舱动作随即降级为不可执行建议，禁止猜当前 ROI。
function peekPlanCache(accountId) {
  const dashboardKey = _dashboardCacheKeyByAccount.get(accountId);
  const full = dashboardKey ? cache.get(dashboardKey) : null;
  if (full && full.plan) return full.plan;
  const slow = _slowCache.get(accountId);
  return slow && slow.plan ? slow.plan : null;
}

module.exports = handleLiveDashboard;
module.exports.invalidatePlanCache = invalidatePlanCache;
module.exports.peekPlanCache = peekPlanCache;
module.exports._internal = { decisionContextFromProfile, buildPlatformRoiRecommendation, buildEffectiveDelivery };
