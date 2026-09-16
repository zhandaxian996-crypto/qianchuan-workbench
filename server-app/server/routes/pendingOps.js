/**
 * /api/pending-ops — AI 建议待确认队列
 *
 * GET  /api/pending-ops?account=&status=     列表（作战室轮询）
 * POST /api/pending-ops                      K3 提交建议 {account, type, params, reason, auto_execute?, source?}
 * POST /api/pending-ops/approve {id}         投手确认执行（内部回环调本机写路由，走完整校验链）
 * POST /api/pending-ops/reject  {id}         投手拒绝/取消
 *
 * delete_material 仅在 Agent 明确提交 auto_execute=true 后进入自动复核执行；
 * 项目诊断、定时任务和规则引擎只能产生建议，不能自行升级为写操作。
 * Agent 授权路径仍按 MHS 工程目标文档 §5.1 执行三层止损复核：
 *   三层止损复核顺序（③→①→②，判定引擎在 lib/mhs.js，阈值参数走 getMhsParams）：
 *     ③ source=owner_directive 人工指令直通：跳过①②一切判定直接 pass（每日≤3 熔断为铁律仍生效）；
 *     ① 急性衰退双闸门：近3天日均消耗 < 前7天×decline_cost_ratio 且 基准日(昨天)消耗 ≥ 斩杀线(客单价×kill_line_factor) 且净ROI < kill_roi
 *       → 不立即删，进入死缓状态机（窗口 stay_hours 可配默认 48h，条目存 cache/delete_stay.json）：
 *         检查日任一日 消耗≥斩杀线且净ROI≥stay_revive_roi → 复活撤销（op 标 expired）；
 *         全部检查日数据回填且均未复活 → 执行删除（仍过每日≤3 熔断原子复核，熔断则条目留待下轮）；
 *         数据未回填（T+1 延迟）→ 等下轮；条目超 5 天未决 → expired 防死条目；
 *     ② 慢性亏损：近7天累计净ROI < 保本×chronic_roi_factor(0.5) 且 累计消耗 ≥ chronic_min_cost(300)
 *       → 今日支付ROI ≥ 保本×0.6 判回升作废（素材级 1h 结算字段千川恒返 0 不可用，用账面口径更保守）。
 *   保留护栏（硬要求）：
 *     每日每账号自动删除 ≤3 条（validate 预检 + executeItem 内原子复核）；
 *     复核数据不可用绝不盲删（DB 断档/今日面拉取失败 → retry 到 2h 自然过期；死缓条目等回填，5 天兜底过期）；
 *     删素材自动执行后余额 <500 写微信通知事件（emitWechatNotify）；
 *     executed/expired 的 result 落三口径 evidence（7d/30d/全周期；死缓路径附死缓明细）供后验统计误杀率；
 *     写操作结果回读（MHS §七-8）：delete_material/create_boost 执行成功后回读验证真实生效，
 *     写 result.readback={verified, detail}，回读失败/超时(10s)不致命，不改变 executed 状态。
 * 全部写操作收归大模型：服务端护栏、熔断和巡检只检测与执行，不独立做投放决策；
 *   create_boost 不进入延迟自动队列；delete_material 仅接受 Agent 明确授权的 auto_execute。
 *   人工启动/恢复 1h 保护期同样约束盯盘轮：/api/boost-list 每个任务带 protection 字段供前置判定。
 */

const { sendJSON, readJsonBody, requireWriteAuth, daysAgo, beijingDay, checkBodyKeys } = require('../lib/utils');
const pendingOps = require('../lib/pendingOps');
const deleteStay = require('../lib/deleteStay');
const mhs = require('../lib/mhs');
const config = require('../lib/config');
const { PORT } = config;

