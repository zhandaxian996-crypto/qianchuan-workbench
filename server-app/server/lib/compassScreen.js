// server/lib/compassScreen.js
// 罗盘直播大屏（专业版）实时数据：近5分钟脉搏 / 实时画像 / AI 分钟预警
// 历史账户专用说明已从试用包移除。
const { fetchCompassDirect } = require('./compassDirect');

// five_min_data 的单位归一：priceV2=分→元，ratio→%，其余原样
function normVal(v) {
  if (!v || v.value == null) return null;
  if (v.unit === 'priceV2') return +(v.value / 100).toFixed(2);
  return v.value;
}
function normChange(c) {
  if (!c || c.value == null || c.unit === 'nan') return null;
  if (c.unit === 'ratio') return +(c.value * 100).toFixed(1); // 0.25 → 25(%)
  return c.value;
}

function parseFive(data) {
  const cards = (data && data.card) || [];
  return cards.map(c => ({
    name: c.index_display,
    tip: c.index_tip || '',
    value: normVal(c.value),
    unit: c.value && c.value.unit === 'priceV2' ? '元' : (c.value && c.value.unit === 'ratio' ? '%' : ''),
    change_pct: normChange(c.change_value), // 环比（%），null=无
    // 每分钟点：[{t:'17:55', v}]（交易额类已是分→保持原始，前端只画形状）
    trend: (c.trends || []).map(p => ({ t: (p.horizontal || '').slice(-5), v: p.vertical })),
  }));
}

function parsePortrait(data) {
  const pick = (node) => node && node.portrait_map ? { title: node.title || '', map: node.portrait_map } : null;
  return {
    watch: pick(data && data.watch_portrait),   // 实时看播
    pay: pick(data && data.pay_portrait),       // 近5分钟成交
    diff: pick(data && data.diff_portrait),     // 只看不买
  };
}

function hasPortraitData(portrait) {
  if (!portrait || typeof portrait !== 'object') return false;
  return ['watch', 'pay', 'diff'].some(key => {
    const section = portrait[key];
    return !!(section && section.map && Object.keys(section.map).length);
  });
}

// 罗盘画像子接口偶发失败时保留最后一次成功画像。不能把接口错误伪装成
// “人数不足”，也不能让一次 100704 把三个画像分区全部冲空。
function mergePortraitFallback(current, previous) {
  if (!current || typeof current !== 'object') return current;
  const portraitError = current.errors && current.errors.portrait;
  if (!portraitError) return current;

  const merged = { ...current, portrait_error: portraitError };
  if (previous && hasPortraitData(previous.portrait)) {
    merged.portrait = previous.portrait;
    merged.portrait_stale = true;
    merged.portrait_fetched_at = previous.portrait_fetched_at || previous.fetched_at || null;
  }
  return merged;
}

function parseWarn(data) {
  const list = (data && data.warn) || [];
  const ts = (data && data.warn_ts) || [];
  return list.map((text, i) => ({ text, ts: ts[i] || null }));
}

// 本场商品榜（date_type=12=整场）：哪个商品卖了多少，按成交额降序取前 15
// 接口按"讲解段"返回多行（同 product_id 重复，pay_gmv 为累计值）→ 按 id 去重取最大
function parseProducts(data) {
  const list = (data && data.product_list) || [];
  const byId = new Map();
  for (const p of list) {
    if (!p || !p.product_title) continue;
    const key = p.product_id || p.product_title;
    const cur = byId.get(key);
    if (!cur || (p.pay_gmv || 0) > (cur.pay_gmv || 0)) byId.set(key, p);
  }
  return [...byId.values()]
    .sort((a, b) => (b.pay_gmv || 0) - (a.pay_gmv || 0))
    .slice(0, 15)
    .map(p => ({
      title: p.product_title,
      pay_gmv: p.pay_gmv != null ? +(p.pay_gmv / 100).toFixed(2) : null, // 分→元
      product_id: p.product_id || '',
      image: p.product_img || '',
      talk_start: p.talk_start_time || null,
      talk_end: p.talk_end_time || null,
    }));
}

/**
 * 纯 API 拉取罗盘直播大屏
 */
