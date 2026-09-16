const { metricNumber } = require('./materialMetricFields');
const { AAVID, PAGE_SIZE, MAX_PAGES, CLASSIFICATION } = require('./config');
const { statQuery, statQueryDirect, requestAPI, enqueue, reportRateLimit } = require('./qianchuan');
const { resolveQcAccount, resolveAavid } = require('./cookie');
const { num, toVal } = require('./utils');

const DIMS = [
  { api: 'material_type',       label: '视频类型' },
  { api: 'material_name_v2',    label: '素材名称' },
  { api: 'material_id',         label: '素材ID' },
  { api: 'material_duration_v2',label: '视频时长' },
  { api: 'material_create_time_v2', label: '创建时间' },
  { api: 'material_source_v2',  label: '来源' },
  { api: 'material_tag_list',   label: '标签' },
  { api: 'roi2_material_status', label: '素材状态原始值' },
  { api: 'ad_id',               label: '计划ID' },
  { api: 'ad_name',             label: '计划名称' },
];

// 精简指标清单（26个）——经3个Agent交叉验证 + 页面字段对照补全：
// 覆盖SOP决策节点、经营计算、素材质量评估、流量质量评估
const ALL_METRICS = [
  // ── 基础投放（6个）── 盯盘定级+经营计算核心
  { api: 'stat_cost_for_roi2',                          label: '整体消耗(元)' },
  { api: 'total_prepay_and_pay_order_roi2',             label: '整体支付ROI' },
  { api: 'total_pay_order_gmv_include_coupon_for_roi2', label: '整体成交金额(元)' },
  { api: 'total_pay_order_gmv_for_roi2',                label: '不含券支付金额(元)' },
  { api: 'total_pay_order_count_for_roi2',              label: '整体成交订单数' },
  { api: 'total_cost_per_pay_order_for_roi2',           label: '订单成本' },
  // ── 追投指标（6个）── 追投止损+经营保护分析
  { api: 'stat_cost_for_roi2_assist',                                           label: '追投调控消耗(元)' },
  { api: 'additional_delivery_total_prepay_and_pay_order_roi2_assist',          label: '追投调控支付ROI' },
  { api: 'additional_delivery_total_pay_order_count_for_roi2_assist',           label: '追投调控成交订单数' },
  { api: 'additional_delivery_total_pay_order_gmv_include_coupon_for_roi2_assist', label: '追投调控成交金额(元)' },
  { api: 'additional_delivery_total_pay_order_gmv_for_roi2_assist',             label: '追投调控不含券支付金额(元)' },
  { api: 'additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist',      label: '追投调控1h净ROI' },
  // ── 净成交1h（5个）── 实时盈亏+退款风险+真实获客成本
  { api: 'total_prepay_and_pay_settle_roi2_1h',         label: '1h结算ROI' },
  { api: 'total_order_settle_amount_for_roi2_1h',       label: '1h结算金额' },
  { api: 'total_order_settle_count_for_roi2_1h',        label: '净成交订单数' },
  { api: 'total_refund_order_gmv_for_roi2_1h_rate',     label: '1h退款率' },
  { api: 'additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist', label: '追投调控退款率' },
  // ── 净成交7d（1个）── 衰退判断基准
  { api: 'total_prepay_and_pay_settle_roi2_7d',         label: '7d结算ROI' },
  // ── 流量质量（4个）── 展现→进房点击→转化；CPC 必须使用真实点击口径
  { api: 'live_show_count_for_roi2_v2',                   label: '整体展现次数' },
  { api: 'live_watch_count_for_roi2_v2',                  label: '进房点击次数' },
  { api: 'total_cpc_for_roi2',                            label: '点击单价(元)' },
  { api: 'live_convert_rate_for_roi2_v2',                 label: '整体转化率' },
  // ── 视频互动（6个）── 素材质量评估
  { api: 'video_play_count_for_roi2_v2',    label: '视频播放次数' },
  { api: 'video_avg_watch_duration_for_roi2', label: '视频平均观看时长(s)' },
  { api: 'video_play_finish_rate_for_roi2_v2', label: '视频完播率' },
  { api: 'video_play_duration_3s_rate_for_roi2', label: '3s播放占比' },
  { api: 'video_like_count_for_roi2',        label: '视频点赞数' },
  { api: 'video_comment_count_for_roi2_v2',  label: '视频评论数' },
];

ALL_METRICS.push(
  { api: 'video_play_duration_5s_rate_for_roi2', label: '5s播放占比' },
  { api: 'additional_delivery_total_order_settle_amount_for_roi2_1h_assist', label: '追投调控1h净成交金额(元)' }
);
const METRIC_KEYS = ALL_METRICS.map(m => m.api);
const DIM_API_KEYS = DIMS.map(d => d.api);

