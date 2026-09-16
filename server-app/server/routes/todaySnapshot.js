const { doFetchAndProcess, enrichRows } = require('../lib/data');
const { getBaselineForToday, updateLifecyclePhase } = require('../lib/db');
const { attachLifecycle } = require('../lib/lifecycle');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr, formatDate, num } = require('../lib/utils');
const { createTTLCache } = require('../lib/cache');
const { defaultAccountId } = require('../lib/api-helpers');

const memCache = createTTLCache(30 * 1000); // 实时数据缓存 30s（与其他路由一致）
const baselineCache = createTTLCache(24 * 60 * 60 * 1000); // 30天历史baseline缓存 24小时（每天23:00回填后才变）

// 操作建议中文名（投手可直接执行的动作）
const ACTION_NAMES = {
  boost_roi:   '开控成本追投',   // 给素材设投入产出比目标加预算，有成本保障
  boost_open:  '开放量追投',     // 不设目标纯加预算跑量，无保障
  pause_boost: '关追投',         // 停掉该素材的追投任务
  raise_roi:   '调高目标投入产出比', // 控成本缩量
  lower_roi:   '调低目标投入产出比', // 放手跑量
  delist:      '下架素材',       // 从计划删除该素材
  watch:       '观察不动',       // 不操作，盯数据
};

