/**
  * 历史账户专用说明已从试用包移除。
 *
 * 四规矩：
  * 历史账户专用说明已从试用包移除。
 *    追投 15 分钟烧不出 30 元，等得起；动作只有一个出口，人机不抢方向盘（7-29 上海小姐姐事件）。
  * 历史账户专用说明已从试用包移除。
 *    判定：op-log 最新写操作来源 ≠ agent（投手经我方网页/接口）→ 从该操作时刻保护 1h；
 *    op-log 无记录（千川官方后台人工操作）→ 从本服务首次见它运行起保护 1h。
 * ③ op-log 全留痕：每条建议/告警写 operation_log（谁触发/动作/数值依据/时间，审计不断链）。
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *    保本线全系统唯一口径（净成交），显示/判断只有这一个数，界面再出现 2.36/2.82 即 bug。
 *    净口径延迟（netRoi=0 但 payRoi>0，净成交 1h 结算字段未产出）不判定，evidence 标注"净口径延迟中"、
 *    附支付口径仅供参考——不得单用支付口径下判定；evidence 必带 net_roi 供哨兵/盯盘轮复核。
 *    退款率独立监控：1h 退款率>15% 单独告警（流量质量信号，不混进投产比判断），同 task+rule 当日只告警一次。
 *    退款率字段口径=百分数（千川 rate 字段返回 0-100，如 9.98=9.98%，与前端 15/25 阈值同尺）——
 *    2026-07-30 三次误报根因：judgeRefund 曾把百分数当小数（9.98>0.15 误触发且显示 998%）。
 */

const fs = require('fs');
const path = require('path');
const { fetchBoostTaskReport } = require('./qianchuanTabs');
const { getCachedAvgOrderPrice } = require('./doudian');
const { manual_config } = require('./config');
const pendingOps = require('./pendingOps');
const opLog = require('./operationLog');
const { writeJsonAtomic } = require('./api-helpers');

const PROTECT_MS = 60 * 60 * 1000;        // 人工保护期 1h
const RESUGGEST_MS = 30 * 60 * 1000;      // 同任务建议冷却（防刷屏；pending 中另判重）
const REFUND_ALERT_LINE = 15;             // 退款率告警线 15%（百分数口径，与千川 rate 字段 0-100 同尺）
const RUNNING_STORE = process.env.BOOST_GUARD_STORE || path.join(__dirname, '..', '..', 'cache', 'boost_running_since.json');
const SUGGEST_STORE = path.join(__dirname, '..', '..', 'cache', 'boost_suggest_memory.json');

// 建议冷却持久化：进程重启后仍遵守 30 分钟冷却，避免服务重启瞬间对同一任务重复建建议
function readSuggestStore() {
  try {
    const data = JSON.parse(fs.readFileSync(SUGGEST_STORE, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch { /* 空库 */ }
  return {};
}
function writeSuggestStore(data) {
  try {
    fs.mkdirSync(path.dirname(SUGGEST_STORE), { recursive: true });
    writeJsonAtomic(SUGGEST_STORE, data);
  } catch (e) { console.error('[boostGuard] 建议冷却写盘失败:', e.message); }
}
function pruneSuggestStore(now) {
  const data = readSuggestStore();
  const cutoff = now - RESUGGEST_MS * 2; // 保留最近 1 小时（超过冷却期 2 倍即可清理）
  let changed = false;
  for (const k of Object.keys(data)) {
    if ((data[k] || 0) < cutoff) { delete data[k]; changed = true; }
  }
  if (changed) writeSuggestStore(data);
  return data;
}

const _suggestMemory = new Map(Object.entries(pruneSuggestStore(Date.now()))); // assistAid -> ts

function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(RUNNING_STORE, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch { /* 空库 */ }
  return {};
}
function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(RUNNING_STORE), { recursive: true });
    writeJsonAtomic(RUNNING_STORE, data);
  } catch (e) { console.error('[boostGuard] 运行记录写盘失败:', e.message); }
}

/**
  * 历史账户专用说明已从试用包移除。
 * @param {object} t - 追投任务（cost/netRoi/payRoi/orderCount/refundRate1h）
 * @param {object} ctx - { avgPrice, breakEven }（breakEven=该账号净保本线）
 * @returns {{verdict:'suggest_pause'|'pass', reason?, evidence?}}
 */
