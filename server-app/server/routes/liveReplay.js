const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchLiveBoard } = require('../lib/liveBoard');
const qcTabs = require('../lib/qianchuanTabs'); // 命名空间引用（不解构）：测试可注入 stub
const { assembleRecord } = require('../lib/liveCollector');
const { resolveQcAccount } = require('../lib/cookie');
const { sendJSON, handleApiError, getLocalDateStr } = require('../lib/utils');
const { isValidAccountId, writeJsonAtomic } = require('../lib/api-helpers');
const { normalizeFunnel, normalizeChannels, buildLiveFinancialBasis } = require('../lib/decisionContext');
const { STORAGE_DIR } = require('../lib/config');

function decorateReplayContract(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const sourceAt = payload.fetchedAt || null; // 落盘时间不是上游数据水位。
  const cacheStable = Array.isArray(payload.sessions)
    ? sessionsSettled(payload.sessions)
    : replaySettled(payload);
  // 旧缓存的账号/多日追投不能重新命名成本场；原始缓存不改写，详情显式请求才暴露。
  const tasks = Array.isArray(payload.boostTasks) ? payload.boostTasks : [];
  const reportWindow = payload.boost_report_window || null;
  const relatedHistory = {
    scope: 'report_date_range_not_session',
    status: payload.boost_report_error ? 'unavailable' : tasks.length || reportWindow ? 'available' : 'not_requested',
    task_count: tasks.length || reportWindow ? tasks.length : null,
    window: reportWindow, source_at: payload.boost_report_source_at || null,
    reason: payload.boost_report_error || (reportWindow ? 'report_window_not_session_attribution' : tasks.length ? 'legacy_report_window_unknown' : 'history_not_loaded'),
    detail_parameter: 'include_boost_history=1',
    ...(options.includeBoostHistory && (tasks.length || reportWindow) ? { tasks } : {}),
  };
  const historicalMaterial = ({ heatStatus, boostTaskName, ...metrics }) => metrics;
  return {
    ...payload,
    ...(payload.materials ? { materials: Object.fromEntries(Object.entries(payload.materials)
      .map(([kind, rows]) => [kind, Array.isArray(rows) ? rows.map(historicalMaterial) : rows])) } : {}),
    ...(Array.isArray(payload.materialsTop) ? { materialsTop: payload.materialsTop.map(historicalMaterial) } : {}),
    boostTasks: [],
    boostTaskMap: {},
    boost_coverage: { scope: 'current_session', data_valid: false, returned: 0,
      reason: 'task_session_attribution_unavailable', empty_means_no_tasks: false },
    related_boost_history: relatedHistory,
    riskAlerts: [],
    decisions: { redList: [], blackList: [], status: 'not_evaluated' },
    thresholds: null,
    policy_evaluation: { status: 'not_evaluated', reason: 'historical_strategy_not_bound',
      legacy_annotations_omitted: (payload.riskAlerts || []).length
        + (payload.decisions?.redList || []).length + (payload.decisions?.blackList || []).length },
    material_state_scope: 'historical_task_state_unavailable',
    financial_basis: payload.financial_basis || buildLiveFinancialBasis(),
    settlement_state: {
      roi_basis: 'platform_net_1h',
      settlement_window: '1h',
      cache_stable: cacheStable,
      final_settlement_available: false,
      note: 'cache_stable 仅表示平台1小时净口径已过缓存稳定窗口，不代表最终结算完成',
    },
    funnel_contract: normalizeFunnel(payload.funnel, { sourceAt, window: 'session_replay' }),
    channels: normalizeChannels(payload.channels || (Array.isArray(payload.source) ? payload.source : []), {
      sourceAt,
      window: 'session_replay',
    }),
  };
}

/**
 * 复盘数据缓存（按 account + roomId + startTime 落盘）。
 * 已结束且过平台1小时净口径缓存稳定窗口（下播 >90 分钟）的场次数据通常不再变，拉取一次后缓存到 storage/replay/，
 * 后续请求直接读文件，避免每次都打千川接口。
  * 历史账户专用说明已从试用包移除。
 * 传入 refresh=1 可强制刷新。
 */
const REPLAY_STORAGE_DIR = path.join(STORAGE_DIR, 'replay');

function normalizeSessionTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = Date.parse(raw.replace(' ', 'T'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

function replayStoragePath(account, roomId, startTime, baseDir = REPLAY_STORAGE_DIR) {
  // 安全防护：account 和 roomId 只允许安全字符，防止路径遍历
  const safeAccount = isValidAccountId(account) ? account : 'unknown';
  const safeRoomId = /^[a-zA-Z0-9_-]+$/.test(roomId) ? roomId : 'unknown';
  const normalizedStart = normalizeSessionTime(startTime);
  if (!normalizedStart) return path.join(baseDir, `replay_${safeAccount}_${safeRoomId}.json`);
  const startKey = crypto.createHash('sha256').update(normalizedStart).digest('hex').slice(0, 12);
  return path.join(baseDir, `replay_${safeAccount}_${safeRoomId}_${startKey}.json`);
}

function readReplayFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.ok !== true) return null;
    return data;
  } catch {
    return null;
  }
}

