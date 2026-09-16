/**
 * 决策后验打分引擎 v2。
 * 只使用服务端持久化的同账号、同场次可信快照；无量化预期标记
 * unscorable，不再用默认 0.5 污染胜率。
 */
'use strict';

const http = require('http');
// 退役评分公式：仅供历史审计与隔离测试，服务不可导入。
const ledger = require('../lib/decisionLedger');
const { PORT, QIANCHUAN_ACCOUNTS } = require('../lib/config');

const API_BASE = `http://127.0.0.1:${PORT}/api`;
const EVALUATOR_VERSION = '2.0';
const accountFlights = new Map();
let globalFlight = null;
const SCORE_RULES = [
  { min: 0.9, score: 1.0 }, { min: 0.7, score: 0.8 },
  { min: 0.5, score: 0.5 }, { min: 0.3, score: 0.3 },
  { min: 0, score: 0 },
];

function fetchJson(urlStr, timeoutMs = 55000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const req = http.get(urlStr, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (Buffer.byteLength(data, 'utf8') > 2 * 1024 * 1024) {
          req.destroy(Object.assign(new Error('后验响应体超过2MB'), { code: 'response_too_large' }));
        }
      });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300 || body && body.ok === false) {
            const error = new Error(body && (body.error || body.message) || `HTTP ${res.statusCode}`);
            error.code = body && body.code || `http_${res.statusCode}`;
            error.retryable = body && body.retryable === true || res.statusCode >= 500;
            return finish(reject, error);
          }
          finish(resolve, body);
        } catch (error) {
          finish(reject, Object.assign(new Error(`JSON 解析失败: ${error.message}`), { code: 'parse_error' }));
        }
      });
    });
    req.on('error', error => finish(reject, error));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`后验取数超过 ${timeoutMs}ms`), { code: 'timeout' })));
  });
}

function mapToScore(achievement) {
  return SCORE_RULES.find(rule => achievement >= rule.min).score;
}

function evaluationAt(record) {
  if (record && record.evaluation_after && Number.isFinite(Date.parse(record.evaluation_after))) {
    return new Date(record.evaluation_after).toISOString();
  }
  const base = Date.parse(record && (record.observed_at || record.recorded_at || record.time || record.timestamp));
  if (!Number.isFinite(base)) return null;
  const judgments = Array.isArray(record.judgments) ? record.judgments : (Array.isArray(record.decisions) ? record.decisions : []);
  const minutes = Number(record.check_after_minutes || judgments[0] && judgments[0].check_after_minutes) || 120;
  return new Date(base + Math.max(5, minutes) * 60000).toISOString();
}

function shouldEvaluate(record, now = Date.now()) {
  const at = evaluationAt(record);
  return !!at && now >= Date.parse(at);
}

function expectationItems(record) {
  const judgments = Array.isArray(record.judgments) ? record.judgments : (Array.isArray(record.decisions) ? record.decisions : []);
  const items = judgments.filter(item => item && item.expected_metrics && typeof item.expected_metrics === 'object')
    .map(item => ({ code: item.code || null, expected_metrics: item.expected_metrics }));
  if (!items.length && record.expected_effect && typeof record.expected_effect === 'object') {
    const { check_after_minutes: _ignored, ...expected } = record.expected_effect;
    if (Object.keys(expected).length) items.push({ code: 'EXPECTED_EFFECT', expected_metrics: expected });
  }
  return items;
}

function usableSnapshot(snapshot, accountId, sessionKey) {
  const meta = snapshot && snapshot.meta || {};
  return !!(snapshot && snapshot.snapshot_id
    && String(meta.account_id || '') === String(accountId || '')
    && String(meta.session_key || '') === String(sessionKey || '')
    && meta.data_valid === true && meta.stale !== true && meta.partial !== true
    && meta.freshness === 'fresh' && Number.isFinite(Date.parse(meta.source_at)));
}

function ratioForMin(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
  if (actual >= expected) return 1;
  return expected > 0 ? Math.max(0, actual / expected) : 0;
}