function judgeTask(t, ctx) {
  const cost = +(t.cost || 0), netRoi = +(t.netRoi || 0), payRoi = +(t.payRoi || 0), orders = +(t.orderCount || 0);
  const checkCostLimit = +(ctx.avgPrice * 0.6).toFixed(2);
  const exploreLine = +ctx.avgPrice.toFixed(2);
  if (cost >= checkCostLimit && netRoi > 0 && netRoi <= ctx.breakEven) {
    return {
      verdict: 'suggest_pause',
      reason: `贴线止损建议：消耗 ${cost.toFixed(2)} 元（过探量线 ${checkCostLimit} 元），净ROI ${netRoi.toFixed(2)} ≤ 保本线 ${ctx.breakEven}，建议暂停`,
      evidence: { cost, net_roi: netRoi, pay_roi: payRoi, check_cost_limit: checkCostLimit, break_even: ctx.breakEven, rule: '贴线' },
    };
  }
  if (cost >= checkCostLimit && netRoi <= 0 && payRoi > 0) {
    // 净口径延迟：净成交为 1h 结算字段，开播初期/结算滞后时 netRoi=0 但已有支付成交——
    // 不得单用支付口径下判定，放行并标注（附支付口径仅供哨兵/盯盘轮参考）
    return { verdict: 'pass', evidence: { cost, net_roi: 0, pay_roi: payRoi, net_pending: true, note: '净口径延迟中，支付ROI仅供参考不判定' } };
  }
  if (cost >= exploreLine && orders === 0) {
    return {
      verdict: 'suggest_pause',
      reason: `空耗止损建议：消耗 ${cost.toFixed(2)} 元 0 成交（过探索线 ${exploreLine} 元），建议暂停`,
      evidence: { cost, explore_line: exploreLine, orders, rule: '空耗' },
    };
  }
  return { verdict: 'pass' };
}

/**
 * 已暂停追投恢复判定（纯函数，可单测）
 * 恢复逻辑：直播间大盘好（shopNetRoi >= breakEven），且追投任务全场累计净 ROI >= 2.20（或恢复阈值）
 */
function judgeResumeTask(t, ctx) {
  const cost = +(t.cost || 0), netRoi = +(t.netRoi || 0);
  const shopNetRoi = +(ctx.shopNetRoi || 0);
  const isPaused = t.status === '已暂停' || t.status === 'manual_paused' || t.status === 'system_paused';
  if (!isPaused) return { verdict: 'pass' };

  const resumeRoiLine = +(ctx.breakEven * 0.88).toFixed(2);  // 历史账户专用说明已从试用包移除。
  if (shopNetRoi >= ctx.breakEven && cost >= (ctx.avgPrice * 0.5) && netRoi >= resumeRoiLine) {
    return {
      verdict: 'suggest_resume',
      reason: `复苏恢复建议：大盘净ROI ${shopNetRoi.toFixed(2)} 达标，追投净ROI ${netRoi.toFixed(2)} ≥ 恢复线 ${resumeRoiLine}，建议恢复投放`,
      evidence: { cost, net_roi: netRoi, shop_net_roi: shopNetRoi, resume_line: resumeRoiLine, rule: '大盘回暖复苏' },
    };
  }
  return { verdict: 'pass' };
}

/**
 * 下播追投清算判定（纯函数，可单测）
 * 归档逻辑：下播后清算死血追投释放配额，保留优质遗产追投
 */
function judgePostLiveTask(t, ctx) {
  const cost = +(t.cost || 0), netRoi = +(t.netRoi || 0), orders = +(t.orderCount || 0);
  const exploreLine = +ctx.avgPrice.toFixed(2);
  const deathRoiLine = +(ctx.breakEven * 0.72).toFixed(2);  // 历史账户专用说明已从试用包移除。
  const legacyRoiLine = +(ctx.breakEven * 0.92).toFixed(2); // 遗产线：如 2.30

  // 死刑清算条件：消耗>=50且ROI<1.80 或 空耗过探索线
  if ((cost >= 50 && netRoi > 0 && netRoi < deathRoiLine) || (cost >= exploreLine && orders === 0)) {
    return {
      verdict: 'suggest_delete',
      reason: `下播死刑清算建议：消耗 ${cost.toFixed(2)} 元，净ROI ${netRoi.toFixed(2)} < 死刑线 ${deathRoiLine}，建议彻底删除释放配额`,
      evidence: { cost, net_roi: netRoi, death_line: deathRoiLine, orders, rule: '下播死刑清算' },
    };
  }

  // 优质遗产保留
  if (netRoi >= legacyRoiLine && t.budget > cost) {
    return {
      verdict: 'keep_legacy',
      reason: `优质遗产保留：净ROI ${netRoi.toFixed(2)} ≥ 遗产线 ${legacyRoiLine}，保留给下场开播复用`,
      evidence: { cost, net_roi: netRoi, legacy_line: legacyRoiLine, rule: '下播遗产保留' },
    };
  }

  return { verdict: 'pass' };
}