function loadReplayStorage(account, roomId, startTime, options = {}) {
  const normalizedStart = normalizeSessionTime(startTime);
  if (!normalizedStart) return null;
  const baseDir = options.baseDir || REPLAY_STORAGE_DIR;
  const canonical = readReplayFile(replayStoragePath(account, roomId, normalizedStart, baseDir));
  if (canonical) {
    const cachedStart = normalizeSessionTime(canonical.room && canonical.room.start_time);
    return cachedStart === normalizedStart ? canonical : null;
  }
  // 升级前旧文件只按 roomId 命名。只有文件内部 start_time 精确匹配才承认归属，
  // 且标为 legacy，调用方必须穿透重拉生成新键，禁止直接当作当前1h净口径稳定值返回。
  const legacy = readReplayFile(replayStoragePath(account, roomId, null, baseDir));
  if (!legacy) return null;
  const legacyStart = normalizeSessionTime(legacy.room && legacy.room.start_time);
  return legacyStart === normalizedStart ? { ...legacy, legacy_cache: true } : null;
}

function saveReplayStorage(account, roomId, startTime, payload) {
  try {
    if (!fs.existsSync(REPLAY_STORAGE_DIR)) fs.mkdirSync(REPLAY_STORAGE_DIR, { recursive: true });
    writeJsonAtomic(replayStoragePath(account, roomId, startTime), payload);
  } catch (e) {
    console.log(`[live-replay] 存储写入失败: ${e.message}`);
  }
}

// 场次列表存储（按 account + date 落盘，永久保存）
function sessionsStoragePath(account, date) {
  const safeAccount = isValidAccountId(account) ? account : 'unknown';
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'unknown';
  return path.join(REPLAY_STORAGE_DIR, `sessions_${safeAccount}_${safeDate}.json`);
}

function loadSessionsStorage(account, date) {
  try {
    const p = sessionsStoragePath(account, date);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.ok !== true) return null;
    return data;
  } catch {
    return null;
  }
}

function saveSessionsStorage(account, date, payload) {
  try {
    // 原子写（临时文件+rename）：采集中断/进程崩溃不会留下残缺 JSON 污染永久存储
    writeJsonAtomic(sessionsStoragePath(account, date), payload);
  } catch (e) {
    console.log(`[live-replay] 场次列表存储失败: ${e.message}`);
  }
}

// 场次快照是否终态：全部场次已结束（无 status=2 在播、均有 endTime）。
// 含在播场次的快照禁止当"永久存储"——2026-07-30 bug：07-28 在播场次被固化，
// 复盘页一直显示"直播中"（时长 44h+），千川上游其实早已结束。
function sessionsFinal(sessions) {
  return (sessions || []).every(s => String(s.status) !== '2' && s.endTime && s.endTime !== '-');
}

// 历史账户专用说明已从试用包移除。
// 窗口内的"已结束"数据允许落盘但每次请求穿透重拉（覆盖落盘）；过窗后可缓存该口径。
// 取 90 分钟（1h 指标 + 延迟余量）。这不是 final_settlement 的完成判定。
const SETTLE_WINDOW_MS = 90 * 60 * 1000;
const SETTLE_WINDOW_MIN = SETTLE_WINDOW_MS / 60000;

