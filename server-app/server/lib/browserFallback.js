/**
  * 历史账户专用说明已从试用包移除。
 *
 * 定位：千川逆向 API（18991）失效时的自动兜底。
 *  - 读兜底：拉起专用探针 Chrome（CDP 9333 + cookie 注入），监听页面 XHR，按谓词截获同源响应
 *  - 写兜底（下一里程碑）：UI 选择器自动化（追投创建/主计划 ROI 调整），默认需 confirm=true 人工确认
 *
 * 复用项目既有设施：probe.js 同款专用 profile（cache/chrome-probe-profile）+ 双域 cookie 注入。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const SERVER_APP = path.resolve(__dirname, '..'); // server-app
const PROJECT_ROOT = path.resolve(SERVER_APP, '..'); // 项目根
// 2026-08-13 交付版适配：Chrome 路径自动探测（原硬编码 Program Files，客户机器安装路径可能不同）
function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),


  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 跳过 */ }
  }
  return null;
}
const CHROME_EXE = findChrome();
const CDP_PORT = 9333;
const PROBE_PROFILE = path.join(PROJECT_ROOT, 'cache', 'chrome-probe-profile');

const { QIANCHUAN_ACCOUNTS, SCRIPTS_DIR } = require('./config');

function getAccountConfig(accountId) {
  const account = (QIANCHUAN_ACCOUNTS || []).find(item => item.id === accountId);
  if (!account) throw new Error(`browserFallback: 未配置账户 ${accountId}`);
  if (!account.aavid) throw new Error(`browserFallback: 账户 ${accountId} 缺少 aavid`);
  return account;
}

function defaultAccountId() {
  const first = (QIANCHUAN_ACCOUNTS || [])[0];
  if (!first) throw new Error('browserFallback: config.qianchuan_accounts 为空');
  return first.id;
}

function getCookiePath(accountId) {
  const account = getAccountConfig(accountId);
  return path.isAbsolute(account.cookieFile)
    ? account.cookieFile
    : path.join(SCRIPTS_DIR, account.cookieFile || 'cookie.txt');
}

function getUniPromUrl(accountId) {
  return `https://qianchuan.jinritemai.com/uni-prom?aavid=${encodeURIComponent(getAccountConfig(accountId).aavid)}`;
}

let cachedBrowser = null;

function portOpen(port) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1', () => { sock.end(); resolve(true); });
    sock.on('error', () => resolve(false));
  });
}