function ratioForMax(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
  if (actual <= expected) return 1;
  return actual > 0 && expected >= 0 ? Math.max(0, expected / actual) : 0;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricDelta(before, after) {
  const b = finite(before), a = finite(after);
  return b == null || a == null ? null : a - b;
}

function scoreRound(record, before, after) {
  const expectedItems = expectationItems(record);
  if (!expectedItems.length) {
    return { status: 'unscorable', score: null, reason: 'missing_expected_metrics', details: { achievements: [] } };
  }
  if (!usableSnapshot(before, record.account_id, record.session_key)) {
    return { status: 'unscorable', score: null, reason: 'unverified_before_snapshot', details: { achievements: [] } };
  }
  if (!usableSnapshot(after, record.account_id, record.session_key)) return null;

  const b = before.metrics || {};
  const a = after.metrics || {};
  const achievements = [];
  const add = (kind, metric, expected, actual) => {
    const expectedNumber = finite(expected);
    const actualNumber = finite(actual);
    const achievement = kind === 'max'
      ? ratioForMax(actualNumber, expectedNumber)
      : ratioForMin(actualNumber, expectedNumber);
    if (achievement != null) achievements.push({ metric, expected: expectedNumber, actual: actualNumber, achievement });
  };
  for (const item of expectedItems) {
    const expected = item.expected_metrics || {};
    const roiMin = expected.net_roi_min != null ? expected.net_roi_min : expected.overall_roi_min;
    if (roiMin != null) add('min', 'net_roi_min', roiMin, a.net_roi);
    if (expected.net_roi_delta_min != null) add('min', 'net_roi_delta_min', expected.net_roi_delta_min, metricDelta(b.net_roi, a.net_roi));
    if (expected.net_gmv_delta_min != null) add('min', 'net_gmv_delta_min', expected.net_gmv_delta_min, metricDelta(b.net_gmv, a.net_gmv));
    if (expected.orders_delta_min != null) add('min', 'orders_delta_min', expected.orders_delta_min, metricDelta(b.orders, a.orders));
    if (expected.spend_delta_min != null) add('min', 'spend_delta_min', expected.spend_delta_min, metricDelta(b.spend, a.spend));
    if (expected.spend_delta_max != null) add('max', 'spend_delta_max', expected.spend_delta_max, metricDelta(b.spend, a.spend));
  }
  if (!achievements.length) {
    return { status: 'unscorable', score: null, reason: 'unsupported_or_missing_metrics', details: { achievements: [] } };
  }

  const total = achievements.reduce((sum, item) => sum + item.achievement, 0) / achievements.length;
  const score = mapToScore(total);
  const verifiedActions = (record.actions || []).filter(action => action && action.verified === true && action.success === true);
  const targetAt = evaluationAt(record);
  const lagMs = Date.parse(after.meta.source_at) - Date.parse(targetAt);
  return {
    status: total >= 0.7 ? 'success' : total >= 0.4 ? 'partial' : 'failed',
    score,
    reason: null,
    details: {
      evaluator_version: EVALUATOR_VERSION,
      evaluation_type: verifiedActions.length ? 'verified_action' : 'forecast_only',
      verified_operation_ids: verifiedActions.map(action => action.operation_id),
      target_at: targetAt,
      before_snapshot_id: before.snapshot_id,
      before_source_at: before.meta.source_at,
      after_snapshot_id: after.snapshot_id,
      after_source_at: after.meta.source_at,
      after_lag_ms: lagMs,
      confidence: lagMs <= 15 * 60000 ? 'high' : 'medium',
      before_metrics: b,
      after_metrics: a,
      achievements,
      total_achievement: +total.toFixed(4),
    },
  };
}

async function runAccountEvaluation(accountId, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const baseDir = options.baseDir;
  await ledger.importLegacyDecisions(accountId, { baseDir });
  const records = ledger.listPendingRounds(accountId, {
    baseDir, limit: options.limit || 500, dueBefore: new Date(now).toISOString(),
  });
  if (!records.length) return 0;

  if (options.refreshSummary !== false) {
    try {
      await (options.fetchJson || fetchJson)(`${API_BASE}/live-summary?account=${encodeURIComponent(accountId)}`, 55000);
    } catch (error) {
      if (options.onError) options.onError(error);
    }
  }

  let count = 0;
  for (const record of records) {
    try {
      if (!shouldEvaluate(record, now)) continue;
      const before = record.snapshot && record.snapshot.verified === true ? record.snapshot : null;
      let result;
      if (!expectationItems(record).length || !usableSnapshot(before, accountId, record.session_key)) {
        result = scoreRound(record, before, null);
      } else {
        const after = ledger.findEvaluationSnapshot(accountId, record.session_key, evaluationAt(record), {
          baseDir, maxLagMs: options.maxLagMs == null ? 45 * 60000 : options.maxLagMs,
        });
        result = scoreRound(record, before, after);
      }
      if (!result) continue;
      const attached = ledger.attachOutcome(accountId, record.round_id, {
        status: result.status, score: result.score, reason: result.reason, details: result.details,
      }, { baseDir, evaluatedAt: new Date(now).toISOString(), outcomeVersion: EVALUATOR_VERSION });
      if (!attached.duplicate) count++;
    } catch (error) {
      if (options.onError) options.onError(error, record);
      else console.error(`[evaluate-decisions] [${accountId}] ${record.round_id}: ${error.code || error.message}`);
    }
  }
  return count;
}

function evaluateAccountDecisions(accountId, options = {}) {
  if (accountFlights.has(accountId)) return accountFlights.get(accountId);
  const flight = runAccountEvaluation(accountId, options).finally(() => accountFlights.delete(accountId));
  accountFlights.set(accountId, flight);
  return flight;
}

async function runAll(options = {}) {
  let total = 0;
  for (const account of (options.accounts || QIANCHUAN_ACCOUNTS || [])) {
    total += await evaluateAccountDecisions(account.id || account, options);
  }
  return total;
}

function evaluatePendingDecisions(options = {}) {
  if (globalFlight) return globalFlight;
  globalFlight = runAll(options).finally(() => { globalFlight = null; });
  return globalFlight;
}

if (require.main === module) {
  evaluatePendingDecisions()
    .then(count => console.log(`[evaluate-decisions] 本轮完成 ${count} 条到期决策评估`))
    .catch(error => { console.error('[evaluate-decisions] 评估异常:', error.message); process.exitCode = 1; });
}

module.exports = {
  EVALUATOR_VERSION, evaluatePendingDecisions, evaluateAccountDecisions,
  shouldEvaluate, evaluationAt, expectationItems, usableSnapshot, scoreRound, mapToScore,
  _test: { accountFlights, getGlobalFlight: () => globalFlight },
};
