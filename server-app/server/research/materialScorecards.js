/**
 * 已退役：仅供离线对照研究和旧公式回归测试，不注册在线路由，不供 Agent 盯盘调用。
 * /api/material-scorecards — MHS 素材决策卡 API（§七-4）
 *
 * GET /api/material-scorecards?account=xx[&date=YYYY-MM-DD]（date 默认昨天，T+1 口径）
 *
 * 流程：
 *   1. lib/mhs.js computeAccountFeatures(account, date) 拿全账号素材特征（零模型 token）
 *   2. 回环 127.0.0.1:PORT GET /api/live-dashboard?account=xx&full=1（15s 超时）取
 *      plan.quota_left / plan.roi_goal / balance.total_yuan / today.netRoi；
 *      取数失败 → 这些值置 null 且响应标注 dashboard_error（quotaLeft=null 时 planBoostChannel 保守判不可执行）
 *   3. 熔断计数：lib/pendingOps list({account,status:'executed'}) 数今日 auto create_boost
 *      条数/新素材条数/合计预算（口径参照 routes/pendingOps.js countAutoBoostToday，不改其文件）
 *   4. 逐素材生成决策卡（纯函数 buildCardActions，动作纪律见 §4.2/§4.3/§4.4/§4.6/§2.7）：
 *      - 禁止输出无法执行的建议：被 checkBoostGate / planBoostChannel 拦下的建议不进 actions，
 *        统一进卡片 suppressed: [{action, reasons}] 保留痕迹
 *      - AIGC 动态创意聚合行（§2.7）：不生成任何处置建议（含删除/追投）
 *   5. 响应 { ok, account, date, calibrated, params_version, quota, account_gate, cards, suppressed_count }
 *
 * 测试钩子：动作生成核心是纯函数，经 _test 导出；live-dashboard 数据经 ctx 注入，不碰网络。
 */

const { sendJSON, yesterday, validateDateRange, beijingDay } = require('../lib/utils');
const { validateAccount, getAccountParams } = require('../lib/api-helpers');
const { getDB } = require('../lib/db');
const mhs = require('../lib/mhs');
const pendingOps = require('../lib/pendingOps');
const { PORT } = require('../lib/config');

// mode=summary 短缓存（2026-07-30 审计 P0 修复）：summary 分支此前每次请求都全量重算
// 历史账户专用说明已从试用包移除。
// agent-round-view 盯盘轮 15min×2 店天天烧。T+1 特征日内不变，仅 today 信号层/dashboard
// 字段最多陈旧 TTL 秒，盯盘口径可接受。
const SUMMARY_CACHE_TTL_MS = 120 * 1000;
const summaryCache = new Map(); // `${account}|${date}|${topN}` -> { t, payload }
function summaryCacheGet(account, date, topN) {
  const k = `${account}|${date}|${topN}`;
  const e = summaryCache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > SUMMARY_CACHE_TTL_MS) { summaryCache.delete(k); return null; }
  return e.payload;
}
function summaryCacheSet(account, date, topN, payload) {
  if (summaryCache.size > 50) summaryCache.clear(); // 防膨胀（正常仅 账号×topN 个位数条目）
  summaryCache.set(`${account}|${date}|${topN}`, { t: Date.now(), payload });
}

// ═══════════════════════════════════════════════════════════
// 纯函数部分（IO 无关，可单测）
// ═══════════════════════════════════════════════════════════

/** AIGC 动态创意聚合行识别（§2.7）：仅按 id 前缀 AIGC::/LIVE::（与 routes/materialLifecycle.js 同口径）。
 *  2026-08-01 二轮审计 P1 修复：原同时按名称 /AIGC/i 匹配——编导若把真素材命名"AIGC口播-01"会被整条滤出榜单。
 *  name 参数保留仅兼容签名，不再参与判定。 */
function isAigcRow(materialId, name) {
  return /^(AIGC|LIVE)::/i.test(String(materialId || ''));
}

