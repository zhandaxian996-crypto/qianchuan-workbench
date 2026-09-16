const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sendJSON } = require('../lib/utils');
const { isValidAccountId } = require('../lib/api-helpers');
const { fetchCompassApi, parseProductList, cellVal, infoStr } = require('../lib/compassApi');
const { getCookieMeta, isCookieStale } = require('../lib/compassDirect');
const { fetchScreenLive, fetchProductExplainDetail, fetchLiveOrders, fetchLiveOrderAgg, mergePortraitFallback } = require('../lib/compassScreen');
const { getLatestWatch } = require('../lib/liveCollector');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache', 'compass');
const COLLECTOR = path.join(__dirname, '..', '..', 'tools', 'compass_collector.js');

// goods/videos 服务端缓存：这两个接口活拉要驱动浏览器取数（会把罗盘官网标签激活到前台，
// 用户感觉"页面自己跳走"）。7d/30d 粒度的数据一天一刷足够，TTL 24h（2026-07-26 从 30min 上调）
const LIVE_CACHE_TTL = 24 * 60 * 60 * 1000;
function readLiveCache(file, maxAge) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (maxAge == null || Date.now() - (j.fetched_at || 0) < maxAge) return j.payload;
  } catch (_) { /* 没缓存或损坏 */ }
  return null;
}
function writeLiveCache(file, payload) {
  try { fs.writeFileSync(file, JSON.stringify({ fetched_at: Date.now(), payload })); } catch (_) { /* 缓存写失败不影响主流程 */ }
}

// 刷新频率限制：同一账号 10 分钟内只允许触发一次
const refreshLock = new Map(); // account -> timestamp

function latestSnapshot(account) {
  let files = [];
  try {
    // 只认客群快照 <account>_crowd_*.json（compass_collector 产物）；
    // goods/videos/screen 等缓存文件同目录同前缀，混进来会把客群板块冲成 0.00%（2026-07-25 事故）
    files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(`${account}_crowd_`) && f.endsWith('.json')).sort().reverse();
  } catch (e) { return { latest: null, files: [] }; }
  if (!files.length) return { latest: null, files: [] };
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[0]), 'utf8'));
    return { latest, files: files.slice(0, 10) };
  } catch (e) {
    return { latest: null, files: [] };
  }
}

/**
  * 历史账户专用说明已从试用包移除。
 *   返回该账号最新的罗盘快照（cache/compass/<account>_*.json 最新一份）+ 最近文件列表
 *
 * POST /api/compass/refresh { account, range? }
 *   后台触发 tools/compass_collector.js 重新采集（WebBridge 驱动浏览器，约 1~2 分钟），
 *   同账号 10 分钟频率限制。刷新完成后重新 GET /api/compass 即可看到新数据。
 */
