const path = require('path');
const { spawn } = require('child_process');

const SERVER_APP_ROOT = path.resolve(__dirname, '..', '..');
const WRITER_SCRIPT = path.join(SERVER_APP_ROOT, 'tools', 'flow_control_browser_write.js');

function parseWriterOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('flow_control_browser_empty_response');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let parsed;
  try { parsed = JSON.parse(lines[lines.length - 1]); }
  catch (cause) {
    const error = new Error('flow_control_browser_invalid_response');
    error.cause = cause;
    throw error;
  }
  if (!parsed || parsed.ok !== true || !parsed.upstream) {
    const error = new Error(parsed && parsed.error || 'flow_control_browser_failed');
    error.code = parsed && parsed.code || 'flow_control_browser_failed';
    error.statusCode = 502;
    throw error;
  }
  return parsed.upstream;
}

function runFlowControlBrowserWrite({ accountId, primaryAdId, budgetYuan, durationSeconds, signal }, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90000;
  return new Promise((resolve, reject) => {
    const args = [
      WRITER_SCRIPT,
      '--account', String(accountId),
      '--primary-ad-id', String(primaryAdId),
      '--budget', String(budgetYuan),
      '--duration', String(durationSeconds),
    ];
    const child = spawnImpl(process.execPath, args, {
      cwd: SERVER_APP_ROOT,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = () => {
      try { child.kill(); } catch (_) {}
    };
    const onAbort = () => {
      terminate();
      const error = new Error('flow_control_browser_cancelled');
      error.code = 'request_cancelled';
      error.statusCode = 504;
      finish(error);
    };
    const timer = setTimeout(() => {
      terminate();
      const error = new Error(`flow_control_browser_timeout_${timeoutMs}ms`);
      error.code = 'upstream_timeout';
      error.statusCode = 504;
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-200000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.on('error', finish);
    child.on('exit', code => {
      if (code !== 0) {
        const error = new Error(stderr.trim() || `flow_control_browser_exit_${code}`);
        error.code = 'flow_control_browser_failed';
        error.statusCode = 502;
        return finish(error);
      }
      try { finish(null, parseWriterOutput(stdout)); }
      catch (error) { finish(error); }
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { parseWriterOutput, runFlowControlBrowserWrite, WRITER_SCRIPT };
