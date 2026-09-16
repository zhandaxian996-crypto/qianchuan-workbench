const fs = require('fs');
const path = require('path');

// 本文件位于 server/lib/，项目根目录为上两级
const PROJECT_DIR = __dirname;
const ROOT_DIR = path.resolve(PROJECT_DIR, '..', '..');
const RUNTIME_DATA_ROOT = process.env.QC_RUNTIME_DATA_ROOT
  ? path.resolve(process.env.QC_RUNTIME_DATA_ROOT)
  : ROOT_DIR;
// 测试/便携运行时可把配置与真实工作树隔离；未设置时仍只读取项目根 config.json。
// 这不是账号回退机制：显式根目录只改变配置文件与账号草稿的存放位置。
const CONFIG_ROOT = process.env.QC_RUNTIME_CONFIG_ROOT
  ? path.resolve(process.env.QC_RUNTIME_CONFIG_ROOT)
  : ROOT_DIR;

const SCRIPTS_DIR = path.join(CONFIG_ROOT, 'scripts');
const CACHE_DIR = path.join(RUNTIME_DATA_ROOT, 'cache');
const REPORTS_DIR = path.join(RUNTIME_DATA_ROOT, 'reports');
const LOGS_DIR = path.join(RUNTIME_DATA_ROOT, 'logs');
const TMP_DIR = path.join(RUNTIME_DATA_ROOT, 'tmp');
const STORAGE_DIR = path.join(RUNTIME_DATA_ROOT, 'storage');
const COOKIE_PATH = path.join(SCRIPTS_DIR, 'cookie.txt');

