const fs = require('fs');
const path = require('path');
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
const { defaultAccountId } = require('../lib/api-helpers');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');

// 千川店铺成交三分口径：marketing_goal 1=推商品 2=推直播间，无过滤=全部（已用 07-20 终值逐字段核验）
const SPLIT_DEF = [
  { key: 'all', label: '全部', goal: null },
  { key: 'product', label: '推商品', goal: '1' },
  { key: 'live', label: '推直播间', goal: '2' },
];
const METRICS = [
  'stat_cost_for_roi2',                              // 整体消耗(元)
  'total_prepay_and_pay_settle_roi2_1h',             // 净成交ROI
  'total_order_settle_amount_for_roi2_1h',           // 净成交金额(元)
  'total_order_settle_count_for_roi2_1h',            // 净成交订单数
  'total_order_settle_amount_rate_for_roi2_1h',      // 净成交金额结算率
  'total_refund_order_gmv_for_roi2_1h_rate',         // 1小时内退款率
];

function parseNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[%,\s]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

async function querySplit(date, accountId, goal, trendDim) {
  const { statQuery } = require('../lib/qianchuan');
  const aavid = (QIANCHUAN_ACCOUNTS.find(a => a.id === accountId) || {}).aavid;
  const conds = [
    { Field: 'ignore_zero_dimension', Operator: 7, Values: ['on'] },
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
    { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
    { Field: 'query_self_data', Operator: 7, Values: ['off'] },
  ];
  if (goal) conds.push({ Field: 'marketing_goal', Operator: 7, Values: [goal] });
  const body = {
    reqFrom: 'content_uni_data',
    DataSetKey: 'home_cost_uni_prom',
    Filters: { ConditionRelationshipType: 1, Conditions: conds },
    // 与官方 tab 一致：推商品/推直播间页用 stat_time_hour 维度，可返回逐点序列而不只是 Totals
    Dimensions: [trendDim || 'stat_time_hour'],
    StartTime: date + ' 00:00:00',
    EndTime: date + ' 23:59:59',
    Metrics: METRICS,
    Extra: { refer: 'ecp,7345401917394190374,7345401917394141222,home_cost_uni_prom' },
  };
  const r = await statQuery(body, 3, accountId);
  const sd = r && r.data && r.data.StatsData;
  // 查询失败（限频/网络/异常）必须与"真零"区分：失败标记 unavailable，前端显示获取失败而非 ¥0
  if (!sd) return { unavailable: true };
  const pick = m => ({
    cost: parseNum(m['stat_cost_for_roi2'] && m['stat_cost_for_roi2'].ValueStr),
    roi: parseNum(m['total_prepay_and_pay_settle_roi2_1h'] && m['total_prepay_and_pay_settle_roi2_1h'].ValueStr),
    gmv: parseNum(m['total_order_settle_amount_for_roi2_1h'] && m['total_order_settle_amount_for_roi2_1h'].ValueStr),
    orders: parseNum(m['total_order_settle_count_for_roi2_1h'] && m['total_order_settle_count_for_roi2_1h'].ValueStr),
    settle_rate: parseNum(m['total_order_settle_amount_rate_for_roi2_1h'] && m['total_order_settle_amount_rate_for_roi2_1h'].ValueStr),
    refund_rate: parseNum(m['total_refund_order_gmv_for_roi2_1h_rate'] && m['total_refund_order_gmv_for_roi2_1h_rate'].ValueStr),
  });
  const totals = (sd && sd.Totals) ? pick(sd.Totals) : { cost: 0, roi: 0, gmv: 0, orders: 0, settle_rate: 0, refund_rate: 0 };
  if (!trendDim) return totals;
  const rows = ((sd && sd.Rows) || []).map(row => {
    const dv = row.Dimensions && row.Dimensions[trendDim];
    return { time: String((dv && (dv.ValueStr || dv.Value)) || ''), ...pick(row.Metrics || {}) };
  });
  return { ...totals, trend: rows };
}

// ═══ 乘方商品卡（2026-07-22 探针抓包发现）═══
// 历史账户专用说明已从试用包移除。
// 独立数据集 overall_roi_promotion_post_overview_for_product，过滤条件为乘方页面原生组合。
// 历史账户专用说明已从试用包移除。
const CHENGFANG_METRICS = [
  'stat_cost_for_roi2',                              // 消耗
  'total_prepay_and_pay_settle_overall_roi2_1h',     // 净ROI（乘方口径）
  'total_order_settle_amount_for_roi2_1h',           // 净成交金额
  'total_order_settle_count_for_roi2_1h',            // 净成交订单数
  'total_order_settle_amount_rate_for_roi2_1h',      // 结算率
  'total_refund_order_gmv_for_roi2_1h_rate',         // 退款率
];

async function queryChengfangProduct(date, accountId, trendDim) {
  const { statQuery } = require('../lib/qianchuan');
  const aavid = (QIANCHUAN_ACCOUNTS.find(a => a.id === accountId) || {}).aavid;
  const body = {
    DataSetKey: 'overall_roi_promotion_post_overview_for_product',
    Dimensions: [trendDim || 'stat_time_hour'],
    StartTime: date + ' 00:00:00',
    EndTime: date + ' 23:59:59',
    Metrics: CHENGFANG_METRICS,
    Filters: {
      ConditionRelationshipType: 1,
      Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'pricing_category', Operator: 7, Values: ['2'] },
        { Field: 'marketing_goal', Operator: 7, Values: ['1'] },
        { Field: 'ecp_app_id', Operator: 7, Values: ['1'] },
        { Field: 'campaign_type', Operator: 7, Values: ['1'] },
        { Field: 'adlab_mode', Operator: 7, Values: ['1'] },
        { Field: 'adlab_scene_fork', Operator: 7, Values: ['1'] },
        { Field: 'is_overall_roi', Operator: 7, Values: ['1'] },
      ],
    },
    FilterParams: { promotion_overview: ['1'] },
  };
  const r = await statQuery(body, 3, accountId);
  const sd = r && r.data && r.data.StatsData;
  if (!sd) return { unavailable: true };
  const pick = m => ({
    cost: parseNum(m['stat_cost_for_roi2'] && m['stat_cost_for_roi2'].ValueStr),
    gmv: parseNum(m['total_order_settle_amount_for_roi2_1h'] && m['total_order_settle_amount_for_roi2_1h'].ValueStr),
    orders: parseNum(m['total_order_settle_count_for_roi2_1h'] && m['total_order_settle_count_for_roi2_1h'].ValueStr),
    settle_rate: parseNum(m['total_order_settle_amount_rate_for_roi2_1h'] && m['total_order_settle_amount_rate_for_roi2_1h'].ValueStr),
    refund_rate: parseNum(m['total_refund_order_gmv_for_roi2_1h_rate'] && m['total_refund_order_gmv_for_roi2_1h_rate'].ValueStr),
  });
  const totals = (sd && sd.Totals) ? pick(sd.Totals) : { cost: 0, gmv: 0, orders: 0, settle_rate: 0, refund_rate: 0 };
  if (!trendDim) return totals;
  const rows = ((sd && sd.Rows) || []).map(row => {
    const dv = row.Dimensions && row.Dimensions[trendDim];
    return { time: String((dv && (dv.ValueStr || dv.Value)) || ''), ...pick(row.Metrics || {}) };
  });
  return { ...totals, trend: rows };
}

