const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR, CACHE_DIR, COOKIE_PATH, AAVID } = require('./config');

let browserContext = null;
let browserPage = null;
let browserInitPromise = null;
let browserInitFailed = false;
let browserInitFailedAt = 0;
// 导航状态缓存：首次导航成功后设为 true，后续跳过 URL 检查与 page.goto。
// 仅在 cookie 刷新或浏览器重启时重置为 false。
let navigated = false;

async function ensureBrowser() {
  if (browserPage) return browserPage;
  // 初始化失败后有 30s 冷却，超时后允许重试（cookie 临时失效/Chromium 冷启动超时等场景可自愈）
  if (browserInitFailed && Date.now() - browserInitFailedAt < 30000) {
    throw new Error('浏览器长连接初始化失败（冷却中），回退到 spawn 模式');
  }
  browserInitFailed = false;
  if (browserInitPromise) return browserInitPromise;
  browserInitPromise = (async () => {
    try {
      const { chromium } = require('playwright');
      if (!await fsPromises.stat(COOKIE_PATH).then(()=>true).catch(()=>false)) throw new Error(`cookie 文件不存在: ${COOKIE_PATH}`);
      const cookieHeader = (await fsPromises.readFile(COOKIE_PATH, 'utf8')).trim();
      const cookies = cookieHeader.split(';').map(s => s.trim()).filter(Boolean).map(p => {
        const idx = p.indexOf('=');
        return idx > 0 ? { name: p.slice(0, idx), value: p.slice(idx + 1), domain: '.qianchuan.jinritemai.com', path: '/' } : null;
      }).filter(Boolean);
      if (!cookies.some(c => c.name === 'sessionid' || c.name === 'sid_tt')) {
        throw new Error('cookie.txt 缺少 sessionid/sid_tt');
      }
      const userDataDir = path.join(require('os').tmpdir(), `qc_longlived_${process.pid}`);
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1366, height: 900 },
        args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
      });
      await browserContext.addCookies(cookies);
      browserPage = browserContext.pages()[0] || await browserContext.newPage();

      browserContext.on('close', () => {
        console.log('[browser] ⚠️ Chromium 进程意外关闭，清理缓存以备下次重启');
        browserContext = null;
        browserPage = null;
        browserInitFailed = false;
        navigated = false;
      });
      console.log('[browser] 长连接已建立');
      navigated = false;
      return browserPage;
    } catch (e) {
      console.error(`[browser] 长连接初始化失败: ${e.message}`);
      browserInitFailed = true;
      browserInitFailedAt = Date.now();
      if (browserContext) {
        browserContext.close().catch(() => {});
        browserContext = null;
      }
      throw e;
    } finally {
      browserInitPromise = null;
    }
  })();
  return browserInitPromise;
}