function normalizeApiRows(rows) {
  return rows.map(r => {
    const dims = r.Dimensions || {};
    const metrics = r.Metrics || {};
    const row = {};
    DIMS.forEach(d => { row[d.label] = toVal(dims[d.api]); });
    const rawStatus = toVal(dims['roi2_material_status']);
    // 素材状态映射（对齐千川开放平台官方定义）
    // 官方值: DELIVERY_OK=投放中, DELETED=已删除, EXCLUDE=已排除, DELIVERY_NOT=不可投
    // 逆向接口返回的是数字/字符串，需要映射
    const STATUS_MAP = {
      '0': '投放中',
      '1': '投放中',
      '2': '已删除',
      '3': '已排除',
      '4': '不可投',
      'DELIVERY_OK': '投放中',
      'DELETED': '已删除',
      'EXCLUDE': '已排除',
      'DELIVERY_NOT': '不可投',
    };
    row['状态'] = STATUS_MAP[String(rawStatus)] || '未知';
    row['material_status_raw'] = rawStatus;
    row._metric_sources = {};
    ALL_METRICS.forEach(m => {
      row[m.label] = metricNumber(metrics[m.api]);
      row._metric_sources[m.label] = { field: m.api, data_valid: row[m.label] !== null };
    });
    row['净成交金额(元)'] = row['1h结算金额'];
    row['追投调控净成交金额(元)'] = row['追投调控1h净成交金额(元)'];
    row['追投净成交金额(元)'] = row['追投调控1h净成交金额(元)'];
    row['基础消耗(元)'] = row['整体消耗(元)'] != null && row['追投调控消耗(元)'] != null
      ? Math.max(0, row['整体消耗(元)'] - row['追投调控消耗(元)']) : null;
    row['基础成交金额(元)'] = row['整体成交金额(元)'] != null && row['追投调控成交金额(元)'] != null
      ? row['整体成交金额(元)'] - row['追投调控成交金额(元)'] : null;
    return row;
  });
}

// ── 素材分类（基于千川官方标准） ──
// 四字段：_stage（生命周期）、_isQuality（优质标记）、_roiStatus（盈利状态）、_action（操作建议）
// _tags：诊断标签数组

function safeNum(v) { const n = num(v); return Number.isFinite(n) ? n : 0; }
function avg(arr, keyOrFn) {
  if (!arr.length) return 0;
  const vals = typeof keyOrFn === 'function' ? arr.map(keyOrFn) : arr.map(r => safeNum(r[keyOrFn]));
  const sum = vals.reduce((s, v) => s + v, 0);
  return sum / vals.length;
}

/** 计算账户基准线，排除消耗 < 50 元或播放 < 100 的死素材 */
function calcBaselines(rows) {
  const valid = rows.filter(r => {
    const cost = safeNum(r['整体消耗(元)']);
    const views = safeNum(r['视频播放次数']);
    return cost >= CLASSIFICATION.minValidCost && views > CLASSIFICATION.minValidViews;
  });
  if (!valid.length) {
    return { roi: 1.0, cost: CLASSIFICATION.minValidCost, watchTime: 5, completionRate: 10, interactionRate: 1, refundRate: 5, s3Rate: 20 };
  }
  return {
    roi: avg(valid, '整体支付ROI'),
    cost: avg(valid, '整体消耗(元)'),
    watchTime: avg(valid, '视频平均观看时长(s)'),
    completionRate: avg(valid, '视频完播率'),
    interactionRate: avg(valid, r => {
      const views = safeNum(r['视频播放次数']);
      if (views <= 0) return 0;
      return (safeNum(r['视频点赞数']) + safeNum(r['视频评论数'])) / views * 100;
    }),
    refundRate: avg(valid, '1h退款率'),
    s3Rate: avg(valid, '3s播放占比'),
  };
}

/** 判定生命周期 */
function calcStage(row, BASE, NOW) {
  const cost = safeNum(row['整体消耗(元)']);
  const orderCount = safeNum(row['整体成交订单数']);

  let days = 999;
  const ct = row['创建时间'];
  if (ct && ct !== '-') {
    const created = new Date(ct);
    days = Math.max(1, Math.floor((NOW - created) / 86400000));
  }

  // 冷启动：≤3天 或 消耗<300 或 （转化<20 且 创建<7天）
  if (days <= CLASSIFICATION.coldMaxDays || cost < CLASSIFICATION.coldMaxCost) return { stage: 'cold', days };
  if (orderCount < CLASSIFICATION.coldMaxOrders && days <= CLASSIFICATION.coldMaxDaysExtended) return { stage: 'cold', days };
  // 衰退：1h 结算 ROI 远低于 7d 结算 ROI，且仍在消耗（须在 active 短路之前判定，
  // 否则成熟大消耗素材永远不会被判衰退——正是最需要止损的对象）
  const roi1h = safeNum(row['1h结算ROI']);
  const roi7d = safeNum(row['7d结算ROI']);
  if (roi7d > 0 && roi1h > 0 && roi1h < roi7d * CLASSIFICATION.decayRoiRatio && cost >= BASE.cost) {
    return { stage: 'declining', days };
  }

  // 创建≥7天且消耗≥1000，即使订单少也认为已度过冷启动
  if (days >= CLASSIFICATION.activeMinDays && cost >= CLASSIFICATION.activeMinCost) return { stage: 'active', days };

  return { stage: 'active', days };
}

/** 判定盈利状态 */
function calcRoiStatus(row, BASE) {
  const cost = safeNum(row['整体消耗(元)']);
  if (cost < CLASSIFICATION.testingMaxCost) return 'testing';
  const roi = safeNum(row['整体支付ROI']);
  if (roi >= BASE.roi * CLASSIFICATION.roiTargetMultiplier) return 'target_met';
  if (roi >= BASE.roi * CLASSIFICATION.roiUnderperformingMultiplier) return 'underperforming';
  return 'bleeding';
}

