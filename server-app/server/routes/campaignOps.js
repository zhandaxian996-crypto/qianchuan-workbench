const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, getLocalDateStr, checkBodyKeys } = require('../lib/utils');
const { updateCampaignStatus, updateCampaignBudgetAndROI, fetchPlanCurrentValues } = require('../lib/qianchuan');
const { fetchUniPromMaterials, fetchBoostList, fetchUniPromAdList } = require('../lib/qianchuanTabs');
const { describeResult } = require('../lib/qcErrors');
const opLog = require('../lib/operationLog');
const { validateRoiGoalWrite } = require('../lib/roiBasis');
const { getActionLimits, assertActionAllowed, resumeProtection } = require('../lib/actionLimits');
const { executeWithReceipt, normalizedTarget } = require('../lib/writeReceipt');

// 写操作熔断常量（对齐 AGENTS.md 规范）
const MAX_CHANGE_RATIO = 0.5;               // 预算单次调整幅度>50%→拦截（衰减止损需要 −33~−50% 收口，维持不变）
// 服务端 ROI 护栏：单次变化不超过 10%，并要求至少 30 分钟冷却。
// 历史账户专用说明已从试用包移除。
const MAX_ROI_CHANGE_RATIO = 0.10;          // ROI 单次调整幅度>10%→拦截
const ROI_MIN_INTERVAL_MS = 30 * 60 * 1000; // 同一目标相邻两次成功 ROI 调整间隔 <30 分钟→拦截429

const { withTargetWriteLock } = require('../lib/targetWriteLock');

async function handleCampaignMaterials(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);

  const adId = url.searchParams.get('adId');
  if (!adId) return sendJSON(res, { ok: false, error: 'Missing adId' }, 400);

  const start = url.searchParams.get('start') || getLocalDateStr();
  const end = url.searchParams.get('end') || getLocalDateStr();
  const account = url.searchParams.get('account') || undefined;

  try {
    const result = await fetchUniPromMaterials(adId, start, end, account);
    return sendJSON(res, { ok: true, data: result });
  } catch (e) {
    return handleApiError(res, e);
  }
}

