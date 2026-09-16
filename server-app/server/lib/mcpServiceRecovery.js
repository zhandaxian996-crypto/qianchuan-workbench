'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const RESTART_COOLDOWN_MS = 30 * 60 * 1000;
const NON_RESTARTABLE_CODES = new Set([
  'cookie_expired', 'rate_limited', 'upstream_locked', 'upstream_bad_request',
  'upstream_unavailable', 'upstream_timeout', 'queue_timeout', 'db_busy', 'SQLITE_BUSY',
]);

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function capture(fetchJson, url, options = {}) {
  try {
    return { ok: true, data: await fetchJson(url, options), error: null };
  } catch (error) {
    return { ok: false, data: error && error.body || null, error };
  }
}

function recoveryCode(result) {
  return result && (result.data && result.data.code || result.error && result.error.code) || 'mcp_http_unavailable';
}

function mayRestart(result) {
  if (!result) return true;
  const code = recoveryCode(result);
  if (NON_RESTARTABLE_CODES.has(code)) return false;
  if (result.data && result.data.restart_recommended === false) return false;
  return true;
}

function defaultStatePath() {
  return path.resolve(__dirname, '..', '..', 'tmp', 'service-recovery.json');
}

function claimRestart(options = {}) {
  const now = Number(options.now) || Date.now();
  const statePath = options.statePath || defaultStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const previousAt = previous && Date.parse(previous.started_at || previous.completed_at || '');
  if (Number.isFinite(previousAt) && now - previousAt < RESTART_COOLDOWN_MS) {
    return {
      claimed: false,
      code: 'service_recovery_cooldown',
      retry_after_ms: RESTART_COOLDOWN_MS - (now - previousAt),
      previous,
      statePath,
    };
  }

  if (fs.existsSync(statePath)) {
    const ageMs = (() => {
      try { return now - fs.statSync(statePath).mtimeMs; } catch { return 0; }
    })();
    if (!Number.isFinite(previousAt) && ageMs < RESTART_COOLDOWN_MS) {
      return {
        claimed: false,
        code: 'service_recovery_cooldown',
        retry_after_ms: Math.max(0, RESTART_COOLDOWN_MS - ageMs),
        previous,
        statePath,
      };
    }
    try { fs.rmSync(statePath, { force: true }); } catch {}
  }

  const state = {
    started_at: new Date(now).toISOString(),
    requested_by_pid: process.pid,
    account_id: options.accountId || null,
  };
  let handle;
  try {
    handle = fs.openSync(statePath, 'wx');
    fs.writeFileSync(handle, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return {
        claimed: false,
        code: 'service_recovery_cooldown',
        retry_after_ms: RESTART_COOLDOWN_MS,
        previous: null,
        statePath,
      };
    }
    throw error;
  } finally {
    if (handle != null) try { fs.closeSync(handle); } catch {}
  }
  return { claimed: true, state, statePath };
}

function completeRestartClaim(claim, details = {}) {
  if (!claim || !claim.statePath) return;
  const state = {
    ...(claim.state || {}),
    completed_at: new Date().toISOString(),
    ...details,
  };
  try { fs.writeFileSync(claim.statePath, JSON.stringify(state, null, 2), 'utf8'); } catch {}
}

function runVerifiedRestart(options = {}) {
  const scriptPath = options.scriptPath || path.resolve(__dirname, '..', '..', 'tools', 'restart_server.ps1');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], {
      cwd: path.resolve(__dirname, '..', '..'),
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

async function pollDataHealth(fetchJson, httpBase, accountId, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await capture(fetchJson, `${httpBase}/health/data?account=${encodeURIComponent(accountId)}`, { deadlineMs: 3000 });
    if (last.data && last.data.ready === true) return last;
    await delay(1000);
  }
  return last;
}

