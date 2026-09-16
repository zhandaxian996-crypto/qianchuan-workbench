const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({
  name: "qianchuan-data-api",
  version: "1.4.0"
});

// ========== 全局异常兜底（2026-08-06 防僵尸加固补充） ==========
// 未捕获异常/未处理 rejection 一律立即退出，宿主检测到进程退出会重新拉起；
// 否则进程带"半注册"状态残留，宿主调到 tool not found（08-07~10:20 故障机理）。
process.on("uncaughtException", (e) => {
  console.error("[mcp] FATAL uncaughtException:", e?.message || e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[mcp] FATAL unhandledRejection:", e?.message || e);
  process.exit(1);
});

const runtimeConfig = require("../lib/config");
const { PORT, agent_policy } = runtimeConfig;
const { validateAccount } = require('../lib/api-helpers');
const { checkAgentWritePolicy, toMcpBlockResult } = require("../lib/agentPolicy");
const { FLOW_CONTRACT, FLOW_ROLES } = require("../lib/flowContract");
const API_BASE = `http://localhost:${PORT}/api`;
const HTTP_BASE = `http://localhost:${PORT}`;
const { createDeadlineFetch, fetchJsonWithDeadline } = require("../lib/mcpFetch");
const { AsyncLocalStorage } = require('async_hooks');
// 所有 MCP→HTTP 调用统一有界：status 30s，其余读/聚合 60s；非 2xx 直接抛结构化错误。
const deadlineContext = new AsyncLocalStorage();
const baseFetch = createDeadlineFetch(globalThis.fetch, { statusMs: 30000, readMs: 60000 });
const fetch = (url, options = {}) => {
  const context = deadlineContext.getStore();
  const remaining = context ? Math.max(1, context.deadlineAt - Date.now()) : null;
  return baseFetch(url, {
    ...options,
    signal: options.signal || context?.signal,
    deadlineMs: remaining == null
      ? options.deadlineMs
      : Math.min(Number(options.deadlineMs) || remaining, remaining),
  });
};
const fetchJson = (url, options) => fetchJsonWithDeadline(fetch, url, options);

// 给整个 MCP 工具调用设置总期限，防止多个串行/聚合子请求把单次 60s 期限累加。
const registerTool = server.tool.bind(server);
server.tool = (...args) => {
  const handler = args[args.length - 1];
  if (typeof handler !== 'function') return registerTool(...args);
  args[args.length - 1] = async (input, extra) => {
    // 独立 stdio 进程也须读取运行中新增的账户，不冻结启动时白名单/授权。
    try {
      const latest = require('../lib/accountRegistry').readConfig(runtimeConfig.CONFIG_PATH);
      if (latest.qianchuan_accounts?.length) runtimeConfig.applyAccountRegistry(latest);
      else {
        runtimeConfig.QIANCHUAN_ACCOUNTS.splice(0);
        for (const key of Object.keys(agent_policy)) delete agent_policy[key];
        agent_policy.mode = 'recommendation_only';
        if (args[0] !== 'setup_account') return toMcpResult({
          ok: false, code: 'account_setup_required', first_use: true,
          message: '还没有接入账户。请引导用户打开本机接入页，登录千川并选择 Cookie Editor 导出的 JSON 文件；不要索要聊天中的 Cookie。',
          onboarding_url: HTTP_BASE + '/v4#/onboarding', next_tool: 'setup_account', next_action: 'status',
        }, { isError: true });
      }
    } catch {
      return toMcpResult({ ok: false, code: 'configuration_unavailable', message: '账户配置无法读取，未执行调用' }, { isError: true });
    }
    // Zod 不能再在启动时冻结账户枚举：账号可在服务运行中新增/归档。
    // 每次调用都按当前注册表校验，写工具也因此绝不可能回落到默认账号。
    if (input && Object.prototype.hasOwnProperty.call(input, 'account_id') && input.account_id != null) {
      try { validateAccount(input.account_id); }
      catch (e) { return toMcpResult({ ok: false, code: 'invalid_account', component: 'mcp', retryable: false, message: e.message }, { isError: true }); }
    }
    const timeoutMs = args[0] === 'recover_data_service'
      ? 90000
      : args[0] === 'get_live_view' && input?.level === 'status'
        ? 30000
        : 60000;
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error(`MCP 工具总期限 ${timeoutMs}ms`), {
      code: 'mcp_tool_timeout', component: 'mcp', retryable: true, timeoutMs,
    });
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timer.unref?.();
    let abortListener;
    const abortPromise = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason || timeoutError);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await deadlineContext.run(
        { signal: controller.signal, deadlineAt: Date.now() + timeoutMs },
        () => Promise.race([Promise.resolve(handler(input, extra)), abortPromise]),
      );
    } catch (e) {
      return toMcpResult(toErrorPayload(e, { component: 'mcp' }), { isError: true });
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  };
  return registerTool(...args);
};

const enforceWritePolicy = (scope, action, accountId) => {
  const check = checkAgentWritePolicy(agent_policy, scope, accountId);
  return check.allowed ? null : toMcpBlockResult(check, scope, action);
};

// MCP 输出净化层（2026-08-04）：让 agent 拿到纯净、决策导向的数据（只影响 MCP 层，不影响 HTTP）
const {
  cleanLiveDashboard, cleanCompass, cleanCompassGoods, cleanMaterialInsight,
  cleanMaterialSummary, cleanCreatorBrief, cleanBoostList,
  cleanLessons, stripNoise, scopeDecl, cleanOverview,
} = require("../lib/mcpClean");
const { toErrorPayload, toMcpResult } = require('../lib/mcpOutput');
const { SnapshotRing } = require('../lib/snapshotRing');
const { recoverDataService } = require('../lib/mcpServiceRecovery');
const { loadAccountProfile, toDecisionProfile } = require('../lib/accountProfile');
const liveSnapshotRing = new SnapshotRing({ ttlMs: 2 * 60 * 60 * 1000, maxPerAccount: 24 });

// 账号白名单（从 config 动态生成，拼错账号 id 在调用前就被 zod 拦下，防止静默回落到默认账号拿错数据）
const accountIds = () => (runtimeConfig.QIANCHUAN_ACCOUNTS || []).map(a => a.id);
// 空账户仍开放接入状态工具；业务工具由账户校验阻断。

// 统一包装：服务端 ok:false → MCP isError:true（防 agent 把熔断/失败当成功结果盲目重试）
const wrap = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  ...(data && data.ok === false ? { isError: true } : {}),
});

// 聚合类工具子项体检：子响应 ok:false → 生成「该子项失败」标注（前置到返回文本，防 agent 误判整体成功）
const subFail = (name, data) => (data && data.ok === false)
  ? `【该子项失败:${name}: ${data.error || data.message || "ok:false"}】`
  : null;
const settledData = (item) => item.status === 'fulfilled'
  ? item.value
  : { ok: false, code: item.reason?.code || 'mcp_subrequest_error', error: item.reason?.message || '子请求失败' };
// 聚合结果统一出口：失败标注前置到文本；主数据子项失败时整体 isError:true
const wrapAggregate = (payload, fails, mainFailed) => ({
  content: [{ type: "text", text: (fails.length ? fails.join("；") + "\n" : "") + JSON.stringify(payload, null, 2) }],
  ...(mainFailed ? { isError: true } : {}),
});

// 写操作失败专用格式：提取纯文本短句前置，防大段 JSON 费 token
const formatWriteError = (data) => {
  if (data && data.ok === false) {
    const msg = data.error || data.message || "未知错误";
    return {
      content: [{ type: "text", text: `Error: ${msg}\n详细: ${JSON.stringify(data, null, 2)}` }],
      isError: true
    };
  }
  return wrap(data);
};

// 历史账户专用说明已从试用包移除。
const { formatWriteResult } = require("../lib/mcpWriteResult");

// 写后回读追投列表，给 Agent 返回已落地对象及其真实 ROI 目标口径。
// 回读失败不把已成功的写操作改判失败，但必须显式 verified=false，禁止伪装已核验。
async function attachBoostWriteReadback(data, { accountId, primaryAdId, targetId, requested = {} }) {
  if (!data || data.ok === false || !targetId) return data;
  if (data.readback && data.effect_status) return data; // HTTP layer already performed action-specific verification.
  try {
    const url = `${API_BASE}/boost-list?account=${encodeURIComponent(accountId)}`
      + `&adId=${encodeURIComponent(primaryAdId)}&includeAllStatus=1`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const list = await response.json();
    const task = list && list.ok && Array.isArray(list.tasks)
      ? list.tasks.find(item => String(item.id) === String(targetId))
      : null;
    const actual = task ? { status: task.status_code, budget: task.budget, roi_goal: task.roi_goal, bid: task.bid } : null;
    const comparison = require('../lib/writeReceipt').compareReadback(actual, requested);
    return {
      ...data,
      requested, actual, effect_status: comparison.verified ? 'confirmed' : 'unconfirmed', retry_write: false,
      readback: task ? {
        ...comparison,
        target_id: String(targetId),
        status: task.status == null ? null : task.status,
        budget: task.budget == null ? null : task.budget,
        roi_goal: task.roi_goal == null ? null : task.roi_goal,
        roi_goal_basis: task.roi_goal_basis || data.roi_goal_basis || 'unknown',
        roi_basis_source: task.roi_basis_source || data.roi_basis_source || 'unknown',
        optimization: task.optimization || data.optimization || null,
      } : {
        verified: false,
        target_id: String(targetId),
        roi_goal_basis: data.roi_goal_basis || 'unknown',
        reason: list && list.ok === false ? (list.code || list.error || 'boost_list_failed') : 'target_not_visible_yet',
      },
    };
  } catch (error) {
    return {
      ...data,
      requested, actual: null, effect_status: 'unconfirmed', retry_write: false,
      readback: {
        verified: false,
        target_id: String(targetId),
        roi_goal_basis: data.roi_goal_basis || 'unknown',
        reason: error.code || error.message || 'readback_failed',
      },
    };
  }
}