async function handleCampaignStatus(req, res, url) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修）
  const bodyCheck = checkBodyKeys(data, ['accountId', 'primaryAdId', 'assistTaskId', 'status', 'source'], '/api/campaign/status');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

  const { primaryAdId, assistTaskId, status, accountId: accountIdCamel, account_id: accountIdSnake } = data;
  const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）
  if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
  // 账号白名单：拼错的账号会回落默认 cookie，对错账号执行写操作（2026-07-25 审查修复）
  try { require('../lib/api-helpers').validateAccount(accountId); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }
  if ((!primaryAdId && !assistTaskId) || status == null) {
    return sendJSON(res, { ok: false, error: 'Missing primaryAdId/assistTaskId or status (1=enable, 2=pause, 6=stop)' }, 400);
  }
  const statusNum = parseInt(status, 10);
  if (![1, 2, 6].includes(statusNum)) {
    return sendJSON(res, { ok: false, error: 'status must be 1 (enable), 2 (pause) or 6 (stop)' }, 400);
  }

  // ===== 硬规则：禁止暂停/停止计划（计划一旦关闭会断掉所有投放，只能暂停/停止追投任务）=====
  // 运营铁律：计划不能关闭。status=2/6 且无 assistTaskId = 操作计划本身 → 直接拦截
  if ((statusNum === 2 || statusNum === 6) && !assistTaskId) {
    opLog.log({
      action: 'pause_blocked',
      account_id: accountId,
      primary_ad_id: primaryAdId,
      target_type: 'plan',
      target_id: primaryAdId,
      params: { status: statusNum },
      success: false,
      result_msg: '禁止暂停计划（运营铁律：计划不能关闭，只能调整预算/ROI或暂停单个追投任务）',
      source: opLog.normalizeSource(data.source), // 决策来源归因：K3/回环带 'agent'，其余视为投手（ruleStats 胜率统计）
    });
    return sendJSON(res, {
      ok: false,
      error: '禁止暂停计划（运营铁律：计划不能关闭）。如需控制消耗请调整预算/ROI，或暂停单个追投任务（需传 assistTaskId）',
      blocked: true,
      rule: 'plan_pause_forbidden',
    }, 403);
  }

  const action = statusNum === 2 ? 'pause' : statusNum === 6 ? 'stop' : 'enable';
  const targetType = assistTaskId ? 'boost_task' : 'plan';
  const targetId = assistTaskId || primaryAdId;
  let oldStatus = null;

  try {
    const result = await withTargetWriteLock(accountId, targetId, async () => {
      // 启停独立于调参额度；仍串行化、回读，不代替上游权限。

      // 写前读取真实对象；无法核验时阻断，不能把接受请求当作状态生效。
      if (assistTaskId) {
        try {
          const d7 = new Date(); d7.setDate(d7.getDate() - 7);
          const d7Str = d7.getFullYear() + '-' + String(d7.getMonth() + 1).padStart(2, '0') + '-' + String(d7.getDate()).padStart(2, '0');
          const boostList = await fetchBoostList(primaryAdId, d7Str, getLocalDateStr(), accountId, { includeAllStatus: true });
          const adInfos = (boostList && boostList.data && boostList.data.adInfos) || [];
          const task = adInfos.find(ad => String(ad.id) === String(assistTaskId));
          if (task) {
            oldStatus = task.status ?? null;
            if (statusNum === 1 && opLog.normalizeSource(data.source) === 'agent') {
              const protection = resumeProtection(accountId, targetId, task.adDeliveryName || task.status, require('../lib/utils').isPassiveStop(task.adDeliveryName));
              if (!protection.allowed) throw Object.assign(new Error(protection.reason), { statusCode: 423, code: protection.reason, skipOpLog: true });
            }
            const operation = task.assistTaskInfoMap?.['2']?.operation?.[statusNum === 1 ? 'start' : 'stop'];
            if (operation?.editable === false) throw Object.assign(new Error(operation.reason || 'upstream_action_blocked'), { statusCode: 423, code: 'upstream_action_blocked', skipOpLog: true });
          }
        } catch (e) {
          if (e.skipOpLog) throw e;
          console.warn('[熔断] 拉取旧状态失败:', e.message);
        }
      } else {
        oldStatus = (await fetchPlanCurrentValues(primaryAdId, accountId)).status ?? null;
      }
      if (oldStatus == null) throw Object.assign(new Error('target_status_unavailable'), { statusCode: 423, code: 'target_status_unavailable', skipOpLog: true });
      if (oldStatus === statusNum) return { ok: true, effect_status: 'unchanged', operation_id: null,
        before: { status: oldStatus }, requested: { status: statusNum }, actual: { status: oldStatus },
        readback: { verified: true }, message: '状态已一致，未重复提交', retry_write: false };
      return executeWithReceipt({
        write: () => updateCampaignStatus(primaryAdId, assistTaskId, statusNum, accountId),
        read: () => readTargetValues(accountId, primaryAdId, assistTaskId),
        before: { status: oldStatus }, requested: { status: statusNum },
        logEntry: { action, account_id: accountId, primary_ad_id: primaryAdId, assist_task_id: assistTaskId,
          target_type: targetType, target_id: targetId, params: { status: statusNum, old_status: oldStatus }, source: opLog.normalizeSource(data.source) },
      });
    });
    if (!result.ok) return sendJSON(res, result, result.http_status || 502);
    // 主计划本身启停成功 → 主动失效 dashboard 计划缓存（追投任务不影响主计划卡，跳过）
    if (!assistTaskId) { try { require('./liveDashboard').invalidatePlanCache(accountId); } catch (e) { console.warn('[缓存失效] 主计划缓存清理失败:', e.message); } }
    return sendJSON(res, result);
  } catch (e) {
    // 异常也记日志（频率熔断拦截除外）
    if (!e.skipOpLog) {
      opLog.log({
        action,
        account_id: accountId,
        primary_ad_id: primaryAdId,
        assist_task_id: assistTaskId,
        target_type: targetType,
        target_id: targetId,
        params: { status: statusNum, old_status: oldStatus },
        success: false,
        result_msg: e.message,
        source: opLog.normalizeSource(data.source),
      });
    }
    return handleApiError(res, e);
  }
}

