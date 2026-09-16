'use strict';

// 已退出在线服务；仅供 scripts/backtest_mhs_v3.js 离线对照，不参与盯盘或写操作。
// 当前阶段使用同账户相对基线与真实边际窗口，尚未用历史动作结果做概率校准。

const MHS_V3_SHADOW_ALGORITHM = Object.freeze({
  family: 'MHS Shadow',
  version: '3.0.0-shadow.2',
  stage: 'account_relative_prior',
  shadow_only: true,
  outcome_horizon_minutes: 30,
  objective: 'material_profitability_and_scale_response',
  auction_proxy: 'observed_ctr_x_conversion_x_net_aov_with_plan_roi_diagnostic',
  roi_position: 'denominator',
  platform_rank_score_claimed: false,
  statistical_treatment: 'leave_one_out_account_prior_with_sparse_sample_shrinkage',
  organic_uplift: 'not_modeled_without_separate_traffic_data',
});

const WINDOW_WEIGHTS = Object.freeze({ 5: 0.50, 15: 0.30, 60: 0.20 });
const REJECTED_WINDOW_QUALITY = new Set(['stale', 'unavailable', 'conflicted', 'backfilled', 'offline']);
const PRIOR_STRENGTHS = Object.freeze({ ctr_impressions: 300, conversion_clicks: 20, net_aov_orders: 3 });
const SCALE_GATES = Object.freeze({ delivery_evidence: 0.35, economics_evidence: 0.50 });

function finite(value) {
  return value != null && value !== '' && Number.isFinite(+value) ? +value : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function normalizePercent(value) {
  const n = finite(value);
  if (n == null || n < 0) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function computeConversionBenchmark(rows) {
  let weightedRate = 0;
  let clickWeight = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const rate = normalizePercent(row && (row.convert_rate != null ? row.convert_rate : row.conversion_rate));
    const clicks = Math.max(0, finite(row && row.clicks) || 0);
    if (rate == null || clicks <= 0) continue;
    weightedRate += rate * clicks;
    clickWeight += clicks;
  }
  return clickWeight > 0 ? weightedRate / clickWeight : null;
}

function computeNetAovBenchmark(rows) {
  let netGmv = 0;
  let orders = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const valid = row && (row.net_data_valid === true || +row.net_data_valid === 1);
    const rowOrders = Math.max(0, finite(row && row.orders) || 0);
    const rowNetGmv = finite(row && (row.net_gmv_1h != null ? row.net_gmv_1h : row.netGmv1h));
    if (!valid || rowNetGmv == null || rowOrders <= 0) continue;
    netGmv += rowNetGmv;
    orders += rowOrders;
  }
  return orders > 0 ? netGmv / orders : null;
}

function auditDeliveryTelemetry(row = {}) {
  const cost = Math.max(0, finite(row.cost != null ? row.cost : row.spend) || 0);
  const shows = finite(row.shows);
  const clicks = finite(row.clicks);
  const orders = Math.max(0, finite(row.orders) || 0);
  const reportedCtr = normalizePercent(row.click_rate != null ? row.click_rate : row.ctr);
  const reportedConversion = normalizePercent(
    row.convert_rate != null ? row.convert_rate : row.conversion_rate,
  );
  const issues = [];

  const countPairValid = shows != null && shows > 0 && clicks != null && clicks >= 0 && clicks <= shows;
  if (cost > 0 && !(shows > 0)) issues.push('PAID_EXPOSURE_TELEMETRY_MISSING');
  if (shows != null && clicks != null && (clicks < 0 || clicks > shows)) {
    issues.push('CLICK_TELEMETRY_INCONSISTENT');
  }
  if (orders > 0 && !(clicks > 0)) issues.push('ATTRIBUTED_ORDER_NOT_CLICK_ALIGNED');
  if (reportedCtr != null && reportedCtr > 100) issues.push('CTR_RATE_OUT_OF_RANGE');
  if (reportedConversion != null && reportedConversion > 100) issues.push('CONVERSION_RATE_OUT_OF_RANGE');

  const ctrPct = countPairValid ? clicks / shows * 100 : null;
  const conversionPct = clicks > 0 && reportedConversion != null && reportedConversion <= 100
    ? reportedConversion
    : null;
  const usableFactorCount = [ctrPct, conversionPct].filter(Number.isFinite).length;
  return {
    status: issues.length
      ? 'conflicted'
      : (usableFactorCount === 2 ? 'complete' : (usableFactorCount ? 'partial' : 'unavailable')),
    ctr_usable: Number.isFinite(ctrPct),
    conversion_usable: Number.isFinite(conversionPct),
    count_derived_ctr_pct: ctrPct,
    reported_ctr_pct: reportedCtr != null && reportedCtr <= 100 ? reportedCtr : null,
    reported_conversion_pct: reportedConversion != null && reportedConversion <= 100 ? reportedConversion : null,
    issues,
  };
}

