/**
 * server/lib/nightTasks.js — 晚间夜间任务
 *
 * 在回填任务完成后自动执行：
 * 1. 数据库备份（保留最近7份）
 * 2. 生成昨日日报（两个账号各一份），存到 agent-memory/reports/
 * 3. AI复盘：对比昨日决策记录和实际数据，自动写经验到 agent-memory/lessons/
 */

const fs = require('fs');
const path = require('path');
const { formatDate, num } = require('./utils');
const { aggregateRange, getDB } = require('./db');
const opLog = require('./operationLog');
const { manual_config, CLASSIFICATION } = require('./config');

const MEMORY_DIR = path.join(__dirname, '..', '..', 'agent-memory');
const REPORTS_DIR = path.join(MEMORY_DIR, 'reports');
const LESSONS_DIR = path.join(MEMORY_DIR, 'lessons');
const DECISIONS_DIR = path.join(MEMORY_DIR, 'decisions');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const DB_PATH = path.join(__dirname, '..', '..', 'cache', 'material_history.db');

[REPORTS_DIR, LESSONS_DIR, DECISIONS_DIR, BACKUP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/**
 * 数据库备份：用 SQLite 的 VACUUM INTO 做热备份（不停服），保留最近7份。
 * 每天一份，文件名格式 material_history_YYYY-MM-DD.db
 * 2026-08-11 backlog 检修：备份成败写入 cache/backup_state.json，/health 可查（静默失败多日 = 无恢复源）
 */
const BACKUP_STATE_FILE = path.join(__dirname, '..', '..', 'cache', 'backup_state.json');

function writeBackupState(state) {
  try {
    const tmp = BACKUP_STATE_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, BACKUP_STATE_FILE);
  } catch (e) {
    console.error('[night-task] 写 backup_state.json 失败:', e.message);
  }
}

function backupDatabase() {
  const date = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000)); // 昨天日期
  const backupFile = path.join(BACKUP_DIR, `material_history_${date}.db`);

  try {
    // 如果今天的备份已存在，跳过
    if (fs.existsSync(backupFile)) {
      console.log(`[night-task] 数据库备份已存在: ${backupFile}`);
      writeBackupState({ last_success_at: new Date().toISOString(), last_fail_at: null, last_error: null });
      return;
    }

    // 路径白名单（2026-08-11 backlog 检修：防未来改动引入 SQL 注入/路径穿越，VACUUM INTO 是 SQL 拼接）
    if (!backupFile.startsWith(BACKUP_DIR) || !/^material_history_\d{4}-\d{2}-\d{2}\.db$/.test(path.basename(backupFile))) {
      throw new Error('备份路径非法: ' + backupFile);
    }

    // 用 SQLite VACUUM INTO 做热备份（WAL模式下也能保证一致性）
    const db = getDB();
    db.exec(`VACUUM INTO '${backupFile.replace(/\\/g, '/')}'`);
    const size = fs.statSync(backupFile).size;
    console.log(`[night-task] 数据库已备份: ${path.basename(backupFile)} (${(size / 1024).toFixed(0)}KB)`);
    writeBackupState({ last_success_at: new Date().toISOString(), last_fail_at: null, last_error: null });

    // 清理超过7份的旧备份
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('material_history_') && f.endsWith('.db'))
      .sort()
      .reverse();
    if (backups.length > 7) {
      for (const old of backups.slice(7)) {
        fs.unlinkSync(path.join(BACKUP_DIR, old));
        console.log(`[night-task] 清理旧备份: ${old}`);
      }
    }
  } catch (e) {
    console.error(`[night-task] 数据库备份失败:`, e.message);
    writeBackupState({ last_success_at: null, last_fail_at: new Date().toISOString(), last_error: e.message });
  }
}

/**
 * 生成昨日日报并存储
 * @param {string} date - 昨天日期 YYYY-MM-DD
 * @param {string} accountId - 账号ID
 * @param {string} accountName - 账号中文名
 */