function getWindowDates() {
  const today = getLocalDateStr();
  const todayDate = new Date(`${today}T00:00:00`);
  const yesterdayDate = new Date(todayDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const start30Date = new Date(todayDate);
  start30Date.setDate(start30Date.getDate() - 30);
  return {
    today,
    yesterday: formatDate(yesterdayDate),
    start30: formatDate(start30Date),
  };
}

// 获取baseline（带5分钟缓存，避免每次都查30天库）
function getBaselineWithCache(account) {
  const cached = baselineCache.get(account);
  if (cached) {
    return cached;
  }
  const { today, yesterday, start30 } = getWindowDates();
  const data = getBaselineForToday(today, account);
  baselineCache.set(account, data);
  return data;
}

function computeAverages(hist) {
  const cost30 = hist.reduce((s, r) => s + num(r.cost), 0);
  const gmv30 = hist.reduce((s, r) => s + num(r.gmv), 0);
  const netGmv30 = hist.reduce((s, r) => s + num(r.net_gmv), 0);
  const basicCost30 = hist.reduce((s, r) => s + num(r.basic_cost), 0);
  const baseNetGmv30 = hist.reduce((s, r) => s + num(r.net_gmv) - num(r.additional_net_gmv), 0);
  const orders30 = hist.reduce((s, r) => s + num(r.orders), 0);

  const last7 = hist.slice(-7);
  const cost7 = last7.reduce((s, r) => s + num(r.cost), 0);
  const gmv7 = last7.reduce((s, r) => s + num(r.gmv), 0);
  const netGmv7 = last7.reduce((s, r) => s + num(r.net_gmv), 0);
  const basicCost7 = last7.reduce((s, r) => s + num(r.basic_cost), 0);
  const baseNetGmv7 = last7.reduce((s, r) => s + num(r.net_gmv) - num(r.additional_net_gmv), 0);
  const orders7 = last7.reduce((s, r) => s + num(r.orders), 0);

  const len7 = last7.length || 1;
  const len30 = hist.length || 1;
  return {
    avgCost7d: cost7 / len7,
    avgRoi7d: cost7 > 0 ? gmv7 / cost7 : 0,
    avgNetRoi7d: cost7 > 0 ? netGmv7 / cost7 : 0,
    avgBaseNetRoi7d: basicCost7 > 0 ? baseNetGmv7 / basicCost7 : 0,
    avgOrders7d: orders7 / len7,
    avgCost30d: cost30 / len30,
    avgRoi30d: cost30 > 0 ? gmv30 / cost30 : 0,
    avgNetRoi30d: cost30 > 0 ? netGmv30 / cost30 : 0,
    avgBaseNetRoi30d: basicCost30 > 0 ? baseNetGmv30 / basicCost30 : 0,
    avgOrders30d: orders30 / len30,
  };
}

async function fetchTodaySnapshotData(account = defaultAccountId()) {
  const cached = memCache.get(account);
  if (cached) {
    return { ...cached, _fromCache: true };
  }

  if (!isCookieProbablyValid(readQcCookie(account))) {
    throw new Error('cookie_expired');
  }

  const { today, yesterday, start30 } = getWindowDates();

  // baseline（30天历史，带5分钟缓存）、today 素材明细、today 账户汇总 并行拉取
  // skipQueue: true 绕过限频队列直接调千川API，避免被 liveCollector 轮询堵塞
  // 失败不兜底，直接抛错让调用方知道接口挂了
  const { runFetchOverview } = require('../lib/browser');
  const [baseline, liveResult, overviewResult] = await Promise.all([
    Promise.resolve().then(() => getBaselineWithCache(account)),
    doFetchAndProcess(today, today, account, { skipQueue: true }),
    runFetchOverview(today, today, account, { skipQueue: true }),
  ]);

  const baseAggregates = baseline.aggregates;
  const histories = baseline.histories;

  const accountCostBase = baseAggregates.reduce((s, r) => s + num(r['整体消耗(元)']), 0);
  const accountGmvBase = baseAggregates.reduce((s, r) => s + num(r['整体成交金额(元)']), 0);
  // 对 baseline 数据调用 enrichRows，生成 _stage/_action/_roiStatus 等分类字段
  // 这样 tier/role 可以用 30天基线的分类（而非单日数据），更准确
  enrichRows(baseAggregates, start30, yesterday);

  // 为 baseline rows 补充 7 天净 ROI，供 reconcileActionByLifecycle 做 volume 准入校验
  baseAggregates.forEach(r => {
    const hist = histories[r['素材ID']] || [];
    const last7 = hist.slice(-7);
    const cost7 = last7.reduce((s, h) => s + num(h.cost), 0);
    const netGmv7 = last7.reduce((s, h) => s + num(h.net_gmv), 0);
    r._avgNetRoi7d = cost7 > 0 ? netGmv7 / cost7 : 0;
  });

  attachLifecycle(baseAggregates, histories, start30, yesterday, { cost: accountCostBase, gmv: accountGmvBase });

  const baseMap = new Map();
  baseAggregates.forEach(r => baseMap.set(r['素材ID'], r));

  const liveRows = (liveResult && liveResult.data) || [];

  // 账户级汇总：overview（home_cost_uni_prom，跟千川首页一致）
  const ov = overviewResult?.kpi_raw || {};
  const parseNum = (s) => parseFloat(String(s || '').replace(/[%,]/g, '')) || 0;
  const accountCostToday = parseNum(ov['整体消耗(元)']);
  const accountGmvToday = accountCostToday > 0 && parseNum(ov['整体支付ROI']) > 0
    ? accountCostToday * parseNum(ov['整体支付ROI']) : 0;
  const accountNetGmvToday = parseNum(ov['净成交金额(元)']);
  const accountRoiToday = parseNum(ov['整体支付ROI']);
  const accountNetRoiToday = parseNum(ov['净成交ROI']);
  const accountOrdersToday = parseNum(ov['净成交订单数']);
  // basicCost / additionalNetGmv overview 不提供，从素材加总
  const accountBasicCostToday = liveRows.reduce((s, r) => s + num(r['基础消耗(元)']), 0);
  const accountAdditionalNetGmvToday = liveRows.reduce((s, r) => s + num(r['追投净成交金额(元)']), 0);
  const accountBaseNetRoiToday = accountBasicCostToday > 0
    ? (accountNetGmvToday - accountAdditionalNetGmvToday) / accountBasicCostToday
    : 0;

  const rows = [];
  liveRows.forEach(r => {
    if (r['状态'] === '已删除') return;

    const id = r['素材ID'];
    const base = baseMap.get(id) || {};
    const hist = histories[id] || [];
    const avgs = computeAverages(hist);

    const todayCost = num(r['整体消耗(元)']);
    const todayGmv = num(r['整体成交金额(元)']);
    const todayNetGmv = num(r['净成交金额(元)']);
    const todayBasicCost = num(r['基础消耗(元)']);
    const todayAdditionalCost = num(r['追投调控消耗(元)']);
    const todayAdditionalNetGmv = num(r['追投净成交金额(元)']);
    const todayOrders = num(r['整体成交订单数']);
    const todayROI = todayCost > 0 ? todayGmv / todayCost : 0;
    const todayNetROI = todayCost > 0 ? todayNetGmv / todayCost : 0;
    const todayBaseNetROI = todayBasicCost > 0
      ? (todayNetGmv - todayAdditionalNetGmv) / todayBasicCost
      : 0;

    avgs.spendRatioTodayVs7d = avgs.avgCost7d > 0 ? todayCost / avgs.avgCost7d : 0;
    avgs.roiRatioTodayVs7d = avgs.avgRoi7d > 0 && todayROI > 0 ? todayROI / avgs.avgRoi7d : 0;
    avgs.netRoiRatioTodayVs7d = avgs.avgNetRoi7d > 0 && todayNetROI > 0 ? todayNetROI / avgs.avgNetRoi7d : 0;
    avgs.baseNetRoiRatioTodayVs7d = avgs.avgBaseNetRoi7d > 0 && todayBaseNetROI > 0
      ? todayBaseNetROI / avgs.avgBaseNetRoi7d
      : 0;

    rows.push({
      materialId: id,
      materialName: r['素材名称'] || base['素材名称'] || '',
      createdAt: r['创建时间'] || base['创建时间'] || '',
      status: r['状态'],
      todayCost,
      todayROI,
      todayNetGmv,
      todayNetROI,
      todayBasicCost,
      todayAdditionalCost,
      todayAdditionalNetGmv,
      todayBaseNetROI,
      todayOrders,
      todayRefundRate: num(r['1h退款率']),
      ...avgs,
      lifecycle: base._lifecycle || 'stable',
      lifecycleName: base._lifecycleName || '稳定期',
      lifecycleClass: base._lifecycleClass || 'phase-stable',
      decaySignals: base._decaySignals || {},
      isSeeding: !!(base._isSeeding || r._action === 'boost_roi' || r._action === 'boost_open'),
      // tier/role 优先用 baseline（30天基线）的分类，live 数据只填空
      // 原因：单日消耗通常 < 300，直接用 live 算 stage 几乎全是 cold/watch
      role: base._action || r._action || 'watch',
      roleName: ACTION_NAMES[base._action || r._action || 'watch'] || '观察不动',
      tier: base._stage || r._stage || 'active',
      ageDays: base._ageDays || r._days || 1,
    });

    // 把今天的生命周期阶段写回历史库，便于后续回溯
    if (today && base._lifecycle) {
      updateLifecyclePhase(id, today, base._lifecycle, account);
    }
  });

  // 风险告警：投手一眼看到该关注什么
  const riskAlerts = [];
  if (accountNetRoiToday < 1.0 && accountCostToday > 100) {
    riskAlerts.push({ level: 'danger', msg: `账号今日净ROI=${accountNetRoiToday.toFixed(2)}，低于1.0正在亏损！消耗${accountCostToday.toFixed(0)}元，净成交仅${accountNetGmvToday.toFixed(0)}元` });
  } else if (accountNetRoiToday < 1.5 && accountCostToday > 500) {
    riskAlerts.push({ level: 'warn', msg: `账号今日净ROI=${accountNetRoiToday.toFixed(2)}，低于目标1.5，注意控成本` });
  }

  // 空耗素材（消耗>50且0成交）
  const noConversionWarns = rows
    .filter(r => r.todayCost > 50 && r.todayOrders === 0)
    .sort((a, b) => b.todayCost - a.todayCost)
    .slice(0, 5);
  if (noConversionWarns.length > 0) {
    riskAlerts.push({ level: 'warn', msg: `${noConversionWarns.length}个素材消耗>50元但0成交（最高: ${noConversionWarns[0].materialName} ${noConversionWarns[0].todayCost.toFixed(0)}元）`, materials: noConversionWarns.map(r => r.materialName) });
  }

  // 高退款素材
  const highRefundWarns = rows
    .filter(r => r.todayRefundRate > 15 && r.todayCost > 30)
    .sort((a, b) => b.todayRefundRate - a.todayRefundRate)
    .slice(0, 3);
  if (highRefundWarns.length > 0) {
    riskAlerts.push({ level: 'warn', msg: `${highRefundWarns.length}个素材退款率>15%`, materials: highRefundWarns.map(r => `${r.materialName}(${r.todayRefundRate.toFixed(1)}%)`) });
  }

  // 高消耗占比低ROI素材：消耗占账户>10%且净ROI<1.0（拖累账户的元凶）
  const highSpendLowRoi = rows
    .filter(r => r.todayCost > 0 && accountCostToday > 0 && (r.todayCost / accountCostToday) > 0.10 && r.todayNetROI < 1.0)
    .sort((a, b) => b.todayCost - a.todayCost)
    .slice(0, 5);
  if (highSpendLowRoi.length > 0) {
    riskAlerts.push({
      level: 'danger',
      msg: `${highSpendLowRoi.length}个高消耗素材净ROI<1.0拖累账户（${highSpendLowRoi.map(r => `${r.materialName}(消耗${r.todayCost.toFixed(0)}元,净ROI${r.todayNetROI.toFixed(2)})`).join('、')}）`,
      materials: highSpendLowRoi.map(r => r.materialName),
    });
  }

  const result = {
    ok: true,
    today,
    account: {
      cost: accountCostToday,
      gmv: accountGmvToday,
      roi: accountRoiToday,
      netGmv: accountNetGmvToday,
      netRoi: accountNetRoiToday,
      basicCost: accountBasicCostToday,
      baseNetRoi: accountBaseNetRoiToday,
      orders: accountOrdersToday || 0,
      data_source: 'home_cost_uni_prom',
    },
    riskAlerts,
    rows,
    server_time: new Date().toISOString(),
  };

  memCache.set(account, result);
  return result;
}

function handleTodaySnapshot(req, res, url) {
  const account = url.searchParams.get('account') || defaultAccountId();
  (async () => {
    try {
      const result = await fetchTodaySnapshotData(account);
      const { _fromCache, ...payload } = result;
      return sendJSON(res, { ...payload, from_cache: _fromCache || false, account_id: account });
    } catch (e) {
      if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
      console.error('[today-snapshot] ✗', e.message);
      console.error('[today-snapshot] stack:', e.stack || 'N/A');
      console.error('[today-snapshot] type:', e.constructor && e.constructor.name || typeof e);
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  })().catch(err => {
    console.error(`[todaySnapshot] 未捕获异常: ${err.message}`, err);
    if (!res.headersSent) sendJSON(res, { error: 'internal_server_error', message: err.message }, 500);
  });
}

module.exports = { handleTodaySnapshot, fetchTodaySnapshotData };