function computeDeliveryBenchmarkTotals(rows) {
  const totals = {
    material_count: 0,
    shows: 0,
    clicks: 0,
    conversion_clicks: 0,
    conversion_weighted_pct: 0,
    net_orders: 0,
    net_gmv: 0,
  };
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row) continue;
    totals.material_count += 1;
    const telemetry = auditDeliveryTelemetry(row);
    const shows = telemetry.ctr_usable ? Math.max(0, finite(row.shows) || 0) : 0;
    const clicks = telemetry.ctr_usable ? Math.max(0, finite(row.clicks) || 0) : 0;
    const conversionPct = telemetry.conversion_usable ? telemetry.reported_conversion_pct : null;
    totals.shows += shows;
    totals.clicks += clicks;
    if (conversionPct != null && clicks > 0) {
      totals.conversion_clicks += clicks;
      totals.conversion_weighted_pct += conversionPct * clicks;
    }
    const valid = row.net_data_valid === true || +row.net_data_valid === 1;
    const orders = Math.max(0, finite(row.orders) || 0);
    const netGmv = finite(row.net_gmv_1h != null ? row.net_gmv_1h : row.netGmv1h);
    if (valid && orders > 0 && netGmv != null) {
      totals.net_orders += orders;
      totals.net_gmv += netGmv;
    }
  }
  return totals;
}

function boostCostShare(row = {}) {
  const cost = Math.max(0, finite(row.cost != null ? row.cost : row.spend) || 0);
  const boostCost = Math.max(0, finite(row.boost_cost != null ? row.boost_cost : row.boostCost) || 0);
  return cost > 0 ? clamp01(boostCost / cost) : 0;
}

function deliveryCohort(row = {}) {
  return boostCostShare(row) > 0.10 ? 'boost_influenced' : 'main_plan_dominant';
}

function peerDeliveryBenchmarks(totals, row = {}) {
  const telemetry = auditDeliveryTelemetry(row);
  const rowShows = telemetry.ctr_usable ? Math.max(0, finite(row.shows) || 0) : 0;
  const rowClicks = telemetry.ctr_usable ? Math.max(0, finite(row.clicks) || 0) : 0;
  const rowConversionPct = telemetry.conversion_usable ? telemetry.reported_conversion_pct : null;
  const rowValid = row.net_data_valid === true || +row.net_data_valid === 1;
  const rowOrders = rowValid ? Math.max(0, finite(row.orders) || 0) : 0;
  const rowNetGmv = rowValid
    ? finite(row.net_gmv_1h != null ? row.net_gmv_1h : row.netGmv1h)
    : null;
  const shows = Math.max(0, (finite(totals && totals.shows) || 0) - rowShows);
  const clicks = Math.max(0, (finite(totals && totals.clicks) || 0) - rowClicks);
  const conversionClicks = Math.max(
    0,
    (finite(totals && totals.conversion_clicks) || 0) - (rowConversionPct != null ? rowClicks : 0),
  );
  const conversionWeightedPct = Math.max(
    0,
    (finite(totals && totals.conversion_weighted_pct) || 0) -
      (rowConversionPct != null ? rowConversionPct * rowClicks : 0),
  );
  const netOrders = Math.max(0, (finite(totals && totals.net_orders) || 0) - rowOrders);
  const netGmv = Math.max(0, (finite(totals && totals.net_gmv) || 0) - (rowNetGmv || 0));
  return {
    method: 'leave_one_material_out_current_account_snapshot',
    peer_material_count: Math.max(0, (finite(totals && totals.material_count) || 0) - 1),
    ctr_pct: shows > 0 ? clicks / shows * 100 : null,
    ctr_trials: shows,
    conversion_pct: conversionClicks > 0 ? conversionWeightedPct / conversionClicks : null,
    conversion_trials: conversionClicks,
    net_aov: netOrders > 0 ? netGmv / netOrders : null,
    net_aov_orders: netOrders,
  };
}

function shrinkBinomialRate(rawPct, trials, priorPct, priorStrength) {
  const raw = normalizePercent(rawPct);
  const prior = normalizePercent(priorPct);
  const n = Math.max(0, finite(trials) || 0);
  const strength = Math.max(0, finite(priorStrength) || 0);
  if (raw == null || prior == null || !(n > 0) || !(strength > 0)) return null;
  const rawProbability = clamp(raw / 100, 0, 1);
  const priorProbability = clamp(prior / 100, 0.000001, 0.999999);
  const successes = rawProbability * n;
  const alpha = priorProbability * strength + successes;
  const beta = (1 - priorProbability) * strength + Math.max(0, n - successes);
  const total = alpha + beta;
  const posterior = alpha / total;
  const variance = alpha * beta / (total * total * (total + 1));
  const margin = 1.96 * Math.sqrt(Math.max(0, variance));
  return {
    raw_pct: raw,
    posterior_pct: posterior * 100,
    lower_95_pct: Math.max(0, posterior - margin) * 100,
    upper_95_pct: Math.min(1, posterior + margin) * 100,
    trials: n,
    prior_pct: prior,
    prior_strength: strength,
    evidence_reliability: n / (n + strength),
  };
}