/** 退款率独立告警（纯函数）：>15% 返回告警文案。refundRate1h 为百分数口径（9.98=9.98%），判定与显示同尺 */
function judgeRefund(t) {
  const r = +(t.refundRate1h || 0);
  if (r > REFUND_ALERT_LINE) {
    return {
      alert: true,
      reason: `退款率告警：追投「${t.name || t.assistAid}」1h 退款率 ${r.toFixed(1)}% > ${REFUND_ALERT_LINE}%，流量质量信号（不混投产比判断）`,
      evidence: { refund_rate_1h: r, line: REFUND_ALERT_LINE },
    };
  }
  return { alert: false };
}

/**
 * 人工 1h 保护期判定。
 * @param {object} t - 任务（assistAid）
 * @param {string} accountId
 * @param {object} runningStore - { assistAid: { first_seen, account } }
 * @param {number} now
 * @param {function} [queryLog] - 测试注入，默认 opLog.query
 */
// 保护期归因只认"真实写动作"（创建/暂停/恢复/改预算ROI/删除）；
// 护栏自己的建议/告警日志（boost_stoploss_suggest/boost_refund_alert，source=agent）必须排除——
// 历史账户专用说明已从试用包移除。
const GUARD_LOG_ACTIONS = new Set(['boost_stoploss_suggest', 'boost_refund_alert']);
function protectionFor(t, accountId, runningStore, now, queryLog) {
  const query = queryLog || (opts => opLog.query(opts));
  let latest = null;
  try {
    // 保护期跨午夜：查询窗口覆盖最近 1 小时，避免 23:30 人工恢复的任务在 00:15 被漏掉
    const startDate = localDateStr(new Date(now - PROTECT_MS));
    const endDate = localDateStr(new Date(now));
    const logs = query({ accountId, startDate, endDate, limit: 200 }) || [];
    // query 按 ts DESC，过滤出该任务的成功写动作（排除护栏自身日志），第一条即最新
    latest = logs.find(l => String(l.assist_task_id || '') === String(t.assistAid) && l.success && !GUARD_LOG_ACTIONS.has(l.action)) || null;
  } catch { /* op-log 不可用时按无记录处理（走首见保护，不误伤人工） */ }
  if (latest) {
    const ts = new Date(String(latest.ts).replace(' ', 'T')).getTime();
    if (latest.source !== 'agent' && Number.isFinite(ts) && (now - ts) < PROTECT_MS) {
      return { protected: true, source: 'manual-oplog', until: new Date(ts + PROTECT_MS).toISOString(), ref: latest.action };
    }
    return { protected: false, source: latest.source === 'agent' ? 'agent' : 'manual-expired' };
  }
  const rec = runningStore[t.assistAid];
  if (rec && (now - rec.first_seen) < PROTECT_MS) {
    return { protected: true, source: 'manual-external', until: new Date(rec.first_seen + PROTECT_MS).toISOString() };
  }
  return { protected: false, source: rec ? 'external-expired' : 'seen-before' };
}

/**
 * 主流程：巡检追投任务，亏损→推暂停建议（不直接动刀），退款率高→告警留痕。
 * 由 liveCollector 每拍调用（原 autoEnforceBoostStopLoss 的建议制替代）。
 */
