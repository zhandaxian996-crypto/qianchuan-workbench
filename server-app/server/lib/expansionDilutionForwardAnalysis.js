'use strict';

/**
 * 扩量稀释 Shadow 的前向验证分析器。
 *
 * 输入必须是 decisionLedger.listShadowEvaluations 返回的“当时可见证据”。
 * 分析器只做观察性统计：同一账号/场次/窗口永远采用最早入账的修订，
 * 再寻找至少经过指定 horizon 的第一个同场观测，禁止读取终场 replay。
 */

const DEFAULT_HORIZON_MINUTES = 15;
const BUCKET_MS = 5 * 60 * 1000;
const BUCKET_TIME_TOLERANCE_MS = 5_000;
const WARNING_STATES = new Set([
  'DILUTION_WARNING',
  'DILUTION_RISK_HIGH',
  // 兼容早期证据里可能出现的简写，不将它扩展到其他状态。
  'RISK_HIGH',
]);

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timeMs(value) {
  if (value == null || value === '') return NaN;
  return Date.parse(value);
}

function firstText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function recordState(record) {
  return firstText(record && record.state, record && record.payload && record.payload.output && record.payload.output.state) || 'UNKNOWN';
}

function displayedCurrent15mNetRoi(record) {
  const payload = record && record.payload || {};
  return finite(
    (payload.output && payload.output.signals && payload.output.signals.current_15m && payload.output.signals.current_15m.net_roi) ??
    (payload.output && payload.output.current_15m && payload.output.current_15m.net_roi) ??
    (payload.signals && payload.signals.current_15m && payload.signals.current_15m.net_roi),
  );
}

function rawCurrent15mMetric(record, windowMs) {
  const payload = record && record.payload || {};
  const buckets = payload.input && payload.input.closed_5m_buckets;
  if (!Array.isArray(buckets)) {
    const displayed = displayedCurrent15mNetRoi(record);
    return {
      value: displayed,
      source: displayed == null ? 'unavailable' : 'legacy_display_current_15m_net_roi',
      precision: displayed == null ? 'unavailable' : 'rounded_display',
      formal_eligible: false,
      reason: displayed == null
        ? 'forward_current_15m_net_roi_missing'
        : 'forward_metric_precision_degraded',
    };
  }
  if (buckets.length < 3) {
    return {
      value: null,
      source: 'closed_5m_buckets_raw',
      precision: 'unavailable',
      formal_eligible: false,
      reason: 'forward_raw_15m_insufficient_buckets',
    };
  }

  // 只能使用窗口末尾三个桶；不能为得到标签而跳过最新无效桶去挑更早的连续段。
  const rows = buckets.slice(-3).map(bucket => {
    const source = bucket && typeof bucket === 'object' ? bucket : {};
    const time = timeMs(source.time || source.point_time || source.as_of);
    return {
      time,
      cost: finite(source.cost ?? source.delta_spend),
      net: finite(source.net_gmv_1h ?? source.gmvSettle ?? source.net_1h ?? source.delta_net_gmv),
      valid: (source.cost_data_valid === true || source.costDataValid === true) &&
        (source.net_data_valid === true || source.netDataValid === true),
    };
  });
  if (rows.some(row => !Number.isFinite(row.time) || !row.valid || row.cost == null || row.net == null)) {
    return {
      value: null,
      source: 'closed_5m_buckets_raw',
      precision: 'unavailable',
      formal_eligible: false,
      reason: 'forward_raw_15m_invalid_bucket',
    };
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (Math.abs(rows[index].time - rows[index - 1].time - BUCKET_MS) > BUCKET_TIME_TOLERANCE_MS) {
      return {
        value: null,
        source: 'closed_5m_buckets_raw',
        precision: 'unavailable',
        formal_eligible: false,
        reason: 'forward_raw_15m_non_contiguous',
      };
    }
  }
  if (!Number.isFinite(windowMs) ||
      Math.abs(rows.at(-1).time + BUCKET_MS - windowMs) > BUCKET_TIME_TOLERANCE_MS) {
    return {
      value: null,
      source: 'closed_5m_buckets_raw',
      precision: 'unavailable',
      formal_eligible: false,
      reason: 'forward_raw_15m_window_mismatch',
    };
  }
  const cost = rows.reduce((sum, row) => sum + Math.max(0, row.cost), 0);
  const netGmv = rows.reduce((sum, row) => sum + row.net, 0);
  if (!(cost > 0)) {
    return {
      value: null,
      source: 'closed_5m_buckets_raw',
      precision: 'unavailable',
      formal_eligible: false,
      reason: 'forward_raw_15m_cost_not_positive',
    };
  }
  return {
    value: netGmv / cost,
    source: 'closed_5m_buckets_raw_recomputed',
    precision: 'full_input_precision',
    formal_eligible: true,
    cost,
    net_gmv_1h: netGmv,
    reason: null,
  };
}

