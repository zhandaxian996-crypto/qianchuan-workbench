'use strict';

function mcpFetchError(code, message, options = {}) {
  const err = new Error(message);
  err.code = code;
  err.component = options.component || 'http_api';
  err.retryable = options.retryable === true;
  if (options.statusCode) err.statusCode = options.statusCode;
  if (options.timeoutMs) err.timeoutMs = options.timeoutMs;
  if (options.body) err.body = options.body;
  return err;
}

function inferDeadline(url, options, defaults) {
  if (Number(options.deadlineMs) > 0) return Number(options.deadlineMs);
  const pathname = (() => { try { return new URL(String(url)).pathname; } catch { return String(url); } })();
  return pathname.endsWith('/live-watch') || pathname.endsWith('/status')
    ? defaults.statusMs
    : defaults.readMs;
}

function createDeadlineFetch(nativeFetch = globalThis.fetch, defaults = {}) {
  if (typeof nativeFetch !== 'function') throw new Error('当前 Node 运行时不支持 fetch');
  const limits = {
    statusMs: Number(defaults.statusMs) > 0 ? Number(defaults.statusMs) : 30000,
    readMs: Number(defaults.readMs) > 0 ? Number(defaults.readMs) : 60000,
  };
  return async function fetchWithDeadline(url, options = {}) {
    const deadlineMs = inferDeadline(url, options, limits);
    const controller = new AbortController();
    const timeoutError = mcpFetchError('mcp_http_timeout', `HTTP 数据服务超过 ${deadlineMs}ms 未返回`, {
      component: 'mcp_http', retryable: true, statusCode: 504, timeoutMs: deadlineMs,
    });
    const callerSignal = options.signal;
    const onCallerAbort = () => controller.abort(callerSignal.reason || mcpFetchError(
      'mcp_request_cancelled', 'MCP 调用方已取消请求', { component: 'mcp_http', retryable: true },
    ));
    let cleaned = false;
    let timer;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', cleanup);
    };
    timer = setTimeout(() => controller.abort(timeoutError), deadlineMs);
    timer.unref?.();
    controller.signal.addEventListener('abort', cleanup, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const { deadlineMs: _deadlineMs, ...fetchOptions } = options;
    fetchOptions.signal = controller.signal;
    let responseHandedToCaller = false;
    try {
      const response = await nativeFetch(url, fetchOptions);
      if (!response.ok) {
        let body = null;
        try { body = await response.clone().json(); } catch {
          try { body = { error: await response.clone().text() }; } catch {}
        }
        const code = body?.code || `http_${response.status}`;
        throw mcpFetchError(code, body?.error || body?.message || `HTTP ${response.status}`, {
          component: body?.component || 'http_api',
          retryable: body?.retryable === true || response.status >= 500 || response.status === 429 || response.status === 423,
          statusCode: response.status,
          timeoutMs: body?.timeout_ms,
          body,
        });
      }
      responseHandedToCaller = true;
      const consume = method => async (...args) => {
        try {
          const data = await response[method](...args);
          if (method === 'json' && data && data.ok === false) {
            throw mcpFetchError(data.code || 'api_error', data.error || data.message || 'HTTP 数据服务返回 ok:false', {
              component: data.component || 'http_api',
              retryable: data.retryable === true,
              statusCode: response.status,
              timeoutMs: data.timeout_ms,
              body: data,
            });
          }
          return data;
        } catch (e) {
          if (controller.signal.aborted) throw controller.signal.reason || timeoutError;
          throw e;
        } finally {
          cleanup();
        }
      };
      // 期限持续到响应体被消费完，避免“已收到响应头、body 永久悬挂”泄漏句柄。
      // 兼容现有 MCP handler 的 `await res.json()` 写法，同时保证 HTTP 200 + ok:false
      // 也一定进入 catch 并映射为 isError:true。
      return new Proxy(response, {
        get(target, prop) {
          if (['json', 'text', 'arrayBuffer', 'blob', 'formData'].includes(prop)) return consume(prop);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    } catch (e) {
      if (controller.signal.aborted) throw controller.signal.reason || timeoutError;
      if (e && e.code) throw e;
      throw mcpFetchError('mcp_http_unavailable', e?.message || '无法连接 HTTP 数据服务', {
        component: 'mcp_http', retryable: true, cause: e,
      });
    } finally {
      if (!responseHandedToCaller) cleanup();
    }
  };
}

async function fetchJsonWithDeadline(fetchWithDeadline, url, options = {}) {
  const response = await fetchWithDeadline(url, options);
  let data;
  try {
    data = await response.json();
  } catch (e) {
    if (e && e.code) throw e;
    throw mcpFetchError('mcp_http_parse_error', 'HTTP 数据服务返回非 JSON 响应', {
      component: 'mcp_http', retryable: true, statusCode: 502, cause: e,
    });
  }
  if (data && data.ok === false) {
    throw mcpFetchError(data.code || 'api_error', data.error || data.message || 'HTTP 数据服务返回 ok:false', {
      component: data.component || 'http_api',
      retryable: data.retryable === true,
      statusCode: response.status,
      timeoutMs: data.timeout_ms,
      body: data,
    });
  }
  return data;
}

module.exports = { createDeadlineFetch, fetchJsonWithDeadline, mcpFetchError };
