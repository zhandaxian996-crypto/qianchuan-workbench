'use strict';

/**
 * 扩量稀释影子预警。
 *
 * 目标不是证明平台主观“注水”，而是识别可重复观察到的经营风险形态：
 * 前一 15m 盈利 -> 当前 15m 流速抬升、ROI 仍在风险线之上但明显收缩 ->
 * 下一窗口更容易出现效率稀释。
 *
 * 本模块只做诊断和责任域路由，永远不产生可执行写动作。
 */

const BUCKET_MS = 5 * 60 * 1000;
const BUCKET_GAP_TOLERANCE_MS = 5 * 1000;
const PREDICTOR_VERSION = '1.1.0';

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function parseTimeMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const text = String(value).trim();
  // 千川 stat_time_5_minute 返回中国时区的无偏移时间。不能让它跟随
  // 服务器宿主时区解释，否则同一批桶在 UTC 主机会整体偏移 8 小时。
  const localMatch = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  const normalized = localMatch
    ? `${localMatch[1]}T${localMatch[2]}+08:00`
    : text;
  return new Date(normalized).getTime();
}

function finiteMetric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unavailable(status, extra = {}) {
  return {
    predictor_version: PREDICTOR_VERSION,
    shadow_only: true,
    actionable: false,
    allowed_use: 'diagnose_and_route_only',
    status,
    state: 'UNAVAILABLE',
    risk_level: 'unavailable',
    roi_basis: 'platform_net_1h',
    prediction_semantics: 'historical_risk_shape_not_probability',
    ...extra,
  };
}

function normalizeTrend(trend, nowMs, maxAgeSec = 720, sourceAsOfMs = nowMs) {
  const evaluationNow = Number(nowMs);
  const sourceAsOf = Number(sourceAsOfMs);
  const closedCutoff = Number.isFinite(sourceAsOf)
    ? Math.min(evaluationNow, sourceAsOf)
    : evaluationNow;
  const rows = (Array.isArray(trend) ? trend : []).map(rawPoint => {
    const point = rawPoint && typeof rawPoint === 'object' ? rawPoint : {};
    return {
      ts: parseTimeMs(point.time || point.point_time || point.as_of),
      time: point.time || point.point_time || point.as_of || null,
      cost: finiteMetric(point.cost ?? point.delta_spend),
      net: finiteMetric(point.gmvSettle ?? point.net_1h ?? point.delta_net_gmv),
      valid: point.costDataValid === true && point.netDataValid === true,
    };
  }).filter(row => Number.isFinite(row.ts))
    .sort((a, b) => a.ts - b.ts)
    .filter(row => row.ts + BUCKET_MS <= closedCutoff);

  if (!rows.length) return { status: 'collecting', rows: [] };
  const latest = rows[rows.length - 1];
  const freshnessSeconds = Math.max(0, Math.round((evaluationNow - (latest.ts + BUCKET_MS)) / 1000));
  const allowedAge = Number.isFinite(Number(maxAgeSec)) ? Math.max(0, Number(maxAgeSec)) : 720;
  if (freshnessSeconds > allowedAge) {
    return { status: 'stale', rows: [], freshness_seconds: freshnessSeconds, latest_closed_at: latest.time };
  }
  const selected = rows.slice(-6);
  if (selected.length < 6) return { status: 'collecting', rows: selected, freshness_seconds: freshnessSeconds };
  if (selected.some(row => !row.valid || row.cost == null || row.net == null)) {
    return { status: 'source_metric_missing', rows: selected, freshness_seconds: freshnessSeconds };
  }
  for (let i = 1; i < selected.length; i++) {
    const gap = selected[i].ts - selected[i - 1].ts;
    if (Math.abs(gap - BUCKET_MS) > BUCKET_GAP_TOLERANCE_MS) {
      return { status: 'non_contiguous', rows: selected, freshness_seconds: freshnessSeconds };
    }
  }
  return { status: 'ready', rows: selected, freshness_seconds: freshnessSeconds };
}

function aggregateWindow(rows) {
  const cost = rows.reduce((sum, row) => sum + Math.max(0, row.cost), 0);
  const net = rows.reduce((sum, row) => sum + row.net, 0);
  const minutes = rows.length * 5;
  return {
    cost,
    net,
    minutes,
    netRoi: cost > 0 ? net / cost : null,
    totalFlowPerHour: minutes > 0 ? cost * 60 / minutes : null,
  };
}