// 确保输出目录存在（tmp 为盘面 fast-path/异步刷新标记文件目录，全新装包必须自举——交付版 E2E 实测修复回流）
[CACHE_DIR, REPORTS_DIR, LOGS_DIR, TMP_DIR, STORAGE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 可被 config.json / QC_PORT 覆盖
let PORT = 18991;
// 可被 config.json 覆盖（默认值仅为示例，生产环境必须通过 config.json 覆盖）
let AAVID = '';
// 千川多账号。每账号: { id, name, aavid, cookieFile }。cookieFile 相对 scripts/。
// 默认账号(列表[0])用全局 AAVID + scripts/cookie.txt，向后兼容。
// 可被 config.json 覆盖
// 千川多账号默认值为空数组，生产环境必须通过 config.json 的 qianchuan_accounts 配置
// 保持数组引用稳定：运行时增删账号时，已经解构导入本数组的模块也必须看见新值。
const QIANCHUAN_ACCOUNTS = [];
// 同上。账号级阈值必须与账号列表一起原地更新，避免运行时回落到其他账号的默认值。
const account_config = {};
// 可被 config.json 覆盖
let PAGE_SIZE = 200;
// 可被 config.json 覆盖
let REQUEST_INTERVAL = 1500; // 单账号千川不限频；此处仅作请求最小间隔兜底(可调 200~4000，批量回填建议 200~500)
let ACCOUNTS = [];
let SCHEDULER = {
  enabled: true,
  statusIntervalMs: 30 * 1000,
  liveDecisionMs: 60 * 60 * 1000,
  idleDecisionMs: 3 * 60 * 60 * 1000,
  liveFreshMs: 10 * 60 * 1000,
  staleRounds: 2,
};
let WRITE_API_TOKEN = process.env.QC_WRITE_TOKEN || ''; // 可选：配置后写接口需携带 Bearer/ x-api-token
let CLEANUP_ENABLED = false; // 本地默认关闭磁盘清理，避免误删历史缓存/报表
let UI_FEATURES = {
};
// 安全默认：仅监听本机回环地址。需要局域网访问时在 config.json 显式设 host: '0.0.0.0'
let HOST = process.env.QC_HOST || '127.0.0.1';
let manual_config = { avg_order_price: null, break_even_roi: 2.0, full_auto_delete: false }; // 保本唯一口径=净成交 break_even_roi；项目不自行决定写操作
// 历史账户专用说明已从试用包移除。
// 默认只放 MHS 工程目标文档 §4.3/§4.4/§4.6 明示的执行约束口径；公式系数/档位阈值默认 null。
let MHS = {
  version: 'V1-uncalibrated',
  alpha: null, beta: null, gamma: null, delta: null,
  t_you: null, t_qian: null, t_lie: null,
  decay_half_life_days: 7,
  head_cost_share: 0.1,
  decline_cost_ratio: 0.4,
  signal_min_cost: 20,
  kill_line_factor: 2,
  kill_roi: 1.05,
  stay_revive_roi: 1.5,
  stay_hours: 48,
  trend_center: 1,  // 历史账户专用说明已从试用包移除。
  chronic_roi_factor: 0.5,
  chronic_min_cost: 300,
  boost_daily_cap: 3,
  boost_daily_budget_cap: 1200,  // 历史账户专用说明已从试用包移除。
  boost_new_daily_cap: 1,
  boost_stop_cost: 500,
  boost_stop_roi: 1.5,
  account_stop_roi: 1.05,
  account_stop_balance: 800,
  cold_max_days: 2,
  cold_group_budget: 300,
  cold_roi_goal_min: 1.5,
  cold_roi_goal_max: 1.89,
  cold_promote_roi: 2.0,
  cold_promote_orders: 3,
  cold_promote_ctr_factor: 1.2,
  cold_kill_cost: 100,
  quota_warn_line: 300,
  fallback_boost_budget: 150,
  vocab_file: '',
};
let CLASSIFICATION = {
  minValidCost: 50,              // calcBaselines: 有效素材最低消耗
  minValidViews: 100,            // calcBaselines: 有效素材最低播放
  coldMaxDays: 3,                // calcStage: 冷启动最大天数
  coldMaxCost: 300,              // calcStage: 冷启动最大消耗
  coldMaxOrders: 20,             // calcStage: 冷启动最大订单数
  coldMaxDaysExtended: 7,        // calcStage: 冷启动延长判断天数
  activeMinDays: 7,              // calcStage: 活跃期最小天数
  activeMinCost: 1000,           // calcStage: 活跃期最小消耗
  testingMaxCost: 50,            // calcRoiStatus: 测试期最大消耗
  roiTargetMultiplier: 1.05,     // calcRoiStatus: 达标ROI倍数
  roiUnderperformingMultiplier: 0.7, // calcRoiStatus: 略亏ROI倍数
  qualityMinCost: 100,           // calcIsQuality: 优质素材最低消耗
  qualityCostRatio: 0.8,         // calcIsQuality: 优质素材消耗占均值比
  refundWarnMultiplier: 1.5,     // extractTags: 退款预警倍数
  boostWarnCost: 300,            // extractTags: 追投预警消耗
  boostWarnRoiRatio: 0.8,        // extractTags: 追投预警ROI比
  churnRateWarnViews: 500,       // extractTags: 流失预警最低播放
  churnRateWarnRatio: 0.7,       // extractTags: 流失预警倍数
  declineRoiRatio: 0.6,          // extractTags: 跳水预警ROI比
  decayRoiRatio: 0.7,            // calcStage: 衰退ROI比
};
// 云图默认值（空字符串，生产环境必须通过 config.json 配置）
let YUNTU_AADVID = '';
let YUNTU_INDUSTRY_ID = '';
let YUNTU_BRAND_ID = '';
let YUNTU_CDP_PORT = 9333;
// 云图多账号列表。每个账号: { id, name, aadvid, brand_id, industry_id, cookieFile }
// cookieFile 相对 scripts/ 目录。cookie 失效需重新导出(浏览器扩展导出 Netscape 转 header)。
// 云图多账号默认值为空数组，生产环境必须通过 config.json 的 yuntu_accounts 配置
let YUNTU_ACCOUNTS = [];

const configPath = path.join(CONFIG_ROOT, 'config.json');
const configExamplePath = path.join(CONFIG_ROOT, 'config.example.json');
const ACCOUNT_PROFILES_DIR = path.join(CONFIG_ROOT, 'account-profiles');
require('./accountPersistence').recoverAtStartup(CONFIG_ROOT);
let config = {};

function normalizeQcAccounts(rawAccounts) {
  return (Array.isArray(rawAccounts) ? rawAccounts : []).map(a => ({
    id: a.id,
    name: a.name,
    aavid: String(a.aavid),
    anchorId: a.anchorId || '',
    primary_ad_id: a.primary_ad_id || '',
    cookieFile: a.cookieFile || 'cookie.txt',
    // 生产运行时只走 Cookie 直连。遗留 Chrome/CDP 字段被有意忽略；探针自带独立参数。
    expectedLiveWindow: a.expectedLiveWindow || '',
    compassName: a.compassName || a.name || '',
    compassMatch: a.compassMatch || a.name || ''
  }));
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source && typeof source === 'object' ? source : {});
}

