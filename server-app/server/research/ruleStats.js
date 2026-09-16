/**
 * 规则胜率统计：把 decisionReview 的逐条后验聚合成"每类操作的胜率"，
 * 让投手 Agent 知道"按某条规则操作，历史上到底赢多还是输多"——
 * 这是阈值调优（斩断线/加码线等）的量化依据，也是"自主学习"的实质一环。
 *
 * 产出两份：
 *   1. agent-memory/reports/rule_stats_YYYY-MM-DD.json —— 完整数据（供后端/页面）
 *   2. agent-memory/lessons/rule_win_rates.md —— 紧凑文本（投手 Step 0 会读到）
 *
 * 建议规则（不自动改阈值，只给建议，人确认后写 config）：
 *   某类操作有效后验 ≥5 次且胜率 <50% → 建议复核该规则阈值/口径
 */
const fs = require('fs');
const path = require('path');
// 退役实现：不再进入夜间任务或 Agent 经验读取链路。
const { query: queryOpLog } = require('../lib/operationLog');
const { reviewDay } = require('./decisionReview');
const { formatDate } = require('../lib/utils');

function shiftDate(dateStr, days) {
  return formatDate(new Date(new Date(dateStr).getTime() + days * 86400000));
}

const MEMORY_DIR = path.join(__dirname, '..', '..', 'agent-memory');

const ACTION_LABELS = {
  pause: '暂停（止损向）',
  delete_boost: '删除追投',
  delete_material: '删除素材',
  update_budget: '预算调整',
  update_roi: 'ROI 目标调整',
  update_budget_roi: '预算+ROI 同调',
  create_boost: '创建追投',
};
const SOURCE_LABELS = { agent: 'Agent', api: '投手' };

// 拉普拉斯平滑（2026-08-01 审计 P1：原纯除法 3/3=100% 与 100/100=100% 同权失真，小样本胜率被放大引 agent 盲目自信；
// 平滑后 3/3→80%、100/100→99%，高胜率榜自然按置信度分层）
function pct(a, b) { return b > 0 ? +((a + 1) / (b + 2) * 100).toFixed(1) : 0; }

/**
 * 聚合近 days 天（不含今天——当天后验必为 pending）的规则胜率。
 * @param {number} [days=90]
 * @param {string} [accountId]
 * @returns {object} stats
 */
function computeRuleStats(days = 90, accountId = null) {
  const yesterday = shiftDate(formatDate(new Date()), -1);
  const start = shiftDate(formatDate(new Date()), -days);
  const queryOpts = { startDate: start, endDate: yesterday, excludeSources: ['e2e'], limit: 2000 };
  if (accountId) queryOpts.accountId = accountId;
  const ops = queryOpLog(queryOpts); // 排除 E2E 测试数据

  // 逐条后验（复用 decisionReview 同一口径，避免两套评分打架）
  const judged = [];
  for (const op of ops) {
    const day = (op.ts || '').slice(0, 10);
    if (!day) continue;
    judged.push({ op, day });
  }

  // 按日分组复用 reviewDay，合并 items
  const byDay = {};
  for (const { day } of judged) byDay[day] = true;
  const allItems = [];
  for (const day of Object.keys(byDay)) {
    try {
      const r = reviewDay(day, accountId);
      (r.items || []).forEach(it => {
        if (!accountId || it.op.account_id === accountId) {
          allItems.push(it);
        }
      });
    } catch (e) {
      console.error(`[rule-stats] ${day} 后验失败: ${e.message}`);
    }
  }

  // 聚合：动作 × 来源
  const bucket = {};
  for (const it of allItems) {
    if (it.pending) continue;
    const action = it.op.action;
    const source = it.op.source === 'agent' ? 'agent' : 'api';
    const key = `${action}|${source}`;
    if (!bucket[key]) bucket[key] = { action, source, judged: 0, plus: 0, minus: 0, zero: 0, totalScore: 0 };
    const b = bucket[key];
    b.judged++;
    if (it.score > 0) b.plus++;
    else if (it.score < 0) b.minus++;
    else b.zero++;
    b.totalScore += it.score;
  }

  const rules = Object.values(bucket).map(b => ({
    action: b.action,
    label: ACTION_LABELS[b.action] || b.action,
    source: b.source,
    source_label: SOURCE_LABELS[b.source] || b.source,
    judged: b.judged,
    plus: b.plus, minus: b.minus, zero: b.zero,
    win_rate: pct(b.plus, b.judged),
    lose_rate: pct(b.minus, b.judged),
    avg_score: b.judged ? +(b.totalScore / b.judged).toFixed(2) : 0,
  })).sort((a, b) => b.judged - a.judged);

  // 汇总 + 建议
  const totalJudged = rules.reduce((s, r) => s + r.judged, 0);
  const totalPlus = rules.reduce((s, r) => s + r.plus, 0);
  const suggestions = [];
  for (const r of rules) {
    if (r.judged >= 5 && r.win_rate < 50) {
      suggestions.push(`「${r.label}」(${r.source_label}) 近段 ${r.judged} 次有效后验胜率仅 ${r.win_rate}%，建议复核该规则的触发线/口径`);
    }
  }
  if (!suggestions.length && totalJudged >= 5) {
    suggestions.push(`各规则胜率均在 50% 上方（综合胜率 ${pct(totalPlus, totalJudged)}%），暂无阈值调整建议`);
  }
  if (totalJudged < 5) {
    suggestions.push(`有效后验样本不足（${totalJudged} 次），胜率暂不构成阈值调整依据，继续积累`);
  }

  return {
    account_id: accountId || 'global',
    generated_at: new Date().toISOString(),
    window: { start, end: yesterday, days },
    total_ops: ops.length,
    total_judged: totalJudged,
    overall_win_rate: pct(totalPlus, totalJudged),
    rules,
    suggestions,
  };
}