function generateDailyReport(date, accountId, accountName) {
  try {
    const agg = aggregateRange(date, date, accountId);
    const totalCost = agg.reduce((s, r) => s + num(r['整体消耗(元)']), 0);
    const totalGmv = agg.reduce((s, r) => s + num(r['整体成交金额(元)']), 0);
    const totalNetGmv = agg.reduce((s, r) => s + num(r['净成交金额(元)']), 0);
    const totalOrders = agg.reduce((s, r) => s + num(r['整体成交订单数']), 0);
    const totalPlays = agg.reduce((s, r) => s + num(r['视频播放次数']), 0);
    const totalBoostCost = agg.reduce((s, r) => s + num(r['追投调控消耗(元)']), 0);
    const totalBoostGmv = agg.reduce((s, r) => s + num(r['追投调控净成交金额(元)']), 0);

    const roi = totalCost > 0 ? totalGmv / totalCost : 0;
    const netRoi = totalCost > 0 ? totalNetGmv / totalCost : 0;
    const boostRoi = totalBoostCost > 0 ? totalBoostGmv / totalBoostCost : 0;
    const orderCost = totalOrders > 0 ? totalCost / totalOrders : 0;

    // 当日操作日志
    const logs = opLog.query({ startDate: date, endDate: date, accountId, limit: 100 });
    const successOps = logs.filter(l => l.success).length;
    const failOps = logs.filter(l => !l.success).length;

    // 素材排行（按消耗）
    const topMaterials = agg
      .filter(r => num(r['整体消耗(元)']) > 0)
      .sort((a, b) => num(b['整体消耗(元)']) - num(a['整体消耗(元)']))
      .slice(0, 10)
      .map(r => ({
        id: r['素材ID'],
        name: r['素材名称'],
        cost: num(r['整体消耗(元)']),
        gmv: num(r['整体成交金额(元)']),
        roi: num(r['整体支付ROI']),
        orders: num(r['整体成交订单数']),
        status: r['状态'],
      }));

    // 追投排行
    const topBoost = agg
      .filter(r => num(r['追投调控消耗(元)']) > 0)
      .sort((a, b) => num(b['追投调控消耗(元)']) - num(a['追投调控消耗(元)']))
      .slice(0, 5)
      .map(r => ({
        id: r['素材ID'],
        name: r['素材名称'],
        boostCost: num(r['追投调控消耗(元)']),
        boostGmv: num(r['追投调控净成交金额(元)']),
        boostRoi: num(r['追投调控支付ROI']),
      }));

    const report = {
      date,
      account_id: accountId,
      account_name: accountName,
      generated_at: new Date().toISOString(),
      generated_by: 'night_task',
      summary: {
        cost: Math.round(totalCost * 100) / 100,
        gmv: Math.round(totalGmv * 100) / 100,
        net_gmv: Math.round(totalNetGmv * 100) / 100,
        roi: Math.round(roi * 100) / 100,
        net_roi: Math.round(netRoi * 100) / 100,
        orders: totalOrders,
        plays: totalPlays,
        order_cost: Math.round(orderCost * 100) / 100,
        boost_cost: Math.round(totalBoostCost * 100) / 100,
        boost_gmv: Math.round(totalBoostGmv * 100) / 100,
        boost_roi: Math.round(boostRoi * 100) / 100,
        material_count: agg.filter(r => num(r['整体消耗(元)']) > 0).length,
      },
      operations: {
        total: logs.length,
        success: successOps,
        fail: failOps,
        details: logs.slice(0, 20).map(l => ({
          time: l.ts,
          action: l.action,
          success: l.success,
          result_msg: l.result_msg,
        })),
      },
      top_materials: topMaterials,
      top_boost: topBoost,
    };

    const fileName = `daily_${accountId}_${date}.json`;
    fs.writeFileSync(path.join(REPORTS_DIR, fileName), JSON.stringify(report, null, 2), 'utf8');
    console.log(`[night-task] 日报已生成: ${fileName}`);
    return report;
  } catch (e) {
    console.error(`[night-task] 日报生成失败 ${accountId} ${date}:`, e.message);
    return null;
  }
}

/**
 * AI复盘：对比昨日决策记录和实际数据效果，自动写经验
 * @param {string} date - 昨天日期 YYYY-MM-DD
 * @param {Array} reports - 两个账号的日报数据
 */