async function ensureBrowser() {
  if (cachedBrowser) return cachedBrowser;
  const { chromium } = require(path.join(PROJECT_ROOT, 'node_modules', 'playwright'));
  if (!(await portOpen(CDP_PORT))) {
    if (!CHROME_EXE) throw new Error('browserFallback: 未找到系统 Chrome（请安装 Google Chrome 后重试）');
    spawn(CHROME_EXE, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROBE_PROFILE}`,
      '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    ], { detached: true, stdio: 'ignore' }).unref();
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await portOpen(CDP_PORT)) { ready = true; break; }
    }
    if (!ready) throw new Error('browserFallback: 探针 Chrome 15 秒未就绪');
  }
  cachedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  return cachedBrowser;
}

async function loginStatus(page, accountId) {
  const aavid = getAccountConfig(accountId).aavid;
  try {
    return await page.evaluate(async (aid) => {
      const r = await fetch(`/ad/api/v1/account/user/info?aavid=${aid}`, { credentials: 'include' });
      return r.status;
    }, aavid);
  } catch {
    return -1;
  }
}

async function injectCookies(context, accountId) {
  const cookieFile = getCookiePath(accountId);
  const cookieStr = fs.readFileSync(cookieFile, 'utf8').trim();
  const cookies = [];
  for (const p of cookieStr.split(/;\s*/).filter(Boolean)) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    cookies.push({ name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: '.jinritemai.com', path: '/' });
    cookies.push({ name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: '.oceanengine.com', path: '/' });
  }
  await context.addCookies(cookies);
}

async function openPage(accountId, url) {
  const browser = await ensureBrowser();
  const context = browser.contexts()[0] || await browser.newContext();
  // 兜底铁律：先注入 cookie（幂等），再开新页导航——保证新页面带登录态
  await injectCookies(context, accountId).catch(() => {});
  const page = await context.newPage();
  await page.bringToFront().catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  return page;
}

/** 截获第一个满足谓词的 XHR/fetch 响应 */
async function captureResponse(page, matchFn, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off('response', handler);
      fn();
    };
    const handler = async res => {
      try {
        if (!matchFn(res)) return;
        const body = await res.text();
        finish(() => resolve({ url: res.url(), status: res.status(), body }));
      } catch { /* 流式/二进制跳过，继续等下一个 */ }
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`browserFallback: 截获响应超时 ${timeoutMs}ms`))), timeoutMs);
    page.on('response', handler);
  });
}

/**
 * 读兜底：主计划当前 ROI（页面计划列表接口，body 含 ecpRoi2Goal）
 * 返回 { source:'browser_fallback', roi, budget, name, ad_id }
 */
async function planRoiFallback(accountId = defaultAccountId(), opts = {}) {
  const browser = await ensureBrowser();
  const context = browser.contexts()[0] || await browser.newContext();
  await injectCookies(context, accountId).catch(() => {});
  const page = await context.newPage();
  try {
    await page.bringToFront().catch(() => {});
    // 先挂监听（不 await），再导航，最后等结果——否则会错过页面加载期发出的 list-required
    const capP = captureResponse(
      page,
      r => /uni-promotion\/ad\/list-(required|optional)/i.test(r.url()),
      opts.timeoutMs || 30000,
    );
    await page.goto(getUniPromUrl(accountId), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const result = await capP;
    let json;
    try { json = JSON.parse(result.body); } catch { json = null; }
    const targetAd = getAccountConfig(accountId).primary_ad_id;
    const ad = json && findAd(json, targetAd);
    if (!ad) throw new Error(`browserFallback: 计划列表响应中未找到主计划 ${targetAd}`);
    return {
      source: 'browser_fallback',
      ad_id: targetAd,
      roi: +(ad.ecpRoi2Goal || 0),
      budget: +(ad.budget || 0) / 100000,
      name: ad.name || null,
      matched_url: result.url,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function findAd(node, targetAd) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAd(item, targetAd);
      if (hit) return hit;
    }
    return null;
  }
  if (String(node.id) === String(targetAd) && node.ecpRoi2Goal != null) return node;
  for (const key of Object.keys(node)) {
    const hit = findAd(node[key], targetAd);
    if (hit) return hit;
  }
  return null;
}

/* ===== 写兜底（CDP 主世界通道，2026-08-12 维护者拍板）=====
 * 原则：Playwright 管页面生命周期，CDP Runtime.evaluate 在主世界执行原生 click/事件 = 真人等价。
 * 默认 requireConfirm=true：未显式 confirm 一律拒绝，避免自动扣扳机。
 */

/** CDP 主世界执行：返回 Runtime.evaluate 的 result.value */
async function cdpEvaluate(page, expression) {
  const session = await page.context().newCDPSession(page);
  const res = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error('cdpEvaluate 异常: ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
  }
  return res.result && res.result.value;
}

const MAIN_ROW_CLICK_EDIT = `(() => {
  const rows = Array.from(document.querySelectorAll('tr'));
  const row = rows.find(r => (r.innerText || '').includes('每日预算') && (r.innerText || '').includes('9999元'));
  if (!row) return { err: 'main row not found' };
  const el = Array.from(row.querySelectorAll('span, a, button, div')).find(s => (s.innerText || '').trim() === '编辑' && s.children.length === 0);
  if (!el) return { err: 'edit not found' };
  el.click();
  return { ok: true };
})()`;

const DRAWER_READ_ROI = `(() => {
  const inputs = Array.from(document.querySelectorAll('input.ovui-input[type="text"]'));
  if (inputs.length < 2) return { err: 'drawer inputs not found', n: inputs.length };
  if ((inputs[0].value || '').trim() !== '9999') return { err: 'budget input mismatch', b: inputs[0].value };
  return { ok: true, value: inputs[1].value };
})()`;

const DRAWER_CANCEL = `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const cancel = btns.find(b => (b.innerText || '').trim() === '取消' && b.offsetParent !== null);
  if (!cancel) return { err: 'cancel btn not found' };
  cancel.click();
  return { ok: true };
})()`;

function drawerSetRoiSave(roi) {
  return `(() => {
  const inputs = Array.from(document.querySelectorAll('input.ovui-input[type="text"]'));
  if (inputs.length < 2) return { err: 'drawer inputs not found', n: inputs.length };
  const roiInput = inputs[1];
  roiInput.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(roiInput, '${roi}');
  roiInput.dispatchEvent(new Event('input', { bubbles: true }));
  roiInput.dispatchEvent(new Event('change', { bubbles: true }));
  const save = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === '保存' && b.offsetParent !== null);
  if (!save) return { err: 'save btn not found', value: roiInput.value };
  save.click();
  return { ok: true, value: roiInput.value };
})()`;
}

function verifyRowRoi(roi) {
  return `(() => {
  const rows = Array.from(document.querySelectorAll('tr'));
  const row = rows.find(r => (r.innerText || '').includes('每日预算') && (r.innerText || '').includes('9999元'));
  if (!row) return { err: 'main row not found' };
  const m = (row.innerText || '').match(/ROI目标[\\s\\S]{0,20}/);
  return { ok: !!(m && m[0].includes('${roi}')), text: m ? m[0] : null };
})()`;
}

/**
 * 写兜底：主计划 ROI 调整（CDP 主世界真人点击）
 * opts: { confirm, dryRun }
 *  - dryRun=true：只打开抽屉读取当前 ROI → 点取消，不保存（无需 confirm）
 *  - 真实执行必须 opts.confirm === true
 */
async function planRoiUpdateFallback(accountId, roiGoal, opts = {}) {
  if (opts.dryRun !== true && opts.confirm !== true) {
    throw new Error('planRoiUpdateFallback: 写操作必须显式 confirm=true（browserFallback 不自动扣扳机）');
  }
  const browser = await ensureBrowser();
  const context = browser.contexts()[0] || await browser.newContext();
  await injectCookies(context, accountId).catch(() => {});
  const page = await context.newPage();
  await page.bringToFront().catch(() => {});
  await page.goto(getUniPromUrl(accountId), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(6000);
  try {
    const edit = await cdpEvaluate(page, MAIN_ROW_CLICK_EDIT);
    if (edit && edit.err) throw new Error('编辑入口: ' + edit.err);
    await page.waitForTimeout(4000);
    const read = await cdpEvaluate(page, DRAWER_READ_ROI);
    if (read && read.err) throw new Error('抽屉读取: ' + read.err);
    if (opts.dryRun) {
      await cdpEvaluate(page, DRAWER_CANCEL);
      return { source: 'browser_fallback_cdp', action: 'dry_run', drawer_roi: read.value, dry_run: true };
    }
    const setRes = await cdpEvaluate(page, drawerSetRoiSave(String(roiGoal)));
    if (setRes && setRes.err) throw new Error('保存: ' + setRes.err);
    await page.waitForTimeout(6000);
    const verify = await cdpEvaluate(page, verifyRowRoi(String(roiGoal)));
    return {
      source: 'browser_fallback_cdp',
      action: 'update_plan_roi',
      ad_id: getAccountConfig(accountId).primary_ad_id,
      roiGoal,
      drawer_old_value: read.value,
      verified: !!(verify && verify.ok),
      row_text: verify && verify.text,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/* 追投创建写兜底（下一里程碑）：素材追投弹窗 → 选素材/预算/ROI → 确认（同 CDP 主世界通道） */

module.exports = {
  ensureBrowser,
  openPage,
  captureResponse,
  planRoiFallback,
  cdpEvaluate,
  planRoiUpdateFallback,
};