/** 判定优质标记（跑量优 + 声画优/互动优） */
function calcIsQuality(row, BASE) {
  const cost = safeNum(row['整体消耗(元)']);
  const views = safeNum(row['视频播放次数']);
  const watchTime = safeNum(row['视频平均观看时长(s)']);
  const completionRate = safeNum(row['视频完播率']);

  // 跑量优：消耗≥100 且 ≥账户均值80%
  const scaleGood = cost >= CLASSIFICATION.qualityMinCost && cost >= BASE.cost * CLASSIFICATION.qualityCostRatio;
  if (!scaleGood) return false;

  // 声画优（用完播/观看时长替代）
  const contentGood = watchTime >= BASE.watchTime || completionRate >= BASE.completionRate;

  // 互动优
  let engageGood = false;
  if (views > 0) {
    const likes = safeNum(row['视频点赞数']);
    const comments = safeNum(row['视频评论数']);
    const interactionRate = (likes + comments) / views * 100;
    engageGood = interactionRate >= BASE.interactionRate;
  }

  // 跑量优 + (声画优 或 互动优) 即算优质
  return contentGood || engageGood;
}

/**
 * 决策矩阵：生命周期 + 盈利状态 + 优质标记 → 投手可直接执行的操作
 *
 * 操作值含义（投手实际执行的动作）：
 * - boost_roi   开控成本追投（给素材设投入产出比目标加预算，有成本保障）
 * - boost_open  开放量追投（不设目标纯加预算跑量，无保障）
 * - pause_boost 关追投（停掉该素材的追投任务）
 * - raise_roi   调高计划目标投入产出比（控成本缩量）
 * - lower_roi   调低计划目标投入产出比（放手跑量）
 * - delist      下架素材（从计划删除该素材）
 * - watch       观察不动（不操作，盯数据）
 */
function determineAction(stage, roiStatus, isQuality, row) {
  if (row['状态'] === '已删除') return 'delist';
  if (stage === 'cold') return 'watch';
  if (stage === 'declining') return 'delist';

  // stage === 'active'
  if (roiStatus === 'bleeding') return 'delist';
  if (roiStatus === 'testing') return 'watch';

  // 达标 → 追投
  if (roiStatus === 'target_met') {
    const boostCost = safeNum(row['追投调控消耗(元)']);
    // 已有追投消耗 → 不重复开，观察
    if (boostCost >= 100) return 'watch';
    // 优质素材 → 控成本追投（有保障）
    if (isQuality) return 'boost_roi';
    // 普通达标 → 放量追投
    return 'boost_open';
  }

  // 略亏 → 调高目标投入产出比控成本
  return 'raise_roi';
}

/** 提取诊断标签 */
function extractTags(row, stage, roiStatus, isQuality, BASE, days) {
  const tags = [];

  // 生命周期
  if (stage === 'cold') tags.push('冷启动中');
  if (stage === 'declining') tags.push('衰退迹象');

  // 优质
  if (isQuality) tags.push('优质素材');

  // 内容诊断
  const s3Rate = safeNum(row['3s播放占比']);
  const views = safeNum(row['视频播放次数']);
  if (s3Rate < BASE.s3Rate * CLASSIFICATION.churnRateWarnRatio && views > CLASSIFICATION.churnRateWarnViews) tags.push('3秒流失严重');
  if (isQuality && roiStatus === 'bleeding') tags.push('叫好不叫座');
  if (!isQuality && roiStatus === 'target_met' && safeNum(row['整体消耗(元)']) >= 100) {
    tags.push('闷声发财');
  }

  // 退款
  const refundRate = safeNum(row['1h退款率']);
  if (refundRate > BASE.refundRate * CLASSIFICATION.refundWarnMultiplier && refundRate > 0) tags.push('高退款风险');

  // 追投
  const boostCost = safeNum(row['追投调控消耗(元)']);
  const boostROI = safeNum(row['追投调控支付ROI']);
  if (boostCost > CLASSIFICATION.boostWarnCost && boostROI > 0 && boostROI < BASE.roi * CLASSIFICATION.boostWarnRoiRatio) tags.push('追投吞利润');
  if (stage === 'active' && roiStatus === 'target_met' && isQuality && boostCost === 0) {
    tags.push('追投潜力股');
  }

  // 跳水
  const roi1h = safeNum(row['1h结算ROI']);
  const roi7d = safeNum(row['7d结算ROI']);
  if (roi7d > 0 && roi1h > 0 && roi1h < roi7d * CLASSIFICATION.declineRoiRatio) tags.push('近期跳水');

  return tags;
}

function enrichRows(rows, startDate, endDate) {
  if (!rows || rows.length === 0) return rows;

  const NOW = new Date();

  // 1. 计算账户动态基准线
  const BASE = calcBaselines(rows);

  // 2. 逐行打标
  rows.forEach(r => {
    const { stage, days } = calcStage(r, BASE, NOW);
    const roiStatus = calcRoiStatus(r, BASE);
    const isQuality = calcIsQuality(r, BASE);

    r._stage = stage;
    r._days = days;
    r._roiStatus = roiStatus;
    r._isQuality = isQuality;

    const cost = safeNum(r['整体消耗(元)']);
    r._netROI = metricNumber(r['1h结算ROI']);

    r._action = determineAction(stage, roiStatus, isQuality, r);
    r._tags = extractTags(r, stage, roiStatus, isQuality, BASE, days);
  });

  return rows;
}

function processRows(rows, startDate, endDate) {
  const normalized = normalizeApiRows(rows);
  return enrichRows(normalized, startDate, endDate);
}