function generateDailyReview(date, reports) {
  try {
    // 读取当天的决策记录
    const decisionFiles = fs.readdirSync(DECISIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    const dayDecisions = [];
    for (const f of decisionFiles) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DECISIONS_DIR, f), 'utf8'));
        if (d.time && d.time.startsWith(date)) {
          dayDecisions.push(d);
        }
      } catch { /* skip */ }
    }

    // 读取已有经验（避免重复写）
    const lessonId = `daily_${date}`;
    const lessonPath = path.join(LESSONS_DIR, lessonId + '.md');
    if (fs.existsSync(lessonPath)) {
      console.log(`[night-task] 复盘经验 ${lessonId} 已存在，跳过`);
      return;
    }

    // 构建复盘内容
    const lines = [];
    lines.push(`# 每日复盘：${date}`);
    lines.push(`> 自动生成时间: ${new Date().toISOString()}（凌晨夜间任务）`);
    lines.push('');

    // 数据概况
    lines.push('## 数据概况');
    for (const r of reports) {
      if (!r || !r.summary) continue;
      const s = r.summary;
      const profit = s.net_gmv - s.cost;
      const profitStr = profit >= 0 ? `盈利${profit.toFixed(0)}元` : `亏损${Math.abs(profit).toFixed(0)}元`;
      lines.push(`- ${r.account_name}：消耗${s.cost}元，净成交${s.net_gmv}元，净ROI ${s.net_roi}，${s.orders}单，${profitStr}`);
      if (s.boost_cost > 0) {
        lines.push(`  - 追投：消耗${s.boost_cost}元，ROI ${s.boost_roi}`);
      }
    }
    lines.push('');

    // 决策回顾
    if (dayDecisions.length > 0) {
      lines.push('## AI决策回顾');
      lines.push(`共运行 ${dayDecisions.length} 轮：`);
      dayDecisions.forEach(d => {
        lines.push(`- 第${d.round || '?'}轮：${d.actions || '无操作'}`);
        if (d.expected_effect) lines.push(`  - 预期：${d.expected_effect}`);
      });
      lines.push('');
    }

    // 操作统计
    lines.push('## 操作统计');
    for (const r of reports) {
      if (!r || !r.operations) continue;
      const ops = r.operations;
      lines.push(`- ${r.account_name}：共${ops.total}次操作（成功${ops.success}，失败${ops.fail}）`);
      // 失败操作
      const fails = (ops.details || []).filter(d => !d.success);
      if (fails.length > 0) {
        lines.push(`  - 失败原因：`);
        fails.forEach(f => {
          lines.push(`    - ${f.action}: ${f.result_msg || '未知原因'}`);
        });
      }
    }
    lines.push('');

    // 效果分析
    lines.push('## 效果分析');
    for (const r of reports) {
      if (!r || !r.summary) continue;
      const s = r.summary;
      const breakEven = 2.0; // 保本ROI
      if (s.net_roi < breakEven) {
        lines.push(`- ${r.account_name}：净ROI ${s.net_roi} 低于保本线${breakEven}，${s.cost > 500 ? '消耗较大需关注' : '消耗可控'}`);
      } else {
        lines.push(`- ${r.account_name}：净ROI ${s.net_roi} 达标，表现良好`);
      }
      if (s.boost_cost > 200 && s.boost_roi < 1.0) {
        lines.push(`- ${r.account_name}：追投消耗${s.boost_cost}元但ROI仅${s.boost_roi}，追投效果差，建议检查追投素材质量`);
      }
    }
    lines.push('');

    // 素材亮点
    lines.push('## 素材亮点');
    for (const r of reports) {
      if (!r || !r.top_materials || r.top_materials.length === 0) continue;
      const top = r.top_materials[0];
      lines.push(`- ${r.account_name}消耗最高：${top.name || top.id}，消耗${top.cost}元，ROI ${top.roi}`);
    }
    lines.push('');

    // 教训总结
    lines.push('## 教训总结');
    for (const r of reports) {
      if (!r || !r.summary) continue;
      const s = r.summary;
      if (s.net_roi < 1.5 && s.cost > 500) {
        lines.push(`- ${r.account_name}：ROI持续低于1.5且消耗超500元，需复盘素材质量和直播间承接力，不能仅靠调ROI目标解决问题`);
      }
    }
    // 429限流教训
    const has429 = dayDecisions.some(d => (d.actions || '').includes('429') || (d.actions || '').includes('限流'));
    if (has429) {
      lines.push(`- 当天出现429限流，操作频率过高，建议调整间隔至30分钟以上`);
    }
    // 3026错误教训
    const has3026 = dayDecisions.some(d => (d.actions || '').includes('3026'));
    if (has3026) {
      lines.push(`- 出现3026错误（区县定向缺城市参数），需修复追投ROI修改接口或调整追投定向设置`);
    }

    const content = lines.join('\n');
    fs.writeFileSync(lessonPath, content, 'utf8');
    console.log(`[night-task] 复盘经验已生成: ${lessonId}.md`);
  } catch (e) {
    console.error(`[night-task] 复盘经验生成失败 ${date}:`, e.message);
  }
}

/**
 * 执行夜间任务：日报 + 复盘
 * @param {Array} accounts - 账号列表 [{ id, name }]
 */