async function fetchScreenLiveDirect(account, roomId) {
  const urls = {
    five: `/compass_api/content_live/shop/live_screen/five_min_data?room_id=${roomId}`,
    portrait: `/compass_api/content_live/shop/live_screen/portrait_five_min_data?room_id=${roomId}`,
    warn: `/business_api/shop/live_bigscreen/min_warn?live_room_id=${roomId}`,
    products: `/compass_api/shop/live/live_screen/product?date_type=12&room_id=${roomId}`,
  };
  const out = {};
  for (const [k, u] of Object.entries(urls)) {
    try {
      const j = await fetchCompassDirect(account, u);
      out[k] = (j.st === 0 || j.st === undefined) ? (j.data !== undefined ? j.data : j) : { __error: 'st=' + j.st + ' ' + (j.msg || '') };
    } catch (e) {
      out[k] = { __error: String(e) };
    }
  }
  return out;
}

/**
  * 历史账户专用说明已从试用包移除。
 */

function resultFromRaw(r, via) {
  // 2026-08-01 审计 P1：子项异常原被静默吞成空数组——调用方把"接口挂了"当"直播间无数据"。错误显式透出
  const errors = {};
  for (const k of ['five', 'portrait', 'warn', 'products']) {
    if (r[k] && r[k].__error) errors[k] = r[k].__error;
  }
  return {
    five: r.five && !r.five.__error ? parseFive(r.five) : [],
    portrait: r.portrait && !r.portrait.__error ? parsePortrait(r.portrait) : { watch: null, pay: null, diff: null },
    warn: r.warn && !r.warn.__error ? parseWarn(r.warn) : [],
    products: r.products && !r.products.__error ? parseProducts(r.products) : [],
    errors: Object.keys(errors).length ? errors : undefined, // 子项失败显式标注（对齐聚合工具契约）
    fetched_at: (() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString(); })(),
    via,
  };
}

/**
 * 拉取罗盘直播大屏实时包（纯 API，无浏览器兜底）
  * 历史账户专用说明已从试用包移除。
 * 纯 API 拿不到就空着，不为三块数据养无头浏览器；画像端点纯 API 直连正常。
  * 历史账户专用说明已从试用包移除。
 * @param {string} roomId 直播房间 id
 * @returns {Promise<{five, portrait, warn, products, fetched_at, via}>}
 */
async function fetchScreenLive(account, roomId) {
  if (!roomId) throw new Error('缺少 room_id');
  const direct = await fetchScreenLiveDirect(account, roomId);
  return resultFromRaw(direct, 'direct');
}

/**
 * 单品实时详情（罗盘大屏「商品详情」抽屉数据，2026-08-12 CDP 探针抓到）
 * GET /compass_api/shop/live/live_screen/product_explain_detail?room_id=&product_id=&date_type=12
 * 含累计支付/成交件数/未支付订单/库存/讲解次数/近5分钟点击与支付趋势
 */
async function fetchProductExplainDetail(account, roomId, productId) {
  if (!roomId || !productId) throw new Error('缺少 room_id 或 product_id');
  const j = await fetchCompassDirect(account, `/compass_api/shop/live/live_screen/product_explain_detail?room_id=${roomId}&product_id=${productId}&date_type=12`);
  if (j.st !== 0 && j.st !== undefined) throw new Error(`compass st=${j.st} ${j.msg || ''}`);
  const d = j.data || {};
  const num = (v) => {
    if (!v || v.value == null) return null;
    if (v.unit === 'price' || v.unit === 'priceV2') return +(v.value / 100).toFixed(2); // 分→元
    if (v.unit === 'ratio') return +(v.value * 100).toFixed(2); // →%
    return v.value;
  };
  const trend = (x) => ((x && x.trend) || []).map(p => ({ t: (p.horizontal || '').slice(-5), v: p.vertical }));
  return {
    product_id: d.product_id || productId,
    product_name: d.product_name || '',
    product_img: d.product_img || '',
    price_text: d.price_text || '',
    market_price: num(d.market_price),
    pay_amt: num(d.pay_amt),                  // 累计用户支付金额(元)
    pay_combo_cnt: num(d.pay_combo_cnt),      // 累计成交件数
    unpay_cnt: num(d.unpay_cnt),              // 未支付订单数
    stock_cnt: num(d.stock_cnt),              // 库存
    explain_cnt: num(d.explain_cnt),          // 讲解次数
    explaining: !!d.explaining,
    conversion_rate: num(d.product_show_pay_ucnt_ratio), // 曝光-成交转化率(%)
    click_5min: d.click_data ? num(d.click_data.product_click_cnt) : null,
    pay_5min: d.pay_amt_data ? num(d.pay_amt_data.pay_amt) : null,
    trend: { click: trend(d.click_data), pay: trend(d.pay_amt_data) },
    fetched_at: (() => { const x = new Date(); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString(); })(),
  };
}

