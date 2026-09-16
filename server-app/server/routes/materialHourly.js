/**
  * 历史账户专用说明已从试用包移除。
 *
 * 素材小时级效果（千川 roi2_video_material_analysis_promotion + stat_time_hour 维度）。
 * 2026-08-11 探针验证：千川支持素材×小时维度，本项目此前未使用。
 *
 * 输出为"解读成品"（面向投手/Agent）：
 *   - hours：有消耗的小时明细（消耗/支付ROI/净GMV/单量/1h净ROI）
 *   - profile：强时段/弱时段/最佳最差小时/标签/调度建议/一句话总结
 *   - display：可直接转述的 Markdown 文本
 *
 * 走 statQuery 限频队列（AGENTS.md 禁止跳过队列直连千川）。
 */
const { statQuery } = require('../lib/qianchuan');
const { resolveAavid } = require('../lib/cookie');
const { sendJSON } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');

const PROMOTION_DS = 'roi2_video_material_analysis_promotion';
const METRICS = [
  'stat_cost_for_roi2',
  'total_prepay_and_pay_order_roi2',
  'total_pay_order_gmv_include_coupon_for_roi2',
  'total_pay_order_count_for_roi2',
  'total_prepay_and_pay_settle_roi2_1h',
  'total_order_settle_amount_for_roi2_1h',
  'total_order_settle_count_for_roi2_1h',
];
const MAX_DAYS = 31;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

function num(o, k) {
  const v = o && o[k];
  return v ? parseFloat(String(v.ValueStr ?? v.Value ?? 0)) : 0;
}
function str(o, k) {
  const v = o && o[k];
  return v ? String(v.ValueStr ?? v.Value ?? '') : '';
}

