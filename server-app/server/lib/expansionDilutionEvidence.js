'use strict';

const crypto = require('node:crypto');

/**
 * 扩量稀释 Shadow 的前向证据封装。
 *
 * 这里保存“评估当时实际可见的数据”，避免终场回流改写历史趋势后，
 * 再用终值倒推出一个当时并不存在的预警。该模块只整理证据，不做决策。
 */

const BUCKET_MS = 5 * 60 * 1000;
const PREDICTOR_NAME = 'expansion_dilution_shadow';
const PREDICTOR_VERSION = '1.1.0';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePlatformTime(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    return number < 1e12 ? number * 1000 : number;
  }
  const text = String(value).trim();
  const localMatch = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  const normalized = localMatch
    ? `${localMatch[1]}T${localMatch[2]}+08:00`
    : text;
  return Date.parse(normalized);
}

function isoOrNull(value) {
  const ms = parsePlatformTime(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function selectVisibleBuckets(trend, windowAsOf) {
  const cutoffMs = parsePlatformTime(windowAsOf);
  if (!Number.isFinite(cutoffMs)) return [];
  return (Array.isArray(trend) ? trend : [])
    .filter(point => point && typeof point === 'object')
    .map(point => {
      const rawTime = point.time || point.point_time || point.as_of || null;
      const ts = parsePlatformTime(rawTime);
      return {
        ts,
        time: isoOrNull(rawTime),
        bucket_end: Number.isFinite(ts) ? new Date(ts + BUCKET_MS).toISOString() : null,
        cost: finite(point.cost ?? point.delta_spend),
        net_gmv_1h: finite(point.gmvSettle ?? point.net_1h ?? point.delta_net_gmv),
        cost_data_valid: point.costDataValid === true,
        net_data_valid: point.netDataValid === true,
      };
    })
    .filter(row => Number.isFinite(row.ts) && row.ts + BUCKET_MS <= cutoffMs)
    .sort((left, right) => left.ts - right.ts)
    .slice(-6)
    .map(({ ts, ...row }) => row);
}

function pickMarginalM15(marginal) {
  const source = marginal && marginal.m15 || {};
  return {
    as_of: isoOrNull(source.as_of),
    data_quality: source.data_quality || null,
    flow_split_quality: source.flow_split_quality || null,
    total_spend_rate_hour: finite(source.total_spend_rate_hour ?? source.spend_rate_hour),
    basic_spend_rate_hour: finite(source.basic_spend_rate_hour),
    assist_spend_rate_hour: finite(source.assist_spend_rate_hour),
    assist_share_pct: finite(source.assist_share_pct),
    marginal_net_roi: finite(source.marginal_net_roi),
  };
}

function pickFunnel(funnel) {
  const source = funnel || {};
  return {
    watch_to_click_rate: finite(source.watchToClickRate ?? source.watch_to_click_rate),
    click_to_pay_rate: finite(source.clickToPayRate ?? source.click_to_pay_rate),
    data_quality: source.data_quality || source.dataQuality || null,
    source_at: isoOrNull(source.source_at || source.sourceAt || source.as_of),
  };
}

function pickBaselineStage(stage) {
  const structured = stage && typeof stage === 'object' && !Array.isArray(stage);
  const rawValue = structured && Object.prototype.hasOwnProperty.call(stage, 'value')
    ? stage.value
    : stage;
  return {
    value: finite(rawValue),
    sample_size: structured ? finite(stage.sample_size) : null,
    source: structured && stage.source != null ? String(stage.source) : null,
    updated_at: structured ? isoOrNull(stage.updated_at) : null,
    unit: structured && stage.unit != null ? String(stage.unit) : null,
  };
}

function pickFunnelBaseline(profile) {
  const baseline = profile && profile.funnel_baseline || {};
  const stages = baseline && baseline.stages || {};
  return {
    window_days: finite(baseline.window_days),
    stages: {
      product_click_rate: pickBaselineStage(stages.product_click_rate),
      payment_rate: pickBaselineStage(stages.payment_rate),
    },
  };
}

function buildExpansionDilutionEvidence(input = {}) {
  const shadow = input.shadow || {};
  const evaluatedAt = isoOrNull(input.evaluatedAt);
  const sourceAt = isoOrNull(input.sourceAt || input.trendInfo && input.trendInfo.fetchedAt);
  const sessionKey = shadow.session_key || input.sessionKey || null;
  if (!evaluatedAt || !sourceAt || !sessionKey) return null;
  const cutoffMs = Math.min(parsePlatformTime(evaluatedAt), parsePlatformTime(sourceAt));
  const requestedWindow = shadow.as_of || input.windowAsOf || null;
  const requestedWindowMs = parsePlatformTime(requestedWindow);
  // Shadow.as_of 是模型声称的观测窗口，不是比采集水位更高的事实来源。
  // 不能把未来窗口上得出的模型结论“夹紧”后重贴到较早窗口；
  // 一旦显式 as_of 越过 min(evaluated_at, source_at)，整条证据拒绝落盘。
  if (requestedWindow && (!Number.isFinite(requestedWindowMs) || requestedWindowMs > cutoffMs)) return null;
  const selectionCutoffMs = Number.isFinite(requestedWindowMs) ? requestedWindowMs : cutoffMs;
  const selectionCutoff = isoOrNull(selectionCutoffMs);
  const closedBuckets = selectVisibleBuckets(
    input.trendInfo && input.trendInfo.trend,
    selectionCutoff,
  );
  const lastClosedAt = closedBuckets.length ? closedBuckets.at(-1).bucket_end : null;
  const fallbackWindowMs = Number.isFinite(selectionCutoffMs)
    ? Math.floor(selectionCutoffMs / BUCKET_MS) * BUCKET_MS
    : NaN;
  const windowAsOf = isoOrNull(lastClosedAt || fallbackWindowMs);
  if (!windowAsOf) return null;
  return {
    schema_version: '1.0',
    predictor_name: PREDICTOR_NAME,
    predictor_version: shadow.predictor_version || PREDICTOR_VERSION,
    account_id: String(input.accountId || ''),
    session_key: String(sessionKey),
    source_at: sourceAt,
    window_as_of: windowAsOf,
    evaluated_at: evaluatedAt,
    input: {
      guards: {
        is_live: input.isLive === true,
        room_conflict: input.roomConflict === true,
        collector_stale: input.collectorStale === true,
        strict_net_available: input.strictNetAvailable === true,
      },
      closed_5m_buckets: closedBuckets,
      marginal_m15: pickMarginalM15(input.marginal),
      funnel: pickFunnel(input.funnel),
      funnel_baseline: pickFunnelBaseline(input.profile),
      calibration: shadow.calibration || null,
    },
    output: {
      status: shadow.status || null,
      state: shadow.state || null,
      risk_level: shadow.risk_level || null,
      confidence: shadow.confidence || null,
      signals: shadow.signals || null,
      attribution: shadow.attribution || null,
      reason_codes: Array.isArray(shadow.reason_codes) ? shadow.reason_codes : [],
    },
  };
}

function evidenceInputHash(evidence) {
  if (!evidence || typeof evidence !== 'object' || !evidence.input) return null;
  const ready = evidence.output && evidence.output.status === 'ready';
  // source_at/评估墙钟不是模型特征；同一闭桶、同一实际输入的重复座舱请求必须幂等。
  // 非 ready 状态也不把尚未参与判定的累计漏斗/流速拆分混进哈希，避免轮询膨胀。
  const funnel = evidence.input.funnel || {};
  const marginal = evidence.input.marginal_m15 || {};
  const calibration = evidence.input.calibration || {};
  const funnelBaseline = evidence.input.funnel_baseline || {};
  const baselineStages = funnelBaseline.stages || {};
  const productClickBaseline = baselineStages.product_click_rate || {};
  const paymentBaseline = baselineStages.payment_rate || {};
  const modelCalibration = {
    profit_roi: calibration.profit_roi,
    floor_roi: calibration.floor_roi,
    expansion_ratio: calibration.expansion_ratio,
    roi_retention_max: calibration.roi_retention_max,
    min_window_spend: calibration.min_window_spend,
    min_window_net_gmv: calibration.min_window_net_gmv,
    total_capacity: calibration.total_capacity,
  };
  const modelInput = ready ? {
    guards: evidence.input.guards,
    closed_5m_buckets: evidence.input.closed_5m_buckets,
    calibration: modelCalibration,
    funnel: {
      watch_to_click_rate: funnel.watch_to_click_rate,
      click_to_pay_rate: funnel.click_to_pay_rate,
    },
    funnel_baseline: {
      window_days: funnelBaseline.window_days,
      stages: {
        product_click_rate: {
          value: productClickBaseline.value,
          sample_size: productClickBaseline.sample_size,
          source: productClickBaseline.source,
          unit: productClickBaseline.unit,
        },
        payment_rate: {
          value: paymentBaseline.value,
          sample_size: paymentBaseline.sample_size,
          source: paymentBaseline.source,
          unit: paymentBaseline.unit,
        },
      },
    },
    marginal_m15: {
      flow_split_quality: marginal.flow_split_quality,
      basic_spend_rate_hour: marginal.basic_spend_rate_hour,
      assist_spend_rate_hour: marginal.assist_spend_rate_hour,
    },
  } : {
    guards: evidence.input.guards,
    closed_5m_buckets: evidence.input.closed_5m_buckets,
    calibration: modelCalibration,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      predictor_name: evidence.predictor_name,
      predictor_version: evidence.predictor_version,
      window_as_of: evidence.window_as_of,
      input: modelInput,
    }))
    .digest('hex');
}

function toLedgerEvaluation(evidence) {
  const inputHash = evidenceInputHash(evidence);
  if (!inputHash) return null;
  return {
    schema_version: evidence.schema_version,
    session_key: evidence.session_key,
    window_as_of: evidence.window_as_of,
    source_at: evidence.source_at,
    evaluated_at: evidence.evaluated_at,
    input_hash: inputHash,
    status: evidence.output && evidence.output.status,
    state: evidence.output && evidence.output.state,
    risk_level: evidence.output && evidence.output.risk_level,
    payload: evidence,
  };
}

module.exports = {
  PREDICTOR_NAME,
  PREDICTOR_VERSION,
  buildExpansionDilutionEvidence,
  evidenceInputHash,
  selectVisibleBuckets,
  toLedgerEvaluation,
};