function summarizeWindow(rows) {
  const raw = aggregateWindow(rows);
  return {
    start_at: rows[0] ? rows[0].time : null,
    end_at: rows.length ? new Date(rows[rows.length - 1].ts + BUCKET_MS).toISOString() : null,
    minutes: raw.minutes,
    spend: round(raw.cost, 2),
    net_gmv: round(raw.net, 2),
    net_roi: round(raw.netRoi, 3),
    total_flow_per_hour: round(raw.totalFlowPerHour, 1),
  };
}

function calibrationValue(value, fallback) {
  const raw = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
    ? value.value
    : value;
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveCalibration(profile, thresholds = {}) {
  const model = profile && profile.predictors && profile.predictors.flow_dilution_shadow || {};
  const metrics = profile && profile.metrics || {};
  const capacity = profile && profile.flow && profile.flow.sustainable_capacity || {};
  return {
    profit_roi: calibrationValue(model.profit_anchor_roi,
      calibrationValue(metrics.profit_roi, calibrationValue(thresholds.profit_roi, null))),
    floor_roi: calibrationValue(model.risk_floor_roi,
      calibrationValue(metrics.risk_floor_roi, calibrationValue(thresholds.floor_roi, null))),
    expansion_ratio: calibrationValue(model.expansion_ratio, 1.15),
    roi_retention_max: calibrationValue(model.roi_retention_max, 0.90),
    min_window_spend: calibrationValue(model.min_window_spend, 25),
    min_window_net_gmv: calibrationValue(model.min_window_net_gmv, 100),
    total_capacity: calibrationValue(model.total_capacity,
      calibrationValue(capacity.total, calibrationValue(thresholds.flow_benchmark, null))),
    source: model.source || 'runtime_fallback',
    updated_at: model.updated_at || null,
    mode: model.mode || 'shadow',
  };
}

function inferAttribution(m15) {
  const basic = finiteMetric(m15 && m15.basic_spend_rate_hour);
  const assist = finiteMetric(m15 && m15.assist_spend_rate_hour);
  if (!m15 || m15.flow_split_quality !== 'complete' ||
      basic == null || assist == null) {
    return {
      domain: 'unknown',
      confidence: 'unavailable',
      target_id: null,
      reason_codes: ['FLOW_SPLIT_NOT_COMPLETE'],
    };
  }
  const total = basic + assist;
  const share = total > 0 ? assist / total : 0;
  if (share <= 0.20) {
    return {
      domain: 'base_plan',
      confidence: 'tentative',
      target_id: null,
      reason_codes: ['CURRENT_15M_BASE_SHARE_DOMINANT'],
    };
  }
  if (share >= 0.50) {
    return {
      domain: 'boost_group',
      confidence: 'tentative',
      target_id: null,
      reason_codes: ['CURRENT_15M_ASSIST_SHARE_DOMINANT', 'PER_TASK_WINDOW_MISSING'],
    };
  }
  return {
    domain: 'mixed',
    confidence: 'tentative',
    target_id: null,
    reason_codes: ['BASE_AND_ASSIST_BOTH_MATERIAL'],
  };
}

function funnelCorroboration(funnel, profile) {
  const baseline = profile && profile.funnel_baseline && profile.funnel_baseline.stages || {};
  const currentWatchClick = finiteMetric(funnel && (funnel.watchToClickRate ?? funnel.watch_to_click_rate));
  const currentClickPay = finiteMetric(funnel && (funnel.clickToPayRate ?? funnel.click_to_pay_rate));
  const baseWatchClick = calibrationValue(baseline.product_click_rate, null);
  const baseClickPay = calibrationValue(baseline.payment_rate, null);
  const signals = [];
  if (Number.isFinite(currentWatchClick) && Number.isFinite(baseWatchClick) && baseWatchClick > 0 &&
      currentWatchClick < baseWatchClick * 0.8) signals.push('WATCH_TO_CLICK_BELOW_BASELINE');
  if (Number.isFinite(currentClickPay) && Number.isFinite(baseClickPay) && baseClickPay > 0 &&
      currentClickPay < baseClickPay * 0.8) signals.push('CLICK_TO_PAY_BELOW_BASELINE');
  return {
    status: signals.length ? 'weak' : (Number.isFinite(currentWatchClick) || Number.isFinite(currentClickPay) ? 'not_weak' : 'unavailable'),
    signals,
    note: 'current_session_cumulative_corroboration_only',
  };
}

function buildRouteCandidates(state, attribution) {
  if (!['DILUTION_WARNING', 'DILUTION_RISK_HIGH', 'DILUTION_MATERIALIZED'].includes(state)) return [];
  if (attribution.domain === 'base_plan') {
    return [{
      target_type: 'base_plan',
      target_id: null,
      candidate_action: 'FLOW_CONTROL_STATUS_AND_PRECHECK',
      preconditions: ['flow_control_inactive', 'account_strategy_allows', 'write_guard_passes'],
      blocked_by: ['shadow_signal_not_actionable'],
      note: '主计划ROI是慢变量；先核验一键控量状态，不由本Shadow直接写入',
    }];
  }
  if (attribution.domain === 'boost_group') {
    return [{
      target_type: 'boost_group',
      target_id: null,
      candidate_action: 'AUDIT_PER_TASK_MODE_AND_WINDOW',
      preconditions: ['per_task_5m_or_15m_metrics', 'bidding_mode_known'],
      blocked_by: ['per_task_window_missing', 'shadow_signal_not_actionable'],
      note: 'ROI追投、手动出价追投和放量任务必须按各自模式处理，禁止点名猜测',
    }];
  }
  return [{
    target_type: attribution.domain,
    target_id: null,
    candidate_action: 'DIAGNOSE_FLOW_SOURCE',
    preconditions: ['complete_window_split'],
    blocked_by: ['responsibility_not_isolated', 'shadow_signal_not_actionable'],
  }];
}

function evaluateExpansionDilutionShadow(input = {}) {
  const {
    isLive, roomConflict, collectorStale, strictNetAvailable,
    trendInfo, marginal, thresholds, profile, funnel, nowMs,
  } = input;
  const sessionKey = input.sessionKey || trendInfo && trendInfo.session && trendInfo.session.session_key || null;
  const baseExtra = { session_key: sessionKey };
  if (!isLive) return unavailable('offline', baseExtra);
  if (roomConflict) return unavailable('conflicted', baseExtra);
  if (collectorStale) return unavailable('stale', baseExtra);
  if (!strictNetAvailable) return unavailable('source_metric_missing', baseExtra);

  const calibration = resolveCalibration(profile, thresholds);
  if (![calibration.profit_roi, calibration.floor_roi, calibration.total_capacity].every(Number.isFinite)) {
    return unavailable('insufficient_baseline', { ...baseExtra, calibration });
  }

  const parsedNow = parseTimeMs(nowMs);
  const effectiveNow = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const trendMaxAgeSec = finiteMetric(
    input.trendMaxAgeSec ?? (thresholds && thresholds.marginal_stale_seconds),
  ) ?? 720;
  const sourceAsOfValue = input.sourceAsOfMs ?? input.sourceAsOf ?? input.source_at ??
    (trendInfo && (trendInfo.sourceAsOfMs ?? trendInfo.sourceAsOf ?? trendInfo.source_at ?? trendInfo.fetchedAt));
  const parsedSourceAsOf = parseTimeMs(sourceAsOfValue);
  const sourceAsOfMs = Number.isFinite(parsedSourceAsOf) ? parsedSourceAsOf : effectiveNow;
  const normalized = normalizeTrend(
    trendInfo && trendInfo.trend,
    effectiveNow,
    trendMaxAgeSec,
    sourceAsOfMs,
  );
  if (normalized.status !== 'ready') {
    return unavailable(normalized.status, {
      ...baseExtra,
      closed_5m_buckets: normalized.rows.length,
      trend_freshness_seconds: normalized.freshness_seconds ?? null,
      calibration,
    });
  }

  const previousRows = normalized.rows.slice(0, 3);
  const currentRows = normalized.rows.slice(3);
  const previousRaw = aggregateWindow(previousRows);
  const currentRaw = aggregateWindow(currentRows);
  const combinedRaw = aggregateWindow(normalized.rows);
  const previous = summarizeWindow(previousRows);
  const current = summarizeWindow(currentRows);
  const combined = summarizeWindow(normalized.rows);
  const flowRatio = previousRaw.totalFlowPerHour > 0
    ? currentRaw.totalFlowPerHour / previousRaw.totalFlowPerHour
    : null;
  const roiRetention = previousRaw.netRoi > 0 ? currentRaw.netRoi / previousRaw.netRoi : null;
  const sampleReady = previousRaw.cost >= calibration.min_window_spend &&
    previousRaw.net >= calibration.min_window_net_gmv &&
    currentRaw.cost >= calibration.min_window_spend;
  const priorStrong = sampleReady && previousRaw.netRoi >= calibration.profit_roi &&
    combinedRaw.netRoi >= calibration.profit_roi;
  const expanded = Number.isFinite(flowRatio) && flowRatio >= calibration.expansion_ratio;
  const weakening = Number.isFinite(roiRetention) && roiRetention <= calibration.roi_retention_max;
  const stillHealthy = currentRaw.netRoi != null && currentRaw.netRoi >= calibration.floor_roi;
  const capacityPressure = currentRaw.totalFlowPerHour != null &&
    currentRaw.totalFlowPerHour >= calibration.total_capacity;
  const materialized = sampleReady && previousRaw.netRoi >= calibration.profit_roi && expanded &&
    currentRaw.netRoi != null && currentRaw.netRoi < calibration.floor_roi;
  const funnelSignal = funnelCorroboration(funnel, profile);
  const m15 = marginal && marginal.m15 || null;
  const attribution = inferAttribution(m15);

  let state = 'BASELINE';
  let riskLevel = 'normal';
  if (materialized) {
    state = 'DILUTION_MATERIALIZED';
    riskLevel = 'high';
  } else if (priorStrong && expanded && weakening && stillHealthy) {
    state = capacityPressure ? 'DILUTION_RISK_HIGH' : 'DILUTION_WARNING';
    riskLevel = capacityPressure ? 'high' : 'elevated';
  } else if (priorStrong && expanded && stillHealthy) {
    state = 'HEALTHY_EXPANSION';
  } else if (priorStrong) {
    state = 'PROFIT_ARMED';
    riskLevel = 'watch';
  }

  const evidenceCount = [priorStrong, expanded, weakening, capacityPressure, funnelSignal.status === 'weak']
    .filter(Boolean).length;
  const confidence = riskLevel === 'high' && funnelSignal.status === 'weak' ? 'medium' :
    (['elevated', 'high'].includes(riskLevel) ? 'low_to_medium' : 'low');

  return {
    predictor_version: PREDICTOR_VERSION,
    shadow_only: true,
    actionable: false,
    allowed_use: 'diagnose_and_route_only',
    status: 'ready',
    state,
    risk_level: riskLevel,
    roi_basis: 'platform_net_1h',
    prediction_semantics: 'historical_risk_shape_not_probability',
    probability_calibrated: false,
    session_key: sessionKey,
    as_of: current.end_at,
    trend_freshness_seconds: normalized.freshness_seconds,
    confidence: {
      level: confidence,
      evidence_count: evidenceCount,
      capped_by: ['historical_settlement_lookahead_risk', 'no_funnel_timeseries', 'no_per_task_boost_window'],
    },
    signals: {
      previous_15m: previous,
      current_15m: current,
      combined_30m: combined,
      flow_ratio_15m: round(flowRatio),
      roi_retention_15m: round(roiRetention),
      crossed_total_capacity: capacityPressure,
      funnel_corroboration: funnelSignal,
    },
    attribution,
    route_candidates: buildRouteCandidates(state, attribution),
    calibration,
    reason_codes: [
      ...(priorStrong ? ['CONTINUOUS_PROFIT_BASELINE'] : []),
      ...(expanded ? ['FLOW_EXPANSION_GE_THRESHOLD'] : []),
      ...(weakening ? ['ROI_RETENTION_WEAKENING'] : []),
      ...(capacityPressure ? ['TOTAL_CAPACITY_REACHED'] : []),
      ...funnelSignal.signals,
    ],
    caveat: '该信号不能证明平台主观注水，也不能单独授权投放写操作',
  };
}

module.exports = {
  PREDICTOR_VERSION,
  evaluateExpansionDilutionShadow,
  normalizeTrend,
  summarizeWindow,
  inferAttribution,
  resolveCalibration,
  unavailable,
};