async function handleCampaignBudget(req, res, url) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修）
  const bodyCheck = checkBodyKeys(data, ['accountId', 'account_id', 'primaryAdId', 'assistTaskId', 'budget', 'roiGoal', 'roiBasis', 'roi_basis', 'bid', 'audienceTemplate', 'source', 'userDirective'], '/api/campaign/budget');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

  const { primaryAdId, assistTaskId, budget, roiGoal, accountId: accountIdCamel, account_id: accountIdSnake, roiBasis: roiBasisCamel, roi_basis: roiBasisSnake, bid, audienceTemplate, userDirective } = data;
  const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）
  const roiBasis = roiBasisCamel != null ? roiBasisCamel : roiBasisSnake;
  if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
  // 账号白名单：拼错的账号会回落默认 cookie，对错账号执行写操作（2026-07-25 审查修复）
  try { require('../lib/api-helpers').validateAccount(accountId); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }
  if ((!primaryAdId && !assistTaskId)) {
    return sendJSON(res, { ok: false, error: 'Missing primaryAdId or assistTaskId' }, 400);
  }
  // 有 assistTaskId 时 primaryAdId 也必填（追投更新需要它拉任务信息）
  if (assistTaskId && !primaryAdId) {
    return sendJSON(res, { ok: false, error: '改追投时必须同时传 primaryAdId（全域计划ID）' }, 400);
  }
  // budget、roiGoal、bid、audienceTemplate 至少传一个（支持单独改定向/出价/ROI/预算）
  if (budget == null && roiGoal == null && bid == null && audienceTemplate == null) {
    return sendJSON(res, { ok: false, error: 'At least one of budget, roiGoal, bid or audienceTemplate must be provided' }, 400);
  }

  const budgetNum = budget != null ? parseFloat(budget) : undefined;
  const roiNum = roiGoal != null ? parseFloat(roiGoal) : undefined;
  const bidNum = bid != null ? parseFloat(bid) : undefined;
  if (bidNum !== undefined && (!Number.isFinite(bidNum) || bidNum <= 0)) {
    return sendJSON(res, { ok: false, error: 'bid must be a positive number' }, 400);
  }

  // 校验传了的值
  if (budgetNum !== undefined) {
    // 追投预算必须 > 100元（千川限制），计划预算必须 > 0
    const minBudget = assistTaskId ? 100 : 0;
    if (!Number.isFinite(budgetNum) || budgetNum <= minBudget || budgetNum > 10000000) {
      const hint = assistTaskId ? '（追投预算必须大于100元）' : '';
      return sendJSON(res, { ok: false, error: `budget must be greater than ${minBudget} and up to 10,000,000${hint}` }, 400);
    }
  }
  if (roiNum !== undefined) {
    if (!Number.isFinite(roiNum) || roiNum < 0.01 || roiNum > 100) {
      return sendJSON(res, { ok: false, error: 'roiGoal must be a number between 0.01 and 100' }, 400);
    }
  }

  // 口径核对先于任何 ROI 写入护栏和上游调用。传入声明不能替代真实计划元数据；
  // 元数据未知时只阻断 ROI 修改，预算、定向、暂停等动作仍按原链路可用。
  let roiContract = null;
  if (roiNum !== undefined) {
    const targetMetadata = await fetchTargetOptimizationMetadata({ accountId, primaryAdId, assistTaskId });
    roiContract = validateRoiGoalWrite({ providedBasis: roiBasis, entity: targetMetadata });
    if (!roiContract.ok) {
      const { status, ...payload } = roiContract;
      return sendJSON(res, payload, status || 400);
    }
  }

  // ===== 手动出价模式校验：手动出价的追投不支持改ROI =====
  if (assistTaskId && roiNum !== undefined) {
    try {
      const { fetchBoostList } = require('../lib/qianchuanTabs');
      const d7 = new Date(); d7.setDate(d7.getDate() - 7);
      const d7Str = d7.getFullYear() + '-' + String(d7.getMonth() + 1).padStart(2, '0') + '-' + String(d7.getDate()).padStart(2, '0');
      const todayStr0 = getLocalDateStr();
      // 写操作场景不用 AdStatusFilterType:28，避免过滤掉暂停状态的追投
      const boostList = await fetchBoostList(primaryAdId, d7Str, todayStr0, accountId, { includeAllStatus: true });
      const adInfos = (boostList && boostList.data && boostList.data.adInfos) || [];
      const task = adInfos.find(ad => String(ad.id) === String(assistTaskId));
      if (task && (task.smartBidType || 0) === 0 && task.bid) {
        // 手动出价模式（smartBidType=0 且有 bid），不支持改ROI
        return sendJSON(res, { ok: false, error: `追投任务 ${assistTaskId} 是手动出价模式（出价${task.bid/100000}元），不支持修改ROI。请改预算` }, 400);
      }
    } catch (e) {
      // 拉取失败不阻塞，后续幅度限制会再拉一次
    }
  }

  // ===== 熔断机制：防误操作 =====
  const targetId = assistTaskId || primaryAdId;

  // 频率熔断 + 幅度限制 + 执行操作（全部在写锁内串行化，防止并发请求绕过熔断/幅度校验）
  try {
    const result = await withTargetWriteLock(accountId, targetId, async () => {
      if (roiNum !== undefined) {
        roiContract = validateRoiGoalWrite({ providedBasis: roiBasis, entity: await fetchTargetOptimizationMetadata({ accountId, primaryAdId, assistTaskId }) });
        if (!roiContract.ok) throw Object.assign(new Error(roiContract.error || 'roi_basis_required'), { statusCode: roiContract.status || 400, code: roiContract.code, details: roiContract, skipOpLog: true });
      }
      const recentLogs = opLog.query({ adId: targetId, accountId, limit: 50 });
      const now = Date.now();

      // 1. 频率熔断：同一目标1小时内修改超过3次 → 拦截
      // ROI 独立 30 分钟冷却；预算/出价/定向累计 3 次/小时；启停不计。
      const limits = getActionLimits(accountId, targetId, now);
      if (budgetNum !== undefined || bidNum !== undefined || audienceTemplate !== undefined) assertActionAllowed(limits, 'update_budget');

      // 1b. ROI 硬锁（仅改 ROI 时）：同一目标相邻两次成功调整间隔 <30 分钟 → 429。
      // 这是本地不可绕过护栏，不宣称为平台官方限制。
      if (roiNum !== undefined) {
        // 专用单行查询，不受 recentLogs limit 截断；DB 异常会抛出并使写请求 fail-closed。
        const lastRoiOp = opLog.getLastSuccessfulRoiUpdate(accountId, targetId);
        if (lastRoiOp) {
          const gap = now - new Date(lastRoiOp.ts).getTime(); // op-log 存本地时间，不带 'Z'
          if (gap < ROI_MIN_INTERVAL_MS) {
            const waitMin = Math.ceil((ROI_MIN_INTERVAL_MS - gap) / 60000);
            const err = new Error(`ROI调整过于频繁：距上次成功调整（${lastRoiOp.ts}）不足30分钟，请约 ${waitMin} 分钟后再试`);
            err.statusCode = 429;
            err.next_allowed_at = new Date(new Date(lastRoiOp.ts).getTime() + ROI_MIN_INTERVAL_MS).toISOString();
            err.skipOpLog = true; // 熔断拦截不写 op-log
            throw err;
          }
        }
      }

      // 2. 同天修改次数告警：同一目标今天已修改超过5次 → 告警
      const todayStr = getLocalDateStr();
      const todayOps = recentLogs.filter(l => l.ts.startsWith(todayStr) && l.success);
      if (todayOps.length >= 5) {
        console.warn(`[熔断告警] 目标 ${targetId} 今天已修改 ${todayOps.length} 次，超过5次上限`);
        // 告警但不拦截（让操作通过，但记录告警）
      }

      // 3. 获取操作前旧值（从千川拉取）
      let oldValue = null;
      if (assistTaskId) {
        // 追投：从 boost-list 拉当前值
        try {
          const { fetchBoostList } = require('../lib/qianchuanTabs');
          const d7 = new Date(); d7.setDate(d7.getDate() - 7);
          const d7Str = d7.getFullYear() + '-' + String(d7.getMonth() + 1).padStart(2, '0') + '-' + String(d7.getDate()).padStart(2, '0');
          const todayStr2 = getLocalDateStr();
          const boostList = await fetchBoostList(primaryAdId, d7Str, todayStr2, accountId, { includeAllStatus: true });
          const adInfos = (boostList && boostList.data && boostList.data.adInfos) || [];
          const task = adInfos.find(ad => String(ad.id) === String(assistTaskId));
          if (task) {
            const editable = task.assistTaskInfoMap?.['2']?.operation?.edit;
            if (editable?.editable === false) throw Object.assign(new Error(editable.reason || 'upstream_action_blocked'), { statusCode: 423, code: 'upstream_action_blocked', skipOpLog: true });
            oldValue = {
              budget: task.budget == null ? null : Number(task.budget) / 100000,
              roiGoal: task.ecpRoi2Goal == null ? null : Number(task.ecpRoi2Goal),
              bid: task.bid == null ? null : Number(task.bid) / 100000,
              audience: task.audience || null,
              smartBidType: task.smartBidType == null ? null : Number(task.smartBidType),
            };
          }
        } catch (e) {
          if (e.skipOpLog) throw e;
          console.warn('[熔断] 拉取旧值失败:', e.message);
        }
      } else {
        // 非追投（全域计划本身）：从计划列表拉当前值
        try {
          const current = await fetchPlanCurrentValues(primaryAdId, accountId);
          if (current.budget > 0 || current.roiGoal > 0) {
            oldValue = { budget: current.budget, roiGoal: current.roiGoal };
          }
        } catch (e) {
          console.warn('[熔断] 拉取计划旧值失败:', e.message);
        }
      }

      // 拉不到旧值时拒绝操作（安全优先）
      if (!oldValue) {
        const err = new Error(`无法获取目标 ${targetId} 的当前值，幅度校验无法执行，拒绝操作以保护安全`);
        err.statusCode = 423;
        throw err;
      }
      if ((budgetNum !== undefined && !(oldValue.budget > 0)) || (roiNum !== undefined && !(oldValue.roiGoal > 0)) ||
          (bidNum !== undefined && !(oldValue.bid > 0))) {
        throw Object.assign(new Error('target_parameter_unavailable：缺少待修改字段的真实前值'), { statusCode: 423, code: 'target_parameter_unavailable', skipOpLog: true });
      }

      // 幅度校验（预算维持 ±50%；ROI 单次 ±10% 为不可绕过硬护栏）
      if (roiNum !== undefined && oldValue.roiGoal > 0) {
        const changeRatio = Math.abs(roiNum - oldValue.roiGoal) / oldValue.roiGoal;
        // +1e-9 浮点容差：如 2→2.2 的 changeRatio 在 IEEE754 下为 0.10000000000000009，恰好10%应放行
        if (changeRatio > MAX_ROI_CHANGE_RATIO + 1e-9) {
          const err = new Error(`ROI调整幅度过大：从 ${oldValue.roiGoal} 改为 ${roiNum}（变化${(changeRatio * 100).toFixed(0)}%）。服务端护栏要求单次变化不超过10%；如需继续调整，必须等待至少30分钟并重新读取盘面`);
          err.statusCode = 400;
          err.details = { old_value: oldValue.roiGoal, new_value: roiNum, change_ratio: changeRatio };
          throw err;
        }
      }
      if (budgetNum !== undefined && oldValue.budget > 0) {
        const changeRatio = Math.abs(budgetNum - oldValue.budget) / oldValue.budget;
        if (changeRatio > MAX_CHANGE_RATIO) {
          const err = new Error(`预算调整幅度过大：从 ${oldValue.budget}元 改为 ${budgetNum}元（变化${(changeRatio * 100).toFixed(0)}%）。单次调整不能超过50%，如需大幅调整请分多次操作`);
          err.statusCode = 400;
          err.details = { old_value: oldValue.budget, new_value: budgetNum, change_ratio: changeRatio };
          throw err;
        }
      }

      // 执行操作：透传 bidNum 与 audienceTemplate
      const action = audienceTemplate !== undefined ? 'update_audience' : bidNum !== undefined && budgetNum === undefined ? 'update_bid'
        : budgetNum !== undefined && roiNum === undefined ? 'update_budget' : budgetNum === undefined ? 'update_roi' : 'update_budget_roi';
      const audience = audienceTemplate !== undefined ? require('../lib/boostAudienceTemplates').getTemplate(audienceTemplate) : null;
      if (audienceTemplate !== undefined && !audience) throw Object.assign(new Error('unknown_audience_template'), { statusCode: 400 });
      const requested = {
        ...(budgetNum !== undefined ? { budget: budgetNum } : {}),
        ...(roiNum !== undefined ? { roi_goal: roiNum } : {}),
        ...(bidNum !== undefined ? { bid: bidNum } : {}),
        // Verify resolved audience values, never a label inferred from the task name.
        ...(audience ? { audience: { ...audience } } : {}),
      };
      const before = { budget: oldValue.budget, roi_goal: oldValue.roiGoal, bid: oldValue.bid ?? null, audience: oldValue.audience || null, smart_bid_type: oldValue.smartBidType ?? null };
      if (Object.keys(requested).every(key => before[key] != null && before[key] === requested[key])) {
        return { ok: true, effect_status: 'unchanged', operation_id: null, before, requested, actual: before,
          readback: { verified: true }, message: '参数已一致，未重复提交', retry_write: false };
      }
      return executeWithReceipt({
        write: () => updateCampaignBudgetAndROI(primaryAdId, assistTaskId, budgetNum, roiNum, accountId, { bid: bidNum, audienceTemplate }),
        read: () => readTargetValues(accountId, primaryAdId, assistTaskId), before, requested,
        // 追投整单更新：除请求字段外，预算/出价模式/定向及适用出价也必须保持。
        preserveFields: assistTaskId ? ['budget', 'smart_bid_type', 'audience', ...(before.smart_bid_type === 7 ? [] : [before.bid > 0 ? 'bid' : 'roi_goal'])] : [],
        logEntry: { action, account_id: accountId, primary_ad_id: primaryAdId, assist_task_id: assistTaskId,
          target_type: assistTaskId ? 'boost_task' : 'plan', target_id: targetId,
          params: { budget: budgetNum, roiGoal: roiNum, bid: bidNum, audienceTemplate, roiBasis: roiContract?.roi_goal_basis, old_value: oldValue },
          source: opLog.normalizeSource(data.source) },
      });
    });
    if (!result.ok) return sendJSON(res, result, result.http_status || 502);
    // 主计划本身变更成功 → 主动失效 dashboard 计划缓存（改出价/预算下轮即见真值；追投任务不影响主计划卡，跳过）
    if (!assistTaskId) { try { require('./liveDashboard').invalidatePlanCache(accountId); } catch (e) { console.warn('[缓存失效] 主计划缓存清理失败:', e.message); } }
    let msg = '';
    const target = assistTaskId ? `追投${assistTaskId}` : `计划${primaryAdId}`;
    if (budgetNum !== undefined && roiNum !== undefined) msg = `${target} 预算改为${budgetNum}元 ROI改为${roiNum}`;
    else if (budgetNum !== undefined) msg = `${target} 预算改为${budgetNum}元`;
    else if (roiNum !== undefined) msg = `${target} ROI改为${roiNum}`;
    return sendJSON(res, {
      ...result,
      message: result.effect_status === 'confirmed' ? msg || result.message : result.message,
      roi_goal_basis: roiContract ? roiContract.roi_goal_basis : 'unknown',
      roi_basis_source: roiContract ? roiContract.roi_basis_source : 'not_checked_no_roi_write',
      optimization: roiContract ? roiContract.optimization : null,
    });
  } catch (e) {
    // 频率熔断拦截不写 op-log（保持熔断原行为）
    if (!e.skipOpLog) {
      opLog.log({
        action: 'update_budget_roi',
        account_id: accountId,
        primary_ad_id: primaryAdId,
        assist_task_id: assistTaskId,
        target_type: assistTaskId ? 'boost_task' : 'plan',
        target_id: assistTaskId || primaryAdId,
        params: { budget: budgetNum, roiGoal: roiNum, roiBasis: roiContract && roiContract.roi_goal_basis },
        success: false,
        result_msg: e.message,
        source: opLog.normalizeSource(data.source),
      });
    }
    return handleApiError(res, e);
  }
}