// 历史账户专用说明已从试用包移除。
const WECHAT_NOTIFY_FILE = require('path').join(__dirname, '..', '..', 'cache', 'wechat_notifications.json');
function emitWechatNotify(event) {
  try {
    let list = [];
    try { list = JSON.parse(require('fs').readFileSync(WECHAT_NOTIFY_FILE, 'utf8')); } catch {}
    list.push({ ...event, notified_at: new Date().toISOString() });
    // 只保留最近 100 条
    if (list.length > 100) list = list.slice(-100);
    require('fs').writeFileSync(WECHAT_NOTIFY_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (_) { /* 通知写失败不影响主流程 */ }
}

// 审批通过后的执行映射：type → 本机写路由 + body 构造（回环调用，免 token，且完整走熔断/校验/op-log）
const EXEC_MAP = {
  pause_boost:     p => ({ path: '/api/campaign/status', body: { primaryAdId: p.primaryAdId || null, assistTaskId: p.assistTaskId, status: 2, accountId: p.accountId } }),
  resume_boost:    p => ({ path: '/api/campaign/status', body: { primaryAdId: p.primaryAdId || null, assistTaskId: p.assistTaskId, status: 1, accountId: p.accountId } }),
  delete_boost:    p => ({ path: '/api/boost-delete', body: { assistTaskId: p.assistTaskId, accountId: p.accountId } }),
  delete_material: p => ({ path: '/api/material/delete', body: { adId: p.adId, objectId: p.objectId, legoMids: p.legoMids, confirm: true, accountId: p.accountId } }),
  create_boost:    p => ({ path: '/api/boost-create', body: p }),
};

// ═══════════════════════════════════════════════════════════
// 静默自动执行：复核阈值（铁律：阈值写死在代码里，不放 Skill 文件）
// ═══════════════════════════════════════════════════════════
const AUTO_MIN_COST_FALLBACK = 100; // 斩杀线兜底：客单价取不到时，累计消耗 ≥ 100 元
const AUTO_RECOVER_FACTOR = 0.6;    // 作废线：今日支付ROI ≥ 保本×0.6 视为回升，自动作废
const AUTO_DAILY_CAP = 3;           // 每日每账号自动删除上限（2026-07-26 由 1 放宽到 3，清理期批量）
const STAY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 死缓条目 5 天未决 → 过期（防死条目）
// 慢性亏损判杀线（保本×0.5 / 消耗≥300）已迁入 MHS 参数：params.chronic_roi_factor / chronic_min_cost（lib/mhs.js，同值）

// 历史账户专用说明已从试用包移除。
// 历史账户专用说明已从试用包移除。
// 2026-08-11 审查确认：validateAutoBoost 仍被 test/pendingOpsValidate.test.js:211 describe 引用（"保留备查"语义），
// 刻意保留不删——删除需连带删 4 个测试用例，无运行收益）
const AUTO_BOOST_MIN_ROI = 1.3;   // 素材净ROI ≥ 保本×1.3（保留备查）
const AUTO_BOOST_MAX_RATIO = 0.25; // 追投占比 <25%（保留备查）
const AUTO_BOOST_BALANCE_FACTOR = 3; // 余额 > 预算×3（保留备查）

// 三层止损判定（纯函数，可测试）：数据齐了以后的判官，不碰 IO（MHS §5.1）
// ③ source=owner_directive 人工直通（2026-08-05 整改：保留直通权但 chronic 3 道前置锁仍复核）；
//   ① 急性衰退双闸门触发 → stay 进 48h 死缓；② 慢性亏损触发 + 今日回升护栏 → pass / 作废。
// acute = mhs.judgeAcuteDecline 结果；chronic = mhs.judgeChronicLoss 结果；
// todayRow=null 表示未求证今日面（第一阶段判定，chronic 触发时必须带 todayRow 二次判定）。
// 口径混用纪律（写死，勿当 bug 改）：判杀用净成交口径（T+1 本地 DB），
//   判救（今日回升作废）用支付口径（账面系统性偏高 → 更容易判回升作废 = 宁可不删，安全方向）
// 历史账户专用说明已从试用包移除。
//   3 道前置判杀锁（全周期/近期/波动）在 mhs.js 判定层已加（acute.fullCycleLock/recentPerformanceLock/volatilityLock 等），
//   owner_directive 直通也走复核——若 chronic 触发但前置锁判救 → 仍 pass:false（保护人工紧急权但不放行误判）
function judgeDeleteLayers({ source, acute, chronic, todayRow, breakEven, autoExecutedToday }) {
  // 每日熔断（铁律，对人工直通同样生效——owner 紧急删除可走 approve 人工通道，不受此限）
  if (autoExecutedToday >= AUTO_DAILY_CAP) {
    return { pass: false, cap: true, layer: 'cap', why: `今日自动删除已达上限 ${AUTO_DAILY_CAP} 条，转人工确认` };
  }
  // ③ 人工指令直通（MHS §5.1 + 2026-08-05 v2 整改）：
  // 历史账户专用说明已从试用包移除。
  // chronic.triggered=false 即前置锁判救的反映，owner_directive 也尊重判救结果
  if (source === 'owner_directive') {
    // 前置锁判救（chronic/acute 在 mhs.js 已算）→ 不直通
    const locks = ['fullCycleLock', 'recentPerformanceLock', 'volatilityLock'];
    for (const lk of locks) {
      if (chronic && chronic[lk] && chronic[lk].active) {
        return { pass: false, layer: 'owner_directive_blocked', why: `人工直通被${lk}拦截：${chronic[lk].why}（维护者可手动直调 /api/material/delete 强制删除）` };
      }
      if (acute && acute[lk] && acute[lk].active) {
        return { pass: false, layer: 'owner_directive_blocked', why: `人工直通被${lk}拦截：${acute[lk].why}（维护者可手动直调 /api/material/delete 强制删除）` };
      }
    }
    return { pass: true, layer: 'owner_directive', why: '人工指令直通（source=owner_directive），跳过急性衰退/慢性亏损判定（前置判杀锁已通过）' };
  }
  // ① 急性衰退：双闸门同时触发 → 48h 死缓，不当场判杀
  if (acute && acute.triggered) {
    return { pass: false, stay: true, layer: 'acute', why: `①急性衰退双闸门触发：${acute.gateA.why}；${acute.gateB.why}，进入 48h 死缓（T+1/T+2 复活观察）`, acute };
  }
  // ② 慢性亏损
  if (!chronic || !chronic.triggered) {
    const aWhy = acute ? `${acute.gateA.why}；${acute.gateB.why}` : '急性判定不可用';
    return { pass: false, layer: 'none', why: `未达自动删除条件：①急性未触发（${aWhy}）；②慢性未触发（${chronic ? chronic.why : '特征不可用'}），自动作废` };
  }
  // 历史账户专用说明已从试用包移除。
  // 素材级 1h settle 字段在千川该数据集恒为 0（实测），实时净成交不可直取；
  // 用 real_pay（券后实付，扣 coupon/subsidy）替代 roi（账面支付ROI）——real_pay/cost 是当前可用最接近净的口径，
  // 账面支付ROI 虚高会让"假回升"反复豁免删除（6月9日第一条反复出现根因）。
  if (todayRow && (+todayRow.cost || 0) > 0) {
    const netRoi = (+todayRow.real_pay || 0) / +todayRow.cost; // 券后实付/消耗 ≈ 净ROI（扣券扣补贴）
    if (netRoi >= breakEven * AUTO_RECOVER_FACTOR) {
      return { pass: false, layer: 'chronic', why: `②慢性亏损触发（${chronic.why}），但今日券后净ROI ${(netRoi).toFixed(2)}（real_pay ${+todayRow.real_pay||0} / cost ${+todayRow.cost}）回升至保本×${AUTO_RECOVER_FACTOR}（${(breakEven * AUTO_RECOVER_FACTOR).toFixed(2)}）以上，自动作废` };
    }
  }
  return { pass: true, layer: 'chronic', why: `②慢性亏损复核通过：${chronic.why}；①急性未触发；今日无回升迹象` };
}

// 历史账户专用说明已从试用包移除。
// owner_directive pending 项 approve 前重跑判定层——防 pending 项创建后数据变化导致误删。
// 复用 validateAutoDelete（已含 3 道前置锁+冲量窗口保护+历史功劳护栏+熔断），
// 历史账户专用说明已从试用包移除。
// 关键：用 source='agent' 跑判定（owner_directive 在 judgeDeleteLayers 直通分支会跳过前置锁），
// 这样 approve 复核会完整走急性/慢性判定+前置锁，前置锁判救时拦截 approve。
async function reviewDeleteOnApprove(item) {
  try {
    // 临时改 source 为 agent 跑判定（不污染原 pending 项）
    const reviewItem = { ...item, source: 'agent' };
    return await validateAutoDelete(reviewItem);
  } catch (e) {
    // 复核异常 → 保护性拦截（宁可误拦不可漏拦）
    return { pass: false, layer: 'review_error', why: `approve 复核异常：${e.message}（保护性拦截，维护者可手动直调 /api/material/delete 强制删除）` };
  }
}

// 每日上限计数：同账号今日已自动执行成功的条数（validate 预检与 executeItem 占位前原子复核共用）
// 2026-08-01 二轮审计 P1：跨天判定统一北京自然日（beijingDay）——toDateString 按服务器本地时区划日，迁 UTC 后会提前 8 小时清零熔断
function countAutoExecutedToday(account) {
  const todayStr = beijingDay();
  return pendingOps.list({ account, status: 'executed' }).filter(it =>
    it.result && it.result.auto === true &&
    it.decided_at && beijingDay(it.decided_at) === todayStr
  ).length;
}

// 每日自动创建追投预算合计（提交时口径）：今日已 executed 且 result.auto===true 的 create_boost 的 params.budget 之和
function sumAutoBoostBudgetToday(account) {
  const todayStr = beijingDay();
  return pendingOps.list({ account, status: 'executed' }).filter(it =>
    it.type === 'create_boost' &&
    it.result && it.result.auto === true &&
    it.decided_at && beijingDay(it.decided_at) === todayStr
  ).reduce((s, it) => s + ((it.params && +it.params.budget) || 0), 0);
}

// create_boost 全自动复核判定（纯函数）
// evidence = { net_roi, boost_ratio, balance, budget, break_even }
// 历史账户专用说明已从试用包移除。
function judgeAutoBoost({ evidence, breakEven, autoBoostBudgetToday, budgetCap }) {
  const cap = budgetCap != null ? budgetCap : 1200;
  const used = autoBoostBudgetToday || 0;
  const budget = evidence && evidence.budget || 0;
  if (used + budget > cap) {
    return { pass: false, cap: true, why: `今日自动创建追投预算合计 ${used} 元 + 拟建 ${budget} 元 > 上限 ${cap} 元，转人工确认` };
  }
  if (!evidence) return { pass: false, why: '无法获取素材/账户数据，不自动创建' };
  const { net_roi, boost_ratio, balance } = evidence;
  if (net_roi == null || net_roi < breakEven * AUTO_BOOST_MIN_ROI) {
    return { pass: false, why: `素材净ROI ${net_roi} < 保本×${AUTO_BOOST_MIN_ROI}（${(breakEven * AUTO_BOOST_MIN_ROI).toFixed(2)}），不满足自动追投条件` };
  }
  if (boost_ratio != null && boost_ratio >= AUTO_BOOST_MAX_RATIO) {
    return { pass: false, why: `追投占比 ${(boost_ratio * 100).toFixed(1)}% ≥ ${AUTO_BOOST_MAX_RATIO * 100}%，不自动创建` };
  }
  if (balance != null && balance < budget * AUTO_BOOST_BALANCE_FACTOR) {
    return { pass: false, why: `余额 ${balance} 元 < 预算×${AUTO_BOOST_BALANCE_FACTOR}（${budget * AUTO_BOOST_BALANCE_FACTOR}），不自动创建` };
  }
  return { pass: true, why: `复核通过：净ROI ${net_roi} ≥ 保本×${AUTO_BOOST_MIN_ROI}、追投占比 ${(boost_ratio * 100).toFixed(1)}% < ${AUTO_BOOST_MAX_RATIO * 100}%、余额充足、预算限额 ${used}+${budget}≤${cap}` };
}

// 写操作结果回读（MHS §七-8）：执行成功后回读验证真实生效。
// 回读失败/超时（10s）不致命：verified=false 记原因，日志 warn，不改变 executed 状态。
// fetchImpl 仅供测试注入；pause/resume/delete_boost 不要求回读（调用方已跳过）。
async function readbackExecution(item, execResult, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (item.type === 'delete_material') {
    const mids = (Array.isArray(item.params.legoMids) ? item.params.legoMids : [item.params.legoMids]).map(String);
    const today = daysAgo(0);
    const r = await doFetch(`http://127.0.0.1:${PORT}/api/materials/live?account=${encodeURIComponent(item.account)}&startDate=${today}&endDate=${today}&status=1&pageSize=50`, {
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || j.ok !== true) return { verified: false, detail: `回读在投列表失败：${(j && j.error) || '响应异常'}` };
    // 2026-08-01 二轮审计 P1 修复：加查已暂停列表（status=2）——此前只查在投（status=1），
    // 素材若删前就不在投（暂停中/今日未跑量），在投列表零匹配会被误判"删除生效"；删除生效的素材应从在投+暂停都消失。
    const r2 = await doFetch(`http://127.0.0.1:${PORT}/api/materials/live?account=${encodeURIComponent(item.account)}&startDate=${today}&endDate=${today}&status=2&pageSize=50`, {
      signal: AbortSignal.timeout(10000),
    });
    const j2 = await r2.json().catch(() => ({}));
    if (!j2 || j2.ok !== true) return { verified: false, detail: `回读暂停列表失败：${(j2 && j2.error) || '响应异常'}` };
    // 2026-07-30 审计修复：批量删除逐条回读（此前只回读 mids[0]，第二条删没删不知道）
    const stillLive = (j.rows || []).filter(m => mids.includes(String(m.material_id))).map(m => String(m.material_id));
    // 历史账户专用说明已从试用包移除。
    // 千川"删除素材"本质是 set-opt 移出计划；视频库文件残留、暂停列表历史记录属千川存储层行为，不影响投放，不判失败。
    // 因此只验证在投列表(status=1)消失 = 删除生效；暂停列表(status=2)残留仅作提示，不改变 verified 结论。
    const pausedNote = (j2 && j2.ok === true && Array.isArray(j2.rows))
      ? (j2.rows || []).filter(m => mids.includes(String(m.material_id))).map(m => String(m.material_id))
      : [];
    if (stillLive.length) {
      return { verified: false, detail: `素材 ${stillLive.join('/')} 仍在今日在投列表（共删 ${mids.length} 条），删除未生效` };
    }
    return pausedNote.length
      ? { verified: true, detail: `${mids.length} 条素材已移出在投列表（删除生效）；暂停列表仍有历史记录：${pausedNote.join('/')}（属千川存储层残留，不影响投放）` }
      : { verified: true, detail: `${mids.length} 条素材均已移出在投列表，删除生效` };
  }
  if (item.type === 'create_boost') {
    // boost-create 成功响应带 task_id（追投任务ID）；boost-list 任务 id 即追投任务ID
    const taskId = execResult && (execResult.task_id || execResult.assist_task_id || execResult.assistTaskId);
    const r = await doFetch(`http://127.0.0.1:${PORT}/api/boost-list?account=${encodeURIComponent(item.account)}`, {
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || j.ok !== true) return { verified: false, detail: `回读追投列表失败：${(j && j.error) || '响应异常'}` };
    const tasks = j.tasks || [];
    if (taskId != null) {
      const found = tasks.find(t => String(t.id) === String(taskId));
      return found
        ? { verified: true, detail: `追投任务 ${taskId} 已在列表（状态 ${found.status}）` }
        : { verified: false, detail: `创建响应的追投任务 ${taskId} 未在列表找到` };
    }
    // 创建响应未带任务ID：按主计划+预算兜底匹配
    const pid = item.params && item.params.primaryAdId;
    const budget = (item.params && item.params.budget) || 0;
    const found = tasks.find(t => String(t.primary_ad_id) === String(pid) && Math.abs((t.budget || 0) - budget) < 1);
    return found
      ? { verified: true, detail: `按主计划 ${pid}+预算 ${budget} 匹配到追投任务 ${found.id}` }
      : { verified: false, detail: '创建响应未含任务ID，按主计划+预算也未匹配到追投任务' };
  }
  return { verified: true, detail: `${item.type} 类型不要求回读` };
}

// 审批/自动共用执行段：回环调本机写路由（走完整校验链+op-log），executing 占位防重复执行
// 历史账户专用说明已从试用包移除。
async function executeItem(item, { auto = false, evidence = null } = {}) {
  const exec = EXEC_MAP[item.type];
  if (!exec) return { ok: false, status: 'failed', error: `不支持的建议类型: ${item.type}` };
  // 占位前复核仍为 pending：approve 路由已查一次，自动执行路径在 validate 之后也需防用户恰好取消
  const fresh = pendingOps.get(item.id);
  if (!fresh) return { ok: false, status: 'failed', error: `建议不存在: ${item.id}` };
  if (fresh.status !== 'pending') return { ok: false, status: fresh.status, error: `建议已处理（${fresh.status}），不可重复操作` };
  // 每日自动删除上限原子复核（与 executing 占位同为同步代码段，防并发 sweep 各自通过预检后超限执行）；超限不动状态，留待人工
  if (auto && fresh.type === 'delete_material' && countAutoExecutedToday(fresh.account) >= AUTO_DAILY_CAP) {
    return { ok: false, status: 'cap_blocked', error: `今日自动删除已达上限 ${AUTO_DAILY_CAP} 条，保留待人工确认` };
  }
  const { path, body } = exec(fresh.params || {});
  body.source = 'agent'; // 决策来源标记：op-log 胜率统计按 source 归因（AI建议/自动执行 vs 投手直调）
  pendingOps.update(fresh.id, { status: 'executing', executing_at: new Date().toISOString() });
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const result = await r.json().catch(() => ({}));
    const success = !!(result && result.ok);
    // 写操作结果回读（MHS §七-8）：成功后验证真实生效；回读失败不致命，不改 executed 状态
    if (success && (fresh.type === 'delete_material' || fresh.type === 'create_boost')) {
      try {
        result.readback = await readbackExecution(fresh, result);
        if (!result.readback.verified) console.warn(`[pending-ops] ${fresh.id} 执行回读未验证：${result.readback.detail}`);
      } catch (e) {
        result.readback = { verified: false, detail: `回读异常：${e.message}` };
        console.warn(`[pending-ops] ${fresh.id} 执行回读异常：${e.message}`);
      }
    }
    if (auto) result.auto = true;
    if (evidence) result.evidence = evidence; // 三口径证据落库（后验统计误杀率）
    pendingOps.update(fresh.id, {
      status: success ? 'executed' : 'failed',
      decided_at: new Date().toISOString(),
      result,
    });

    // 历史账户专用说明已从试用包移除。
    if (auto && success && fresh.type === 'delete_material') {
      try {
        const dash = await fetch(`http://127.0.0.1:${PORT}/api/live-dashboard?account=${encodeURIComponent(fresh.account)}&full=1`, {
          signal: AbortSignal.timeout(15000),
        }).then(r2 => r2.json()).catch(() => ({}));
        const balance = dash && dash.balance && dash.balance.total_yuan != null ? dash.balance.total_yuan : null;
        if (balance != null && balance < 500) {
          const mid = Array.isArray(fresh.params.legoMids) ? fresh.params.legoMids[0] : fresh.params.legoMids;
          emitWechatNotify({
            type: 'delete_material',
            account: fresh.account,
            material_id: mid,
            reason: fresh.reason,
            balance,
            result: 'executed',
            op_id: fresh.id,
          });
          console.log(`[pending-ops] 余额 ${balance} < 500，已输出微信通知事件`);
        } else {
          console.log(`[pending-ops] 余额 ${balance} ≥ 500，不发通知`);
        }
      } catch (e) { console.warn('[pending-ops] 通知事件输出失败:', e.message); }
    }

    return { ok: success, status: success ? 'executed' : 'failed', result };
  } catch (e) {
    pendingOps.update(fresh.id, { status: 'failed', decided_at: new Date().toISOString(), result: { error: e.message, ...(auto ? { auto: true } : {}), ...(evidence ? { evidence } : {}) } });
    return { ok: false, status: 'failed', error: e.message };
  }
}

// 自动执行前复核：取数 → 三层止损 / judgeAutoBoost 判定；返回 { pass, why, retry?, cap?, stay?, kill_line?, evidence? }
// retry=true 表示数据不可用，下轮重试绝不盲删；stay=true 表示急性衰退触发，进入 48h 死缓；
// evidence 为三口径证据包，executed/expired 落库供后验统计误杀率（硬要求 2026-07-26）
async function validateAutoExecute(item) {
  if (item.type === 'delete_material') {
    return validateAutoDelete(item);
  }
  if (item.type === 'create_boost') {
    // 历史账户专用说明已从试用包移除。
    // 历史账户专用说明已从试用包移除。
    return { pass: false, why: '写操作收归大模型（2026-07-29 维护者拍板）：create_boost 不再自动执行，转Agent盯盘轮判断' };
  }
  return { pass: false, why: `auto_execute 不支持类型 ${item.type}` };
}

// 历史账户专用说明已从试用包移除。
// 累计 GMV ≥1万 或 全店 GMV 贡献 top10 → auto_execute 通道豁免，转人工确认
// （与 MHS 层 V1.1-② 劣质档降观察互补：MHS 层管"别误判"，删除层管"大头必须人点头"）
const HISTORY_MERIT_GMV = 10000;
function historyMeritGuard({ gmvTotal, isTop10 }) {
  const over10k = (+gmvTotal || 0) >= HISTORY_MERIT_GMV;
  if (!over10k && !isTop10) return null;
  const bits = [];
  if (over10k) bits.push(`累计GMV ${Math.round(gmvTotal)} ≥1万`);
  if (isTop10) bits.push('全店GMV贡献 top10');
  return { pass: false, cap: true, why: `历史功臣素材保护（${bits.join(' · ')}），auto_execute 通道豁免，转人工确认（2026-07-30 维护者拍板）` };
}

// delete_material 自动执行复核（MHS §5.1 三层止损：③人工直通 → ①急性衰退双闸门+48h死缓 → ②慢性亏损）
// db / materialProfile / liveCollector 均为惰性 require（测试可打桩模块对象）
async function validateAutoDelete(item) {
  const { getAccountParams } = require('../lib/api-helpers');
  const { getRangeHistory, getMaterialHistory } = require('../lib/db');
  const { buildMaterialProfile } = require('../lib/materialProfile');
  const { buildThresholds } = require('../lib/liveCollector');
  const be = getAccountParams(item.account).break_even_roi;
  // 斩杀线：该账号客单价×kill_line_factor（MHS 参数，2026-07-28 反推收敛 ×0.5/×0.75，取不到兜底 100 元）
  const { params } = mhs.getMhsParams(item.account);
  const killFactor = params.kill_line_factor != null ? params.kill_line_factor : 2;
  const th = buildThresholds(item.account) || {};
  const killLine = th.avg_order_price ? +(th.avg_order_price * killFactor).toFixed(2) : AUTO_MIN_COST_FALLBACK;

  // 每日上限：同账号今日已自动执行成功的条数
  const autoExecutedToday = countAutoExecutedToday(item.account);
  const source = item.source || 'agent';
  const mids = (Array.isArray(item.params.legoMids) ? item.params.legoMids : [item.params.legoMids]).map(String);
  const mid = mids[0];
  const endDate = daysAgo(1); // 基准日=昨天（T+1 口径）
  let stableFunnelMap = new Map();
  try {
    const { getDB } = require('../lib/db');
    const { loadStableFunnelContext } = require('../lib/materialFunnelStore');
    stableFunnelMap = loadStableFunnelContext(getDB(), item.account, endDate, 7, params.material_funnel || {}).materials;
  } catch {
    // 旧库迁移中或内容指标暂缺时保留原财务硬闸；不得伪造漏斗旁证。
  }

  // 数据可用性闸（绝不盲删）：该账号近7天 DB 整体空洞（采集断档）→ retry；
  // 注意与"DB 有数据但该素材无行"区分——后者是素材零消耗，落在 ①② 判定里安全作废，不是不可用
  const rows7d = getRangeHistory(daysAgo(7), endDate, item.account) || [];
  if (rows7d.length === 0) return { pass: false, retry: true, why: '本地 DB 近7天无该账号任何素材数据（采集断档），下轮重试绝不盲删' };

  // 三口径证据包（7d/30d/全周期）：主判=近7天净成交口径；30d/全周期仅旁证（全周期不作免死辩护）
  const profile = buildMaterialProfile(mid, item.account);
  const evidence = profile ? {
    cost_7d: profile.cost_7d, roi_7d: profile.roi_7d,
    cost_30d: profile.cost_30d, roi_30d: profile.roi_30d,
    cost_total: profile.cost_total, roi_total: profile.roi_total,
    cpc_7d: profile.retention && profile.retention.cpc_7d,
    funnel: stableFunnelMap.get(String(mid)) || null,
    kill_line: killLine, break_even: be,
  } : null;

  // 历史账户专用说明已从试用包移除。
  // 查询失败按 cap 处理（保护性护栏，宁可误拦不可漏拦）
  // 2026-07-30 审计修复：批量提交时逐个过护栏（此前只检 legoMids[0]，[普通素材,头牌] 组合可整体绕过）
  try {
    const { getDB } = require('../lib/db');
    const db = getDB();
    const top10 = db.prepare(`SELECT material_id, SUM(gmv) AS g FROM material_daily WHERE account_id = ? AND material_id != '__EMPTY__' GROUP BY material_id ORDER BY g DESC LIMIT 10`).all(item.account);
    const top10Ids = new Set(top10.map(r => String(r.material_id)));
    for (const m of mids) {
      const gRow = db.prepare(`SELECT SUM(gmv) AS g FROM material_daily WHERE account_id = ? AND material_id = ?`).get(item.account, m);
      const gmvTotal = (gRow && +gRow.g) || 0;
      const guard = historyMeritGuard({ gmvTotal, isTop10: top10Ids.has(m) });
      if (guard) { guard.why = `素材 ${m}：${guard.why}`; guard.evidence = evidence; return guard; }
    }
  } catch (e) {
    return { pass: false, cap: true, why: `历史功劳护栏查询失败（${e.message}），保护性拦截转人工`, evidence };
  }

  // 三层止损判定：批量提交逐条复核（2026-07-30 opus 复核实锤：此前判定层只算 mids[0]，
  // 批量第二条素材不做急性/慢性判定就被跟着删）。保守语义：任一不过 → 整批不执行。
  // ②慢性判杀前的今日在投列表（批量共用只拉一次，仅慢性层需要时）
  let liveRowsCache = null;
  const fetchLiveRows = async () => {
    if (liveRowsCache) return liveRowsCache;
    const today = daysAgo(0);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/materials/live?account=${encodeURIComponent(item.account)}&startDate=${today}&endDate=${today}&status=all&pageSize=100`, {
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || j.ok !== true) return null;
    liveRowsCache = j.rows || [];
    return liveRowsCache;
  };

  const judgeOneMid = async (m, profile) => {
    // 逐日行（①急性 与 ②慢性 共用；近30天窗口覆盖 近3天+前7天+近7天 全部判定窗）
    const daily = mhs.aggregateDaily(getMaterialHistory(m, daysAgo(30), endDate, item.account) || []);
    // 历史账户专用说明已从试用包移除。
    const firstCostDate = (daily.find(d => d.cost > 0) || {}).date || null;
    const ageDays = firstCostDate
      ? Math.max(0, Math.round((new Date(endDate + 'T00:00:00') - new Date(String(firstCostDate).slice(0, 10) + 'T00:00:00')) / 86400000))
      : null;
    // V1.6 节令豁免需要：账号 ID + 素材名（profile.name 来自 buildMaterialProfile）
    const materialName = (profile && profile.name) || '';
    // ① 急性衰退双闸门（基准日=昨天）——2026-08-05 v2 整改：补 breakEven/ageDays 供前置判杀锁+冲量窗口保护
    // V1.6：补 accountId/materialName 供节令豁免判定（节令窗口内短路返回 triggered:false）
    const acute = mhs.judgeAcuteDecline(daily, { endDate, killLine, params, breakEven: be, ageDays, avgOrder: th.avg_order_price, accountId: item.account, materialName });
    // ② 慢性亏损特征（近7天窗口，T+1 净成交口径）——双轨制（2026-08-01 专家团方案）：补旁证窗口（动量/GPM/流量）
    const w7 = mhs.sumWindow(daily, endDate, 7);
    const w3 = mhs.sumWindow(daily, endDate, 3);
    const wPrev7 = mhs.sumWindow(daily, mhs.shiftDate(endDate, -3), 7);
    const w30 = mhs.sumWindow(daily, endDate, 30);  // v2 整改：近期表现锁需要 30d 窗口
    const funnel = stableFunnelMap.get(String(m)) || null;
    const chronic = mhs.judgeChronicLoss({
      cost_7d: Math.round(w7.cost * 100) / 100,
      net_roi_7d: w7.cost > 0 ? Math.round((w7.net / w7.cost) * 100) / 100 : 0,
      net_roi_30d: w30.cost > 0 ? Math.round((w30.net / w30.cost) * 100) / 100 : null,  // v2 整改：近期表现锁
      cost_3d: w3.cost, cost_prev7d: wPrev7.cost,
      gmv_3d: w3.gmv, gmv_prev7d: wPrev7.gmv,
      gmv_7d: w7.gmv,  // v2 整改：netROI 不可信降级时需要支付口径 7d GMV
      shows_3d: w3.shows, shows_prev7d: wPrev7.shows,
      age_days: ageDays,  // v2 整改：冲量窗口保护
      daily_7d: daily.filter(d => d.date >= mhs.shiftDate(endDate, -6) && d.date <= endDate),  // v2 整改：近期表现锁健康日判定
      funnel_diagnosis: funnel && funnel.diagnosis,
      funnel_failure_hits: funnel && funnel.failure_hits || 0,
      funnel_signals: funnel && funnel.signals || [],
      drop_amplifier: !!(funnel && funnel.drop_amplifier),
    }, { breakEven: be, params, daily, endDate, avgOrder: th.avg_order_price, accountId: item.account, materialName });  // v2 整改：补 daily + endDate 供全周期锁+波动锁；V1.6 补 accountId/materialName 供节令豁免

    const v1 = judgeDeleteLayers({ source, acute, chronic, todayRow: null, breakEven: be, autoExecutedToday });
    if (v1.stay) { v1.kill_line = killLine; v1.mid = m; return v1; } // ①急性触发 → sweep 建死缓条目，保持 pending（mid=触发者，死缓监控对象——审计P0：原死取mids[0]张冠李戴）
    if (v1.cap || !v1.pass) return v1;                    // 熔断转人工 / 未达条件作废
    if (v1.layer !== 'chronic') return v1;                // ③人工直通：无需求证今日面

    // ②慢性判杀前最后护栏：今日有回升迹象则作废；数据不可用 → retry，下轮再试（2h 到点自然过期）
    let rows;
    try { rows = await fetchLiveRows(); } catch (e) { return { pass: false, retry: true, why: `今日素材数据拉取异常：${e.message}` }; }
    if (!rows) return { pass: false, retry: true, why: '今日素材数据拉取失败，下轮重试' };
    const row = rows.find(x => String(x.material_id) === m);
    return judgeDeleteLayers({ source, acute, chronic, todayRow: row || null, breakEven: be, autoExecutedToday });
  };

  let lastV = null;
  for (const m of mids) {
    const profile = buildMaterialProfile(m, item.account);
    const mEvidence = profile ? {
      cost_7d: profile.cost_7d, roi_7d: profile.roi_7d,
      cost_30d: profile.cost_30d, roi_30d: profile.roi_30d,
      cost_total: profile.cost_total, roi_total: profile.roi_total,
      cpc_7d: profile.retention && profile.retention.cpc_7d,
      funnel: stableFunnelMap.get(String(m)) || null,
      kill_line: killLine, break_even: be,
    } : evidence;
    const v = await judgeOneMid(m, profile);  // V1.6：传 profile 供 judgeOneMid 取 materialName 做节令豁免
    v.evidence = mEvidence;
    lastV = v;
    if (v.pass && !v.stay && !v.cap && !v.retry) continue; // 该条通过，审下一条
    if (mids.length > 1 && v.why) v.why = `素材 ${m}：${v.why}`;
    return v;
  }
  if (mids.length === 1) return lastV;
  return { pass: true, why: `批量 ${mids.length} 条逐条复核通过（三层止损）`, evidence: lastV.evidence };
}

// create_boost 自动执行复核
async function validateAutoBoost(item) {
  const { getAccountParams } = require('../lib/api-helpers');
  const be = getAccountParams(item.account).break_even_roi;
  const autoBoostBudgetToday = sumAutoBoostBudgetToday(item.account);
  const { params: boostParams } = mhs.getMhsParams(item.account);
  const budgetCap = boostParams.boost_daily_budget_cap != null ? boostParams.boost_daily_budget_cap : 1200;

  // 从 live-dashboard 获取素材净ROI、追投占比、余额
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/live-dashboard?account=${encodeURIComponent(item.account)}&full=1`, {
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || j.ok !== true) return { pass: false, retry: true, why: '盘面数据拉取失败，下轮重试' };

    const mid = Array.isArray(item.params.mids) ? item.params.mids[0] : item.params.mids;
    let netRoi = null;

    // 先从 live-dashboard 的 materials_top / boost_materials 找（ roiSettle 即净ROI ）
    const allMats = [...(j.materials_top || []), ...(j.boost_materials || [])];
    const mat = allMats.find(m => String(m.material_id) === String(mid));
    if (mat && mat.roiSettle != null) {
      netRoi = mat.roiSettle;
    } else {
      // 找不到则从本地 DB 取近7天净ROI
      const { buildMaterialProfile } = require('../lib/materialProfile');
      const profile = buildMaterialProfile(String(mid), item.account);
      if (profile && profile.roi_7d != null) netRoi = profile.roi_7d;
    }

    // 追投占比：当前追投总预算 / 主计划预算
    const plan = j.plan || {};
    const boostTasks = j.boost_tasks || [];
    const boostBudget = boostTasks.reduce((s, t) => s + (t.budget || 0), 0);
    const planBudget = plan.budget || 1;
    const boostRatio = boostBudget / planBudget;

    const balance = j.balance && j.balance.total_yuan != null ? j.balance.total_yuan : null;
    const budget = item.params.budget || 0;

    const evidence = { net_roi: netRoi, boost_ratio: boostRatio, balance, budget, break_even: be };
    const verdict = judgeAutoBoost({ evidence, breakEven: be, autoBoostBudgetToday, budgetCap });
    verdict.evidence = evidence;
    return verdict;
  } catch (e) {
    return { pass: false, retry: true, why: `盘面数据拉取异常：${e.message}` };
  }
}

// ═══════════════════════════════════════════════════════════
// 48h 死缓状态机（MHS §5.1：急性衰退触发后不立即删，T+1/T+2 复活观察）
// ═══════════════════════════════════════════════════════════

// 死缓证据包：三口径画像 + 死缓明细（斩杀线/基准日/逐检查日判定/急性闸门快照），落 result.evidence 供后验
function buildStayEvidence(st, checks) {
  let ev = {
    kill_line: st.kill_line,
    triggered_date: st.triggered_date,
    stay: { check_dates: st.check_dates, checks: checks || st.checks || [], acute: st.acute || null },
  };
  try {
    const { buildMaterialProfile } = require('../lib/materialProfile');
    const profile = buildMaterialProfile(String(st.material_id), st.account);
    if (profile) {
      ev = {
        cost_7d: profile.cost_7d, roi_7d: profile.roi_7d,
        cost_30d: profile.cost_30d, roi_30d: profile.roi_30d,
        cost_total: profile.cost_total, roi_total: profile.roi_total,
        ...ev,
      };
    }
  } catch { /* 证据缺失不阻断主流程 */ }
  return ev;
}

// 急性触发 → 建死缓条目（同素材已有 staying 条目不重复建，本建议作重复作废防悬挂）；建议保持 pending
function enterDeleteStay(item, v) {
  // 死缓监控对象=触发急性判定的那条（v.mid，judgeOneMid 设置）；批量提交时原死取 legoMids[0] 会张冠李戴——
  // 第2条触发却监控第1条，期满 exec 把整批（含误伤者）一网打尽（2026-07-31 审计 P0）
  const mid = String(v.mid || (Array.isArray(item.params.legoMids) ? item.params.legoMids[0] : item.params.legoMids));
  const existing = deleteStay.getStaying(mid, item.account);
  if (existing) {
    pendingOps.update(item.id, {
      status: 'expired', decided_at: new Date().toISOString(),
      result: { auto: true, skipped: `素材 ${mid} 已有死缓条目（${existing.triggered_date} 触发，归属建议 ${existing.item_id}），本建议作重复作废`, ...(v.evidence ? { evidence: v.evidence } : {}) },
    });
    console.log(`[pending-ops-stay] ${item.id} 素材 ${mid} 已有死缓条目（${existing.triggered_date} 触发），不重复建，本建议作废`);
    return existing;
  }
  const triggered = daysAgo(1); // 基准日=昨天（与 validateAutoDelete 的 endDate 一致）
  // 历史账户专用说明已从试用包移除。
  const { params: stayParams } = mhs.getMhsParams(item.account);
  const stayDays = Math.max(1, Math.round((stayParams.stay_hours != null ? stayParams.stay_hours : 48) / 24));
  const checkDates = [];
  for (let i = 1; i <= stayDays; i++) checkDates.push(mhs.shiftDate(triggered, i));
  const entry = deleteStay.create({
    material_id: mid,
    account: item.account,
    item_id: item.id,
    kill_line: v.kill_line,
    revive_line: stayParams.stay_revive_roi != null ? stayParams.stay_revive_roi : null, // 复活线快照（2026-08-01 审计P0：死缓48h内MHS版本切换，实时取参会按新阈值误判生死——建档时冻结）
    triggered_date: triggered,
    check_dates: checkDates,
    entered_at: new Date().toISOString(),
    status: 'staying',
    acute: v.acute || null,
    checks: [],
  });
  // 标记进入死缓：保持 pending 且不受 2h 自然过期影响（死缓最长 5 天由状态机兜底）
  pendingOps.update(item.id, { delete_stay: true });
  console.log(`[pending-ops-stay] ${item.id} 素材 ${mid} 急性衰退触发，进入 ${stayDays * 24}h 死缓（检查日 ${entry.check_dates.join(' / ')}，斩杀线 ${entry.kill_line}）`);
  return entry;
}

// 每轮 sweep 推进全部 staying 条目：复活撤销 / 期满执行 / 等回填 / 超期过期
async function resolveStayEntries({ execute } = {}) {
  const staying = deleteStay.list({ status: 'staying' });
  for (const st of staying) {
    try {
      await resolveOneStay(st, { execute });
    } catch (e) {
      console.error(`[pending-ops-stay] ${st.item_id} 死缓处理异常：${e.message}`);
    }
  }
}

async function resolveOneStay(st, { execute } = {}) {
  const { getRangeHistory, getMaterialHistory } = require('../lib/db');
  const exec = execute || executeItem;
  const yesterday = daysAgo(1);
  const { params } = mhs.getMhsParams(st.account);
  const item = pendingOps.get(st.item_id);
  const itemActive = item && item.status === 'pending';

  // 数据范围：触发日 → 昨天（覆盖全部 check_dates）
  const daily = mhs.aggregateDaily(getMaterialHistory(st.material_id, st.triggered_date, yesterday, st.account) || []);
  const checks = Array.isArray(st.checks) ? [...st.checks] : [];
  let pendingBackfill = false;

  // 复活判定参数：kill_line 用建档快照，stay_revive_roi 也用建档快照（2026-08-01 审计 P0：
  // 此前实时 getMhsParams——死缓 48h 内 MHS 版本切换，素材按新阈值误判生死；旧条目无快照回退实时值兼容）
  const reviveParams = st.revive_line != null ? { ...params, stay_revive_roi: st.revive_line } : params;

  for (const cd of st.check_dates) {
    if (cd > yesterday) { pendingBackfill = true; continue; } // 检查日还没到（T+1 之前）
    if (checks.some(c => c.date === cd)) continue;            // 该日已判过，幂等跳过
    // 账号级回填闸（绝不把"无数据"当"未复活"执行）：该日全账号无行 = T+1 采集未回填 → 等下轮
    const dayRows = getRangeHistory(cd, cd, st.account) || [];
    if (dayRows.length === 0) { pendingBackfill = true; continue; }
    const rv = mhs.judgeStayRevive(daily, { endDate: cd, killLine: st.kill_line, params: reviveParams });
    checks.push({ date: cd, revived: rv.revived, ...(rv.day || {}), why: rv.why });
    if (rv.revived) {
      deleteStay.update(st.material_id, st.account, {
        status: 'revoked', resolved_at: new Date().toISOString(), resolve_why: rv.why, checks,
      });
      if (itemActive) {
        pendingOps.update(item.id, {
          status: 'expired', decided_at: new Date().toISOString(),
          result: { auto: true, skipped: `死缓期间复活撤销：${rv.why}`, evidence: buildStayEvidence(st, checks) },
        });
      }
      console.log(`[pending-ops-stay] ${st.item_id} 素材 ${st.material_id} 死缓复活撤销：${rv.why}`);
      return;
    }
  }
  // 持久化 checks 进度（判过的日期下轮不重判）
  deleteStay.update(st.material_id, st.account, { checks });

  if (!pendingBackfill) {
    // 全部 check_date 已回填且均未复活 → 执行删除
    if (!itemActive) {
      deleteStay.update(st.material_id, st.account, {
        status: 'cancelled', resolved_at: new Date().toISOString(),
        resolve_why: `对应建议已被处理（${item ? item.status : '不存在'}），死缓条目关闭`,
      });
      console.log(`[pending-ops-stay] ${st.item_id} 建议已非 pending，死缓条目关闭`);
      return;
    }
    console.log(`[pending-ops-stay] ${st.item_id} 素材 ${st.material_id} 死缓 ${st.check_dates.join(' / ')} 均未复活，执行删除`);
    const r = await exec(item, { auto: true, evidence: buildStayEvidence(st, checks) });
    if (r.status === 'cap_blocked') {
      // 每日≤3 熔断原子复核仍生效：条目保持 staying 下轮重试（5 天未决兜底过期）
      console.log(`[pending-ops-stay] ${st.item_id} ${r.error}，死缓条目保留待下轮`);
      return;
    }
    deleteStay.update(st.material_id, st.account, {
      status: 'executed', resolved_at: new Date().toISOString(),
      resolve_why: `死缓期满未复活，已交付执行（${r.ok ? '成功' : `失败：${r.error || '未知'}`}）`,
    });
    console.log(`[pending-ops-stay] ${st.item_id} 死缓转执行${r.ok ? '成功' : '失败'}：${JSON.stringify(r.result || r.error || '').slice(0, 200)}`);
    return;
  }

  // 数据未回填（T+1 延迟）→ 等下轮；条目超 5 天未决 → 过期（防死条目）
  if (Date.now() - new Date(st.entered_at).getTime() > STAY_MAX_AGE_MS) {
    deleteStay.update(st.material_id, st.account, {
      status: 'expired', resolved_at: new Date().toISOString(),
      resolve_why: '死缓超过 5 天数据仍未回填，防死条目自动过期', checks,
    });
    if (itemActive) {
      pendingOps.update(item.id, {
        status: 'expired', decided_at: new Date().toISOString(),
        result: { auto: true, skipped: '死缓超过 5 天未决（检查日数据未回填），防死条目自动过期', evidence: buildStayEvidence(st, checks) },
      });
    }
    console.log(`[pending-ops-stay] ${st.item_id} 素材 ${st.material_id} 死缓超 5 天未决，条目与建议一并过期`);
  }
}

// 扫描一轮到点的 auto_execute 建议（deps 仅供测试注入 stub）
// 重入闸：单轮含千川复核可超 60s，无闸会让上一轮未跑完下一轮并发进来（同一项被重复执行、每日上限被突破）
let sweepRunning = false;
async function sweepOnce(deps) {
  if (sweepRunning) { console.log('[pending-ops-auto] 上一轮未结束，本轮跳过'); return; }
  sweepRunning = true;
  try {
    await sweepOnceInner(deps);
  } finally {
    sweepRunning = false;
  }
}

async function sweepOnceInner(deps) {
  const validate = (deps && deps.validate) || validateAutoExecute;
  const execute = (deps && deps.execute) || executeItem;
  // 先推进 48h 死缓状态机（复活撤销 / 期满执行 / 超期过期），死缓转执行与本轮常规执行共享每日≤3 熔断计数
  await resolveStayEntries({ execute });
  const due = pendingOps.list({ status: 'pending' }).filter(it =>
    it.auto_execute && it.auto_execute_at && Date.now() >= new Date(it.auto_execute_at).getTime()
  );
  for (const item of due) {
    try {
      // 死缓中的建议由状态机接管，跳过常规复核（防复核窗口前移导致口径变化绕过死缓）
      if (item.type === 'delete_material' && item.delete_stay) continue;
      const v = await validate(item);
      if (v.retry) {
        console.log(`[pending-ops-auto] ${item.id} 复核数据不可用，下轮重试：${v.why}`);
        continue;
      }
      if (v.cap) { // 达每日上限：不作废，保留 pending 等投手人工确认（与提示语"转人工"一致）
        console.log(`[pending-ops-auto] ${item.id} ${v.why}，保留待人工`);
        continue;
      }
      if (v.stay) { // ①急性衰退触发 → 建死缓条目，保持 pending 等 T+1/T+2 复活观察
        enterDeleteStay(item, v);
        continue;
      }
      if (!v.pass) {
        pendingOps.update(item.id, { status: 'expired', decided_at: new Date().toISOString(), result: { auto: true, skipped: v.why, ...(v.evidence ? { evidence: v.evidence } : {}) } });
        console.log(`[pending-ops-auto] ${item.id} 复核未通过，自动作废：${v.why}`);
        continue;
      }
      console.log(`[pending-ops-auto] ${item.id} 复核通过（${v.why}），自动执行 ${item.type}`);
      const r = await execute(item, { auto: true, evidence: v.evidence || null });
      if (r.status === 'cap_blocked') console.log(`[pending-ops-auto] ${item.id} ${r.error}`);
      else console.log(`[pending-ops-auto] ${item.id} 自动执行${r.ok ? '成功' : '失败'}：${JSON.stringify(r.result || r.error || '').slice(0, 200)}`);
    } catch (e) {
      console.error(`[pending-ops-auto] ${item.id} 处理异常：${e.message}`);
    }
  }
}

let sweepTimer = null;
function startAutoSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepOnce().catch(e => console.error('[pending-ops-auto] sweep 异常:', e.message));
  }, 60 * 1000);
  sweepTimer.unref();
  console.log('[pending-ops-auto] Agent 授权队列巡检已启动（每60秒扫描；只处理 Agent 明确 auto_execute 的 delete_material；项目不自行生成写授权）');
}

