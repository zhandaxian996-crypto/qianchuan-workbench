// 素材内容漏斗：把内容力、获客阻力与绝对危害量拆开计算。
// 纯函数，不读 DB/网络；调用方必须提供同账号、同渠道、同稳定窗口的数据。

const DEFAULTS = Object.freeze({
  min_plays: 300,
  min_clicks: 20,
  weak_rate3s: 25,
  weak_finish_rate: 10,
  weak_watch_ratio: 0.18,
  weak_relative: 0.80,
  high_cpc_relative: 1.25,
  high_drop_count: 5000,
  high_drop_percentile: 0.80,
});

function finite(v) {
  return v != null && v !== '' && Number.isFinite(+v) ? +v : null;
}

function round(v, digits = 2) {
  return Number.isFinite(v) ? +v.toFixed(digits) : null;
}

function parseDurationSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = +raw;
    return n > 0 ? n : null;
  }
  const parts = raw.split(':').map(Number);
  if (!parts.length || parts.some(v => !Number.isFinite(v) || v < 0)) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds > 0 ? seconds : null;
}

// 平台和本地字段均为百分数，禁止按数值大小猜测单位。
function asPercent(value) {
  const n = finite(value);
  if (n == null || n < 0) return null;
  return n;
}

function aggregateFunnelRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let cost = 0, plays = 0, shows = 0, clicks = 0;
  let rate3sSum = 0, rate3sWeight = 0;
  let finishSum = 0, finishWeight = 0;
  let watchSum = 0, watchWeight = 0;
  let watchRatioSum = 0, watchRatioWeight = 0;
  let estimatedClicks = 0;

  for (const row of list) {
    const rowCost = Math.max(0, finite(row.cost) || 0);
    const rowPlays = Math.max(0, finite(row.plays) || 0);
    const rowShows = Math.max(0, finite(row.shows) || 0);
    const rowClicks = Math.max(0, finite(row.clicks != null ? row.clicks : row.click_count) || 0);
    cost += rowCost;
    plays += rowPlays;
    shows += rowShows;
    clicks += rowClicks;

    const reportedCpc = finite(row.cpc);
    if (rowClicks <= 0 && reportedCpc != null && reportedCpc > 0 && rowCost > 0) {
      estimatedClicks += rowCost / reportedCpc;
    }

    const rate3s = asPercent(row.rate3s);
    if (rate3s != null && rowPlays > 0) {
      rate3sSum += rate3s * rowPlays;
      rate3sWeight += rowPlays;
    }
    const finishRate = asPercent(row.finish_rate != null ? row.finish_rate : row.finishRate);
    if (finishRate != null && rowPlays > 0) {
      finishSum += finishRate * rowPlays;
      finishWeight += rowPlays;
    }
    const avgWatch = finite(row.avg_watch_time != null ? row.avg_watch_time : row.avgWatchTime);
    if (avgWatch != null && avgWatch >= 0 && rowPlays > 0) {
      watchSum += avgWatch * rowPlays;
      watchWeight += rowPlays;
      const duration = parseDurationSeconds(row.duration);
      if (duration) {
        watchRatioSum += Math.min(avgWatch / duration, 1) * rowPlays;
        watchRatioWeight += rowPlays;
      }
    }
  }

  const effectiveClicks = clicks > 0 ? clicks : estimatedClicks;
  return {
    cost: round(cost),
    plays: Math.round(plays),
    shows: Math.round(shows),
    clicks: Math.round(clicks),
    clicks_estimated: clicks <= 0 && estimatedClicks > 0 ? round(estimatedClicks) : null,
    ctr: shows > 0 && effectiveClicks > 0 ? round(effectiveClicks / shows * 100) : null,
    cpc: effectiveClicks > 0 ? round(cost / effectiveClicks) : null,
    cpc_source: clicks > 0 ? 'cost_div_clicks' : (estimatedClicks > 0 ? 'reported_cpc_estimate' : null),
    rate3s: rate3sWeight > 0 ? round(rate3sSum / rate3sWeight) : null,
    finish_rate: finishWeight > 0 ? round(finishSum / finishWeight) : null,
    avg_watch_time: watchWeight > 0 ? round(watchSum / watchWeight) : null,
    watch_ratio: watchRatioWeight > 0 ? round(watchRatioSum / watchRatioWeight, 4) : null,
  };
}