async function fetchAllData(startDate, endDate, accountId, opts = {}) {
  const aavid = resolveAavid(accountId);
  const sq = opts.skipQueue ? statQueryDirect : statQuery;

  const filters = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "adlab_mode_fork", Operator: 7, Values: ["1"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
  ];
  const body = {
    DataSetKey: "roi2_video_material_analysis",
    reqFrom: "roi2_material_list",
    StartTime: startDate + " 00:00:00",
    EndTime: endDate + " 23:59:59",
    Metrics: METRIC_KEYS,
    Dimensions: DIM_API_KEYS,
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
    OrderBy: [{ Type: 2, Field: "stat_cost_for_roi2" }],
  };

  let allRows = [];
  let truncated = false;
  let pageSize = PAGE_SIZE;

  // 第一页串行，拿 TotalCount 确定后续页数
  body.PageParams = { Offset: 0, Limit: pageSize };
  const t0 = Date.now();
  const firstResult = await sq(body, 3, accountId);
  const elapsed0 = Date.now() - t0;
  if (!firstResult) return { rows: [], truncated };
  const firstSd = firstResult.data && firstResult.data.StatsData;
  const firstRows = (firstSd && firstSd.Rows) || [];
  const total = parseInt(firstSd && firstSd.TotalCount) || firstRows.length;
  allRows = allRows.concat(firstRows);
  const totalPages = Math.ceil(total / pageSize);
  const estMs = totalPages > 1 ? Math.round(elapsed0 * totalPages / Math.min(3, totalPages)) : 0;
  console.log(`  [分页] 共${total}条/${totalPages}页 · 第1页${firstRows.length}条 (${elapsed0}ms)${totalPages > 1 ? ` · 预计还需${Math.ceil(estMs/1000)}s` : ''}`);

  if (allRows.length >= total || firstRows.length < pageSize) {
    await appendAigcRows(allRows, startDate, endDate, accountId);
    return { rows: allRows, truncated };
  }

  // 后续页按3页一组并发预取（走 statQuery 内部的 enqueue 限频队列，
  // statQuery 自带 status_code=2 限频重试兜底）
  const remainingPages = Math.min(MAX_PAGES - 1, Math.ceil((total - allRows.length) / pageSize));
  const BATCH = 3;
  for (let batchStart = 0; batchStart < remainingPages; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, remainingPages);
    const promises = [];
    for (let i = batchStart; i < batchEnd; i++) {
      const offset = (i + 1) * pageSize;
      const pageBody = { ...body, PageParams: { Offset: offset, Limit: pageSize } };
      promises.push(sq(pageBody, 3, accountId).catch(e => {
        if (e.message === 'cookie_expired') throw e;
        console.log(`  [分页] 第${i+2}页失败: ${e.message}`);
        return null;
      }));
    }
    const results = await Promise.all(promises);
    let batchRows = 0;
    for (const result of results) {
      if (!result) continue;
      const sd = result.data && result.data.StatsData;
      const rows = (sd && sd.Rows) || [];
      allRows = allRows.concat(rows);
      batchRows += rows.length;
    }
    console.log(`  [分页] 批次 ${batchStart+2}~${batchEnd+1} 页，本批 ${batchRows}条 · 累计 ${allRows.length}/${total}`);
    if (allRows.length >= total) break;
  }

  // AIGC 动态创意集合在 roi2_material_list（无 stat_time_day）下不返回，
  // 在 LIST+stat_time_day 维度下以 material_id=-/-2/null 的聚合行呈现（仅在有消耗的当天返回）。
  // 补充拉取并合成 AIGC::<name> 并入，确保 AIGC 进库（自动回填/前端查询都会走这里）。
  await appendAigcRows(allRows, startDate, endDate, accountId);

  if (allRows.length < total) truncated = true;
  return { rows: allRows, truncated };
}

/**
 * 按素材拉取每日明细数据（新方案，速度快10倍+）
 * 用 roi2_video_material_analysis_promotion 数据集 + stat_time_day 维度
 * 一次请求拿到该素材整个时间段的每日数据
 *
 * @param {string} startDate - 起始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @param {string} accountId - 账号ID
 * @returns {Promise<{rows: array, truncated: boolean}>}
 */