async function handleMaterialHourly(req, res, url) {
  const q = url.searchParams;
  const account = q.get('account') || q.get('accountId');
  const materialId = q.get('material_id') || q.get('materialId') || q.get('id');
  const start = q.get('start') || q.get('startDate');
  const end = q.get('end') || q.get('endDate');
  const name = q.get('name') || null;

  if (!account) return sendJSON(res, { ok: false, error: 'Missing account' }, 400);
  try { validateAccount(account); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 400); }
  if (!materialId || !/^\d{1,30}$/.test(String(materialId))) {
    return sendJSON(res, { ok: false, error: 'material_id 必须为数字字符串' }, 400);
  }
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return sendJSON(res, { ok: false, error: 'start/end 必填，格式 YYYY-MM-DD' }, 400);
  }
  if (start > end) return sendJSON(res, { ok: false, error: 'start 不能晚于 end' }, 400);
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  if (days > MAX_DAYS) return sendJSON(res, { ok: false, error: `查询区间最多 ${MAX_DAYS} 天` }, 400);

  const aavid = resolveAavid(account);
  const rawRows = [];
  let offset = 0;
  while (true) {
    const body = {
      DataSetKey: PROMOTION_DS,
      reqFrom: 'roi2_material_list',
      StartTime: start + ' 00:00:00',
      EndTime: end + ' 23:59:59',
      Metrics: METRICS,
      Dimensions: ['stat_time_hour'],
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
        { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
        { Field: 'material_type', Operator: 7, Values: ['3'] },
        { Field: 'material_id', Operator: 7, Values: [String(materialId)] },
      ]},
      PageParams: { Offset: offset, Limit: PAGE_LIMIT },
      OrderBy: [{ Type: 1, Field: 'stat_time_hour' }],
    };
    const r = await statQuery(body, 3, account);
    if (!r) break;
    const sd = r.data && r.data.StatsData;
    if (!sd) break;
    const page = sd.Rows || [];
    rawRows.push(...page);
    const total = parseInt(sd.TotalCount) || page.length;
    offset += PAGE_LIMIT;
    if (page.length === 0 || offset >= total || rawRows.length >= PAGE_LIMIT * MAX_PAGES) break;
  }

  const hours = [];
  for (const row of rawRows) {
    const d = row.Dimensions || {};
    const m = row.Metrics || {};
    const hourRaw = str(d, 'stat_time_hour');
    const cost = num(m, 'stat_cost_for_roi2');
    if (cost <= 0) continue;
    const h = hourRaw.length >= 13 ? parseInt(hourRaw.slice(11, 13)) : null;
    hours.push({
      hour: hourRaw,
      date: hourRaw.slice(0, 10),
      h,
      cost,
      pay_roi: num(m, 'total_prepay_and_pay_order_roi2'),
      gmv: num(m, 'total_pay_order_gmv_include_coupon_for_roi2'),
      net_gmv: num(m, 'total_order_settle_amount_for_roi2_1h'),
      orders: num(m, 'total_pay_order_count_for_roi2'),
      net_orders: num(m, 'total_order_settle_count_for_roi2_1h'),
      roi_1h: num(m, 'total_prepay_and_pay_settle_roi2_1h'),
    });
  }

  const strong = hours.filter(x => x.orders >= 2 && x.pay_roi >= 2.0);
  const weak = hours.filter(x => (x.cost >= 30 && x.orders === 0) || (x.pay_roi > 0 && x.pay_roi < 1.0));
  const withOrders = hours.filter(x => x.orders >= 1 && x.pay_roi > 0);
  const best = withOrders.length
    ? withOrders.reduce((a, b) => (b.pay_roi > a.pay_roi ? b : a))
    : (hours.length ? hours.reduce((a, b) => (b.cost > a.cost ? b : a)) : null);
  const bestReliable = withOrders.filter(x => x.orders >= 2)
    .reduce((a, b) => (a === null ? b : (b.pay_roi > a.pay_roi ? b : a)), null);
  const worst = withOrders.length ? withOrders.reduce((a, b) => (b.pay_roi < a.pay_roi ? b : a)) : null;
  const totalCost = hours.reduce((s, x) => s + x.cost, 0);
  const totalNetGmv = hours.reduce((s, x) => s + x.net_gmv, 0);
  const totalOrders = hours.reduce((s, x) => s + x.orders, 0);
  const emptyCost = hours.filter(x => x.orders === 0).reduce((s, x) => s + x.cost, 0);

  const fmtH = x => (x ? `${x.date.slice(5)} ${String(x.h).padStart(2, '0')}点` : '');
  const tagParts = [];
  if (strong.length) {
    const roiMin = Math.min(...strong.map(x => x.pay_roi));
    const roiMax = Math.max(...strong.map(x => x.pay_roi));
    tagParts.push(`${strong.map(fmtH).join('/')}强（ROI ${roiMin.toFixed(1)}~${roiMax.toFixed(1)}）`);
  }
  const emptyText = weak.filter(x => x.orders === 0 && x.cost >= 30)
    .map(x => `${x.date.slice(5)} ${String(x.h).padStart(2, '0')}点空耗${x.cost.toFixed(0)}元`);
  if (emptyText.length) tagParts.push(`空耗风险：${emptyText.join('、')}`);
  const tag = tagParts.length ? tagParts.join('；') : (hours.length ? '表现平稳/样本有限' : '区间内无消耗');

  let suggest = '';
  if (strong.length && weak.length) suggest = '强时段放回、弱时段移出；同场调度间隔≥1小时、每日同素材≤1次';
  else if (strong.length) suggest = '可重点投放在强时段；弱时段尚未暴露，持续观察';
  else if (weak.length) suggest = '弱时段明显，建议移出止损观察；隔场/隔天或强时段再放回';
  else suggest = '无消耗或样本不足，暂不调度';

  const summaryBest = bestReliable || best;
  const summary = `素材${name ? '「' + name + '」' : materialId} ${start}~${end}：耗 ${totalCost.toFixed(1)} 元 / 净GMV ${totalNetGmv.toFixed(0)} / ${totalOrders} 单`
    + (summaryBest ? `；最佳时段 ${fmtH(summaryBest)}（ROI ${summaryBest.pay_roi.toFixed(2)} / ${summaryBest.orders} 单）` : '')
    + (worst && worst !== best ? `；最差时段 ${fmtH(worst)}（ROI ${worst.pay_roi.toFixed(2)}）` : '')
    + (emptyCost >= 50 ? `；零单空耗 ${emptyCost.toFixed(0)} 元` : '');

  const table = hours.length
    ? '| 时段 | 消耗 | 单量 | 支付ROI | 净GMV |\n' + hours.map(x =>
        `| ${x.hour} | ${x.cost.toFixed(1)} | ${x.orders} | ${x.pay_roi.toFixed(2)} | ${x.net_gmv.toFixed(0)} |`).join('\n')
    : '（区间内无消耗）';
  const display = [
    `## 素材小时级表现（${start} ~ ${end}）`,
    `**${name || materialId}**：耗 ${totalCost.toFixed(1)} / 净GMV ${totalNetGmv.toFixed(0)} / ${totalOrders} 单`,
    table,
    `**时段画像**：${tag}`,
    `**调度建议**：${suggest}`,
  ].join('\n\n');

  return sendJSON(res, {
    ok: true,
    account,
    material_id: materialId,
    name,
    range: { start, end },
    hours,
    profile: {
      strong_slots: strong,
      weak_slots: weak,
      best_hour: best,
      best_reliable_hour: bestReliable,
      worst_hour: worst,
      total_cost: totalCost,
      total_net_gmv: totalNetGmv,
      total_orders: totalOrders,
      empty_cost: emptyCost,
      tag,
      suggest_schedule: suggest,
      summary,
    },
    display,
  });
}

module.exports = handleMaterialHourly;