// 历史账户专用说明已从试用包移除。
// 语义修正：删除 = 移出在投列表（不再投放/不再消耗即生效）；视频库文件残留/暂停历史记录属千川存储层，不报失败。
const formatMaterialOpResult = (action, data) => {
  if (!data || data.ok === false) {
    const msg = (data && (data.error || data.message)) || "操作失败";
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
  const lines = [];
  if (action === "precheck") {
    lines.push(`预检：${data.confirmed === true ? "可删除" : "待确认"}（${(data.lego_mids || []).length} 条素材）`);
  } else if (action === "rename_precheck") {
    lines.push(`改名预检：${data.current_name} → ${data.proposed_name}`);
    lines.push(`素材：${data.material_id}｜角色：${data.role || "未指定"}｜尚未写入`);
  } else if (action === "rename_confirm") {
    lines.push(`素材已改名：${data.current_name} → ${data.proposed_name}`);
    lines.push(`回读：${data.verified ? "已确认" : "官方列表暂未刷新"}｜素材：${data.material_id}`);
  } else if (action === "propose") {
    const item = data.item || data;
    const id = item.id || "";
    const st = item.status || "pending";
    lines.push(`提案已入队：${id}（${(item.type_label || item.type || "操作")}，${st}${item.auto_execute ? "，自动复核执行" : "，待人工" }）`);
  } else if (action === "reject") {
    lines.push(`已驳回：${data.status || data.id || ""}`);
  } else if (action === "list") {
    const items = Array.isArray(data.items) ? data.items : [];
    const pending = items.filter(x => x.status === "pending");
    lines.push(`待确认队列：${pending.length} 条待处理 / 共 ${items.length} 条`);
    pending.slice(0, 10).forEach(x => {
      const p = x.params || {};
      lines.push(`  - ${x.id} ${x.type_label || x.type} | ${(p.legoMids || []).length} 条素材 | ${(x.reason || "").slice(0, 40)}${x.auto_execute ? " [自动]" : ""}`);
    });
    if (pending.length > 10) lines.push(`  …其余 ${pending.length - 10} 条略`);
  }
  lines.push(`详情: ${JSON.stringify(data).slice(0, 400)}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
};

// ========== 1. 直播盯盘一站式 ==========
server.tool(
  'recover_data_service',
  '只恢复千川数据读取链路，不改投放。关键读工具超时、连接失败、无结构化响应，或在播数据 stale/unavailable 时调用。先在HTTP进程内重采collector，仍失败才核验18991 PID并受控重启；Cookie/429/423/400/502/SQLite busy不会触发重启。',
  {
    account_id: z.string().min(1).describe('需要恢复的账号ID'),
    restart_if_needed: z.boolean().optional().describe('collector重采仍失败时是否受控重启18991；持续盯盘通常传true'),
  },
  async ({ account_id, restart_if_needed }) => {
    const result = await recoverDataService({
      fetchJson,
      httpBase: HTTP_BASE,
      accountId: account_id,
      restartIfNeeded: restart_if_needed !== false,
    });
    return toMcpResult(result, { isError: result.ok === false });
  },
);

server.tool(
  'setup_account',
  '首次接入与继续配置。status 返回已有账户、缺口和下一组问题；draft 保存非凭据回答；rehearse 只读验证账户与计划；save 确认保存只读配置及授权意向。Cookie 只能通过本机 /v4#/onboarding 文件导入，不要请求用户在聊天粘贴凭据。未实现的预算护栏会阻断写授权激活。',
  {
    action: z.enum(['status', 'draft', 'rehearse', 'save']), account_id: z.string().optional(),
    revision: z.number().int().nonnegative().optional(), confirm: z.boolean().optional(),
    primary_ad_id: z.string().nullable().optional(),
    answers: z.object({
      objective: z.string().max(500).optional(), target_roi: z.number().positive().nullable().optional(),
      roi_basis: z.enum(['payment', 'platform_net_1h', 'final_settlement', 'chengfang_comprehensive', 'unknown']).optional(),
      break_even_roi: z.number().positive().nullable().optional(),
      break_even_basis: z.enum(['payment', 'platform_net_1h', 'final_settlement', 'chengfang_comprehensive', 'unknown']).optional(),
      daily_budget: z.number().nonnegative().nullable().optional(), session_budget: z.number().nonnegative().nullable().optional(), test_loss: z.number().nonnegative().nullable().optional(),
      mode: z.enum(['recommendation_only', 'confirm_writes', 'auto_guarded']).optional(),
      allowed_actions: z.array(z.string()).optional(), forbidden_actions: z.array(z.string()).optional(),
      notifications: z.enum(['important_only', 'every_round']).optional(),
    }).strict().optional(),
  },
  async input => {
    if (input.action !== 'status' && !input.account_id) return toMcpResult({ ok: false, code: 'account_required' }, { isError: true });
    const url = API_BASE + '/onboarding';
    const result = input.action === 'status'
      ? await fetchJson(url + (input.account_id ? '?account_id=' + encodeURIComponent(input.account_id) : ''))
      : await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-qc-onboarding': '1' }, body: JSON.stringify(input) });
    return toMcpResult(result, { isError: result.ok === false });
  },
);

server.tool(
  'load_account_profile',
  '只读加载指定账号的规范化 Profile 决策子集。返回执行模式、ROI/漏斗/渠道/流速/样本门槛和可比条件；不读取或返回 Cookie、aavid、令牌及兼容扩展。',
  {
    account_id: z.string().min(1).describe('账号ID'),
  },
  async ({ account_id }) => {
    try {
      const profile = loadAccountProfile(account_id);
      if (!profile) {
        return toMcpResult({
          ok: false,
          code: 'account_profile_not_found',
          component: 'account_profile',
          retryable: false,
          account_id,
          message: `账号 ${account_id} 尚无可用 Profile`,
        }, { isError: true });
      }
      return toMcpResult({ ok: true, account_id, profile: toDecisionProfile(profile) });
    } catch (error) {
      return toMcpResult({
        ok: false,
        code: 'account_profile_unavailable',
        component: 'account_profile',
        retryable: true,
        account_id,
        message: `账号 ${account_id} Profile 无法读取: ${error.message}`,
      }, { isError: true });
    }
  },
);

server.tool(
  "monitor_once",
  "执行一轮只读盯盘并结束，适合任意 Agent 的 loop 或定时安排。直读直播状态，开播才取盘面；返回新鲜度、变化、错误及 should_notify。不会自行循环或修改投放。无账号或多账号时要求明确选择。",
  { account_id: z.string().min(1).optional().describe("已接入的账户 ID；只有一个账户时可省略") },
  async ({ account_id }) => {
    try {
      const { run } = require(require('node:path').resolve(__dirname, '../../../tools/monitor.cjs'));
      const { result } = await run({ args: ['--once', '--json', ...(account_id ? ['--account-id', account_id] : [])],
        healthTimeoutMs: 3000, statusTimeoutMs: 5000, liveTimeoutMs: 15000, dashboardTimeoutMs: 30000 });
      return toMcpResult(result, { isError: result.ok !== true });
    } catch (error) {
      return toMcpResult({ ok: false, state: 'unavailable', code: error.code || 'monitor_unavailable', next_step: '先运行项目启动入口，确认本机服务和账户接入，再重试一轮。' }, { isError: true });
    }
  },
);

server.tool(
  "get_live_view",
  "直播数据读取。status=全账号身份心跳；dashboard默认单账号可信摘要，含全部相关追投审计字段及material_changes（视频/直播画面/轮播，前10+榜外变化+待确认，含真实窗口和覆盖缺口）；view=detail为兼容详情，since_snapshot_id读取增量。缺字段按supplement定点补读，预算周期未知不可用当日比值冒充进度。unified=盘面+罗盘；overview=区间；chengfang=乘方；board=场次大屏。开场或身份冲突先status，同场稳定轮可直接summary。",
  {
    account_id: z.string().min(1).optional().describe("账号ID（status 级别可不传）"),
    level: z.enum(["status", "dashboard", "unified", "overview", "chengfang", "board"]).describe("status=心跳/dashboard=盘面/unified=+罗盘/overview=区间(需start/end)/chengfang=乘方(可date/ad_id)/board=大屏分钟级(可room_id)"),
    start: z.string().optional().describe("开始日期 YYYY-MM-DD（level=overview 必填）"),
    end: z.string().optional().describe("结束日期 YYYY-MM-DD（level=overview 必填）"),
    date: z.string().optional().describe("单日日期 YYYY-MM-DD（level=chengfang 可选，默认今天）"),
    ad_id: z.string().optional().describe("乘方计划ID（level=chengfang 可选，传了返回该计划商品归因 Top）"),
    room_id: z.string().optional().describe("直播场次roomId（level=board 可选，缺省=当日最近一场）"),
    view: z.enum(["summary", "detail"]).optional().describe("输出粒度：summary默认摘要；detail兼容详情"),
    since_snapshot_id: z.string().optional().describe("上一轮summary返回的snapshot_id；同账号同场次只返回变化，失效或跨场次自动回退完整摘要"),
    slim: z.boolean().optional().describe("旧参数兼容：true等同view=summary，false等同view=detail；新调用请用view")
  },
  async ({ account_id, level, start, end, date, ad_id, room_id, view, since_snapshot_id, slim }) => {
    try {
      if (level === "status") {
        const data = await fetchJson(`${API_BASE}/live-watch`, { deadlineMs: 30000 });
        // live-watch HTTP 全量在真实账户可超过 180KB；MCP status 只保留调度下一步所需字段。
        if (data && Array.isArray(data.accounts)) {
          data.accounts = data.accounts.map(a => ({
            account_id: a.accountId,
            account_name: a.accountName,
            is_live: typeof a.isLive === 'boolean' ? a.isLive : null,
            status: a.status || null,
            source_at: a.fetchedAt || a.liveCheckedAt || null,
            session_key: a.session_key,
            age_ms: a.age_ms == null ? null : a.age_ms,
            freshness: a.dataValid !== true ? 'unavailable' : (a.stale ? 'stale' : (a.partial ? 'partial' : 'fresh')),
            data_valid: a.dataValid === true,
            partial: a.partial === true,
            error_codes: (a.errors || []).map(e => typeof e === 'string' ? e : e.code || 'unknown_error'),
            source_type: a.source_type || (typeof a.source === 'string' ? a.source : null),
            room_id: a.room && (a.room.roomId || a.room.room_id) || a.detectedRoomId || null,
            start_time: a.room && (a.room.startTime || a.room.start_time) || a.detectedRoomStartTime || null,
            cookie_expired: a.cookieExpired === true,
            metrics: a.isLive ? {
              spend: a.live_metrics ? (a.live_metrics.cost ?? a.live_metrics.spend ?? null) : null,
              payment_gmv: a.live_metrics ? (a.live_metrics.gmv ?? a.live_metrics.paymentGmv ?? a.live_metrics.payment_gmv ?? null) : null,
              payment_roi: a.live_metrics ? (a.live_metrics.roi ?? a.live_metrics.paymentRoi ?? a.live_metrics.payment_roi ?? null) : null,
              // collector 原生字段是 gmvSettle/roiSettle；兼容旧别名但不把缺失补成 0。
              net_gmv: a.live_metrics ? (a.live_metrics.gmvSettle ?? a.live_metrics.netGmv ?? a.live_metrics.net_gmv ?? null) : null,
              net_roi: a.live_metrics ? (a.live_metrics.roiSettle ?? a.live_metrics.netRoi ?? a.live_metrics.net_roi ?? null) : null,
              orders: a.live_metrics ? (a.live_metrics.orderCount ?? a.live_metrics.orders ?? null) : null,
              roi_basis: { payment_roi: 'payment', net_roi: 'platform_net_1h' },
              settlement_window: { payment: 'realtime', net: '1h' },
            } : undefined,
          }));
        }
        return toMcpResult({ ok: data && data.ok !== false, mode: 'status', generated_at: new Date().toISOString(), accounts: data.accounts || [] }, {
          summary: `账号状态：${(data.accounts || []).filter(a => a.is_live).length} 个在播 / ${(data.accounts || []).length} 个账号`,
        });
      }
      if (!account_id) {
        return { content: [{ type: "text", text: `Error: level=${level} 必须传 account_id` }], isError: true };
      }
      if (level === "dashboard") {
        const summaryMode = view !== 'detail' && slim !== false;
        const url = summaryMode || since_snapshot_id
          ? `${API_BASE}/live-summary?account=${encodeURIComponent(account_id)}`
          : `${API_BASE}/live-dashboard?account=${encodeURIComponent(account_id)}&full=1`;
        const data = await fetchJson(url, { deadlineMs: 60000 });
        if (summaryMode || since_snapshot_id) {
          const summary = data;
          let payload;
          if (since_snapshot_id) payload = liveSnapshotRing.delta(summary, since_snapshot_id);
          else {
            liveSnapshotRing.put(summary);
            payload = { ...summary, mode: 'summary', delta_available: true };
          }
          return toMcpResult(payload);
        }
        // detail 为兼容出口；默认轮次不再返回这份大结构。
        return wrap(cleanLiveDashboard(data));
      }
      if (level === "unified") {
        const settled = await Promise.allSettled([
          fetchJson(`${API_BASE}/live-dashboard?account=${account_id}&full=1`, { deadlineMs: 60000 }),
          fetchJson(`${API_BASE}/compass?account=${account_id}`, { deadlineMs: 60000 }),
        ]);
        const dash = settled[0].status === 'fulfilled'
          ? settled[0].value
          : { ok: false, code: settled[0].reason.code, error: settled[0].reason.message };
        const snapshot = settled[1].status === 'fulfilled'
          ? settled[1].value
          : { ok: false, code: settled[1].reason.code, error: settled[1].reason.message };
        // 主数据=千川盘面：盘面失败整体 isError；罗盘快照失败仅标注（盘面仍可决策）
        const fails = [subFail("千川盘面", dash), subFail("罗盘快照", snapshot)].filter(Boolean);
        const mainFailed = dash && dash.ok === false;
        // 2026-08-04 净化层：盘面走 cleanLiveDashboard，罗盘走 cleanCompass
        return wrapAggregate({
          ok: !mainFailed,
          partial: fails.length > 0,
          errors: fails,
          account: account_id,
          qianchuan: cleanLiveDashboard(dash),
          compass: cleanCompass(snapshot),
        }, fails, mainFailed);
      }
      if (level === "overview") {
        if (!start || !end) {
          return { content: [{ type: "text", text: "Error: level=overview 必须传 start 和 end" }], isError: true };
        }
        return wrap(cleanOverview(await fetchJson(`${API_BASE}/overview?account=${account_id}&start=${start}&end=${end}`)));
      }
      if (level === "chengfang") {
        // 乘方只读（2026-07-30）：默认今日总览；ad_id=单计划商品归因 Top；date=历史单日
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (date && !dateRe.test(date)) return { content: [{ type: "text", text: "Error: date 格式须为 YYYY-MM-DD" }], isError: true };
        let url = ad_id
          ? `${API_BASE}/chengfang/products?account=${account_id}&ad_id=${encodeURIComponent(ad_id)}`
          : `${API_BASE}/chengfang/overview?account=${account_id}`;
        if (date) url += `&date=${date}`;
        const data = await fetchJson(url);
        if (data && data.ok === false) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
        return wrap(scopeDecl(stripNoise(data), '净成交1h'));
      }
      if (level === "board") {
        // 历史账户专用说明已从试用包移除。
        let url = `${API_BASE}/live-board-detail?account=${account_id}&digest=1`;
        if (room_id) url += `&roomId=${encodeURIComponent(room_id)}`;
        const d = await fetchJson(url);
        if (d && d.ok === false) return { content: [{ type: "text", text: `Error: ${d.error}` }], isError: true };
        const lines = [];
        lines.push(`【场次消化】${account_id} 场次 ${d.roomId}（${d.startTime} ~ ${d.endTime || '进行中'}）${d.partial ? '⚠️部分缺失' : ''}`);
        for (const l of d.digest || []) lines.push(l);
        return { content: [{ type: "text", text: lines.join('\n') }] };
      }
      return { content: [{ type: "text", text: `Error: 未知 level ${level}` }], isError: true };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 1.1 一站式盯盘证据座舱 ==========
server.tool(
  "get_live_cockpit",
  "只读盯盘证据座舱。返回同场 5m/15m/30m/60m 边际及15m总/基础/追投流速、拆分质量、计划与冷却。素材按实际消耗展示，附当日口径、样本、窗口、漏斗和覆盖率；不返回 MHS 总分、等级或评分动作建议。累计ROI只用平台原值，平台1h净口径不等于最终结算；缺失为null，区间边际另列。历史盘面动力与 expansion_dilution_shadow 保留结构化预警和证据，不是概率、因果结论或写授权。休播、陈旧或场次冲突时证据降级。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    limit: z.number().optional().describe("Top素材返回数量（默认10，范围1~30）"),
    slot: z.string().optional().describe("当前时段标签，仅作上下文；没有素材级历史实证时不会自动加权"),
    slim: z.boolean().optional().describe("是否启用极简脱水模式（默认 true）")
  },
  async ({ account_id, limit, slot, slim }) => {
    try {
      const l = limit || 10;
      const s = slot || "normal";
      const slimFlag = slim === false ? 0 : 1;
      const res = await fetch(`${API_BASE}/live-cockpit?account=${encodeURIComponent(account_id)}&limit=${l}&slot=${encodeURIComponent(s)}&slim=${slimFlag}`);
      const data = await res.json();
      return wrap(data);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 1.1.1 扩量稀释 Shadow 独立只读出口 ==========
server.tool(
  "get_expansion_dilution_shadow",
  "只读获取当前场次的扩量稀释 Shadow。结果直接取自 /api/live-cockpit.expansion_dilution_shadow，不在 MCP 内重复计算。该信号只用于诊断、责任域路由和前向留证，不是概率、因果结论或任何投放写操作授权。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）")
  },
  async ({ account_id }) => {
    try {
      const cockpit = await fetchJson(
        `${API_BASE}/live-cockpit?account=${encodeURIComponent(account_id)}&slim=1`,
      );
      if (!cockpit || cockpit.ok === false) {
        return toMcpResult(cockpit || {
          ok: false,
          code: 'live_cockpit_empty',
          component: 'live_cockpit',
          retryable: true,
          message: '实时座舱未返回数据',
        }, { isError: true });
      }
      const shadow = cockpit.expansion_dilution_shadow;
      if (!shadow || typeof shadow !== 'object') {
        return toMcpResult({
          ok: false,
          code: 'expansion_dilution_shadow_missing',
          component: 'live_cockpit',
          retryable: true,
          message: '实时座舱未返回扩量稀释 Shadow',
        }, { isError: true });
      }
      const payload = {
        ok: true,
        account: cockpit.account || account_id,
        room_id: cockpit.room_id || null,
        session_key: shadow.session_key || null,
        cockpit_as_of: cockpit.as_of || null,
        data_degraded: cockpit.data_degraded === true,
        expansion_dilution_shadow: shadow,
      };
      const state = shadow.state || shadow.status || 'UNKNOWN';
      const status = shadow.status || 'unknown';
      const riskLevel = shadow.risk_level || 'unknown';
      const attribution = shadow.attribution && shadow.attribution.domain || 'unknown';
      const evidenceStatus = shadow.evidence_ref && shadow.evidence_ref.status || 'unknown';
      return toMcpResult(payload, {
        summary: `扩量稀释Shadow｜${payload.account}｜${status}/${state}｜风险 ${riskLevel}｜责任域 ${attribution}｜证据 ${evidenceStatus}｜只诊断，不授权任何投放写操作。`,
      });
    } catch (e) {
      return toMcpResult(toErrorPayload(e, { component: 'live_cockpit' }), { isError: true });
    }
  }
);

// ========== 1.2 当前场次原生边际切片与流速 ==========
server.tool(
  "get_marginal_slice",
  "当前在播场次原生边际切片。基于 liveCollector 的真实 5 分钟增量桶聚合 5m/15m/30m/60m 结算净GMV、净ROI与总流速，并返回同窗主计划流速、追投流速、追投占比及flow_split_quality。默认15m总流速用于直播间承接，主计划/追投分项用于归因；5m只作即时预警，30m作调控确认。拆分未达到complete时不得据此修改主计划或追投。休播或陈旧时明确返回 offline/stale。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    minutes: z.number().optional().describe("切片窗口分钟数（默认 15=总流速及主计划/追投拆分；5=即时预警，30=调控确认，60=长周期）")
  },
  async ({ account_id, minutes }) => {
    try {
      const m = minutes || 15;
      if (![5, 15, 30, 60].includes(m)) {
        return { content: [{ type: "text", text: "Error: minutes 仅支持 5/15/30/60" }], isError: true };
      }
      // collector 只运行在 18991 HTTP 进程。MCP stdio 是独立进程，不能直接 require
      // liveCollector 读取进程内单例，否则会把正在直播误判为 offline。
      const data = await fetchJson(`${API_BASE}/live-trend?account=${encodeURIComponent(account_id)}`);
      const slice = data && data.marginal && data.marginal[`m${m}`];
      if (!slice) {
        return toMcpResult({
          ok: false,
          code: 'marginal_slice_missing',
          component: 'collector',
          retryable: true,
          message: `HTTP 服务未返回 ${m} 分钟边际切片`,
        }, { isError: true });
      }
      return wrap({
        ok: true,
        account: account_id,
        flow_contract: data.flow_contract || FLOW_CONTRACT,
        slice: { ...slice, flow_role: slice.flow_role || FLOW_ROLES[m] },
      });
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 1.3 拍板前快照（只读，2026-08-14 三合一：系统体检+今日待决策+多店对比，18→14 工具面收敛） ==========
server.tool(
  "get_snapshot",
  "拍板前一站式快照（只读）。早晨/盯盘轮开头调一次：①系统体检(uptime/cookie/余额/回填空洞/DB备份/日报)②今日待决策(盘面建议+追投停摆+待确认队列)③多店对比(近N天消耗/净GMV/净ROI/单量+今日盘中+余额+在播)。主数据=系统体检，失败整体isError；其余子项失败显式标注「该子项失败:原因」。",
  {
    account_id: z.string().min(1).optional().describe("只看单账号的待决策与对比行（不传=全部账号）"),
    days: z.number().optional().describe("对比窗口天数（默认7，范围1~30）")
  },
  async ({ account_id, days }) => {
    try {
      // ①系统体检（主数据：失败整体 isError）
      const hData = await (await fetch(`${API_BASE}/health-check`)).json();
      if (hData && hData.ok === false) {
        return { content: [{ type: "text", text: `Error: ${hData.error || "体检失败"}` }], isError: true };
      }
      const fails = [];
      const lines = [];
      lines.push(`【①系统体检】${hData.health === 'healthy' ? '✅ 健康' : '⚠️ 需处理：' + (hData.degraded_accounts || []).join('、')}（${hData.server_time}，已运行 ${Math.floor(hData.uptime_sec / 60)} 分钟）`);
      for (const a of hData.accounts || []) {
        lines.push(`- ${a.name}：cookie ${a.cookie_valid ? '✓' : '✗失效'}｜余额 ${a.balance_yuan != null ? '¥' + a.balance_yuan : '未知'}｜回填空洞 直播${a.backfill.missing_live_days}天/商品卡${a.backfill.missing_product_days}天${a.backfill.missing_live_days > 0 ? '（' + a.backfill.recent_missing_live.join(',') + '）' : ''}`);
      }
      if (hData.backup && hData.backup.last_success_at) {
        lines.push(`- DB备份：最近成功 ${hData.backup.last_success_at}${hData.backup.last_fail_at ? '；曾失败 ' + hData.backup.last_fail_at : ''}`);
      }
      if (hData.nightly) {
        const nr = [];
        for (const [accId, st] of Object.entries(hData.nightly.per_account || {})) {
          nr.push(`${accId}:日报${st.daily ? '✓' : '✗'}/洞察${st.insights ? '✓' : '✗'}`);
        }
        lines.push(`- 夜间任务：昨日(${hData.nightly.yesterday}) ${nr.join('，')}`);
      }

      // ②待决策 + ③多店对比：按账号并行取数（盘面/队列/区间/余额，各路由有 30~60s 缓存）
      const accounts = account_id ? [account_id] : accountIds();
      const d = Math.min(30, Math.max(1, days || 7));
      const endD = new Date();
      const startD = new Date(endD.getTime() - d * 86400000);
      const f = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
      const startS = f(startD), endS = f(endD);

      const per = await Promise.all(accounts.map(async (acc) => {
        const [dash, pend, ov, bal] = await Promise.all([
          fetch(`${API_BASE}/live-dashboard?account=${encodeURIComponent(acc)}&full=1`).then(r => r.json()).catch(e => ({ error: e.message })),
          fetch(`${API_BASE}/pending-ops?account=${encodeURIComponent(acc)}`).then(r => r.json()).catch(e => ({ error: e.message })),
          fetch(`${API_BASE}/overview?account=${encodeURIComponent(acc)}&start=${startS}&end=${endS}`).then(r => r.json()).catch(e => ({ error: e.message })),
          fetch(`${API_BASE}/balance?account=${encodeURIComponent(acc)}`).then(r => r.json()).catch(() => null),
        ]);
        return { acc, dash, pend, ov, bal };
      }));

      // ②今日待决策
      lines.push('');
      lines.push('【②今日待决策】');
      let total = 0;
      for (const { acc, dash, pend } of per) {
        const sub = [];
        let cnt = 0;
        if (dash && dash.ok) {
          for (const s of (dash.suggestions || [])) { sub.push(`  - [${s.level || 'info'}] ${s.msg || s.message || ''}`); cnt++; }
          for (const t of (dash.boost_tasks || [])) {
            if (t.passive_stop) { sub.push(`  - [停摆] 追投「${t.name}」系统强停（非手动暂停），按因处理`); cnt++; }
          }
        } else {
          sub.push(`  - 盘面取数失败: ${(dash && dash.error) || 'ok:false'}`);
          fails.push(`【该子项失败:${acc}盘面: ${(dash && dash.error) || 'ok:false'}】`);
        }
        if (pend && pend.ok !== false) {
          const pending = ((pend && pend.items) || []).filter(x => x.status === 'pending');
          for (const x of pending) { sub.push(`  - [待确认] ${x.type_label || x.type} ${x.id || ''}：${String(x.reason || '').slice(0, 60)}`); cnt++; }
          if (!pending.length) sub.push('  - 待确认队列：空');
        } else {
          sub.push(`  - 队列取数失败: ${(pend && pend.error) || 'ok:false'}`);
          fails.push(`【该子项失败:${acc}待确认队列: ${(pend && pend.error) || 'ok:false'}】`);
        }
        if (!cnt) sub.push('  - 无建议');
        lines.push(`【${acc}】`);
        lines.push(...sub);
        total += cnt;
      }
      if (!total) lines.push('（各账号盘面干净，队列为空）');

      // ③多店对比
      lines.push('');
      lines.push(`【③多店对比 · 近${d}天】（${startS} ~ ${endS}）`);
      lines.push(`| 账号 | 近${d}天消耗 | 净GMV | 净ROI | 单量 | 今日消耗 | 今日净ROI | 余额 | 在播 |`);
      lines.push('|---|---|---|---|---|---|---|---|---|');
      for (const { acc, dash, ov, bal } of per) {
        if (!ov || ov.ok === false) {
          lines.push(`| ${acc} | 区间取数失败: ${(ov && (ov.error || ov.message)) || 'ok:false'} |`);
          fails.push(`【该子项失败:${acc}区间对比: ${(ov && (ov.error || ov.message)) || 'ok:false'}】`);
          continue;
        }
        let balYuan = null;
        if (bal && bal.ok) balYuan = bal.total_balance_yuan;
        const k = (ov && ov.data && ov.data.kpi_raw) || {};
        const cost = parseFloat(String(k['整体消耗(元)'] || 0).replace(/,/g, '')) || 0;
        const gmv = parseFloat(String(k['净成交金额(元)'] || 0).replace(/,/g, '')) || 0;
        const roi = k['净成交ROI'] || '-';
        const orders = parseInt(k['净成交订单数'] || 0, 10) || 0;
        const today = (dash && dash.ok && dash.today) || null;
        const todayTrusted = !!today && (dash.dataValid === true || dash.today_source === 'sessions');
        const todayCost = todayTrusted && today.cost != null ? `¥${today.cost}` : '未知';
        const todayRoi = todayTrusted
          ? (today.netRoi != null ? today.netRoi : (today.roi != null ? today.roi : '未知'))
          : '未知';
        lines.push(`| ${(dash && dash.account_name) || acc} | ¥${+cost.toFixed(2)} | ¥${+gmv.toFixed(2)} | ${roi} | ${orders} | ${todayCost} | ${todayRoi} | ${balYuan != null ? '¥' + balYuan : '未知'} | ${dash && dash.live && dash.live.isLive ? '●' : '○'} |`);
      }

      return { content: [{ type: "text", text: (fails.length ? fails.join('；') + '\n' : '') + lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 1.5 账户诊断一站式（只读，交付版 E2E 验证后回流） ==========
server.tool(
  "get_diagnosis",
  "账户诊断一站式（只读）。一次拉全：全域承载力(在线/GPM)、素材质量、动态生命周期止损建议、追投任务诊断、总结与风险等级。数据源=/api/diagnose（live-dashboard+today-snapshot 聚合 SOP 诊断引擎，references/discipline.md 前置诊断代码化）。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）")
  },
  async ({ account_id }) => {
    try {
      const res = await fetch(`${API_BASE}/diagnose?account=${encodeURIComponent(account_id)}`);
      const data = await res.json();
      if (data && data.ok === false) return { content: [{ type: "text", text: `Error: ${data.error || "诊断失败"}` }], isError: true };
      return wrap(data);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 1.8 场次复盘一站式（只读，交付版 E2E 验证后回流） ==========
server.tool(
  "get_live_replay",
  "精确场次复盘（只读）：平台支付/1h净原值、消耗、订单、漏斗、素材和趋势，不生成红黑榜或财务盈亏判断。任务级本场归因缺失明确标注；include_boost_history才附独立日期范围历史，不能算入本场。同room_id重播必须用start_time隔离。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    date: z.string().optional().describe("场次日期 YYYY-MM-DD（可选，默认今天）"),
    room_id: z.string().optional().describe("直播场次roomId（可选，默认当日最近一场）"),
    start_time: z.string().optional().describe("场次开始时间（可选；同一roomId重复开播时必填，值取sessions返回的startTime）"),
    end_time: z.string().optional().describe("场次结束时间（可选；值取sessions返回的endTime）"),
    include_boost_history: z.boolean().optional().describe("默认false；true显式附缓存中的相关历史/在线日期报告，独立于本场归因；仅专项历史查询使用")
  },
  async ({ account_id, date, room_id, start_time, end_time, include_boost_history }) => {
    try {
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { content: [{ type: "text", text: "Error: date 格式须为 YYYY-MM-DD" }], isError: true };
      }
      // 缺 room_id 或 start_time 时先查场次列表。roomId 不是场次唯一键，必须把 startTime 一并传给详情路由。
      if (!room_id || !start_time) {
        let sUrl = `${API_BASE}/live-replay/sessions?account=${encodeURIComponent(account_id)}`;
        if (date) sUrl += `&date=${encodeURIComponent(date)}`;
        const sRes = await fetch(sUrl);
        const sData = await sRes.json();
        const sessions = (sData && sData.ok && Array.isArray(sData.sessions))
          ? [...sData.sessions].sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || '')))
          : [];
        if (!sessions.length) {
          return { content: [{ type: "text", text: `无场次：${date || '今天'} 没有开播记录` }], isError: false };
        }
        const matches = room_id ? sessions.filter(s => String(s.roomId) === String(room_id)) : sessions;
        if (!matches.length) {
          return { content: [{ type: "text", text: `Error: 未找到 room_id=${room_id} 对应场次` }], isError: true };
        }
        if (room_id && !start_time && matches.length > 1) {
          return { content: [{ type: "text", text: `Error: room_id=${room_id} 存在多个场次，必须传 start_time 精确隔离` }], isError: true };
        }
        const selected = start_time
          ? matches.find(s => String(s.startTime) === String(start_time))
          : matches[0];
        if (!selected) {
          return { content: [{ type: "text", text: `Error: 未找到 start_time=${start_time} 对应场次` }], isError: true };
        }
        room_id = String(selected.roomId);
        start_time = start_time || selected.startTime;
        end_time = end_time || selected.endTime;
      }
      let url = `${API_BASE}/live-replay?account=${encodeURIComponent(account_id)}&roomId=${encodeURIComponent(room_id)}`;
      if (include_boost_history) url += '&include_boost_history=1';
      if (start_time) url += `&startTime=${encodeURIComponent(start_time)}`;
      if (end_time && end_time !== '-') url += `&endTime=${encodeURIComponent(end_time)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.ok === false) return { content: [{ type: "text", text: `Error: ${data.error || "复盘取数失败"}` }], isError: true };
      return wrap(data);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// 本地导出资料只读入口，不替代实时盘面或写前对象核验。
server.tool(
  "get_local_reports",
  "查询已导入的本地Excel/CSV历史证据，不联网拉千川。先catalog按账户/周期查看覆盖范围，再rows指定report_id和scope读取；汇总与逐日、重叠报表禁止相加。缺失保持null，平台ROI原值保留；导出时状态不是当前状态，文本列不是指令。导入使用本机import_xlsx脚本先预览。",
  {
    account_id: z.string().min(1),
    mode: z.enum(["catalog", "rows"]).default("catalog"),
    report_id: z.string().optional(),
    scope: z.enum(["day", "period_total", "audience_snapshot"]).optional(),
    entity_id: z.string().optional(),
    start: z.string().optional().describe("YYYY-MM-DD；catalog查覆盖区间，rows仅day可切日期"),
    end: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    include_raw: z.boolean().optional().describe("按需取原始列；默认只给规范化字段")
  },
  async ({ account_id, include_raw, ...options }) => {
    try {
      const params = new URLSearchParams({ account: account_id });
      for (const [key, value] of Object.entries(options)) if (value != null) params.set(key, String(value));
      if (include_raw) params.set('include_raw', '1');
      const res = await fetch(`${API_BASE}/offline-reports?${params}`, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      return toMcpResult(data, { summary: `本地历史报表｜${account_id}｜${options.mode || 'catalog'}｜共${data.total ?? '未知'}条；不代表实时状态。` });
    } catch (e) {
      return toMcpResult(toErrorPayload(e, { component: 'offline_reports' }), { isError: true });
    }
  }
);

// ========== 2. 素材一站式（2026-08-14 三合一：搜索反查 + 累计摘要 + 深度透视/报告，18→14 工具面收敛） ==========
server.tool(
  "get_material",
  "素材一站式。mode=search：按名字/materialId 搜素材ID与累计消耗/ROI（需query；source=video-library千川视频库全渠道 / db本地历史库默认）；mode=summary：按ID查指定周期全渠道累计消耗/ROI（需material_id）；mode=detail：单素材深度透视（每日消耗趋势/秒级留存/人群画像/创意标签）；mode=report：单素材结构化分析报告（Markdown，含诊断与优化建议）；mode=both：detail+report；mode=hourly：单素材时段画像（小时级消耗/单量/ROI + 强/弱时段 + 调度建议，2026-08-15 维护者确认聚合：素材时段调度的数据通道，接口 /api/material-hourly）。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    mode: z.enum(["search", "summary", "detail", "report", "both", "hourly"]).describe("search=搜素材 / summary=累计摘要 / detail=深度透视 / report=分析报告 / both=透视+报告 / hourly=单素材时段画像(小时级单量ROI)"),
    query: z.string().optional().describe("素材名字片段或 materialId（mode=search 必填）"),
    material_id: z.string().optional().describe("素材唯一ID（mode=summary/detail/report/both 必填）"),
    source: z.enum(["db", "video-library"]).optional().describe("搜索源（mode=search 用）：db=本地历史库（默认） / video-library=千川视频库全渠道"),
    start: z.string().optional().describe("开始日期 YYYY-MM-DD（search 默认今天；detail/report 默认近30天）"),
    end: z.string().optional().describe("结束日期 YYYY-MM-DD（默认今天；detail/report 默认昨天）")
  },
  async ({ account_id, mode, query, material_id, source, start, end }) => {
    try {
      // ===== search：名字反查ID + 累计数据（沿用 2026-08-06 双源合并结论逻辑） =====
      if (mode === "search") {
        if (!query) {
          return { content: [{ type: "text", text: "Error: mode=search 必须传 query（素材名字片段或 materialId）" }], isError: true };
        }
        let url = `${API_BASE}/material-search?account=${encodeURIComponent(account_id)}&name=${encodeURIComponent(query)}`;
        if (source) url += `&source=${encodeURIComponent(source)}`;
        if (start) url += `&start=${encodeURIComponent(start)}`;
        if (end) url += `&end=${encodeURIComponent(end)}`;
        const data = await (await fetch(url)).json();
        // 缺陷四修复：db 源查无时自动补查 video-library，返回合并结论——避免"本地库命中/视频库未收录"割裂信息
        if (source === 'db' && data && data.ok === true && (!data.matches || !data.matches.length)) {
          try {
            let vlUrl = `${API_BASE}/material-search?account=${encodeURIComponent(account_id)}&name=${encodeURIComponent(query)}&source=video-library`;
            if (start) vlUrl += `&start=${encodeURIComponent(start)}`;
            if (end) vlUrl += `&end=${encodeURIComponent(end)}`;
            const vl = await (await fetch(vlUrl)).json();
            const merged = cleanMaterialSummary(vl, 'video-library全渠道');
            const vlHits = (vl && vl.matches) || [];
            const note = vlHits.length
              ? '【合并结论】本地历史库未收录，视频库命中（索引不同步，素材仍有效）'
              : '【合并结论】本地历史库与视频库均未收录';
            return { content: [{ type: "text", text: note + '\n' + JSON.stringify(merged || {}, null, 2) }] };
          } catch (e) {
            return wrap(data); // 补查失败返回原 db 结果
          }
        }
        return wrap(cleanMaterialSummary(data, source === 'db' ? '本地历史库' : 'video-library全渠道'));
      }

      // ===== summary：按ID累计摘要 =====
      if (mode === "summary") {
        if (!material_id) {
          return { content: [{ type: "text", text: "Error: mode=summary 必须传 material_id" }], isError: true };
        }
        let url = `${API_BASE}/materials/summary?account=${encodeURIComponent(account_id)}&id=${encodeURIComponent(material_id)}`;
        if (start) url += `&start=${encodeURIComponent(start)}`;
        if (end) url += `&end=${encodeURIComponent(end)}`;
        return wrap(cleanMaterialSummary(await (await fetch(url)).json()));
      }

      // 历史账户专用说明已从试用包移除。
      if (mode === "hourly") {
        if (!material_id) {
          return { content: [{ type: "text", text: "Error: mode=hourly 必须传 material_id" }], isError: true };
        }
        let url = `${API_BASE}/material-hourly?account=${encodeURIComponent(account_id)}&material_id=${encodeURIComponent(material_id)}`;
        if (start) url += `&start=${encodeURIComponent(start)}`;
        if (end) url += `&end=${encodeURIComponent(end)}`;
        const data = await (await fetch(url)).json();
        if (!data || data.ok === false) return wrap(data);
        // 精简输出：全量 hours 费 token，只回 profile 摘要 + 强/弱时段（上限条数），要全量明细走 HTTP
        const p = data.profile || {};
        const trimSlots = (slots, n) => (slots || []).slice(0, n).map(s => ({
          hour: s.hour, cost: s.cost, orders: s.orders, net_gmv: s.net_gmv, roi_1h: s.roi_1h
        }));
        const payload = {
          ok: true,
          material_id: data.material_id,
          name: data.name || null,
          range: data.range || null,
          summary: p.summary || null,
          tag: p.tag || null,
          strong_slots_top10: trimSlots(p.strong_slots, 10),
          weak_slots_top5: trimSlots(p.weak_slots, 5),
          best_hour: p.best_hour ? { hour: p.best_hour.hour, orders: p.best_hour.orders, roi_1h: p.best_hour.roi_1h } : null,
          worst_hour: p.worst_hour ? { hour: p.worst_hour.hour, orders: p.worst_hour.orders, roi_1h: p.worst_hour.roi_1h } : null,
          suggest_schedule: p.suggest_schedule || null,
          hint: "全量小时明细走 HTTP /api/material-hourly（MCP 精简只回画像摘要）"
        };
        return wrap(payload);
      }

      // ===== detail / report / both：深度透视与报告 =====
      if (!material_id) {
        return { content: [{ type: "text", text: `Error: mode=${mode} 必须传 material_id` }], isError: true };
      }
      let queryStr = `account=${account_id}&id=${encodeURIComponent(material_id)}`;
      if (start) queryStr += `&start=${start}`;
      if (end) queryStr += `&end=${end}`;

      const result = {};
      const fails = [];
      const requests = [];
      if (mode === "detail" || mode === "both") requests.push({
        name: 'detail', promise: fetchJson(`${API_BASE}/material-detail?${queryStr}`), clean: cleanMaterialInsight,
      });
      if (mode === "report" || mode === "both") requests.push({
        name: 'report', promise: fetchJson(`${API_BASE}/material-report?${queryStr}`), clean: cleanMaterialInsight,
      });
      const settled = await Promise.allSettled(requests.map(x => x.promise));
      settled.forEach((item, index) => {
        const request = requests[index];
        const data = settledData(item);
        result[request.name] = item.status === 'fulfilled' ? request.clean(data) : data;
        const failure = subFail(request.name, result[request.name]);
        if (failure) fails.push(failure);
      });
      // 主数据=所请求的子项：全部失败整体 isError；部分失败仅标注（成功子项仍可用）
      result.partial = fails.length > 0;
      result.errors = fails;
      return wrapAggregate(result, fails, fails.length >= requests.length);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 3. 罗盘数据一站式 ==========
server.tool(
  "get_compass_data",
  "罗盘数据一站式工具。type=snapshot：核心人群/画像/首页指标快照（判拉新辩护/经营质量）；type=goods：商品榜（素材选品）；type=orders：直播间实时订单流（本场已支付订单，需在播）；type=overview：店铺核心指标区间查询（经营参考，需 start/end）；type=refresh：触发重新采集（低频，10分钟限频）；type=all：snapshot+goods",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    type: z.enum(["snapshot", "goods", "orders", "overview", "refresh", "all"]).describe("snapshot=快照 / goods=商品榜 / orders=直播间实时订单(需在播) / overview=店铺指标 / refresh=触发采集 / all=快照+商品榜"),
    range: z.enum(["7d", "30d"]).optional().describe("时间范围（goods/refresh 用，默认 30d）"),
    start: z.string().optional().describe("开始日期 YYYY-MM-DD（overview 必填）"),
    end: z.string().optional().describe("结束日期 YYYY-MM-DD（overview 必填）")
  },
  async ({ account_id, type, range, start, end }) => {
    try {
      if (type === "snapshot") {
        const res = await fetch(`${API_BASE}/compass?account=${account_id}`);
        return wrap(cleanCompass(await res.json()));
      }
      if (type === "goods") {
        const res = await fetch(`${API_BASE}/compass/goods?account=${account_id}&range=${range || "30d"}`);
        return wrap(cleanCompassGoods(await res.json()));
      }
      if (type === "orders") {
        // 直播间订单流（2026-08-18 探针：罗盘大屏订单tab，签名端点直调已通；按品聚合）
        const res = await fetch(`${API_BASE}/compass/live-orders?account=${account_id}`);
        const data = await res.json();
        if (data && data.ok === false) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
        if (data && data.ok) {
          const prods = data.products || [];
          const list = data.orders || [];
          const prodHead = prods.map(p => `${p.product_title || p.sku_title || '未知品'}: ${p.order_cnt}单${p.item_num > p.order_cnt ? '(' + p.item_num + '件)' : ''} ¥${p.amount ?? '-'}`).join('\n');
          const head = list.slice(0, 8).map(o => `${o.order_ts ? new Date(o.order_ts * 1000).toTimeString().slice(0, 8) : ''} ${o.nick_name || ''} ¥${o.order_amount ?? '-'} ${o.product_title || ''}${o.sku_product_title ? '(' + o.sku_product_title + ')' : ''}${o.item_num > 1 ? ' ×' + o.item_num : ''}`).join('\n');
          return { content: [{ type: "text", text: `直播间订单（本场已支付）共 ${data.total} 单：\n【按品】\n${prodHead}\n【最近订单】\n${head}${list.length > 8 ? '\n…' : ''}` }] };
        }
        return wrap(data);
      }
      if (type === "overview") {
        if (!start || !end) {
          return { content: [{ type: "text", text: "Error: type=overview 必须传 start 和 end" }], isError: true };
        }
        const settled = await Promise.allSettled([
          fetchJson(`${API_BASE}/doudian/overview?account=${account_id}&start=${start}&end=${end}`),
          fetchJson(`${API_BASE}/doudian/summary?account=${account_id}&start=${start}&end=${end}`),
        ]);
        const ov = settledData(settled[0]);
        const sm = settledData(settled[1]);
        // 主数据=overview+summary 两项：全失败整体 isError；单失败仅标注
        const fails = [subFail("店铺overview", ov), subFail("店铺summary", sm)].filter(Boolean);
        return wrapAggregate({ overview: ov, summary: sm, partial: fails.length > 0, errors: fails }, fails, fails.length === 2);
      }
      if (type === "refresh") {
        const res = await fetch(`${API_BASE}/compass/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: account_id, range: range || "30d" })
        });
        return wrap(await res.json());
      }
      if (type === "all") {
        const settled = await Promise.allSettled([
          fetchJson(`${API_BASE}/compass?account=${account_id}`),
          fetchJson(`${API_BASE}/compass/goods?account=${account_id}&range=${range || "30d"}`),
        ]);
        const snapshot = settledData(settled[0]);
        const goods = settledData(settled[1]);
        // 主数据=snapshot+goods 两项：全失败整体 isError；单失败仅标注
        const fails = [subFail("快照", snapshot), subFail("商品榜", goods)].filter(Boolean);
        return wrapAggregate({
          snapshot: cleanCompass(snapshot), goods: cleanCompassGoods(goods),
          partial: fails.length > 0, errors: fails,
        }, fails, fails.length === 2);
      }
      return { content: [{ type: "text", text: `Error: 未知 type ${type}` }], isError: true };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 4. 读取 Agent 经验库 ==========
server.tool(
  "get_agent_lessons",
  "按需读取该账号已记录的经验与证据；不是已验证高胜率规则，自动评分产物已排除，不作为健康轮必读",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）")
  },
  async ({ account_id }) => {
    try {
      // Token 优化（2026-08-04）：lessons 库 30+ 篇全量返回太大（~43k tok）。
      // 先拉标题索引（轻量），再按需取最近 3 篇全文；其余由分身按标题自行判断后再取。
      const idx = await (await fetch(`${API_BASE}/agent-memory?type=lessons&account=${account_id}&mode=titles`)).json();
      const titles = (idx && idx.lessons) || [];
      const recentFull = [];
      for (const t of titles.slice(0, 3)) {
        try {
          const one = await (await fetch(`${API_BASE}/agent-memory?type=lessons&account=${account_id}&id=${encodeURIComponent(t.id)}`)).json();
          if (one && one.lessons && one.lessons[0]) recentFull.push(one.lessons[0]);
        } catch { /* 单篇失败跳过 */ }
      }
      return { content: [{ type: "text", text: JSON.stringify(cleanLessons({ ok: true, account: account_id, mode: 'slim', total_lessons: titles.length, all_titles: titles, recent_full: recentFull }), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 5. 沉淀可复用经验 ==========
server.tool(
  "record_agent_lesson",
  "保存一条经过后验验证、可复用的账号经验。普通盯盘轮次必须使用 record_watch_round；未经验证的临时判断不要写成经验。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验；经验按账号隔离）"),
    title: z.string().min(1).max(200).describe("经验标题，说明适用场景和结论"),
    body: z.string().min(1).max(20000).describe("经验正文，必须包含证据、适用条件和失效边界"),
    lesson_id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe("可选幂等ID；仅允许字母、数字、下划线和连字符"),
  },
  async ({ account_id, title, body, lesson_id }) => {
    try {
      const res = await fetch(`${API_BASE}/agent-memory?account=${account_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account_id,
          type: "lesson",
          content: { id: lesson_id, title, body },
        })
      });
      const data = await res.json();
      return formatWriteResult("record_agent_lesson", data);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 5.1 结构化盯盘决策台账（平台中立） ==========
server.tool(
  "record_watch_round",
  "记录观测、判断与实际操作，不打分、不统计胜率。先读 get_live_view dashboard 并绑定 snapshot_id；写动作带 operation_id，由服务端核对实际生效状态。可选记录预期和 check_after_minutes，仅用于连接同场前后事实，不认定因果；不要求为留痕编造量化预期。",
  {
    account_id: z.string().min(1).describe("账号ID；台账按账号物理隔离"),
    round_id: z.string().optional().describe("调用方幂等ID；安全重试时保持不变"),
    session_key: z.string().optional().describe("直播场次键；phase=live/post_live 时必填"),
    phase: z.enum(["pre_live", "live", "post_live", "offline"]).describe("轮次阶段"),
    round_no: z.union([z.string(), z.number()]).optional().describe("场次内轮次号"),
    observed_at: z.string().optional().describe("本轮数据观测时间 ISO-8601"),
    snapshot: z.record(z.any()).optional().describe("可信快照引用；只传 get_live_view dashboard 返回的 snapshot_id，服务端忽略调用方自报指标"),
    observations: z.array(z.record(z.any())).optional().describe("观测事实数组。保留素材待确认对象用{code:'MATERIAL_WATCH',object_key:摘要对象键,status:'pending',message:原因}；确认完用相同键status:'resolved'。同场持续保留，不受前10排名限制。"),
    judgments: z.array(z.record(z.any())).optional().describe("判断数组；expected_metrics 可选，只作预期记录，不评分"),
    recommendations: z.array(z.record(z.any())).optional().describe("建议数组，每项建议含 code/message"),
    actions: z.array(z.record(z.any())).optional().describe("实际执行动作；必须带 operation_id 才会与 op-log 验真，未操作传空数组"),
    summary: z.string().optional().describe("给人看的本轮一句话摘要"),
    expected_effect: z.any().optional().describe("单项预期兼容入口；推荐使用 judgments[].expected_metrics"),
    check_after_minutes: z.number().min(5).max(1440).optional().describe("前后事实观察窗口，默认120分钟，范围5~1440；无合格后快照标缺失，不为补数据重拉业务接口"),
    agent_platform: z.string().optional().describe("调用平台，如 codex/hermes/workbud"),
    task_ref: z.string().optional().describe("调用方任务引用；仅作提示，不作为可信身份")
  },
  async ({ account_id, ...round }) => {
    try {
      const data = await fetchJson(`${API_BASE}/decision-rounds?account=${encodeURIComponent(account_id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id, ...round }),
        deadlineMs: 10000,
      });
      return toMcpResult(data, {
        summary: data.duplicate
          ? `决策轮次已存在，幂等返回：${data.round_id}`
          : `决策轮次已记录：${data.round_id}`,
      });
    } catch (e) {
      return toMcpResult(toErrorPayload(e, { component: "decision_ledger" }), { isError: true });
    }
  }
);

server.tool(
  "manage_boost",
  "追投管理一站式。list/detail 返回 roi_goal_basis 与可用优化元数据；create/update_roi 可传 roi_basis，服务端以真实计划元数据核对，未知或冲突时阻断 ROI 写入。list=查全状态列表(前置闸必查)；detail=单任务素材明细(必传target_id，建议同时传primary_ad_id以回读口径)；diagnose=直播间诊断(只读,必传primary_ad_id)；create=创建(控成本传roi_goal；放量传duration且需在播；出价形态传bid15~35+audience_template，与roi_goal互斥、预算≤300、仅mar_goal=2；mar_goal=1商品卡仅放量传duration；一键起量传assist_task=true+必传duration,预算100~5000,无素材/ROI维度)；update_roi/budget/status/audience/bid=修改(必传target_id+primary_ad_id，ROI单次≤10%且硬锁≥30分钟，预算≤50%；预算/出价/定向同账户同对象调参≤3次/小时，启停不计调参额度；读取action_limits和available_actions，写回执effect_status=confirmed才算生效，update_audience传audience_template，update_bid传bid)；pause/resume=开停别名；stop=停止(6,仅追投任务)；delete=删除。写操作带熔断/op-log。数值随start/end，不传=近30天，当日值必传start=end=今日。passive_stop=true=系统强停勿resume",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    action: z.enum(["list", "detail", "create", "update_roi", "update_budget", "update_status", "pause", "resume", "stop", "diagnose", "update_audience", "update_bid", "delete"]).describe("list=全状态列表/detail=素材明细(必传target_id，slim=true压缩版~2KB)/diagnose=直播间诊断(只读,必传primary_ad_id)/create=创建/update_roi=改ROI/update_budget=改预算/update_status=开停(1开2停6停)/pause=暂停(别名→update_status 2)/resume=恢复(别名→update_status 1)/stop=停止(别名→update_status 6)/update_audience=改定向/update_bid=改出价/delete=删除"),
    primary_ad_id: z.string().optional().describe("全域计划ID（create/update/delete 必填，未传时自动从 config.qianchuan_accounts[].primary_ad_id 取；list 可选，不传合并全部计划）"),
    target_id: z.string().optional().describe("追投任务ID（detail/update/delete 必填，create 不传）"),
    target_ids: z.array(z.string().min(1)).max(10).optional().describe("批量 detail 的追投任务ID；与 target_id 二选一，最多10个，服务端受控并发查询后一次返回"),
    session_key: z.string().optional().describe("detail 可选请求场次标识；当前上游只提供日期累计，返回的 session_metrics 会明确标记不可归因"),
    slim: z.boolean().optional().describe("detail 压缩版（2026-08-17 维护者：省 token）——只返回素材层汇总+Totals（~2KB），砍三层嵌套；盯盘筛选素材用 slim=true"),
    value: z.number().optional().describe("新值（update_roi=ROI数字 / update_budget=预算金额 / update_status=1或2 / update_bid=出价）"),
    budget: z.number().optional().describe("预算（create 必填，>100元）"),
    roi_goal: z.number().optional().describe("ROI目标（create 控成本必填，0.01~100；数值必须来自已确认的账户 Profile 或工作区策略）"),
    roi_basis: z.enum(["payment", "platform_net_1h", "final_settlement", "chengfang_comprehensive", "unknown"]).optional().describe("ROI目标口径；create/update_roi 可选。与真实计划元数据冲突或元数据无法识别时，ROI写入会被阻断"),
    bid: z.number().optional().describe("手动出价 元/成交：15~35，与 roi_goal 互斥、仅 mar_goal=2、预算≤300"),
    audience_template: z.enum(["full_region"]).optional().describe("定向模板：仅提供平台全地域枚举；客户画像模板未分发"),
    duration: z.number().optional().describe("投放时长秒数（create 放量必填，60~86400）"),
    live_feed: z.boolean().optional().describe("直播间画面直投：与 mids 互斥、必须配 bid 15~35"),
    assist_task: z.boolean().optional().describe("一键起量形态（2026-08-17 探针）：传 true 即 Scene=1+InterfereType=1，无素材/ROI/出价维度，必须配 duration，预算 100~5000 元"),
    name: z.string().optional().describe("任务名（create 可选）"),
    smart_bid_type: z.enum(["0", "7"]).optional().describe("0=控成本(默认) / 7=放量（create 可选）"),
    mar_goal: z.enum(["1", "2"]).optional().describe("营销目标：2=直播间(默认) / 1=商品卡(仅放量，必传duration、不传roi_goal、无需在播)"),
    mids: z.array(z.string()).optional().describe("素材ID列表（create 必填，最多50个）"),
    start: z.string().optional().describe("list/detail 可选：开始日期 YYYY-MM-DD（list 默认近30天，detail 默认今天）"),
    end: z.string().optional().describe("list/detail 可选：结束日期 YYYY-MM-DD（默认今天）")
  },
  async ({ account_id, action, primary_ad_id, target_id, target_ids, session_key, value, budget, roi_goal, roi_basis, bid, audience_template, live_feed, duration, name, smart_bid_type, mar_goal, mids, start, end, assist_task, slim }) => {
    try {
      if (!["list", "detail", "diagnose"].includes(action)) {
        const blocked = enforceWritePolicy("boost", action, account_id);
        if (blocked) return blocked;
      }
      // 历史账户专用说明已从试用包移除。
      if (action === "pause") {
        action = "update_status";
        if (value == null) value = 2;
      } else if (action === "resume") {
        action = "update_status";
        if (value == null) value = 1;
      } else if (action === "stop") {
        action = "update_status";
        if (value == null) value = 6;
      }

      // diagnose：只读——千川直播间诊断（2026-08-17 探针接口 live_diagnosis，短建议文案）
      if (action === "diagnose") {
        if (!primary_ad_id) {
          return { content: [{ type: "text", text: "Error: action=diagnose 必须传 primary_ad_id（要诊断的全域计划ID）" }], isError: true };
        }
        const res = await fetch(`${API_BASE}/live-diagnosis?account=${encodeURIComponent(account_id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adIDs: [primary_ad_id], invalidSceneTag: [], isRoi2: true })
        });
        const data = await res.json();
        if (data && data.ok === false) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
        return wrap({ account_id, primary_ad_id, diagnosis: data.diagnosis || null });
      }

      // list：只读全状态列表（含暂停/已删），manage_boost 唯一不写动作
      if (action === "list") {
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (start && !dateRe.test(start)) return { content: [{ type: "text", text: "Error: start 格式须为 YYYY-MM-DD" }], isError: true };
        if (end && !dateRe.test(end)) return { content: [{ type: "text", text: "Error: end 格式须为 YYYY-MM-DD" }], isError: true };
        let url = `${API_BASE}/boost-list?account=${encodeURIComponent(account_id)}&includeAllStatus=1`;
        if (primary_ad_id) url += `&adId=${encodeURIComponent(primary_ad_id)}`;
        if (mar_goal) url += `&marGoal=${encodeURIComponent(mar_goal)}`; // 商品卡任务监测（2026-08-03：mar_goal=1 计划的追投默认口径看不到）
        if (start) url += `&start=${encodeURIComponent(start)}`;
        if (end) url += `&end=${encodeURIComponent(end)}`;
        const res = await fetch(url);
        const data = await res.json();
        // 历史账户专用说明已从试用包移除。
        if (data && data.ok && data.date_range) {
          const scopeNote = (start || end) ? '' : '（未传日期=近30天累计口径，非当日）';
          // 2026-08-04 净化：adInfos 逐项 slim（剔恒空 show_cnt/click_cnt/refund_rate）
          return { content: [{ type: "text", text: `数据范围：${data.date_range}${scopeNote}\n` + JSON.stringify(cleanBoostList(data), null, 2) }] };
        }
        return wrap(cleanBoostList(data));
      }

      // detail：可单任务或受控并发批量读取；所有结果保持同一 JSON，避免调用方拼接。
      if (action === "detail") {
        const detailIds = target_ids ? [...new Set(target_ids)] : (target_id ? [target_id] : []);
        if (!detailIds.length) return { content: [{ type: "text", text: "Error: action=detail 必须传 target_id 或 target_ids" }], isError: true };
        if (target_ids && target_id) return { content: [{ type: "text", text: "Error: detail 请只传 target_id 或 target_ids" }], isError: true };
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (start && !dateRe.test(start)) return { content: [{ type: "text", text: "Error: start 格式须为 YYYY-MM-DD" }], isError: true };
        if (end && !dateRe.test(end)) return { content: [{ type: "text", text: "Error: end 格式须为 YYYY-MM-DD" }], isError: true };
        const fetchDetail = async id => {
          // Reserve a small tail for workers to serialize settled results before
          // the tool-level deadline Promise.race rejects the whole batch.
          const context = deadlineContext.getStore();
          const remainingMs = context ? context.deadlineAt - Date.now() - 1000 : 59000;
          if (remainingMs <= 0) {
            return { target_id: id, ok: false, error: { code: 'detail_timeout', message: 'batch deadline budget exhausted before request started' } };
          }
          let url = `${API_BASE}/boost-material-detail?account=${encodeURIComponent(account_id)}&assistAid=${encodeURIComponent(id)}`;
          if (primary_ad_id) url += `&primaryAdId=${encodeURIComponent(primary_ad_id)}`;
          if (slim) url += `&slim=1`;
          if (session_key) url += `&session_key=${encodeURIComponent(session_key)}`;
          if (start) url += `&start=${encodeURIComponent(start)}`;
          if (end) url += `&end=${encodeURIComponent(end)}`;
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(60000, remainingMs)) });
            const data = await response.json();
            if (!response.ok || data?.ok !== true) {
              return { target_id: id, ok: false, error: data?.error || data?.message || `detail_http_${response.status}`, response: data };
            }
            return { target_id: id, ...data };
          } catch (error) {
            return { target_id: id, ok: false, error: {
              code: error?.name === 'TimeoutError' ? 'detail_timeout' : 'detail_request_failed',
              message: error?.message || 'detail request failed',
            } };
          }
        };
        const details = new Array(detailIds.length); let next = 0;
        await Promise.all(Array.from({ length: Math.min(2, detailIds.length) }, async () => {
          while (next < detailIds.length) { const i = next++; details[i] = await fetchDetail(detailIds[i]); }
        }));
        if (target_id) {
          const { target_id: ignored, ...single } = details[0];
          return wrap(single);
        }
        return wrap({ ok: details.every(item => item?.ok === true), partial: details.some(item => item?.ok !== true),
          account_id, action: 'detail', session_key: session_key || null, requested_target_ids: detailIds, concurrency: 2, details });
      }

      // 历史账户专用说明已从试用包移除。
      // 速度优化——分身创建追投省一轮 list-required 查询（计划ID 固定不变，配置化）
      if (!primary_ad_id) {
        const acctCfg = (require("../lib/config").QIANCHUAN_ACCOUNTS || []).find(a => a.id === account_id);
        primary_ad_id = acctCfg && acctCfg.primary_ad_id;
        if (!primary_ad_id) {
          return { content: [{ type: "text", text: `Error: action=${action} 必须传 primary_ad_id（且 config.qianchuan_accounts[${account_id}].primary_ad_id 未配置）` }], isError: true };
        }
      }

      if (action === "create") {
        if (assist_task) {
          // 一键起量形态（2026-08-17 探针）：预算 100~5000，必传 duration，无素材维度
          if (!budget || budget < 100 || budget > 5000) {
            return { content: [{ type: "text", text: "Error: assist_task 一键起量预算须 100~5000 元" }], isError: true };
          }
          if (!duration) {
            return { content: [{ type: "text", text: "Error: assist_task 一键起量必须传 duration（投放时长秒数，如 7200=2小时）" }], isError: true };
          }
          if (mids && mids.length) {
            return { content: [{ type: "text", text: "Error: assist_task 一键起量无素材维度，请去掉 mids" }], isError: true };
          }
          if (roi_goal != null || bid != null) {
            return { content: [{ type: "text", text: "Error: assist_task 一键起量无 ROI/出价维度（按 duration 时长加速），请去掉 roi_goal/bid" }], isError: true };
          }
        } else {
          if (!budget || budget <= 100) {
            return { content: [{ type: "text", text: "Error: create 必须传 budget >100" }], isError: true };
          }
          if (!live_feed && (!mids || !mids.length)) {
            return { content: [{ type: "text", text: "Error: create 必须传 mids（素材ID列表；直播间画面形态传 live_feed=true）" }], isError: true };
          }
        }
        const payload = { accountId: account_id, primaryAdId: primary_ad_id, budget, source: "agent" };
        if (mids && mids.length) payload.mids = mids;
        if (live_feed) payload.liveFeed = true; // 直播间画面形态（与 mids 互斥，服务端校验）
        if (assist_task) payload.assistTask = true; // 一键起量形态（与 mids/roi/bid 互斥，服务端校验）
        if (name) payload.name = name;
        if (smart_bid_type != null) payload.smartBidType = Number(smart_bid_type);
        if (mar_goal != null) payload.marGoal = Number(mar_goal);
        if (roi_goal != null) payload.ecpRoi2Goal = roi_goal;
        if (roi_basis != null) payload.roiBasis = roi_basis;
        if (bid != null) payload.bid = bid; // 手动出价形态（与 roi_goal 互斥，服务端校验）
        if (audience_template != null) payload.audienceTemplate = audience_template;
        if (duration != null) payload.duration = duration;
        const res = await fetch(`${API_BASE}/boost-create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        const withReadback = await attachBoostWriteReadback(data, {
          accountId: account_id,
          primaryAdId: primary_ad_id,
          targetId: data && data.task_id,
          requested: { budget, ...(bid != null ? { bid } : roi_goal != null ? { roi_goal } : {}) },
        });
        return formatWriteResult("create", withReadback);
      }

      if (action === "delete") {
        const res = await fetch(`${API_BASE}/boost-delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: account_id, assistTaskId: target_id, source: "agent" })
        });
        const data = await res.json();
        return formatWriteResult("delete", data);
      }

      // 历史账户专用说明已从试用包移除。
      const missing = [];
      if (!target_id) missing.push("target_id（追投任务ID）");
      if (action === "update_audience") {
        if (!audience_template) missing.push("audience_template");
      } else if (action === "update_bid") {
        if (bid == null && value == null) missing.push("bid 或 value（出价金额元/单）");
      } else if (value == null) {
        missing.push("value");
      }
      if (action === "update_status" && value != null && ![1, 2, 6].includes(value)) {
        missing.push("value 必须是 1(开启)、2(暂停) 或 6(停止)");
      }
      if (missing.length) {
        return { content: [{ type: "text", text: `Error: action=${action} 参数缺失/非法：${missing.join("、")}（update 系列必传 primary_ad_id + target_id + 对应新值）` }], isError: true };
      }

      const path = action === "update_status" ? "/campaign/status" : "/campaign/budget";
      const payload = { accountId: account_id, primaryAdId: primary_ad_id, assistTaskId: target_id, source: "agent" };
      if (action === "update_roi") payload.roiGoal = value;
      else if (action === "update_budget") payload.budget = value;
      else if (action === "update_audience") payload.audienceTemplate = audience_template;
      else if (action === "update_bid") payload.bid = bid != null ? bid : value;
      else payload.status = value;
      if (action === "update_roi" && roi_basis != null) payload.roiBasis = roi_basis;

      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      const withReadback = await attachBoostWriteReadback(data, {
        accountId: account_id,
        primaryAdId: primary_ad_id,
        targetId: target_id,
      });
      return formatWriteResult(action, withReadback);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// 历史账户专用说明已从试用包移除。
server.tool(
  "manage_plan",
  "主计划(全域计划本身)调整。update_roi改ROI目标(0.01~100)，可传roi_basis与真实计划元数据核对，未知或冲突时阻断；update_budget改预算(元)；update_status开停(1开2停)。熔断+op-log。primary_ad_id 可从 config.qianchuan_accounts[].primary_ad_id 自动取",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    action: z.enum(["update_roi", "update_budget", "update_status"]).describe("update_roi=改主计划ROI目标 / update_budget=改预算 / update_status=改状态(1开2停)"),
    primary_ad_id: z.string().optional().describe("全域计划ID（未传时从 config 自动取账号 primary_ad_id）"),
    value: z.number().describe("新值（update_roi=ROI数字 / update_budget=预算金额元 / update_status=1或2）"),
    roi_basis: z.enum(["payment", "platform_net_1h", "final_settlement", "chengfang_comprehensive", "unknown"]).optional().describe("update_roi 的目标口径；与真实计划元数据冲突或无法识别时阻断")
  },
  async ({ account_id, action, primary_ad_id, value, roi_basis }) => {
    try {
      const blocked = enforceWritePolicy("plan", action, account_id);
      if (blocked) return blocked;
      // 历史账户专用说明已从试用包移除。
      if (!primary_ad_id) {
        const acctCfg = (require("../lib/config").QIANCHUAN_ACCOUNTS || []).find(a => a.id === account_id);
        primary_ad_id = acctCfg && acctCfg.primary_ad_id;
        if (!primary_ad_id) {
          return { content: [{ type: "text", text: `Error: 必须传 primary_ad_id（且 config.qianchuan_accounts[${account_id}].primary_ad_id 未配置）` }], isError: true };
        }
      }
      if (value == null) {
        return { content: [{ type: "text", text: `Error: action=${action} 必须传 value` }], isError: true };
      }
      let path, payload;
      if (action === "update_status") {
        if (![1, 2].includes(value)) {
          return { content: [{ type: "text", text: "Error: 状态值只支持 1=开启 / 2=暂停" }], isError: true };
        }
        path = "/campaign/status";
        payload = { accountId: account_id, primaryAdId: primary_ad_id, status: value, source: "agent" };
      } else {
        if (action === "update_roi" && (value < 0.01 || value > 100)) {
          return { content: [{ type: "text", text: "Error: ROI 目标范围 0.01~100" }], isError: true };
        }
        if (action === "update_budget" && (!Number.isFinite(value) || value <= 0)) {
          return { content: [{ type: "text", text: "Error: 预算必须 > 0（元）" }], isError: true };
        }
        path = "/campaign/budget";
        payload = { accountId: account_id, primaryAdId: primary_ad_id, source: "agent" };
        if (action === "update_roi") {
          payload.roiGoal = value;
          if (roi_basis != null) payload.roiBasis = roi_basis;
        }
        else payload.budget = value;
      }
      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      return formatWriteResult("manage_plan:" + action, data);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 8.6 一键控量（独立短时消耗上限，不修改主计划 ROI） ==========
server.tool(
  "manage_flow_control",
  "一键控量管理。status 读取当前任务、预算与起止时间；start 创建已验证的30分钟最大消耗任务，不修改主计划ROI。start 必须先读 status，已有任务时阻断重复创建；成功后服务端回读并返回 operation_id。停止接口尚未抓取，当前不提供 stop。",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    action: z.enum(["status", "start"]).describe("status=只读状态 / start=开启30分钟一键控量"),
    primary_ad_id: z.string().optional().describe("全域主计划ID；未传时从账户配置读取"),
    budget: z.number().min(100).max(5000).optional().describe("30分钟最大消耗预算（元）；action=start 必填，范围100~5000"),
    duration_minutes: z.literal(30).optional().describe("当前仅支持已抓包验证的30分钟；可省略，默认30"),
  },
  async ({ account_id, action, primary_ad_id, budget, duration_minutes }) => {
    try {
      if (!primary_ad_id) {
        const account = (require("../lib/config").QIANCHUAN_ACCOUNTS || []).find(item => item.id === account_id);
        primary_ad_id = account && account.primary_ad_id;
      }
      if (!primary_ad_id) {
        return toMcpResult({ ok: false, code: 'primary_ad_id_missing', message: `账户 ${account_id} 未配置主计划ID` }, { isError: true });
      }
      if (action === 'status') {
        const data = await fetchJson(`${API_BASE}/flow-control?account=${encodeURIComponent(account_id)}&primaryAdId=${encodeURIComponent(primary_ad_id)}`);
        return toMcpResult(data, {
          summary: data.flow_control && data.flow_control.active
            ? `一键控量进行中：30分钟上限${data.flow_control.budget}元，结束于${data.flow_control.end_time}`
            : '当前无进行中的一键控量任务',
        });
      }
      const blocked = enforceWritePolicy('plan', 'flow_control_start', account_id);
      if (blocked) return blocked;
      if (budget == null) {
        return toMcpResult({ ok: false, code: 'budget_required', message: 'action=start 必须传 budget（元）' }, { isError: true });
      }
      const data = await fetchJson(`${API_BASE}/flow-control?account=${encodeURIComponent(account_id)}&primaryAdId=${encodeURIComponent(primary_ad_id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: account_id,
          primaryAdId: primary_ad_id,
          budget,
          durationMinutes: duration_minutes || 30,
          source: 'agent',
        }),
      });
      return toMcpResult(data, { isError: data.ok === false, summary: data.message });
    } catch (error) {
      return toMcpResult(toErrorPayload(error, { component: 'flow_control' }), { isError: true });
    }
  }
);

// ========== 9. 素材操作与待确认（写操作） ==========
server.tool(
  "manage_material_ops",
  "素材操作与待确认队列一站式。rename_precheck 根据角色预览官方视频库名称，不写入；rename_confirm 仅在人工确认预览后执行，必须携带预检返回的 expected_current_name，成功后回读并同步本地库。删除仍走 precheck/propose 队列。返回极简文本",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    action: z.enum(["precheck", "propose", "list", "reject", "rename_precheck", "rename_confirm"]).describe("删素材预检/提案/队列，或素材改名预检/确认"),
    ad_id: z.string().optional().describe("计划/广告ID（precheck/propose 必填）"),
    object_id: z.string().optional().describe("素材对象ID（precheck/propose 可选）"),
    lego_mids: z.array(z.string()).optional().describe("素材ID列表（precheck/propose 可选）"),
    type: z.enum(["delete_material", "delete_boost", "pause_boost", "resume_boost", "create_boost"]).optional().describe("建议类型（propose 必填）"),
    params: z.record(z.any()).optional().describe("执行参数（propose 必填，如 {adId, objectId, legoMids}）"),
    reason: z.string().optional().describe("建议理由（propose 必填，带数据依据）"),
    auto_execute: z.boolean().optional().describe("仅 delete_material 可用；只有当前 Agent 已完成判断并明确授权时才传 true，项目不会自行升级建议"),
    id: z.string().optional().describe("待确认建议ID（reject 必填）"),
    material_id: z.string().optional().describe("素材ID（rename_* 必填）"),
    role: z.enum(["种草", "收割", "承接", "探索", "待定"]).optional().describe("素材角色（rename_* 必填）"),
    new_name: z.string().max(50).optional().describe("完整新名称；不传时按 [角色]当前名称 生成"),
    expected_current_name: z.string().max(50).optional().describe("rename_confirm 必填，必须等于 rename_precheck 返回的 current_name")
  },
  async ({ account_id, action, ad_id, object_id, lego_mids, type, params, reason, auto_execute, id, material_id, role, new_name, expected_current_name }) => {
    try {
      if (["propose", "reject", "rename_confirm"].includes(action)) {
        const blocked = enforceWritePolicy("material", action, account_id);
        if (blocked) return blocked;
      }
      if (action === "rename_precheck" || action === "rename_confirm") {
        if (!material_id || !role) {
          return { content: [{ type: "text", text: `Error: ${action} 必须传 material_id 和 role` }], isError: true };
        }
        if (action === "rename_confirm" && !expected_current_name) {
          return { content: [{ type: "text", text: "Error: rename_confirm 必须传预检返回的 expected_current_name" }], isError: true };
        }
        const payload = {
          accountId: account_id,
          materialId: material_id,
          role,
          confirm: action === "rename_confirm",
          source: "agent",
        };
        if (new_name) payload.newName = new_name;
        if (expected_current_name) payload.expectedCurrentName = expected_current_name;
        const res = await fetch(`${API_BASE}/material/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        return formatMaterialOpResult(action, await res.json());
      }
      if (action === "precheck") {
        if (!ad_id) {
          return { content: [{ type: "text", text: "Error: precheck 必须传 ad_id" }], isError: true };
        }
        const payload = { accountId: account_id, adId: ad_id, confirm: false };
        if (object_id) payload.objectId = object_id;
        if (lego_mids) payload.legoMids = lego_mids;
        const res = await fetch(`${API_BASE}/material/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        return formatMaterialOpResult("precheck", await res.json());
      }

      if (action === "propose") {
        if (!type || !params || !reason) {
          return { content: [{ type: "text", text: "Error: propose 必须传 type、params、reason" }], isError: true };
        }
        // 与工具描述契约一致：auto_execute 仅 delete_material 授权通道可用（服务端也只对 delete_material 开自动复核）
        if (auto_execute === true && type !== "delete_material") {
          return { content: [{ type: "text", text: "Error: auto_execute 仅 delete_material 可用，其他类型请走人工确认（不传 auto_execute）" }], isError: true };
        }
        const payload = { account: account_id, accountId: account_id, type, params, reason };
        if (auto_execute != null) payload.auto_execute = auto_execute;
        const res = await fetch(`${API_BASE}/pending-ops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        return formatMaterialOpResult("propose", await res.json());
      }

      if (action === "list") {
        const res = await fetch(`${API_BASE}/pending-ops?account=${account_id}`);
        return formatMaterialOpResult("list", await res.json());
      }

      if (action === "reject") {
        if (!id) {
          return { content: [{ type: "text", text: "Error: reject 必须传 id（先 list 获取）" }], isError: true };
        }
        const res = await fetch(`${API_BASE}/pending-ops/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data && data.ok === false) return { content: [{ type: "text", text: `Error: ${data.error || data.message || "驳回失败"}` }], isError: true };
        return formatMaterialOpResult("reject", data);
      }

      return { content: [{ type: "text", text: `Error: 未知 action ${action}` }], isError: true };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 10. 编导素材简报（只读，给写作 agent） ==========
function formatBriefMarkdown(data) {
  if (!data || data.ok === false) return `获取简报失败: ${data?.error || '未知错误'}`;

  const lines = [];
  lines.push(`# 千川素材编导简报 (账号: ${data.account || ''})`);
  lines.push(`- 统计窗口：${data.range || '近7天'}`);
  lines.push(`- 保本净ROI：${data.break_even_roi != null ? data.break_even_roi : '未配置'}`);
  lines.push('');

  // 1. 跑量标杆榜
  lines.push('## 1. 跑量标杆榜 (Top 10 消耗素材)');
  if (Array.isArray(data.top_materials) && data.top_materials.length > 0) {
    lines.push('| 素材名称 | 创意标签 | 消耗(元) | 净ROI | 成交单数 |');
    lines.push('|---|---|---|---|---|');
    data.top_materials.forEach(m => {
      const name = m.name || m.material_id;
      const tags = m.tags || '-';
      const cost = m.cost != null ? Number(m.cost).toFixed(2) : '0.00';
      const netRoi = m.net_roi != null ? m.net_roi : '-';
      const orders = m.orders != null ? m.orders : 0;
      lines.push(`| ${name} | ${tags} | ${cost} | ${netRoi} | ${orders} |`);
    });
  } else {
    lines.push('暂无跑量标杆素材');
  }
  lines.push('');

  // 1.5 效益标杆榜
  lines.push('## 1.5 效益标杆榜（能赚钱的）');
  if (Array.isArray(data.profit_materials) && data.profit_materials.length > 0) {
    lines.push('| 素材名称 | 创意标签 | 消耗(元) | 净ROI | 成交单数 |');
    lines.push('|---|---|---|---|---|');
    data.profit_materials.forEach(m => {
      const name = m.name || m.material_id;
      const tags = m.tags || '-';
      const cost = m.cost != null ? Number(m.cost).toFixed(2) : '0.00';
      const netRoi = m.net_roi != null ? m.net_roi : '-';
      const orders = m.orders != null ? m.orders : 0;
      lines.push(`| ${name} | ${tags} | ${cost} | ${netRoi} | ${orders} |`);
    });
  } else {
    lines.push(data.profit_note || '本期无效益标杆：跑量素材全部低于保本线，新文案重点解决劝服深度而非找新题材');
  }
  lines.push('');

  if (data.tags_missing) {
    lines.push(`*注：${data.tags_missing}*`);
    lines.push('');
  }

  // 2. Hook 表现
  lines.push('## 2. 前5秒 Hook 留存表现');
  const hs = data.hook_summary;
  if (hs) {
    lines.push(`- 数据覆盖：${hs.coverage || '无'}`);
    if (hs.data_count > 0) {
      lines.push(`- 平均5秒流失率：${hs.avg_churn_rate_5s != null ? hs.avg_churn_rate_5s + '%' : '-'}`);
      if (hs.best) lines.push(`- 最佳 Hook：${hs.best.name || hs.best.material_id} (5秒流失率: ${hs.best.churn_rate_5s}%)`);
      if (hs.worst) lines.push(`- 最差 Hook：${hs.worst.name || hs.worst.material_id} (5秒流失率: ${hs.worst.churn_rate_5s}%)`);
    }
  } else {
    lines.push(`留存概况数据不可用${data.hook_summary_error ? ` (${data.hook_summary_error})` : ''}`);
  }
  lines.push('');

  // 3. 高频标签
  lines.push('## 3. 高频爆款创意标签 Top 5');
  if (Array.isArray(data.hot_tags) && data.hot_tags.length > 0) {
    data.hot_tags.forEach(t => {
      lines.push(`- ${t.tag} (${t.count} 次)`);
    });
  } else {
    lines.push('暂无高频标签');
  }
  lines.push('');

  // 4. 避雷清单
  lines.push('## 4. 避雷清单 (近7天亏损/高隐患素材)');
  if (Array.isArray(data.avoid_list) && data.avoid_list.length > 0) {
    data.avoid_list.forEach(m => {
      lines.push(`- **${m.name || m.material_id}**：${m.why || `耗 ${m.cost} 元，净ROI ${m.net_roi}`}`);
    });
  } else {
    lines.push('近7天无避雷素材（无高消耗且低ROI的亏损素材）');
  }
  lines.push('');

  // 5. 人群画像
  lines.push('## 5. 罗盘核心人群画像');
  const p = data.portrait;
  if (p) {
    if (Array.isArray(p.consumer) && p.consumer.length > 0) {
      lines.push(`- 核心消费人群：${p.consumer.map(c => `${c.name} (${c.pct}%)`).join('、')}`);
    }
    if (p.sex) lines.push(`- 主导性别：${p.sex.name} (${p.sex.pct}%)`);
    if (p.age) lines.push(`- 主力年龄：${p.age.name} (${p.age.pct}%)`);
  } else {
    lines.push(`人群画像暂不可用${data.portrait_error ? ` (${data.portrait_error})` : ''}`);
  }

  return lines.join('\n');
}

server.tool(
  "get_creator_brief",
  "编导写素材文案前调用，获取跑量标杆/Hook表现/避雷/人群画像，只读",
  {
    account_id: z.string().min(1).describe("账号ID（运行时校验）"),
    format: z.enum(["markdown", "json"]).optional().describe("输出格式：markdown 简报 (默认) / json 原始数据")
  },
  async ({ account_id, format }) => {
    try {
      const res = await fetch(`${API_BASE}/creator-brief?account=${encodeURIComponent(account_id)}`);
      const data = await res.json();
      if (data && data.ok === false) {
        return { content: [{ type: "text", text: `Error: ${data.error || "获取编导简报失败"}` }], isError: true };
      }
      if (format === "json") {
        return wrap(cleanCreatorBrief(data));
      }
      const md = formatBriefMarkdown(data);
      return { content: [{ type: "text", text: md }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ========== 15. 净ROI计算器（纯计算，不取数；涉钱执行前回算用，防脑算口径错） ==========
server.tool(
  "calc_roi",
  "千川净ROI计算与保本线判定（纯计算，无取数）。入参消耗+净GMV+可选保本线，出参结算净ROI与相对保本线的操作判定（可放大/可扶持/需止损）。涉钱执行前用它回算，避免脑算口径错。",
  {
    cost: z.number().positive().describe("消耗（元）"),
    net_gmv: z.number().describe("结算净GMV（元，扣退款）"),
    break_even: z.number().positive().optional().describe("保本线ROI（可选，不传只算ROI不判定）")
  },
  async ({ cost, net_gmv, break_even }) => {
    try {
      const roi = net_gmv / cost;
      let out = `净ROI = ${roi.toFixed(4)}（净GMV ${net_gmv} ÷ 消耗 ${cost}）`;
      if (break_even != null && break_even > 0) {
        const ratio = roi / break_even;
        out += `；保本线 ${break_even}，倍率 ${ratio.toFixed(3)}`;
        if (roi >= 1.3 * break_even) out += ' → 优质可放大';
        else if (roi >= break_even) out += ' → 达标可扶持';
        else if (roi < 0.5 * break_even) out += ' → 亏损需止损';
        else out += ' → 观察区';
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// 历史账户专用说明已从试用包移除。
// 背景：08:07~10:20 出现"进程在但工具未注册"僵尸态——connect 失败时旧代码 catch 只打印不退出，
// 进程残留但工具没注册进宿主，表现为 tool not found。加固：connect 失败立即 exit(1) 防僵尸；
// 启动后打印工具计数自检日志，便于故障时快速定位（无此日志=注册阶段就挂了）。

async function run() {
  const transport = new StdioServerTransport();
  // 传输层异常监听：stdio 通道断开时主动退出，防僵尸进程（进程在但宿主调不到工具）
  transport.onclose = () => {
    console.error("[mcp] stdio transport closed, exiting");
    process.exit(0);
  };
  transport.onerror = (e) => {
    console.error("[mcp] stdio transport error:", e?.message || e);
    process.exit(1);
  };
  await server.connect(transport);
  // 工具注册计数自检（server.tool 注册是同步的，connect 后确认全部就位）
  const toolCount = server._registeredTools ? Object.keys(server._registeredTools).length : 14;
  console.error(`Qianchuan MCP Server running on stdio (${toolCount} tools registered: ${accountIds().join('/')})`);
}

if (require.main === module) {
  run().catch((e) => {
    // connect 失败必须退出，否则进程残留成僵尸（进程在但工具没注册，宿主调到 tool not found）
    console.error("[mcp] FATAL: server.connect failed:", e?.message || e);
    process.exit(1);
  });
}

module.exports = { server };
