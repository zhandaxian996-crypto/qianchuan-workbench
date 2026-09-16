/**
 * server/lib/liveCollector.js — 直播采集调度器（融入 server）
 *
 * 设计原则（用户要求）:
 *   - 不再独立常驻。由 server 启动，按 SCHEDULER.statusIntervalMs 节拍运行。
 *   - 根据「直播状态/直播场次」接口决定是否采集：
 *       在播 → 拉大屏 + 组装投手记录 + 写 JSON/MD
 *       不在播 → 跳过；检测到刚下播 → 用 endTime 补采一次终值；
 *       下播后 2 小时回流窗口内每 15 分钟补采一次（千川订单回流修正会持续更新）
 *   - 复用 server/lib/liveBoard.fetchLiveBoard（字段映射已验证正确），
 *     不再维护 tools/live-collect 那套过时出错的 assembleRecord。
 *
 * 字段 key 全部来自抓包确认（见 cache/live_board_templates 与 live-board 实测）:
 *   GMV(整体含退款)     total_pay_order_gmv_realtime_for_roi2
 *   GMV(净成交扣退款)   total_order_settle_amount_realtime_for_roi2_1h
 *   消耗(基础+追投)     stat_cost_for_roi2
 *   追投消耗            stat_cost_for_roi2_assist
 *   ROI(整体)           total_prepay_and_pay_order_realtime_roi2
 *   ROI(净成交)         total_prepay_and_pay_settle_realtime_roi2_1h
 *   在线人数            room_pack_online_user_count
 *   观看人数            live_watch_ucount_for_roi2
 *   GPM                 total_live_pay_order_gpm_realtime_for_roi2
 *   订单数(净成交扣退款) total_order_settle_count_realtime_for_roi2_1h
 *   订单数(整体含退款)   total_pay_order_count_realtime_for_roi2
 *   素材名(视频)        roi2_material_video_name
 *   素材类型            roi2_material_type_mix_v3
 *   追投热度            material_heat_status_v2 (追投中/未追投)
 */
const fs = require('fs');
const path = require('path');
const { fetchLiveStatus, fetchLiveSessions, fetchBoostTaskReport, fetchLiveMaterials } = require('./qianchuanTabs');
const { fetchLiveBoard, fetchLiveCore } = require('./liveBoard');
const { MaterialChanges, materialFrame } = require('./materialChanges');
const materialChanges = new MaterialChanges();
const { componentTimes, mergeCoreRecord } = require('./liveFreshness');
const { qcError } = require('./qianchuan');
const { getLocalDateStr } = require('./utils');
const { SCHEDULER, QIANCHUAN_ACCOUNTS, CACHE_DIR } = require('./config');
const { aggregateFunnelRows, evaluateFunnel } = require('./materialFunnel');
const { loadStableFunnelContext, shiftDate } = require('./materialFunnelStore');
const { normalizeChannels, buildLiveFinancialBasis } = require('./decisionContext');
const { getDB } = require('./db');

// 最新一轮采集结果（供 /api/live-watch 读取，避免重复查文件）
// cookie_expired 时 tick 顶层会挂 cookieExpired: true（可能仅有 record:null 的占位条目），下次采集成功写入时清掉
const latestByAccount = {};  // accountId -> { record, decisions, fetchedAt, cookieExpired? }
const latestLiveStates = {}; // accountId -> { isLive, checkedAt, roomId, startTime }：独立状态探测真值
// 当前场次累计消耗采样。内存用于热路径，同时写入 SQLite，避免 Agent 晚启动或
// HTTP 服务重启后丢失15m拆分基线。只保存总消耗和追投累计，不保存决策结论。
const flowSamplesByAccount = new Map();
const boardFlights = new Map();
const coreFlights = new Map();
const latestCoreByAccount = new Map();
const intradayFlights = new Map();
const collectorRuntime = { startedAt: null, intervalMs: null, accounts: {} };
let activeCollector = null;
const BOARD_DEADLINE_MS = 55 * 1000;
const INTRADAY_DEADLINE_MS = 90 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const WATCHDOG_RECOVERY_COOLDOWN_MS = 2 * 60 * 1000;
const FLOW_SAMPLE_KEEP_MS = 6 * 60 * 60 * 1000;
const FLOW_SAMPLE_MAX = 900;

const NON_RESTARTABLE_CODES = new Set([
  'cookie_expired', 'rate_limited', 'upstream_locked', 'upstream_bad_request',
  'upstream_unavailable', 'upstream_timeout', 'queue_timeout', 'db_busy', 'SQLITE_BUSY',
]);

function isCollectorQuietHour(date = new Date()) {
  const hour = date.getHours();
  return hour >= 22 || hour < 7;
}

function getStartupTickOptions(date = new Date()) {
  return {
    ignoreQuietHours: true,
    // 夜间启动先确认直播状态：停播时不采大屏/素材；若确实在播则 tick 继续恢复场次数据。
    // 否则服务在 22:00 后重启时，liveCheckedAt 会一直为空到次日 07:00。
    statusOnly: isCollectorQuietHour(date),
  };
}

function assessCollectorWatch(watch, options = {}) {
  const quietHours = options.quietHours === true;
  if (!watch) {
    return {
      ready: false,
      code: 'collector_not_started',
      state: 'unavailable',
      retryable: true,
      restart_recommended: true,
    };
  }

  if (watch.cookieExpired === true) {
    return {
      ready: false,
      code: 'cookie_expired',
      state: 'auth_required',
      retryable: false,
      restart_recommended: false,
    };
  }

  const errorCodes = [
    watch.liveStateError,
    ...(watch.errors || []).map(error => typeof error === 'string' ? error : error && error.code),
  ].filter(Boolean);
  const nonRestartable = errorCodes.find(code => NON_RESTARTABLE_CODES.has(code));
  if (nonRestartable) {
    return {
      ready: false,
      code: nonRestartable,
      state: 'degraded',
      retryable: nonRestartable !== 'cookie_expired' && nonRestartable !== 'upstream_bad_request',
      restart_recommended: false,
    };
  }

  // 夜间已确认停播后允许状态探针静默；不能把计划内静默误判成服务故障并循环重启。
  if (quietHours && watch.isLive === false && watch.liveCheckedAt) {
    return {
      ready: true,
      code: 'offline_quiet',
      state: 'offline',
      retryable: false,
      restart_recommended: false,
    };
  }

  if (watch.status_stale === true || !watch.liveCheckedAt) {
    return {
      ready: false,
      code: 'collector_status_stale',
      state: 'stale',
      retryable: true,
      restart_recommended: true,
    };
  }

  if (watch.isLive !== true) {
    return {
      ready: true,
      code: 'offline',
      state: 'offline',
      retryable: false,
      restart_recommended: false,
    };
  }

  if (watch.collecting === true && (watch.fetchedAt == null || watch.data_stale === true)) {
    return {
      ready: false,
      code: 'collector_collecting',
      state: 'recovering',
      retryable: true,
      restart_recommended: false,
    };
  }

  if (watch.data_stale === true || !watch.fetchedAt || watch.dataValid !== true) {
    return {
      ready: false,
      code: watch.data_stale === true ? 'collector_data_stale' : 'collector_data_unavailable',
      state: 'stale',
      retryable: true,
      restart_recommended: true,
    };
  }

  return {
    ready: true,
    code: 'ready',
    state: 'live',
    retryable: false,
    restart_recommended: false,
  };
}

function makeSessionKey(accountId, room) {
  return `${accountId || '_default'}|${room?.roomId ?? ''}|${room?.startTime ?? ''}`;
}

function resetFlowSamples(accountId, sessionKey = null) {
  if (!accountId) return;
  if (sessionKey == null) flowSamplesByAccount.delete(accountId);
  else flowSamplesByAccount.set(accountId, { sessionKey, samples: [] });
}

