// server/lib/compassWb.js
// WebBridge 罗盘统一通道：
//   1. 单 session「qianchuan-compass」= 浏览器里单个标签组（组名「千川·罗盘数据」）。
//      WebBridge 官方约定：一个任务 = 一个 session = 一个标签组；每个功能各起一个 session 名
//      是标签组碎片化的根因（2026-07-25 用户反馈浏览器里堆了 8 个组）。
//   2. 跨进程文件锁（cache/compass/wb.lock）：session 共享后 daemon 的"当前标签"指针也是共享的，
//      server 进程（ask/api）与独立进程（tools/compass_collector.js）并发操作会互踩，必须串行。
//   3. 常驻单组（2026-07-25 调整）：任务结束不关组，保持罗盘页/AI 面板在线——
//      AI 问答靠它实现热通道秒回（原"用完即关"策略因每次 20~40s 准备开销废止）。
//      closeSession 保留为手动清理工具。
const fs = require('fs');
const path = require('path');
const { CACHE_DIR, QIANCHUAN_ACCOUNTS } = require('./config');

const WB = 'http://127.0.0.1:10086/command';
const SESSION = 'qianchuan-compass';
const GROUP_TITLE = '千川·罗盘数据';
const LOCK_FILE = path.join(CACHE_DIR, 'compass', 'wb.lock');
const LOCK_STALE_MS = 6 * 60 * 1000; // 持锁方崩溃后 6 分钟自动失效

// 页签亲和（2026-07-25）：两个固定标签分工，杜绝"取数导航把当前标签抢走"
//   TAB_ASK  = AI 问答专用（/shop，面板常驻保热通道）
//   TAB_DATA = 数据取数专用（/shop/core-users：goods/videos/screen/collector）
// 注意 TAB_ASK 是 TAB_DATA 的前缀，匹配时 A 用精确匹配、B 用前缀匹配
const TAB_ASK = 'https://compass.jinritemai.com/shop';
const TAB_DATA = 'https://compass.jinritemai.com/shop/core-users';

const sleep = (ms, signal) => {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => finish(() => reject(signal.reason || new Error('aborted')));
    function done() { finish(resolve); }
    function finish(fn) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
};

async function fetchLocalJson(url, options = {}, timeoutMs = 15000, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`WebBridge timeout ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(parentSignal.reason || new Error('aborted'));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`WebBridge HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 选中本流程的固定标签（不存在则新开）。
 * @param {string} url TAB_ASK 或 TAB_DATA
 * @returns {Promise<'existing'|'created'|false>}
 */
async function useTab(url) {
  try {
    const r = await wb('list_tabs', {});
    const tabs = (r && r.data && r.data.tabs) || [];
    const hit = tabs.find(t => {
      const u = (t.url || '');
      if (url === TAB_ASK) return u === TAB_ASK || u.startsWith(TAB_ASK + '?') || u.startsWith(TAB_ASK + '#');
      return u.startsWith(url);
    });
    if (hit) {
      const f = await wb('find_tab', { url: hit.url });
      if (f && f.ok) return 'existing';
    }
  } catch (_) { /* 走下去新建 */ }
  const nav = await wb('navigate', { url, newTab: true });
  return nav && nav.ok ? 'created' : false;
}

async function wb(action, args = {}) {
  // 每次 navigate 都带组名：daemon 重启后重建组时也能拿到正确标题
  if (action === 'navigate') args = Object.assign({ group_title: GROUP_TITLE }, args);
  return fetchLocalJson(WB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: SESSION }),
  }, 15000);
}

async function evalJs(code) {
  const r = await wb('evaluate', { code });
  if (!r.ok) throw new Error((r.error && r.error.message) || 'evaluate failed');
  return r.data && r.data.value;
}

/**
 * 获取罗盘通道锁（异步等待）。
 * @param {string} owner 持锁方标识（ask/api/collector），用于释放时校验
 * @param {number} waitMs 最长等待时间
 * @returns {Promise<boolean>} 是否拿到锁
 */