function triggerFloorRoi(record) {
  const payload = record && record.payload || {};
  return finite(
    (payload.input && payload.input.calibration && payload.input.calibration.floor_roi) ??
    (payload.calibration && payload.calibration.floor_roi) ??
    (payload.output && payload.output.calibration && payload.output.calibration.floor_roi),
  );
}

function normalizeRecord(record, inputIndex) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const accountId = firstText(record.account_id, payload.account_id);
  const sessionKey = firstText(record.session_key, payload.session_key);
  const windowAsOf = firstText(record.window_as_of, payload.window_as_of);
  const recordedAt = firstText(record.recorded_at, payload.recorded_at);
  const evaluatedAt = firstText(record.evaluated_at, payload.evaluated_at);
  const windowMs = timeMs(windowAsOf);
  const recordedMs = timeMs(recordedAt);
  const evaluatedMs = timeMs(evaluatedAt);
  if (!accountId || !sessionKey || !Number.isFinite(windowMs) ||
      !Number.isFinite(recordedMs) || !Number.isFinite(evaluatedMs)) return null;
  const current15mMetric = rawCurrent15mMetric(record, windowMs);
  return {
    record,
    input_index: inputIndex,
    account_id: accountId,
    session_key: sessionKey,
    window_as_of: new Date(windowMs).toISOString(),
    window_ms: windowMs,
    recorded_at: new Date(recordedMs).toISOString(),
    recorded_ms: recordedMs,
    evaluated_at: new Date(evaluatedMs).toISOString(),
    evaluated_ms: evaluatedMs,
    evaluation_id: firstText(record.evaluation_id) || null,
    state: recordState(record),
    current_15m_net_roi: current15mMetric.value,
    current_15m_metric: current15mMetric,
    floor_roi: triggerFloorRoi(record),
  };
}

function firstSeenComparator(left, right) {
  return left.recorded_ms - right.recorded_ms ||
    left.evaluated_ms - right.evaluated_ms ||
    String(left.evaluation_id || '').localeCompare(String(right.evaluation_id || '')) ||
    left.input_index - right.input_index;
}

function observationComparator(left, right) {
  return left.window_ms - right.window_ms || firstSeenComparator(left, right);
}

function firstSeenByWindow(records) {
  const normalized = [];
  let invalidRecords = 0;
  (Array.isArray(records) ? records : []).forEach((record, index) => {
    const row = normalizeRecord(record, index);
    if (row) normalized.push(row);
    else invalidRecords += 1;
  });

  const selected = new Map();
  for (const row of normalized) {
    const key = [row.account_id, row.session_key, row.window_as_of].join('\u0000');
    const existing = selected.get(key);
    if (!existing || firstSeenComparator(row, existing) < 0) selected.set(key, row);
  }

  return {
    observations: [...selected.values()].sort(observationComparator),
    invalid_records: invalidRecords,
    ignored_revisions: normalized.length - selected.size,
  };
}