// 两数据源合并：cost/gmv/orders 加总，roi 重算，settle_rate/refund_rate 按净成交加权；
// 单边获取失败不拖死另一边，标 base_unavailable/cf_unavailable 透出
function mergeSplit(base, extra) {
  const flags = {};
  const b = (base && !base.unavailable) ? base : { cost: 0, roi: 0, gmv: 0, orders: 0, settle_rate: 0, refund_rate: 0 };
  const e = (extra && !extra.unavailable) ? extra : { cost: 0, gmv: 0, orders: 0, settle_rate: 0, refund_rate: 0 };
  if (base && base.unavailable) flags.base_unavailable = true;
  if (extra && extra.unavailable) flags.cf_unavailable = true;
  const cost = +(b.cost + e.cost).toFixed(2);
  const gmv = +(b.gmv + e.gmv).toFixed(2);
  const wavg = (x, y, wx, wy) => (wx + wy) > 0 ? +((x * wx + y * wy) / (wx + wy)).toFixed(2) : 0;
  return {
    cost,
    gmv,
    orders: +(b.orders + e.orders).toFixed(2),
    roi: cost > 0 ? +(gmv / cost).toFixed(2) : 0,
    settle_rate: wavg(b.settle_rate, e.settle_rate, b.gmv, e.gmv),
    refund_rate: wavg(b.refund_rate, e.refund_rate, b.gmv, e.gmv),
    ...flags,
  };
}

