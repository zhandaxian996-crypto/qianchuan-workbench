/**
 * 素材画像 + 人群洞察（只读，数据全部来自本地 SQLite，不调千川 API，无需 cookie）
 * - buildMaterialProfile：单素材全周期画像（消耗/ROI/生命周期/人群/脚本/留存/14天趋势 + 规则模板摘要）
 * - buildAudienceInsight：近 N 天优质（净ROI≥2.0）/ 亏损（净ROI<1.0）素材的人群交集与投放建议
 * 缓存：cache/material_profile/ 日级磁盘缓存（源数据 T+1，文件名带今日日期自然过期）
 */
const fs = require('fs');
const path = require('path');
const { getDB } = require('./db');
const { computeLifecycle } = require('./lifecycle');
const { CACHE_DIR } = require('./config');
const { daysAgo, yesterday } = require('./utils');

const PROFILE_CACHE_DIR = path.join(CACHE_DIR, 'material_profile');
// 人群维度指标：优先按成交GMV判定核心人群，GMV全为0时回退到观看人数
const GMV_METRIC = 'total_pay_order_gmv_include_coupon_for_roi2';
const WATCH_METRIC = 'live_watch_count_for_roi2_v2';
// 人群洞察的最小消耗门槛（元）：低于此消耗的素材 ROI 偶然性太大，不参与交集
const MIN_COST_FOR_INSIGHT = 100;
// 单个集合最多参与交集计算的素材数（按消耗降序取头部）
const MAX_MATERIALS_PER_SET = 50;

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function pct(share) { return Math.round((share || 0) * 100) + '%'; }

/**
 * material_content.creative_json 在不同采集链路中有两种结构：
 * - fetchCreativeAnalysis: myTags[].tags
 * - fetchMaterialContent: creative_tags[].tag_name_list
 * 同时把脚本公式标签作为本地兜底，避免前端为了几个标签重新请求千川上游。
 */
function parseCreativeTags(creativeJson, scriptJson) {
  let creative = null;
  let script = null;
  try { creative = creativeJson ? JSON.parse(creativeJson) : null; } catch { /* ignore */ }
  try { script = scriptJson ? JSON.parse(scriptJson) : null; } catch { /* ignore */ }
  const tags = [];
  const add = value => {
    const text = typeof value === 'string'
      ? value
      : value && (value.text || value.name || value.label || value.tag_name);
    if (text && !tags.includes(String(text))) tags.push(String(text));
  };
  for (const group of (creative && creative.myTags) || []) {
    for (const tag of group.tags || []) add(tag);
  }
  for (const group of (creative && creative.creative_tags) || []) {
    for (const tag of group.tag_name_list || group.tags || []) add(tag);
  }
  for (const tag of (creative && creative.tags) || []) add(tag);
  for (const group of (script && script.formula) || []) {
    for (const tag of group.tags || []) add(tag);
  }
  return tags.slice(0, 8);
}

// ═══════════════════════════════════════════════════════════
// 日级磁盘缓存
// ═══════════════════════════════════════════════════════════

function readDayCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeDayCache(file, data) {
  try {
    if (!fs.existsSync(PROFILE_CACHE_DIR)) fs.mkdirSync(PROFILE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch { /* 缓存写入失败不影响主流程 */ }
}

function invalidateMaterialProfileCache(accountId, materialId) {
  if (!fs.existsSync(PROFILE_CACHE_DIR)) return 0;
  const safeAccount = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeMaterial = String(materialId).replace(/[^a-zA-Z0-9:_-]/g, '_');
  const prefixes = [
    `profile_${safeAccount}_${safeMaterial}_`,
    `profile_v2_${safeAccount}_${safeMaterial}_`,
  ];
  let removed = 0;
  for (const file of fs.readdirSync(PROFILE_CACHE_DIR)) {
    if (!prefixes.some(prefix => file.startsWith(prefix))) continue;
    try {
      fs.unlinkSync(path.join(PROFILE_CACHE_DIR, file));
      removed++;
    } catch { /* 下一次请求仍可重新覆盖，不阻断上游数据返回 */ }
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════
// 人群数据解析（material_crowd.crowd_json，结构见 server/lib/data.js fetchCrowd）
// ═══════════════════════════════════════════════════════════

/**
 * 解析单素材人群 JSON，输出各维度 GMV 占比分布与头部标签。
 * @param {string} crowdJson - material_crowd.crowd_json
 * @returns {{genderDist:object, ageDist:object, regionDist:object, genderTop:string|null, ageTop:string[], regionTop:string[]}|null}
 */
function parseCrowd(crowdJson) {
  let crowd;
  try { crowd = JSON.parse(crowdJson); } catch { return null; }
  if (!crowd || typeof crowd !== 'object') return null;
  const dist = (dim) => {
    const d = crowd[dim];
    if (!d) return {};
    let rows = Array.isArray(d[GMV_METRIC]) ? d[GMV_METRIC] : [];
    if (!rows.length || rows.every(r => !r.value)) {
      rows = Array.isArray(d[WATCH_METRIC]) ? d[WATCH_METRIC] : [];
    }
    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    if (total <= 0) return {};
    const m = {};
    for (const r of rows) {
      if (r && r.label) m[r.label] = (r.value || 0) / total;
    }
    return m;
  };
  const topN = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
  const genderDist = dist('gender');
  const ageDist = dist('age');
  const regionDist = dist('province_name');
  if (!Object.keys(genderDist).length && !Object.keys(ageDist).length) return null;
  return {
    genderDist,
    ageDist,
    regionDist,
    genderTop: topN(genderDist, 1)[0] || null,
    ageTop: topN(ageDist, 2),
    regionTop: topN(regionDist, 5),
  };
}

/**
 * 解析单素材人群 JSON，输出各维度数组（含 count / rate），供前端图表直接使用。
 * 优先按 GMV 维度聚合，GMV 全为 0 时回退到观看人数。
 */
function parseCrowdArrays(crowdJson) {
  let crowd;
  try { crowd = JSON.parse(crowdJson); } catch { return null; }
  if (!crowd || typeof crowd !== 'object') return null;
  const dims = {
    gender: '性别',
    age: '年龄',
    province_name: '省份',
    city_name: '城市',
    user_group_label_name: '八大人群'
  };
  const out = {};
  for (const [dim, label] of Object.entries(dims)) {
    const d = crowd[dim];
    if (!d) continue;
    let rows = Array.isArray(d[GMV_METRIC]) ? d[GMV_METRIC] : [];
    if (!rows.length || rows.every(r => !r.value)) {
      rows = Array.isArray(d[WATCH_METRIC]) ? d[WATCH_METRIC] : [];
    }
    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    if (total <= 0) continue;
    out[dim] = rows.map(r => ({
      label: r.label || '',
      count: r.value || 0,
      rate: (r.value || 0) / total
    })).sort((a, b) => b.count - a.count);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 多素材人群交集：性别按主导性别多数投票，年龄取进入各素材 top2 的高频年龄段，
 * 地域取进入各素材 top5 且覆盖 ≥1/3 素材的省份。
 * @param {object[]} profiles - parseCrowd 返回的人群画像数组
 * @returns {{count:number, gender:string|null, gender_share:number, age:string[], region:string[]}}
 */
function intersectCrowd(profiles) {
  if (!profiles.length) return { count: 0, gender: null, gender_share: 0, age: [], region: [] };
  // 性别交集：各素材主导性别多数投票，share 取该性别在各素材中的平均 GMV 占比
  const genderVotes = {};
  for (const p of profiles) {
    if (p.genderTop) genderVotes[p.genderTop] = (genderVotes[p.genderTop] || 0) + 1;
  }
  const gender = (Object.entries(genderVotes).sort((a, b) => b[1] - a[1])[0] || [])[0] || null;
  let genderShare = 0;
  if (gender) {
    genderShare = round2(profiles.reduce((s, p) => s + (p.genderDist[gender] || 0), 0) / profiles.length);
  }
  // 年龄交集：进入各素材 GMV 占比 top2 的年龄段，按出现频次取交集（≥半数素材）
  const ageCount = {};
  for (const p of profiles) for (const a of p.ageTop) ageCount[a] = (ageCount[a] || 0) + 1;
  const half = Math.ceil(profiles.length / 2);
  let age = Object.entries(ageCount).filter(([, c]) => c >= half)
    .sort((a, b) => b[1] - a[1]).map(e => e[0]);
  if (!age.length) {
    age = Object.entries(ageCount).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  }
  age = age.slice(0, 2);
  // 地域交集：进入各素材 top5 的省份，保留覆盖 ≥1/3 素材的
  const regCount = {};
  for (const p of profiles) for (const r of p.regionTop) regCount[r] = (regCount[r] || 0) + 1;
  const third = Math.max(1, Math.ceil(profiles.length / 3));
  const region = Object.entries(regCount).filter(([, c]) => c >= third)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  return { count: profiles.length, gender, gender_share: genderShare, age, region };
}

// ═══════════════════════════════════════════════════════════
// ① 单素材画像
// ═══════════════════════════════════════════════════════════

/**
 * 生命周期判定：复用 server/lib/lifecycle.js 的权威分类器（学习/爬坡/稳定/衰退/死亡/复活期），
 * 与素材生命周期看板口径一致；异常时兜底"稳定期"。
 * @param {object[]} rows - material_daily 全历史行（含 stat_date/cost/gmv/orders/refund_rate）
 * @param {string} createdAt - 素材创建时间
 * @returns {string} 生命周期中文名
 */
function resolveLifecycle(rows, createdAt) {
  try {
    // queryEnd 传昨天：让分类器把"最后一天有数据"之后到昨天的空窗补零，连续无消耗 streak 才能判出死亡期
    return computeLifecycle({ '创建时间': createdAt || '' }, rows, rows[0].stat_date, yesterday()).phase.name;
  } catch {
    return '稳定期';
  }
}

/** 近14天ROI趋势：后7天均值与前7天均值比较（仅统计有消耗的天） */
function calcTrendCn(trend14) {
  const first = trend14.slice(0, 7).filter(d => d.cost > 0);
  const last = trend14.slice(7).filter(d => d.cost > 0);
  if (!first.length || !last.length) return '数据不足';
  const avg = arr => arr.reduce((s, d) => s + d.roi, 0) / arr.length;
  const diff = avg(last) - avg(first);
  if (diff > 0.3) return '上升';
  if (diff < -0.3) return '下降';
  return '平稳';
}

/** 规则模板画像摘要（≤200字，不用 LLM）：综合消耗档位、ROI档位、生命周期、趋势与人群集中度 */
function buildSummary(p) {
  const costTier = p.cost_total >= 5000 ? '高消耗' : p.cost_total >= 1000 ? '中消耗' : '低消耗';
  const roiTier = p.roi_total >= 2 ? '优质' : p.roi_total >= 1 ? '保本' : '亏损';
  let s = `上线${p.days_active}天累计消耗${Math.round(p.cost_total)}元，整体净ROI ${p.roi_total}，` +
    `属${costTier}、${roiTier}素材，当前处于${p.lifecycle}。` +
    `近30天消耗${Math.round(p.cost_30d)}元、净ROI ${p.roi_30d}，近14天ROI趋势${p._trendCn}。`;
  if (p.audience.gender) {
    s += `核心人群为${p.audience.gender}性`;
    if (p.audience.age) s += `、${p.audience.age}`;
    if (p.audience.region_top.length) s += `，主要分布在${p.audience.region_top.slice(0, 3).join('、')}`;
    s += '。';
  } else {
    s += '暂无人群画像数据。';
  }
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}

/**
 * 构建单素材全周期画像。
 * @param {string} materialId - 素材ID
 * @param {string} accountId - 千川账号ID
 * @returns {object|null} 画像对象；素材无本地数据时返回 null
 */
function buildMaterialProfile(materialId, accountId) {
  const db = getDB();
  const rows = db.prepare(`
    SELECT * FROM material_daily
    WHERE account_id = ? AND material_id = ?
    ORDER BY stat_date
  `).all(accountId, materialId);
  if (!rows.length) return null;

  const yStr = yesterday();
  const start30 = daysAgo(30);
  const latest = rows[rows.length - 1];
  const name = ([...rows].reverse().find(r => r.material_name) || {}).material_name || '';

  const activeRows = rows.filter(r => r.cost > 0);
  const daysActive = activeRows.length;
  const costTotal = round2(rows.reduce((s, r) => s + (r.cost || 0), 0));
  const netTotal = rows.reduce((s, r) => s + (r.net_gmv || 0), 0);
  const roiTotal = costTotal > 0 ? round2(netTotal / costTotal) : 0;

  const rows30 = rows.filter(r => r.stat_date >= start30 && r.stat_date <= yStr);
  const cost30 = round2(rows30.reduce((s, r) => s + (r.cost || 0), 0));
  const net30 = rows30.reduce((s, r) => s + (r.net_gmv || 0), 0);
  const roi30 = cost30 > 0 ? round2(net30 / cost30) : 0;

  // 历史账户专用说明已从试用包移除。
  const start7 = daysAgo(7);
  const rows7 = rows.filter(r => r.stat_date >= start7 && r.stat_date <= yStr);
  const cost7 = round2(rows7.reduce((s, r) => s + (r.cost || 0), 0));
  const net7 = rows7.reduce((s, r) => s + (r.net_gmv || 0), 0);
  const roi7 = cost7 > 0 ? round2(net7 / cost7) : 0;
  const clicks7 = rows7.reduce((s, r) => s + (+r.clicks || 0), 0);
  const cpc7 = clicks7 > 0 ? round2(cost7 / clicks7) : null;

  // 近14天/30天逐日趋势（截止昨天，源数据 T+1；缺数据的日期补0）
  const byDate = {};
  for (const r of rows) byDate[r.stat_date] = r;
  const makeTrend = n => {
    const arr = [];
    for (let i = n; i >= 1; i--) {
      const d = daysAgo(i);
      const r = byDate[d];
      const cost = r ? round2(r.cost || 0) : 0;
      const net = r ? (r.net_gmv || 0) : 0;
      arr.push({ date: d, cost, roi: cost > 0 ? round2(net / cost) : 0 });
    }
    return arr;
  };
  const trend14 = makeTrend(14);
  const trend30 = makeTrend(30);

  // 人群画像：取最近一次深度采集的人群数据
  const crowdRow = db.prepare(`
    SELECT crowd_json FROM material_crowd
    WHERE account_id = ? AND material_id = ? ORDER BY stat_date DESC LIMIT 1
  `).get(accountId, materialId);
  const crowdProfile = crowdRow ? parseCrowd(crowdRow.crowd_json) : null;
  const crowdArrays = crowdRow ? parseCrowdArrays(crowdRow.crowd_json) : null;
  const audience = crowdProfile
    ? { gender: crowdProfile.genderTop, age: crowdProfile.ageTop[0] || null, region_top: crowdProfile.regionTop.slice(0, 3) }
    : { gender: null, age: null, region_top: [] };

  // 脚本与创意标签：全部读取本地 material_content，不为打开抽屉访问千川上游。
  // 分别选择最近的非空记录，兼容脚本与创意分析在不同日期写入的旧数据。
  const contentRows = db.prepare(`
    SELECT script_json, creative_json FROM material_content
    WHERE account_id = ? AND material_id = ?
      AND (script_json IS NOT NULL OR creative_json IS NOT NULL)
    ORDER BY stat_date DESC
  `).all(accountId, materialId);
  const scriptRow = contentRows.find(row => row.script_json) || null;
  const creativeRow = contentRows.find(row => row.creative_json) || null;
  let script = null;
  if (scriptRow) {
    try { script = JSON.parse(scriptRow.script_json).text || null; } catch { /* 脚本JSON损坏则置空 */ }
  }
  const creativeTags = parseCreativeTags(
    creativeRow && creativeRow.creative_json,
    scriptRow && scriptRow.script_json
  );

  // 留存：秒级留存表 + 日报表的完播/3s/平均观看时长
  const insightRow = db.prepare(`
    SELECT total_seconds, lose_rate_5s, click_count, drop_count, seconds_json FROM material_insight
    WHERE account_id = ? AND material_id = ? ORDER BY stat_date DESC LIMIT 1
  `).get(accountId, materialId);
  const retention = {
    total_seconds: insightRow ? insightRow.total_seconds : null,
    lose_rate_5s: insightRow ? insightRow.lose_rate_5s : null,
    finish_rate: round2(latest.finish_rate),
    rate3s: round2(latest.rate3s),
    avg_watch_time: round2(latest.avg_watch_time),
    clicks_7d: clicks7,
    cpc_7d: cpc7,
    click_count: insightRow ? (insightRow.click_count || 0) : null,
    drop_count: insightRow ? (insightRow.drop_count || 0) : null,
  };
  // 保留秒级曲线兼容旧消费端
  let retentionCurve = null;
  if (insightRow && insightRow.seconds_json) {
    try {
      retentionCurve = JSON.parse(insightRow.seconds_json)
        .map(r => ({ second: +r.second || 0, viewers: +r.watchCount || 0 }))
        .filter(p => p.second >= 0);
    } catch { retentionCurve = null; }
  }

  const lifecycle = resolveLifecycle(rows, latest.created_at);
  const profile = {
    material_id: materialId,
    name,
    summary: '',
    days_active: daysActive,
    cost_total: costTotal,
    roi_total: roiTotal,
    cost_30d: cost30,
    roi_30d: roi30,
    cost_7d: cost7,
    roi_7d: roi7,
    lifecycle,
    audience,
    audience_dist: crowdProfile, // 全量分布（genderDist/ageDist/regionDist，前端人群条形图秒开，无需等千川实时）
    audience_full: crowdArrays,   // 各维度数组（count+rate），供图表直接使用
    script,
    creative_tags: creativeTags,
    retention,
    retention_curve: retentionCurve, // 秒级留存曲线（本地 T+1 深度采集），前端即开即有
    trend_14d: trend14,
    trend_30d: trend30,
    _trendCn: calcTrendCn(trend14),
  };
  profile.summary = buildSummary(profile);
  delete profile._trendCn;
  return profile;
}

// ═══════════════════════════════════════════════════════════
// ② 人群洞察（优质/亏损素材人群交集）
// ═══════════════════════════════════════════════════════════

/**
 * 生成 2~4 条投放建议（收紧 X 定向 / 拓展 Y 人群，带数据依据）。
 * @param {object} winners - 优质素材人群交集（intersectCrowd 返回，count 为符合门槛的素材数）
 * @param {object} losers - 亏损素材人群交集
 * @param {number} days - 统计窗口天数
 * @param {number} eligibleCount - 窗口内消耗≥门槛的素材总数
 * @returns {string[]}
 */
function buildAdvice(winners, losers, days, eligibleCount) {
  const advice = [];
  if (winners.count === 0) {
    advice.push(`近${days}天无净ROI≥2.0且消耗≥${MIN_COST_FOR_INSIGHT}元的素材，建议先跑出优质素材再分析人群交集`);
  }
  if (losers.count === 0) {
    advice.push(`近${days}天无净ROI<1.0且消耗≥${MIN_COST_FOR_INSIGHT}元的素材，当前账户素材整体不亏损`);
  }
  if (winners.gender && losers.gender && winners.gender !== losers.gender) {
    advice.push(`收紧「${losers.gender}性」定向、拓展「${winners.gender}性」人群：优质素材${winners.gender}性GMV占比${pct(winners.gender_share)}，亏损素材则以${losers.gender}性为主（${pct(losers.gender_share)}）`);
  } else if (winners.gender && winners.gender_share >= 0.6) {
    advice.push(`保持「${winners.gender}性」定向：优质素材${winners.gender}性GMV占比达${pct(winners.gender_share)}，人群集中度高`);
  }
  if (winners.age.length && losers.age.length) {
    const expandAge = winners.age.filter(a => !losers.age.includes(a));
    const shrinkAge = losers.age.filter(a => !winners.age.includes(a));
    if (expandAge.length && shrinkAge.length) {
      advice.push(`年龄定向向「${expandAge.join('、')}」倾斜：优质素材核心年龄段为${winners.age.join('、')}，「${shrinkAge.join('、')}」仅在亏损素材中集中，建议收紧`);
    }
  }
  if (winners.region.length && losers.region.length) {
    const shrinkReg = losers.region.filter(r => !winners.region.includes(r));
    if (shrinkReg.length) {
      advice.push(`地域向${winners.region.slice(0, 3).join('、')}集中：这些省份在优质素材中稳定进Top5；「${shrinkReg.slice(0, 3).join('、')}」仅在亏损素材中集中，建议收缩投放`);
    }
  }
  // 兜底补足 2 条：规则未触发时给出集合规模结论
  if (advice.length < 2) {
    advice.push(`近${days}天消耗≥${MIN_COST_FOR_INSIGHT}元的素材共${eligibleCount}条，其中优质${winners.count}条、亏损${losers.count}条，建议持续汰换亏损素材、复制优质素材定向`);
  }
  return advice.slice(0, 4);
}

/**
 * 构建人群洞察：近 N 天优质（净ROI≥2.0）与亏损（净ROI<1.0）素材的人群交集。
 * 仅统计消耗 ≥ MIN_COST_FOR_INSIGHT 元的素材，避免低消耗素材的 ROI 噪音。
 * @param {string} accountId - 千川账号ID
 * @param {number} days - 统计窗口天数（截止昨天）
 * @returns {{ok:true, days:number, range:{start:string,end:string}, winners:object, losers:object, advice:string[]}}
 */
function buildAudienceInsight(accountId, days) {
  const db = getDB();
  const start = daysAgo(days);
  const end = yesterday();
  const rows = db.prepare(`
    SELECT material_id, SUM(cost) AS cost, SUM(net_gmv) AS net_gmv
    FROM material_daily
    WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
    GROUP BY material_id
  `).all(accountId, start, end);

  const eligible = rows
    .filter(r => (r.cost || 0) >= MIN_COST_FOR_INSIGHT)
    .map(r => ({ material_id: r.material_id, cost: r.cost, roi: r.cost > 0 ? r.net_gmv / r.cost : 0 }));
  const winnerRows = eligible.filter(r => r.roi >= 2.0).sort((a, b) => b.cost - a.cost).slice(0, MAX_MATERIALS_PER_SET);
  const loserRows = eligible.filter(r => r.roi < 1.0).sort((a, b) => b.cost - a.cost).slice(0, MAX_MATERIALS_PER_SET);

  const crowdStmt = db.prepare(`
    SELECT crowd_json FROM material_crowd
    WHERE account_id = ? AND material_id = ? ORDER BY stat_date DESC LIMIT 1
  `);
  const loadProfiles = (list) => {
    const profiles = [];
    for (const m of list) {
      const row = crowdStmt.get(accountId, m.material_id);
      if (!row) continue;
      const p = parseCrowd(row.crowd_json);
      if (p) profiles.push(p);
    }
    return profiles;
  };

  const winners = intersectCrowd(loadProfiles(winnerRows));
  const losers = intersectCrowd(loadProfiles(loserRows));
  // count 语义为"符合门槛的素材数"（无人群数据的素材也计入）
  winners.count = winnerRows.length;
  losers.count = loserRows.length;
  const advice = buildAdvice(winners, losers, days, eligible.length);
  return { ok: true, days, range: { start, end }, winners, losers, advice };
}

module.exports = {
  PROFILE_CACHE_DIR,
  readDayCache,
  writeDayCache,
  invalidateMaterialProfileCache,
  buildMaterialProfile,
  buildAudienceInsight,
};