/**
  * 历史账户专用说明已从试用包移除。
 * 输入完整卡片数组（已按 mhs 降序），输出档位计数 + 每档 topN 精简卡。
 * @param {object[]} cards - handleMaterialScorecards 生成的完整卡片
 * @param {number} [perTier=5] - 每档取前 N 条
 * @returns {{tier_counts: object, top: object}}
 */
function buildSummary(cards, perTier = 5) {
  const tier_counts = { 优质: 0, 潜力: 0, 观察: 0, 劣质: 0, 无档: 0 };
  const top = { 优质: [], 潜力: [], 观察: [], 劣质: [] };
  for (const c of cards || []) {
    const t = c.tier || '无档';
    tier_counts[t] = (tier_counts[t] || 0) + 1;
    if (top[t] && top[t].length < perTier) {
      const slim = {
        material_id: c.material_id, name: c.name, mhs: c.mhs, tier: c.tier,
        today_cost: c.features && c.features.today_cost,
        today_roi: c.features && c.features.today_roi,
        cost_7d: c.features && c.features.cost_7d,
      };
      if (c.tier_orig) slim.tier_orig = c.tier_orig;
      if (c.tier_note) slim.tier_note = c.tier_note;
      if (c.features && c.features.fast_track) slim.fast_track = true; // 2026-08-02 快速通道标记透出盯盘轮（observe 动作不进精简卡，标记必须进）
      // 2026-08-06 盘中参考段透出（material_intraday，1h 口径仅参考；精简只带关键值）
      if (c.features && c.features.intraday && c.features.intraday.available) {
        const it = c.features.intraday;
        // 历史账户专用说明已从试用包移除。
        slim.intraday = { cost: it.cost, roi_1h: it.roi_1h, orders: it.orders, refund_rate: it.refund_rate, snapshot_time: it.snapshot_time };
      }
      top[t].push(slim);
    }
  }
  return { tier_counts, top };
}

/**
 * 追投 ROI 目标求解（§2.3/§4.2/§4.4：必须低于主计划 ROI 目标，同素材双出价竞争，无优势难跑量）。
 * @param {object} input - { min, max, planRoiGoal（主计划目标，取不到传 null） }
 * @returns {{suggested:number, why:string}|null} null=区间内无解（应进 suppressed）
 */
function resolveRoiGoal({ min, max, planRoiGoal }) {
  if (planRoiGoal == null) {
    return { suggested: min, why: `主计划 ROI 目标未获取，取区间下限 ${min}（§4.2 兜底）` };
  }
  const upper = Math.min(max, +(planRoiGoal - 0.01).toFixed(2));
  if (upper < min) return null; // 主计划目标已压到区间下限之下，无出价优势空间
  return { suggested: upper, why: `主计划目标 ${planRoiGoal}，追投目标 ${upper} 保持出价优势（<主计划）` };
}

/** 卡片 features 摘要：去掉 _daily 与顶层已提字段 */
function summarizeFeatures(feat) {
  const {
    _daily, mhs: _m, tier: _t, calibrated: _c, params_version: _v, age_decay: _a,
    ...rest
  } = feat;
  return rest;
}

/**
  * 历史账户专用说明已从试用包移除。
 * 数据源 liveCollector.todayMaterialMap（直播日内存态，**当日实时未结算**口径，与 T+1 特征分区展示）。
  * 历史账户专用说明已从试用包移除。
 *   当日耗 ≥ today_demote_min_cost(默认50) 且实时净 ROI < today_demote_max_roi(默认1.0)
 *   → 降为「观察」（标灰留在候选池，不消失；tier_orig 保留原档，tier_note 注明原因）。
 *   劣质档不降（劣质→观察是升级，违背规则意图）。
 * @param {object} feat - 单素材特征（原地修改）
 * @param {object|null} today - { cost, gmv, net, orders } 今日盘中实时（无数据传 null）
 * @param {object} [params] - MHS 参数（阈值随版本 params 走，缺省用默认值）
 * @returns {object} feat
 */