async function fetchAllDataByMaterial(startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);

  // Step 1: 先拉素材列表（只拿素材ID和基本信息，不分日期）
  const listFilters = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "adlab_mode_fork", Operator: 7, Values: ["1"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
  ];
  const listBody = {
    DataSetKey: "roi2_video_material_analysis",
    reqFrom: "roi2_material_list",
    StartTime: startDate + " 00:00:00",
    EndTime: endDate + " 23:59:59",
    Metrics: ["stat_cost_for_roi2"],
    Dimensions: ["material_id", "material_name_v2", "material_type", "material_create_time_v2", "material_source_v2", "material_tag_list", "material_duration_v2", "roi2_material_status"],
    Filters: { ConditionRelationshipType: 1, Conditions: listFilters },
    OrderBy: [{ Type: 2, Field: "stat_cost_for_roi2" }],
  };

  // 拉素材列表（分页）
  let materialList = [];
  let pageSize = PAGE_SIZE;
  listBody.PageParams = { Offset: 0, Limit: pageSize };
  const t0 = Date.now();
  const firstListResult = await statQuery(listBody, 3, accountId);
  if (!firstListResult) return { rows: [], truncated: false };
  const firstListSd = firstListResult.data && firstListResult.data.StatsData;
  const firstListRows = (firstListSd && firstListSd.Rows) || [];
  const totalMaterials = parseInt(firstListSd && firstListSd.TotalCount) || firstListRows.length;
  materialList = materialList.concat(firstListRows);
  console.log(`  [素材列表] 共${totalMaterials}个素材 · 第1页${firstListRows.length}条 (${Date.now()-t0}ms)`);

  // 后续页
  while (materialList.length < totalMaterials) {
    const offset = materialList.length;
    const pageBody = { ...listBody, PageParams: { Offset: offset, Limit: pageSize } };
    const result = await statQuery(pageBody, 3, accountId);
    if (!result) break;
    const sd = result.data && result.data.StatsData;
    const rows = (sd && sd.Rows) || [];
    if (rows.length === 0) break;
    materialList = materialList.concat(rows);
    console.log(`  [素材列表] 累计 ${materialList.length}/${totalMaterials}`);
  }

  if (materialList.length === 0) return { rows: [], truncated: false };

  // 收集 AIGC 动态创意集合信息（material_id 为 '-'/'-2'/null，无逐素材明细）
  const aigcInfos = [];
  const aigcSeenNames = new Set();
  for (const mat of materialList) {
    const rid = mat.Dimensions?.material_id?.ValueStr || mat.Dimensions?.material_id?.Value;
    const isAigcMat = !rid || rid === '-' || rid === '-2';
    if (!isAigcMat) continue;
    const name = mat.Dimensions?.material_name_v2?.ValueStr || mat.Dimensions?.material_name_v2?.Value || '';
    if (aigcSeenNames.has(name)) continue;
    aigcSeenNames.add(name);
    aigcInfos.push({ name, dims: mat.Dimensions || {} });
  }

  // Step 2: 逐个素材拉每日明细
  console.log(`  [每日明细] 开始拉取 ${materialList.length} 个素材的每日数据 (${startDate}~${endDate})`);
  const detailFilters = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
    { Field: "fill_stat_time", Operator: 7, Values: ["on"] },
  ];

  let allRows = [];
  let totalDays = 0;
  const t1 = Date.now();

  for (let i = 0; i < materialList.length; i++) {
    const mat = materialList[i];
    const rawMaterialId = mat.Dimensions?.material_id?.ValueStr || mat.Dimensions?.material_id?.Value;
    // AIGC 动态创意集合无固定 material_id（'-'/'-2'/null），其每日数据在 LIST 数据集
    // (roi2_video_material_analysis + stat_time_day 维度) 中以 material_id=null 的聚合行呈现。
    // promotion 明细按占位 id 过滤会触发千川 ES 后端报错，故跳过逐素材明细，
    // 改由循环结束后的 fetchAigcRows() 用 LIST+stat_time_day 全量查询按 null-id 筛选后合成入库。
    const isAigc = !rawMaterialId || rawMaterialId === '-' || rawMaterialId === '-2';
    if (isAigc) {
      const pct = Math.round(((i + 1) / materialList.length) * 100);
      process.stdout.write(`\r  [每日明细] ${pct}% (${i+1}/${materialList.length}) · 跳过AIGC占位(走聚合)   `);
      continue;
    }
    const materialId = rawMaterialId;

    // 用素材创建日期作为起始时间，避免拉取创建前的空数据
    const createTime = mat.Dimensions?.material_create_time_v2?.ValueStr || '';
    let matStartDate = startDate;
    if (createTime) {
      // 创建时间格式可能是 "2026-05-07 17:34:43" 或 "2026-05-07"
      const m = createTime.match(/(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] > startDate) matStartDate = m[1];
    }
    // 创建时间晚于查询区间结束：该素材在本区间不可能有数据，跳过
    // （否则 StartTime>EndTime 触发千川 status_code=3000「时间格式错误」中断整段回填）
    if (matStartDate > endDate) continue;
    // 窗口天数上界，用于 AIGC 防爆护栏
    const d0 = new Date(matStartDate), d1 = new Date(endDate);
    const expectedDays = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);

    const detailBody = {
      DataSetKey: "roi2_video_material_analysis_promotion",
      StartTime: matStartDate + " 00:00:00",
      EndTime: endDate + " 23:59:59",
      Metrics: METRIC_KEYS,
      Dimensions: ["stat_time_day"],
      Filters: {
        ConditionRelationshipType: 1,
        Conditions: [...detailFilters, { Field: "material_id", Operator: 7, Values: [materialId] }],
      },
      OrderBy: [{ Type: 2, Field: "stat_time_day" }],
    };

    // 分页拉（通常一个素材半年也就几十到一百多天）
    let offset = 0;
    let matTotal = 0;
    let matRows = [];
    let aigcSuspicious = false;
    while (true) {
      detailBody.PageParams = { Offset: offset, Limit: 200 };
      const result = await statQuery(detailBody, 3, accountId);
      if (!result) break;
      const sd = result.data && result.data.StatsData;
      const rows = (sd && sd.Rows) || [];
      if (rows.length === 0) break;
      matTotal = parseInt(sd && sd.TotalCount) || rows.length;

      // 防爆护栏：占位 id 若被接口当成"不过滤"，会返回整个账户流水。
      // 单素材窗口天数上界 = 区间天数*3，超出即判定为账户级脏数据，丢弃本素材。
      if (isAigc && matTotal > expectedDays * 3) aigcSuspicious = true;

      // 给每行补上素材维度信息（因为promotion数据集不返回素材名称等）
      const matDims = mat.Dimensions || {};
      rows.forEach(r => {
        r.Dimensions = r.Dimensions || {};
        // 补充素材信息；AIGC 用合成 id 标记，便于下游识别与去重
        ['material_id', 'material_name_v2', 'material_type', 'material_create_time_v2', 'material_source_v2', 'material_tag_list', 'material_duration_v2', 'roi2_material_status'].forEach(k => {
          if (k === 'material_id') { r.Dimensions[k] = { ValueStr: materialId, Value: materialId }; return; }
          if (!r.Dimensions[k] && matDims[k]) r.Dimensions[k] = matDims[k];
        });
      });

      matRows = matRows.concat(rows);
      offset += rows.length;
      if (offset >= matTotal || rows.length < 200) break;
    }


    // 账户级脏数据护栏：丢弃，避免污染全库
    if (aigcSuspicious) {
      console.log(`\n  [AIGC护栏] 素材 ${materialId} 返回 ${matTotal} 天，疑似账户级脏数据，已丢弃`);
    } else {
      allRows = allRows.concat(matRows);
    }
    totalDays += matTotal;
    const pct = Math.round((i + 1) / materialList.length * 100);
    const elapsed = Date.now() - t1;
    const avg = elapsed / (i + 1);
    const remaining = Math.round(avg * (materialList.length - i - 1) / 1000);
    process.stdout.write(`\r  [每日明细] ${pct}% (${i+1}/${materialList.length}) · ${materialId} ${matTotal}天 · 累计${allRows.length}行 · 剩余${remaining}s   `);
  }

  console.log(`\n  [每日明细] 完成 · 共${allRows.length}行/${totalDays}天 · 耗时${Math.round((Date.now()-t1)/1000)}s`);

  // AIGC 动态创意集合：LIST 数据集 + stat_time_day（不加 material 过滤），
  // 筛选 material_id 为 null/'-'/'-2' 的每日聚合行，合成 AIGC::<name> 后并入。
  if (aigcInfos.length > 0) {
    const aigcRows = await fetchAigcRows(startDate, endDate, accountId, aigcInfos);
    allRows = allRows.concat(aigcRows);
    console.log(`  [AIGC聚合] 并入 ${aigcRows.length} 条 · 共${allRows.length}行`);
  }

  return { rows: allRows, truncated: false, materialList };
}