async function checkBoostStopLoss(accountId, accountName) {
  const today = localDateStr();
  const now = Date.now();
  const breakEven = require('./api-helpers').getAccountParams(accountId).break_even_roi;
  let avgPrice = (manual_config && manual_config.avg_order_price) || 0;
  if (!avgPrice) {
    const avg = await getCachedAvgOrderPrice(accountId).catch(() => null);
    avgPrice = (avg && avg.avg_order_price) || 79.5;
  }

  const bRes = await fetchBoostTaskReport(today, today, accountId);
  const tasks = ((bRes && bRes.tasks) || []).filter(t => t.isRunning && t.assistAid);

  // 首见运行追踪：新出现的 running 记录首次时间；不再 running 的清掉
  const store = readStore();
  const runningIds = new Set(tasks.map(t => String(t.assistAid)));
  let storeChanged = false;
  for (const t of tasks) {
    if (!store[t.assistAid]) { store[t.assistAid] = { first_seen: now, account: accountId }; storeChanged = true; }
  }
  for (const k of Object.keys(store)) {
    if (!runningIds.has(String(k))) { delete store[k]; storeChanged = true; }
  }
  if (storeChanged) writeStore(store);

  const pendings = pendingOps.list({ account: accountId, status: 'pending' });

  // 历史账户专用说明已从试用包移除。
  const refundAlerted = new Set();
  try {
    const todayAlerts = opLog.query({ accountId, action: 'boost_refund_alert', startDate: today, endDate: today, limit: 500 }) || [];
    for (const l of todayAlerts) refundAlerted.add(String(l.assist_task_id || ''));
  } catch { /* op-log 不可用时按未告警处理（留痕优先，宁可多记） */ }

  for (const t of tasks) {
    // ② 人工保护期：直接跳过（不建议不动作，日志留痕一次）
    const prot = protectionFor(t, accountId, store, now);
    if (prot.protected) {
      console.log(`[boostGuard] ${accountName} 任务 ${t.assistAid} 人工保护期（${prot.source}，至 ${prot.until}），护栏跳过`);
      continue;
    }

    // ④ 退款率独立告警（不建议暂停，只留痕）
    const rf = judgeRefund(t);
    if (rf.alert) {
      opLog.log({ action: 'boost_refund_alert', account_id: accountId, assist_task_id: t.assistAid,
        params: rf.evidence, result_msg: rf.reason, source: 'agent' });
      console.warn(`[boostGuard] ${accountName} ${rf.reason}`);
    }

    // ① 止损判定 → 建议制
    const v = judgeTask(t, { avgPrice, breakEven });
    if (v.verdict !== 'suggest_pause') continue;

    // 判重：同任务已有 pending 建议，或 30 分钟内已建议过
    const dup = pendings.some(p => p.type === 'pause_boost' && String(p.params && p.params.assistTaskId) === String(t.assistAid));
    if (dup) continue;
    const lastAt = _suggestMemory.get(t.assistAid) || 0;
    if (now - lastAt < RESUGGEST_MS) continue;

    const reason = `【护栏建议暂停】追投「${t.name || t.assistAid}」${v.reason}（动作收归Agent盯盘轮，服务端不直接暂停）`;
    try {
      pendingOps.create({
        account: accountId,
        type: 'pause_boost',
        params: { accountId, assistTaskId: String(t.assistAid) },
        reason,
        source: 'server_guard',
      });
      _suggestMemory.set(t.assistAid, now);
      writeSuggestStore(Object.fromEntries(_suggestMemory));
      // ③ op-log 留痕
      opLog.log({ action: 'boost_stoploss_suggest', account_id: accountId, assist_task_id: t.assistAid,
        params: v.evidence, result_msg: reason, source: 'agent' });
      console.log(`[boostGuard] ${accountName} ${reason}`);
    } catch (e) {
      console.error(`[boostGuard] ${accountName} 建议创建失败: ${e.message}`);
    }
  }
}

/* ===== 素材出血闸（2026-07-31 Agent框架·维护者拍板）：主计划通道出血素材发现层 =====
 * 背景：清理劣质是四目标唯一的烂尾——追投任务级止损精装修，但挂在主计划创编里天天流血的素材没人盯
 * （7-31 案例：7月3日稻草 roi 1.20 烧 192、4月23日口播 1.89 烧 273，追投层止损再好人身在大池子外）。
 * 机制（与追投止损闸同款：建议制+op-log留痕+不抢方向盘）：
 *   当日出血观察：当日耗≥50 且 1h净ROI < 保本×0.70 → info（快照进 dashboard suggestions，观察名单不动作）
 *   持续出血候选：近7天耗≥300 且 7天净ROI < 保本×0.85 → warning（快照进 suggestions，盯盘轮复核全周期ROI后走删除通道）
  * 历史账户专用说明已从试用包移除。
 *   豁免（服务端预判写进 evidence）：新素材上传≤3天探索期 / 跑量担当（店铺整体净ROI≥保本时豁免，破线失效）
 * 产出：op-log（material_bleeding_suggest，同素材同规则当日去重）+ cache/bleeding_suggestions_<account>.json 快照（dashboard 并入）
 * 只发现不动作：不进 pending_ops（那是"待执行操作"队列，出血是"需要研判"——研判权在盯盘轮）
 */