function applyTodaySignal(feat, today, params) {
  const p = params || {};
  const demoteCost = p.today_demote_min_cost != null ? p.today_demote_min_cost : 50;
  const demoteRoi = p.today_demote_max_roi != null ? p.today_demote_max_roi : 1.0;
  const t = today || { cost: 0, gmv: 0, net: 0, orders: 0 };
  feat.today_cost = +(+t.cost || 0).toFixed(2);
  feat.today_orders = +t.orders || 0;
  feat.today_roi = t.cost > 0 ? +(t.net / t.cost).toFixed(2) : null;
  feat.today_basis = '当日实时未结算';
  if ((feat.tier === '优质' || feat.tier === '潜力')
    && feat.today_cost >= demoteCost && feat.today_roi != null && feat.today_roi < demoteRoi) {
    const orig = feat.tier;
    feat.tier = '观察';
    feat.tier_orig = orig;
    feat.tier_note = `当日信号降级：今日耗 ${feat.today_cost} 元且实时净ROI ${feat.today_roi} <${demoteRoi}（未结算），${orig}档降观察标灰（V1.1-①）`;
  }
  return feat;
}

/**
 * 追投类建议装配：先过 checkBoostGate（§4.3 总闸），再过 planBoostChannel（§4.6 额度分流）。
 * 任一不通过 → 返回 { suppressed }；通过 → 返回 { action }（附 channel/budget/roi_goal/warnings）。
 */
function proposeBoost({ purpose, budget, roiGoalSpec, feat, ctx, why }) {
  const p = ctx.params;
  const isNewMaterial = (feat.age_days || 0) <= (p.cold_max_days != null ? p.cold_max_days : 2);
  const base = { type: 'create_boost', purpose, budget, roi_goal: roiGoalSpec || null, why };

  // 千川创建下限：预算必须 >100 元（create_boost 路由硬约束，低于此的建议无法执行）
  if (!(budget > 100)) {
    return { suppressed: { action: base, reasons: [`预算 ${budget} 元未过千川创建下限（>100 元），建议不可执行`] } };
  }

  const gate = mhs.checkBoostGate({
    features: feat,
    accountNetRoi: ctx.accountNetRoiToday,
    balance: ctx.balance,
    autoCreatedToday: ctx.fuse.autoCreatedToday,
    autoNewToday: ctx.fuse.autoNewToday,
    autoCostToday: ctx.fuse.autoCostToday,
    nextBudget: budget,
    todayNetRoi: ctx.accountNetRoiToday,
    isNewMaterial,
    params: p,
  });
  if (!gate.allowed) {
    return { suppressed: { action: base, reasons: gate.reasons } };
  }

  const plan = mhs.planBoostChannel({ purpose, budget, quotaLeft: ctx.quotaLeft, params: p });
  if (!plan.executable) {
    return { suppressed: { action: base, reasons: [plan.why, ...plan.warnings] } };
  }

  return {
    action: {
      ...base,
      executable: true,
      channel: plan.channel,
      budget: plan.budget,
      duration_hours: plan.duration_hours,
      warnings: plan.warnings,
      gate: 'checkBoostGate+planBoostChannel 通过',
    },
  };
}

