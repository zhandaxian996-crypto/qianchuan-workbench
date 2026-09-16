const { fetchBoostOverview, fetchBoostTrend, fetchBoostMaterialDetail, fetchBoostSupport, fetchBoostOptLog, fetchSuggestedRoi, fetchBoostList } = require('../lib/qianchuanTabs');
const { deleteBoostTask } = require('../lib/qianchuan');
const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, validateDateRange, checkBodyKeys } = require('../lib/utils');
const { describeResult } = require('../lib/qcErrors');
const opLog = require('../lib/operationLog');
const { executeWithReceipt } = require('../lib/writeReceipt');
const { withTargetWriteLock } = require('../lib/targetWriteLock');
const { boostTaskContract } = require('../lib/boostTaskContract');
const { attachRoiGoalContract, inferRoiGoalBasis } = require('../lib/roiBasis');

const BOOST_EFFECT_ROI_BASIS = Object.freeze({
  gmv: 'payment',
  roi: 'payment',
  net_roi: 'platform_net_1h',
});

function metricValueOrNull(cell) {
  if (cell == null) return null;
  const value = typeof cell === 'object'
    ? (cell.Value != null ? cell.Value : cell.value != null ? cell.value : cell.ValueStr)
    : cell;
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(number) ? number : null;
}

function metricValidity(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value != null]));
}

/**
 * 追投效果数据路由：
 *
 * GET /api/boost-overview?assistAid=&anchorId=&startDate=&endDate=&account=
 *   追投效果概览（汇总指标 + 昨日环比）
 *
 * GET /api/boost-trend?assistAid=&anchorId=&startDate=&endDate=&account=
 *   追投效果趋势（按小时）
 *
 * GET /api/boost-material-detail?assistAid=&startDate=&endDate=&account=
 *   追投素材明细（每个素材的效果数据）
 *
 * GET /api/boost-support?adId=&startDate=&endDate=&account=
 *   追投流量扶持数据（累计 + 增量）
 *
 * POST /api/boost-delete
 *   删除追投任务 body: { assistTaskId, accountId }
 */