/**
 * 仅刷新会被账号注册表影响的运行时引用。
 * 不重载完整 config，避免端口、鉴权令牌、调度器等进程级配置在运行中被静默改变。
 */
function applyAccountRegistry(nextConfig) {
  const rawAccounts = nextConfig && nextConfig.qianchuan_accounts;
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
    throw new Error('qianchuan_accounts 不能为空');
  }
  const normalized = normalizeQcAccounts(rawAccounts);
  const ids = new Set();
  for (const account of normalized) {
    if (!account.id || ids.has(account.id)) throw new Error(`账号列表存在非法或重复 ID: ${account.id || '(empty)'}`);
    ids.add(account.id);
  }
  QIANCHUAN_ACCOUNTS.splice(0, QIANCHUAN_ACCOUNTS.length, ...normalized);
  replaceObject(account_config, nextConfig.account_config);
  replaceObject(agent_policy, nextConfig.agent_policy);
  return QIANCHUAN_ACCOUNTS;
}

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.error('[config] 已成功加载本地 config.json 配置');
  } else if (fs.existsSync(configExamplePath)) {
    // 示例不是用户账户；首次启动保持空账户，由接入向导创建。
    console.error('[config] 首次启动，请在工作台完成账户接入');
  }
} catch (e) {
  console.error('[config] 读取配置失败，将使用无账户默认值；请检查配置格式与文件权限');
}

if (config.port) PORT = config.port;
if (process.env.QC_PORT) {
  const p = parseInt(process.env.QC_PORT, 10);
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) PORT = p;
  else console.error(`[config] 忽略非法 QC_PORT="${process.env.QC_PORT}"，继续使用 ${PORT}`);
}
if (config.aavid) AAVID = String(config.aavid);
if (config.page_size) PAGE_SIZE = config.page_size;
if (config.request_interval) REQUEST_INTERVAL = config.request_interval;
// 千川多账号 config.json 覆盖
if (Array.isArray(config.qianchuan_accounts) && config.qianchuan_accounts.length) {
  QIANCHUAN_ACCOUNTS.push(...normalizeQcAccounts(config.qianchuan_accounts));
}

