const { fetchBoostList, fetchBoostSummary, fetchUniPromAdList } = require('../lib/qianchuanTabs');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr, isPassiveStop } = require('../lib/utils');
const { handleApiError } = require('../lib/handleApiError');
const { protectionFor, loadRunningStore } = require('../lib/boostGuard');
const { attachRoiGoalContract } = require('../lib/roiBasis');
const { boostTaskContract } = require('../lib/boostTaskContract');

const BOOST_EFFECT_ROI_BASIS = Object.freeze({
  roi: 'payment',
  net_roi: 'platform_net_1h',
});

function metricValueOrNull(cell) {
  if (cell == null) return null;
  const value = typeof cell === 'object'
    ? (cell.value != null ? cell.value : cell.Value != null ? cell.Value : cell.ValueStr)
    : cell;
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(number) ? number : null;
}

/**
 * GET /api/boost-list?adId=xxx&account=xxx&start=YYYY-MM-DD&end=YYYY-MM-DD&includeAllStatus=1
 * 不传 adId 时自动拉全部全域计划，再逐个查追投，合并返回。
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 */
// 给任务列表附加人工保护期判定（暂停/删除建议的前置闸）
function attachProtection(tasks, account) {
  const store = loadRunningStore();
  const now = Date.now();
  for (const t of tasks) {
    const aid = t.assistAid || t.assist_aid || t.assist_task_id || t.id;
    try { t.protection = protectionFor({ assistAid: String(aid) }, account, store, now); }
    catch { t.protection = { protected: false, source: 'check_error' }; }
  }
  return tasks;
}
async function handleBoostList(req, res, url) {
  const account = url.searchParams.get('account') || url.searchParams.get('accountId') || undefined;
  const adId = url.searchParams.get('adId');
  const includeAll = url.searchParams.get('includeAllStatus') === '1' || url.searchParams.get('includeAllStatus') === 'true';
  const listOpts = includeAll ? { includeAllStatus: true } : {};
  // marGoal：2=直播间(默认) 1=商品卡（2026-08-03 商品卡追投监测——门票任务挂 mar_goal=1 计划，默认口径看不到）
  const marGoalParam = url.searchParams.get('marGoal');
  if (marGoalParam != null && !['1', '2'].includes(marGoalParam)) {
    return sendJSON(res, { ok: false, error: 'marGoal 只支持 1(商品卡)/2(直播间，默认)' }, 400);
  }
  if (marGoalParam) listOpts.marGoal = parseInt(marGoalParam, 10);

  // 日期范围：支持 start/end 参数，默认近30天
  const today = getLocalDateStr();
  let end = url.searchParams.get('end') || today;
  let start = url.searchParams.get('start');
  if (!start) {
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);
    start = getLocalDateStr(d30);
  }

  if (!account) {
    return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  }

  if (!isCookieProbablyValid(readQcCookie(account))) {
    return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
  }

  // 不传 adId 时：先拉全部全域计划列表，再逐个查追投
  if (!adId) {
    try {
      const adListResult = await fetchUniPromAdList(start, end, account, listOpts.marGoal ? { marGoal: listOpts.marGoal } : {});
      const adInfos = (adListResult && adListResult.data && adListResult.data.adInfos) || [];
      if (adInfos.length === 0) {
        return sendJSON(res, { ok: true, account, date_range: `${start} ~ ${end}`, total_tasks: 0, tasks: [], message: '未找到任何全域计划' });
      }
      // 逐个计划查追投列表
      const allTasks = [];
      let truncated = adListResult?.truncated === true;
      for (const ad of adInfos) {
        try {
          const listResult = await fetchBoostList(String(ad.id), start, end, account, listOpts);
          if (listResult?.truncated || !Array.isArray(listResult?.data?.adInfos)) truncated = true;
          if (listResult && listResult.data && listResult.data.adInfos) {
            for (const task of listResult.data.adInfos) {
              allTasks.push(parseTask(task, ad, listResult, { accountId: account, sourceAt: new Date().toISOString(), start, end }));
            }
          }
        } catch (e) {
          truncated = true;
          if (e.message === 'cookie_expired') throw e;  // 必须向上抛
          console.log(`[boost-list] 计划 ${ad.id} 追投拉取失败: ${e.message}`);
        }
      }
      return sendJSON(res, {
        ok: true,
        account,
        date_range: `${start} ~ ${end}`,
        metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
        total_tasks: allTasks.length,
        truncated,
        data_valid: !truncated,
        tasks: attachProtection(allTasks, account),
        server_time: new Date().toISOString(),
      });
    } catch (e) {
      console.log(`[boost-list] 拉全部计划失败: ${e.message}`);
      return handleApiError(res, e);
    }
  }

  try {
    const [listResult, summaryResult] = await Promise.all([
      fetchBoostList(adId, start, end, account, listOpts),
      fetchBoostSummary(adId, start, end, account, listOpts).catch(e => {
        console.log(`[boost-list] 汇总拉取失败: ${e.message}`);
        return null;
      }),
    ]);

    if (!listResult || !listResult.data || !listResult.data.adInfos) {
      return sendJSON(res, { ok: false, error: '返回数据异常', raw: listResult }, 500);
    }

    const tasks = attachProtection(listResult.data.adInfos.map(ad => parseTask(ad, { id: adId }, listResult, { accountId: account, sourceAt: new Date().toISOString(), start, end })), account);

    // 状态分组
    const groups = {};
    tasks.forEach(t => {
      const s = t.status || 'unknown';
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    // 汇总
    let summary = null;
    if (summaryResult && summaryResult.data) {
      const tm = summaryResult.data.totalMetrics || {};
      const m = tm.metrics || {};
      summary = {
        total_num: summaryResult.data.totalNum || tasks.length,
        total_cost: metricValueOrNull(m.statCostForRoi2Assist),
        total_gmv: metricValueOrNull(m.totalPayOrderGmvForRoi2Assist),
        total_roi: metricValueOrNull(m.totalPrepayAndPayOrderRoi2Assist),
        metric_roi_basis: { total_roi: 'payment' },
      };
    }

    return sendJSON(res, {
      ok: true,
      ad_id: adId,
      account,
      mar_goal: listOpts.marGoal || 2,
      date_range: `${start} ~ ${end}`,
      metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
      total_tasks: tasks.length,
      truncated: listResult.truncated === true,
      data_valid: listResult.truncated !== true,
      status_groups: Object.entries(groups).map(([status, list]) => ({ status, count: list.length })),
      summary,
      tasks,
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    console.log(`[boost-list] ✗ ${e.message}`);
    return handleApiError(res, e);
  }
}

// 解析单个追投任务，提取投手需要的字段（含 assistAid/anchorId 供下游接口使用）
function parseTask(ad, planInfo, listResult, context = {}) {
  const stats = (listResult.data.adStatsMap && listResult.data.adStatsMap[ad.id] && listResult.data.adStatsMap[ad.id].metrics) || {};
  const assistInfo = ad.assistTaskInfoMap || {};
  const scene2 = assistInfo['2'] || {};
  const op = scene2.operation || {};

  // 历史账户专用说明已从试用包移除。
  // cost_per_hour = 累计消耗 / 已运行小时数（create_time 起算）；无 create_time 或运行 <3 分钟时 null
  let costPerHour = null;
  const ct = ad.createTime ? new Date(String(ad.createTime).replace(' ', 'T')).getTime() : 0;
  if (ct > 0 && stats) {
    const hours = (Date.now() - ct) / 3600000;
    if (hours >= 0.05) {
      const c = metricValueOrNull(stats.statCostForRoi2Assist);
      costPerHour = c == null ? null : (c > 0 ? +(c / hours).toFixed(2) : 0);
    }
  }

  const task = {
    id: ad.id,
    assist_aid: String(ad.id),          // 供 /api/boost-overview 等接口的 assistAid 参数使用
    primary_ad_id: String(planInfo.id),  // 全域计划ID
    anchor_id: ad.anchorId || ad.authorId || (ad.audience && ad.audience.AuthorId) || null, // 主播ID
    name: ad.name,
    status: ad.adDeliveryName,
    passive_stop: isPassiveStop(ad.adDeliveryName), // 系统强停标记（任务预算不足/计划组超出预算/未开播——非手动暂停）
    create_time: ad.createTime,
    smart_bid_type: ad.smartBidType,
    budget: metricValueOrNull(ad.budget) == null ? null : metricValueOrNull(ad.budget) / 100000, // 微转元
    roi_goal: metricValueOrNull(ad.ecpRoi2Goal),
    // ROI 目标口径只来自真实任务/计划元数据；识别不了就明确 unknown。
    // planInfo 只补充任务返回中可能缺失的计划级优化字段，不覆盖任务真值。
    ...attachRoiGoalContract({ ...(planInfo || {}), ...(ad || {}) }),
    // 历史账户专用说明已从试用包移除。
    cost_per_hour: costPerHour,
    // 消耗效果（adStatsMap metrics 用驼峰格式，值是 {value:xxx} 对象）
    cost: metricValueOrNull(stats.statCostForRoi2Assist),
    gmv: metricValueOrNull(stats.totalPayOrderGmvForRoi2Assist),
    roi: metricValueOrNull(stats.totalPrepayAndPayOrderRoi2Assist),
    // 历史账户专用说明已从试用包移除。
    // 注意键名大小写：1h 的 H 大写（Roi21HAssist，实测 adStatsMap 键表）
    net_roi: metricValueOrNull(stats.totalPrepayAndPaySettleRoi21HAssist),
    net_gmv: metricValueOrNull(stats.totalOrderSettleAmountForRoi21HAssist),
    // roi_goal_basis 描述“目标值按什么优化”；这里单独描述实际效果字段，二者禁止混用。
    metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
    settlement_window: { net_roi: '1h' },
    refund_rate_1h: metricValueOrNull(stats.totalRefundOrderGmvForRoi21HRateAssist),
    order_count: metricValueOrNull(stats.totalPayOrderCountForRoi2Assist),
    show_cnt: metricValueOrNull(stats.showCntForRoi2Assist),
    click_cnt: metricValueOrNull(stats.clickCntForRoi2Assist),
    // 操作权限
    can_start: !!(op.start && op.start.editable),
    can_edit: !!(op.edit && op.edit.editable),
    can_delete: !!(op.delete && op.delete.editable),
    can_view_stats: !!(op.statistics && op.statistics.editable),
  };
  return { ...task, ...boostTaskContract(ad, task, context) };
}

module.exports = handleBoostList;
