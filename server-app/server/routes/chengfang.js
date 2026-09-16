/**
 * server/routes/chengfang.js
 * 乘方（全域升级版·推商品）只读数据路由（2026-07-30 盲区接入）。
 *
 *   GET /api/chengfang/overview?account=xx&date=YYYY-MM-DD
 *     → 自选+托管计划列表、今日汇总、单计划官方ROI建议值/今日成本保障、服务费减免（60s 缓存）
 *   GET /api/chengfang/products?account=xx&ad_id=xx&date=YYYY-MM-DD
 *     → 单计划商品粒度归因 Top10（消耗降序）
 *
 * 接口依据 references/qianchuan-chengfang-api.md；只读不含写操作。
 */
const { getOverview, getProductsTop } = require('../lib/chengfang');
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');

async function handleChengfang(req, res, url) {
  try {
    const account = validateAccount(url.searchParams.get('account'));
    const date = url.searchParams.get('date');
    // 2026-08-13 区间支持：start/end（兼容旧 date 单日；白名单已加 start/end）
    const start = url.searchParams.get('start') || date || getLocalDateStr();
    const end = url.searchParams.get('end') || date || start;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return sendJSON(res, { ok: false, error: 'date/start/end 格式须为 YYYY-MM-DD' }, 400);
    }
    if (start > end) return sendJSON(res, { ok: false, error: 'start 不能晚于 end' }, 400);

    if (url.pathname === '/api/chengfang/products') {
      const adId = url.searchParams.get('ad_id');
      if (!adId || !/^\d+$/.test(adId)) {
        return sendJSON(res, { ok: false, error: 'ad_id 必填且须为数字' }, 400);
      }
      const products = await getProductsTop(account, adId, start);
      return sendJSON(res, { ok: true, account, date: start, ad_id: adId, count: products.length, products });
    }

    // /api/chengfang/overview
    const overview = await getOverview(account, start, end);
    return sendJSON(res, { ok: true, ...overview });
  } catch (e) {
    if (e.statusCode) return sendJSON(res, { ok: false, error: e.message }, e.statusCode);
    console.error('[chengfang] 查询失败:', e.message);
    return sendJSON(res, { ok: false, error: '乘方数据查询失败: ' + e.message }, 500);
  }
}

module.exports = handleChengfang;