/** 删除评估动作登记（去重：同卡多触发源合并 why） */
function addDeleteEval(actions, trigger, why, evidence, feat, params) {
  let existing = actions.find(a => a.type === 'delete_material_eval');
  const headShare = params.head_cost_share != null ? params.head_cost_share : 0.1;
  const headWarning = (feat.cost_share_7d || 0) >= headShare
    ? `头部GMV素材（近7天消耗占比 ${feat.cost_share_7d} ≥ ${headShare}），禁止直接删除，须先降量过渡（§2.5/§4.2）`
    : null;
  if (existing) {
    existing.trigger += '+' + trigger;
    existing.why += '；' + why;
    Object.assign(existing.evidence, evidence);
    if (headWarning && !existing.warnings.includes(headWarning)) existing.warnings.push(headWarning);
    return;
  }
  actions.push({
    type: 'delete_material_eval',
    executable: false, // 仅供 agent 提交 pending-ops，不直接执行
    trigger,
    why,
    evidence,
    warnings: headWarning ? [headWarning] : [],
  });
}

/**
 * 单素材决策卡动作生成（纯函数核心）。
 * @param {object} feat - computeAccountFeatures 的单素材特征（含 _daily）
 * @param {object} ctx - 上下文（全部由路由 IO 层注入，可 stub）：
 *   { endDate, params, breakEven, killLine, accountCtr7d,
 *     quotaLeft, planRoiGoal, balance, accountNetRoiToday,
 *     fuse: { autoCreatedToday, autoNewToday, autoCostToday },
 * @returns {{actions: object[], suppressed: object[]}}
 */