function endMsOf(t) {
  const ms = new Date(String(t || '').replace(' ', 'T')).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// 场次列表是否已过1h净口径缓存稳定窗口：全终态 且 最晚下播时间距今 > 90 分钟
function sessionsSettled(sessions, nowMs = Date.now()) {
  if (!sessionsFinal(sessions)) return false;
  const latestEnd = Math.max(0, ...(sessions || []).map(s => endMsOf(s.endTime)));
  return latestEnd > 0 && (nowMs - latestEnd) > SETTLE_WINDOW_MS;
}

// 单场复盘缓存是否可放心直返当前1h净口径：有明确结束时间 且 已过缓存稳定窗口
// （在播/无结束时间 → 永不直接吃缓存，顺带防"在播场次被旧缓存遮蔽"）
function replaySettled(cached, nowMs = Date.now()) {
  const end = String((cached && cached.room && cached.room.end_time) || '');
  if (!end || end === '-') return false;
  const endMs = endMsOf(end);
  return endMs > 0 && (nowMs - endMs) > SETTLE_WINDOW_MS;
}

/**
 * 直播复盘路由
 *
 * GET /api/live-replay/sessions?account=xxx&date=YYYY-MM-DD
 *   获取某天的直播场次列表（用于复盘选场次）
 *
 * GET /api/live-replay?roomId=xxx&account=xxx&startTime=YYYY-MM-DD HH:MM:SS&endTime=YYYY-MM-DD HH:MM:SS
 *   获取精确场次事实；include_boost_history=1 单独展开非本场归因的日期范围报告。
 */
async function handleLiveReplay(req, res, url) {
  const pathname = url.pathname;

  // ===== 场次列表 =====
  if (pathname === '/api/live-replay/sessions') {
    if (req.method !== 'GET') return sendJSON(res, { ok: false, error: '只支持 GET' }, 405);
    const account = url.searchParams.get('account');
    if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
    const date = url.searchParams.get('date') || getLocalDateStr();
    const refresh = url.searchParams.get('refresh') === '1';
    // 未来日期不查也不落盘：空结果写进"永久存储"会把明天真正到达时的场次永久遮蔽（2026-07-29 审计修复）
    if (date > getLocalDateStr()) {
      return sendJSON(res, { ok: false, error: '日期不能超过今天（未来日期无场次，且空结果落盘会污染永久存储）' }, 400);
    }

    // 场次列表存储：已结束且过1h净口径缓存稳定窗口后，拉一次存文件，后续直接读。
    // 历史账户专用说明已从试用包移除。
    if (!refresh) {
      const cached = loadSessionsStorage(account, date);
      if (cached && sessionsSettled(cached.sessions)) {
        cached.cached = true;
        return sendJSON(res, decorateReplayContract(cached));
      }
    }

    try {
      const r = await qcTabs.fetchLiveSessions(date, { accountId: account });
      // fetchLiveSessions 内部 catch 后返回 { sessions: [], error }——不检查就会把空结果当稳定值固化，
      // 上游一次抖动就永久遮蔽真数据（2026-07-30 审计：07-19/26 空文件即此路径，巧合是那天真没播）
      if (r.error) {
        return sendJSON(res, { ok: false, error: `场次拉取失败（不落盘，下次重试）: ${r.error}` }, 502);
      }
      // 只返回已结束的场次（复盘用），附上 accountName
      const accName = resolveQcAccount(account)?.name || account;
      const sessions = (r.sessions || []).map(s => ({
        ...s,
        account,
        accountName: accName,
      }));
      const payload = { ok: true, account, accountName: accName, date, sessions, settle_window_min: SETTLE_WINDOW_MIN };
      // 只有全终态快照才落盘永久存储；含在播场次的快照直接返回不落盘，等终态后再固化
      if (sessionsFinal(sessions)) saveSessionsStorage(account, date, payload);
      return sendJSON(res, decorateReplayContract(payload));
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  // ===== 单场复盘看板 =====
  if (pathname === '/api/live-replay') {
    if (req.method !== 'GET') return sendJSON(res, { ok: false, error: '只支持 GET' }, 405);
    const roomId = url.searchParams.get('roomId');
    const account = url.searchParams.get('account');
    if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
    const startTime = url.searchParams.get('startTime') || undefined;
    const endTime = url.searchParams.get('endTime') || undefined;
    if (!roomId) return sendJSON(res, { ok: false, error: '需要 roomId 参数' }, 400);
    if (!startTime) {
      return sendJSON(res, {
        ok: false,
        code: 'start_time_required',
        component: 'live_replay',
        retryable: false,
        error: '需要 startTime 参数以隔离同一直播间的不同场次',
      }, 400);
    }

    const acc = resolveQcAccount(account);
    const anchorId = acc ? acc.anchorId : undefined;
    const accountName = acc ? acc.name : account;

    // 稳定历史缓存不再为“追投当前状态”访问平台，也不按素材名回写历史状态。
    const includeBoostHistory = url.searchParams.get('include_boost_history') === '1';
    const refresh = url.searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = loadReplayStorage(account, roomId, startTime);
      if (cached && !cached.legacy_cache && replaySettled(cached)) {
        return sendJSON(res, decorateReplayContract({ ...cached, cached: true }, { includeBoostHistory }));
      }
    }

    try {
      // 1. 拉大屏全量数据
      const board = await fetchLiveBoard(roomId, anchorId, startTime, account, endTime);
      if (!board) return sendJSON(res, { ok: false, error: '大屏数据为空' }, 502);

      // 2. 构造 room 信息（assembleRecord 需要）
      const initRow = board.init && board.init.rows && board.init.rows[0];
      const initDims = (initRow && initRow.Dimensions) || {};
      const room = {
        room_id: roomId,
        room_name: initDims.room_name?.ValueStr || initDims.room_name?.Value || '',
        start_time: startTime || initDims.room_start_time?.ValueStr || initDims.room_start_time?.Value || '',
        end_time: endTime || initDims.room_end_time?.ValueStr || initDims.room_end_time?.Value || '',
        anchor_id: anchorId,
        status: initDims.room_status?.Value ?? null,
      };

      // 3. 复用 assembleRecord 解析大屏数据
      const record = assembleRecord(board, room, accountName, account);

      // 追投报告只有日期范围归因，不属于精确场次。默认不额外取数；需要历史明细时显式读取。
      let boostTasks = [], boostReportWindow = null, boostReportSourceAt = null, boostReportError = null;
      if (includeBoostHistory) {
        const reportStart = String(room.start_time).slice(0, 10);
        const reportEnd = String(room.end_time && room.end_time !== '-' ? room.end_time : room.start_time).slice(0, 10);
        boostReportWindow = { start_date: reportStart, end_date: reportEnd };
        try {
          const report = await qcTabs.fetchBoostTaskReport(reportStart, reportEnd, account);
          if (!report || report.ok === false || report.error || !Array.isArray(report.tasks)) {
            boostReportError = report?.error || 'boost_report_unavailable';
          } else {
            boostTasks = report.tasks;
            boostReportSourceAt = report.fetched_at || report.source_at || null;
          }
        } catch (error) { boostReportError = error.code || error.message; }
      }

      // 7. materialsTop 兜底：assembleRecord 不返回该字段，从 materials.video 取
      const materialsTop = record.materialsTop || (record.materials && record.materials.video || []).slice(0, 10).map(m => ({
        name: m.name, cost: m.cost, roiSettle: m.roiSettle, orders: m.orders, heatStatus: m.heatStatus,
      }));

      // 7.5 大屏增强（2026-08-02 探针接入）：分钟级趋势 + 调控动作日志 + 素材5分钟趋势
      // best-effort：任一路失败只缺对应段（partial），不阻塞主看板；cookie_expired 上抛
      let boardDetail = { partial: false, errors: [] };
      try {
        const { fetchBoardDetail } = require('../lib/liveBoardDetail');
        const detailStart = room.start_time || startTime;
        const detailEnd = (room.end_time && room.end_time !== '-') ? room.end_time : (endTime || undefined);
        if (detailStart) {
          boardDetail = await fetchBoardDetail(roomId, anchorId, detailStart, detailEnd, account);
        }
      } catch (e) {
        if (e.message === 'cookie_expired') throw e;
        boardDetail = { partial: true, errors: [`fetchBoardDetail: ${e.message}`] };
        console.log(`[live-replay] 大屏增强拉取跳过: ${e.message}`);
      }

      // 8. 返回结果
      const payload = {
        ok: true,
        account,
        accountName,
        roomId,
        session_key: `${account}|${roomId}|${normalizeSessionTime(room.start_time)}`,
        room,
        live_metrics: record.live_metrics,
        dataValid: record.dataValid === true,
        partial: record.partial === true || boardDetail.partial === true,
        errors: [...(record.errors || []), ...(boardDetail.errors || [])],
        trend: record.trend,
        trend_minute: boardDetail.trend_minute || null,
        roi2_log: boardDetail.roi2_log || null,
        material_trends: boardDetail.material_trends || null,
        detail_partial: boardDetail.partial || false,
        source: record.source,
        funnel: record.funnel,
        materialsTop,
        materials: record.materials,
        boostTasks,
        boost_report_window: boostReportWindow,
        boost_report_source_at: boostReportSourceAt,
        boost_report_error: boostReportError,
        riskAlerts: [],
        decisions: { redList: [], blackList: [], status: 'not_evaluated' },
        settle_window_min: SETTLE_WINDOW_MIN, // 兼容字段：1h净口径缓存稳定窗口，不代表最终结算
        fetchedAt: board.fetched_at,
        cached: false,
        cachedAt: new Date().toISOString(),
      };

      // 拉一次即落盘存储（窗口内数据会被后续重拉覆盖，过窗口后可缓存该1h净口径）
      saveReplayStorage(account, roomId, room.start_time, payload);

      // 历史账户专用说明已从试用包移除。
      try {
        const { upsertSession } = require('../lib/liveSessionStore');
        upsertSession(account, payload);
      } catch (e) {
        console.log(`[live-replay] 场次入库跳过: ${e.message}`);
      }

      // 新鲜拉取与缓存命中必须返回同一份口径契约，避免刚下播时把平台 1h
      // 净口径误读成最终结算；落盘仍保留原始 payload，由读取路径统一装饰。
      return sendJSON(res, decorateReplayContract(payload, { includeBoostHistory }));
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
}

module.exports = handleLiveReplay;
// 测试用内部导出（settled 判定纯函数）
module.exports._internal = {
  sessionsFinal, sessionsSettled, replaySettled, normalizeSessionTime,
  replayStoragePath, loadReplayStorage, decorateReplayContract,
  SETTLE_WINDOW_MS, SETTLE_WINDOW_MIN,
};