async function fetchOverviewViaBrowser(start, end) {
  const page = await ensureBrowser();
  const t0 = Date.now();
  if (!navigated && (!page.url() || page.url() === 'about:blank' || /passport|login/.test(page.url()))) {
    try {
      await page.goto(`https://qianchuan.jinritemai.com/home?aavid=${AAVID}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      navigated = true;
    } catch (e) { console.log(`[browser] 导航警告: ${e.message}`); }
    if (/passport|login/i.test(page.url())) throw new Error('未登录千川');
  }
  const body = {
    DataSetKey: 'home_cost_uni_prom',
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'ignore_zero_dimension', Operator: 7, Values: ['on'] },
      { Field: 'advertiser_id', Operator: 7, Values: [AAVID] },
      { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'query_self_data', Operator: 7, Values: ['off'] },
    ] },
    Dimensions: ['stat_time_hour'],
    StartTime: start + ' 00:00:00',
    EndTime: end + ' 23:59:59',
    Metrics: [
      'stat_cost_for_roi2', 'total_prepay_and_pay_settle_roi2_1h',
      'total_order_settle_amount_for_roi2_1h', 'total_order_settle_count_for_roi2_1h',
      'total_order_settle_amount_rate_for_roi2_1h', 'total_prepay_and_pay_order_roi2',
      'total_pay_order_gmv_include_coupon_for_roi2',
    ],
    Extra: { refer: 'ecp,7345401917394190374,7345401917394141222,home_cost_uni_prom' },
  };
  const url = `https://qianchuan.jinritemai.com/ad/api/data/v1/common/statQuery?reqFrom=content_uni_data&aavid=${AAVID}&gfversion=1.0.0.4862`;
  const raw = await page.evaluate(async ({ url, body }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Accept': 'application/json, text/plain, */*' }, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timeout);
      return { status: r.status, text: await r.text() };
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }, { url, body });
  const elapsed = Date.now() - t0;
  console.log(`[browser] overview ${start}~${end} 状态=${raw.status} 长度=${raw.text.length} (${elapsed}ms)`);
  if (raw.status !== 200) throw new Error(`overview API 失败: ${raw.status}`);
  const parsed = JSON.parse(raw.text);
  if (!parsed?.data?.StatsData?.Totals) throw new Error('overview 响应无 Totals');
  const outPath = path.join(CACHE_DIR, `overview_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}.json`);
  const METRIC_LABELS = {
    'stat_cost_for_roi2': '整体消耗(元)', 'total_prepay_and_pay_settle_roi2_1h': '净成交ROI',
    'total_order_settle_amount_for_roi2_1h': '净成交金额(元)', 'total_order_settle_count_for_roi2_1h': '净成交订单数',
    'total_order_settle_amount_rate_for_roi2_1h': '净成交金额结算率', 'total_prepay_and_pay_order_roi2': '整体支付ROI',
    'total_pay_order_gmv_include_coupon_for_roi2': '整体成交金额(元)',
  };
  const kpiRaw = {};
  const totals = parsed.data.StatsData.Totals;
  for (const [k, v] of Object.entries(METRIC_LABELS)) {
    if (totals[k]?.ValueStr != null) kpiRaw[v] = totals[k].ValueStr;
  }
  const outData = {
    start, end, aavid: AAVID, fetched_at: new Date().toISOString(), source: 'api', kpi_raw: kpiRaw,
    row: { Dimensions: { advertiser_id: AAVID }, Metrics: Object.fromEntries(Object.entries(METRIC_LABELS).map(([k, v]) => [k, parseFloat(String(kpiRaw[v] || '').replace(/[%,]/g, '')) || null])) },
  };
  // 写盘用于 overview 路由后续读取，但函数直接返回内存对象，免去一次冗余的磁盘读回
  await fsPromises.writeFile(outPath, JSON.stringify(outData, null, 2), 'utf8');
  return outData;
}

const collectTasks = new Map();

async function runFetchOverviewViaSpawn(start, end) {
  return new Promise(async (resolve, reject) => {
    const overviewPath = path.join(CACHE_DIR, `overview_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}.json`);
    const scriptPath = path.join(ROOT_DIR, 'tools', 'data', 'fetch_overview.js');
    if (!await fsPromises.stat(scriptPath).then(()=>true).catch(()=>false)) return reject(new Error(`脚本不存在: ${scriptPath}`));
    console.log(`[overview] 启动采集: ${scriptPath} ${start} ${end} --cookies`);
    const child = spawn(process.execPath, [scriptPath, start, end, '--cookies'], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stdout.on('data', d => process.stdout.write(`  [fetch] ${d}`));
    child.stderr.on('data', d => { stderr += d; process.stderr.write(`  [fetch:err] ${d}`); });

    const timer = setTimeout(() => {
      console.log('[overview] 采集超时，先发 SIGTERM 让子进程清理 Chromium，2s 后强杀');
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      reject(new Error('采集超时（90s）'));
    }, 90000);

    child.on('close', async code => {
      clearTimeout(timer);
      if (code === 0 && await fsPromises.stat(overviewPath).then(()=>true).catch(()=>false)) {
        try {
          const data = JSON.parse(await fsPromises.readFile(overviewPath, 'utf8'));
          resolve(data);
        } catch (e) {
          reject(new Error(`采集完成但 JSON 解析失败: ${e.message}`));
        }
      } else {
        reject(new Error(`采集退出码=${code} stderr=${stderr.slice(0, 300)}`));
      }
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Spawn 失败: ${err.message}`));
    });
  });
}

// 纯 HTTP 版本：用 statQuery 调 home_cost_uni_prom，不再启动浏览器
async function fetchOverviewHTTP(start, end, accountId, opts = {}) {
  const { statQuery, statQueryDirect } = require('./qianchuan');
  const sq = opts.skipQueue ? statQueryDirect : statQuery;
  const aavid = accountId
    ? (require('./config').QIANCHUAN_ACCOUNTS.find(a => a.id === accountId) || {}).aavid || AAVID
    : AAVID;
  const body = {
    reqFrom: 'content_uni_data',
    DataSetKey: 'home_cost_uni_prom',
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'ignore_zero_dimension', Operator: 7, Values: ['on'] },
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'query_self_data', Operator: 7, Values: ['off'] },
    ] },
    Dimensions: ['stat_time_hour'],
    StartTime: start + ' 00:00:00',
    EndTime: end + ' 23:59:59',
    Metrics: [
      'stat_cost_for_roi2', 'total_prepay_and_pay_settle_roi2_1h',
      'total_order_settle_amount_for_roi2_1h', 'total_order_settle_count_for_roi2_1h',
      'total_order_settle_amount_rate_for_roi2_1h', 'total_prepay_and_pay_order_roi2',
      'total_pay_order_gmv_include_coupon_for_roi2',
    ],
    Extra: { refer: 'ecp,7345401917394190374,7345401917394141222,home_cost_uni_prom' },
  };
  const result = await sq(body, 3, accountId);
  const totals = result && result.data && result.data.StatsData && result.data.StatsData.Totals;
  if (!totals) throw new Error('overview HTTP 响应无 Totals');
  const METRIC_LABELS = {
    'stat_cost_for_roi2': '整体消耗(元)', 'total_prepay_and_pay_settle_roi2_1h': '净成交ROI',
    'total_order_settle_amount_for_roi2_1h': '净成交金额(元)', 'total_order_settle_count_for_roi2_1h': '净成交订单数',
    'total_order_settle_amount_rate_for_roi2_1h': '净成交金额结算率', 'total_prepay_and_pay_order_roi2': '整体支付ROI',
    'total_pay_order_gmv_include_coupon_for_roi2': '整体成交金额(元)',
  };
  const kpiRaw = {};
  for (const [k, v] of Object.entries(METRIC_LABELS)) {
    if (totals[k] && totals[k].ValueStr != null) kpiRaw[v] = totals[k].ValueStr;
  }
  const outData = {
    start, end, aavid, fetched_at: new Date().toISOString(), source: 'http', kpi_raw: kpiRaw,
    row: { Dimensions: { advertiser_id: aavid }, Metrics: Object.fromEntries(Object.entries(METRIC_LABELS).map(([k, v]) => [k, parseFloat(String(kpiRaw[v] || '').replace(/[%,]/g, '')) || null])) },
  };
  // 写盘保持兼容（overview 路由会读文件）
  const outPath = path.join(CACHE_DIR, `overview_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}_${accountId || 'def'}.json`);
  await fsPromises.writeFile(outPath, JSON.stringify(outData, null, 2), 'utf8').catch(() => {});
  return outData;
}

function runFetchOverview(start, end, accountId, opts = {}) {
  const key = `${start}~${end}~${accountId || ''}~${opts.skipQueue ? 'direct' : 'queue'}`;
  if (collectTasks.has(key)) return collectTasks.get(key);

  const promise = fetchOverviewHTTP(start, end, accountId, opts);
  collectTasks.set(key, promise);
  promise.finally(() => collectTasks.delete(key));
  return promise;
}



// CDP 模式：用真实 Chrome（带登录态的 Profile）启动，Playwright 通过 CDP 连上去开探针页。
// 不需要 cookie.txt，直接复用日常登录态。
let cdpBrowser = null;
let cdpChromeProcess = null;
const CHROME_EXE = '';
const CHROME_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CDP_PORT = 9333;

async function openDebugProbe(targetUrl, opts = {}) {
  const { defaultAccountId } = require('./api-helpers');
  const account = opts.account || defaultAccountId();
  const { QIANCHUAN_ACCOUNTS } = require('./config');
  const acc = QIANCHUAN_ACCOUNTS.find(a => a.id === account) || QIANCHUAN_ACCOUNTS[0];
  const profileDir = acc.chromeProfile || 'Default';

  const { chromium } = require('playwright');
  const LOG_FILE = path.join(__dirname, '..', '..', 'logs', `probe_records_${Date.now()}.jsonl`);
  if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  // 如果已有 CDP 浏览器连接，复用
  if (cdpBrowser) {
    try {
      const context = cdpBrowser.contexts()[0];
      const probePage = await context.newPage();
      await setupProbeListeners(probePage, LOG_FILE);
      await probePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('[probe] 跳转告警: ' + e.message));
      return { ok: true, msg: `探针已复用CDP连接(Profile=${profileDir})`, logFile: LOG_FILE, close: () => { probePage.close().catch(() => {}); } };
    } catch (e) {
      console.log('[probe] CDP 复用失败，重新连接: ' + e.message);
      cdpBrowser = null;
    }
  }

  // 启动真实 Chrome（带登录态），开 CDP 端口
  console.log(`[probe] 启动真实 Chrome (Profile=${profileDir}, CDP端口=${CDP_PORT})...`);
  cdpChromeProcess = spawn(CHROME_EXE, [
    `--profile-directory=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_USER_DATA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session=false',
  ], { detached: false, stdio: 'ignore' });

  // 等 CDP 端口就绪
  let cdpReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const net = require('net');
      const ok = await new Promise(resolve => {
        const sock = net.connect(CDP_PORT, '127.0.0.1', () => { sock.end(); resolve(true); });
        sock.on('error', () => resolve(false));
      });
      if (ok) { cdpReady = true; break; }
    } catch {}
  }
  if (!cdpReady) {
    throw new Error(`Chrome CDP 端口 ${CDP_PORT} 未就绪（等了10秒）`);
  }

  // Playwright 连上去
  cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  console.log(`[probe] CDP 已连接, contexts=${cdpBrowser.contexts().length}`);

  const context = cdpBrowser.contexts()[0] || await cdpBrowser.newContext();
  const probePage = await context.newPage();
  await probePage.bringToFront();
  await setupProbeListeners(probePage, LOG_FILE);

  console.log('[probe] 探针已启动，跳转至: ' + targetUrl);
  await probePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('[probe] 跳转告警: ' + e.message));

  return {
    ok: true,
    msg: `探针已启动(真实Chrome Profile=${profileDir})`,
    logFile: LOG_FILE,
    close: () => { probePage.close().catch(() => {}); },
  };
}

async function setupProbeListeners(probePage, LOG_FILE) {
  probePage.on('request', req => {
    const url = req.url();
    if ((url.includes('/api/') || url.includes('/uni-prom/')) && req.method() === 'POST') {
      console.log('');
      console.log('[➡ PROBE REQ] ' + req.method() + ' ' + url);
      try { console.log(JSON.parse(req.postData())); } catch(e) { console.log(req.postData()); }
    }
  });
  probePage.on('response', async res => {
    const url = res.url();
    if ((url.includes('/api/') || url.includes('/uni-prom/')) && res.request().method() === 'POST') {
      try {
        const body = await res.json();
        console.log('[⬅ PROBE RES] ' + res.status() + ' ' + url);
        const record = { time: new Date().toISOString(), url, request: res.request().postData(), response: body };
        fs.appendFileSync(LOG_FILE, JSON.stringify(record) + String.fromCharCode(10));
      } catch(e) {}
    }
  });
}
async function closeBrowser() {
  if (browserContext) {
    try { await browserContext.close(); } catch (e) { /* ignore */ }
    browserContext = null;
    browserPage = null;
  }
  // 清理 CDP Chrome 子进程，防止孤儿进程
  if (cdpChromeProcess) {
    try { cdpChromeProcess.kill(); } catch (e) { /* ignore */ }
    cdpChromeProcess = null;
  }
  navigated = false;
}

module.exports = { ensureBrowser, closeBrowser, fetchOverviewViaBrowser, runFetchOverview, runFetchOverviewViaSpawn, openDebugProbe };