async function runNightTasks(accounts) {
  const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  console.log(`[night-task] 开始执行夜间任务，目标日期: ${yesterday}`);

  // 0. 数据库备份（最先执行，确保数据不丢）
  backupDatabase();

  // 0.6 采集对账：本地 material_daily 昨日汇总 vs 千川账户级汇总，偏差>5% 告警
  // （防整段漏采静默存在——曾导致素材 ROI 被低估、AI 误删素材）
  for (const acc of accounts) {
    try {
      const { reconcileDate } = require('./reconcile');
      await reconcileDate(yesterday, acc.id);
    } catch (e) {
      console.error(`[night-task] ${acc.id} 对账执行失败:`, e.message);
    }
  }

  // 历史账户专用说明已从试用包移除。
  try {
    const { spawnSync } = require('child_process');
    const script = path.join(__dirname, '..', '..', 'scripts', 'intraday_reconcile.js');
    const r = spawnSync(process.execPath, [script], { timeout: 60000, encoding: 'utf8' });
    if (r.status !== 0) console.error(`[night-task] 盘中对账失败: ${(r.stderr || '').slice(0, 200)}`);
    else console.log((r.stdout || '').trim().split('\n')[0]);
  } catch (e) {
    console.error('[night-task] 盘中对账执行异常:', e.message);
  }
  try {
    const { prune } = require('./intradayStore');
    const n = prune(7);
    console.log(`[night-task] 盘中库 prune 清理 ${n} 行（保留近 7 天）`);
  } catch (e) {
    console.error('[night-task] 盘中库 prune 失败:', e.message);
  }

  // 自动事后评分、规则胜率及其经验报告已退役；原始数据回填继续。

  // 0.75 深度数据刷新：保留素材留存、简报 hook 和原始证据。
  try {
    const { refreshDeepData } = require('./fetchDaily');
    await refreshDeepData(yesterday, accounts);
  } catch (e) {
    console.error('[night-task] 深度数据刷新总调度失败:', e.message);
  }

  // 0.755 每日素材文案完整性检查：不能用 material_content “有行”代替“有文案”。
  // 只补昨日真实素材，缺失项按消耗顺序有限修复；失败留状态文件，下次夜任务继续自愈。
  for (const acc of accounts) {
    try {
      const { auditMaterialScripts } = require('./materialScriptCoverage');
      const coverage = await auditMaterialScripts({
        accountId: acc.id,
        date: yesterday,
        repair: true,
        limit: 30,
      });
      console.log(`[night-task] 素材文案 ${acc.id} @${yesterday}: ${coverage.available_scripts}/${coverage.total_materials}（缺${coverage.missing_scripts}，本轮补${coverage.repaired_count}）`);
    } catch (e) {
      console.error(`[night-task] 素材文案检查失败 ${acc.id}:`, e.message);
    }
  }

  // 历史账户专用说明已从试用包移除。
  for (const acc of accounts) {
    try {
      const { syncAccountDay } = require('./liveSessionStore');
      const r = await syncAccountDay(acc.id, yesterday);
      console.log(`[night-task] 场次入库 ${acc.id} @${yesterday}: ${r.sessions} 场 / trend ${r.trend} 点 / actions ${r.actions} 条${r.errors.length ? ' / 异常 ' + r.errors.length : ''}`);
    } catch (e) {
      console.error(`[night-task] 场次入库失败 ${acc.id}:`, e.message);
    }
  }

  // 1. 生成日报
  const reports = [];
  for (const acc of accounts) {
    const report = generateDailyReport(yesterday, acc.id, acc.name);
    if (report) reports.push(report);
  }

  // 2. AI复盘
  generateDailyReview(yesterday, reports);

  // 3. 素材洞察报告（规则版，作为 AI Agent 的输入数据）
  generateInsightInputs(accounts);

  console.log(`[night-task] 夜间任务完成`);
}

/**
 * 生成素材洞察报告的"输入数据"（候选集 + 基础统计），存到 agent-memory/reports/
 *
 * 注意：本函数只负责规则筛选和聚合，**不调用 LLM**。
 * 最终的洞察归纳、命名规律分析、素材建议，由 WorkBud Agent 在巡检时
 * 读取本文件后通过其 SDK 调 LLM 完成。
 *
 * 输出文件结构：
 *   {
 *     ...
 *     llm_insight: null,  // 预留字段，由 AI Agent 填充
 *     llm_insight_inputs: { ... 本函数生成的所有统计 ... }
 *   }
 */
