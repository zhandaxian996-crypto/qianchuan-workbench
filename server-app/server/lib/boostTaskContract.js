'use strict';
const { finiteNumber: n } = require('./dataContract');
const { safeActionLimits, resumeProtection } = require('./actionLimits');
const { reconcileFinancial } = require('./watchContract');

function requestedSessionStart(sessionKey, sessionStartTime) {
  const raw = sessionStartTime ?? (typeof sessionKey === 'string' ? sessionKey.split('|').at(-1) : null);
  const at = Date.parse(raw || '');
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function boostTaskContract(raw, task, { accountId, sourceAt = null, start = null, end = null, sessionKey = null, sessionStartTime = null } = {}) {
  const bid = n(raw.bid);
  const operations = raw.assistTaskInfoMap && raw.assistTaskInfoMap['2'] && raw.assistTaskInfoMap['2'].operation || {};
  const permission = key => operations[key] && typeof operations[key].editable === 'boolean' ? operations[key].editable : null;
  const window = { start, end, scope: 'date_range' };
  const financial = reconcileFinancial({ spend: n(task.cost), payment_gmv: n(task.gmv), payment_roi: n(task.roi),
    net_gmv: n(task.net_gmv), net_roi: n(task.net_roi), orders: n(task.order_count) }, {}, window);
  const actionLimits = safeActionLimits(accountId, task.id);
  const actions = {};
  for (const [action, upstream] of Object.entries({ pause: operations.pause ? 'pause' : 'stop', resume: 'start', update_budget: 'edit', update_bid: 'edit', update_roi: 'edit', update_audience: 'edit', delete: 'delete' })) {
    const local = actionLimits[action];
    const upstreamAllowed = permission(upstream);
    const resume = action === 'resume' ? resumeProtection(accountId, task.id, task.status || raw.status, task.passive_stop) : null;
    const protection = resume?.allowed === false;
    actions[action] = { allowed: protection || upstreamAllowed === false || local && !local.allowed ? false : null,
      upstream_allowed: upstreamAllowed, local_allowed: local ? local.allowed : null,
      reason: protection ? resume.reason : upstreamAllowed === false
        ? (operations[upstream].reason || operations[upstream].message || 'upstream_action_blocked')
        : local && !local.allowed ? local.reason : 'write_precheck_required' };
  }
  // Numeric budgetMode enums have not been verified as daily/lifetime. Do not guess.
  const budgetScope = ['daily', 'lifetime'].includes(raw.budgetScope) ? raw.budgetScope : 'unknown';
  const matchedSpend = budgetScope === 'daily' && start && start === end ? n(task.cost)
    : budgetScope === 'lifetime' ? n(raw.lifetimeCostCny) : null;
  const progress = n(task.budget) > 0 && matchedSpend != null ? +(matchedSpend / task.budget * 100).toFixed(2) : null;
  // The task/detail APIs expose daily windows, not native per-session financial
  // totals. A matching-looking key or create time is not sufficient evidence.
  const sessionMetrics = { session_key: sessionKey, data_valid: false,
    reason: 'native_session_metrics_unavailable',
    request_session_key: sessionKey || null,
    requested_start_time: requestedSessionStart(sessionKey, sessionStartTime),
    task_start_time: task.start_time || raw.startTime || raw.createTime || null,
    spend: null, payment_gmv: null, payment_roi: null, net_gmv: null, net_roi: null, orders: null };
  return { bid: bid == null ? null : bid / 100000, bid_unit: 'CNY/order',
    bid_mode: bid > 0 && Number(raw.smartBidType) === 0 ? 'manual_bid' : task.roi_goal > 0 ? 'roi' : 'unknown',
    status_code: n(raw.status), pause_reason: task.passive_stop || /暂停|未开播|预算不足/.test(task.status || '') ? task.status : null,
    source_at: sourceAt, window, action_limits: actionLimits, available_actions: actions,
    // 不向调用方暴露无法解释的预算枚举；只保留可直接使用的进度与预算结果。
    budget_progress_pct: progress,
    observed_period_budget_ratio_pct: n(task.budget) > 0 && n(task.cost) != null ? +(task.cost / task.budget * 100).toFixed(2) : null,
    budget_audit_required: progress == null || progress >= 85,
    budget_remaining: matchedSpend != null && n(task.budget) != null ? Math.max(0, +(task.budget - matchedSpend).toFixed(2)) : null,
    roi: financial.values.payment_roi, net_roi: financial.values.net_roi, financial_checks: financial.checks,
    period_metrics: financial.values,
    session_metrics: sessionMetrics,
  };
}
module.exports = { boostTaskContract };