/** 写完整 JSON + 更新 lessons/rule_win_rates.md（按账号隔离） */
function writeRuleStats(stats) {
  const date = (stats.generated_at || new Date().toISOString()).slice(0, 10);
  const accountId = stats.account_id !== 'global' ? stats.account_id : null;
  const baseDir = accountId ? path.join(MEMORY_DIR, accountId) : MEMORY_DIR;
  
  const reportsDir = path.join(baseDir, 'reports');
  const lessonsDir = path.join(baseDir, 'lessons');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  if (!fs.existsSync(lessonsDir)) fs.mkdirSync(lessonsDir, { recursive: true });

  const jsonPath = path.join(reportsDir, `rule_stats_${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(stats, null, 2), 'utf-8');

  const lines = [
    `# 规则胜率统计（近 ${stats.window.days} 天滚动窗口）`,
    `> 记录时间: ${new Date().toISOString()}`,
    `> 账号: ${accountId || '全局'}`,
    ``,
    `窗口 ${stats.window.start} ~ ${stats.window.end} · 写操作 ${stats.total_ops} 次 · 有效后验 ${stats.total_judged} 次 · 综合胜率 ${stats.overall_win_rate}%`,
    ``,
    `| 规则 | 执行者 | 后验次数 | 胜率 | 均分(-2~+2) |`,
    `|---|---|---|---|---|`,
    ...stats.rules.map(r => `| ${r.label} | ${r.source_label} | ${r.judged} | ${r.win_rate}% | ${r.avg_score} |`),
    ``,
    `## 阈值建议`,
    ...stats.suggestions.map(s => `- ${s}`),
  ];
  const lessonPath = path.join(lessonsDir, 'rule_win_rates.md');
  fs.writeFileSync(lessonPath, lines.join('\n') + '\n', 'utf-8');
  return { jsonPath, lessonPath };
}

/** 供 Prompt 调用的高胜率与避坑指南格式化导出 */
function getAccountPromptLessons(accountId) {
  try {
    const stats = computeRuleStats(90, accountId);
    if (!stats || !stats.rules || !stats.rules.length) return '';
    const highWin = stats.rules.filter(r => r.judged >= 3 && r.win_rate >= 70);
    const lowWin = stats.rules.filter(r => r.judged >= 3 && r.win_rate < 50);
    
    const lines = [];
    if (highWin.length) {
      lines.push('【高胜率策略（推荐保持）】: ' + highWin.map(r => `${r.label}(胜率${r.win_rate}%, ${r.judged}次)`).join('；'));
    }
    if (lowWin.length) {
      lines.push('【高危告警策略（谨慎触发）】: ' + lowWin.map(r => `${r.label}(胜率仅${r.win_rate}%, ${r.judged}次)`).join('；'));
    }
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

/** 夜间任务入口：统计 + 落盘，返回简要结果供日志 */
function runRuleStats(days = 90) {
  const stats = computeRuleStats(days);
  const { jsonPath, lessonPath } = writeRuleStats(stats);
  
  // 顺便生成各账号独立的胜率报告
  try {
    const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
    (QIANCHUAN_ACCOUNTS || []).forEach(acc => {
      const acctStats = computeRuleStats(days, acc.id);
      writeRuleStats(acctStats);
    });
  } catch (e) {}

  console.log(`[rule-stats] 窗口 ${stats.window.start}~${stats.window.end} · 后验 ${stats.total_judged} 次 · 综合胜率 ${stats.overall_win_rate}% · ${path.basename(jsonPath)}`);
  return stats;
}

module.exports = { computeRuleStats, writeRuleStats, runRuleStats, getAccountPromptLessons };
