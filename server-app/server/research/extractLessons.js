/**
 * scripts/extract_lessons.js — 经验提取引擎
 *
 * 从已评估的决策中归纳高胜率模式（score ≥ 0.8），提取成可复用的结构化经验。
 */

const fs = require('fs');
const path = require('path');
// 退役实现：仅保留原公式供历史审计，不由服务调度。
const ledger = require('../lib/decisionLedger');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');

const memoryBase = () => ledger.memoryBaseDir();

function categorizeCost(cost) {
  if (cost < 100) return 'low';
  if (cost < 500) return 'medium';
  return 'high';
}

function categorizeROI(roi) {
  if (roi < 1.8) return 'low';
  if (roi < 2.5) return 'medium';
  return 'high';
}

function mode(arr) {
  if (!arr || !arr.length) return null;
  const counts = {};
  let maxItem = arr[0], maxCount = 1;
  for (const item of arr) {
    counts[item] = (counts[item] || 0) + 1;
    if (counts[item] > maxCount) {
      maxCount = counts[item];
      maxItem = item;
    }
  }
  return maxItem;
}

/** 加载账号下已完成评估的近 N 天决策 */
function loadEvaluatedDecisions(accountId, days = 14, options = {}) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  try {
    return ledger.listRounds(accountId, { limit: 500, baseDir: options.baseDir }).filter(rec => {
      const ts = new Date(rec.observed_at || rec.recorded_at).getTime();
      return ts >= cutoff && rec.outcome && rec.outcome.score != null;
    });
  } catch { return []; }
}

/** 从高分决策提取经验模式 */
function extractLessonsForAccount(accountId, days = 14, options = {}) {
  const records = loadEvaluatedDecisions(accountId, days, options);
  if (!records.length) return [];

  // 筛选高分决策（得分 ≥ 0.8）
  const goodRecords = records.filter(r => +r.outcome.score >= 0.8);
  const badRecords = records.filter(r => +r.outcome.score < 0.5);

  // 按动作类型分组
  const byAction = {};
  for (const r of goodRecords) {
    const decs = Array.isArray(r.actions) ? r.actions : [];
    for (const d of decs) {
      const act = d.code || d.action || d.type || 'unknown';
      if (!byAction[act]) byAction[act] = [];
      byAction[act].push({ record: r, decision: d });
    }
  }

  const extracted = [];
  for (const [action, items] of Object.entries(byAction)) {
    if (items.length < 3) continue; // 至少 3 个高分样本才提取模式

    const costs = items.map(i => categorizeCost((i.decision.reason_metrics || i.decision.evidence || {}).cost || 0));
    const rois = items.map(i => categorizeROI((i.decision.reason_metrics || i.decision.evidence || {}).roi || 0));
    const modeCost = mode(costs);
    const modeRoi = mode(rois);

    // 统计相同动作低分样本数
    const badCount = badRecords.filter(r => {
      const decs = Array.isArray(r.actions) ? r.actions : [];
      return decs.some(d => (d.code || d.action || d.type || 'unknown') === action);
    }).length;

    const winRate = +(items.length / (items.length + badCount) * 100).toFixed(1);
    if (winRate < 60) continue; // 胜率低于 60% 不提取

    const lessonItem = {
      id: `${action}_${modeCost}_${modeRoi}`,
      title: `${accountId} ${action} 优化模式（胜率 ${winRate}%）`,
      conditions: {
        action,
        cost_range: modeCost,
        roi_range: modeRoi,
      },
      win_rate: winRate,
      sample_count: items.length,
      body: `在 ${accountId} 账号中，当消耗位于 ${modeCost} 档且 ROI 为 ${modeRoi} 档时，执行 ${action} 操作具有高胜率（${winRate}%），共依据 ${items.length} 次成功验证。`,
      extracted_at: new Date().toISOString(),
    };

    extracted.push(lessonItem);
  }

  if (extracted.length) {
    saveLessons(accountId, extracted, options);
  }
  return extracted;
}

/** 存档写入账号 lessons 目录 */
function saveLessons(accountId, lessons, options = {}) {
  const lessonsDir = path.join(options.baseDir || memoryBase(), accountId, 'lessons');
  if (!fs.existsSync(lessonsDir)) fs.mkdirSync(lessonsDir, { recursive: true });

  const targetFile = path.join(lessonsDir, 'extracted_patterns.json');
  fs.writeFileSync(targetFile, JSON.stringify(lessons, null, 2), 'utf8');
}

/** 全账号经验提取 */
function extractAllLessons(days = 14) {
  const result = {};
  for (const account of (QIANCHUAN_ACCOUNTS || [])) {
    const lessons = extractLessonsForAccount(account.id, days);
    result[account.id] = lessons;
  }
  return result;
}

// 命令行直接调用
if (require.main === module) {
  const res = extractAllLessons(14);
  console.log('[extract-lessons] 经验提取完成:', JSON.stringify(res, null, 2));
}

module.exports = { extractLessonsForAccount, extractAllLessons };
