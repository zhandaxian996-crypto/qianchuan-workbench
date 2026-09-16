'use strict';
const opLog = require('./operationLog');
const { safeActionLimits } = require('./actionLimits');
const { finiteNumber: n } = require('./dataContract');

async function boundedRead(read, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('readback_timeout'), { code: 'readback_timeout' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function normalizedTarget(raw, plan = false) {
  if (!raw) return null;
  return { status: n(raw.status), budget: plan ? n(raw.budget) : n(raw.budget) == null ? null : n(raw.budget) / 100000,
    id: raw.id == null ? null : String(raw.id), smart_bid_type: n(raw.smartBidType),
    roi_goal: n(raw.roiGoal ?? raw.ecpRoi2Goal), bid: n(raw.bid) == null ? null : n(raw.bid) / 100000,
    audience: raw.audience || null };
}

function compareReadback(actual, requested) {
  const matches = (observed, expected) => {
    if (observed == null) return false;
    if (typeof expected === 'number') return Number.isFinite(Number(observed)) && Math.abs(Number(observed) - expected) <= 0.00001;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      return typeof observed === 'object' && Object.keys(expected).every(key => matches(observed[key], expected[key]));
    }
    return JSON.stringify(observed) === JSON.stringify(expected);
  };
  const mismatches = Object.keys(requested).filter(key => !matches(actual && actual[key], requested[key]));
  return { verified: Object.keys(requested).length > 0 && mismatches.length === 0, mismatches };
}

// Called inside the same target write lock. Acceptance is logged before readback, so a
// delayed read cannot let a concurrent request bypass cooldown or repeat an accepted write.
async function executeWithReceipt({ write, read, before, requested, logEntry, readTimeoutMs, preserveFields = [] }) {
  const began = Date.now();
  let result, thrown;
  try { result = await write(); } catch (error) { thrown = error; }
  const requestMs = Date.now() - began;
  const code = result && (result.status_code ?? result.code);
  const httpStatus = thrown?.statusCode || (/cookie_expired|cookie_not_found/.test(thrown?.message || '') ? 401 : 502);
  const accepted = !thrown && code === 0;
  logEntry = typeof logEntry === 'function' ? logEntry(result) : logEntry;
  requested = typeof requested === 'function' ? requested(result) : requested;
  const operationId = opLog.log({ ...logEntry, success: accepted, result_code: code,
    result_msg: thrown ? thrown.message : accepted ? null : 'upstream_rejected_or_unknown',
    params: { ...logEntry.params, before, requested, upstream_accepted: accepted } });
  const readBegan = Date.now();
  let actual = null, reason = null;
  if (accepted) {
    try { actual = await boundedRead(() => read(result), readTimeoutMs); }
    catch (error) { reason = error.code || error.message || 'readback_failed'; }
  }
  const comparison = compareReadback(actual, requested);
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const preservation = preserveFields.filter(key => !Object.hasOwn(requested, key)).map(field => ({
    field, before: before?.[field] ?? null, actual: actual?.[field] ?? null,
    status: before?.[field] == null || actual?.[field] == null ? 'unknown'
      : JSON.stringify(canonical(before[field])) === JSON.stringify(canonical(actual[field])) ? 'unchanged' : 'changed',
  }));
  const preserved = preservation.every(item => item.status === 'unchanged');
  const verified = accepted && comparison.verified && preserved;
  const limits = safeActionLimits(logEntry.account_id, logEntry.target_id);
  const fields = { budget: 'update_budget', roi_goal: 'update_roi', bid: 'update_bid', audience: 'update_audience' };
  const unlocks = Object.keys(requested).map(key => limits[fields[key]]?.next_allowed_at).filter(Boolean).sort();
  const receipt = { operation_id: operationId, before: before || null, requested, actual,
    upstream_accepted: accepted, effect_status: verified ? 'confirmed' : accepted || thrown || code == null ? 'unconfirmed' : 'rejected',
    readback: { ...comparison, verified, preservation, target_id: String(logEntry.target_id),
      reason: verified ? null : reason || (accepted && !preserved ? 'unchanged_fields_not_confirmed' : accepted ? 'requested_values_not_confirmed' : 'upstream_rejected_or_unknown') },
    next_allowed_at: unlocks.at(-1) || limits[logEntry.action]?.next_allowed_at || null, action_limits: limits,
    retry_write: false, timings: { request_ms: requestMs, readback_ms: accepted ? Date.now() - readBegan : 0,
      total_ms: Date.now() - began, retry_ms: result?.request_timings?.retry_ms ?? null,
      retry_count: result?.request_timings?.retry_count ?? null,
      upstream_ms: result?.request_timings?.upstream_ms ?? null } };
  if (!operationId) receipt.audit_error = 'operation_log_persistence_failed';
  try { if (operationId) opLog.attachReceipt(operationId, receipt); }
  catch { receipt.audit_error = 'receipt_persistence_failed'; }
  return { ok: accepted, result, ...receipt,
    ...(!accepted ? { http_status: httpStatus, code: thrown?.code || thrown?.message || code } : {}),
    message: verified ? '已回读确认生效' : accepted ? '上游已接受，结果未确认；只读核验，禁止自动重发' : '上游拒绝或结果未知',
    ...(!accepted ? { error: thrown?.message || 'upstream_rejected_or_unknown' } : {}) };
}
module.exports = { executeWithReceipt, compareReadback, normalizedTarget, boundedRead };