/**
 * 直播间订单流（罗盘直播大屏「订单」tab，2026-08-18 探针抓到）
 * GET /compass_api/content_live/shop_official/live_screen/live_order?room_id=&order_status=&data_range=&page_no=&page_size=
 *   - order_status：3=已支付（大屏默认），其他状态待探针验证
 *   - data_range：0=本场
 *   - 签名端点（裸调 st=11001 被拒，本地 a_bogus 签名后 st=0）
 * @param {string} accountId
 * @param {string} roomId
 * @param {object} [opts] { order_status=3, data_range=0, page_no=1, page_size=20 }
 * @returns {Promise<{orders:Array, total:number, page_no:number, page_size:number}>}
 */
async function fetchLiveOrders(accountId, roomId, opts = {}) {
  if (!roomId) throw new Error('缺少 room_id');
  const orderStatus = opts.order_status != null ? opts.order_status : 3;
  const dataRange = opts.data_range != null ? opts.data_range : 0;
  const pageNo = opts.page_no != null ? opts.page_no : 1;
  const pageSize = opts.page_size != null ? opts.page_size : 20;
  const apiPath = `/compass_api/content_live/shop_official/live_screen/live_order?room_id=${roomId}&order_status=${orderStatus}&data_range=${dataRange}&page_no=${pageNo}&page_size=${pageSize}`;
  const j = await fetchCompassDirect(accountId, apiPath, { referer: 'https://compass.jinritemai.com/shop' });
  if (j.st !== 0 && j.st !== undefined) throw new Error(`compass st=${j.st} ${j.msg || ''}`);
  const d = j.data || {};
  const yuan = v => (v && v.value != null && v.unit === 'price') ? +(v.value / 100).toFixed(2) : (v && v.value != null ? v.value : null);
  const orders = (d.order_list || []).map(o => ({
    order_id: o.order_id,
    order_ts: o.order_ts,                        // 下单时间戳(秒)
    order_status: o.order_status,                // 3=已支付
    nick_name: o.nick_name,                      // 脱敏买家昵称
    item_num: o.item_num,                        // 件数
    order_amount: yuan(o.order_amount),          // 订单金额(元)
    product_id: o.product_id,
    product_title: o.product_title,
    sku_product_id: o.sku_product_id,
    sku_product_title: o.sku_product_title,     // 规格（如 1350g）
    sku_product_img: o.sku_product_img,
  }));
  const pg = d.page_result || {};
  return {
    orders,
    total: pg.total != null ? pg.total : orders.length,
    page_no: pg.page_no || pageNo,
    page_size: pg.page_size || pageSize,
  };
}

/**
  * 历史账户专用说明已从试用包移除。
 * 翻页循环直到拉满 total（page_size=50 翻页；单场订单量级百级，可控）。
 * @param {string} accountId
 * @param {string} roomId
 * @returns {Promise<{products:Array, total:number, orders:Array}>}
 *   products: [{product_id, product_title, sku_title, order_cnt, item_num, amount}]
 */
async function fetchLiveOrderAgg(accountId, roomId) {
  // page_size 用探针实测值 9（>9 曾触发 st=621000601 参数校验失败，2026-08-18 实测）
  const PAGE = 9;
  let all = [];
  let total = null;
  let pageNo = 1;
  while (true) {
    const r = await fetchLiveOrders(accountId, roomId, { page_no: pageNo, page_size: PAGE });
    all = all.concat(r.orders);
    total = r.total;
    if (all.length >= total || !r.orders.length) break;
    pageNo += 1;
  }
  // 按商品聚合（订单明细为权威源：每笔订单带 product_id）
  const byProduct = new Map();
  for (const o of all) {
    const key = o.product_id || '未知商品';
    const cur = byProduct.get(key) || { product_id: key, product_title: o.product_title || '', sku_title: o.sku_product_title || '', order_cnt: 0, item_num: 0, amount: 0 };
    cur.order_cnt += 1;
    cur.item_num += o.item_num || 1;
    cur.amount += o.order_amount || 0;
    if (!cur.product_title && o.product_title) cur.product_title = o.product_title;
    if (!cur.sku_title && o.sku_product_title) cur.sku_title = o.sku_product_title;
    byProduct.set(key, cur);
  }
  const products = [...byProduct.values()]
    .sort((a, b) => b.amount - a.amount)
    .map(p => ({ ...p, amount: +p.amount.toFixed(2) }));
  return { products, total: total != null ? total : all.length, orders: all };
}

module.exports = {
  fetchScreenLive,
  fetchProductExplainDetail,
  fetchLiveOrders,
  fetchLiveOrderAgg,
  mergePortraitFallback,
  _test: { parsePortrait, hasPortraitData, resultFromRaw },
};