const BLEED_EVAL_MS = 30 * 60 * 1000;     // 评估节流 30 分钟/账号（出血是慢信号）
const BLEED_TODAY_COST = 50;              // 当日出血消耗门槛（元，绝对值两店通用）
const BLEED_D7_COST = 300;                // 持续出血 7 天消耗门槛（元）
const BLEED_OBSERVE_RATIO = 0.70;         // 当日观察线 = 保本×0.70（膳 1.47 / 胜 1.75）
const BLEED_CANDIDATE_RATIO = 0.85;       // 持续候选线 = 保本×0.85（膳 1.79 / 胜 2.13）
const NEW_MATERIAL_DAYS = 3;              // 新素材探索期（上传≤3天不判）
// 2026-08-17 升级（公式层降噪）：出血建议 72h 去重（原当日去重——13 天连续重复建议=噪音，agent 每天白处理一轮）
const BLEED_DEDUP_MS = 72 * 3600 * 1000;
// 新信号豁免：近7天消耗较上次建议增长>30% = 素材恶化新触发，突破去重重新建议
const BLEED_COST_GROWTH = 1.3;
const _bleedLastEval = new Map();         // accountId -> ts（进程内节流；重启即评一次，可接受）

/**
 * 素材出血判定（纯函数，可单测）。
 * @param {object} m - { material_id, name, todayCost, todayNetRoi1h, d7Cost, d7NetRoi, uploadDays }
 * @param {object} ctx - { breakEven, shopNetRoi }（shopNetRoi=店铺当日整体净ROI，跑量豁免判定用）
 * @returns {{verdict:'candidate'|'observe'|'exempt_volume'|'exempt_new'|'pass', reason?, evidence}}
 */