function generateInsightInputs(accounts) {
  const { getDB } = require('./db');
  try {
    const db = getDB();
    for (const acc of accounts) {
      const materials = db.prepare(`
        SELECT
          material_id,
          MAX(material_name) AS material_name,
          MAX(duration) AS duration,
          MAX(created_at) AS created_at,
          MAX(status) AS status,
          ROUND(SUM(cost), 1) AS cost,
          ROUND(SUM(gmv), 1) AS gmv,
          SUM(orders) AS orders,
          MIN(stat_date) AS first_date,
          MAX(stat_date) AS last_date,
          CASE WHEN SUM(cost) > 0 THEN ROUND(SUM(gmv) / SUM(cost), 2) ELSE 0 END AS roi
        FROM material_daily
        WHERE account_id = ? AND material_id != '__EMPTY__'
        GROUP BY material_id
        HAVING cost > 0
        ORDER BY cost DESC
      `).all(acc.id);

      if (materials.length === 0) continue;

      const reportDate = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

      // === 0. 从数据库反推该账号的真实阈值（数据驱动） ===
      const thresholds = deriveThresholds(db, acc.id);
      const t = thresholds; // 简写

      // === 1. 给每个素材算 age_days + 最近7天 ROI 序列 + 生命周期阶段 ===
      const enriched = materials.map(m => {
        const ageDays = m.created_at && m.created_at !== '-'
          ? Math.round((new Date(m.last_date) - new Date(m.created_at)) / 86400000)
          : 0;

        // 拉最近 7 天每日 ROI（cost>0 的天）
        const dailyRows = db.prepare(`
          SELECT stat_date, cost, gmv, CASE WHEN cost>0 THEN gmv/cost ELSE 0 END as roi
          FROM material_daily
          WHERE account_id=? AND material_id=? AND cost>0
          ORDER BY stat_date DESC LIMIT 7
        `).all(acc.id, m.material_id).reverse();

        const dailyRoi = dailyRows.map(d => Math.round(d.roi * 100) / 100);
        const last7AvgRoi = dailyRoi.length > 0
          ? Math.round(dailyRoi.reduce((s, r) => s + r, 0) / dailyRoi.length * 100) / 100
          : 0;

        // 生命周期阶段（阈值全部来自 t）
        // - 新生期：age <= lifespanNew
        // - 死亡期：近 3 天 ROI 全 < breakEvenRoi 的 50%（只针对在投素材）
        // - 衰退期：近 decayWindow 天连续下滑，且末值 < 始值的 70%
        // - 稳定期：其他
        let stage = '稳定期';
        const isActive = m.status !== '已删除';
        if (ageDays <= t.lifespanNew) stage = '新生期';
        else if (dailyRoi.length >= t.decayWindow) {
          const recent = dailyRoi.slice(-t.decayWindow);
          const isDeclining = recent.every((r, i) => i === 0 || r <= recent[i - 1]);
          const isLow = recent.every(r => r < t.severityHigh); // ROI < 保本 50%
          if (isLow && isActive) stage = '死亡期';
          else if (isDeclining && recent[recent.length - 1] < recent[0] * 0.7) stage = '衰退期';
        }

        return {
          id: m.material_id,
          name: m.material_name,
          duration: m.duration,
          created_at: m.created_at,
          age_days: ageDays,
          cost: Math.round(m.cost),
          gmv: Math.round(m.gmv),
          roi: m.roi,
          orders: m.orders,
          status: m.status,
          daily_roi_7d: dailyRoi,
          last7_avg_roi: last7AvgRoi,
          stage,
        };
      });

      // === 2. 衰退信号：更丰富的分类（阈值来自 t） ===
      const decay = enriched.filter(m => {
        if (m.daily_roi_7d.length < t.decayWindow) return false;
        const early = m.daily_roi_7d.slice(0, Math.floor(m.daily_roi_7d.length / 2));
        const late = m.daily_roi_7d.slice(Math.floor(m.daily_roi_7d.length / 2));
        const avgEarly = early.reduce((s, r) => s + r, 0) / early.length;
        const avgLate = late.reduce((s, r) => s + r, 0) / late.length;
        // 衰退判定：后期 ROI < 前期的 60%（使用 CLASSIFICATION.decayRoiRatio 兜底）
        return avgEarly > 0 && avgLate < avgEarly * (CLASSIFICATION.decayRoiRatio || 0.6);
      }).map(m => {
        const early = m.daily_roi_7d.slice(0, Math.floor(m.daily_roi_7d.length / 2));
        const late = m.daily_roi_7d.slice(Math.floor(m.daily_roi_7d.length / 2));
        const avgEarly = early.reduce((s, r) => s + r, 0) / early.length;
        const avgLate = late.reduce((s, r) => s + r, 0) / late.length;

        // 衰退类型分类（"早期 > 保本线"作为"曾经健康"的判据）
        let decayType = '缓慢衰减';
        const last3 = m.daily_roi_7d.slice(-3);
        if (last3.every(r => r === 0) && early.some(r => r > t.breakEvenRoi)) decayType = '突然死亡';
        else if (Math.abs(avgEarly - avgLate) / Math.max(avgEarly, 0.01) > 0.8) decayType = '断崖式下跌';
        else if (m.daily_roi_7d.some((r, i) => i > 0 && r > m.daily_roi_7d[i - 1] * 1.5)) decayType = '波动型';

        // 严重度（基于保本线比例，非硬编码 0.5/1.0/1.5）
        let severity = 'low';
        if (avgLate < t.severityCritical) severity = 'critical';
        else if (avgLate < t.severityHigh) severity = 'high';
        else if (avgLate < t.severityMedium) severity = 'medium';

        return {
          id: m.id,
          name: m.name,
          duration: m.duration,
          age_days: m.age_days,
          roi_early: Math.round(avgEarly * 100) / 100,
          roi_late: Math.round(avgLate * 100) / 100,
          decline_pct: Math.round((1 - avgLate / avgEarly) * 100),
          decay_type: decayType,
          severity,
          daily_roi_7d: m.daily_roi_7d,
          cost: m.cost,
        };
      }).sort((a, b) => {
        const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return sevOrder[a.severity] - sevOrder[b.severity] || b.decline_pct - a.decline_pct;
      });

      // === 3. 命名规律聚类 ===
      const namingClusters = analyzeNamingPatterns(enriched);

      // === 4. 效率榜（阈值全部基于 t 的保本线比例） ===
      // 新秀：新生期内 ROI >= 保本 75% 的小素材
      const rising = enriched.filter(m => m.age_days <= t.lifespanNew && m.roi >= t.risingMinRoi && m.cost < 3000)
        .sort((a, b) => b.roi - a.roi).slice(0, 5);
      // 摇钱树：稳定期+ ROI >= 保本 90% 的主力素材
      const cashCows = enriched.filter(m => m.age_days > t.lifespanStable && m.roi >= t.cashCowMinRoi && m.cost >= 2000)
        .sort((a, b) => b.cost - a.cost).slice(0, 5);
      // 鸡肋：消耗>=2000 但 ROI 在保本 50%~75%（亏损但舍不得停）
      const chickens = enriched.filter(m => m.cost >= 2000 && m.roi >= t.chickenRoiMin && m.roi < t.chickenRoiMax)
        .sort((a, b) => b.cost - a.cost).slice(0, 5);

      // === 5. 时长分桶（边界来自 t.durationShortMax / durationMidMax）/ 年龄分桶（边界来自 t） ===
      const shortLabel = `短视频(<${t.durationShortMax}s)`;
      const midLabel = `中视频(${t.durationShortMax}-${t.durationMidMax}s)`;
      const longLabel = `长视频(>${t.durationMidMax}s)`;
      const bands = { [shortLabel]: { count: 0, cost: 0, gmv: 0 }, [midLabel]: { count: 0, cost: 0, gmv: 0 }, [longLabel]: { count: 0, cost: 0, gmv: 0 } };
      for (const m of enriched) {
        if (m.duration === '-' || !m.duration) continue;
        const parts = m.duration.split(':');
        const sec = parseInt(parts[1]) + parseInt(parts[0]) * 60;
        let band;
        if (sec < t.durationShortMax) band = bands[shortLabel];
        else if (sec <= t.durationMidMax) band = bands[midLabel];
        else band = bands[longLabel];
        band.count++;
        band.cost += m.cost;
        band.gmv += m.gmv;
      }
      // 年龄分桶用真实寿命分位数
      const ageNewLabel = `0-${t.lifespanNew}天`;
      const ageStableLabel = `${t.lifespanNew + 1}-${t.lifespanStable}天`;
      const ageDeclineLabel = `${t.lifespanStable + 1}-${t.lifespanDecline}天`;
      const ageOldLabel = `${t.lifespanDecline}天+`;
      const ageBuckets = { [ageNewLabel]: [], [ageStableLabel]: [], [ageDeclineLabel]: [], [ageOldLabel]: [] };
      for (const m of enriched) {
        if (m.age_days <= t.lifespanNew) ageBuckets[ageNewLabel].push(m);
        else if (m.age_days <= t.lifespanStable) ageBuckets[ageStableLabel].push(m);
        else if (m.age_days <= t.lifespanDecline) ageBuckets[ageDeclineLabel].push(m);
        else ageBuckets[ageOldLabel].push(m);
      }
      // 阶段分布
      const stageDist = { '新生期': 0, '稳定期': 0, '衰退期': 0, '死亡期': 0 };
      for (const m of enriched) { stageDist[m.stage] = (stageDist[m.stage] || 0) + 1; }

      const report = {
        date: reportDate,
        account_id: acc.id,
        account_name: acc.name,
        generated_at: new Date().toISOString(),
        generated_by: 'night_task',
        total_materials: enriched.length,
        // === 兼容旧前端的字段（保留） ===
        duration_bands: Object.entries(bands).map(([label, d]) => ({ label, count: d.count, cost: Math.round(d.cost), roi: d.cost > 0 ? Math.round((d.gmv / d.cost) * 100) / 100 : 0 })),
        age_distribution: Object.entries(ageBuckets).map(([label, items]) => ({
          label,
          count: items.length,
          avg_cost: items.length > 0 ? Math.round(items.reduce((s, m) => s + m.cost, 0) / items.length) : 0,
          avg_roi: items.length > 0 && items.reduce((s, m) => s + m.cost, 0) > 0
            ? Math.round((items.reduce((s, m) => s + m.gmv, 0) / items.reduce((s, m) => s + m.cost, 0)) * 100) / 100
            : 0,
        })),
        decay_signals: decay.map(d => ({
          id: d.id, name: d.name,
          roi_early: d.roi_early, roi_late: d.roi_late,
          decline: d.decline_pct + '%',
        })),
        top_materials: enriched.slice(0, 15).map(m => ({
          id: m.id, name: m.name, duration: m.duration,
          age_days: m.age_days, cost: m.cost, roi: m.roi, orders: m.orders,
        })),
        // === LLM 洞察预留位 ===
        llm_insight: null,
        llm_insight_inputs: {
          total_materials: enriched.length,
          decay_count: decay.length,
          // 0. 阈值依据（AI 可以判断阈值是否合理）
          thresholds_used: t,
          // 1. 衰退素材（含分类 + 7天趋势 + 严重度，按严重度排序）
          decay_materials: decay,
          // 2. 命名规律聚类（关键信号源）
          naming_clusters: namingClusters,
          // 3. 效率榜
          rising_stars: rising.map(m => ({ id: m.id, name: m.name, age_days: m.age_days, cost: m.cost, roi: m.roi, daily_roi_7d: m.daily_roi_7d })),
          cash_cows: cashCows.map(m => ({ id: m.id, name: m.name, age_days: m.age_days, cost: m.cost, roi: m.roi, daily_roi_7d: m.daily_roi_7d })),
          chicken_ribs: chickens.map(m => ({ id: m.id, name: m.name, age_days: m.age_days, cost: m.cost, roi: m.roi, daily_roi_7d: m.daily_roi_7d })),
          // 4. 生命周期阶段分布
          stage_distribution: stageDist,
          // 5. TOP 素材（含7天趋势）
          top_materials: enriched.slice(0, 15).map(m => ({
            id: m.id, name: m.name, duration: m.duration,
            age_days: m.age_days, cost: m.cost, roi: m.roi,
            stage: m.stage, daily_roi_7d: m.daily_roi_7d,
          })),
          // 6. prompt 提示词（AI 直接用）
          prompt_hint: `请基于以上数据输出 JSON：
{
  "summary": "1-2句总结当日素材健康度",
  "decay_attribution": [{"reason":"衰退共性原因","evidence":["素材名/数据"],"affected_ids":[]}],
  "winning_patterns": [{"pattern":"成功模式","example_ids":[],"roi_avg":0}],
  "recommendations": [{"action":"stop_boost|add_boost|replace|keep","material_id":"","reason":"","expected_effect":""}],
  "risk_alerts": [{"material_id":"","risk":"","urgency":"high|medium|low"}]
}`,
        },
      };

      const fileName = `insights_${acc.id}_${report.date}.json`;
      fs.writeFileSync(path.join(REPORTS_DIR, fileName), JSON.stringify(report, null, 2), 'utf8');
      console.log(`[night-task] 素材洞察已生成: ${fileName}（${enriched.length}个素材，${decay.length}个衰退信号，${namingClusters.length}个命名聚类）`);
    }
  } catch (e) {
    console.error('[night-task] 素材洞察生成失败:', e.message);
  }
}