function distribution(values) {
  const counts = {};
  for (const value of values) {
    const key = firstText(value) || 'UNKNOWN';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function publicObservation(row) {
  return {
    evaluation_id: row.evaluation_id,
    account_id: row.account_id,
    session_key: row.session_key,
    window_as_of: row.window_as_of,
    evaluated_at: row.evaluated_at,
    recorded_at: row.recorded_at,
    state: row.state,
    current_15m_net_roi: row.current_15m_net_roi,
    current_15m_metric_source: row.current_15m_metric.source,
    current_15m_metric_precision: row.current_15m_metric.precision,
    current_15m_metric_formal_eligible: row.current_15m_metric.formal_eligible,
  };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function analyzeExpansionDilutionForward(records, options = {}) {
  const horizonMinutes = Math.max(15, finite(options.horizonMinutes) || DEFAULT_HORIZON_MINUTES);
  const horizonMs = horizonMinutes * 60 * 1000;
  const selected = firstSeenByWindow(records);
  const observations = selected.observations;
  const bySession = new Map();

  for (const row of observations) {
    const key = `${row.account_id}\u0000${row.session_key}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
  }

  const triggers = observations.filter(row => WARNING_STATES.has(row.state));
  const matured = [];
  const unmatured = [];

  for (const trigger of triggers) {
    const sessionRows = bySession.get(`${trigger.account_id}\u0000${trigger.session_key}`) || [];
    const eligibleAt = trigger.window_ms + horizonMs;
    const outcome = sessionRows.find(row => row.window_ms >= eligibleAt);
    const triggerPublic = {
      ...publicObservation(trigger),
      floor_roi: trigger.floor_roi,
    };

    if (!outcome) {
      unmatured.push({
        trigger: triggerPublic,
        eligible_at: new Date(eligibleAt).toISOString(),
        reason: 'forward_observation_not_yet_available',
      });
      continue;
    }
    if (!Number.isFinite(trigger.floor_roi)) {
      unmatured.push({
        trigger: triggerPublic,
        eligible_at: new Date(eligibleAt).toISOString(),
        first_forward_observation: publicObservation(outcome),
        reason: 'trigger_floor_roi_missing',
      });
      continue;
    }
    if (!outcome.current_15m_metric.formal_eligible || !Number.isFinite(outcome.current_15m_net_roi)) {
      unmatured.push({
        trigger: triggerPublic,
        eligible_at: new Date(eligibleAt).toISOString(),
        first_forward_observation: publicObservation(outcome),
        reason: outcome.current_15m_metric.reason || 'forward_current_15m_net_roi_missing',
      });
      continue;
    }

    const label = outcome.current_15m_net_roi < trigger.floor_roi ? 'hit' : 'false_alarm';
    matured.push({
      trigger: triggerPublic,
      eligible_at: new Date(eligibleAt).toISOString(),
      first_forward_observation: publicObservation(outcome),
      forward_minutes: round((outcome.window_ms - trigger.window_ms) / 60_000, 2),
      label,
    });
  }

  const hit = matured.filter(item => item.label === 'hit').length;
  const falseAlarm = matured.filter(item => item.label === 'false_alarm').length;
  const sessions = new Set(observations.map(row => `${row.account_id}\u0000${row.session_key}`));

  return {
    schema_version: '1.0',
    analyzer_name: 'expansion_dilution_forward_analysis',
    observational_shadow_only: true,
    actionable: false,
    horizon_minutes: horizonMinutes,
    prediction_states: [...WARNING_STATES],
    outcome_definition: 'first_same_session_first_seen_observation_at_or_after_horizon.last_three_contiguous_valid_raw_5m_buckets.net_gmv_1h_sum_div_cost_sum_below_trigger_floor_roi',
    terminal_replay_used: false,
    selection_policy: {
      revision: 'earliest_recorded_at_then_evaluated_at_per_account_session_window',
      outcome: 'first_same_session_observation_at_or_after_horizon',
      metric: 'recompute_from_last_three_contiguous_valid_closed_5m_buckets; rounded_display_values_are_not_formally_matured',
    },
    coverage: {
      input_records: Array.isArray(records) ? records.length : 0,
      valid_records: (Array.isArray(records) ? records.length : 0) - selected.invalid_records,
      invalid_records: selected.invalid_records,
      first_seen_observations: observations.length,
      later_revisions_ignored: selected.ignored_revisions,
      sessions: sessions.size,
      warning_triggers: triggers.length,
    },
    state_distribution: {
      first_seen_observations: distribution(observations.map(row => row.state)),
      warning_triggers: distribution(triggers.map(row => row.state)),
      matured_triggers: distribution(matured.map(item => item.trigger.state)),
      current_15m_metric_sources: distribution(observations.map(row => row.current_15m_metric.source)),
      outcomes: { hit, false_alarm: falseAlarm },
    },
    matured: {
      count: matured.length,
      hit,
      false_alarm: falseAlarm,
      hit_rate: matured.length ? round(hit / matured.length) : null,
      evaluations: matured,
    },
    unmatured: {
      count: unmatured.length,
      reason_distribution: distribution(unmatured.map(item => item.reason)),
      evaluations: unmatured,
    },
    caveat: '结果仅验证前向关联形态，不证明平台主观注水，也不能单独授权任何投放写操作。',
  };
}

module.exports = {
  DEFAULT_HORIZON_MINUTES,
  WARNING_STATES,
  analyzeExpansionDilutionForward,
  firstSeenByWindow,
  rawCurrent15mMetric,
};