async function handleCompass(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/compass/cookie-status') {
    try {
      const account = url.searchParams.get('account') || url.searchParams.get('accountId');
      const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
      const accounts = account ? [account] : (QIANCHUAN_ACCOUNTS || []).map(a => a.id);
      const status = {};
      for (const acc of accounts) {
        const meta = getCookieMeta(acc);
        status[acc] = {
          synced_at: meta ? meta.synced_at : null,
          cookie_count: meta ? meta.cookie_count : 0,
          cookie_length: meta ? meta.cookie_length : 0,
          stale: isCookieStale(acc, 24),
          page_url: meta ? meta.page_url : null,
        };
      }
      return sendJSON(res, { ok: true, status });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (req.method === 'GET' && pathname === '/api/compass') {
    try {
      const account = url.searchParams.get('account') || url.searchParams.get('accountId');
      if (!account || !isValidAccountId(account)) {
        return sendJSON(res, { ok: false, error: '缺少或非法的 account 参数' }, 400);
      }
      const { latest, files } = latestSnapshot(account);
      if (!latest) {
        return sendJSON(res, { ok: true, account, snapshot: null, files, hint: '暂无快照，可 POST /api/compass/refresh 触发首次采集' });
      }
      return sendJSON(res, { ok: true, account, snapshot: latest, files });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (req.method === 'POST' && pathname === '/api/compass/refresh') {
    // 2026-07-29 免除写鉴权：本接口只触发数据采集（不改任何投放状态），
    // 滥用上限被下方 10 分钟/账号限频锁死；此前局域网打开页面点刷新必 401，按钮永远"失败"
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const account = payload.account || payload.accountId;
        const range = payload.range === '7d' ? '7d' : '30d';
        if (!account || !isValidAccountId(account)) {
          return sendJSON(res, { ok: false, error: '缺少或非法的 account 参数' }, 400);
        }
        const last = refreshLock.get(account) || 0;
        const waitSec = Math.ceil((600000 - (Date.now() - last)) / 1000);
        if (Date.now() - last < 600000) {
          return sendJSON(res, { ok: false, error: `刷新过于频繁，请 ${waitSec} 秒后再试`, retry_after_sec: waitSec }, 429);
        }
        refreshLock.set(account, Date.now());

        const child = spawn(process.execPath, [COLLECTOR, '--account', account, '--range', range], {
          detached: true,
          stdio: 'ignore',
          cwd: path.join(__dirname, '..', '..'),
          windowsHide: true,
        });
        child.unref();
        return sendJSON(res, { ok: true, refreshing: true, account, range, eta_seconds: 90, hint: '采集已在后台运行，约 1~2 分钟后重新 GET /api/compass 查看' });
      } catch (e) {
        return sendJSON(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/compass/screen') {
    try {
      const account = url.searchParams.get('account') || url.searchParams.get('accountId');
      if (!account || !isValidAccountId(account)) {
        return sendJSON(res, { ok: false, error: '缺少或非法的 account 参数' }, 400);
      }
      // 罗盘直播大屏（专业版）实时包：近5分钟脉搏/实时画像/AI 预警（2026-07-25 新增）
      const watch = getLatestWatch().find(a => a.accountId === account);
      const roomId = watch && watch.room && watch.room.room_id;
      if (!(watch && watch.isLive) || !roomId) {
        return sendJSON(res, { ok: true, live: false, five: [], portrait: null, warn: [] });
      }
      const cacheFile = path.join(CACHE_DIR, `${account}_screen.json`);
      if (url.searchParams.get('fresh') !== '1') {
        const hit = readLiveCache(cacheFile, 30000);  // 历史账户专用说明已从试用包移除。
        if (hit) return sendJSON(res, Object.assign({ ok: true, live: true, cached: true, room: watch.room }, hit));
      }
      try {
        const previous = readLiveCache(cacheFile, null);
        const data = mergePortraitFallback(await fetchScreenLive(account, roomId), previous);
        writeLiveCache(cacheFile, data);
        return sendJSON(res, Object.assign({ ok: true, live: true, room: watch.room }, data));
      } catch (e) {
        const stale = readLiveCache(cacheFile, null);
        if (stale) return sendJSON(res, Object.assign({ ok: true, live: true, stale: true, fetch_error: e.message, room: watch.room }, stale));
        throw e;
      }
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (req.method === 'GET' && pathname === '/api/compass/goods') {
    try {
      const account = url.searchParams.get('account') || url.searchParams.get('accountId');
      if (!account || !isValidAccountId(account)) {
        return sendJSON(res, { ok: false, error: '缺少或非法的 account 参数' }, 400);
      }
      const range = url.searchParams.get('range') === '7d' ? '7d' : '30d';
      const cacheFile = path.join(CACHE_DIR, `${account}_goods_${range}.json`);
      if (url.searchParams.get('fresh') !== '1') {
        const hit = readLiveCache(cacheFile, LIVE_CACHE_TTL);
        if (hit) return sendJSON(res, Object.assign({ ok: true, cached: true }, hit));
      }
      const dateType = range === '7d' ? 21 : 23;
      const idx = 'pay_amt,pay_cnt,net_trans_amt,receive_amt,product_show_ucnt,product_click_ucnt,ad_costed_amt';
      const pageReq = encodeURIComponent(JSON.stringify({ page_no: 1, page_size: 15 }));
      const q = `/compass_api/shop/product/product/product_list?date_type=${dateType}&is_activity=false&activity_id=&key_word=&index_selected=${idx}&sale_type=1&content_type=1&cate_ids=&cate_ids_original=0&product_tab=0&page_req=${pageReq}`;
      try {
        const data = await fetchCompassApi(account, q);
        const goods = parseProductList(data);
        writeLiveCache(cacheFile, { account, range, goods });
        return sendJSON(res, { ok: true, account, range, goods });
      } catch (e) {
        const stale = readLiveCache(cacheFile, null);
        if (stale) return sendJSON(res, Object.assign({ ok: true, stale: true, fetch_error: e.message }, stale));
        throw e;
      }
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (req.method === 'GET' && pathname === '/api/compass/product-detail') {
    try {
      const account = url.searchParams.get('account') || url.searchParams.get('accountId');
      const productId = url.searchParams.get('productId');
      if (!account || !isValidAccountId(account)) return sendJSON(res, { ok: false, error: '缺少或非法的 account 参数' }, 400);
      if (!productId || !/^\d{1,30}$/.test(productId)) return sendJSON(res, { ok: false, error: 'productId 必填（数字串）' }, 400);
      const watch = getLatestWatch().find(a => a.accountId === account);
      const roomId = url.searchParams.get('roomId') || (watch && watch.room && watch.room.room_id);
      if (!roomId) return sendJSON(res, { ok: false, error: '缺少 roomId（或账号当前不在播）' }, 400);
      const cacheFile = path.join(CACHE_DIR, `${account}_product_${productId}.json`);
      const hit = readLiveCache(cacheFile, 30000); // 单品详情 30 秒缓存
      if (hit) return sendJSON(res, Object.assign({ ok: true, account, room_id: roomId, cached: true }, hit));
      const data = await fetchProductExplainDetail(account, roomId, productId);
      writeLiveCache(cacheFile, { account, room_id: roomId, product: data });
      return sendJSON(res, { ok: true, account, room_id: roomId, product: data });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }
  if (req.method === 'GET' && pathname === '/api/compass/live-orders') {
    // 直播间订单流（2026-08-18 探针：罗盘大屏订单tab，live_order 签名端点）
    try {
      const account = url.searchParams.get('account') || url.searchParams.get('accountId');
      if (!account || !isValidAccountId(account)) return sendJSON(res, { ok: false, error: '缺少或非法的 account 参数' }, 400);
      const watch = getLatestWatch().find(a => a.accountId === account);
      const roomId = url.searchParams.get('roomId') || (watch && watch.room && watch.room.room_id);
      if (!roomId) return sendJSON(res, { ok: false, error: '缺少 roomId（或账号当前不在播）' }, 400);
      const orderStatus = url.searchParams.get('orderStatus') != null ? parseInt(url.searchParams.get('orderStatus'), 10) : 3;
      const pageNo = url.searchParams.get('page') != null ? parseInt(url.searchParams.get('page'), 10) : 1;
      const cacheFile = path.join(CACHE_DIR, `${account}_live_orders.json`);
      const hit = readLiveCache(cacheFile, 20000); // 订单流 20 秒缓存（直播快照类）
      if (hit) return sendJSON(res, Object.assign({ ok: true, account, room_id: roomId, cached: true }, hit));
      // 历史账户专用说明已从试用包移除。
      const agg = await fetchLiveOrderAgg(account, roomId, { order_status: orderStatus });
      const payload = { account, room_id: roomId, total: agg.total, products: agg.products, orders: agg.orders.slice(0, 20) };
      writeLiveCache(cacheFile, payload);
      return sendJSON(res, Object.assign({ ok: true, account, room_id: roomId, cached: false }, payload));
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }
  if (req.method === 'GET' && pathname === '/api/compass/videos') {
    return sendJSON(res, { ok: false, error: '接口已下线：账号带货榜对素材四大目的无可执行输出，2026-07-28 裁剪' }, 410);
  }

  if (req.method === 'POST' && pathname === '/api/compass/ask') {
    return sendJSON(res, { ok: false, error: '接口已下线：罗盘 AI 问答对素材四大目的无可执行输出，2026-07-28 裁剪' }, 410);
  }

  return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
}

module.exports = handleCompass;
