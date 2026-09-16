// 历史账户专用说明已从试用包移除。
//
// 原则：
//   - 成功：一句结论 + 精简结构化回执；保留真实 operation_id 和逐字段回读结果
//   - 失败：保留 Error: msg + 详细 JSON（失败必须留排查细节，防盲目重试）
//   - 未确认：保留操作编号，仅允许只读核验，不指示自动重发
//   - 与 manage_material_ops 的 formatMaterialOpResult 同思路（2026-08-06 已先例）

/**
 * 写操作结果极简格式化。
 * @param {string} action create/delete/update_roi/update_budget/update_status/
 *                        manage_plan:update_roi|update_budget|update_status/record_agent_lesson
 * @param {object} data 后端 HTTP 响应（{ ok:true, message?, msg?, ... }）
 * @returns {{content:[{type:'text',text}], isError?:true}}
 */
function formatWriteResult(action, data) {
  // ===== 失败分支（复用 formatWriteError 语义，保留排查细节） =====
  if (!data || data.ok === false) {
    const msg = (data && (data.error || data.message)) || "未知错误";
    return {
      content: [{ type: "text", text: `Error: ${msg}\n详细: ${JSON.stringify(data || {}, null, 2)}` }],
      isError: true,
      structuredContent: data || {},
    };
  }

  // ===== 成功分支：一行短句 =====
  let line;
  const msg = data.message || data.msg || "";

  if (action === "create") {
    const parts = [msg || "追投任务已创建"];
    if (data.budget != null) parts.push(`预算${data.budget}元`);
    if (data.smart_bid_type === 7) parts.push("放量");
    else if (data.smart_bid_type === 0) parts.push("控成本");
    if (data.mar_goal === 1) parts.push("商品卡");
    if (data.task_id) parts.push(`ID=${data.task_id}`);
    line = parts.join(" · ");
  } else if (action === "delete") {
    line = msg || "追投任务已删除";
  } else if (action === "update_status") {
    line = msg || "追投状态已更新";
  } else if (action === "update_roi" || action === "update_budget") {
    line = msg || `追投${action === "update_roi" ? " ROI 已调整" : " 预算已调整"}`;
  } else if (action.indexOf("manage_plan:") === 0) {
    const sub = action.slice("manage_plan:".length);
    line = msg || `主计划${sub === "update_roi" ? " ROI 已调整" : sub === "update_budget" ? " 预算已调整" : " 状态已更新"}`;
  } else if (action === "record_agent_lesson") {
    line = msg || "经验已保存";
  } else {
    line = msg || "操作成功";
  }

  const readback = data.readback && typeof data.readback === 'object' ? data.readback : null;
  const roiBasis = readback && readback.roi_goal_basis || data.roi_goal_basis;
  if (roiBasis) line += ` · ROI口径=${roiBasis}`;
  if (readback) line += ` · 回读=${readback.verified === true ? '已核验' : '未核验'}`;
  const receipt = Object.fromEntries(['operation_id', 'task_id', 'before', 'requested', 'actual', 'upstream_accepted',
    'effect_status', 'readback', 'next_allowed_at', 'action_limits', 'retry_write', 'timings', 'audit_error']
    .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  if (data.effect_status === 'unconfirmed') line = '上游已接受或结果未知，尚未确认生效；只读核验，不自动重发';
  return { content: [{ type: "text", text: line + (Object.keys(receipt).length ? `\n${JSON.stringify(receipt)}` : '') }],
    ...(Object.keys(receipt).length ? { structuredContent: receipt } : {}) };
}

module.exports = { formatWriteResult };