/**
 * 从数据库反推该账号的真实阈值（数据驱动，不再硬编码）
 *
 * 基于 180 天历史数据计算：
 * - breakEvenRoi：保本 ROI（来自 config，默认 2.0）
 * - healthyRoi：健康 ROI = 该账号 ROI 分布的 P75（前 25% 才算健康）
 * - lifespanNew：新生期天数 = 该账号素材寿命分布的 P25（短寿素材的典型寿命）
 * - lifespanStable：稳定期天数 = 寿命 P50（中位寿命）
 * - lifespanDecline：衰退期开始 = 寿命 P75
 * - durationShortMax：短视频上限 = 时长分布的 P33
 * - durationMidMax：中视频上限 = 时长分布的 P66
 * - peakDay：ROI 峰值出现的天数（从首投算）
 * - decayWindow：衰退判定窗口（峰值到腰斩的天数 + 1，最小 3）
 */
function deriveThresholds(db, accountId) {
  const breakEvenRoi = (manual_config && manual_config.break_even_roi) || 2.0;

  // 1. ROI 分布（按素材聚合，只看消耗>100 的）
  const roiRows = db.prepare(`
    SELECT CASE WHEN SUM(cost)>0 THEN SUM(gmv)/SUM(cost) ELSE 0 END AS roi
    FROM material_daily
    WHERE account_id=? AND cost>0
    GROUP BY material_id
    HAVING SUM(cost) > 100
    ORDER BY roi
  `).all(accountId);
  const rois = roiRows.map(r => r.roi);
  const roiPct = p => rois.length > 0 ? rois[Math.floor(rois.length * p)] : breakEvenRoi;
  const healthyRoi = Math.max(roiPct(0.75), breakEvenRoi * 0.9); // 至少不低于保本线的 90%

  // 2. 素材寿命分布
  const lifespanRows = db.prepare(`
    SELECT material_id, MIN(stat_date) first_date, MAX(stat_date) last_date
    FROM material_daily WHERE account_id=? AND cost>0
    GROUP BY material_id HAVING MAX(stat_date) > MIN(stat_date)
  `).all(accountId);
  const lifespans = lifespanRows.map(m => Math.round((new Date(m.last_date) - new Date(m.first_date)) / 86400000)).filter(d => d > 0).sort((a, b) => a - b);
  const lifePct = p => lifespans.length > 0 ? lifespans[Math.floor(lifespans.length * p)] : 30;
  const lifespanNew = Math.max(3, lifePct(0.25));
  const lifespanStable = Math.max(lifespanNew + 1, lifePct(0.5));
  const lifespanDecline = Math.max(lifespanStable + 1, lifePct(0.75));

  // 3. 时长分布 → 自然分界点
  const durRows = db.prepare(`
    SELECT duration, COUNT(DISTINCT material_id) c
    FROM material_daily WHERE account_id=? AND cost>0 AND duration IS NOT NULL AND duration!='-'
    GROUP BY duration
  `).all(accountId);
  const durCounts = [];
  for (const r of durRows) {
    if (!r.duration || r.duration === '-') continue;
    const parts = r.duration.split(':');
    const sec = parseInt(parts[1]) + parseInt(parts[0]) * 60;
    if (!isNaN(sec)) durCounts.push({ sec, count: r.c });
  }
  durCounts.sort((a, b) => a.sec - b.sec);
  const totalDur = durCounts.reduce((s, d) => s + d.count, 0);
  let acc = 0;
  let durationShortMax = 15, durationMidMax = 30;
  for (const d of durCounts) {
    acc += d.count;
    const pct = acc / totalDur;
    if (pct >= 0.33 && durationShortMax === 15) durationShortMax = d.sec;
    if (pct >= 0.66 && durationMidMax === 30) { durationMidMax = d.sec; break; }
  }

  // 4. ROI 峰值天数 + 衰退窗口
  //    从每个素材的每日数据找峰值，算峰值到腰斩的天数
  const allDaily = db.prepare(`
    SELECT material_id, stat_date, cost, gmv, CASE WHEN cost>0 THEN gmv/cost ELSE 0 END roi
    FROM material_daily WHERE account_id=? AND cost>0 ORDER BY material_id, stat_date
  `).all(accountId);
  const byMat = {};
  for (const r of allDaily) {
    if (!byMat[r.material_id]) byMat[r.material_id] = [];
    byMat[r.material_id].push(r);
  }
  let peakSum = 0, dropSum = 0, validN = 0;
  for (const days of Object.values(byMat)) {
    if (days.length < 5) continue;
    let maxRoi = 0, maxIdx = 0;
    days.forEach((d, i) => { if (d.roi > maxRoi) { maxRoi = d.roi; maxIdx = i; } });
    const dropIdx = days.findIndex((d, i) => i > maxIdx && d.roi < maxRoi * 0.5);
    if (dropIdx > 0) {
      peakSum += maxIdx;
      dropSum += (dropIdx - maxIdx);
      validN++;
    }
  }
  const peakDay = validN > 0 ? Math.round(peakSum / validN) : 7;
  const decayWindow = validN > 0 ? Math.max(3, Math.round(dropSum / validN) + 1) : 3;

  return {
    breakEvenRoi,
    healthyRoi: Math.round(healthyRoi * 100) / 100,
    lifespanNew,
    lifespanStable,
    lifespanDecline,
    durationShortMax,
    durationMidMax,
    peakDay,
    decayWindow,
    // 严重度档位：基于保本线的比例
    severityCritical: breakEvenRoi * 0.25,  // ROI < 保本 25% = 纯亏
    severityHigh: breakEvenRoi * 0.5,       // ROI < 保本 50% = 严重亏损
    severityMedium: breakEvenRoi * 0.75,    // ROI < 保本 75% = 亏损
    // 效率榜阈值（基于保本线推导）
    risingMinRoi: breakEvenRoi * 0.75,      // 新秀最低 ROI = 保本 75%
    cashCowMinRoi: breakEvenRoi * 0.9,      // 摇钱树最低 ROI = 保本 90%
    chickenRoiMax: breakEvenRoi * 0.75,     // 鸡肋最高 ROI = 保本 75%
    chickenRoiMin: breakEvenRoi * 0.5,      // 鸡肋最低 ROI = 保本 50%
    // 数据样本量
    sampleRoiCount: rois.length,
    sampleLifespanCount: lifespans.length,
    samplePeakCount: validN,
  };
}