async function acquireLock(owner, waitMs = 120000) {
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, owner, ts: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      // 锁已存在：过期/损坏则清掉重试
      let stale = false;
      try {
        const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
        stale = Date.now() - (cur.ts || 0) > LOCK_STALE_MS;
      } catch (_) { stale = true; }
      if (stale) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} continue; }
      if (Date.now() > deadline) return false;
      await sleep(2000);
    }
  }
}

function releaseLock(owner) {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    if (cur.owner === owner && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) { /* 锁不存在或已易主，忽略 */ }
}

/** 关闭本 session 的全部标签（整个组）。任务收尾调用，浏览器不留痕。 */
async function closeSession() {
  try { await wb('close_session', {}); } catch (_) { /* daemon 不在就算了 */ }
}

// ---- 专用浏览器自救（2026-07-26 无头 / 2026-07-27 改有头巡查）----
// 架构：daemon 与扩展是单 WebSocket 连接。专用 profile（cache/chrome-compass-profile，
// 由 tools/compass_browser.cmd 建档）常驻，承载全部罗盘采集；
// 用户日常浏览器若也装了扩展会抢连接，需要求其禁用扩展或不在线。
// 2026-09-04：改用完整罗盘 cookie 后纯 API 通道已恢复，WebBridge 仅在纯 API 失效时兜底；
// 为不再弹出有头窗口，保持无头（原 2026-07-27 为巡查改有头，属临时，已改回）。
const HEADED = false;
const DAEMON_EXE = path.join(process.env.USERPROFILE || '', '.kimi-webbridge', 'bin', 'kimi-webbridge.exe');
const HEADLESS_PROFILE = path.join(CACHE_DIR, 'chrome-compass-profile');
const CHROME_EXE = '';

async function wbStatus(signal) {
  try {
    return await fetchLocalJson('http://127.0.0.1:10086/status', {}, 5000, signal);
  } catch (_) { return null; }
}

function spawnDetached(cmd, args, opts) {
  const { spawn } = require('child_process');
  const hide = !opts || opts.hide !== false; // 默认隐藏（daemon）；浏览器有头模式必须 false
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: hide });
  child.unref();
}

// 进程内并发门闩：防止多个请求同时触发 ensureExtensionConnected 时拉起多个 Chrome 实例抢槽位
let ensurePromise = null;

/**
 * 确保 daemon 在线且扩展已连接；专用 profile 存在时，浏览器不在/未连扩展会自动拉起（HEADED 常量控制有头/无头）。
 * @returns {Promise<boolean>} 扩展就绪
 */
async function ensureExtensionConnected() {
  if (ensurePromise) return ensurePromise;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('WebBridge 连接自愈超过 55 秒')), 55000);
  timer.unref?.();
  ensurePromise = ensureExtensionConnectedImpl(controller.signal).finally(() => {
    clearTimeout(timer);
    ensurePromise = null;
  });
  return ensurePromise;
}

