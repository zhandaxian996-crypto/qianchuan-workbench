'use strict';
const { readConfig } = require('./accountRegistry');
const { CONFIG_PATH } = require('./config');
const { readJsonBody, sendJSON } = require('./utils');
const WRITE_ROUTES = new Set(['/api/campaign/status', '/api/campaign/budget', '/api/material/delete', '/api/material/rename',
  '/api/material/add', '/api/boost-create', '/api/boost-delete', '/api/flow-control', '/api/pending-ops/approve']);
async function enforceOnboardingGuard(req, res, url) {
  if (!WRITE_ROUTES.has(url.pathname) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const parsed = await readJsonBody(req);
  if (parsed.error) { sendJSON(res, { ok: false, code: 'invalid_json' }, 400); return false; }
  const id = parsed.data?.account_id || parsed.data?.accountId || url.searchParams.get('account') || url.searchParams.get('accountId');
  const config = readConfig(CONFIG_PATH);
  const policies = config.agent_policy?.account_policies || {};
  if ((!id && Object.values(policies).some(p => p.onboarding_managed)) || policies[id]?.onboarding_managed) {
    sendJSON(res, { ok: false, code: 'onboarding_write_not_enabled', error: '本账户接入仅完成只读配置，写授权意向尚未激活', advertising_writes: 0 }, 403);
    return false;
  }
  return true;
}
module.exports = { enforceOnboardingGuard, WRITE_ROUTES };
