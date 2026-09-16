'use strict';

/**
 * 实时盘面历史动力影子层。
 *
 * 历史文件解析和模型训练放在 Worker 中，避免阻塞 HTTP 事件循环。当前进程只保存
 * 小型系数和验证摘要；模型只触发专项诊断，不产生任何投放写动作。
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  normalizeSession,
  buildCurrentFeatureSample,
  predictLogistic,
} = require('./liveDynamicsBacktest');

const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const REPLAY_DIR = path.join(__dirname, '..', '..', 'storage', 'replay');
const WORKER_PATH = path.join(__dirname, 'liveDynamicsModelWorker.js');
const states = new Map();

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function publicState(state) {
  return {
    trained_at: state && state.trainedAt ? new Date(state.trainedAt).toISOString() : null,
    training_samples: state && state.result && state.result.samples || 0,
    training_sessions: state && state.result && state.result.sessions || 0,
    validation: state && state.result && state.result.validation || null,
  };
}

function launchTraining(accountId, cfg) {
  const existing = states.get(accountId);
  const now = Date.now();
  if (existing && existing.training) return existing;
  if (existing && existing.result && now - existing.trainedAt < MODEL_TTL_MS) return existing;
  if (existing && existing.lastErrorAt && now - existing.lastErrorAt < RETRY_AFTER_MS) return existing;

  const state = existing || { result: null, trainedAt: null, lastError: null, lastErrorAt: null };
  state.training = true;
  states.set(accountId, state);
  const worker = new Worker(WORKER_PATH, {
    workerData: {
      replayDir: REPLAY_DIR,
      accountId,
      options: {
        breakEven: cfg.break_even_roi,
        floorRoi: cfg.floor_roi,
        horizonMinutes: 30,
        historyMinutes: 60,
        minHistorySpend: 10,
        minFutureSpend: 5,
      },
    },
  });
  worker.unref();
  worker.once('message', message => {
    state.training = false;
    if (message && message.ok) {
      state.result = message;
      state.trainedAt = Date.now();
      state.lastError = null;
      state.lastErrorAt = null;
    } else {
      state.lastError = message && message.error || 'model_worker_failed';
      state.lastErrorAt = Date.now();
    }
  });
  worker.once('error', error => {
    state.training = false;
    state.lastError = error.message;
    state.lastErrorAt = Date.now();
  });
  worker.once('exit', code => {
    if (state.training) {
      state.training = false;
      if (code !== 0) {
        state.lastError = `model_worker_exit_${code}`;
        state.lastErrorAt = Date.now();
      }
    }
  });
  return state;
}

function reasonsFor(features) {
  const reasons = [];
  if (['deep_loss', 'below_floor'].includes(features.roi_band)) reasons.push('RECENT_30M_ROI_BELOW_FLOOR');
  if (features.roi_direction === 'weakening') reasons.push('ROI_MOMENTUM_WEAKENING');
  if (['expanding', 'surging'].includes(features.flow_band) && features.roi_band !== 'strong_profit') {
    reasons.push('FLOW_EXPANDING_WITHOUT_STRONG_PROFIT');
  }
  if (['stalled', 'contracting'].includes(features.flow_band)) reasons.push('FLOW_CONTRACTING');
  return reasons.slice(0, 3);
}

function unavailable(status, extra = {}) {
  return {
    shadow_only: true,
    actionable: false,
    allowed_use: 'diagnose_only',
    status,
    risk_level: 'unavailable',
    future_30m_risk_percentile: null,
    profitability_score: null,
    trigger_special_diagnosis: false,
    opportunity_scale_ready: false,
    ...extra,
  };
}

function empiricalRiskPercentile(sortedScores, score) {
  if (!Array.isArray(sortedScores) || !sortedScores.length || !Number.isFinite(score)) return null;
  let lo = 0;
  let hi = sortedScores.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedScores[mid] <= score) lo = mid + 1;
    else hi = mid;
  }
  return 1 - lo / sortedScores.length;
}

function getLiveDynamicsShadow({ accountId, isLive, roomConflict, collectorStale, strictNetAvailable, trendInfo, cfg }) {
  // 即使休播也在 Worker 中预热历史模型；开播后的第一轮无需临时解析历史文件。
  const state = launchTraining(accountId, cfg);
  if (!isLive) return unavailable('offline', publicState(state));
  if (roomConflict) return unavailable('conflicted');
  if (collectorStale) return unavailable('stale');
  if (!strictNetAvailable) return unavailable('source_metric_missing');
  if (!trendInfo || !Array.isArray(trendInfo.trend)) return unavailable('trend_missing');
  if (trendInfo.trend.some(point => point.netDataValid === false || point.costDataValid === false)) {
    return unavailable('source_metric_missing');
  }

  if (!state.result) {
    return unavailable(state.training ? 'warming' : 'model_unavailable', {
      error: state.lastError || null,
      ...publicState(state),
    });
  }
  if (!state.result.validation || state.result.validation.risk_triage_shadow !== true) {
    return unavailable('validation_gate_failed', publicState(state));
  }

  const room = trendInfo.room || {};
  const normalized = normalizeSession({ room, trend: trendInfo.trend }, 'live_memory', accountId);
  if (!normalized) return unavailable('current_session_invalid', publicState(state));
  const current = buildCurrentFeatureSample(normalized, {
    breakEven: cfg.break_even_roi,
    floorRoi: cfg.floor_roi,
    historyMinutes: 60,
    minHistorySpend: 10,
  });
  if (!current.sample) return unavailable(String(current.reason || 'insufficient_history').toLowerCase(), publicState(state));

  const profitabilityIndex = predictLogistic(state.result.model, current.sample);
  const riskPercentile = empiricalRiskPercentile(state.result.score_distribution, profitabilityIndex);
  const riskLevel = riskPercentile >= 0.8 ? 'high' : (riskPercentile >= 0.5 ? 'elevated' : 'normal');
  return {
    shadow_only: true,
    actionable: false,
    allowed_use: 'diagnose_only',
    status: 'ready',
    risk_level: riskLevel,
    future_30m_risk_percentile: round(riskPercentile),
    profitability_score: round(profitabilityIndex),
    score_semantics: 'historical_rank_not_probability',
    confidence: 'medium',
    trigger_special_diagnosis: riskLevel === 'high',
    confirmation_rounds_required: 2,
    opportunity_scale_ready: state.result.validation.opportunity_scale_shadow === true,
    reasons: reasonsFor(current.sample.features),
    evidence: {
      as_of: current.sample.anchor_time,
      recent_30m_net_roi: current.sample.features.recent_30_net_roi,
      previous_30m_net_roi: current.sample.features.previous_30_net_roi,
      flow_ratio_30m: current.sample.features.flow_ratio_30m,
      roi_direction: current.sample.features.roi_direction,
    },
    model: {
      family: 'historical_live_dynamics',
      version: '1.0-shadow',
      ...publicState(state),
    },
  };
}

function clearLiveDynamicsModelCache() {
  states.clear();
}

module.exports = {
  getLiveDynamicsShadow,
  clearLiveDynamicsModelCache,
  reasonsFor,
  unavailable,
  empiricalRiskPercentile,
};