async function ensureExtensionConnectedImpl(signal) {
  // 1. daemon 探活，不通则拉起
  let st = await wbStatus(signal);
  if (!st) {
    if (fs.existsSync(DAEMON_EXE)) spawnDetached(DAEMON_EXE, ['start']);
    for (let i = 0; i < 10 && !st; i++) { await sleep(2000, signal); st = await wbStatus(signal); }
    if (!st) return false;
  }
  if (st.extension_connected) return true;
  // 2. 扩展未连接：专用 profile 在就拉起（HEADED=true 有头巡查 / false 无头常驻）
  if (fs.existsSync(HEADLESS_PROFILE) && fs.existsSync(CHROME_EXE)) {
    const args = [
      `--user-data-dir=${HEADLESS_PROFILE}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1707,932',
      // 直连：专用采集实例不走系统代理（2026-07-26 事故：系统代理残留指向已关闭的代理进程，
      // 无头实例报 ERR_PROXY_CONNECTION_FAILED，罗盘全部取数失败；国内站点直连即可）
      '--no-proxy-server',
      'about:blank',
    ];
    if (!HEADED) args.unshift('--headless=new');
    spawnDetached(CHROME_EXE, args, { hide: !HEADED });
    for (let i = 0; i < 15; i++) {
      await sleep(2000, signal);
      st = await wbStatus(signal);
      if (st && st.extension_connected) {
        // 冷启动热身：扩展连上≠渲染进程就绪，立即 navigate 大页面易 30s 超时（2026-07-26 实测）
        await sleep(5000, signal);
        return true;
      }
    }
  }
  return false;
}

// 从 config 动态生成店铺名映射，避免硬编码（支持多店铺扩展）
const STORE_MATCH = Object.fromEntries((QIANCHUAN_ACCOUNTS || []).map(a => [a.id, a.name]));

/**
 * 确保罗盘页面已切换到目标店铺（WebBridge 页面上下文仿真切店）
  * 历史账户专用说明已从试用包移除。
 * @param {string} [homeUrl] 切店后导航回的页面，默认 TAB_ASK
 * @returns {Promise<boolean>} 是否已确认在目标店铺
 */
async function ensureStore(match, homeUrl) {
  const cur = await evalJs(`(() => {
    const t = document.body ? document.body.innerText.slice(0, 3000) : '';
    return t.includes('${match}') ? 'ok' : 'wrong';
  })()`);
  if (cur === 'ok') return true;

  // 视口仿真放大（2026-07-25 实测：窗口宽 1523px 时店名切换器被搜索框遮挡，仿真到 1920px 后可见可点）
  await wb('cdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false } });
  await sleep(2500);

  let switched = false;
  for (let round = 0; round < 2 && !switched; round++) {
    // 1. 找 hover 目标：userSection（店名容器）
    const pos = await evalJs(`(() => {
      const el = document.querySelector('[class*=userSection]') || document.querySelector('[class*=userCenter]');
      if (!el) return '';
      const r = el.getBoundingClientRect();
      return r.width > 0 ? JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) : '';
    })()`);
    if (!pos) break;
    const p = JSON.parse(pos);

    // 2. hover 展开下拉
    await wb('cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: p.x, y: p.y } });
    await sleep(2000);

    // 3. 等「切换数据视角」出现并点击（最多等 4 秒）
    let sw = 'no';
    for (let i = 0; i < 4 && sw !== 'ok'; i++) {
      sw = await evalJs(`(() => { const el = document.querySelector('[class*=switchAccount]'); if (!el) return 'no'; el.click(); return 'ok'; })()`);
      if (sw !== 'ok') await sleep(1000);
    }
    if (sw !== 'ok') continue;
    await sleep(1500);

    // 4. 等账号列表里的目标店铺并点击（最多等 4 秒；点可视的、位置在弹层里的）
    let ck = 'no';
    for (let i = 0; i < 4 && ck !== 'ok'; i++) {
      ck = await evalJs(`(() => {
        const hits = [...document.querySelectorAll('body *')].filter(e => {
          const t = (e.textContent || '');
          const r = e.getBoundingClientRect();
          return t.includes('${match}') && r.width > 0 && r.height > 0 && r.top > 50;
        });
        if (!hits.length) return 'no';
        const inList = hits.filter(e => /roleList|roleItem|intro/i.test(e.className.toString()));
        const el = inList.length ? inList[inList.length - 1] : hits[hits.length - 1];
        el.click();
        return 'ok';
      })()`);
      if (ck !== 'ok') await sleep(1000);
    }
    if (ck === 'ok') switched = true;
  }

  // 5. 恢复视口，刷新验证（回到本流程的固定标签页，别乱串到别的页签）
  await wb('cdp', { method: 'Emulation.clearDeviceMetricsOverride', params: {} });
  if (!switched) return false;
  await sleep(3000);
  await wb('navigate', { url: homeUrl || TAB_ASK, newTab: false });
  await sleep(4500);
  const chk = await evalJs(`(() => document.body.innerText.slice(0, 3000).includes('${match}') ? 'ok' : 'wrong')()`);
  return chk === 'ok';
}

module.exports = { WB, SESSION, GROUP_TITLE, TAB_ASK, TAB_DATA, wb, evalJs, sleep, useTab, acquireLock, releaseLock, closeSession, ensureExtensionConnected, ensureStore, STORE_MATCH };