function judgeBleeding(m, ctx) {
  // 历史账户专用说明已从试用包移除。
  const round2 = x => +(Math.round((x + Number.EPSILON) * 100) / 100).toFixed(2);
  const observeLine = round2(ctx.breakEven * BLEED_OBSERVE_RATIO);
  const candidateLine = round2(ctx.breakEven * BLEED_CANDIDATE_RATIO);
  const killLine = round2(ctx.breakEven * 0.643); // MHS 斩杀线同尺：低于此线=真烂非"跑量担当"，跑量豁免不适用
  const evidence = {
    material_id: m.material_id || null, material_name: m.name || null,
    today_cost: +(m.todayCost || 0), today_net_roi_1h: m.todayNetRoi1h != null ? +m.todayNetRoi1h : null,
    d7_cost: +(m.d7Cost || 0), d7_net_roi: m.d7NetRoi != null ? +m.d7NetRoi : null,
    upload_days: m.uploadDays != null ? m.uploadDays : null,
    break_even: ctx.breakEven, observe_line: observeLine, candidate_line: candidateLine, kill_line: killLine,
    shop_net_roi: ctx.shopNetRoi != null ? ctx.shopNetRoi : null,
    funnel_diagnosis: m.funnel && m.funnel.diagnosis || null,
    funnel_failure_hits: m.funnel && Number.isFinite(+m.funnel.failure_hits) ? +m.funnel.failure_hits : 0,
    funnel_signals: m.funnel && Array.isArray(m.funnel.signals) ? m.funnel.signals : [],
    funnel_metrics: m.funnel && m.funnel.metrics ? m.funnel.metrics : null,
    drop_amplifier: !!(m.funnel && m.funnel.drop_amplifier),
  };
  const strongFunnelFailure = evidence.funnel_failure_hits >= 2;
  // 新素材豁免（最优先：官方探索期，上传≤3天不判）
  if (m.uploadDays != null && m.uploadDays <= NEW_MATERIAL_DAYS) {
    return { verdict: 'exempt_new', evidence: { ...evidence, exempt: 'new_material' } };
  }
  // 跑量担当豁免（官方拼图理论）：店铺整体净≥保本 且 素材ROI≥斩杀线（保本×0.643，MHS kill 同尺）——
  // 低于斩杀线的不算"跑量担当"（是真烂），即使店铺健康也照判；整体破线豁免失效
  const shopHealthy = ctx.shopNetRoi != null && ctx.shopNetRoi >= ctx.breakEven;
  const volumeExemptFor = roi => shopHealthy && roi != null && roi >= killLine && !strongFunnelFailure;
  // 持续出血候选（7 天口径，优先级高于当日观察）
  // d7_net_roi=0 判（7天是 T-1 终值无延迟问题，0=真零成交——审计 P0：此前 >0 把"烧300零产出"的最烂素材放过了）；
  // d7_net_roi=null 不判（net_gmv 字段缺失，数据异常不盲杀）
  if (evidence.d7_cost >= BLEED_D7_COST && evidence.d7_net_roi != null && evidence.d7_net_roi < candidateLine) {
    if (volumeExemptFor(evidence.d7_net_roi)) {
      return { verdict: 'exempt_volume', evidence: { ...evidence, exempt: 'volume', kill_line: killLine, exempt_note: '店铺整体净≥保本且素材ROI≥斩杀线，跑量担当豁免中' } };
    }
    return {
      verdict: 'candidate',
      code: strongFunnelFailure ? 'MATERIAL_MULTI_DIMENSION_LOSS' : 'MATERIAL_HIGH_SPEND_LOW_RETURN',
      reason: `持续高消耗低回报「${m.name}」近7天耗 ${evidence.d7_cost} 净ROI ${evidence.d7_net_roi} < 关注线 ${candidateLine}（保本${ctx.breakEven}×0.85）${strongFunnelFailure ? `，内容漏斗同时命中${evidence.funnel_failure_hits}项（${evidence.funnel_diagnosis}）` : ''}——先停对应追投/移出在投候选，头部GMV素材只做可逆动作并补位，不自动删除素材资产`,
      evidence,
    };
  }
  // 当日出血观察（1h 净口径；净延迟 roi=0 不判，对齐追投闸"净口径延迟不判定"）
  if (evidence.today_cost >= BLEED_TODAY_COST && evidence.today_net_roi_1h != null && evidence.today_net_roi_1h > 0 && evidence.today_net_roi_1h < observeLine) {
    if (volumeExemptFor(evidence.today_net_roi_1h)) {
      return { verdict: 'exempt_volume', evidence: { ...evidence, exempt: 'volume', kill_line: killLine, exempt_note: '店铺整体净≥保本且素材ROI≥斩杀线，跑量担当豁免中' } };
    }
    return {
      verdict: 'observe',
      code: 'MATERIAL_HIGH_SPEND_LOW_RETURN',
      reason: `当日高消耗低回报观察「${m.name}」耗 ${evidence.today_cost.toFixed(2)} 净ROI(1h) ${evidence.today_net_roi_1h} < 观察线 ${observeLine}（保本${ctx.breakEven}×0.70）——小样本观察1天，连续低回报时升级关注`,
      evidence,
    };
  }
  // 稳定内容漏斗已连续失败时，即使财务尚处结算延迟，也要明确给出重剪/换素材观察，
  // 但不能把它升级成投放暂停或删除动作。
  if (evidence.today_cost >= BLEED_TODAY_COST && strongFunnelFailure) {
    return {
      verdict: 'observe',
      code: 'MATERIAL_CONTENT_FUNNEL_WEAK',
      reason: `素材「${m.name}」当日耗 ${evidence.today_cost.toFixed(2)}，稳定内容漏斗命中${evidence.funnel_failure_hits}项（${evidence.funnel_diagnosis}）——进入重剪/换素材队列；等待净成交结算后再决定可逆暂停`,
      evidence,
    };
  }
  return { verdict: 'pass', evidence };
}

/**
 * 素材生命周期上下文（2026-08-17 升级）：近 7 天该素材的 add_material/delete_material 操作。
 * 算法只给事实（谁在何时加了/删了），人工复活/重新投放的语义判断归大模型（agent）结合上下文处理。
 * @param {string} accountId
 * @param {string} materialId
 * @param {number} now
 * @returns {Array<{action:string, ts:string, success:number}>}
 */