async function handlePendingOps(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/pending-ops') {
    const account = url.searchParams.get('account') || null;
    const status = url.searchParams.get('status') || null;
    return sendJSON(res, { ok: true, items: pendingOps.list({ account, status }) });
  }

  if (req.method === 'POST' && pathname === '/api/pending-ops') {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: 'invalid json body' }, 400);
    // body 参数白名单（2026-08-11 backlog 检修）
    const bodyCheck = checkBodyKeys(data, ['account', 'accountId', 'type', 'params', 'reason', 'round_time', 'auto_execute', 'source'], '/api/pending-ops');
    if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);
    try {
      // 项目不把诊断建议强制升级为写操作。只有 Agent 明确提交 auto_execute=true，
      // 且 pendingOps 的类型白名单与三层护栏通过后，才允许进入延迟执行队列。
      const item = pendingOps.create({
        account: data.account,
        type: data.type,
        params: data.params,
        reason: data.reason,
        roundTime: data.round_time,
        autoExecute: data.auto_execute === true,
        source: data.source,
      });

      // delete_material 建议：自动附加数据支撑（近7天/30天/全周期消耗与净ROI）
      if (data.type === 'delete_material') {
        try {
          const { buildMaterialProfile } = require('../lib/materialProfile');
          const mid = Array.isArray(data.params.legoMids) ? data.params.legoMids[0] : data.params.legoMids;
          const profile = buildMaterialProfile(String(mid), data.account);
          if (profile) {
            const evidence = {
              cost_7d: profile.cost_7d, roi_7d: profile.roi_7d,
              cost_30d: profile.cost_30d, roi_30d: profile.roi_30d,
              cost_total: profile.cost_total, roi_total: profile.roi_total,
            };
            pendingOps.update(item.id, { evidence });
          }
        } catch (e) { /* 附加失败不影响建议创建 */ }
      }
      return sendJSON(res, { ok: true, item });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 400);
    }
  }

  if (req.method === 'POST' && (pathname === '/api/pending-ops/approve' || pathname === '/api/pending-ops/reject')) {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error || !data.id) return sendJSON(res, { ok: false, error: 'id 必填' }, 400);
    // body 参数白名单（2026-08-11 backlog 检修）
    const bodyCheck = checkBodyKeys(data, ['id'], pathname);
    if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);
    const item = pendingOps.get(data.id);
    if (!item) return sendJSON(res, { ok: false, error: `建议不存在: ${data.id}` }, 404);
    if (item.status !== 'pending') return sendJSON(res, { ok: false, error: `建议已处理（${item.status}），不可重复操作` }, 409);

    if (pathname.endsWith('/reject')) {
      pendingOps.update(item.id, { status: 'rejected', decided_at: new Date().toISOString() });
      return sendJSON(res, { ok: true, status: 'rejected' });
    }

    // approve：内部回环调用对应写路由（executeItem 内含 pending 复核 + executing 占位，防双击/重试重复执行）
    // 历史账户专用说明已从试用包移除。
    // 历史账户专用说明已从试用包移除。
    // 删除素材类 pending 项 approve 前必须重新跑 3 道锁校验（防 pending 项创建后数据已变化）
    if (item.type === 'delete_material' && item.source === 'owner_directive') {
      const reviewResult = await reviewDeleteOnApprove(item);
      if (reviewResult && !reviewResult.pass) {
        pendingOps.update(item.id, { status: 'rejected', decided_at: new Date().toISOString(), result: { blocked: true, why: reviewResult.why } });
        return sendJSON(res, { ok: false, error: `approve 被 3 道锁拦截：${reviewResult.why}`, layer: reviewResult.layer }, 409);
      }
    }
    const r = await executeItem(item, { auto: true, approve: true });
    if (r.error && r.status !== 'failed') return sendJSON(res, { ok: false, error: r.error }, 409);
    if (r.error) return sendJSON(res, { ok: false, error: `执行异常: ${r.error}` }, 500);
    return sendJSON(res, { ok: r.ok, status: r.status, result: r.result });
  }

  return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
}

module.exports = handlePendingOps;
module.exports.startAutoSweep = startAutoSweep;
module.exports.sweepOnce = sweepOnce;
module.exports.validateAutoExecute = validateAutoExecute;
module.exports.executeItem = executeItem;
module.exports._test = { judgeDeleteLayers, judgeAutoBoost, sweepOnce, enterDeleteStay, resolveStayEntries, readbackExecution, buildStayEvidence, historyMeritGuard, validateAutoDelete };