function recordFlowSample(accountId, sessionKey, liveMetrics, sampledAt = new Date().toISOString()) {
  const metrics = liveMetrics || {};
  if (!accountId || !sessionKey || metrics.costDataValid !== true) return false;
  if (metrics.cost == null || metrics.assistCost == null) return false;
  const totalCost = Number(metrics.cost);
  const rawAssistCost = Number(metrics.assistCost);
  if (!Number.isFinite(totalCost) || totalCost < 0 || !Number.isFinite(rawAssistCost) || rawAssistCost < 0) return false;
  const ts = Date.parse(sampledAt);
  if (!Number.isFinite(ts)) return false;

  let state = flowSamplesByAccount.get(accountId);
  if (!state || state.sessionKey !== sessionKey) {
    state = { sessionKey, samples: [] };
    flowSamplesByAccount.set(accountId, state);
  }

  // totalCost 是本场累计，rawAssistCost 可能是当日累计；绝对值不能解释成同一口径，
  // 但同一场次内的差分可以严格相减。因此保存原始累计值，拆分时只计算窗口差分。
  const rawWentBack = Number.isFinite(state.lastTotalCost) && (
    totalCost < state.lastTotalCost - 0.5 || rawAssistCost < state.lastRawAssistCost - 0.5
  );
  if (rawWentBack) {
    state.samples = [];
  }
  const assistCost = rawAssistCost;
  const basicCost = totalCost - rawAssistCost;

  const last = state.samples[state.samples.length - 1];
  if (last && last.ts === ts) state.samples[state.samples.length - 1] = { ts, at: sampledAt, totalCost, basicCost, assistCost };
  else state.samples.push({ ts, at: sampledAt, totalCost, basicCost, assistCost });

  try {
    const db = getDB();
    db.prepare(`
      INSERT OR REPLACE INTO live_flow_samples
        (account_id, session_key, sample_time, total_cost, assist_cost)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, sessionKey, sampledAt, totalCost, rawAssistCost);
    db.prepare('DELETE FROM live_flow_samples WHERE sample_time < ?')
      .run(new Date(ts - FLOW_SAMPLE_KEEP_MS).toISOString());
  } catch (error) {
    console.warn(`[flow-samples] 持久化失败，继续使用内存采样: ${error.message}`);
  }

  state.lastTotalCost = totalCost;
  state.lastRawAssistCost = rawAssistCost;

  const cutoff = ts - FLOW_SAMPLE_KEEP_MS;
  state.samples = state.samples.filter(sample => sample.ts >= cutoff).slice(-FLOW_SAMPLE_MAX);
  return true;
}

function singleFlight(map, accountId, key, timeoutMs, component, task) {
  const existing = map.get(accountId);
  if (existing && existing.key === key) return existing.promise;
  if (existing && !existing.controller.signal.aborted) {
    existing.controller.abort(qcError('session_changed', '直播场次已切换，取消旧采集', {
      statusCode: 409, retryable: true, component,
    }));
  }

  const controller = new AbortController();
  const timeoutError = qcError(`${component}_timeout`, `${component} 超过 ${timeoutMs}ms`, {
    statusCode: 504, retryable: true, timeoutMs, component,
  });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  let abortListener;
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(controller.signal.reason || timeoutError);
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  const entry = { key, controller, startedAt: Date.now(), promise: null };
  const promise = Promise.race([
    Promise.resolve().then(() => task(controller.signal)),
    abortPromise,
  ]).then(result => {
    const state = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    state.components = state.components || {};
    state.components[component] = { lastSuccessAt: new Date().toISOString(), lastError: null };
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    return result;
  }).catch(err => {
    const state = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    state.components = state.components || {};
    state.components[component] = { ...state.components[component], lastErrorAt: new Date().toISOString(),
      lastError: { component, code: err.code || `${component}_error`, error: err.message } };
    state.lastErrorAt = new Date().toISOString();
    state.lastError = { component, code: err.code || `${component}_error`, error: err.message };
    throw err;
  }).finally(() => {
    clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    if (map.get(accountId) === entry) map.delete(accountId);
  });
  entry.promise = promise;
  map.set(accountId, entry);
  return promise;
}

function runBoardSingleFlight(accountId, room, task, timeoutMs = BOARD_DEADLINE_MS) {
  return singleFlight(boardFlights, accountId, makeSessionKey(accountId, room), timeoutMs, 'collector_board', task);
}

function collectCoreSession(room, accountId, accountName) {
  const key = makeSessionKey(accountId, room);
  return singleFlight(coreFlights, accountId, key, 20000, 'collector_core', async signal => {
    const account = QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
    const board = await fetchLiveCore(room.roomId, room.anchorId || account?.anchorId, room.startTime, accountId, { signal });
    const record = assembleRecord(board, room, accountName, accountId);
    if (signal.aborted) throw signal.reason;
    const live = latestLiveStates[accountId];
    if (live?.isLive !== true || makeSessionKey(accountId, live) !== key) {
      throw qcError('stale_session_result', '核心采集期间场次或直播状态已变化', { component: 'collector_core' });
    }
    if (!record.dataValid) throw qcError('core_data_invalid', '核心金额字段缺失，保留旧值及原采集时间', { component: 'collector_core' });
    latestCoreByAccount.set(accountId, { record, sessionKey: key, fetchedAt: record.component_times.core.source_at });
    return record;
  });
}

// ====== 工具：取 Metrics/Dimensions 字段值 ======
function mv(m, key) {
  const v = m && m[key];
  if (!v) return 0;
  const n = Number(v.Value);
  return isFinite(n) ? n : 0;
}
function metricValid(m, key) {
  const cell = m && m[key];
  if (!cell) return false;
  const raw = cell.Value != null ? cell.Value : cell.value;
  return raw != null && raw !== '' && Number.isFinite(Number(raw));
}
function metricValueOrNull(m, key) {
  if (!metricValid(m, key)) return null;
  const cell = m[key];
  return Number(cell.Value != null ? cell.Value : cell.value);
}
function dv(d, key) {
  const v = d && d[key];
  if (!v) return '';
  return v.ValueStr || v.Value || '';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function nowDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function nowTimeStr() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// ====== 组装投手记录（正确 key） ======
function assembleRecord(board, room, accountName, accountId) {
  const initRow = board.init && board.init.rows && board.init.rows[0];
  const initDims = (initRow && initRow.Dimensions) || {};

  // 核心指标
  const metricRow = board.metrics && board.metrics.rows && board.metrics.rows[0];
  const mm = (metricRow && metricRow.Metrics) || {};
  const cost = mv(mm, 'stat_cost_for_roi2');
  // stat_cost_for_roi2_assist 不在 commonMetricCard 数据集中（千川会报 status_code=3000），
  // 从互斥的 video/live/carousel 素材模块 Totals 汇总。旧逻辑只取 video，
  // 会漏掉直播画面/轮播追投，导致“主计划流速”被追投消耗污染。
  const materialGroups = board.materials || {};
  const assistTotals = ['video', 'live', 'carousel']
    .map(kind => materialGroups[kind] && materialGroups[kind].totals)
    .filter(totals => metricValid(totals, 'stat_cost_for_roi2_assist'));
  const assistCost = assistTotals.length
    ? assistTotals.reduce((sum, totals) => sum + mv(totals, 'stat_cost_for_roi2_assist'), 0)
    : mv(mm, 'stat_cost_for_roi2_assist');
  // live_metrics 字段口径（下游 today.orderCount 取净成交、orderCountPay 取整体）：
  //   成交：gmv=整体支付 / gmvSettle=平台1h净成交；ROI：roi=支付 / roiSettle=平台1h净成交
  //   roiSettle/gmvSettle 不等于最终结算；最终结算只能由明确支持 final_settlement 的历史数据源提供。
  //   消耗：cost=整体(基础+追投) / basicCost=基础 / assistCost=追投
  //   订单：orders=净成交(扣退款) / ordersPay=整体(含退款，同千川后台头条口径)
  const live_metrics = {
    gmv: mv(mm, 'total_pay_order_gmv_realtime_for_roi2'),                      // 整体成交GMV(含退款)
    gmvSettle: mv(mm, 'total_order_settle_amount_realtime_for_roi2_1h'),       // 净成交GMV(扣退款)
    netDataValid:
      metricValid(mm, 'total_order_settle_amount_realtime_for_roi2_1h') &&
      metricValid(mm, 'total_order_settle_count_realtime_for_roi2_1h'),
    costDataValid: metricValid(mm, 'stat_cost_for_roi2'),
    cost,                                                                       // 整体消耗(基础+追投)
    basicCost: Math.max(0, cost - assistCost),                                  // 基础消耗
    assistCost,                                                                 // 追投消耗
    roi: mv(mm, 'total_prepay_and_pay_order_realtime_roi2'),                   // 整体支付ROI
    roiSettle: mv(mm, 'total_prepay_and_pay_settle_realtime_roi2_1h'),         // 净成交ROI
    online: mv(mm, 'room_pack_online_user_count'),                             // 在线人数
    watchUcount: mv(mm, 'live_watch_ucount_for_roi2'),                         // 累计观看人数
    gpm: mv(mm, 'total_live_pay_order_gpm_realtime_for_roi2'),                 // 千次观看成交GMV
    orders: mv(mm, 'total_order_settle_count_realtime_for_roi2_1h'),          // 净成交订单数(扣退款)
    ordersPay: mv(mm, 'total_pay_order_count_realtime_for_roi2'),             // 整体成交订单数(含退款，同千川后台头条口径)
    watchToPayRate: mv(mm, 'live_watch_to_pay_rate_for_roi2'),                // 观看-支付转化率
    showToWatchRate: mv(mm, 'total_show_to_watch_rate_for_roi2'),             // 曝光-观看率
    orderCost: mv(mm, 'total_cost_per_pay_order_settle_realtime_for_roi2_1h'),// 单均净成交成本
    roiBasis: { roi: 'payment', roiSettle: 'platform_net_1h' },
    settlementWindow: '1h',
    financialBasis: buildLiveFinancialBasis(),
  };

  // 趋势
  const trendRows = (board.trend && board.trend.rows) || [];
  const trend = trendRows.map(r => ({
    time: dv(r.Dimensions, 'stat_time_5_minute'),
    gmvSettle: mv(r.Metrics, 'total_order_settle_amount_realtime_for_roi2_1h'),
    cost: mv(r.Metrics, 'stat_real_cost_for_roi2'),
    netDataValid: metricValid(r.Metrics, 'total_order_settle_amount_realtime_for_roi2_1h'),
    costDataValid: metricValid(r.Metrics, 'stat_real_cost_for_roi2'),
  }));

  // 漏斗
  const funnelRow = board.funnel && board.funnel.rows && board.funnel.rows[0];
  const fm = (funnelRow && funnelRow.Metrics) || {};
  const funnelKeys = {
    show: 'live_show_count_for_roi2',
    watch: 'live_watch_count_for_roi2',
    click: 'live_product_click_count_for_roi2',
    order: 'total_pay_order_count_for_roi2',
    showToWatchRate: 'total_show_to_watch_rate_for_roi2',
    watchToClickRate: 'total_watch_to_product_click_rate_for_roi2',
    watchToPayRate: 'total_watch_to_pay_rate_realtime_for_roi2',
    clickToPayRate: 'total_product_click_to_pay_rate_realtime_for_roi2',
  };
  const funnelFieldValidity = Object.fromEntries(
    Object.entries(funnelKeys).map(([name, key]) => [name, metricValid(fm, key)]),
  );
  const funnelValidCount = Object.values(funnelFieldValidity).filter(Boolean).length;
  const funnel = {
    show: metricValueOrNull(fm, funnelKeys.show),
    watch: metricValueOrNull(fm, funnelKeys.watch),
    click: metricValueOrNull(fm, funnelKeys.click),
    order: metricValueOrNull(fm, funnelKeys.order),
    showToWatchRate: metricValueOrNull(fm, funnelKeys.showToWatchRate),
    watchToClickRate: metricValueOrNull(fm, funnelKeys.watchToClickRate),
    watchToPayRate: metricValueOrNull(fm, funnelKeys.watchToPayRate),
    clickToPayRate: metricValueOrNull(fm, funnelKeys.clickToPayRate),
    fieldValidity: funnelFieldValidity,
    dataValid: funnelValidCount === Object.keys(funnelKeys).length,
    dataQuality: funnelValidCount === 0
      ? 'unavailable'
      : (funnelValidCount === Object.keys(funnelKeys).length ? 'complete' : 'partial'),
    missing: Object.entries(funnelFieldValidity).filter(([, valid]) => !valid).map(([name]) => name),
    source_at: board.funnel?.source_at || board.fetched_at || null,
    window: 'current_session',
  };

  // 渠道
  const channelRows = (board.channels && board.channels.rows) || [];
  const source = channelRows.map(r => {
    const channel = dv(r.Dimensions, 'combined_first_compass_entrance_code');
    const watchValid = metricValid(r.Metrics, 'total_live_watch_cnt_for_roi2');
    const payAmountValid = metricValid(r.Metrics, 'total_live_pay_amt_for_roi2');
    return {
      channel,
      watch: metricValueOrNull(r.Metrics, 'total_live_watch_cnt_for_roi2'),
      pay: metricValueOrNull(r.Metrics, 'total_live_pay_amt_for_roi2'),
      // 渠道接口允许部分字段返回：有真实 code 且至少一个指标有效就保留这一行，
      // 缺失字段由 normalizeChannels 逐字段置 null，不能把已知看播/成交金额一起清掉。
      dataValid: !!channel && (watchValid || payAmountValid),
      fieldValidity: { watch: watchValid, pay: payAmountValid },
    };
  }).sort((a, b) => (b.pay == null ? -Infinity : b.pay) - (a.pay == null ? -Infinity : a.pay));
  const channels = normalizeChannels(source, {
    sourceAt: board.channels?.source_at || board.fetched_at || null,
    window: 'current_session',
  });

  // 素材
  const matNameKeys = { video: 'roi2_material_video_name', carousel: 'roi2_material_image_agg_name', live: 'room_name' };
  // Do not use mv() here: it intentionally preserves legacy aggregate behavior
  // (missing/invalid => 0), which is unsafe for material engagement fields.
  const materialMetric = (metrics, key) => {
    const cell = metrics && metrics[key];
    const raw = cell && typeof cell === 'object' ? (cell.Value ?? cell.value ?? cell.ValueStr) : cell;
    if (raw == null || String(raw).trim() === '') return null;
    const parsed = Number(String(raw).trim().replace(/,/g, '').replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };
  function enrichMatRows(rows, nameKey) {
    return (rows || []).map(r => {
      const d = r.Dimensions || {};
      const m = r.Metrics || {};
      const c = mv(m, 'stat_cost_for_roi2');
      const ac = mv(m, 'stat_cost_for_roi2_assist');
      return {
        material_id: dv(d, 'material_id'),
        name: dv(d, nameKey) || dv(d, 'material_id'),
        type: dv(d, 'roi2_material_type_mix_v3'),
        heatStatus: dv(d, 'material_heat_status_v2'),
        status: dv(d, 'roi2_material_status'),
        uploadTime: dv(d, 'roi2_material_upload_time'),
        cost: c,
        basicCost: Math.max(0, c - ac),
        assistCost: ac,
        gmv: mv(m, 'total_pay_order_gmv_include_coupon_realtime_for_roi2'),
        gmvSettle: mv(m, 'total_order_settle_amount_realtime_for_roi2_1h'),
        roi: mv(m, 'total_prepay_and_pay_order_realtime_roi2'),
        roiSettle: mv(m, 'total_prepay_and_pay_settle_realtime_roi2_1h'),
        orders: mv(m, 'total_pay_order_count_realtime_for_roi2'),
        cvr: mv(m, 'total_pay_order_gmv_include_coupon_rate_realtime_for_roi2'),
        shows: mv(m, 'live_show_count_for_roi2_v2'),
        clicks: materialMetric(m, 'live_watch_count_for_roi2_v2'),
        cpc: materialMetric(m, 'total_cpc_for_roi2'),
        clickRate: materialMetric(m, 'live_cvr_rate_for_roi2_v2'),
        convertRate: mv(m, 'live_convert_rate_for_roi2_v2'),
      };
    });
  }
  const materials = {
    video: enrichMatRows(board.materials && board.materials.video && board.materials.video.rows, matNameKeys.video),
    live: enrichMatRows(board.materials && board.materials.live && board.materials.live.rows, matNameKeys.live),
    carousel: enrichMatRows(board.materials && board.materials.carousel && board.materials.carousel.rows, matNameKeys.carousel),
  };

  // 采集器只报告可核验的数据问题；素材盈利、样本门槛与动作由账户策略及 Agent 判断。
  // 旧的固定阈值“亏损/无脑停投”告警退出在线结果，原始指标仍完整保留。
  const riskAlerts = [];

  const now = new Date();
  const session = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${pad2(now.getHours())}时${pad2(now.getMinutes())}分`;
  const outputMetrics = { ...live_metrics };
  // 核心快读缺失指标仍是 null，不能把缺失在线/支付字段显示成真实零。
  const optionalCore = { gmv: 'total_pay_order_gmv_realtime_for_roi2', roi: 'total_prepay_and_pay_order_realtime_roi2',
    roiSettle: 'total_prepay_and_pay_settle_realtime_roi2_1h', online: 'room_pack_online_user_count',
    watchUcount: 'live_watch_ucount_for_roi2', gpm: 'total_live_pay_order_gpm_realtime_for_roi2',
    ordersPay: 'total_pay_order_count_realtime_for_roi2', watchToPayRate: 'live_watch_to_pay_rate_for_roi2',
    showToWatchRate: 'total_show_to_watch_rate_for_roi2', orderCost: 'total_cost_per_pay_order_settle_realtime_for_roi2_1h' };
  for (const [name, key] of Object.entries(optionalCore)) outputMetrics[name] = metricValueOrNull(mm, key);
  if (board.core_only) {
    outputMetrics.basicCost = null;
    outputMetrics.assistCost = null;
    outputMetrics.splitDataValid = false;
  }
  if (!outputMetrics.netDataValid) {
    outputMetrics.gmvSettle = null;
    outputMetrics.roiSettle = null;
    outputMetrics.orders = null;
    outputMetrics.orderCost = null;
  }
  if (!outputMetrics.costDataValid) {
    outputMetrics.cost = null;
    outputMetrics.basicCost = null;
    outputMetrics.assistCost = null;
    outputMetrics.roi = null;
  }
  const dataValid = outputMetrics.netDataValid === true && outputMetrics.costDataValid === true;

  return {
    session,
    session_key: makeSessionKey(accountId, room),
    account: accountName || '',
    room: {
      room_id: room.roomId,
      room_name: room.roomName || dv(initDims, 'room_name'),
      anchor_id: dv(initDims, 'room_with_anchor_id') || room.anchorId || '',
      start_time: room.startTime || dv(initDims, 'room_start_time'),
      end_time: room.endTime || dv(initDims, 'room_end_time') || null,
      status: (() => {
        // 归一化：千川 room_status 原始值是数字/字符串 2/4，统一成中文，前端确定性判断
        const s = room.status != null ? room.status : dv(initDims, 'room_status');
        if (s === 2 || s === '2') return '直播中';
        if (s === 4 || s === '4') return '已结束';
        return null; // 缺失不冒充在播或已结束，调用方必须单独核验状态。
      })(),
    },
    live_metrics: outputMetrics,
    dataValid,
    partial: board.partial === true,
    errors: board.errors || [],
    source_type: 'live_board',
    component_times: componentTimes(board),
    trend,
    funnel,
    source,
    channels,
    materials,
    material_frame: board.core_only ? null : materialFrame(board, room, makeSessionKey(accountId, room)),
    riskAlerts,
    collected_at: board.metrics?.source_at || board.fetched_at || new Date().toISOString(),
  };
}

// ====== 写 JSON + 投手简报 MD ======
function fmt(n) {
  if (n === null || n === undefined) return '--';
  const x = Number(n);
  if (!isFinite(x)) return '--';
  if (Math.abs(x) >= 10000) return (x / 10000).toFixed(2) + 'w';
  return Number.isInteger(x) ? x.toLocaleString() : x.toFixed(2);
}
function pct(n) {
  const x = Number(n);
  if (!isFinite(x)) return '--';
  return x.toFixed(2) + '%';
}

// ====== 单次采集（在播） ======
async function collectLive(room, accountId, accountName, signal) {
  // anchorId 留空，由 fetchLiveBoard 走 init 自动取（保证多账号 anchor 正确）
  const board = await fetchLiveBoard(room.roomId, undefined, room.startTime, accountId, undefined, { signal });
  if (board.partial || !board.dataValid) {
    const err = qcError('board_partial', '直播大屏子模块失败，保留上一成功帧', {
      statusCode: 502, retryable: true, component: 'collector_board',
    });
    err.errors = board.errors || [];
    throw err;
  }
  const record = assembleRecord(board, room, accountName, accountId);
  if (!record.dataValid) {
    const err = qcError('board_data_invalid', '直播大屏核心金额字段缺失，拒绝覆盖成功缓存', {
      statusCode: 502, retryable: true, component: 'collector_board',
    });
    err.errors = [{ component: 'commonMetricCard', code: 'missing_core_metrics', error: '净成交或消耗字段缺失' }];
    throw err;
  }
  return { record };
}

// ====== 采集后基于素材级数据做分层建议（只建议不下发） ======
// 财务结果决定是否需要止损，稳定内容漏斗与当前 CPC 用来确认问题发生在哪一层。
// 任何单项内容指标都不能判死刑；物理删除永远不在 collector 内执行。
function scanDecisionsFromLive(accountId) {
  const latest = latestByAccount[accountId];
  if (!latest || !latest.record) return { redList: [], blackList: [], potentialList: [], error: 'no_data' };

  const { getAccountParams } = require('./api-helpers');
  const accP = getAccountParams(accountId);
  const P = accP.avg_order_price || 79.5;
  const ROIt = accP.break_even_roi;
  const rec = latest.record;
  // V1.1-⑤ AIGC 动态创意聚合行不进决策榜（官方教义：不按普通素材处置——它是开关不是素材，治本靠清理低质输入原素材）
  const isAigcMat = m => /AIGC/i.test(String(m.name || '')) || /^(AIGC|LIVE)::/.test(String(m.material_id || '')) || String(m.material_id || '') === '-';
  // 历史账户专用说明已从试用包移除。
  const aigcRows = [
    ...rec.materials.video,
    ...rec.materials.carousel,
  ].filter(m => isAigcMat(m) && m.cost > 0);
  let aigcSummary = null;
  if (aigcRows.length) {
    const cost = aigcRows.reduce((s, m) => s + (+m.cost || 0), 0);
    const net = aigcRows.reduce((s, m) => s + (+m.gmvSettle || 0), 0);
    const orders = aigcRows.reduce((s, m) => s + (+m.orders || 0), 0);
    aigcSummary = { cost: +cost.toFixed(2), net: +net.toFixed(2), orders, netRoi: cost > 0 ? +(net / cost).toFixed(2) : null, rows: aigcRows.length };
  }
  const allMats = [
    ...rec.materials.video,
    ...rec.materials.carousel,
  ].filter(m => m.cost > 0 && !isAigcMat(m));  // 只看有消耗的；materials.live 是直播间直投画面（非素材，无 material_id，不可追投/删除），不进决策榜

  let stableFunnel = { benchmark: {}, materials: new Map() };
  try {
    const { getDB } = require('./db');
    stableFunnel = loadStableFunnelContext(getDB(), accountId, shiftDate(todayStr(), -1), 7, accP.material_funnel || {});
  } catch (e) {
    stableFunnel = { benchmark: {}, materials: new Map(), error: e.message };
  }
  const liveAcquisitionBenchmark = aggregateFunnelRows(allMats.map(m => ({
    cost: m.cost, shows: m.shows, clicks: m.clicks, cpc: m.cpc,
  })));
  const totalNetGmv = allMats.reduce((sum, m) => sum + Math.max(0, +m.gmvSettle || 0), 0);

  function buildFunnel(m) {
    const stable = stableFunnel.materials.get(String(m.material_id));
    const stableMetrics = stable && stable.metrics || {};
    const metrics = { ...stableMetrics };
    if (+m.shows > 0) metrics.shows = +m.shows;
    if (+m.clicks > 0) metrics.clicks = +m.clicks;
    if (+m.cpc > 0) metrics.cpc = +m.cpc;
    if (+m.shows > 0 && +m.clicks > 0) metrics.ctr = +m.clicks / +m.shows * 100;
    const benchmark = { ...(stableFunnel.benchmark || {}) };
    if (liveAcquisitionBenchmark.cpc != null) benchmark.cpc = liveAcquisitionBenchmark.cpc;
    if (liveAcquisitionBenchmark.ctr != null) benchmark.ctr = liveAcquisitionBenchmark.ctr;
    const evaluated = evaluateFunnel(metrics, benchmark, stable && stable.insight || {}, accP.material_funnel || {});
    evaluated.stable_window = stable && stable.stable_window || null;
    evaluated.insight_window = stable && stable.insight_window || null;
    return evaluated;
  }

  function decisionBase(m, funnel) {
    const gmvShare = totalNetGmv > 0 ? Math.max(0, +m.gmvSettle || 0) / totalNetGmv : 0;
    return {
      material_id: m.material_id,
      name: m.name,
      accountId,
      todayCost: m.cost,
      orders: m.orders,
      netGmv: Number((+m.gmvSettle || 0).toFixed(2)),
      netRoi: Number((+m.roiSettle || 0).toFixed(2)),
      cpc: funnel.metrics.cpc,
      ctr: funnel.metrics.ctr,
      gmvShare: +gmvShare.toFixed(4),
      headGmvProtected: gmvShare >= 0.10,
      funnel: {
        diagnosis: funnel.diagnosis,
        failure_hits: funnel.failure_hits,
        signals: funnel.signals,
        drop_amplifier: funnel.drop_amplifier,
        metrics: {
          rate3s: funnel.metrics.rate3s,
          finish_rate: funnel.metrics.finish_rate,
          avg_watch_time: funnel.metrics.avg_watch_time,
          cpc: funnel.metrics.cpc,
          cpc_rel: funnel.metrics.cpc_rel,
          drop_count_30d: funnel.metrics.drop_count_30d,
        },
        stable_window: funnel.stable_window,
      },
    };
  }

  const redList = [];
  const blackList = [];

  for (const m of allMats) {
    const cost = m.cost;
    const roi = m.roiSettle;
    const orders = m.orders;
    const funnel = buildFunnel(m);
    const base = decisionBase(m, funnel);
    const strongFunnelFailure = funnel.failure_hits >= 2;
    const deepFinancialLoss = cost >= P * 2 && roi >= 0 && roi < ROIt * 0.5;
    const emptySpend = cost >= P && orders === 0;
    // 红榜（追投候选）：消耗达标 + 有成交 + 净ROI 明显盈利（≥ ROIt×1.3）
    if (cost >= P * 2 && orders > 0 && roi >= ROIt * 1.3 && !strongFunnelFailure) {
      redList.push({
        ...base,
        action: '追投', reason: `消耗${cost.toFixed(0)}，净ROI ${roi.toFixed(2)}，成单${orders}`,
      });
    }
    // 需要复核：财务深水、真实空耗或至少两个漏斗维度同时失效。
    // 只有“财务 + 多维漏斗”或已过线空耗才给可逆暂停候选；否则仅复核/重剪。
    else if (deepFinancialLoss || emptySpend || strongFunnelFailure) {
      let action = '复核';
      if (emptySpend || (deepFinancialLoss && strongFunnelFailure)) action = '可逆暂停候选';
      else if (strongFunnelFailure) action = '重剪';
      const cpcText = funnel.metrics.cpc != null
        ? `，CPC ${funnel.metrics.cpc.toFixed(2)}${funnel.metrics.cpc_rel != null ? `（账户基线×${funnel.metrics.cpc_rel.toFixed(2)}）` : ''}`
        : '';
      const funnelText = funnel.failure_hits > 0 ? `，漏斗失败${funnel.failure_hits}项${funnel.drop_amplifier ? '、流失规模高' : ''}` : '，内容漏斗证据不足';
      blackList.push({
        ...base,
        action,
        reason: emptySpend
          ? `消耗${cost.toFixed(0)}无成交（空耗）${cpcText}${funnelText}`
          : `消耗${cost.toFixed(0)}，净ROI ${roi.toFixed(2)}${cpcText}${funnelText}`,
      });
    }
  }

  // 潜力榜（目的二·赚钱未起量，2026-07-27 新增）：
  //   净ROI ≥ 保本（已赚钱）+ 成交 ≥ 2 单（有验证）+ 消耗 < 300 元（未起量）；
  //   与红榜互斥（红=已起量 S 级，潜力=待培养的苗子），与黑榜天然互斥（ROI/单数条件相反）
  const redIds = new Set(redList.map(m => m.material_id));
  const potentialList = [];
  for (const m of allMats) {
    if (redIds.has(m.material_id)) continue;
    const cost = m.cost;
    const roi = m.roiSettle;
    const orders = m.orders;
    const funnel = buildFunnel(m);
    if (roi >= ROIt && orders >= 2 && cost < 300 && funnel.failure_hits < 2) {
      potentialList.push({
        ...decisionBase(m, funnel),
        action: '扶持', reason: `消耗${cost.toFixed(0)}未起量，净ROI ${roi.toFixed(2)} 已赚钱、成交${orders}单，可追投培养`,
      });
    }
  }

  // 按消耗降序，投手优先看大消耗的；潜力榜按净ROI降序（最赚钱的苗子优先扶持）
  redList.sort((a, b) => b.todayCost - a.todayCost);
  blackList.sort((a, b) => b.todayCost - a.todayCost);
  potentialList.sort((a, b) => b.netRoi - a.netRoi || b.todayCost - a.todayCost);
  return { redList, blackList, potentialList, aigc: aigcSummary, error: null };
}

// 兼容旧调用名（auto-operator.scanMaterials 仍可独立跑计划级扫描）
async function scanDecisions(accountId) {
  return scanDecisionsFromLive(accountId);
}

// 历史账户专用说明已从试用包移除。
// 人工 1h 保护期、op-log 全留痕、净成交口径（保本=break_even_roi 按账号，7-30 废支付折算线）、退款率>15% 独立告警。原静默自动暂停已废弃。
const { checkBoostStopLoss } = require('./boostGuard');

// 统一：采集 + 扫建议 + 更新 latestByAccount + 护栏巡检（建议制，不动刀）
function collectSession(room, accountId, accountName) {
  const expectedSessionKey = makeSessionKey(accountId, room);
  return runBoardSingleFlight(accountId, room, async signal => {
    const r = await collectLive(room, accountId, accountName, signal);
    if (signal.aborted) throw signal.reason;
    const live = latestLiveStates[accountId];
    if (live && live.isLive && makeSessionKey(accountId, { roomId: live.roomId, startTime: live.startTime }) !== expectedSessionKey) {
      throw qcError('stale_session_result', '旧场次采集结果已丢弃', {
        statusCode: 409, retryable: true, component: 'collector_board',
      });
    }
    if (live && live.isLive && r.record.room) r.record.room.status = '直播中';
    r.record.collecting = false;
    const sampledAt = r.record.collected_at || new Date().toISOString();
    recordFlowSample(accountId, expectedSessionKey, r.record.live_metrics, sampledAt);
    materialChanges.ingest(accountId, r.record.material_frame);
    // 只有完整、场次匹配且核心字段有效的帧能覆盖最后成功缓存。
    latestByAccount[accountId] = {
      record: r.record,
      decisions: { redList: [], blackList: [], potentialList: [], error: null },
      fetchedAt: r.record.collected_at,
      sessionKey: expectedSessionKey,
    };
    const decisions = scanDecisionsFromLive(accountId);
    r.record.decisions = decisions;
    latestByAccount[accountId].decisions = decisions;
    return r;
  });
}

async function collectAndAdvise(room, accountId, accountName) {
  const r = await collectSession(room, accountId, accountName);

// 护栏巡检：建议制（只推建议不动刀，详见 lib/boostGuard.js 头注四规矩）
  checkBoostStopLoss(accountId, accountName).catch(e => console.error(`[boostGuard] ${accountName} 巡检异常:`, e.message));
  // 历史账户专用说明已从试用包移除。
  const { checkMaterialBleeding } = require('./boostGuard');
  checkMaterialBleeding(accountId, accountName, latestByAccount[accountId] && latestByAccount[accountId].record).catch(e => console.error(`[bleedGate] ${accountName} 评估异常:`, e.message));

  // 流速枯竭监控（2026-08-02）：纯发现告警
  const { checkFlowGuard } = require('./flowGuard');
  checkFlowGuard(accountId, accountName, latestByAccount[accountId] && latestByAccount[accountId].record).catch(e => console.error(`[flowGuard] ${accountName} 巡检异常:`, e.message));
  return r;
}

// ====== 补采已结束场次（用 endTime 框定） ======
async function collectEndedSession(roomId, accountId, accountName) {
  const today = nowDateStr();
  let sess = await fetchLiveSessions(today, { status: '4', accountId });
  let s = (sess.sessions || []).find(x => x.roomId === roomId);
  if (!s) {
    // 跨天兜底：场次可能昨天开播、今天才检测到下播，查不到时补查前一天
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = y.getFullYear() + '-' + pad2(y.getMonth() + 1) + '-' + pad2(y.getDate());
    sess = await fetchLiveSessions(yesterday, { status: '4', accountId });
    s = (sess.sessions || []).find(x => x.roomId === roomId);
  }
  if (!s) {
    console.warn(`[liveCollector] ${accountName || accountId} 未找到已结束场次 ${roomId}（今昨两天均无），终值补采跳过`);
    return null;
  }
  const board = await fetchLiveBoard(roomId, undefined, s.startTime, accountId, s.endTime);
  const record = assembleRecord(board, { roomId, roomName: s.roomName, startTime: s.startTime, endTime: s.endTime, status: '4' }, accountName, accountId);
  record.session += '_终值';
  return { record };
}

/**
 * 手动触发一次采集（路由用）。
 * @param {string} accountId
 * @param {object} opts { roomId } 可选：指定房间(已结束场次补采)；不传则按在播状态采
 */
async function collectOnce(accountId, opts = {}) {
  // 铁律：拼错的账号一律报错，禁止静默回落默认账号（2026-07-25 曾因回落拿错账号数据）
  const acc = QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
  if (!acc) throw new Error(`未知账号: ${accountId}`);
  const accountName = acc.name;
  const aid = acc.id;

  if (opts.roomId) {
    const r = await collectEndedSession(opts.roomId, aid, accountName);
    if (!r) return { ok: false, error: '未找到该房间已结束场次' };
    // 先存 latestByAccount 再扫建议（scanDecisionsFromLive 读本轮素材）
    latestByAccount[aid] = { record: r.record, decisions: { redList: [], blackList: [], potentialList: [], error: null }, fetchedAt: new Date().toISOString() };
    materialChanges.ingest(aid, r.record.material_frame);
    const decisions = scanDecisionsFromLive(aid);
    r.record.decisions = decisions;
    latestByAccount[aid].decisions = decisions;
    return { ok: true, status: 'ended', session: r.record.session, record: r.record };
  }

  const status = await fetchLiveStatus(aid);
  if (status.error) return { ok: false, error: status.error };
  const checkedAt = new Date().toISOString();
  if (!status.isLive) {
    latestLiveStates[aid] = { isLive: false, checkedAt, roomId: null, startTime: null };
    return { ok: true, status: 'idle', rooms: [] };
  }
  const room = status.rooms[0];
  latestLiveStates[aid] = {
    isLive: true, checkedAt, roomId: String(room.roomId), startTime: room.startTime || null,
  };
  if (latestByAccount[aid]?.record?.session_key !== makeSessionKey(aid, room)) {
    latestByAccount[aid] = buildSessionSkeleton(room, aid);
    latestCoreByAccount.delete(aid);
    resetFlowSamples(aid, makeSessionKey(aid, room));
  }
  collectCoreSession(room, aid, accountName).catch(() => {});
  const r = await collectAndAdvise(room, aid, accountName);
  return { ok: true, status: 'live', session: r.record.session, record: r.record };
}

// ====== 调度器 ======
// 下播后回流补采：千川订单回流修正持续数小时，窗口内每 15 分钟补采一次终值
const REFLOW_WINDOW_MS = 2 * 3600 * 1000;
const REFLOW_INTERVAL_MS = 15 * 60 * 1000;

// 新场次骨架帧：新房间信息+清零指标+collecting 标记。
// 首轮采集完成前顶替旧场次记录，下游（作战室/总览/盯盘轮）立刻切到新场次冷启动态，
// 而不是继续读上一场的消耗/ROI/素材/漏斗做展示和决策。
function buildSessionSkeleton(room, accountId) {
  const sessionKey = makeSessionKey(accountId, room);
  return {
    record: {
      room: {
        room_id: room.roomId, roomId: room.roomId,
        room_name: room.roomName, roomName: room.roomName,
        start_time: room.startTime, startTime: room.startTime,
        status: '直播中',
      },
      session: null,
      session_key: sessionKey,
      collecting: true,
      dataValid: false,
      partial: false,
      errors: [],
      trend: [],
      live_metrics: {
        online: null, watchUcount: null, gpm: null,
        cost: null, basicCost: null, assistCost: null,
        gmv: null, gmvSettle: null, roi: null, roiSettle: null, orders: null,
        netDataValid: false, costDataValid: false,
        roiBasis: { roi: 'payment', roiSettle: 'platform_net_1h' },
        settlementWindow: '1h',
        financialBasis: buildLiveFinancialBasis(),
      },
      riskAlerts: [],
      decisions: { redList: [], blackList: [], potentialList: [] },
      materials: { video: [], live: [], carousel: [] },
      funnel: null,
      source: [],
      channels: null,
    },
    decisions: { redList: [], blackList: [], potentialList: [], error: null },
    fetchedAt: null,
    createdAt: new Date().toISOString(),
    sessionKey,
  };
}

function mapIntradayMaterialRow(r, accountId, statDate) {
  const d = (r && r.dimensions) || {};
  const m = (r && r.metrics) || {};
  // qianchuanTabs 的 snake→camel 转换会把 `_1h` 规范为 `1H`（大写 H）。
  // 字段必须同时存在，才能把 0 判作真实零成交。
  const netAmountRaw = m.totalOrderSettleAmountForRoi21H;
  const netOrdersRaw = m.totalOrderSettleCountForRoi21H;
  const hasNetAmount = Object.prototype.hasOwnProperty.call(m, 'totalOrderSettleAmountForRoi21H') &&
    netAmountRaw != null && netAmountRaw !== '' && Number.isFinite(Number(netAmountRaw));
  const hasNetOrders = Object.prototype.hasOwnProperty.call(m, 'totalOrderSettleCountForRoi21H') &&
    netOrdersRaw != null && netOrdersRaw !== '' && Number.isFinite(Number(netOrdersRaw));
  return {
    account_id: accountId,
    material_id: d.materialId != null ? String(d.materialId) : '',
    stat_date: statDate,
    material_name: d.roi2MaterialVideoName || '',
    status: d.roi2MaterialStatus != null ? String(d.roi2MaterialStatus) : '',
    cost: +(m.statCostForRoi2 || 0),
    net_gmv_1h: +(m.totalOrderSettleAmountForRoi21H || 0),
    net_roi_1h: m.totalPrepayAndPaySettleRoi21H != null && m.totalPrepayAndPaySettleRoi21H !== '' &&
      Number.isFinite(Number(m.totalPrepayAndPaySettleRoi21H)) ? Number(m.totalPrepayAndPaySettleRoi21H) : null,
    orders: Math.round(+(m.totalOrderSettleCountForRoi21H || 0)),
    refund_rate: +(m.totalRefundOrderGmvForRoi21HRate || 0),
    boost_cost: +(m.additionalDeliveryStatCostForRoi2Assist || 0),
    boost_settle_roi: +(m.additionalDeliveryTotalPrepayAndPaySettleRoi21HAssist || 0),
    shows: Math.round(+(m.liveShowCountForRoi2V2 || 0)),
    clicks: Math.round(+(m.liveWatchCountForRoi2V2 || 0)),
    cpc: +(m.totalCpcForRoi2 || 0),
    click_rate: +(m.liveCvrRateForRoi2V2 || 0),
    convert_rate: +(m.liveConvertRateForRoi2V2 || 0),
    net_data_valid: hasNetAmount && hasNetOrders,
  };
}

function startLiveCollector() {
  if (activeCollector) return activeCollector;
  const intervalMs = (SCHEDULER && SCHEDULER.statusIntervalMs) || 5 * 60 * 1000;
  const running = {};      // accountId -> bool
  const lastRoom = {};     // accountId -> { roomId, startTime, roomName, endedAt?, lastReflowAt? }
  const wasLive = {};      // accountId -> bool
  const liveState = latestLiveStates;
  let timer = null;
  let watchdogTimer = null;
  let watchdogRunning = false;
  const watchdogLastRecovery = {};
  collectorRuntime.startedAt = collectorRuntime.startedAt || new Date().toISOString();
  collectorRuntime.intervalMs = intervalMs;
  collectorRuntime.watchdog = {
    ...(collectorRuntime.watchdog || {}),
    state: 'active',
    interval_ms: WATCHDOG_INTERVAL_MS,
    recovery_cooldown_ms: WATCHDOG_RECOVERY_COOLDOWN_MS,
  };

  // 核心指标每 10s 独立采集；完整大屏每 30s 补趋势/漏斗/素材。
  // 两路均单飞、按账户限流，核心缓存不被慢模块或旧场次覆盖。
  const FAST_BOARD_MS = 30 * 1000;            // 在播大屏快刷频率（对齐千川页面刷新）
  const CORE_MS = 10 * 1000;
  const INTRADAY_LIVE_MS = 5 * 60 * 1000;     // 在播：素材快照 5 分钟一采
  const INTRADAY_IDLE_MS = 30 * 60 * 1000;    // 非在播（商品卡在售）：30 分钟一采
  const intradayLast = {};                    // accountId -> 上次素材落盘时间
  let fastTimer = null;
  let coreTimer = null;

  /** 盘中素材快照落盘（节流由调用方控制；失败静默不阻断主流程） */
  async function collectIntraday(accountId, signal) {
    try {
      const acc = (QIANCHUAN_ACCOUNTS || []).find(a => a.id === accountId);
      if (!acc || !acc.anchorId) return;
      const today = getLocalDateStr();
      const pageSize = 500;
      let offset = 0;
      let expectedTotal = null;
      let totalCountReliable = true;
      const byId = new Map();
      for (let page = 0; page < 20; page++) {
        const result = await fetchLiveMaterials(acc.anchorId, {
          accountId, startDate: today, endDate: today, status: 'all', pageSize, offset, signal,
        });
        const pageRows = (result && result.rows) || [];
        if (!(result && result.totalCountReliable === true)) totalCountReliable = false;
        const reported = Number(result && result.totalCount);
        if (Number.isFinite(reported)) expectedTotal = reported;
        for (const r of pageRows) {
          const id = r && r.dimensions && r.dimensions.materialId;
          if (id != null && id !== '') byId.set(String(id), r);
        }
        offset += pageRows.length;
        if (!pageRows.length || (expectedTotal != null && offset >= expectedTotal) || pageRows.length < pageSize) break;
      }
      // 不完整/总数不可验证的批次绝不落盘；否则 MAX(snapshot_time) 会把缺页误当最新全量。
      if (!totalCountReliable) {
        console.log(`[intraday] ${accountId} 上游未返回可信 totalCount，跳过落盘`);
        return;
      }
      if (expectedTotal != null && byId.size < expectedTotal) {
        console.log(`[intraday] ${accountId} 批次不完整 ${byId.size}/${expectedTotal}，跳过落盘`);
        return;
      }
      const rows = [...byId.values()];
      if (!rows.length) return;
      const { upsertSnapshots } = require('./intradayStore');
      const list = rows.map(r => mapIntradayMaterialRow(r, accountId, today)).filter(x => x.material_id);
      upsertSnapshots(list);
      console.log(`[intraday] ${accountId} 完整快照落盘 ${list.length}/${expectedTotal == null ? list.length : expectedTotal} 条`);
    } catch (e) {
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e; // cookie 失效向上抛，由 tick 顶层统一处理
      console.log(`[intraday] ${accountId} 快照采集失败(静默): ${e.message}`);
    }
  }

  /** 节流包装：在播 5 分钟 / 非在播 30 分钟 */
  async function collectIntradayIfDue(accountId, isLive) {
    const gap = isLive ? INTRADAY_LIVE_MS : INTRADAY_IDLE_MS;
    if (Date.now() - (intradayLast[accountId] || 0) < gap) return;
    intradayLast[accountId] = Date.now();
    const key = `${accountId}|intraday|${getLocalDateStr()}`;
    await singleFlight(
      intradayFlights,
      accountId,
      key,
      INTRADAY_DEADLINE_MS,
      'collector_intraday',
      signal => collectIntraday(accountId, signal),
    );
  }

  /** 在播账号 30s 大屏快刷（只刷数据不重算决策；决策/护栏仍走 5 分钟主 tick） */
  async function fastBoard(accountId, accountName) {
    const room = lastRoom[accountId];
    if (!room || !room.roomId) return;
    try {
      const r = await collectSession(room, accountId, accountName);
      const detected = liveState[accountId];
      const recordRoomId = r.record && r.record.room && r.record.room.room_id;
      const roomEnded = r.record && r.record.room && r.record.room.status === '已结束';
      const roomMismatch = detected && detected.roomId && recordRoomId &&
        String(detected.roomId) !== String(recordRoomId);
      if (roomEnded || roomMismatch) {
        console.log(`[liveCollector] ${accountName} 快刷结果与状态探针冲突，丢弃大屏状态判断`);
        return;
      }
    } catch (e) {
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;
      console.error(`[liveCollector] ${accountName} 30s快刷失败(静默): ${e.message}`);
    }
  }

  function coreTickAll() {
    if (isCollectorQuietHour()) return;
    for (const acc of QIANCHUAN_ACCOUNTS || []) {
      const ls = liveState[acc.id], room = lastRoom[acc.id];
      if (ls?.isLive !== true || !room?.startTime || makeSessionKey(acc.id, ls) !== makeSessionKey(acc.id, room)) continue;
      collectCoreSession(room, acc.id, acc.name).catch(() => {});
    }
  }

  function fastTickAll() {
    // 夜间静默（与主 tick 同规则）
    const h = new Date().getHours();
    if (h >= 22 || h < 7) return;
    for (const acc of (QIANCHUAN_ACCOUNTS || [])) {
      const ls = liveState[acc.id];
      if (!(ls && ls.isLive)) continue; // 只在播时快刷大屏
      const room = lastRoom[acc.id];
      if (!room || (ls.roomId && String(ls.roomId) !== String(room.roomId))) continue;
      fastBoard(acc.id, acc.name).catch(e => {
        if (e.message !== 'cookie_expired') console.error(`[liveCollector] ${acc.name} 快刷异常:`, e.message);
      });
      collectIntradayIfDue(acc.id, true).catch(() => {});
    }
  }

  // 补采已结束场次并刷新缓存（终值/回流共用）
  async function recollectEnded(accountId, accountName, prev, tag) {
    try {
      const r = await collectEndedSession(prev.roomId, accountId, accountName);
      if (r) {
        materialChanges.ingest(accountId, r.record.material_frame);
        latestByAccount[accountId] = {
          record: r.record,
          decisions: { redList: [], blackList: [], potentialList: [], error: null },
          fetchedAt: new Date().toISOString(),
        };
        const decisions = scanDecisionsFromLive(accountId);
        r.record.decisions = decisions;
        latestByAccount[accountId].decisions = decisions;
        const m = r.record.live_metrics;
        console.log(`[liveCollector] ${accountName} ${tag} ${prev.roomId} 净ROI=${fmt(m.roiSettle)} 消耗=${fmt(m.cost)}`);
      }
    } catch (e) {
      // cookie_expired 不能和普通错误混在一起只打日志，向上抛由 tick 顶层分支统一处理（挂 cookieExpired 标记）
      if (e.message === 'cookie_expired') throw e;
      console.error(`[liveCollector] ${accountName} ${tag}失败: ${e.message}`);
    }
  }

  async function tick(accountId, accountName, options = {}) {
    const statusOnly = options.statusOnly === true;
    if (running[accountId]) { console.log(`[liveCollector] ${accountName} 上一轮仍在采，跳过`); return; }
    running[accountId] = true;
    const runtime = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    runtime.tickStartedAt = new Date().toISOString();
    runtime.running = true;
    try {
      const status = await fetchLiveStatus(accountId);
      if (status.error) {
        // cookie_expired 不能静默吞掉，必须向上抛让调度层感知
        if (status.code === 'cookie_expired' || status.error === 'cookie_expired') {
          throw qcError('cookie_expired', 'cookie_expired', { statusCode: 401, component: 'live_status' });
        }
        const previous = liveState[accountId] || {};
        liveState[accountId] = {
          ...previous,
          error: status.code || status.error,
          probeFailedAt: new Date().toISOString(),
        };
        console.log(`[liveCollector] ${accountName} 状态查询失败: ${status.error}`);
        return;
      }
      const checkedAt = new Date().toISOString();
      runtime.lastStatusSuccessAt = checkedAt;
      if (latestByAccount[accountId] && latestByAccount[accountId].cookieExpired) {
        delete latestByAccount[accountId].cookieExpired;
      }
      if (status.isLive) {
        const room = status.rooms && status.rooms[0];
        if (!room || room.roomId == null) {
          liveState[accountId] = { isLive: false, checkedAt, roomId: null, startTime: null, error: 'live_room_missing' };
          console.log(`[liveCollector] ${accountName} 状态称在播但缺 roomId，安全降级为离线`);
          return;
        }
        liveState[accountId] = {
          isLive: true,
          checkedAt,
          roomId: String(room.roomId),
          startTime: room.startTime || null,
        };
        const prev = lastRoom[accountId];
        const isNewSession = !prev || String(prev.roomId) !== String(room.roomId) ||
          String(prev.startTime || '') !== String(room.startTime || '');
        if (isNewSession) {
          // 新场次即刻换骨架帧：record 要等首轮采集完成才替换，期间 fast path/full flow 会把
          // 历史账户专用说明已从试用包移除。
          latestByAccount[accountId] = buildSessionSkeleton(room, accountId);
          latestCoreByAccount.delete(accountId);
          resetFlowSamples(accountId, makeSessionKey(accountId, room));
        }
        // wasLive/lastRoom 置位与采集成功解耦：检测到在播即置位，
        // 否则 collectAndAdvise 持续非 cookie 报错时下播后不会触发终值补采
        lastRoom[accountId] = { roomId: room.roomId, startTime: room.startTime, roomName: room.roomName };
        wasLive[accountId] = true;
        collectCoreSession(room, accountId, accountName).catch(() => {});
        if (statusOnly) {
          // 夜间启动若发现真的在播，必须继续拉取大屏；只在停播时保持轻量探测。
          console.log(`[liveCollector] ${accountName} 夜间启动状态探测：直播中，继续恢复场次数据`);
        }
        const r = await collectAndAdvise(room, accountId, accountName);
        // isLive 只以独立状态探针为准；大屏内旧 room.status 不得覆盖真值。
        const m = r.record.live_metrics;
        const d = r.record.decisions;
        console.log(`[liveCollector] ${accountName} 📡 直播中${isNewSession ? '(新场次)' : ''} ${room.roomName.slice(0, 16)} 净ROI=${fmt(m.roiSettle)} 消耗=${fmt(m.cost)} 建议:红榜${d.redList.length}/黑榜${d.blackList.length}`);
      } else {
        // 已成功确认停播后，旧场 board/upstream 错误不再代表当前数据健康状态。
        runtime.lastError = null;
        liveState[accountId] = { isLive: false, checkedAt, roomId: null, startTime: null };
        if (statusOnly) {
          console.log(`[liveCollector] ${accountName} 夜间启动状态探测：未在直播`);
          return;
        }
        // 不在播：商品卡在售时也采盘中素材（30 分钟节流，供商品卡当天评估）
        collectIntradayIfDue(accountId, false).catch(() => {});
        // 不在播
        if (wasLive[accountId] && lastRoom[accountId]) {
          const prev = lastRoom[accountId];
          console.log(`[liveCollector] ${accountName} 检测到下播，补采终值 ${prev.roomId}`);
          await recollectEnded(accountId, accountName, prev, '终值已采');
          wasLive[accountId] = false;
          // 不置 null：千川订单回流修正持续数小时，保留场次用于回流补采
          prev.endedAt = Date.now();
          prev.lastReflowAt = Date.now();
        } else if (lastRoom[accountId] && lastRoom[accountId].endedAt) {
          const prev = lastRoom[accountId];
          if (Date.now() - prev.endedAt >= REFLOW_WINDOW_MS) {
            lastRoom[accountId] = null;
            console.log(`[liveCollector] ${accountName} 未在播，跳过 (${nowTimeStr()})`);
          } else if (Date.now() - (prev.lastReflowAt || 0) >= REFLOW_INTERVAL_MS) {
            prev.lastReflowAt = Date.now();
            await recollectEnded(accountId, accountName, prev, '回流补采');
          } else {
            console.log(`[liveCollector] ${accountName} 未在播，跳过 (${nowTimeStr()})`);
          }
        } else {
          console.log(`[liveCollector] ${accountName} 未在播，跳过 (${nowTimeStr()})`);
        }
      }
    } catch (e) {
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') {
        console.error(`[liveCollector] ${accountName} Cookie 已失效，暂停采集（需刷新 cookie 后自动恢复）`);
        // 挂 cookieExpired 标记供 /api/live-watch 透出（投手可感知）；下一轮采集成功写入时会自然清掉
        if (!latestByAccount[accountId]) {
          latestByAccount[accountId] = { record: null, decisions: { redList: [], blackList: [], potentialList: [], error: 'cookie_expired' }, fetchedAt: null };
        }
        latestByAccount[accountId].cookieExpired = true;
        // 不清除 wasLive/lastRoom 状态，cookie 恢复后可以继续补采终值
        // 但标记 running=false 防止无限重试
      } else {
        console.error(`[liveCollector] ${accountName} tick 异常: ${e.message}`);
      }
    } finally {
      running[accountId] = false;
      runtime.running = false;
      runtime.tickFinishedAt = new Date().toISOString();
    }
  }

  function tickAll(options = {}) {
    // 历史账户专用说明已从试用包移除。
    if (isCollectorQuietHour() && options.ignoreQuietHours !== true) {
      // 静默期仍保留 wasLive/lastRoom 状态，次日 07:00 后恢复检测，如检测到下播会触发终值补采
      return;
    }
    const list = QIANCHUAN_ACCOUNTS && QIANCHUAN_ACCOUNTS.length ? QIANCHUAN_ACCOUNTS : [];
    for (const acc of list) {
      tick(acc.id, acc.name, { statusOnly: options.statusOnly === true })
        .catch(e => console.error(`[liveCollector] tick ${acc.id} 异常:`, e.message));
    }
    if (options.statusOnly !== true) maybeCollectCompass(list);
  }

  function currentWatch(accountId) {
    return getLatestWatch().find(item => item.accountId === accountId) || null;
  }

  async function recoverAccount(accountId, options = {}) {
    const acc = (QIANCHUAN_ACCOUNTS || []).find(item => item.id === accountId);
    if (!acc) {
      return {
        ok: false,
        ready: false,
        code: 'invalid_account',
        component: 'collector',
        retryable: false,
        restart_recommended: false,
      };
    }

    const before = currentWatch(accountId);
    const beforeHealth = assessCollectorWatch(before, { quietHours: isCollectorQuietHour() });
    if (beforeHealth.ready && options.force !== true) {
      return { ok: true, ready: true, action: 'none', account_id: accountId, health: beforeHealth, watch: before };
    }

    const runtime = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    runtime.lastRecoveryAttemptAt = new Date().toISOString();
    runtime.recoveryAttempts = (runtime.recoveryAttempts || 0) + 1;

    // 卡住的 board Promise 自身有 55 秒上限。显式恢复时主动取消旧 flight，
    // 让 tick 的 finally 释放 running，而不是把 Agent 的恢复请求再挂一轮。
    const flight = boardFlights.get(accountId);
    if (flight && !flight.controller.signal.aborted) {
      flight.controller.abort(qcError('collector_recovery_abort', '自愈取消陈旧采集', {
        statusCode: 409, retryable: true, component: 'collector_board',
      }));
      await Promise.race([
        flight.promise.catch(() => null),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }

    const waitUntil = Date.now() + 2000;
    while (running[accountId] && Date.now() < waitUntil) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (running[accountId]) {
      const health = assessCollectorWatch(currentWatch(accountId), { quietHours: isCollectorQuietHour() });
      return {
        ok: false,
        ready: false,
        action: 'collector_busy',
        account_id: accountId,
        health: { ...health, code: 'collector_busy', restart_recommended: false },
      };
    }

    await tick(accountId, acc.name, { statusOnly: false });
    const watch = currentWatch(accountId);
    const health = assessCollectorWatch(watch, { quietHours: isCollectorQuietHour() });
    if (health.ready) {
      runtime.lastRecoverySuccessAt = new Date().toISOString();
      runtime.recoverySuccesses = (runtime.recoverySuccesses || 0) + 1;
    } else {
      runtime.lastRecoveryFailureAt = new Date().toISOString();
      runtime.recoveryFailures = (runtime.recoveryFailures || 0) + 1;
    }
    return {
      ok: health.ready,
      ready: health.ready,
      action: 'collector_recollect',
      account_id: accountId,
      health,
      watch,
    };
  }

  async function watchdogOnce() {
    if (watchdogRunning) return;
    watchdogRunning = true;
    collectorRuntime.watchdog = collectorRuntime.watchdog || {};
    collectorRuntime.watchdog.last_check_at = new Date().toISOString();
    try {
      const quietHours = isCollectorQuietHour();
      for (const acc of (QIANCHUAN_ACCOUNTS || [])) {
        const watch = currentWatch(acc.id);
        const health = assessCollectorWatch(watch, { quietHours });
        if (health.ready || health.restart_recommended !== true) continue;
        if (Date.now() - (watchdogLastRecovery[acc.id] || 0) < WATCHDOG_RECOVERY_COOLDOWN_MS) continue;
        watchdogLastRecovery[acc.id] = Date.now();
        const result = await recoverAccount(acc.id);
        collectorRuntime.watchdog.last_action_at = new Date().toISOString();
        collectorRuntime.watchdog.last_account_id = acc.id;
        collectorRuntime.watchdog.last_result = result.health || null;
      }
    } catch (error) {
      collectorRuntime.watchdog.last_error_at = new Date().toISOString();
      collectorRuntime.watchdog.last_error = error.message;
      console.error(`[liveCollector] watchdog 自愈失败: ${error.message}`);
    } finally {
      watchdogRunning = false;
    }
  }

  // ═══ 罗盘客群快照每日自愈采集（2026-07-29 补：罗盘此前只有手动刷新通道，快照会长期停滞）═══
  // 规则：每天 07:00 起检查 cache/compass/<account>_crowd_<今日>.json，缺失即补采（30d）；
  //   每次 tick 最多采 1 个账号（WebBridge 回退通道并发会互踩，串行最稳；纯 API 通道秒级）；
  //   失败 30 分钟后重试，PM2 重启/电脑断电后开机自动补上。
  const compassLastTry = {};
  // 罗盘 cookie 失效通知去重：避免 30 分钟重试每次失败都轰炸一次，同账号 12h 内只通知一次
  const compassNotified = {};
  function maybeCollectCompass(list) {
    try {
      const now = new Date();
      if (now.getHours() < 7) return;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const COMPASS_DIR = path.join(__dirname, '..', '..', 'cache', 'compass');
      const COLLECTOR = path.join(__dirname, '..', '..', 'tools', 'compass_collector.js');
      const NOTIFY_FILE = path.join(__dirname, '..', '..', 'cache', 'wechat_notifications.json');
      const emitWechatNotify = (event) => {
        try {
          let list = [];
          try { list = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8')); } catch { /* 无/坏文件按空 */ }
          list.push({ ...event, notified_at: new Date().toISOString() });
          if (list.length > 100) list = list.slice(-100);
          fs.writeFileSync(NOTIFY_FILE, JSON.stringify(list, null, 2), 'utf8');
        } catch (_) { /* 通知写失败不影响主流程 */ }
      };
      for (const acc of list) {
        const snap = path.join(COMPASS_DIR, `${acc.id}_crowd_${today}.json`);
        if (fs.existsSync(snap)) continue;
        if (Date.now() - (compassLastTry[acc.id] || 0) < 30 * 60 * 1000) continue;
        compassLastTry[acc.id] = Date.now();
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [COLLECTOR, '--account', acc.id, '--range', '30d'], {
          detached: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..', '..'), windowsHide: true,
        });
        let out = '';
        child.stdout && child.stdout.on('data', d => { out += d; });
        child.stderr && child.stderr.on('data', d => { out += d; });
        child.on('error', () => { /* spawn 失败，等下一拍 */ });
        child.on('close', (code) => {
          const needUpdate = /COOKIE_UPDATE_NEEDED/.test(out);
          console.log(`[liveCollector] ${acc.name} 罗盘自愈采集结束 code=${code}${needUpdate ? '（cookie 需更新）' : ''}`);
          if (needUpdate) {
            const within = Date.now() - (compassNotified[acc.id] || 0) < 12 * 3600 * 1000;
            if (!within) {
              compassNotified[acc.id] = Date.now();
              emitWechatNotify({
                type: 'compass_cookie_update', account: acc.id, account_name: acc.name,
                title: `【${acc.name}】罗盘数据读不到，需更新 cookie`,
                body: `罗盘采集纯 API 已失效（cookie 过期或需更新）。请登录 compass.jinritemai.com 后，把含 ucas_c0_compass 的完整 cookie 给弈更新。`, // eslint-disable-line
                source: 'liveCollector',
              });
              console.log(`[liveCollector] ${acc.name} 已发出罗盘 cookie 更新通知`);
            } else {
              console.log(`[liveCollector] ${acc.name} cookie 失效通知 12h 内已发，跳过`);
            }
          }
        });
        console.log(`[liveCollector] ${acc.name} 罗盘今日快照缺失，已触发自愈采集（${today}）`);
        break; // 每拍最多一个，串行
      }
    } catch (e) {
      console.error(`[liveCollector] 罗盘自愈采集触发失败: ${e.message}`);
    }
  }

  // 启动后立即跑一次，再按间隔跑。夜间也必须做一次轻量状态探测，
  // 避免服务重启后直到次日 07:00 都无法区分“未在直播”和“状态未知”。
  tickAll(getStartupTickOptions());
  timer = setInterval(tickAll, intervalMs);
  timer.unref();
  // 历史账户专用说明已从试用包移除。
  fastTimer = setInterval(fastTickAll, FAST_BOARD_MS);
  fastTimer.unref();
  coreTimer = setInterval(coreTickAll, CORE_MS);
  coreTimer.unref();
  watchdogTimer = setInterval(() => watchdogOnce().catch(() => {}), WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
  console.log(`[liveCollector] 已启动，每 ${intervalMs / 1000}s 检测一次直播状态（账号: ${(QIANCHUAN_ACCOUNTS || []).map(a => a.name).join('/')}）；核心 10s / 完整大屏 30s 独立采集`);

  // 盯盘轮直播门禁复用：返回账号在播状态表 { accountId: { isLive, checkedAt } }
  function getLiveStates() { return latestLiveStates; }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
    if (coreTimer) { clearInterval(coreTimer); coreTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    collectorRuntime.watchdog = { ...(collectorRuntime.watchdog || {}), state: 'stopped' };
    for (const entry of boardFlights.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(qcError('collector_stopped', 'collector 已停止', { component: 'collector_board' }));
    }
    for (const entry of intradayFlights.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(qcError('collector_stopped', 'collector 已停止', { component: 'collector_intraday' }));
    }
    for (const entry of coreFlights.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(qcError('collector_stopped', 'collector 已停止', { component: 'collector_core' }));
    }
    activeCollector = null;
  }
  activeCollector = { stop, tickAll, collectOnce, getLiveStates, recoverAccount, watchdogOnce };
  return activeCollector;
}

// ====== /api/live-watch 用：返回所有账号最新一轮采集+建议总览 ======

// 动态阈值（与 liveDashboard 同口径）：config 手动值 > 抖店客单价内存缓存 > null（前端兜底）
function buildThresholds(accountId) {
  try {
    const { getAccountParams } = require('./api-helpers');
    const accP = getAccountParams(accountId);
    const manualPrice = accP.avg_order_price;
    const manualRoi = accP.break_even_roi;
    let avgOrderPrice = null;
    let priceSource = null;
    if (manualPrice && manualPrice > 0) {
      avgOrderPrice = manualPrice;
      priceSource = 'config_manual';
    } else {
      const { peekAvgOrderPriceCache } = require('./doudian');
      const peek = peekAvgOrderPriceCache(accountId);
      if (peek && peek.value > 0) {
        avgOrderPrice = peek.value;
        priceSource = peek.source;
      }
    }
    const t = {
      avg_order_price: avgOrderPrice ? +avgOrderPrice.toFixed(2) : null,
      price_source: priceSource,
      break_even_roi: manualRoi,
      stop_loss_roi: +(manualRoi * 0.5).toFixed(2),
      s_level_roi: +(manualRoi * 1.3).toFixed(2),
      a_level_roi: +(manualRoi * 0.9).toFixed(2),
    };
    if (avgOrderPrice && avgOrderPrice > 0) {
      t.explore_line = +(avgOrderPrice * 1.5).toFixed(2);
      t.s_level_cost = +(avgOrderPrice * 2).toFixed(2);
      t.hook_fail_line = +(avgOrderPrice * 0.5).toFixed(2);
    }
    // 历史账户专用说明已从试用包移除。
    // 历史账户专用说明已从试用包移除。
    try {
      t.flow_baseline = require('./flowBaseline').getFlowBaseline(accountId);
    } catch { t.flow_baseline = null; }
    return t;
  } catch (e) {
    return null;
  }
}

// 今日盘中素材数据，供素材分析读取。
function todayMaterialMap(accountId) {
  const latest = latestByAccount[accountId];
  const rec = latest && latest.record;
  const mats = rec && rec.materials ? [...(rec.materials.video || []), ...(rec.materials.carousel || [])] : [];
  const map = {};
  for (const m of mats) {
    if (!m.material_id) continue;
    const cur = map[m.material_id] || { cost: 0, gmv: 0, net: 0, orders: 0 };
    cur.cost += +m.cost || 0;
    cur.gmv += +m.gmv || 0;       // 支付口径（不扣退款，仅展示参考）
    cur.net += +m.gmvSettle || 0; // 净口径（去退款）
    cur.orders += +m.orders || 0;
    map[m.material_id] = cur;
  }
  return map;
}

function getLatestWatch() {
  const accounts = QIANCHUAN_ACCOUNTS && QIANCHUAN_ACCOUNTS.length ? QIANCHUAN_ACCOUNTS : [];
  const todayStr = getLocalDateStr();
  const now = Date.now();
  const statusIntervalMs = (SCHEDULER && SCHEDULER.statusIntervalMs) || 5 * 60 * 1000;
  const statusStaleAfterMs = statusIntervalMs * 2 + 30 * 1000;
  return accounts.map(acc => {
    let latest = latestByAccount[acc.id];
    const ls = latestLiveStates[acc.id] || null;
    latest = mergeCoreRecord(latest, latestCoreByAccount.get(acc.id), ls);
    if (latest?.record?.component_times?.core?.source_at) latest = { ...latest, fetchedAt: latest.record.component_times.core.source_at };
    const runtime = collectorRuntime.accounts[acc.id] || {};
    const liveCheckedAgeMs = ls && ls.checkedAt ? Math.max(0, now - Date.parse(ls.checkedAt)) : null;
    const fetchedAgeMs = latest && latest.fetchedAt ? Math.max(0, now - Date.parse(latest.fetchedAt)) : null;
    const statusStale = liveCheckedAgeMs == null || liveCheckedAgeMs > statusStaleAfterMs;
    const dataStale = !!(ls && ls.isLive) && (fetchedAgeMs == null || fetchedAgeMs > 30 * 1000);
    const flight = boardFlights.get(acc.id);
    const runtimeErrors = [];
    if (runtime.lastError && (!latest?.fetchedAt || !runtime.lastErrorAt || Date.parse(runtime.lastErrorAt) >= Date.parse(latest.fetchedAt))) {
      runtimeErrors.push(runtime.lastError);
    }
    // 跨午夜保护（2026-07-29 审计修复）：非在播且记录属于昨天及以前 → 视为无今日数据，
    // 历史账户专用说明已从试用包移除。
    if (latest && latest.record && !(ls && ls.isLive)) {
      const recDate = String((latest.record.room && (latest.record.room.start_time || latest.record.room.startTime)) || '').slice(0, 10)
        || (latest.fetchedAt ? getLocalDateStr(new Date(latest.fetchedAt)) : '');
      if (recDate && recDate < todayStr) latest = null;
    }
    const thresholds = buildThresholds(acc.id);
    // cookie 失效标记（tick 顶层 cookie_expired 分支挂上，下次采集成功写入时清掉）
    const cookieExpired = !!(latest && latest.cookieExpired);
    // 无数据时也返回完整字段（零值+空数组），前端用 acc.live_metrics / acc.riskAlerts 等
    // 不会触发 undefined 错误，页面优雅降级
    // （cookie 失效占位条目 record 为 null，同样走此分支）
    if (!latest || !latest.record) {
      return {
        accountId: acc.id,
        accountName: acc.name,
        status: 'no_data',
        fetchedAt: null,
        session_key: ls ? makeSessionKey(acc.id, { roomId: ls.roomId, startTime: ls.startTime }) : null,
        isLive: typeof ls?.isLive === 'boolean' ? ls.isLive : null,
        liveCheckedAt: (ls && ls.checkedAt) || null,
        age_ms: null,
        live_checked_age_ms: liveCheckedAgeMs,
        stale: statusStale || dataStale,
        status_stale: statusStale,
        data_stale: dataStale,
        dataValid: false,
        partial: runtimeErrors.length > 0,
        errors: runtimeErrors,
        source_type: 'collector_memory',
        source: [],
        detectedRoomId: (ls && ls.roomId) || null,
        detectedRoomStartTime: (ls && ls.startTime) || null,
        liveStateError: (ls && ls.error) || null,
        collecting: !!flight,
        room: null,
        live_metrics: {
          online: null, watchUcount: null, gpm: null, cost: null, gmv: null,
          gmvSettle: null, roi: null, roiSettle: null, orders: null,
          netDataValid: false, costDataValid: false,
          roiBasis: { roi: 'payment', roiSettle: 'platform_net_1h' },
          settlementWindow: '1h',
          financialBasis: buildLiveFinancialBasis(),
        },
        riskAlerts: [],
        decisions: { redList: [], blackList: [], potentialList: [] },
        materialsTop: [],
        funnel: null,
        channels: null,
        thresholds,
        cookieExpired,
      };
    }
    const metrics = { ...(latest.record.live_metrics || {}) };
    if (metrics.netDataValid !== true) {
      metrics.gmvSettle = null;
      metrics.roiSettle = null;
      metrics.orders = null;
      metrics.orderCost = null;
    }
    if (metrics.costDataValid !== true) {
      metrics.cost = null;
      metrics.basicCost = null;
      metrics.assistCost = null;
      metrics.roi = null;
    }
    const dataValid = latest.record.dataValid === true ||
      (metrics.netDataValid === true && metrics.costDataValid === true);
    const errors = [...(latest.record.errors || []), ...runtimeErrors];
    return {
      accountId: acc.id,
      accountName: acc.name,
      status: 'live_or_ended',
      fetchedAt: latest.fetchedAt,
      session_key: latest.sessionKey || latest.record.session_key || makeSessionKey(acc.id, {
        roomId: latest.record.room?.room_id,
        startTime: latest.record.room?.start_time,
      }),
      isLive: typeof ls?.isLive === 'boolean' ? ls.isLive : null,
      liveCheckedAt: (ls && ls.checkedAt) || null,
      age_ms: fetchedAgeMs,
      live_checked_age_ms: liveCheckedAgeMs,
      stale: statusStale || dataStale,
      status_stale: statusStale,
      data_stale: dataStale,
      dataValid,
      partial: latest.record.partial === true || errors.length > 0,
      errors,
      source_type: latest.record.source_type || 'collector_memory',
      detectedRoomId: (ls && ls.roomId) || null,
      detectedRoomStartTime: (ls && ls.startTime) || null,
      liveStateError: (ls && ls.error) || null,
      collecting: !dataValid && (!!latest.record.collecting || !!flight || coreFlights.has(acc.id)),
      room: latest.record.room,
      live_metrics: metrics,
      component_times: latest.record.component_times || null,
      riskAlerts: latest.record.riskAlerts || [],
      decisions: latest.decisions,
      funnel: latest.record.funnel || null,
      source: latest.record.source || [], // 成交渠道构成（各渠道观看/支付，作战室环形图用）
      channels: latest.record.channels || normalizeChannels(latest.record.source || [], {
        sourceAt: latest.fetchedAt,
        window: 'current_session',
      }),
      materialsTop: (latest.record.materials.video || []).slice(0, 5).map(m => ({
        material_id: m.material_id,
        name: m.name, cost: m.cost, roiSettle: m.roiSettle, orders: m.orders, heatStatus: m.heatStatus,
        shows: m.shows, clicks: m.clicks, cpc: m.cpc, clickRate: m.clickRate,
      })),
      thresholds,
      cookieExpired,
    };
  });
}

function getCollectorStatus() {
  const now = Date.now();
  const flights = {};
  for (const [accountId, entry] of boardFlights.entries()) {
    flights[accountId] = { session_key: entry.key, age_ms: now - entry.startedAt };
  }
  const intraday = {};
  const core = {};
  for (const [accountId, entry] of coreFlights.entries()) {
    core[accountId] = { session_key: entry.key, age_ms: now - entry.startedAt };
  }
  for (const [accountId, entry] of intradayFlights.entries()) {
    intraday[accountId] = { key: entry.key, age_ms: now - entry.startedAt };
  }
  return {
    started_at: collectorRuntime.startedAt,
    interval_ms: collectorRuntime.intervalMs,
    accounts: collectorRuntime.accounts,
    board_in_flight: flights,
    core_in_flight: core,
    core_interval_ms: 10000,
    intraday_in_flight: intraday,
    watchdog: collectorRuntime.watchdog || {
      interval_ms: WATCHDOG_INTERVAL_MS,
      recovery_cooldown_ms: WATCHDOG_RECOVERY_COOLDOWN_MS,
      state: activeCollector ? 'active' : 'not_started',
    },
  };
}

function getCollectorHealth(accountId) {
  const watch = getLatestWatch().find(item => item.accountId === accountId) || null;
  const health = assessCollectorWatch(watch, { quietHours: isCollectorQuietHour() });
  return { account_id: accountId, ...health, watch };
}

async function recoverCollectorAccount(accountId, options = {}) {
  const collector = activeCollector || startLiveCollector();
  return collector.recoverAccount(accountId, options);
}

// 供路由复用：返回某账号最新一轮采集的全部素材明细（video+live+carousel 合并），无数据返回 []
function getLatestMaterialsAll(accountId) {
  try {
    const latest = latestByAccount[accountId];
    if (!latest || !latest.record || !latest.record.materials) return [];
    const m = latest.record.materials;
    return [...(m.video || []), ...(m.live || []), ...(m.carousel || [])];
  } catch (e) {
    return [];
  }
}

function getLatestMaterialChanges(accountId, options = {}) {
  return materialChanges.build(accountId, options);
}

// 供 /api/live-trend 用：某账号当前/最近场次的 5 分钟粒度趋势（内存态，0 千川开销）
// 下播后 latestByAccount 保留最近场次记录，回流补采会刷新终值，前端可直接画"当日盘中曲线"
function getLatestTrend(accountId) {
  try {
    const latest = latestByAccount[accountId];
    if (!latest || !latest.record) return { trend: [], flowSamples: [], room: null, session: null, fetchedAt: null };
    const r = latest.record;
    const trend = (r.trend || []).map(p => ({
      time: p.time,
      cost: p.cost,
      gmvSettle: p.gmvSettle,
      netDataValid: p.netDataValid === true,
      costDataValid: p.costDataValid === true,
      roi: p.cost > 0 ? +(p.gmvSettle / p.cost).toFixed(3) : 0,
    }));
    const flowState = flowSamplesByAccount.get(accountId);
    const inMemory = flowState && flowState.sessionKey === latest.sessionKey
      ? flowState.samples.map(sample => ({ ...sample }))
      : [];
    let persisted = [];
    try {
      persisted = getDB().prepare(`
        SELECT sample_time, total_cost, assist_cost
        FROM live_flow_samples
        WHERE account_id = ? AND session_key = ? AND sample_time >= ?
        ORDER BY sample_time ASC
      `).all(accountId, latest.sessionKey, new Date(Date.now() - FLOW_SAMPLE_KEEP_MS).toISOString())
        .map(row => ({
          ts: Date.parse(row.sample_time),
          at: row.sample_time,
          totalCost: Number(row.total_cost),
          assistCost: Number(row.assist_cost),
          basicCost: Number(row.total_cost) - Number(row.assist_cost),
        }));
    } catch (error) {
      console.warn(`[flow-samples] 读取持久化基线失败，继续使用内存采样: ${error.message}`);
    }
    const merged = new Map();
    for (const sample of [...persisted, ...inMemory]) merged.set(sample.ts, sample);
    const flowSamples = [...merged.values()].sort((a, b) => a.ts - b.ts);
    return { trend, flowSamples, room: r.room || null, session: r.session || null,
      fetchedAt: r.component_times?.trend?.source_at || latest.fetchedAt || null };
  } catch (e) {
    return { trend: [], flowSamples: [], room: null, session: null, fetchedAt: null };
  }
}

function clearAccountCache(accountId) {
  // 归档只移除该账号命名空间的派生缓存；SQLite 历史、Cookie、Profile 均不在此范围。
  const safeId = String(accountId || '');
  if (!/^[A-Za-z0-9_-]{2,50}$/.test(safeId)) return 0;
  const root = path.resolve(CACHE_DIR);
  let removed = 0;
  const isOwned = name => name === safeId || name.includes(`_${safeId}_`) || name.endsWith(`_${safeId}.json`) || name.startsWith(`${safeId}_`);
  function visit(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.resolve(dir, entry.name);
      if (!target.startsWith(root + path.sep)) continue;
      if (entry.isDirectory()) {
        if (entry.name === safeId) {
          try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {}
        } else {
          visit(target, depth + 1);
        }
      } else if (isOwned(entry.name)) {
        try { fs.rmSync(target, { force: true }); removed++; } catch {}
      }
    }
  }
  visit(root, 0);
  return removed;
}

async function evictAccountRuntime(accountId) {
  for (const flights of [boardFlights, coreFlights, intradayFlights]) {
    const entry = flights.get(accountId);
    if (entry && !entry.controller.signal.aborted) {
      entry.controller.abort(qcError('account_archived', '账号已移出，停止采集', { statusCode: 409, component: 'collector' }));
    }
    flights.delete(accountId);
  }
  delete latestByAccount[accountId];
  latestCoreByAccount.delete(accountId);
  materialChanges.clear(accountId);
  delete latestLiveStates[accountId];
  delete collectorRuntime.accounts[accountId];
  flowSamplesByAccount.delete(accountId);
  return { cache_entries_removed: clearAccountCache(accountId) };
}

module.exports = {
  startLiveCollector,
  collectOnce,
  collectLive,
  collectCoreSession,
  collectEndedSession,
  assembleRecord,
  mapIntradayMaterialRow,
  getLatestWatch,
  todayMaterialMap,
  getLatestMaterialsAll,
  getLatestMaterialChanges,
  getLatestTrend,
  getCollectorStatus,
  getCollectorHealth,
  recoverCollectorAccount,
  assessCollectorWatch,
  makeSessionKey,
  recordFlowSample,
  resetFlowSamples,
  runBoardSingleFlight,
  buildSessionSkeleton,
  buildThresholds,
  clearAccountCache,
  evictAccountRuntime,
  isCollectorQuietHour,
  getStartupTickOptions,
};
