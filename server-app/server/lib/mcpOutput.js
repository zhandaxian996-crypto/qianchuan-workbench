'use strict';

function payloadSize(payload) {
  const json = JSON.stringify(payload == null ? null : payload);
  return {
    characters: [...json].length,
    bytes: Buffer.byteLength(json, 'utf8'),
  };
}

function value(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLiveSummary(payload) {
  const meta = payload.meta || {};
  if (payload.mode === 'delta') {
    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    const changed = changes.length
      ? changes.map(item => `${item.field} ${value(item.from)}→${value(item.to)}`).join('｜')
      : '核心指标无变化';
    return `${meta.account_id || '未知账号'}｜增量｜数据${meta.freshness || 'unknown'}｜${meta.age_ms == null ? '时间未知' : Math.round(meta.age_ms / 1000) + '秒前'}\n${changed}`;
  }
  const metrics = payload.metrics || payload.absolute && payload.absolute.metrics || {};
  const live = payload.live || payload.absolute && payload.absolute.live || {};
  const lines = [
    `${meta.account_id || '未知账号'}｜${live.is_live === true ? '直播中' : live.is_live === false ? '未在直播' : '直播状态未知'}｜数据${meta.freshness || 'unknown'}｜${meta.age_ms == null ? '时间未知' : Math.round(meta.age_ms / 1000) + '秒前'}`,
    `消耗 ${value(metrics.spend)}｜净成交 ${value(metrics.net_gmv)}｜净ROI ${value(metrics.net_roi)}｜订单 ${value(metrics.orders, 0)}`,
  ];
  const alerts = payload.alerts || [];
  if (alerts.length) lines.push(`需关注：${alerts.slice(0, 5).map(item => item.label || item.code).join('、')}`);
  if (meta.partial || (meta.errors && meta.errors.length)) lines.push(`部分数据不可用：${(meta.errors || []).map(item => item.code).join('、') || 'unknown'}`);
  return lines.join('\n');
}

function formatError(payload) {
  const code = payload && (payload.code || payload.error && payload.error.code) || 'unknown_error';
  const message = payload && (payload.message || payload.error || payload.error && payload.error.message) || '请求失败';
  return `Error: ${code}｜${typeof message === 'string' ? message : '请求失败'}`;
}

function toErrorPayload(error, defaults = {}) {
  const source = error && typeof error === 'object' ? error : { message: String(error || '请求失败') };
  const status = Number(source.status || source.httpStatus || 0);
  let code = source.code || defaults.code || 'mcp_tool_error';
  if (!source.code) {
    if (status === 401 || status === 403) code = 'cookie_expired';
    else if (status === 429) code = 'rate_limited';
    else if (status === 503) code = 'db_busy';
    else if (status === 504 || source.name === 'AbortError') code = 'timeout';
  }
  const retryableCodes = new Set(['timeout', 'mcp_tool_timeout', 'rate_limited', 'upstream_unavailable', 'db_busy']);
  return {
    ok: false,
    code: String(code),
    component: String(source.component || defaults.component || 'mcp'),
    retryable: source.retryable != null ? source.retryable === true : retryableCodes.has(String(code)),
    ...(source.timeout_ms != null || source.timeoutMs != null
      ? { timeout_ms: Number(source.timeout_ms != null ? source.timeout_ms : source.timeoutMs) }
      : {}),
    message: String(source.message || defaults.message || '请求失败'),
  };
}

function toMcpResult(payload, options = {}) {
  const isError = options.isError === true || !!(payload && payload.ok === false);
  let text;
  if (isError) text = formatError(payload);
  else if (payload && payload.meta && (payload.metrics || payload.absolute || payload.mode === 'delta')) text = formatLiveSummary(payload);
  else text = options.summary || '请求成功；结构化结果见 structuredContent。';
  const maxTextChars = Number.isFinite(+options.maxTextChars) ? +options.maxTextChars : 2000;
  if (text.length > maxTextChars) text = text.slice(0, maxTextChars - 1) + '…';
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload && typeof payload === 'object' ? payload : { value: payload },
    ...(isError ? { isError: true } : {}),
  };
}

module.exports = { payloadSize, formatLiveSummary, toErrorPayload, toMcpResult };