// AIGC 集合在不同千川接口间素材名不一致（如"视频素材集合" vs "素材集合"），
// 归一化(去"视频"等差异词)后合成统一 id，避免同一集合被拆成多个 id、且与历史 backfill 数据对齐。
function normalizeAigcName(name) {
  return (name || '').replace(/视频/g, '').replace(/\s+/g, '').trim() || 'DYNAMIC';
}

// AIGC 动态创意素材：在 LIST 数据集(roi2_video_material_analysis) + stat_time_day 维度下，
// 以 material_id=null 的每日聚合行呈现。promotion 明细按占位 id('-'/'-2')过滤会触发千川 ES 报错，
// 故直接拉 LIST+stat_time_day 全量(不加 material 过滤)，筛选 null-id 行，按素材名合成 AIGC::<name>。
async function fetchAigcRows(startDate, endDate, accountId, aigcInfos) {
  const aavid = resolveAavid(accountId);
  const adv = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
    { Field: "fill_stat_time", Operator: 7, Values: ["on"] },
  ];
  const dailyBody = {
    DataSetKey: "roi2_video_material_analysis",
    StartTime: startDate + " 00:00:00",
    EndTime: endDate + " 23:59:59",
    Metrics: METRIC_KEYS,
    Dimensions: ["stat_time_day", ...DIM_API_KEYS],
    Filters: { ConditionRelationshipType: 1, Conditions: adv },
    OrderBy: [{ Type: 2, Field: "stat_time_day" }],
  };
  let rows = [];
  let offset = 0;
  while (true) {
    dailyBody.PageParams = { Offset: offset, Limit: 200 };
    const r = await statQuery(dailyBody, 3, accountId);
    if (!r) break;
    const sd = r.data && r.data.StatsData;
    const pageRows = (sd && sd.Rows) || [];
    if (pageRows.length === 0) break;
    for (const row of pageRows) {
      const mid = row.Dimensions?.material_id?.ValueStr ?? row.Dimensions?.material_id?.Value;
      const isNull = !mid || mid === '-' || mid === '-2' || mid === 'null';
      if (!isNull) continue; // 仅保留 AIGC 每日行
      const name = row.Dimensions?.material_name_v2?.ValueStr || row.Dimensions?.material_name_v2?.Value || 'DYNAMIC';
      const synthId = 'AIGC::' + normalizeAigcName(name);
      row.Dimensions = row.Dimensions || {};
      row.Dimensions['material_id'] = { ValueStr: synthId, Value: synthId };
      rows.push(row);
    }
    const total = parseInt(sd && sd.TotalCount) || 0;
    if (offset + pageRows.length >= total || pageRows.length < 200) break;
    offset += pageRows.length;
  }
  return rows;
}

// AIGC 补充：拉取 LIST+stat_time_day 聚合行（material_id=-/-2/null），合成 AIGC::<name> 并入 allRows
async function appendAigcRows(allRows, startDate, endDate, accountId) {
  // 主查询（roi2_material_list，完整 Metrics 时）可能已含 AIGC 行（material_id=-/-2/null），
  // 先就地合成 AIGC::<name>，避免以 '-' 形式重复入库。所有 return 路径都经此函数，去重统一生效。
  for (const r of allRows) {
    const dims = r.Dimensions || {};
    const mid = dims.material_id?.ValueStr ?? dims.material_id?.Value;
    if (!mid || mid === '-' || mid === '-2' || mid === 'null') {
      const name = dims.material_name_v2?.ValueStr || dims.material_name_v2?.Value || 'DYNAMIC';
      const synthId = 'AIGC::' + normalizeAigcName(name);
      dims.material_id = { ValueStr: synthId, Value: synthId };
    }
  }
  try {
    const aigcRows = await fetchAigcRows(startDate, endDate, accountId);
    console.log(`  [AIGC] fetchAigcRows 返回 ${aigcRows.length} 条`);
    if (aigcRows.length > 0) {
      allRows.push(...aigcRows);
      console.log(`  [AIGC] 补充 ${aigcRows.length} 条`);
    }
  } catch (e) {
    if (e.message.includes('cookie_expired')) throw e;
    console.log(`  [AIGC] 补充拉取失败(忽略): ${e.message}`);
  }
}