/**
 * 命名规律聚类：从素材名提取关键词，识别系列/类型
 * 例如："6-13内行人精编-V2.mp4" → 类型=内行人系列, 版本=V2
 */
function analyzeNamingPatterns(materials) {
  const patterns = {};

  for (const m of materials) {
    const name = m.name || '';
    if (!name || name === '-') {
      addToCluster(patterns, '未命名', m);
      continue;
    }

    // 识别系列关键词
    let series = null;
    if (/内行人/.test(name)) series = '内行人系列';
    else if (/差评/.test(name)) series = '差评系列';
    else if (/混剪|精编/.test(name)) series = '混剪/精编';
    else if (/小姐姐|大哥|阿姨|叔叔|奶奶|爷爷/.test(name)) series = '人物口播';
    else if (/吃|好吃|满足|大口|馋/.test(name)) series = '吃播展示';
    else if (/客户|反馈|夸|好评/.test(name)) series = '客户反馈';
    else if (/工厂|制作|生产|过程/.test(name)) series = '工厂纪实';
    else if (/露营|户外|野餐/.test(name)) series = '场景植入';
    else if (/\d{1,2}月\d{1,2}日|^\d+\.\d+/.test(name)) series = '日期命名';
    else series = '其他';

    addToCluster(patterns, series, m);

    // 识别版本标记（V1/V2/v1/v2）
    const vMatch = name.match(/V(\d+)/i);
    if (vMatch) {
      addToCluster(patterns, `版本V${vMatch[1]}`, m);
    }
  }

  // 聚合每个聚类的统计
  return Object.entries(patterns).map(([pattern, items]) => {
    const totalCost = items.reduce((s, m) => s + m.cost, 0);
    const totalGmv = items.reduce((s, m) => s + m.gmv, 0);
    const decayCount = items.filter(m => m.stage === '衰退期' || m.stage === '死亡期').length;
    return {
      pattern,
      count: items.length,
      total_cost: Math.round(totalCost),
      avg_roi: totalCost > 0 ? Math.round((totalGmv / totalCost) * 100) / 100 : 0,
      decay_count: decayCount,
      sample_names: items.slice(0, 3).map(m => m.name),
      material_ids: items.map(m => m.id),
    };
  }).sort((a, b) => b.total_cost - a.total_cost);
}

function addToCluster(patterns, key, material) {
  if (!patterns[key]) patterns[key] = [];
  patterns[key].push(material);
}

// ═══════════════════════════════════════════════════════════
// MHS 公式健康周报（§七-7，口径 §六-2）
// ═══════════════════════════════════════════════════════════

// 退役的 MHS 周报与动作胜率实现不再保留在生产调度模块。
module.exports = { runNightTasks, backupDatabase, generateInsightInputs };