// 逐点趋势合并（按 time 对齐加总，roi 重算）
function mergeTrend(baseRows, extraRows) {
  if (!Array.isArray(baseRows) && !Array.isArray(extraRows)) return undefined;
  const byTime = new Map();
  for (const r of [...(baseRows || []), ...(extraRows || [])]) {
    const t = byTime.get(r.time) || { time: r.time, cost: 0, gmv: 0, orders: 0, settle_rate: 0, refund_rate: 0, roi: 0 };
    t.cost += +r.cost || 0; t.gmv += +r.gmv || 0; t.orders += +r.orders || 0;
    byTime.set(r.time, t);
  }
  return [...byTime.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map(t => ({ ...t, cost: +t.cost.toFixed(2), gmv: +t.gmv.toFixed(2), roi: t.cost > 0 ? +(t.gmv / t.cost).toFixed(2) : 0 }));
}

// 终值性判定：千川日数据 T+1，需等到次日晚上 22:30 后才出全（与 server.js 每日 23:00 昨日终值重写同口径）。
// 抓取本地时刻 ≥ date 次日 23:00 才算终值；此前抓的昨日数据未结算全，落盘会把残缺口径永久固化。
function isFetchedFinal(date, fetchedAt) {
  const t = fetchedAt ? new Date(fetchedAt) : new Date();
  if (isNaN(t.getTime())) return false;
  const finalFrom = new Date(date + 'T00:00:00'); // 本地时区解析
  finalFrom.setDate(finalFrom.getDate() + 1);
  finalFrom.setHours(23, 0, 0, 0);
  return t.getTime() >= finalFrom.getTime();
}

/**
 * GET /api/home-split?account=&date=YYYY-MM-DD
 *
 * 店铺成交三分口径（全部/推商品/推直播间），千川 home_cost_uni_prom 按 marketing_goal 拆分。
 * 历史日期落盘缓存（终值不可变）；今天不缓存（实时变动）。
 * 返回：{ ok, account, date, all, product, live, cached, fetched_at }
 *   每个口径：{ label, cost, roi, gmv, orders, settle_rate, refund_rate }
 */
async function handleHomeSplit(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  try {
    const account = url.searchParams.get('account') || url.searchParams.get('accountId') || defaultAccountId();
    const today = getLocalDateStr();
    const yesterday = getLocalDateStr(new Date(Date.now() - 86400000));
    const date = url.searchParams.get('date') || yesterday;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, { ok: false, error: 'date 格式非法' }, 400);
    if (date > today) return sendJSON(res, { ok: false, error: 'date 不能晚于今天' }, 400);
    // 账号必须在已知列表内：否则 querySplit 里 aavid=undefined 会序列化成 [null] 发往千川
    if (!QIANCHUAN_ACCOUNTS.some(a => a.id === account)) return sendJSON(res, { ok: false, error: `未知账号: ${account}` }, 400);
    // trend=hour|day：附带回口径逐点序列（与官方 tab 的 stat_time_hour 维度一致）；day 用于多日对比
    const trendArg = url.searchParams.get('trend');
    const trendDim = trendArg === 'day' ? 'stat_time_day' : trendArg === 'hour' ? 'stat_time_hour' : null;

    // 历史日期：读落盘缓存（trend 请求不走缓存，序列体积大且调用少）
    const cacheFile = path.join(CACHE_DIR, `home_split_${date}_${account}.json`);
    if (!trendDim && date < today && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        // 非终值缓存（次日 23:00 前抓的未结算数据）不认，穿透重拉并在终值后重写——历史已固化的残缺缓存借此自愈
        if (isFetchedFinal(date, cached.fetched_at)) {
          cached.cached = true;
          return sendJSON(res, cached);
        }
      } catch (e) { /* 缓存损坏则重拉 */ }
    }

    const [uniAll, uniProduct, live, cfProduct] = await Promise.all([
      querySplit(date, account, null, trendDim),
      querySplit(date, account, '1', trendDim),
      querySplit(date, account, '2', trendDim),
      queryChengfangProduct(date, account, trendDim),
    ]);
    // 历史账户专用说明已从试用包移除。
    const all = mergeSplit(uniAll, cfProduct);
    const product = mergeSplit(uniProduct, cfProduct);
    if (trendDim) {
      all.trend = mergeTrend(uniAll.trend, cfProduct.trend);
      product.trend = mergeTrend(uniProduct.trend, cfProduct.trend);
    }
    const payload = {
      ok: true, account, date,
      all: { label: '全部', ...all },
      product: { label: '推商品', ...product },
      live: { label: '推直播间', ...live },
      cached: false,
      fetched_at: new Date().toISOString(),
    };
    if (trendDim) payload.trend_dim = trendDim;
    // 历史日期且确有数据：写缓存（全零可能是异常日不写；任一口径获取失败也不写——失败态被永久固化会再也刷不掉；
    // 非终值不写——昨日数据须等次日 23:00 结算全后才允许固化，否则残缺口径永久留存）
    if (!trendDim && date < today && isFetchedFinal(date) && !uniAll.unavailable && !uniProduct.unavailable && !live.unavailable && !cfProduct.unavailable && (all.cost > 0 || all.gmv > 0)) {
      try { fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf-8'); } catch (e) { /* 非关键 */ }
    }
    return sendJSON(res, payload);
  } catch (e) {
    console.error('[home-split] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleHomeSplit;