async function doFetchAndProcess(startDate, endDate, accountId, opts = {}) {
  const fetchResult = await fetchAllData(startDate, endDate, accountId, opts);
  const rows = fetchResult.rows;
  if (!rows || rows.length === 0) return null;
  const processed = processRows(rows, startDate, endDate);
  const activeCount = processed.filter(r => r['状态'] === '投放中').length;
  const deletedCount = processed.filter(r => r['状态'] === '已删除').length;
  return {
    rows: processed.length,
    meta: {
      total: processed.length,
      active: activeCount,
      deleted: deletedCount,
      truncated: fetchResult.truncated
    },
    data: processed,
  };
}

// ═══════════════════════════════════════════════════════════
// 单素材深度数据拉取（秒级留存/人群画像/追投任务/脚本/创意元素）
// ═══════════════════════════════════════════════════════════

/**
 * 拉取素材秒级留存数据（流失人数+观看次数，按秒拆分）
 */
async function fetchInsight(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const baseFilters = {
    ConditionRelationshipType: 1,
    Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'material_id', Operator: 7, Values: [materialId] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
    ],
  };
  const baseBody = {
    DataSetKey: 'roi2_video_material_analysis_insight',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: ['duration'],
    Filters: baseFilters,
  };

  // 流失人数+观看次数（按秒，合并为一次查询）
  const result = await statQuery({ ...baseBody, Metrics: ['video_lose_count_for_roi2', 'live_watch_count_for_roi2_v2'] }, 3, accountId);
  const rows = result?.data?.StatsData?.Rows || [];

  // 整体点击次数：必须从 promotion 数据集取真实汇总（insight 按秒累加会得到“观看·秒”）
  let clickCount = 0;
  try {
    const aavid = resolveAavid(accountId);
    const clickResult = await statQuery({
      DataSetKey: 'roi2_video_material_analysis',
      StartTime: startDate + ' 00:00:00',
      EndTime: endDate + ' 23:59:59',
      Dimensions: [],
      Metrics: ['live_watch_count_for_roi2_v2'],
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'material_id', Operator: 7, Values: [materialId] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      ]},
    }, 3, accountId);
    clickCount = clickResult?.data?.StatsData?.Rows?.[0]?.Metrics?.live_watch_count_for_roi2_v2?.Value || 0;
  } catch {}

  // 整体流失次数（不拆秒，直接取汇总值）
  let dropCount = 0;
  try {
    const dropResult = await statQuery({ ...baseBody, Dimensions: [], Metrics: ['video_lose_count_for_roi2'] }, 3, accountId);
    dropCount = dropResult?.data?.StatsData?.Rows?.[0]?.Metrics?.video_lose_count_for_roi2?.Value || 0;
  } catch {}

  // 流失率（0-5秒区间）
  const rateBody = { ...baseBody, Dimensions: [], Metrics: ['video_user_lose_rate_for_roi2'],
    Filters: { ...baseFilters, Conditions: [...baseFilters.Conditions, { Field: 'duration', Values: ['0', '5'], Operator: 9 }] } };
  let loseRate5s = 0;
  try {
    const rateResult = await statQuery(rateBody, 3, accountId);
    loseRate5s = rateResult?.data?.StatsData?.Rows?.[0]?.Metrics?.video_user_lose_rate_for_roi2?.Value || 0;
  } catch {}

  // 合并成每秒一条
  const bySecond = {};
  rows.forEach(r => {
    const s = r.Dimensions?.duration?.ValueStr;
    if (s != null) {
      bySecond[s] = {
        second: parseInt(s),
        loseCount: r.Metrics?.video_lose_count_for_roi2?.Value || 0,
        watchCount: r.Metrics?.live_watch_count_for_roi2_v2?.Value || 0,
      };
    }
  });

  return {
    totalSeconds: Object.keys(bySecond).length,
    loseRate5s,
    clickCount,
    dropCount,
    seconds: Object.values(bySecond).sort((a, b) => a.second - b.second),
  };
}

/**
 * 拉取素材人群画像（5个维度×3个指标）
 */
async function fetchCrowd(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const dims = ['gender', 'age', 'province_name', 'city_name', 'user_group_label_name'];
  const metrics = ['live_show_count_for_roi2_v2', 'live_watch_count_for_roi2_v2', 'total_pay_order_gmv_include_coupon_for_roi2'];
  const result = {};

  for (const dim of dims) {
    result[dim] = {};
    metrics.forEach(m => { result[dim][m] = []; });
    // 3个指标合并为一次查询（原实现逐指标查询，15次/素材，是深度拉取的最大瓶颈）
    const body = {
      DataSetKey: 'roi2_video_material_analysis_crow',
      StartTime: startDate + ' 00:00:00',
      EndTime: endDate + ' 23:59:59',
      Dimensions: [dim],
      Metrics: metrics,
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'material_id', Operator: 7, Values: [materialId] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      ]},
      OrderBy: [{ Type: 2, Field: metrics[0] }],
      PageParams: { Offset: 0, Limit: 500 },
    };
    try {
      const r = await statQuery(body, 3, accountId);
      const rows = r?.data?.StatsData?.Rows || [];
      for (const row of rows) {
        const label = row.Dimensions?.[dim]?.ValueStr || '';
        for (const met of metrics) {
          result[dim][met].push({ label, value: row.Metrics?.[met]?.Value || 0 });
        }
      }
    } catch {
      // 该维度查询失败，3个指标均保持空数组
    }
  }

  return result;
}

/**
 * 拉取素材追投任务明细
 */
