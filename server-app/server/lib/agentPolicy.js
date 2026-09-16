'use strict';

const WRITE_KEYS = {
  plan: 'allow_plan_write',
  boost: 'allow_boost_write',
  material: 'allow_material_write'
};

function checkAgentWritePolicy(policy, scope, accountId) {
  // 账号策略优先；未配置不是旧系统兼容口，而是不可审计的写入状态，必须安全失败。
  if (policy && accountId && policy.account_policies && typeof policy.account_policies === 'object') {
    const accountPolicy = policy.account_policies[accountId];
    if (accountPolicy && typeof accountPolicy === 'object') policy = accountPolicy;
  }
  if (!policy || typeof policy !== 'object' || !policy.mode) {
    return { allowed: false, mode: 'unconfigured', reason: '未配置 agent_policy；写操作默认关闭' };
  }

  const mode = String(policy.mode);
  if (mode === 'recommendation_only') {
    return { allowed: false, mode, reason: '账户仍处于 recommendation_only，只允许读取、诊断和建议' };
  }

  if (!['confirm_writes', 'auto_guarded'].includes(mode)) {
    return { allowed: false, mode, reason: `未知 agent_policy.mode=${mode}` };
  }

  const key = WRITE_KEYS[scope];
  if (!key) return { allowed: false, mode, reason: `未知写操作域：${scope}` };
  if (policy[key] !== true) {
    return { allowed: false, mode, reason: `${key}=false，当前账户未开放该类写操作` };
  }

  return { allowed: true, mode, reason: `${mode}/${key}=true` };
}

function toMcpBlockResult(check, scope, action) {
  return {
    content: [{
      type: 'text',
      text: `Error: 写操作被账户安全策略拦截（${scope}:${action}）——${check.reason}。请完成账户校准并由用户明确开放权限。`
    }],
    isError: true
  };
}

module.exports = { WRITE_KEYS, checkAgentWritePolicy, toMcpBlockResult };
