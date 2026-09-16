/**
  * 历史账户专用说明已从试用包移除。
 *
 * 用途：盯盘轮流速监控的判定输入——"在播但烧不动钱"需要一个数据算出来的基线，不是拍脑袋阈值。
  * 历史账户专用说明已从试用包移除。
 *       服务端零判定零动作。
 *
 * 数据源：storage/replay/replay_<acct>_<roomId>.json 的 trend（5 分钟粒度区间消耗，
 *         cost 求和≈场次总消耗已实证，非累计值，免差分；15 分钟速率=连续 3 点求和）。
 * 剔除规则：① 开播前 30 分钟冷启动段；② 连续 ≥3 个 0 消耗的断流异常段（零星单点 0 保留）；
 *          ③ 不完整点（晚于 end_time / fetchedAt-5min）。
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 * 缓存：cache/flow_baseline_<acct>.json，24h TTL，stale-while-revalidate（陈旧照返+后台重算）。
 */

const fs = require('fs');
const path = require('path');

const REPLAY_DIR = process.env.FLOW_BASELINE_REPLAY_DIR || path.join(__dirname, '..', '..', 'storage', 'replay');
const CACHE_DIR = process.env.FLOW_BASELINE_CACHE_DIR || path.join(__dirname, '..', '..', 'cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COLD_START_MS = 30 * 60 * 1000;   // 开播冷启动剔除 30 分钟
const MIN_SAMPLES = 5;                    // 历史账户专用说明已从试用包移除。
const ZERO_RUN_EXCLUDE = 3;              // 连续 ≥3 个 0 消耗点 = 断流异常段，剔除

const SLOTS = [
  { key: 'morning', label: '08-12', from: 8, to: 12 },
  { key: 'noon', label: '12-14', from: 12, to: 14 },
  { key: 'afternoon', label: '14-18', from: 14, to: 18 },
  { key: 'evening', label: '18-23', from: 18, to: 23 },
];

function slotOf(hour) {
  for (const s of SLOTS) if (hour >= s.from && hour < s.to) return s.key;
  return null;
}

function parseTs(s) {
  const t = new Date(String(s || '').replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? t : null;
}

function median(sorted) {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * 时段速率聚合（纯函数，可单测）。
 * @param {Object<string, number[]>} ratesBySlot - slot key → 15 分钟速率数组（元/15分钟）
 * @returns {Object<string, {label, mean, median, p25, samples}>}
 */
function aggregateSlotRates(ratesBySlot) {
  const out = {};
  for (const s of SLOTS) {
    const arr = (ratesBySlot[s.key] || []).slice().sort((a, b) => a - b);
    const n = arr.length;
    if (n < MIN_SAMPLES) {
      out[s.key] = { label: s.label, mean: null, median: null, p25: null, samples: n };
      continue;
    }
    const mean = arr.reduce((x, y) => x + y, 0) / n;
    out[s.key] = {
      label: s.label,
      mean: +mean.toFixed(2),
      median: +median(arr).toFixed(2),
      p25: +percentile(arr, 0.25).toFixed(2),
      samples: n,
    };
  }
  return out;
}

/**
 * 计算账号分时段流速基线。
 * @param {string} accountId
 * @param {object} [opts] - { days=14, replayDir }
 * @returns {{window_days, computed_at, unit, slots, sessions_used}}
 */
function computeFlowBaseline(accountId, opts = {}) {
  const days = opts.days || 14;
  const replayDir = opts.replayDir || REPLAY_DIR;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let files = [];
  try {
    files = fs.readdirSync(replayDir).filter(f => f.startsWith(`replay_${accountId}_`) && f.endsWith('.json'));
  } catch { /* 目录不存在按空处理 */ }

  const ratesBySlot = { morning: [], noon: [], afternoon: [], evening: [] };
  let sessionsUsed = 0;

  for (const f of files) {
    let session;
    try {
      session = JSON.parse(fs.readFileSync(path.join(replayDir, f), 'utf8'));
    } catch { continue; }
    const startMs = parseTs(session.room && session.room.start_time);
    if (!startMs || startMs < cutoff || !Array.isArray(session.trend)) continue;
    sessionsUsed++;

    const endMs = parseTs(session.room && session.room.end_time);
    const fetchedMs = parseTs(session.fetchedAt);
    // 1. 过滤冷启动/不完整点
    const pts = [];
    for (const p of session.trend) {
      const ts = parseTs(p.time);
      if (ts === null) continue;
      if (ts < startMs + COLD_START_MS) continue;
      if (endMs && ts > endMs) continue;
      if (!endMs && fetchedMs && ts > fetchedMs - 5 * 60000) continue;
      pts.push({ ts, hour: new Date(ts).getHours(), cost: +p.cost || 0 });
    }
    // 2. 剔除连续 ≥ZERO_RUN_EXCLUDE 个 0 消耗的断流段（零星单点 0 保留）
    const kept = [];
    let i = 0;
    while (i < pts.length) {
      if (pts[i].cost === 0) {
        let j = i;
        while (j < pts.length && pts[j].cost === 0) j++;
        if (j - i < ZERO_RUN_EXCLUDE) for (let k = i; k < j; k++) kept.push(pts[k]);
        i = j;
      } else {
        kept.push(pts[i]); i++;
      }
    }
    // 3. 连续 3 点求和 = 15 分钟速率，按窗口起始点小时归时段
    for (let k = 0; k + 2 < kept.length; k++) {
      // 3 点须时间连续（5 分钟间隔），断点处不成窗
      if (kept[k + 1].ts - kept[k].ts !== 5 * 60000 || kept[k + 2].ts - kept[k + 1].ts !== 5 * 60000) continue;
      const slot = slotOf(kept[k].hour);
      if (!slot) continue;
      ratesBySlot[slot].push(+(kept[k].cost + kept[k + 1].cost + kept[k + 2].cost).toFixed(2));
    }
  }

  return {
    window_days: days,
    computed_at: new Date().toISOString(),
    unit: '元/15分钟',
    sessions_used: sessionsUsed,
    slots: aggregateSlotRates(ratesBySlot),
  };
}

function cachePath(accountId) {
  return path.join(CACHE_DIR, `flow_baseline_${accountId}.json`);
}

function readCache(accountId) {
  try {
    const d = JSON.parse(fs.readFileSync(cachePath(accountId), 'utf8'));
    if (d && typeof d === 'object' && d.slots) return d;
  } catch { /* 无缓存 */ }
  return null;
}

function writeCache(accountId, payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = cachePath(accountId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, cachePath(accountId));
  } catch (e) { console.error('[flowBaseline] 缓存写盘失败:', e.message); }
}

const _refreshInflight = new Set();

/**
 * 读基线（缓存优先，stale-while-revalidate）。
 * 无缓存同步算一次落盘；缓存 >24h 返回陈旧值标 stale:true 并后台重算。
 */
function getFlowBaseline(accountId) {
  const cached = readCache(accountId);
  if (cached) {
    const age = Date.now() - (parseTs(cached.computed_at) || 0);
    if (age > CACHE_TTL_MS) {
      cached.stale = true;
      if (!_refreshInflight.has(accountId)) {
        _refreshInflight.add(accountId);
        setImmediate(() => {
          try { writeCache(accountId, computeFlowBaseline(accountId)); }
          catch (e) { console.error('[flowBaseline] 后台重算失败:', e.message); }
          finally { _refreshInflight.delete(accountId); }
        });
      }
    } else {
      cached.stale = false;
    }
    return cached;
  }
  try {
    const fresh = computeFlowBaseline(accountId);
    fresh.stale = false;
    writeCache(accountId, fresh);
    return fresh;
  } catch (e) {
    console.error('[flowBaseline] 首次计算失败:', e.message);
    return null;
  }
}

module.exports = { computeFlowBaseline, getFlowBaseline, aggregateSlotRates, SLOTS, MIN_SAMPLES, ZERO_RUN_EXCLUDE, COLD_START_MS };