async function fetchBoostTasks(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const metrics = [
    'additional_delivery_stat_cost_for_roi2_assist',
    'additional_delivery_total_prepay_and_pay_order_roi2_assist',
    'additional_delivery_total_pay_order_gmv_for_roi2_assist',
    'additional_delivery_total_pay_order_count_for_roi2_assist',
    'additional_delivery_show_cnt_for_roi2_assist',
    'additional_delivery_click_cnt_for_roi2_assist',
    'additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist',
    'additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist',
  ];
  const body = {
    DataSetKey: 'roi2_video_material_task_analysis_detail',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: ['assist_aid', 'assist_name', 'assist_start_time'],
    Metrics: metrics,
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'material_id', Operator: 7, Values: [materialId] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'material_type', Operator: 7, Values: ['3'] },
      { Field: 'assist_task_scene', Operator: 7, Values: ['2'] },
      { Field: 'roi2_project_scene', Operator: 7, Values: ['2'] },
    ]},
    OrderBy: [{ Type: 2, Field: 'additional_delivery_stat_cost_for_roi2_assist' }],
    PageParams: { Offset: 0, Limit: 200 },
  };
  try {
    const r = await statQuery(body, 3, accountId);
    const rows = r?.data?.StatsData?.Rows || [];
    return rows.map(row => ({
      assistAid: row.Dimensions?.assist_aid?.ValueStr || '',
      assistName: row.Dimensions?.assist_name?.ValueStr || '',
      assistStartTime: row.Dimensions?.assist_start_time?.ValueStr || '',
      cost: row.Metrics?.additional_delivery_stat_cost_for_roi2_assist?.Value || 0,
      roi: row.Metrics?.additional_delivery_total_prepay_and_pay_order_roi2_assist?.Value || 0,
      gmv: row.Metrics?.additional_delivery_total_pay_order_gmv_for_roi2_assist?.Value || 0,
      orders: row.Metrics?.additional_delivery_total_pay_order_count_for_roi2_assist?.Value || 0,
      shows: row.Metrics?.additional_delivery_show_cnt_for_roi2_assist?.Value || 0,
      clicks: row.Metrics?.additional_delivery_click_cnt_for_roi2_assist?.Value || 0,
      settleRoi: row.Metrics?.additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist?.Value || 0,
      refundRate: row.Metrics?.additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist?.Value || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * 拉取AI脚本拆解（内容公式+脚本文案）
 * 需要vid（视频URI），从创意元素拆解接口获取
 */
async function fetchScript(vid, accountId) {
  const aavid = resolveAavid(accountId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await enqueue(() => requestAPI('GET', `/ad/api/data/v1/material-analysis/getContentFormulaAndScript?vid=${vid}&aavid=${aavid}`, null, accountId), accountId);
      if (r && r.status_code === 0 && r.data && r.data.text) {
        const d = r.data;
        return {
          text: d.text || '',
          formula: (d.data || []).map(f => ({
            category: f.level_1_label?.label || '',
            tags: (f.level_2_labels || []).map(t => t.label),
          })),
          details: Object.entries(d.detail || {}).map(([k, v]) => ({
            tagId: k,
            label: v.label,
            segments: v.list || [],
          })),
        };
      }
      if (r && r.status_code === 2) { reportRateLimit(accountId); console.log('  [脚本] 限频，等15s重试'); await new Promise(res => setTimeout(res, 15000)); continue; }
      if (r && r.status_code === 0 && (!r.data || !r.data.text)) {
        return null;
      }
    } catch (e) {
      console.log('  [脚本] 异常:', e.message);
    }
  }
  return null;
}

/**
 * 拉取创意元素拆解（我的标签 vs 行业Top标签）
 */
async function fetchCreativeAnalysis(materialId, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    material_id: materialId,
    p_date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    period_type: 30,
    assist_type: 3,
    assist_video_type: 2,
    aavid,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await enqueue(() => requestAPI('POST', `/ad/api/data/v1/material-analysis/getContentMaterialAnalysisInfo?aavid=${aavid}`, body, accountId), accountId);
      if (r && r.status_code === 0) {
        const d = r.data || {};
        return {
          materialUri: d.material_uri || '',
          title: d.title || '',
          cost: d.cost || 0,
          ctr: d.ctr || 0,
          roi: d.roi || 0,
          gmv: d.gmv || 0,
          playOverRate: d.play_over_rate || 0,
          statusLifetime: d.status_lifetime || 0,
          myTags: (d.my_tag_entry || []).map(t => ({
            type: t.material_tag_type,
            label: t.tag_label,
            tags: (t.tag_name_list || []).map(x => x.text || x),
          })),
          benchTags: (d.bench_tag_entry || []).map(t => ({
            type: t.material_tag_type,
            label: t.tag_label,
            tags: (t.tag_name_list || []).map(x => x.text || x),
          })),
        };
      }
      if (r && r.status_code === 2) { reportRateLimit(accountId); console.log('  [创意] 限频，等15s重试'); await new Promise(r => setTimeout(r, 15000)); continue; }
    } catch (e) {
      console.log('  [创意] 异常:', e.message);
    }
  }
  return null;
}

module.exports = {
  DIMS,
  ALL_METRICS,
  METRIC_KEYS,
  DIM_API_KEYS,
  processRows,
  normalizeApiRows,
  enrichRows,
  fetchAllData,
  fetchAllDataByMaterial,
  doFetchAndProcess,
  fetchInsight,
  fetchCrowd,
  fetchBoostTasks,
  fetchScript,
  fetchCreativeAnalysis,
};
