const fs = require('fs');
const path = require('path');
const opLog = require('./operationLog');
const flowBaseline = require('./flowBaseline');
const { writeJsonAtomic } = require('./api-helpers');

const WECHAT_NOTIFY_FILE = path.join(__dirname, '..', '..', 'cache', 'wechat_notifications.json');
function emitWechatNotify(event) {
  try {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(WECHAT_NOTIFY_FILE, 'utf8')); } catch {}
    list.push({ ...event, notified_at: new Date().toISOString() });
    if (list.length > 100) list = list.slice(-100);
    fs.writeFileSync(WECHAT_NOTIFY_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (_) {}
}

const GUARD_INTERVAL = 5 * 60 * 1000;
const _lastCheckAt = new Map();

function judgeFlow({ rate15, baselineMedian }) {
  if (rate15 < baselineMedian * 0.4) return 'depleted';
  return 'normal';
}

function getSlotOf(hour) {
  for (const s of flowBaseline.SLOTS) {
    if (hour >= s.from && hour < s.to) return s.key;
  }
  return null;
}

function parseTs(s) {
  const t = new Date(String(s || '').replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? t : null;
}

function readCache(accountId) {
  const file = path.join(__dirname, '..', '..', 'cache', `flow_guard_${accountId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch {}
  return { state: 'normal', since: null, lastAlertAt: null };
}

function writeCache(accountId, data) {
  try {
    const file = path.join(__dirname, '..', '..', 'cache', `flow_guard_${accountId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, data);
  } catch (e) {
    console.error(`[flowGuard] 快照写盘失败:`, e.message);
  }
}

async function checkFlowGuard(accountId, accountName, record, forceNowForTest) {
  const now = forceNowForTest || Date.now();
  const lastAt = _lastCheckAt.get(accountId) || 0;
  if (now - lastAt < GUARD_INTERVAL) return;
  _lastCheckAt.set(accountId, now);

  if (!record || !record.room || record.room.status !== '直播中') return;
  if (!record.trend || record.trend.length < 3) return;
  
  const startMs = parseTs(record.room.start_time || record.room.startTime);
  if (startMs && (now - startMs <= 30 * 60 * 1000)) return;

  const currentHour = new Date(now).getHours();
  const slotKey = getSlotOf(currentHour);
  if (!slotKey) return;

  const baseline = flowBaseline.getFlowBaseline(accountId);
  if (!baseline || !baseline.slots || !baseline.slots[slotKey] || baseline.slots[slotKey].median == null) return;
  
  const baselineMedian = baseline.slots[slotKey].median;
  const last3 = record.trend.slice(-3);
  const rate15 = last3.reduce((sum, p) => sum + (+p.cost || 0), 0);

  const stateData = readCache(accountId);
  const currentState = stateData.state || 'normal';

  if (currentState === 'normal') {
    const verdict = judgeFlow({ rate15, baselineMedian });
    if (verdict === 'depleted') {
      const msg = `流速枯竭告警：当前 15 分钟流速 ${rate15.toFixed(2)} 元 < 基线 ${baselineMedian} 元 × 40%`;
      const evidence = { rate15, baseline_median: baselineMedian, slot: slotKey, rule: '枯竭告警' };
      
      opLog.log({
        action: 'flow_depleted_alert', account_id: accountId,
        params: evidence, result_msg: msg, source: 'agent'
      });
      
      emitWechatNotify({
        type: 'flow_depleted',
        account: accountId,
        reason: msg,
        evidence
      });

      writeCache(accountId, {
        state: 'depleted',
        since: new Date(now).toISOString(),
        lastAlertAt: new Date(now).toISOString()
      });
      console.log(`[flowGuard] ${accountName} ${msg}`);
    }
  } else if (currentState === 'depleted') {
    if (rate15 >= baselineMedian * 0.8) {
      const msg = `流速恢复消警：当前 15 分钟流速 ${rate15.toFixed(2)} 元 ≥ 基线 ${baselineMedian} 元 × 80%`;
      const evidence = { rate15, baseline_median: baselineMedian, slot: slotKey, rule: '恢复消警' };
      
      opLog.log({
        action: 'flow_recovered_alert', account_id: accountId,
        params: evidence, result_msg: msg, source: 'agent'
      });

      emitWechatNotify({
        type: 'flow_recovered',
        account: accountId,
        reason: msg,
        evidence
      });

      writeCache(accountId, {
        state: 'normal',
        since: null,
        lastAlertAt: new Date(now).toISOString()
      });
      console.log(`[flowGuard] ${accountName} ${msg}`);
    }
  }
}

// 暴露 _lastCheckAt 供测试清理
module.exports = { judgeFlow, checkFlowGuard, _lastCheckAt };