async function recoverDataService(options) {
  const {
    fetchJson,
    httpBase,
    accountId,
    restartIfNeeded = true,
    restart = runVerifiedRestart,
    statePath,
    now,
  } = options;

  const initial = await capture(
    fetchJson,
    `${httpBase}/health/data?account=${encodeURIComponent(accountId)}`,
    { deadlineMs: 3000 },
  );
  if (initial.data && initial.data.ready === true) {
    return {
      ok: true,
      recovered: false,
      restarted: false,
      action: 'none',
      account_id: accountId,
      health: initial.data,
    };
  }
  if (!mayRestart(initial)) {
    return {
      ok: false,
      recovered: false,
      restarted: false,
      action: 'structured_error_no_restart',
      account_id: accountId,
      code: recoveryCode(initial),
      component: initial.data && initial.data.component || 'collector',
      retryable: initial.data && initial.data.retryable === true,
      restart_recommended: false,
      health: initial.data,
    };
  }

  // 第一层：HTTP 能返回结构化 collector 状态时，先在原进程内取消陈旧 flight 并重采。
  // 若健康请求本身超时/拒绝/重置，说明 HTTP 数据平面已不可达，不能再傻等一次 58 秒 POST。
  const recollect = initial.data
    ? await capture(
      fetchJson,
      `${httpBase}/api/collector/recover?account=${encodeURIComponent(accountId)}`,
      { method: 'POST', deadlineMs: 58000 },
    )
    : initial;
  if (recollect.data && recollect.data.ready === true) {
    return {
      ok: true,
      recovered: true,
      restarted: false,
      action: 'collector_recollect',
      account_id: accountId,
      health: recollect.data,
    };
  }
  if (!mayRestart(recollect)) {
    return {
      ok: false,
      recovered: false,
      restarted: false,
      action: 'structured_error_no_restart',
      account_id: accountId,
      code: recoveryCode(recollect),
      component: recollect.data && recollect.data.component || 'collector',
      retryable: recollect.data && recollect.data.retryable === true,
      restart_recommended: false,
      health: recollect.data,
    };
  }
  if (!restartIfNeeded) {
    return {
      ok: false,
      recovered: false,
      restarted: false,
      action: 'restart_required',
      account_id: accountId,
      code: recoveryCode(recollect),
      retryable: true,
      restart_recommended: true,
      health: recollect.data || initial.data,
    };
  }

  // 第二层：MCP 是独立 stdio 进程，能在 HTTP 无响应时运行已核验 PID 的重启脚本。
  const claim = claimRestart({ accountId, statePath, now });
  if (!claim.claimed) {
    const health = await pollDataHealth(fetchJson, httpBase, accountId, 8000);
    if (health && health.data && health.data.ready === true) {
      return {
        ok: true,
        recovered: true,
        restarted: false,
        action: 'joined_existing_recovery',
        account_id: accountId,
        health: health.data,
      };
    }
    return {
      ok: false,
      recovered: false,
      restarted: false,
      action: 'restart_cooldown',
      account_id: accountId,
      code: claim.code,
      retryable: true,
      retry_after_ms: claim.retry_after_ms,
      restart_recommended: false,
      health: health && health.data || null,
    };
  }

  try {
    const restartResult = await restart();
    const processHealth = await capture(fetchJson, `${httpBase}/health/live`, { deadlineMs: 3000 });
    if (!(processHealth.data && processHealth.data.ok === true)) {
      throw Object.assign(new Error('18991 重启后存活探针未通过'), { code: 'restart_health_failed' });
    }
    const dataHealth = await pollDataHealth(fetchJson, httpBase, accountId, 15000);
    completeRestartClaim(claim, { ok: true, new_pid: processHealth.data.pid || null });
    return {
      ok: true,
      recovered: true,
      restarted: true,
      action: 'verified_http_restart',
      account_id: accountId,
      data_ready: !!(dataHealth && dataHealth.data && dataHealth.data.ready === true),
      process: processHealth.data,
      health: dataHealth && dataHealth.data || null,
      restart_output: restartResult && restartResult.stdout || null,
    };
  } catch (error) {
    completeRestartClaim(claim, { ok: false, error: error.message });
    return {
      ok: false,
      recovered: false,
      restarted: false,
      action: 'restart_failed',
      account_id: accountId,
      code: error.code || 'restart_failed',
      component: 'http_process',
      retryable: true,
      restart_recommended: false,
      error: error.message,
    };
  }
}

module.exports = {
  RESTART_COOLDOWN_MS,
  NON_RESTARTABLE_CODES,
  capture,
  mayRestart,
  claimRestart,
  runVerifiedRestart,
  recoverDataService,
};