function queryMaterialLifecycle(accountId, materialId, now) {
  try {
    const since = localDateStr(new Date(now - 7 * 86400000));
    const today = localDateStr(now);
    const adds = opLog.query({ accountId, action: 'add_material', startDate: since, endDate: today, limit: 100 }) || [];
    const dels = opLog.query({ accountId, action: 'delete_material', startDate: since, endDate: today, limit: 100 }) || [];
    return [...adds, ...dels]
      .filter(l => String(l.target_id || '').split(',').map(x => x.trim()).includes(String(materialId)))
      .map(l => ({ action: l.action, ts: String(l.ts || '').slice(5, 10), success: l.success ? 1 : 0 }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
  } catch { return []; }
}

/**
 * 出血闸主流程：当日素材（record.materials）× 近7天库聚合 → 判定 → 快照+留痕。
 * 由 liveCollector.collectAndAdvise 每拍调用（内部 30 分钟节流）。
 * @param {string} accountId
 * @param {string} accountName
 * @param {object} record - liveCollector 最新帧（materials.video/live/carousel + live_metrics.roiSettle）
 */
async function checkMaterialBleeding(accountId, accountName, record) {
  const now = Date.now();
  const lastAt = _bleedLastEval.get(accountId) || 0;
  if (now - lastAt < BLEED_EVAL_MS) return;
  _bleedLastEval.set(accountId, now);

  const today = localDateStr();
  const breakEven = require('./api-helpers').getAccountParams(accountId).break_even_roi;
  const mats = record && record.materials
    ? [...(record.materials.video || []), ...(record.materials.live || []), ...(record.materials.carousel || [])]
    : [];
  const shopNetRoi = record && record.live_metrics && +record.live_metrics.roiSettle > 0 ? +record.live_metrics.roiSettle : null;

  // 历史账户专用说明已从试用包移除。
  const d7map = {};
  let stableFunnelMap = new Map();
  try {
    const { getDB } = require('./db');
    const db = getDB();
    const d7start = localDateStr(new Date(now - 7 * 86400000));
    const d7end = localDateStr(new Date(now - 86400000)); // 到昨天（T-1 终值）
    const rows = db.prepare(`
      SELECT material_id, MAX(material_name) AS name, ROUND(SUM(cost),2) AS cost, ROUND(SUM(net_gmv),2) AS net_gmv
      FROM material_daily
      WHERE account_id = ? AND stat_date BETWEEN ? AND ? AND material_id != '__EMPTY__' AND marketing_goal = 2
      GROUP BY material_id
    `).all(accountId, d7start, d7end);
    for (const r of rows) {
      d7map[String(r.material_id)] = { name: r.name, cost: +r.cost || 0, netRoi: (+r.cost > 0 && r.net_gmv != null) ? +(r.net_gmv / r.cost).toFixed(2) : null };
    }
    const { loadStableFunnelContext } = require('./materialFunnelStore');
    const stableEnd = localDateStr(new Date(now - 86400000));
    stableFunnelMap = loadStableFunnelContext(db, accountId, stableEnd, 7).materials;
  } catch (e) {
    console.error(`[materialEfficiency] ${accountName} 7天聚合失败:`, e.message);
  }

  // 当日素材 × 7 天数据合并（当日在投的 + 7天有耗的并集，避免"今天没投但连烂7天"漏网）
  const candidates = new Map(); // material_id -> 判定输入
  for (const m of mats) {
    if (!m.material_id) continue;
    const uploadDays = m.uploadTime ? Math.floor((now - new Date(String(m.uploadTime).replace(' ', 'T')).getTime()) / 86400000) : null;
    candidates.set(String(m.material_id), {
      material_id: String(m.material_id), name: m.name,
      todayCost: +m.cost || 0, todayNetRoi1h: +m.roiSettle > 0 ? +m.roiSettle : (+m.cost > 0 ? 0 : null),
      uploadDays: Number.isFinite(uploadDays) ? uploadDays : null,
    });
  }
  for (const [mid, d7] of Object.entries(d7map)) {
    const cur = candidates.get(mid) || { material_id: mid, name: d7.name, todayCost: 0, todayNetRoi1h: null, uploadDays: null };
    cur.d7Cost = d7.cost;
    cur.d7NetRoi = d7.netRoi;
    candidates.set(mid, cur);
  }
  for (const [mid, cur] of candidates) {
    cur.funnel = stableFunnelMap.get(mid) || null;
  }

  // 72h 内已留痕的（2026-08-17 升级：当日去重 → 72h 去重，降噪防每天重复轰炸；
  // 保留新信号豁免——近7天消耗较上次建议增长>30% 视为素材恶化新触发，突破去重重新建议）
  const alerted = new Map(); // "material_id:rule" -> { ts, d7_cost }
  try {
    const logs = opLog.query({ accountId, action: 'material_bleeding_suggest', startDate: localDateStr(new Date(now - BLEED_DEDUP_MS)), endDate: today, limit: 500 }) || [];
    for (const l of logs) {
      if (new Date(l.ts).getTime() < now - BLEED_DEDUP_MS) continue;
      const p = typeof l.params === 'string' ? JSON.parse(l.params || '{}') : (l.params || {});
      if (p.material_id && p.rule) alerted.set(`${p.material_id}:${p.rule}`, { ts: l.ts, d7_cost: +p.d7_cost || 0 });
    }
  } catch { /* op-log 不可用按未留痕（留痕优先，宁可多记） */ }

  const items = [];
  for (const [, m] of candidates) {
    // AIGC 动态创意聚合条目不可按素材删除——判定同 liveCollector isAigcMat 三条件（审计 P1：此前只查 name，material_id 形态漏网）
    if (/AIGC/i.test(m.name || '') || /^(AIGC|LIVE)::/.test(String(m.material_id || '')) || String(m.material_id || '') === '-') continue;
    const v = judgeBleeding(m, { breakEven, shopNetRoi });
    if (v.verdict !== 'candidate' && v.verdict !== 'observe') continue;
    const rule = v.verdict === 'candidate' ? '持续出血' : '当日出血';
    const level = v.verdict === 'candidate' ? 'warning' : 'info';
    const key = `${m.material_id}:${rule}`;
    const prev = alerted.get(key);
    // 72h 去重：已建议过且无新信号（近7天消耗未较上次增长>30%）→ 跳过（降噪，agent 不重复处理）
    const costGrowth = prev && prev.d7_cost > 0 ? ((m.d7Cost || 0) / prev.d7_cost) : null;
    const isNewSignal = prev && costGrowth != null && costGrowth > BLEED_COST_GROWTH;
    if (prev && !isNewSignal) continue;
    // 生命周期上下文（2026-08-17 升级：附近7天 add/delete 操作——人工复活的素材由大模型结合上下文研判，算法只给事实）
    const lifecycle = queryMaterialLifecycle(accountId, String(m.material_id), now);
    const lifeNote = lifecycle.length
      ? `；近7天操作: ${lifecycle.map(x => `${x.action}@${x.ts}`).join(',')}`
      : '';
    const msg = v.reason + lifeNote;
    items.push({ level, code: v.code || 'MATERIAL_HIGH_SPEND_LOW_RETURN', msg, material_id: m.material_id, legacy_rule: rule, funnel: m.funnel || null });
    opLog.log({
      action: 'material_bleeding_suggest', account_id: accountId,
      target_type: 'material', target_id: String(m.material_id),
      params: { ...v.evidence, rule, public_code: v.code || 'MATERIAL_HIGH_SPEND_LOW_RETURN', lifecycle }, result_msg: msg, source: 'agent',
    });
  }

  // 快照落盘（dashboard suggestions 并入点；当日有效，过期快照自动失效）
  try {
    const file = path.join(__dirname, '..', '..', 'cache', `bleeding_suggestions_${accountId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { date: today, eval_at: new Date().toISOString(), items });
  } catch (e) {
    console.error(`[materialEfficiency] ${accountName} 快照写盘失败:`, e.message);
  }
  if (items.length) console.log(`[materialEfficiency] ${accountName} 低效评估：${items.length} 条建议（${items.filter(i => i.level === 'warning').length} 条建议处理）`);
}

module.exports = { checkBoostStopLoss, judgeTask, judgeResumeTask, judgePostLiveTask, judgeRefund, protectionFor, loadRunningStore: readStore, PROTECT_MS, REFUND_ALERT_LINE, judgeBleeding, checkMaterialBleeding };