function ratio(value, baseline) {
  return value != null && baseline != null && baseline > 0 ? value / baseline : null;
}

function evaluateFunnel(material, benchmark = {}, insight = {}, overrides = {}) {
  const p = { ...DEFAULTS, ...(overrides || {}) };
  const m = material || {};
  const plays = finite(m.plays) || 0;
  const clicks = finite(m.clicks) || finite(m.clicks_estimated) || 0;
  const rate3sRel = ratio(finite(m.rate3s), finite(benchmark.rate3s));
  const ctrRel = ratio(finite(m.ctr), finite(benchmark.ctr));
  const finishRel = ratio(finite(m.finish_rate), finite(benchmark.finish_rate));
  const watchRel = ratio(finite(m.watch_ratio), finite(benchmark.watch_ratio));
  const cpcRel = ratio(finite(m.cpc), finite(benchmark.cpc));
  const contentSample = plays >= p.min_plays;
  const clickSample = clicks >= p.min_clicks;

  const hookWeak = contentSample && m.rate3s != null && (
    m.rate3s < p.weak_rate3s || (rate3sRel != null && rate3sRel < p.weak_relative)
  );
  const finishWeak = contentSample && m.finish_rate != null && (
    (m.finish_rate < p.weak_finish_rate && (finishRel == null || finishRel < p.weak_relative))
  );
  const watchWeak = contentSample && m.watch_ratio != null && (
    m.watch_ratio < p.weak_watch_ratio && (watchRel == null || watchRel < p.weak_relative)
  );
  const persuasionWeak = finishWeak || watchWeak;
  const cpcHigh = clickSample && cpcRel != null && cpcRel >= p.high_cpc_relative;
  const dropCount = finite(insight.drop_count);
  const dropPercentile = finite(insight.drop_percentile);
  const dropAmplifier = dropCount != null && dropCount >= p.high_drop_count &&
    dropPercentile != null && dropPercentile >= p.high_drop_percentile;

  const signals = [];
  if (!contentSample) signals.push('CONTENT_SAMPLE_INSUFFICIENT');
  if (!clickSample) signals.push('CLICK_SAMPLE_INSUFFICIENT');
  if (hookWeak) signals.push('HOOK_WEAK');
  if (persuasionWeak) signals.push('PERSUASION_WEAK');
  if (cpcHigh) signals.push('CPC_HIGH');
  if (dropAmplifier) signals.push('DROP_SCALE_HIGH');

  let diagnosis = 'INSUFFICIENT_EVIDENCE';
  if (contentSample || clickSample) {
    if (hookWeak && persuasionWeak) diagnosis = 'FATIGUED_OR_FULL_FUNNEL_FAILURE';
    else if (!hookWeak && persuasionWeak) diagnosis = 'TITLE_BAIT_OR_MIDROLL_DROP';
    else if (hookWeak) diagnosis = 'HOOK_FAILURE';
    else if (cpcHigh) diagnosis = 'HIGH_ACQUISITION_RESISTANCE';
    else diagnosis = 'CONTENT_HEALTHY_OR_UNPROVEN';
  }

  return {
    data_quality: contentSample && clickSample ? 'complete' : ((contentSample || clickSample) ? 'partial' : 'insufficient'),
    diagnosis,
    failure_hits: (hookWeak ? 1 : 0) + (persuasionWeak ? 1 : 0) + (cpcHigh ? 1 : 0),
    drop_amplifier: dropAmplifier,
    signals,
    metrics: {
      ...m,
      rate3s_rel: round(rate3sRel, 3),
      ctr_rel: round(ctrRel, 3),
      finish_rate_rel: round(finishRel, 3),
      watch_ratio_rel: round(watchRel, 3),
      cpc_rel: round(cpcRel, 3),
      drop_count_30d: dropCount,
      drop_count_percentile: round(dropPercentile, 3),
    },
  };
}

module.exports = {
  DEFAULTS,
  parseDurationSeconds,
  asPercent,
  aggregateFunnelRows,
  evaluateFunnel,
};