async function readTargetValues(accountId, primaryAdId, assistTaskId) {
  if (!assistTaskId) return normalizedTarget(await fetchPlanCurrentValues(primaryAdId, accountId), true);
  const today = getLocalDateStr();
  const result = await fetchBoostList(primaryAdId, today, today, accountId, { includeAllStatus: true });
  const task = result?.data?.adInfos?.find(t => String(t.id) === String(assistTaskId));
  return normalizedTarget(task);
}

async function fetchTargetOptimizationMetadata({ accountId, primaryAdId, assistTaskId }) {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86400000);
  const fmt = date => date.toISOString().slice(0, 10);
  try {
    if (assistTaskId) {
      const result = await fetchBoostList(primaryAdId, fmt(start), fmt(end), accountId, { includeAllStatus: true });
      const tasks = (result && result.data && result.data.adInfos) || [];
      return tasks.find(task => String(task.id) === String(assistTaskId)) || null;
    }

    if (typeof fetchUniPromAdList !== 'function') return null;
    const [liveResult, productResult] = await Promise.all([
      fetchUniPromAdList(fmt(start), fmt(end), accountId, { marGoal: 2 }).catch(() => null),
      fetchUniPromAdList(fmt(start), fmt(end), accountId, { marGoal: 1 }).catch(() => null),
    ]);
    const plans = [
      ...((liveResult && liveResult.data && liveResult.data.adInfos) || []),
      ...((productResult && productResult.data && productResult.data.adInfos) || []),
    ];
    return plans.find(plan => String(plan.id) === String(primaryAdId)) || null;
  } catch (error) {
    console.warn(`[ROI口径] 目标 ${assistTaskId || primaryAdId} 优化元数据读取失败: ${error.message}`);
    return null;
  }
}

module.exports = {
  handleCampaignMaterials,
  handleCampaignStatus,
  handleCampaignBudget
};