if (Array.isArray(config.accounts) && config.accounts.length) {
  ACCOUNTS = config.accounts.filter(a => a && a.id);
}
if (config.scheduler) {
  SCHEDULER = { ...SCHEDULER, ...config.scheduler };
}
if (config.write_api_token) WRITE_API_TOKEN = String(config.write_api_token);
if (typeof config.cleanup_enabled === 'boolean') CLEANUP_ENABLED = config.cleanup_enabled;
if (config.ui_features && typeof config.ui_features === 'object') {
  UI_FEATURES = Object.fromEntries(Object.keys(UI_FEATURES).map(key => [key, config.ui_features[key] ?? UI_FEATURES[key]]));
}
// CLI / QC_HOST 必须高于 config.json：隔离测试与应急收口监听范围时不能被生产配置反向覆盖。
if (config.host && !process.env.QC_HOST) HOST = String(config.host);
if (config.manual_config && typeof config.manual_config === 'object') {
  manual_config = { ...manual_config, ...config.manual_config };
}
// MHS 参数段（2026-07-28 §七-5）：config.json 的 mhs 覆盖默认值；按账号覆盖走 account_config[acc].mhs（lib/mhs.js 合并）
if (config.mhs && typeof config.mhs === 'object') {
  MHS = { ...MHS, ...config.mhs };
}
// 按账号差异化配置（2026-07-28 多店铺扩展）：account_config[accountId] 覆盖 manual_config 全局值
if (config.account_config && typeof config.account_config === 'object') {
  Object.assign(account_config, config.account_config);
}
// Agent 写操作策略：未配置时保持旧账户兼容；新账户初始化器固定写 recommendation_only。
const agent_policy = config.agent_policy && typeof config.agent_policy === 'object'
  ? { ...config.agent_policy }
  : {};
// 历史账户专用说明已从试用包移除。
let seasonal_products = {};
if (config.seasonal_products && typeof config.seasonal_products === 'object') {
  seasonal_products = config.seasonal_products;
}
if (config.classification && typeof config.classification === 'object') {
  CLASSIFICATION = { ...CLASSIFICATION, ...config.classification };
}
if (config.yuntu_aavid) YUNTU_AADVID = String(config.yuntu_aavid);
if (config.yuntu_industry_id) YUNTU_INDUSTRY_ID = String(config.yuntu_industry_id);
if (config.yuntu_brand_id) YUNTU_BRAND_ID = String(config.yuntu_brand_id);
if (config.yuntu_cdp_port) YUNTU_CDP_PORT = parseInt(config.yuntu_cdp_port, 10) || YUNTU_CDP_PORT;
// config.json 可覆盖默认账号列表(整体替换)
if (Array.isArray(config.yuntu_accounts) && config.yuntu_accounts.length) {
  YUNTU_ACCOUNTS = config.yuntu_accounts.map(a => ({
    id: a.id, name: a.name, aadvid: String(a.aadvid), brand_id: String(a.brand_id),
    industry_id: String(a.industry_id), cookieFile: a.cookieFile || 'yuntu_cookie.txt',
    version: a.version || 'brand',
  }));
}

// 常量
const MAX_PAGES = 25;
// 常量
const GFVERSION = '1.0.0.5718';
// 常量
const CACHE_TTL_MS = 30 * 1000;
const SLOW_REQUEST_MS = 8000;
const SLOW_REQUEST_LIMIT = 3;

module.exports = {
  ROOT_DIR,
  PROJECT_DIR: ROOT_DIR,
  SCRIPTS_DIR,
  CACHE_DIR,
  STORAGE_DIR,
  REPORTS_DIR,
  LOGS_DIR,
  COOKIE_PATH,
  PORT,
  HOST,
  AAVID,
  PAGE_SIZE,
  REQUEST_INTERVAL,
  MAX_PAGES,
  GFVERSION,
  CACHE_TTL_MS,
  SLOW_REQUEST_MS,
  SLOW_REQUEST_LIMIT,
  ACCOUNTS,
  SCHEDULER,
  WRITE_API_TOKEN,
  CLEANUP_ENABLED,
  UI_FEATURES,
  manual_config,
  MHS,
  account_config,
  agent_policy,
  seasonal_products,
  CLASSIFICATION,
  YUNTU_AADVID,
  YUNTU_INDUSTRY_ID,
  YUNTU_BRAND_ID,
  YUNTU_CDP_PORT,
  YUNTU_ACCOUNTS,
  QIANCHUAN_ACCOUNTS,
  CONFIG_PATH: configPath,
  ACCOUNT_PROFILES_DIR,
  applyAccountRegistry,
};