function shrinkPositiveMean(rawValue, samples, priorValue, priorStrength) {
  const raw = finite(rawValue);
  const prior = finite(priorValue);
  const n = Math.max(0, finite(samples) || 0);
  const strength = Math.max(0, finite(priorStrength) || 0);
  if (raw == null || raw < 0 || prior == null || prior < 0 || !(strength > 0)) return null;
  return {
    raw_value: raw,
    posterior_value: (raw * n + prior * strength) / (n + strength),
    samples: n,
    prior_value: prior,
    prior_strength: strength,
    evidence_reliability: n / (n + strength),
  };
}

// 相对账户基线：0.5倍及以下记0，等于基线记50，1.5倍及以上记100。
function relativeStrength(relative) {
  return relative == null ? null : 100 * clamp01((relative - 0.5) / 1.0);
}

// CPC 越低越好：0.5倍及以下记100，等于基线记50，1.5倍及以上记0。
function inverseRelativeStrength(relative) {
  return relative == null ? null : 100 * clamp01((1.5 - relative) / 1.0);
}

// ROI 为保本线的一半记0，等于保本线记50，达到1.5倍保本线记100。
function roiStrength(roi, breakEven) {
  if (roi == null || !(breakEven > 0)) return null;
  return 100 * clamp01((roi / breakEven - 0.5) / 1.0);
}

function collectMarginalWindows(mat, ctx) {
  const input = ctx.marginalWindows || mat.marginal_windows || {};
  const windows = [];
  for (const minutes of [5, 15, 60]) {
    const raw = input[`m${minutes}`] || input[minutes];
    if (!raw || raw.stale || raw.net_data_valid !== true || REJECTED_WINDOW_QUALITY.has(raw.data_quality)) continue;
    const deltaSpend = finite(raw.delta_spend);
    const deltaNetGmv = finite(raw.delta_net_gmv);
    const deltaOrders = finite(raw.delta_orders);
    const actualMinutes = finite(raw.actual_window_minutes != null ? raw.actual_window_minutes : raw.window_minutes);
    if (deltaSpend == null || deltaSpend < 0 || deltaNetGmv == null || !(actualMinutes > 0)) continue;
    windows.push({
      minutes,
      weight: WINDOW_WEIGHTS[minutes],
      delta_spend: deltaSpend,
      delta_net_gmv: deltaNetGmv,
      delta_orders: deltaOrders == null ? 0 : deltaOrders,
      actual_window_minutes: actualMinutes,
      marginal_net_roi: deltaSpend > 0 ? deltaNetGmv / deltaSpend : null,
      spend_rate_hour: deltaSpend * 60 / actualMinutes,
      data_quality: raw.data_quality || 'complete',
    });
  }
  return windows;
}