function buildCardActions(feat, ctx) {
  const actions = [];
  const suppressed = [];
  const p = ctx.params;
  const materialName = feat._name || '';
  const endDate = ctx.endDate;

  // §2.7：AIGC 动态创意聚合行不按普通素材处置（不删除/不降档/不追投）
  if (isAigcRow(feat._material_id, materialName)) {
    return { actions, suppressed, note: 'AIGC 动态创意聚合行，不按普通素材处置（§2.7），治本路径为清理低质输入原素材' };
  }

  // ── 1. 冷启动通道（§4.4，独立通道优先于主公式/删除子模型）──
  // 2026-08-01 二轮审计 P1：判死素材与追投动作互斥（声明在通道外，步骤3/4共用——见步骤2注释）
  let deleteFlagged = false;
  const cold = mhs.judgeColdStart(feat._daily || [], {
    endDate,
    accountCtr7d: ctx.accountCtr7d,
    createdAt: feat.first_cost_date,
    params: p,
  });
  if (cold.isCold) {
    if (cold.verdict === '转培养') {
      const budget = p.cold_group_budget != null ? p.cold_group_budget : 300;
      const roiMin = p.cold_roi_goal_min != null ? p.cold_roi_goal_min : 1.5;
      const roiMax = p.cold_roi_goal_max != null ? p.cold_roi_goal_max : 1.89;
      const roiGoal = resolveRoiGoal({ min: roiMin, max: roiMax, planRoiGoal: ctx.planRoiGoal });
      if (!roiGoal) {
        suppressed.push({
          action: { type: 'create_boost', purpose: '新素材测试', budget, why: cold.why },
          reasons: [`roi_goal 区间 [${roiMin}, ${roiMax}] 无法低于主计划目标 ${ctx.planRoiGoal}，无出价优势空间`],
        });
      } else {
        const r = proposeBoost({
          purpose: '新素材测试', budget, roiGoalSpec: roiGoal, feat, ctx,
          why: `冷启动转培养：${cold.why}；组级预算口径（可与同批新素材合组一个组合任务，§4.4）`,
        });
        if (r.action) actions.push(r.action); else suppressed.push(r.suppressed);
      }
    } else if (cold.verdict === '止损候选') {
      addDeleteEval(actions, '冷启动止损候选', `冷启动 0 成交：${cold.why}`, { cold_signals: cold.signals }, feat, p);
    } else {
      actions.push({ type: 'observe', executable: false, why: cold.why, evidence: { cold_signals: cold.signals } });
    }
    // 冷启动通道内不再走删除子模型与 tier 逻辑（§4.4 独立通道）。
  } else if (feat.fast_track === true) {
    actions.push({
      type: 'observe',
      executable: false,
      why: '信号闸快速通道：' + (feat.tier_note || '无信号高ROI苗子'),
      evidence: { cost_7d: feat.cost_7d, net_roi_7d: feat.net_roi_7d },
    });
  } else {
    // ── 2. 删除子模型（§5.1：先急性衰退，后慢性亏损）──
    // 2026-08-01 二轮审计 P1：判死素材与追投动作互斥——触发删除评估后，步骤3/4不再追加 create_boost，
    // 防同一张卡同时出现"建议删除"+"建议追投"矛盾动作（急性衰退的素材 7 天窗仍可能是优质档/当月ROI够冲线）。
    const acute = mhs.judgeAcuteDecline(feat._daily || [], { endDate, killLine: ctx.killLine, params: p, breakEven: ctx.breakEven, ageDays: feat.age_days, avgOrder: ctx.avgOrder, accountId: ctx.account, materialName: materialName });
    if (acute.triggered) {
      deleteFlagged = true;
      addDeleteEval(actions, '急性衰退·死缓48h',
        `急性衰退双闸门触发（死缓48h）：${acute.gateA.why}；${acute.gateB.why}`,
        { gateA: acute.gateA, gateB: acute.gateB, cpaOverride: acute.cpaOverride, surgeProtect: acute.surgeProtect, seasonalExempt: acute.seasonalExempt }, feat, p);
    } else {
      const chronic = mhs.judgeChronicLoss(feat, { breakEven: ctx.breakEven, params: p, daily: feat._daily, endDate, avgOrder: ctx.avgOrder, accountId: ctx.account, materialName: materialName });
      if (chronic.triggered) {
        deleteFlagged = true;
        addDeleteEval(actions, '慢性亏损', chronic.why, { chronic }, feat, p);
      }
    }

    // ── 3. 已标定主公式档位动作（§4.2）──
    if (feat.calibrated && !deleteFlagged) {
      const roiMin = p.boost_roi_goal_min != null ? p.boost_roi_goal_min : 1.89;
      const roiMax = p.boost_roi_goal_max != null ? p.boost_roi_goal_max : 2.15;
      if (feat.tier === '优质') {
        const budget = feat.role === '跑量担当' ? 500 : 300;
        const roiGoal = resolveRoiGoal({ min: roiMin, max: roiMax, planRoiGoal: ctx.planRoiGoal });
        if (!roiGoal) {
          suppressed.push({
            action: { type: 'create_boost', purpose: '优质放大', budget, why: '优质档放大' },
            reasons: [`roi_goal 区间 [${roiMin}, ${roiMax}] 无法低于主计划目标 ${ctx.planRoiGoal}，无出价优势空间`],
          });
        } else {
          const r = proposeBoost({
            purpose: '优质放大', budget, roiGoalSpec: roiGoal, feat, ctx,
            why: `优质档放大（MHS ${feat.mhs}，${feat.role}，预算口径 ${budget} 元）`,
          });
          if (r.action) actions.push(r.action); else suppressed.push(r.suppressed);
        }
      } else if (feat.tier === '潜力' && (feat.trend_score || 0) > 0) {
        const roiGoal = resolveRoiGoal({ min: roiMin, max: roiMax, planRoiGoal: ctx.planRoiGoal });
        if (!roiGoal) {
          suppressed.push({
            action: { type: 'create_boost', purpose: '优质放大', budget: 200, why: '潜力档培养（小额）' },
            reasons: [`roi_goal 区间 [${roiMin}, ${roiMax}] 无法低于主计划目标 ${ctx.planRoiGoal}，无出价优势空间`],
          });
        } else {
          const r = proposeBoost({
            purpose: '优质放大', budget: 200, roiGoalSpec: roiGoal, feat, ctx,
            why: `潜力档培养（MHS ${feat.mhs}，趋势分为正，小额 150~300 取 200）`,
          });
          if (r.action) actions.push(r.action); else suppressed.push(r.suppressed);
        }
      } else if (feat.tier === '劣质' && (feat.trend_score || 0) < 0) {
        addDeleteEval(actions, '劣质档', `劣质档且趋势分为负（MHS ${feat.mhs} < t_lie，trend ${feat.trend_score}）`,
          { mhs: feat.mhs, trend_score: feat.trend_score }, feat, p);
      }
    }
  }

  return { actions, suppressed };
}

