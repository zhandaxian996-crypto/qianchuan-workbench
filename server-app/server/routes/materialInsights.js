/**
 * server/routes/materialInsights.js — 素材洞察分析
 *
 * 基于数据库中恒古不变的素材固有属性（时长、创建时间、名称）+ 每日业务数据，
 * 生成三个维度的洞察：
 * 1. 素材生命周期曲线（存活天数、衰退拐点、换新信号）
 * 2. 时长 vs 效果（哪种长度的素材ROI最高）
 * 3. 素材基因规律（命名模式、创建批次的效果对比）
 *
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 */

const { sendJSON, num } = require('../lib/utils');
const { getDB } = require('../lib/db');

function handleMaterialInsights(req, res, url) {
  const account = url.searchParams.get('account');
  if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  const type = url.searchParams.get('type') || 'all';

  try {
    const db = getDB();

    // 直接用原始SQL查聚合数据（aggregateRange返回中文key，这里用原始字段名更干净）
    const materials = db.prepare(`
      SELECT
        material_id,
        MAX(material_name) AS material_name,
        MAX(duration) AS duration,
        MAX(created_at) AS created_at,
        MAX(source) AS source,
        MAX(status) AS status,
        ROUND(SUM(cost), 1) AS cost,
        ROUND(SUM(gmv), 1) AS gmv,
        ROUND(SUM(net_gmv), 1) AS net_gmv,
        SUM(orders) AS orders,
        SUM(plays) AS plays,
        ROUND(SUM(additional_cost), 1) AS boost_cost,
        ROUND(SUM(additional_net_gmv), 1) AS boost_gmv,
        MIN(stat_date) AS first_date,
        MAX(stat_date) AS last_date,
        CASE WHEN SUM(cost) > 0 THEN ROUND(SUM(gmv) / SUM(cost), 2) ELSE 0 END AS roi
      FROM material_daily
      WHERE account_id = ? AND material_id != '__EMPTY__'
      GROUP BY material_id
      HAVING cost > 0
      ORDER BY cost DESC
    `).all(account);

    if (!materials || materials.length === 0) {
      return sendJSON(res, { ok: false, error: '无数据' }, 404);
    }

    let result = { ok: true, account, total_materials: materials.length };

    if (type === 'all' || type === 'lifecycle') {
      result.lifecycle = analyzeLifecycle(db, account, materials);
    }
    if (type === 'all' || type === 'duration') {
      result.duration = analyzeDuration(materials);
    }
    if (type === 'all' || type === 'gene') {
      result.gene = analyzeGene(materials);
    }

    return sendJSON(res, result);
  } catch (e) {
    console.error('[material-insights] error:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

/**
 * 1. 素材生命周期分析
 */
function analyzeLifecycle(db, accountId, materials) {
  const list = materials.map(r => {
    const created = r.created_at ? r.created_at.slice(0, 10) : null;
    const ageDays = created ? Math.round((new Date(r.last_date) - new Date(created)) / 86400000) : 0;
    return {
      id: r.material_id,
      name: r.material_name,
      duration: r.duration,
      created_at: created,
      last_date: r.last_date,
      age_days: ageDays,
      total_cost: Math.round(r.cost),
      total_gmv: Math.round(r.gmv),
      roi: r.roi,
      orders: r.orders,
      status: r.status,
    };
  });

  // 按存活天数分组
  const buckets = { '0-7天': [], '8-30天': [], '31-60天': [], '60天+': [] };
  for (const m of list) {
    if (m.age_days <= 7) buckets['0-7天'].push(m);
    else if (m.age_days <= 30) buckets['8-30天'].push(m);
    else if (m.age_days <= 60) buckets['31-60天'].push(m);
    else buckets['60天+'].push(m);
  }

  const bucketStats = {};
  for (const [label, items] of Object.entries(buckets)) {
    if (items.length === 0) { bucketStats[label] = { count: 0 }; continue; }
    const totalCost = items.reduce((s, m) => s + m.total_cost, 0);
    const totalGmv = items.reduce((s, m) => s + m.total_gmv, 0);
    bucketStats[label] = {
      count: items.length,
      avg_cost: Math.round(totalCost / items.length),
      avg_roi: totalCost > 0 ? Math.round((totalGmv / totalCost) * 100) / 100 : 0,
    };
  }

  // 衰退信号：找ROI随时间下滑的素材
  const decay = [];
  for (const m of list.slice(0, 20)) {
    const daily = db.prepare(`
      SELECT stat_date, cost, gmv, CASE WHEN cost>0 THEN gmv/cost ELSE 0 END as roi
      FROM material_daily
      WHERE account_id = ? AND material_id = ? AND cost > 0
      ORDER BY stat_date
    `).all(accountId, m.id);
    if (daily.length < 3) continue;
    const half = Math.floor(daily.length / 2);
    const avgRoi1 = daily.slice(0, half).reduce((s, d) => s + d.roi, 0) / half;
    const avgRoi2 = daily.slice(half).reduce((s, d) => s + d.roi, 0) / (daily.length - half);
    if (avgRoi1 > 0 && avgRoi2 < avgRoi1 * 0.6) {
      decay.push({
        id: m.id,
        name: m.name,
        roi_first_half: Math.round(avgRoi1 * 100) / 100,
        roi_second_half: Math.round(avgRoi2 * 100) / 100,
        decline_pct: Math.round((1 - avgRoi2 / avgRoi1) * 100),
        age_days: m.age_days,
      });
    }
  }

  return {
    top_materials: list.slice(0, 15),
    age_distribution: bucketStats,
    decay_signals: decay.sort((a, b) => b.decline_pct - a.decline_pct),
  };
}

/**
 * 2. 时长 vs 效果分析
 */
function analyzeDuration(materials) {
  const groups = {};
  for (const m of materials) {
    const dur = m.duration || '-';
    if (!groups[dur]) groups[dur] = { duration: dur, count: 0, total_cost: 0, total_gmv: 0, total_orders: 0 };
    const g = groups[dur];
    g.count++;
    g.total_cost += m.cost;
    g.total_gmv += m.gmv;
    g.total_orders += m.orders;
  }

  const list = Object.values(groups).map(g => ({
    duration: g.duration,
    material_count: g.count,
    total_cost: Math.round(g.total_cost),
    avg_cost: Math.round(g.total_cost / g.count),
    roi: g.total_cost > 0 ? Math.round((g.total_gmv / g.total_cost) * 100) / 100 : 0,
    total_orders: g.total_orders,
  })).sort((a, b) => b.total_cost - a.total_cost);

  // 按时长区间汇总
  const bands = { '短视频(<20s)': [], '中视频(20-35s)': [], '长视频(>35s)': [] };
  for (const item of list) {
    if (item.duration === '-') continue;
    const parts = item.duration.split(':');
    const sec = parseInt(parts[1]) + parseInt(parts[0]) * 60;
    if (sec < 20) bands['短视频(<20s)'].push(item);
    else if (sec <= 35) bands['中视频(20-35s)'].push(item);
    else bands['长视频(>35s)'].push(item);
  }

  const bandSummary = {};
  for (const [label, items] of Object.entries(bands)) {
    if (items.length === 0) { bandSummary[label] = { count: 0 }; continue; }
    const totalCost = items.reduce((s, i) => s + i.total_cost, 0);
    const totalGmv = items.reduce((s, i) => s + i.total_cost * i.roi, 0);
    bandSummary[label] = {
      material_count: items.reduce((s, i) => s + i.material_count, 0),
      total_cost: totalCost,
      avg_roi: totalCost > 0 ? Math.round((totalGmv / totalCost) * 100) / 100 : 0,
    };
  }

  return { by_duration: list, by_band: bandSummary };
}

/**
 * 3. 素材基因分析（命名模式 + 创建批次）
 */
function analyzeGene(materials) {
  // 按名称关键词分类
  const patterns = {};
  for (const m of materials) {
    const name = m.material_name || '';
    let category = '其他';
    if (/混剪|精编/i.test(name)) category = '混剪/精编';
    else if (/差评/i.test(name)) category = '差评系列';
    else if (/内行人/i.test(name)) category = '内行人系列';
    else if (/大口|吃|好吃|满足/i.test(name)) category = '吃播展示';
    else if (/客户|夸|反馈/i.test(name)) category = '客户反馈';
    else if (/AIGC|动态/i.test(name)) category = 'AIGC';
    else if (/^-$/i.test(name)) category = '未命名';

    if (!patterns[category]) patterns[category] = { count: 0, total_cost: 0, total_gmv: 0 };
    patterns[category].count++;
    patterns[category].total_cost += m.cost;
    patterns[category].total_gmv += m.gmv;
  }

  const patternList = Object.entries(patterns).map(([cat, d]) => ({
    pattern: cat,
    material_count: d.count,
    total_cost: Math.round(d.total_cost),
    avg_cost: Math.round(d.total_cost / d.count),
    roi: d.total_cost > 0 ? Math.round((d.total_gmv / d.total_cost) * 100) / 100 : 0,
  })).sort((a, b) => b.total_cost - a.total_cost);

  // 按创建周次分组
  const weeks = {};
  for (const m of materials) {
    if (!m.created_at) continue;
    const weekKey = getWeekKey(m.created_at);
    if (!weeks[weekKey]) weeks[weekKey] = { count: 0, total_cost: 0, total_gmv: 0 };
    weeks[weekKey].count++;
    weeks[weekKey].total_cost += m.cost;
    weeks[weekKey].total_gmv += m.gmv;
  }

  const weekList = Object.entries(weeks).map(([week, d]) => ({
    week,
    material_count: d.count,
    total_cost: Math.round(d.total_cost),
    avg_cost: Math.round(d.total_cost / d.count),
    roi: d.total_cost > 0 ? Math.round((d.total_gmv / d.total_cost) * 100) / 100 : 0,
  })).sort((a, b) => a.week.localeCompare(b.week));

  return { by_pattern: patternList, by_week: weekList };
}

function getWeekKey(date) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.getFullYear() + '-W' + String(Math.ceil((((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1) / 7)).padStart(2, '0');
}

module.exports = handleMaterialInsights;