function weightedWindowValue(windows, selector) {
  let numerator = 0;
  let denominator = 0;
  for (const window of windows) {
    const value = selector(window);
    if (!Number.isFinite(value)) continue;
    numerator += value * window.weight;
    denominator += window.weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function canonicalNet(mat, netDataValid) {
  if (!netDataValid) return null;
  if (mat.net_gmv_1h != null || mat.netGmv1h != null) {
    return finite(mat.net_gmv_1h != null ? mat.net_gmv_1h : mat.netGmv1h);
  }
  return mat.netGmv != null ? finite(mat.netGmv) : null;
}

function roiScenario(currentRoi, targetRoi, direction) {
  if (!(currentRoi > 0) || !(targetRoi > 0)) return null;
  const multiplier = currentRoi / targetRoi;
  return {
    direction,
    target_roi: round(targetRoi, 2),
    first_order_power_multiplier: round(multiplier, 4),
    first_order_power_change_pct: round((multiplier - 1) * 100, 2),
  };
}

function buildRoiScenarios(roiGoal) {
  if (!(roiGoal > 0)) return [];
  const down = Math.max(roiGoal * 0.90, roiGoal - 0.1);
  const up = Math.min(roiGoal * 1.10, roiGoal + 0.1);
  return [
    roiScenario(roiGoal, down, 'loosen_for_volume'),
    roiScenario(roiGoal, up, 'tighten_for_cost'),
  ].filter(Boolean);
}

function strengthStatus(strength) {
  if (!Number.isFinite(strength)) return 'UNAVAILABLE';
  if (strength < 35) return 'BOTTLENECK';
  if (strength < 50) return 'WEAK';
  if (strength < 70) return 'HEALTHY';
  return 'STRONG';
}

function factor(code, label, relative, strength, evidence = null) {
  return {
    code,
    label,
    relative_to_account: round(relative),
    strength: round(strength, 1),
    status: strengthStatus(strength),
    evidence_reliability: evidence ? round(evidence.evidence_reliability) : null,
    sample_size: evidence ? round(evidence.trials != null ? evidence.trials : evidence.samples, 0) : null,
  };
}

function buildDeliveryPowerDiagnostic(input = {}) {
  const {
    ctrPct,
    ctrRelative,
    conversionRate,
    conversionRelative,
    netAov,
    netAovRelative,
    roiGoal,
    persuasionIndex,
    funnelMetrics = {},
    rawCtrPct,
    rawConversionRate,
    rawNetAov,
    ctrEvidence,
    conversionEvidence,
    netAovEvidence,
    factorEvidenceConfidence,
    peerBenchmarks,
    deliveryCohort: deliveryCohortName,
    boostShare,
    deliveryTelemetry,
  } = input;
  const relativeProduct = ctrRelative != null && conversionRelative != null && netAovRelative != null
    ? Math.max(0, ctrRelative) * Math.max(0, conversionRelative) * Math.max(0, netAovRelative)
    : null;
  const expectedGmvPerThousand = ctrPct != null && conversionRate != null && netAov != null
    ? (ctrPct / 100) * (conversionRate / 100) * netAov * 1000
    : null;
  const roiAdjustedCapacity = expectedGmvPerThousand != null && roiGoal > 0
    ? expectedGmvPerThousand / roiGoal
    : null;

  const factors = [
    factor('CTR', '点击吸引力', ctrRelative, relativeStrength(ctrRelative), ctrEvidence),
    factor('CVR', '成交转化', conversionRelative, relativeStrength(conversionRelative), conversionEvidence),
    factor('NET_AOV', '净客单价', netAovRelative, relativeStrength(netAovRelative), netAovEvidence),
    {
      code: 'CONTENT_QUALITY',
      label: '内容留存代理',
      relative_to_account: null,
      strength: round(persuasionIndex, 1),
      status: strengthStatus(persuasionIndex),
    },
  ];
  const usableFactors = factors.filter(item => Number.isFinite(item.strength));
  const weakest = usableFactors.length
    ? [...usableFactors].sort((a, b) => a.strength - b.strength)[0]
    : null;
  const observedFactorCount = [ctrRelative, conversionRelative, netAovRelative]
    .filter(Number.isFinite).length;
  const status = observedFactorCount === 3
    ? 'complete'
    : (observedFactorCount > 0 || Number.isFinite(persuasionIndex) ? 'partial' : 'unavailable');

  return {
    name: '竞价动力代理',
    status,
    interpretation: 'diagnostic_not_platform_ecpm_or_rank_score',
    formula: {
      plan_level: 'observed_pctr_x_observed_pcvr_x_net_aov_divided_by_roi_goal',
      within_plan_material_level: 'observed_pctr_x_observed_pcvr_x_net_aov',
      roi_position: 'denominator',
      content_quality_handling: 'separate_explanatory_proxy_to_avoid_double_counting',
    },
    plan_control: {
      roi_goal: round(roiGoal, 2),
      delivery_cohort: deliveryCohortName || 'unknown',
      boost_cost_share: round(boostShare),
      same_plan_material_comparison: roiGoal > 0
        ? (deliveryCohortName === 'boost_influenced'
          ? 'not_strict_due_to_boost_traffic_mixture'
          : 'roi_denominator_cancels')
        : 'roi_goal_unavailable',
      first_order_scenarios: buildRoiScenarios(roiGoal),
      actual_response_requires_account_history: true,
    },
    observed_mechanics: {
      ctr_pct: round(rawCtrPct != null ? rawCtrPct : ctrPct, 3),
      conversion_pct: round(rawConversionRate != null ? rawConversionRate : conversionRate, 3),
      net_aov: round(rawNetAov != null ? rawNetAov : netAov, 2),
      shrunk_ctr_pct: round(ctrPct, 3),
      shrunk_conversion_pct: round(conversionRate, 3),
      shrunk_net_aov: round(netAov, 2),
      expected_net_gmv_per_1000_impressions_proxy: round(expectedGmvPerThousand, 2),
      roi_adjusted_cost_capacity_per_1000_proxy: round(roiAdjustedCapacity, 2),
      account_relative_numerator_product: round(relativeProduct),
    },
    statistical_evidence: {
      method: 'leave_one_out_account_prior_with_empirical_bayes_shrinkage',
      factor_evidence_confidence: round(factorEvidenceConfidence),
      prior_strengths: PRIOR_STRENGTHS,
      peer_benchmarks: peerBenchmarks || null,
      ctr: ctrEvidence ? {
        trials: round(ctrEvidence.trials, 0),
        prior_pct: round(ctrEvidence.prior_pct, 3),
        posterior_pct: round(ctrEvidence.posterior_pct, 3),
        lower_95_pct: round(ctrEvidence.lower_95_pct, 3),
        upper_95_pct: round(ctrEvidence.upper_95_pct, 3),
        reliability: round(ctrEvidence.evidence_reliability),
      } : null,
      conversion: conversionEvidence ? {
        trials: round(conversionEvidence.trials, 0),
        prior_pct: round(conversionEvidence.prior_pct, 3),
        posterior_pct: round(conversionEvidence.posterior_pct, 3),
        lower_95_pct: round(conversionEvidence.lower_95_pct, 3),
        upper_95_pct: round(conversionEvidence.upper_95_pct, 3),
        reliability: round(conversionEvidence.evidence_reliability),
      } : null,
      net_aov: netAovEvidence ? {
        samples: round(netAovEvidence.samples, 0),
        prior_value: round(netAovEvidence.prior_value, 2),
        posterior_value: round(netAovEvidence.posterior_value, 2),
        reliability: round(netAovEvidence.evidence_reliability),
      } : null,
    },
    measurement_quality: deliveryTelemetry || {
      status: 'unavailable',
      ctr_usable: false,
      conversion_usable: false,
      issues: ['DELIVERY_TELEMETRY_NOT_AUDITED'],
    },
    factors,
    primary_constraint: weakest && weakest.strength < 50
      ? { code: weakest.code, label: weakest.label, status: weakest.status, strength: weakest.strength }
      : null,
    content_quality_proxy: {
      status: Number.isFinite(persuasionIndex) ? strengthStatus(persuasionIndex) : 'UNAVAILABLE',
      strength: round(persuasionIndex, 1),
      rate3s_relative: round(finite(funnelMetrics.rate3s_rel)),
      finish_rate_relative: round(finite(funnelMetrics.finish_rate_rel)),
      watch_time_relative: round(finite(funnelMetrics.watch_ratio_rel)),
      platform_quality_score_claimed: false,
    },
    safeguards: [
      'OBSERVED_VALUES_NOT_PLATFORM_PREDICTIONS',
      'NET_AOV_IS_BUSINESS_OUTCOME_NOT_CONFIRMED_AUCTION_INPUT',
      'ROI_SCENARIOS_ARE_FIRST_ORDER_NOT_TRAFFIC_FORECASTS',
      'DO_NOT_COMBINE_ROI_AND_CONTENT_ACTIONS_IN_ONE_TEST',
      ...(deliveryCohortName === 'boost_influenced' ? ['BOOST_TRAFFIC_MIXTURE_CONFOUNDS_PLAN_COMPARISON'] : []),
    ],
  };
}

function computeMhsV3Shadow(mat = {}, ctx = {}) {
  const breakEven = finite(ctx.breakEven) || 3;
  const floorRoi = finite(ctx.floorRoi) || Math.max(0, breakEven - 0.2);
  const cost = Math.max(0, finite(mat.cost != null ? mat.cost : mat.spend) || 0);
  const orders = Math.max(0, finite(mat.orders) || 0);
  const netDataValid = ctx.netDataValid != null
    ? !!ctx.netDataValid
    : (mat.net_data_valid === true || +mat.net_data_valid === 1);
  const netGmv = canonicalNet(mat, netDataValid);
  const financialDataUsable = netDataValid && netGmv != null;
  const netRoi = netDataValid && netGmv != null && cost > 0 ? netGmv / cost : null;
  const stale = ctx.stale === true;
  const isActive = ctx.isActive !== false;
  const funnel = ctx.funnel && typeof ctx.funnel === 'object' ? ctx.funnel : null;
  const funnelMetrics = funnel && funnel.metrics && typeof funnel.metrics === 'object' ? funnel.metrics : {};
  const windows = collectMarginalWindows(mat, ctx);
  const positiveSpendWindows = windows.filter(window => window.delta_spend > 0);
  const weightedMarginalRoi = weightedWindowValue(positiveSpendWindows, window => window.marginal_net_roi);
  const marginalCoverage = windows.reduce((sum, window) => sum + window.weight, 0);

  const cumulativeProfitability = roiStrength(netRoi, breakEven);
  const marginalProfitability = roiStrength(weightedMarginalRoi, breakEven);
  const profitabilityIndex = !financialDataUsable
    ? null
    : (marginalProfitability == null
      ? cumulativeProfitability
      : (cumulativeProfitability == null
        ? marginalProfitability
        : 0.70 * marginalProfitability + 0.30 * cumulativeProfitability));

  const persuasionParts = [
    relativeStrength(finite(funnelMetrics.rate3s_rel)),
    relativeStrength(finite(funnelMetrics.finish_rate_rel)),
    relativeStrength(finite(funnelMetrics.watch_ratio_rel)),
  ];
  const persuasionIndex = mean(persuasionParts);

  const peerBenchmarks = ctx.peerBenchmarks && typeof ctx.peerBenchmarks === 'object'
    ? ctx.peerBenchmarks
    : {
      method: 'legacy_account_benchmark',
      ctr_pct: normalizePercent(ctx.ctrBenchmark),
      conversion_pct: normalizePercent(ctx.conversionBenchmark),
      net_aov: finite(ctx.netAovBenchmark),
    };
  const deliveryTelemetry = auditDeliveryTelemetry(mat);
  const rawCtrPct = deliveryTelemetry.ctr_usable
    ? deliveryTelemetry.count_derived_ctr_pct
    : null;
  const rawConversionRate = deliveryTelemetry.conversion_usable
    ? deliveryTelemetry.reported_conversion_pct
    : null;
  const rawNetAov = financialDataUsable && orders > 0 ? netGmv / orders : null;
  const ctrBenchmark = normalizePercent(peerBenchmarks.ctr_pct);
  const conversionBenchmark = normalizePercent(peerBenchmarks.conversion_pct);
  const netAovBenchmark = finite(peerBenchmarks.net_aov);
  const ctrEvidence = shrinkBinomialRate(
    rawCtrPct,
    mat.shows,
    ctrBenchmark,
    finite(ctx.ctrPriorImpressions) || PRIOR_STRENGTHS.ctr_impressions,
  );
  const conversionEvidence = shrinkBinomialRate(
    rawConversionRate,
    mat.clicks,
    conversionBenchmark,
    finite(ctx.conversionPriorClicks) || PRIOR_STRENGTHS.conversion_clicks,
  );
  const netAovEvidence = shrinkPositiveMean(
    rawNetAov,
    orders,
    netAovBenchmark,
    finite(ctx.netAovPriorOrders) || PRIOR_STRENGTHS.net_aov_orders,
  );
  const ctrPct = ctrEvidence ? ctrEvidence.posterior_pct : rawCtrPct;
  const conversionRate = conversionEvidence
    ? conversionEvidence.posterior_pct
    : ((finite(mat.clicks) || 0) > 0 ? rawConversionRate : null);
  const netAov = netAovEvidence ? netAovEvidence.posterior_value : rawNetAov;
  const ctrRelative = ctrPct != null && ctrBenchmark > 0
    ? ctrPct / ctrBenchmark
    : finite(funnelMetrics.ctr_rel);
  const conversionRelative = conversionRate != null && conversionBenchmark > 0
    ? conversionRate / conversionBenchmark
    : null;
  const netAovRelative = netAov != null && netAovBenchmark > 0 ? netAov / netAovBenchmark : null;
  const acquisitionParts = [
    relativeStrength(ctrRelative),
    inverseRelativeStrength(finite(funnelMetrics.cpc_rel)),
  ];
  const acquisitionIndex = mean(acquisitionParts);
  const conversionIndex = relativeStrength(conversionRelative);
  const factorReliabilities = [ctrEvidence, conversionEvidence, netAovEvidence]
    .map(item => item && item.evidence_reliability)
    .filter(Number.isFinite);
  const factorEvidenceConfidence = factorReliabilities.length === 3
    ? Math.min(...factorReliabilities)
    : 0;
  // 仅做账户内可观测代理：不含平台预估值、质量分、竞争环境或未公开校准参数。
  const auctionProxyRelative = ctrRelative != null && conversionRelative != null && netAovRelative != null
    ? Math.cbrt(Math.max(0, ctrRelative) * Math.max(0, conversionRelative) * Math.max(0, netAovRelative))
    : null;
  const deliveryPowerProxyIndex = relativeStrength(auctionProxyRelative);
  const roiGoal = finite(ctx.roiGoal);
  const deliveryCohortName = ctx.deliveryCohort || deliveryCohort(mat);
  const boostShare = boostCostShare(mat);
  const deliveryPower = buildDeliveryPowerDiagnostic({
    ctrPct,
    ctrRelative,
    conversionRate,
    conversionRelative,
    netAov,
    netAovRelative,
    roiGoal,
    persuasionIndex,
    funnelMetrics,
    rawCtrPct,
    rawConversionRate,
    rawNetAov,
    ctrEvidence,
    conversionEvidence,
    netAovEvidence,
    factorEvidenceConfidence,
    peerBenchmarks,
    deliveryCohort: deliveryCohortName,
    boostShare,
    deliveryTelemetry,
  });

  const maxMarginalSpend = positiveSpendWindows.length
    ? Math.max(...positiveSpendWindows.map(window => window.delta_spend))
    : 0;
  const marginalSample = 1 - Math.exp(-maxMarginalSpend / 50);
  const stableWindowWeight = positiveSpendWindows.reduce((sum, window) => (
    sum + (window.marginal_net_roi != null && window.marginal_net_roi >= floorRoi ? window.weight : 0)
  ), 0);
  const positiveWindowWeight = positiveSpendWindows.reduce((sum, window) => sum + window.weight, 0);
  const stability = positiveWindowWeight > 0 ? stableWindowWeight / positiveWindowWeight : null;
  const scaleCapacityIndex = !financialDataUsable || marginalProfitability == null ? null : 100 * (
    0.65 * marginalProfitability / 100 +
    0.20 * marginalSample +
    0.15 * (stability == null ? 0 : stability)
  );

  const m5 = positiveSpendWindows.find(window => window.minutes === 5) || null;
  const longerRoi = weightedWindowValue(
    positiveSpendWindows.filter(window => window.minutes > 5),
    window => window.marginal_net_roi,
  );
  const recentRatio = m5 && m5.marginal_net_roi != null && longerRoi > 0
    ? m5.marginal_net_roi / longerRoi
    : null;
  const recentDeterioration = recentRatio == null ? null : 100 * clamp01((1.1 - recentRatio) / 0.8);
  const consecutiveLow = Math.max(0, finite(ctx.consecutiveLow != null ? ctx.consecutiveLow : mat.consecutive_low_rounds) || 0);
  const funnelFailureHits = funnel && finite(funnel.failure_hits) != null ? finite(funnel.failure_hits) : 0;
  const funnelRisk = funnel
    ? clamp(25 * Math.min(funnelFailureHits, 3) + (funnel.drop_amplifier ? 15 : 0), 0, 100)
    : null;
  const fatigueRiskIndex = mean([
    recentDeterioration,
    consecutiveLow > 0 ? 100 * clamp01(consecutiveLow / 3) : null,
    funnelRisk,
  ]);

  const spendConfidence = 1 - Math.exp(-cost / 80);
  const orderConfidence = 1 - Math.exp(-orders / 4);
  const economicsEvidenceConfidence = Math.min(
    spendConfidence,
    orderConfidence,
    clamp01(marginalCoverage),
  );
  const funnelEvidenceCount = [...acquisitionParts, ...persuasionParts].filter(Number.isFinite).length;
  const funnelCoverage = funnelEvidenceCount / 5;
  let confidence = (
    (netDataValid && netGmv != null ? 0.25 : 0) +
    0.20 * spendConfidence +
    0.10 * orderConfidence +
    0.30 * clamp01(marginalCoverage) +
    0.10 * funnelCoverage +
    0.05 * (conversionIndex == null ? 0 : 1)
  );
  if (stale) confidence *= 0.2;
  if (!isActive) confidence *= 0.5;
  confidence = clamp01(confidence);

  const sampleConfidence = 0.60 * spendConfidence + 0.40 * orderConfidence;
  const wasteRiskIndex = profitabilityIndex == null || sampleConfidence < 0.25
    ? null
    : clamp(
      (100 - profitabilityIndex) * 0.65 +
      (fatigueRiskIndex == null ? 0 : fatigueRiskIndex * 0.35),
      0,
      100,
    );

  const profitabilityLikelihood = profitabilityIndex == null
    ? null
    : clamp01((0.70 * profitabilityIndex + 0.30 * (scaleCapacityIndex == null ? profitabilityIndex : scaleCapacityIndex)) / 100);
  const scaleSuccessLikelihood = scaleCapacityIndex == null
    ? null
    : clamp01((0.70 * scaleCapacityIndex + 0.20 * (profitabilityIndex || 0) + 0.10 * (100 - (fatigueRiskIndex || 0))) / 100);
  const expectedRoiBasis = !financialDataUsable
    ? null
    : (weightedMarginalRoi != null ? 'real_marginal_windows' : (netRoi != null ? 'cumulative_fallback' : null));
  const expectedRoi = !financialDataUsable
    ? null
    : (weightedMarginalRoi != null ? weightedMarginalRoi : netRoi);

  const reasonCodes = ['ORGANIC_UPLIFT_NOT_MODELED'];
  if (!netDataValid || netGmv == null) reasonCodes.push('NET_DATA_UNAVAILABLE');
  if (!windows.length) reasonCodes.push('NO_REAL_MARGINAL');
  if (sampleConfidence < 0.5) reasonCodes.push('LOW_SAMPLE_CONFIDENCE');
  if (acquisitionIndex == null) reasonCodes.push('ACQUISITION_EVIDENCE_MISSING');
  if (persuasionIndex == null) reasonCodes.push('PERSUASION_EVIDENCE_MISSING');
  if (conversionIndex == null) reasonCodes.push('CONVERSION_BENCHMARK_MISSING');
  if (deliveryPowerProxyIndex == null) reasonCodes.push('AUCTION_PROXY_INCOMPLETE');
  if (factorEvidenceConfidence < SCALE_GATES.delivery_evidence) reasonCodes.push('SPARSE_DELIVERY_EVIDENCE');
  if (economicsEvidenceConfidence < SCALE_GATES.economics_evidence) reasonCodes.push('SPARSE_ECONOMICS_EVIDENCE');
  reasonCodes.push(...deliveryTelemetry.issues);
  if (deliveryCohortName === 'boost_influenced') reasonCodes.push('DELIVERY_MIXTURE_CONFOUNDED');
  if (stale) reasonCodes.push('STALE_DATA');
  if (!isActive) reasonCodes.push('INACTIVE_MATERIAL');

  let candidate = 'HOLD';
  const scaleSignal = profitabilityIndex >= 70 && scaleCapacityIndex >= 65 &&
    (fatigueRiskIndex == null || fatigueRiskIndex < 45);
  const scaleEvidenceReady = factorEvidenceConfidence >= SCALE_GATES.delivery_evidence &&
    economicsEvidenceConfidence >= SCALE_GATES.economics_evidence &&
    deliveryTelemetry.status === 'complete' &&
    deliveryCohortName !== 'boost_influenced';
  if (!netDataValid || netGmv == null || !windows.length) candidate = 'INSUFFICIENT_EVIDENCE';
  else if (confidence < 0.55) candidate = 'LEARN_MORE';
  else if (scaleSignal && !scaleEvidenceReady) candidate = 'PROMISING_CANDIDATE';
  else if (scaleSignal) {
    candidate = 'SCALE_CANDIDATE';
  } else if (wasteRiskIndex >= 65 && profitabilityIndex < 45) {
    candidate = 'RISK_CANDIDATE';
  } else if (fatigueRiskIndex >= 60) {
    candidate = 'FATIGUE_WATCH';
  }

  let dataQuality = 'insufficient';
  if (stale) dataQuality = 'stale';
  else if (!netDataValid || netGmv == null) dataQuality = 'unavailable';
  else if (marginalCoverage >= 0.8 && funnelEvidenceCount >= 3 && deliveryTelemetry.status === 'complete') dataQuality = 'complete';
  else if (windows.length || funnelEvidenceCount > 0) dataQuality = 'partial';

  return {
    model: MHS_V3_SHADOW_ALGORITHM,
    calibration: {
      status: 'account_relative_untrained',
      learned_from_historical_outcomes: false,
      probability_calibrated: false,
    },
    shadow_only: true,
    actionable: false,
    candidate,
    confidence: round(confidence),
    data_quality: dataQuality,
    indices: {
      profitability: round(profitabilityIndex, 1),
      acquisition: round(acquisitionIndex, 1),
      persuasion: round(persuasionIndex, 1),
      conversion: round(conversionIndex, 1),
      delivery_power_proxy: round(deliveryPowerProxyIndex, 1),
      delivery_evidence_confidence: round(factorEvidenceConfidence, 3),
      economics_evidence_confidence: round(economicsEvidenceConfidence, 3),
      scale_capacity: round(scaleCapacityIndex, 1),
      fatigue_risk: round(fatigueRiskIndex, 1),
      waste_risk: round(wasteRiskIndex, 1),
    },
    decision_domains: {
      material_capability: {
        status: deliveryPower.status,
        account_relative_index: round(deliveryPowerProxyIndex, 1),
        evidence_confidence: round(factorEvidenceConfidence),
        primary_constraint: deliveryPower.primary_constraint,
      },
      realized_economics: {
        status: financialDataUsable ? 'observed' : 'unavailable',
        evidence_confidence: round(economicsEvidenceConfidence),
        profitability_index: round(profitabilityIndex, 1),
        cumulative_net_roi: round(netRoi, 2),
        weighted_marginal_net_roi: round(weightedMarginalRoi, 2),
      },
      scale_response: {
        status: 'not_causally_identified_without_intervention_data',
        observational_readiness_index: round(scaleCapacityIndex, 1),
        observational_candidate: scaleSignal,
        experiment_readiness: !scaleSignal
          ? 'no_observational_scale_signal'
          : (scaleEvidenceReady ? 'eligible_for_guarded_trial' : 'promising_but_underpowered_or_confounding'),
        evidence_gates: {
          delivery_minimum: SCALE_GATES.delivery_evidence,
          economics_minimum: SCALE_GATES.economics_evidence,
          delivery_passed: factorEvidenceConfidence >= SCALE_GATES.delivery_evidence,
          economics_passed: economicsEvidenceConfidence >= SCALE_GATES.economics_evidence,
          telemetry_passed: deliveryTelemetry.status === 'complete',
          traffic_mix_passed: deliveryCohortName !== 'boost_influenced',
        },
        action_success_probability: null,
      },
    },
    estimates: {
      profitability_likelihood_index: round(profitabilityLikelihood),
      scale_success_likelihood_index: round(scaleSuccessLikelihood),
      likelihood_fields_are_uncalibrated_indices: true,
      expected_net_gmv_per_100_spend: expectedRoi == null ? null : round(expectedRoi * 100, 2),
      expected_value_basis: expectedRoiBasis,
    },
    delivery_power: deliveryPower,
    evidence: {
      net_roi: round(netRoi, 2),
      weighted_marginal_net_roi: round(weightedMarginalRoi, 2),
      marginal_coverage: round(marginalCoverage),
      spend: round(cost, 2),
      orders: round(orders, 0),
      conversion_rate: round(conversionRate, 3),
      raw_conversion_rate: round(rawConversionRate, 3),
      conversion_benchmark: round(conversionBenchmark, 3),
      auction_proxy: {
        status: 'diagnostic_not_platform_rank_score',
        method: 'geometric_mean_of_account_relative_observed_factors',
        roi_goal: round(roiGoal, 2),
        roi_position: 'denominator',
        ctr_relative: round(ctrRelative),
        conversion_relative: round(conversionRelative),
        net_aov: round(netAov, 2),
        net_aov_benchmark: round(netAovBenchmark, 2),
        net_aov_relative: round(netAovRelative),
        combined_relative: round(auctionProxyRelative),
      },
      marginal_windows: windows.map(window => ({
        minutes: window.minutes,
        delta_spend: round(window.delta_spend, 2),
        delta_net_gmv: round(window.delta_net_gmv, 2),
        delta_orders: round(window.delta_orders, 0),
        marginal_net_roi: round(window.marginal_net_roi, 2),
        spend_rate_hour: round(window.spend_rate_hour, 2),
        data_quality: window.data_quality,
      })),
    },
    reason_codes: reasonCodes,
  };
}

module.exports = {
  MHS_V3_SHADOW_ALGORITHM,
  computeMhsV3Shadow,
  computeConversionBenchmark,
  computeNetAovBenchmark,
  computeDeliveryBenchmarkTotals,
  peerDeliveryBenchmarks,
  boostCostShare,
  deliveryCohort,
  auditDeliveryTelemetry,
  normalizePercent,
  buildDeliveryPowerDiagnostic,
  _test: {
    buildRoiScenarios,
    shrinkBinomialRate,
    shrinkPositiveMean,
    collectMarginalWindows,
    relativeStrength,
    inverseRelativeStrength,
    roiStrength,
  },
};