// ═══════════════════════════════════════════════════════════
// IO 层（路由 handler）
// ═══════════════════════════════════════════════════════════

/** 回环拉 live-dashboard（15s 超时）；失败返回 null，调用方全部置 null 并标注 */
async function fetchDashboard(account) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/live-dashboard?account=${encodeURIComponent(account)}&full=1`, {
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * 今日 auto create_boost 熔断计数（口径参照 routes/pendingOps.js countAutoBoostToday）：
 *   条数 = 今日已 executed 且 result.auto===true 的 create_boost；
 *   新素材条数 = 其中 params.isNew===true 或 reason 含 冷启动/新素材 的；
 *   合计预算 = 这些建议 params.budget 之和（提交时口径，实际消耗以盘面为准）。
 */
function countAutoBoostFuse(account) {
  // 2026-08-01 二轮审计 P1：跨天判定统一北京自然日（utils.beijingDay）——服务器迁 UTC 后 toDateString 按 UTC 划日会提前清零
  const todayStr = beijingDay();
  const items = pendingOps.list({ account, status: 'executed' }).filter(it =>
    it.type === 'create_boost' &&
    it.result && it.result.auto === true &&
    it.decided_at && beijingDay(it.decided_at) === todayStr);
  return {
    autoCreatedToday: items.length,
    autoNewToday: items.filter(it =>
      (it.params && it.params.isNew === true) || /冷启动|新素材/.test(it.reason || '')).length,
    autoCostToday: items.reduce((s, it) => s + ((it.params && +it.params.budget) || 0), 0),
  };
}

async function handleMaterialScorecards(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);

  let account;
  try {
    account = validateAccount(url.searchParams.get('account'));
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }
  const date = url.searchParams.get('date') || yesterday();
  if (!validateDateRange(date, date)) {
    return sendJSON(res, { ok: false, error: `date 格式非法: ${date}（YYYY-MM-DD）` }, 400);
  }

  // summary 缓存命中直接返回（P0：跳过后续全量重算）
  const isSummary = (url.searchParams.get('mode') || '') === 'summary';
  const summaryTopN = Math.min(50, Math.max(1, parseInt(url.searchParams.get('top_n') || '5', 10) || 5));
  if (isSummary) {
    const hit = summaryCacheGet(account, date, summaryTopN);
    if (hit) return sendJSON(res, hit);
  }

  try {
    // 1. 特征快照（公式层）
    const { features, endDate, params, calibrated, version, account: accCtx } = mhs.computeAccountFeatures(account, date);

    // 2. 盘面数据（额度/主计划目标/余额/今日净ROI）；失败全 null + 标注
    const dash = await fetchDashboard(account);
    const quotaLeft = dash && dash.plan && dash.plan.quota_left != null ? +dash.plan.quota_left : null;
    const planRoiGoal = dash && dash.plan && dash.plan.roi_goal != null ? +dash.plan.roi_goal : null;
    const balance = dash && dash.balance && dash.balance.total_yuan != null ? +dash.balance.total_yuan : null;
    const netRoiToday = dash && dash.today && dash.today.netRoi != null ? +dash.today.netRoi : null;

    // 3. 熔断计数
    const fuse = countAutoBoostFuse(account);
    const accParams = getAccountParams(account);
    // 斩杀线：客单价×kill_line_factor（MHS 参数，2026-07-28 反推收敛，兜底 100）
    const killFactor = params.kill_line_factor != null ? params.kill_line_factor : 2;
    const killLine = accParams.avg_order_price ? +(accParams.avg_order_price * killFactor).toFixed(2) : 100;

    // 4. 素材名（该素材最新 material_name）
    const db = getDB();
    const nameStmt = db.prepare(`
      SELECT material_name FROM material_daily
      WHERE account_id = ? AND material_id = ? AND material_name IS NOT NULL AND material_name != ''
      ORDER BY stat_date DESC LIMIT 1
    `);

    const quotaWarnings = new Set();
    if (!dash) quotaWarnings.add('live-dashboard 取数失败，quota_left/主计划目标/余额/今日净ROI 均置 null（保守不输出可执行追投建议）');
    if (quotaLeft != null && quotaLeft < (params.quota_warn_line != null ? params.quota_warn_line : 300)) {
      quotaWarnings.add(`额度紧张预警：剩余额度 ${quotaLeft} < ${params.quota_warn_line != null ? params.quota_warn_line : 300}`);
    }

    // V1.1-① 今日盘中实时素材数据（当日实时未结算口径；无直播日内存态时今日字段全 0/null，不阻断）
    // 2026-08-06 分身需求：非直播时段（停播期/下播后）回退读盘中库 material_intraday（商品卡 30 分钟快照），
    // 让商品卡素材当日表现差也能触发哑火降级。边界：只参与降级，不参与判杀/止损（buildCardActions 不读 intraday）。
    let todayMap = {};
    try { todayMap = require('../lib/liveCollector').todayMaterialMap(account) || {}; } catch { /* 未直播/采集未就绪 */ }
    let intradayFallback = null;
    try {
      const snaps = require('../lib/intradayStore').getLatestSnapshots(account, beijingDay());
      if (snaps && snaps.length) {
        intradayFallback = new Map(snaps.map(s => [String(s.material_id), {
          cost: +s.cost || 0,
          net: +s.net_gmv_1h || 0,
          orders: Math.round(+s.orders || 0),
          basis: '盘中库(1h口径)',
        }]));
      }
    } catch { /* 盘中库不可用不阻断 */ }

    const cards = [];
    let suppressedCount = 0;
    for (const [mid, feat] of features) {
      let name = '';
      try { name = (nameStmt.get(account, mid) || {}).material_name || ''; } catch { /* 名单缺失不阻断 */ }
      feat._material_id = mid;
      feat._name = name;

      // V1.1-⑤ AIGC 动态创意聚合行过滤出榜单（官方：不按普通素材处置；buildCardActions 内 §2.7 豁免动作，此处连同卡片一并滤掉）
      if (isAigcRow(mid, name)) continue;

      // V1.1-① 今日信号层：盘中实时三字段 + 优质/潜力档哑火降级（耗≥50 且实时净ROI<1.0 → 观察标灰）
      // 2026-08-06 分身需求：内存态无数据或消耗为 0（停播期/下播后/商品卡渠道）回退盘中库
      let todayData = todayMap[mid] || null;
      let todayBasis = '当日实时未结算';
      if (intradayFallback && intradayFallback.has(String(mid))) {
        const fb = intradayFallback.get(String(mid));
        const memHasCost = todayData && (+todayData.cost || 0) > 0;
        if (!memHasCost && fb.cost > 0) { // 内存态无消耗（直播榜不含/商品卡渠道）→ 用盘中库
          todayData = fb;
          todayBasis = fb.basis;
        }
      }
      applyTodaySignal(feat, todayData, params);
      if (todayBasis !== '当日实时未结算' && todayData) feat.today_basis = todayBasis; // 标注数据源（盘中库1h口径）

      const { actions, suppressed, note } = buildCardActions(feat, {
        endDate,
        account,  // V1.6 节令豁免需要 accountId
        params,
        breakEven: accParams.break_even_roi,
        avgOrder: accParams.avg_order_price,
        killLine,
        accountCtr7d: accCtx.ctr_7d,
        quotaLeft,
        planRoiGoal,
        balance,
        accountNetRoiToday: netRoiToday,
        fuse,
      });
      for (const a of actions) {
        // 2026-08-01 二轮审计 P2：只收集追投动作的额度警告进账号级 quota.warnings；
        // delete_material_eval 的头部GMV警告是素材级（仍留在卡片 action.warnings），不污染账号额度口径
        if (a.type === 'create_boost' && Array.isArray(a.warnings)) a.warnings.forEach(w => quotaWarnings.add(w));
      }
      suppressedCount += suppressed.length;
      const card = {
        material_id: mid,
        name,
        mhs: feat.mhs,
        tier: feat.tier,
        calibrated: feat.calibrated,
        no_signal: feat.no_signal || false,
        features: summarizeFeatures(feat),
        actions,
      };
      if (feat.tier_orig) card.tier_orig = feat.tier_orig; // V1.1-① 降级前原档
      if (feat.tier_note) card.tier_note = feat.tier_note; // V1.1 档位修正原因（降级/豁免）
      if (suppressed.length) card.suppressed = suppressed;
      if (note) card.note = note;
      cards.push(card);
    }

    // 5. 排序：mhs 降序（null 最后），同分按 cost_7d 降序
    cards.sort((a, b) => {
      if (a.mhs == null && b.mhs == null) return (b.features.cost_7d || 0) - (a.features.cost_7d || 0);
      if (a.mhs == null) return 1;
      if (b.mhs == null) return -1;
      if (b.mhs !== a.mhs) return b.mhs - a.mhs;
      return (b.features.cost_7d || 0) - (a.features.cost_7d || 0);
    });

    // 历史账户专用说明已从试用包移除。
    if (isSummary) {
      const { tier_counts, top } = buildSummary(cards, summaryTopN);
      const selectedCount = Object.values(top || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
      const scoredCount = cards.filter(card => card.mhs != null).length;
      const payload = {
        ok: true,
        account,
        date: endDate,
        mode: 'summary',
        calibrated,
        params_version: version,
        algorithm: {
          family: 'MHS Daily',
          version: version || null,
          window: 't_plus_1_daily_lifecycle',
          selection_method: 'top_per_tier',
          total_material_count: cards.length,
          scored_material_count: scoredCount,
          selected_material_count: selectedCount,
          scored_coverage_ratio: cards.length ? +Math.min(1, scoredCount / cards.length).toFixed(3) : null,
          response_coverage_ratio: cards.length ? +Math.min(1, selectedCount / cards.length).toFixed(3) : null,
          coverage_ratio: cards.length ? +Math.min(1, selectedCount / cards.length).toFixed(3) : null, // 兼容旧调用方
        },
        quota: { quota_left: quotaLeft, warnings: [...quotaWarnings] },
        account_gate: { balance, net_roi_today: netRoiToday, plan_roi_goal: planRoiGoal },
        dashboard_error: dash ? undefined : 'live-dashboard 回环取数失败',
        tier_counts,
        top,
        suppressed_count: suppressedCount,
      };
      summaryCacheSet(account, date, summaryTopN, payload);
      return sendJSON(res, payload);
    }

    return sendJSON(res, {
      ok: true,
      account,
      date: endDate,
      calibrated,
      params_version: version,
      quota: { quota_left: quotaLeft, warnings: [...quotaWarnings] },
      account_gate: { balance, net_roi_today: netRoiToday, plan_roi_goal: planRoiGoal },
      dashboard_error: dash ? undefined : 'live-dashboard 回环取数失败',
      cards,
      suppressed_count: suppressedCount,
    });
  } catch (e) {
    console.error('[scorecards] 异常:', e);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialScorecards;
module.exports._test = {
  isAigcRow,
  resolveRoiGoal,
  summarizeFeatures,
  buildSummary,
  applyTodaySignal,
  proposeBoost,
  buildCardActions,
  countAutoBoostFuse,
};