async function handleBoostData(req, res, url) {
  const pathname = url.pathname;

  // ===== GET 接口 =====
  if (req.method === 'GET') {
    const account = url.searchParams.get('account') || undefined;

    // 追投效果概览
    if (pathname === '/api/boost-overview') {
      const assistAid = url.searchParams.get('assistAid');
      const anchorId = url.searchParams.get('anchorId');
      if (!assistAid || !anchorId) return sendJSON(res, { ok: false, error: 'Missing assistAid or anchorId' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostOverview(assistAid, anchorId, startDate, endDate, account);
        return sendJSON(res, {
          ok: true, assistAid, startDate, endDate,
          metric_roi_basis: { default: 'unknown' },
          data: result && result.data,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投效果趋势
    if (pathname === '/api/boost-trend') {
      const assistAid = url.searchParams.get('assistAid');
      const anchorId = url.searchParams.get('anchorId');
      if (!assistAid || !anchorId) return sendJSON(res, { ok: false, error: 'Missing assistAid or anchorId' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostTrend(assistAid, anchorId, startDate, endDate, account);
        return sendJSON(res, {
          ok: true, assistAid, startDate, endDate,
          metric_roi_basis: { default: 'unknown' },
          data: result && result.data,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投素材明细
    if (pathname === '/api/boost-material-detail') {
      const assistAid = url.searchParams.get('assistAid');
      if (!assistAid) return sendJSON(res, { ok: false, error: 'Missing assistAid' }, 400);
      const primaryAdId = url.searchParams.get('primaryAdId') || url.searchParams.get('adId');
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      const slim = url.searchParams.get('slim') === '1';
      const sessionKey = url.searchParams.get('session_key') || null;
      try {
        const result = await fetchBoostMaterialDetail(assistAid, startDate, endDate, account);
        // 素材明细响应通常只有 StatsData。调用方同时给出主计划 ID 时，额外用真实
        // 追投列表回读优化元数据；回读失败时保持 unknown，不猜口径也不影响只读明细。
        let optimizationEntity = result && result.data && (
          result.data.adInfo || result.data.taskInfo || result.data.assistTaskInfo || result.data
        );
        if (primaryAdId) {
          try {
            const listResult = await fetchBoostList(primaryAdId, startDate, endDate, account, { includeAllStatus: true });
            const tasks = (listResult && listResult.data && listResult.data.adInfos) || [];
            optimizationEntity = tasks.find(task => String(task.id) === String(assistAid)) || optimizationEntity;
          } catch (readbackError) {
            console.log(`[boost-material-detail] ROI 口径回读失败: ${readbackError.message}`);
          }
        }
        const roiContract = attachRoiGoalContract(optimizationEntity);
        const task_contract = boostTaskContract(optimizationEntity || {}, {
          id: String(assistAid), status: optimizationEntity?.adDeliveryName,
          start_time: optimizationEntity?.startTime || optimizationEntity?.createTime || null,
          budget: optimizationEntity?.budget == null ? null : Number(optimizationEntity.budget) / 100000,
          roi_goal: optimizationEntity?.ecpRoi2Goal, passive_stop: require('../lib/utils').isPassiveStop(optimizationEntity?.adDeliveryName),
        }, { accountId: account, sourceAt: result?.source_at || null, start: startDate, end: endDate, sessionKey });
        if (slim) {
          // 历史账户专用说明已从试用包移除。
          // 盯盘轮筛选优秀素材一次拿全，不再拉全量明细
          const stats = result && result.data && result.data.StatsData;
          const materials = (stats && Array.isArray(stats.Rows) ? stats.Rows : []).map(m => {
            const d = m.Dimensions || {};
            const mt = m.Metrics || {};
            const metrics = {
              cost: metricValueOrNull(mt.stat_cost_for_roi2_assist),
              show_cnt: metricValueOrNull(mt.show_cnt_for_roi2_assist),
              click_cnt: metricValueOrNull(mt.click_cnt_for_roi2_assist),
              ctr: metricValueOrNull(mt.ctr_for_roi2_assist),
              clicks: metricValueOrNull(mt.click_cnt_for_roi2_assist),
              cpc: (() => { const cost = metricValueOrNull(mt.stat_cost_for_roi2_assist); const clicks = metricValueOrNull(mt.click_cnt_for_roi2_assist); return cost != null && clicks > 0 ? +(cost / clicks).toFixed(4) : null; })(),
              clickRate: metricValueOrNull(mt.ctr_for_roi2_assist),
              orders: metricValueOrNull(mt.total_pay_order_count_for_roi2_assist),
              gmv: metricValueOrNull(mt.total_pay_order_gmv_for_roi2_assist),
              net_roi: metricValueOrNull(mt.total_prepay_and_pay_settle_roi2_1h_assist),
            };
            return {
              name: (d.assist_material_name && d.assist_material_name.Value) || '',
              material_id: (d.material_id && d.material_id.Value) || '',
              ...metrics,
              field_validity: metricValidity(metrics),
              metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
            };
          }).sort((a, b) => (b.cost == null ? -Infinity : b.cost) - (a.cost == null ? -Infinity : a.cost));
          const t = (stats && stats.Totals) || {};
          const totalMetrics = {
            cost: metricValueOrNull(t.stat_cost_for_roi2_assist),
            show_cnt: metricValueOrNull(t.show_cnt_for_roi2_assist),
            click_cnt: metricValueOrNull(t.click_cnt_for_roi2_assist),
            ctr: metricValueOrNull(t.ctr_for_roi2_assist),
            clicks: metricValueOrNull(t.click_cnt_for_roi2_assist),
            cpc: (() => { const cost = metricValueOrNull(t.stat_cost_for_roi2_assist); const clicks = metricValueOrNull(t.click_cnt_for_roi2_assist); return cost != null && clicks > 0 ? +(cost / clicks).toFixed(4) : null; })(),
            clickRate: metricValueOrNull(t.ctr_for_roi2_assist),
            orders: metricValueOrNull(t.total_pay_order_count_for_roi2_assist),
            gmv: metricValueOrNull(t.total_pay_order_gmv_for_roi2_assist),
            net_roi: metricValueOrNull(t.total_prepay_and_pay_settle_roi2_1h_assist),
          };
          const totals = {
            ...totalMetrics,
            field_validity: metricValidity(totalMetrics),
            metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
          };
          return sendJSON(res, {
            ok: true, assistAid, primary_ad_id: primaryAdId || null, startDate, endDate, session_key: sessionKey, slim: true,
            ...roiContract, task_contract,
            metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
            settlement_window: { net_roi: '1h' },
            data: { materials, totals },
          });
        }
        return sendJSON(res, {
          ok: true, assistAid, primary_ad_id: primaryAdId || null, startDate, endDate, session_key: sessionKey,
          ...roiContract, task_contract,
          metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
          settlement_window: { net_roi: '1h' },
          data: result && result.data,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投流量扶持
    if (pathname === '/api/boost-support') {
      const adId = url.searchParams.get('adId');
      if (!adId) return sendJSON(res, { ok: false, error: 'Missing adId' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostSupport(adId, startDate, endDate, account);
        return sendJSON(res, {
          ok: true, adId, startDate, endDate,
          metric_roi_basis: { default: 'unknown' },
          data: result,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投ROI操作日志
    if (pathname === '/api/boost-opt-log') {
      const aggAid = url.searchParams.get('aggAid');
      if (!aggAid) return sendJSON(res, { ok: false, error: 'Missing aggAid (全域计划ID)' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostOptLog(aggAid, startDate, endDate, account);
        const optLogs = result && result.data && result.data.optLogs ? result.data.optLogs : [];
        return sendJSON(res, {
          ok: true,
          aggAid,
          startDate,
          endDate,
          count: optLogs.length,
          hasPurePayRoi: result && result.data ? result.data.hasPurePayRoi : null,
          hasOverallRoi: result && result.data ? result.data.hasOverallRoi : null,
          logs: optLogs.map(log => ({
            modify_ts: log.modifyTs,
            modify_time: log.modifyTs ? new Date(parseInt(log.modifyTs) * 1000).toLocaleString('zh-CN', { hour12: false }) : null,
            before_roi: log.beforeEcpRoi2Goal,
            after_roi: log.afterEcpRoi2Goal,
            before_roi_basis: inferRoiGoalBasis({ deepExternalAction: log.beforeDeepEa }).basis,
            after_roi_basis: inferRoiGoalBasis({ deepExternalAction: log.afterDeepEa }).basis,
            before_deep_action: log.beforeDeepEa,
            after_deep_action: log.afterDeepEa,
            before_type: log.beforeType,
            after_type: log.afterType,
            before_cost_items: log.beforeOverallRoiCostItems,
            after_cost_items: log.afterOverallRoiCostItems,
            before_adlab_scene: log.beforeAdlabScene,
            after_adlab_scene: log.afterAdlabScene,
          })),
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投建议ROI目标
    if (pathname === '/api/boost-suggest-roi') {
      const adId = url.searchParams.get('adId');       // 追投任务ID
      const primaryAdId = url.searchParams.get('primaryAdId'); // 全域计划ID
      const anchorId = url.searchParams.get('anchorId');      // 主播ID
      if (!adId || !primaryAdId || !anchorId) {
        return sendJSON(res, { ok: false, error: 'Missing adId, primaryAdId, or anchorId' }, 400);
      }
      try {
        const result = await fetchSuggestedRoi(adId, primaryAdId, anchorId, account);
        const outputs = result && result.data && result.data.getSuggestedRoiGoalOutputs ? result.data.getSuggestedRoiGoalOutputs : [];
        return sendJSON(res, {
          ok: true,
          adId,
          primaryAdId,
          anchorId,
          suggestions: outputs.map((s, i) => {
            const deepExternalAction = i === 0 ? 326 : 576;
            return {
              deep_external_action: deepExternalAction,
              action_name: i === 0 ? '直播间支付' : '净成交ROI',
              roi_basis: inferRoiGoalBasis({ deepExternalAction }).basis,
              suggested_roi: s.ecpRoi2Goal,
              roi_lower_bound: s.roi2LowerBound,
              roi_upper_bound: s.roi2UpperBound,
              roi_high: s.roi2High,
              order_pay_rate: s.orderPayRate,
              is_accepted: s.isAccepted,
            };
          }),
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
  }

  // ===== POST: 删除追投任务 =====
  if (pathname === '/api/boost-delete' && req.method === 'POST') {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
    // body 参数白名单（2026-08-11 backlog 检修）
    const bodyCheck = checkBodyKeys(data, ['accountId', 'assistTaskId', 'source'], '/api/boost-delete');
    if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

    const { assistTaskId, accountId: accountIdCamel, account_id: accountIdSnake } = data;
    const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）
    if (!assistTaskId) return sendJSON(res, { ok: false, error: 'Missing assistTaskId' }, 400);
    if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
    // 账号白名单：拼错的账号会回落默认 cookie，对错账号执行写操作（2026-07-25 审查修复）
    try { require('../lib/api-helpers').validateAccount(accountId); } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 400);
    }

    return withTargetWriteLock(accountId, assistTaskId, async () => {
    // 频率熔断（2026-07-25 审查补闸：删除曾无任何限制，可配合重建绕过调整纪律）
    const recentLogs = opLog.query({ adId: assistTaskId, accountId, limit: 50 });
    const now = Date.now();
    const recentOps = recentLogs.filter(l => String(l.target_id) === String(assistTaskId) && l.action === 'delete_boost' && (now - new Date(l.ts).getTime()) < 3600000 && l.success);
    if (recentOps.length >= 3) {
      // 历史账户专用说明已从试用包移除。
      const nextAllowed = new Date(new Date(recentOps[recentOps.length - 1].ts).getTime() + 3600000).toISOString();
      // 2026-08-11 审查修复：拦截也落盘 op-log（审计完整性，对齐 campaignOps pause_blocked 模式）
      opLog.log({ action: 'delete_boost_blocked', account_id: accountId, target_type: 'boost_task', target_id: assistTaskId, result_msg: '1h 删除频率熔断拦截', success: false, source: opLog.normalizeSource(data.source) });
      return sendJSON(res, { ok: false, error: `操作频率过高：目标 ${assistTaskId} 1小时内已操作 ${recentOps.length} 次（上次：${recentOps[0].ts}）。请等待后再试`, blocked: true, rule: 'boost_delete_rate_limit', next_allowed_at: nextAllowed }, 429);
    }

    try {
      // 删除前落操作前旧值（2026-07-30 审计修复：op-log 契约"含操作前旧值"；拉不到记 null 不阻塞）
      // 数据源 /api/boost-list（含全状态）：任务对象带 budget/roi_goal/status/smart_bid_type；
      // fetchBoostTaskReport 的 tasks 只有 assistAid+效果指标，没有预算/出价字段（opus 复核实锤）
      let oldValue = null;
      try {
        const r = await fetch(`http://127.0.0.1:${require('../lib/config').PORT}/api/boost-list?account=${encodeURIComponent(accountId)}&includeAllStatus=1`, { signal: AbortSignal.timeout(30000) });
        const j = await r.json().catch(() => null);
        const t = (j && j.ok && Array.isArray(j.tasks)) ? j.tasks.find(x => String(x.id) === String(assistTaskId)) : null;
        if (t) oldValue = { budget: t.budget, roi_goal: t.roi_goal, status: t.status, name: t.name, smart_bid_type: t.smart_bid_type };
        else oldValue = { fetch_note: '任务未在 boost-list 找到（可能已删）' };
      } catch (e) {
        oldValue = { fetch_error: e.message };
      }

      const receipt = await executeWithReceipt({
        write: () => deleteBoostTask(assistTaskId, accountId),
        read: async () => {
          const r = await fetch(`http://127.0.0.1:${require('../lib/config').PORT}/api/boost-list?account=${encodeURIComponent(accountId)}&includeAllStatus=1`, { signal: AbortSignal.timeout(10000) });
          const list = await r.json();
          if (!list.ok) throw new Error('readback_list_failed');
          const task = list.tasks?.find(t => String(t.id) === String(assistTaskId));
          // An absent row is not deletion proof (pagination/filter/latency can hide it).
          return task ? { deleted: /已删除/.test(task.status || ''), status: task.status } : null;
        },
        before: oldValue, requested: { deleted: true },
        logEntry: { action: 'delete_boost', account_id: accountId, target_type: 'boost_task', target_id: assistTaskId,
          params: { assistTaskId, old_value: oldValue }, source: opLog.normalizeSource(data.source) },
      });
      return sendJSON(res, receipt, receipt.ok ? 200 : (receipt.http_status || 502));
    } catch (e) {
      opLog.log({ action: 'delete_boost', account_id: accountId, target_type: 'boost_task', target_id: assistTaskId, success: false, result_msg: e.message, source: opLog.normalizeSource(data.source) });
      return handleApiError(res, e);
    }
    });
  }

  return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
}

function getToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = handleBoostData;
