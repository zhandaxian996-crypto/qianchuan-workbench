'use strict';

/**
 * 历史直播盘面动力回测。
 *
 * 输入是 replay 文件里的 5 分钟区间增量，不读取实时接口、不写数据库。
 * 目标是验证“最近盘面状态”对未来 30 分钟的观察性预测能力；它不能证明
 * 调 ROI、追投或暂停素材的因果收益。
 */

const fs = require('node:fs');
const path = require('node:path');

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function finite(value) {
  return value != null && value !== '' && Number.isFinite(+value) ? +value : null;
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function parseTs(value) {
  if (!value) return null;
  const ms = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function roi(gmv, spend) {
  return spend > 0 ? gmv / spend : null;
}

function sum(points, key) {
  return points.reduce((total, point) => total + (finite(point[key]) || 0), 0);
}

function roiBand(value, floorRoi, breakEven) {
  if (value == null) return 'unknown';
  if (value < floorRoi * 0.6) return 'deep_loss';
  if (value < floorRoi) return 'below_floor';
  if (value < breakEven) return 'near_break_even';
  if (value < breakEven * 1.2) return 'profitable';
  return 'strong_profit';
}

function flowBand(recentSpend, previousSpend) {
  if (recentSpend < 5) return 'stalled';
  if (previousSpend < 5) return 'new_flow';
  const ratio = recentSpend / previousSpend;
  if (ratio < 0.6) return 'contracting';
  if (ratio < 0.9) return 'soft_contracting';
  if (ratio <= 1.15) return 'stable';
  if (ratio <= 1.6) return 'expanding';
  return 'surging';
}

function broadFlowBand(value) {
  if (['stalled', 'contracting', 'soft_contracting'].includes(value)) return 'low_flow';
  if (['expanding', 'surging'].includes(value)) return 'high_flow';
  return 'steady_flow';
}

function roiDirection(recentRoi, previousRoi) {
  if (recentRoi == null || previousRoi == null) return 'unknown';
  const delta = recentRoi - previousRoi;
  if (delta >= 0.5) return 'improving';
  if (delta <= -0.5) return 'weakening';
  return 'flat';
}

function isConsecutive(points) {
  for (let i = 1; i < points.length; i++) {
    if (points[i].ts - points[i - 1].ts !== FIVE_MINUTES_MS) return false;
  }
  return true;
}

function normalizeSession(payload, sourceFile, accountId) {
  const room = payload && payload.room ? payload.room : {};
  const roomId = String(room.room_id || room.roomId || payload.roomId || '');
  const startTime = room.start_time || room.startTime || payload.startTime || null;
  const startTs = parseTs(startTime);
  const endTime = room.end_time || room.endTime || payload.endTime || null;
  const endTs = parseTs(endTime);
  if (!roomId || !startTs || !Array.isArray(payload && payload.trend)) return null;

  const byTime = new Map();
  for (const raw of payload.trend) {
    const ts = parseTs(raw && raw.time);
    const cost = finite(raw && raw.cost);
    const netGmv = finite(raw && raw.gmvSettle);
    if (!ts || cost == null || netGmv == null || cost < 0 || netGmv < 0) continue;
    if (ts < startTs - 10 * 60 * 1000) continue;
    if (endTs && ts > endTs + FIVE_MINUTES_MS) continue;
    byTime.set(ts, { ts, time: raw.time, cost, net_gmv: netGmv });
  }
  const points = [...byTime.values()].sort((a, b) => a.ts - b.ts);
  if (!points.length) return null;
  return {
    account_id: accountId,
    room_id: roomId,
    start_time: startTime,
    start_ts: startTs,
    end_time: endTime,
    fetched_at: payload.fetchedAt || payload.fetched_at || null,
    source_file: sourceFile,
    points,
  };
}

function readReplaySessions(replayDir, accountId) {
  const prefix = `replay_${accountId}_`;
  const files = fs.readdirSync(replayDir)
    .filter(file => file.startsWith(prefix) && file.endsWith('.json'));
  const bySession = new Map();
  const coverage = { files: files.length, valid_files: 0, invalid_files: 0, duplicate_sessions: 0 };
  for (const file of files) {
    let normalized = null;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(replayDir, file), 'utf8'));
      normalized = normalizeSession(payload, file, accountId);
    } catch { /* 损坏文件只计数，不中断全量回测 */ }
    if (!normalized) {
      coverage.invalid_files += 1;
      continue;
    }
    coverage.valid_files += 1;
    const key = `${accountId}|${normalized.room_id}|${normalized.start_time}`;
    const existing = bySession.get(key);
    if (existing) coverage.duplicate_sessions += 1;
    if (!existing || normalized.points.length > existing.points.length) bySession.set(key, normalized);
  }
  return {
    sessions: [...bySession.values()].sort((a, b) => a.start_ts - b.start_ts),
    coverage,
  };
}

function buildSessionSamples(session, options = {}) {
  const breakEven = finite(options.breakEven) || 3;
  const floorRoi = finite(options.floorRoi) || 2.8;
  const horizonMinutes = Math.max(5, finite(options.horizonMinutes) || 30);
  const horizonPoints = Math.max(1, Math.round(horizonMinutes / 5));
  const minHistoryPoints = Math.max(12, Math.round((finite(options.historyMinutes) || 60) / 5));
  const minHistorySpend = Math.max(0, finite(options.minHistorySpend) || 10);
  const minFutureSpend = Math.max(0.01, finite(options.minFutureSpend) || 5);
  const points = session.points || [];
  const samples = [];

  // 标签窗按 horizon 步进，同一场内未来结果不重叠。
  for (let anchor = minHistoryPoints - 1; anchor + horizonPoints < points.length; anchor += horizonPoints) {
    const fullWindow = points.slice(anchor - minHistoryPoints + 1, anchor + horizonPoints + 1);
    if (!isConsecutive(fullWindow)) continue;
    const recent15 = points.slice(anchor - 2, anchor + 1);
    const recent30 = points.slice(anchor - 5, anchor + 1);
    const previous30 = points.slice(anchor - 11, anchor - 5);
    const recent60 = points.slice(anchor - 11, anchor + 1);
    const running = points.slice(0, anchor + 1);
    const future = points.slice(anchor + 1, anchor + horizonPoints + 1);
    const recentSpend = sum(recent30, 'cost');
    const recentNet = sum(recent30, 'net_gmv');
    const previousSpend = sum(previous30, 'cost');
    const previousNet = sum(previous30, 'net_gmv');
    const futureSpend = sum(future, 'cost');
    const futureNet = sum(future, 'net_gmv');
    if (recentSpend < minHistorySpend || futureSpend < minFutureSpend) continue;
    const recentRoi = roi(recentNet, recentSpend);
    const previousRoi = roi(previousNet, previousSpend);
    const runningSpend = sum(running, 'cost');
    const runningNet = sum(running, 'net_gmv');
    const flow = flowBand(recentSpend, previousSpend);
    const band = roiBand(recentRoi, floorRoi, breakEven);
    const direction = roiDirection(recentRoi, previousRoi);
    const futureRoi = roi(futureNet, futureSpend);
    samples.push({
      session_key: `${session.account_id}|${session.room_id}|${session.start_time}`,
      session_start_ts: session.start_ts,
      anchor_time: points[anchor].time,
      anchor_ts: points[anchor].ts,
      state_key: `${band}|${broadFlowBand(flow)}|${direction}`,
      fallback_state_key: `${band}|${broadFlowBand(flow)}`,
      features: {
        minutes_since_start: round((points[anchor].ts - session.start_ts) / 60000, 1),
        recent_15_spend: round(sum(recent15, 'cost'), 2),
        recent_15_net_roi: round(roi(sum(recent15, 'net_gmv'), sum(recent15, 'cost')), 3),
        recent_30_spend: round(recentSpend, 2),
        recent_30_net_roi: round(recentRoi, 3),
        previous_30_spend: round(previousSpend, 2),
        previous_30_net_roi: round(previousRoi, 3),
        recent_60_spend: round(sum(recent60, 'cost'), 2),
        recent_60_net_roi: round(roi(sum(recent60, 'net_gmv'), sum(recent60, 'cost')), 3),
        cumulative_net_roi: round(roi(runningNet, runningSpend), 3),
        flow_ratio_30m: previousSpend > 0 ? round(recentSpend / previousSpend, 3) : null,
        roi_delta_30m: recentRoi != null && previousRoi != null ? round(recentRoi - previousRoi, 3) : null,
        roi_band: band,
        flow_band: flow,
        roi_direction: direction,
      },
      outcome: {
        future_minutes: horizonMinutes,
        spend: round(futureSpend, 2),
        net_gmv: round(futureNet, 2),
        net_roi: round(futureRoi, 3),
        profitable: futureRoi >= breakEven,
        below_floor: futureRoi < floorRoi,
      },
    });
  }
  return samples;
}

function buildCurrentFeatureSample(session, options = {}) {
  const breakEven = finite(options.breakEven) || 3;
  const floorRoi = finite(options.floorRoi) || 2.8;
  const minHistoryPoints = Math.max(12, Math.round((finite(options.historyMinutes) || 60) / 5));
  const minHistorySpend = Math.max(0, finite(options.minHistorySpend) || 10);
  const points = session && Array.isArray(session.points) ? session.points : [];
  if (points.length < minHistoryPoints) return { sample: null, reason: 'INSUFFICIENT_HISTORY_POINTS' };
  const anchor = points.length - 1;
  const fullWindow = points.slice(anchor - minHistoryPoints + 1, anchor + 1);
  if (!isConsecutive(fullWindow)) return { sample: null, reason: 'NON_CONTIGUOUS_HISTORY' };
  const recent15 = points.slice(anchor - 2, anchor + 1);
  const recent30 = points.slice(anchor - 5, anchor + 1);
  const previous30 = points.slice(anchor - 11, anchor - 5);
  const recent60 = points.slice(anchor - 11, anchor + 1);
  const running = points.slice(0, anchor + 1);
  const recentSpend = sum(recent30, 'cost');
  const recentNet = sum(recent30, 'net_gmv');
  if (recentSpend < minHistorySpend) return { sample: null, reason: 'INSUFFICIENT_RECENT_SPEND' };
  const previousSpend = sum(previous30, 'cost');
  const previousNet = sum(previous30, 'net_gmv');
  const recentRoi = roi(recentNet, recentSpend);
  const previousRoi = roi(previousNet, previousSpend);
  const runningSpend = sum(running, 'cost');
  const runningNet = sum(running, 'net_gmv');
  const flow = flowBand(recentSpend, previousSpend);
  const band = roiBand(recentRoi, floorRoi, breakEven);
  const direction = roiDirection(recentRoi, previousRoi);
  return {
    reason: 'READY',
    sample: {
      session_key: `${session.account_id}|${session.room_id}|${session.start_time}`,
      anchor_time: points[anchor].time,
      anchor_ts: points[anchor].ts,
      state_key: `${band}|${broadFlowBand(flow)}|${direction}`,
      fallback_state_key: `${band}|${broadFlowBand(flow)}`,
      features: {
        minutes_since_start: round((points[anchor].ts - session.start_ts) / 60000, 1),
        recent_15_spend: round(sum(recent15, 'cost'), 2),
        recent_15_net_roi: round(roi(sum(recent15, 'net_gmv'), sum(recent15, 'cost')), 3),
        recent_30_spend: round(recentSpend, 2),
        recent_30_net_roi: round(recentRoi, 3),
        previous_30_spend: round(previousSpend, 2),
        previous_30_net_roi: round(previousRoi, 3),
        recent_60_spend: round(sum(recent60, 'cost'), 2),
        recent_60_net_roi: round(roi(sum(recent60, 'net_gmv'), sum(recent60, 'cost')), 3),
        cumulative_net_roi: round(roi(runningNet, runningSpend), 3),
        flow_ratio_30m: previousSpend > 0 ? round(recentSpend / previousSpend, 3) : null,
        roi_delta_30m: recentRoi != null && previousRoi != null ? round(recentRoi - previousRoi, 3) : null,
        roi_band: band,
        flow_band: flow,
        roi_direction: direction,
      },
    },
  };
}

function newBucket() {
  return { samples: 0, spend: 0, net_gmv: 0, profitable: 0, below_floor: 0 };
}

function addSample(bucket, sample) {
  bucket.samples += 1;
  bucket.spend += sample.outcome.spend;
  bucket.net_gmv += sample.outcome.net_gmv;
  if (sample.outcome.profitable) bucket.profitable += 1;
  if (sample.outcome.below_floor) bucket.below_floor += 1;
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { low: round(Math.max(0, center - margin), 3), high: round(Math.min(1, center + margin), 3) };
}

function finalizeBucket(bucket) {
  return {
    samples: bucket.samples,
    future_spend: round(bucket.spend, 2),
    spend_weighted_future_net_roi: bucket.spend > 0 ? round(bucket.net_gmv / bucket.spend, 3) : null,
    profitable_rate: bucket.samples ? round(bucket.profitable / bucket.samples, 3) : null,
    profitable_rate_ci95: wilson(bucket.profitable, bucket.samples),
    below_floor_rate: bucket.samples ? round(bucket.below_floor / bucket.samples, 3) : null,
    below_floor_rate_ci95: wilson(bucket.below_floor, bucket.samples),
  };
}

function bucketMap(samples, keyFn) {
  const buckets = new Map();
  for (const sample of samples) {
    const key = keyFn(sample);
    if (!buckets.has(key)) buckets.set(key, newBucket());
    addSample(buckets.get(key), sample);
  }
  return buckets;
}

function buildEmpiricalModel(trainSamples, minStateSamples = 20) {
  const full = bucketMap(trainSamples, sample => sample.state_key);
  const fallback = bucketMap(trainSamples, sample => sample.fallback_state_key);
  const roiOnly = bucketMap(trainSamples, sample => sample.features.roi_band);
  const global = newBucket();
  for (const sample of trainSamples) addSample(global, sample);
  return { full, fallback, roiOnly, global, minStateSamples };
}

function predict(model, sample) {
  const candidates = [
    ['full_state', model.full.get(sample.state_key)],
    ['roi_flow_state', model.fallback.get(sample.fallback_state_key)],
    ['roi_band', model.roiOnly.get(sample.features.roi_band)],
  ];
  let source = 'global';
  let bucket = model.global;
  for (const [candidateSource, candidate] of candidates) {
    if (candidate && candidate.samples >= model.minStateSamples) {
      source = candidateSource;
      bucket = candidate;
      break;
    }
  }
  // Beta(2,2) 收缩，避免小组出现虚假的 0%/100%。
  const probability = (bucket.profitable + 2) / (bucket.samples + 4);
  return {
    source,
    training_samples: bucket.samples,
    predicted_profitable_probability: probability,
    predicted_future_net_roi: bucket.spend > 0 ? bucket.net_gmv / bucket.spend : null,
  };
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function continuousFeatures(sample) {
  const f = sample.features;
  const clippedRoi = value => clamp(finite(value) || 0, 0, 10);
  return [
    clippedRoi(f.recent_15_net_roi),
    clippedRoi(f.recent_30_net_roi),
    clippedRoi(f.previous_30_net_roi),
    clippedRoi(f.recent_60_net_roi),
    clippedRoi(f.cumulative_net_roi),
    Math.log1p(Math.max(0, finite(f.recent_15_spend) || 0)),
    Math.log1p(Math.max(0, finite(f.recent_30_spend) || 0)),
    clamp(Math.log(Math.max(0.05, finite(f.flow_ratio_30m) || 0.05)), -3, 3),
    clamp(finite(f.roi_delta_30m) || 0, -10, 10),
    clamp((finite(f.minutes_since_start) || 0) / 60, 0, 12),
  ];
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function fitLogisticModel(samples, options = {}) {
  if (!samples.length) return null;
  const raw = samples.map(continuousFeatures);
  const dimensions = raw[0].length;
  const means = Array(dimensions).fill(0);
  const scales = Array(dimensions).fill(0);
  for (const row of raw) for (let j = 0; j < dimensions; j++) means[j] += row[j] / raw.length;
  for (const row of raw) for (let j = 0; j < dimensions; j++) scales[j] += (row[j] - means[j]) ** 2 / raw.length;
  for (let j = 0; j < dimensions; j++) scales[j] = Math.sqrt(scales[j]) || 1;
  const matrix = raw.map(row => row.map((value, j) => (value - means[j]) / scales[j]));
  const weights = Array(dimensions + 1).fill(0);
  const iterations = Math.max(100, finite(options.iterations) || 800);
  const learningRate = Math.max(0.001, finite(options.learningRate) || 0.03);
  const l2 = Math.max(0, finite(options.l2) || 0.1);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = Array(weights.length).fill(0);
    for (let i = 0; i < matrix.length; i++) {
      let linear = weights[0];
      for (let j = 0; j < dimensions; j++) linear += weights[j + 1] * matrix[i][j];
      const error = sigmoid(linear) - (samples[i].outcome.profitable ? 1 : 0);
      gradient[0] += error;
      for (let j = 0; j < dimensions; j++) gradient[j + 1] += error * matrix[i][j];
    }
    weights[0] -= learningRate * gradient[0] / matrix.length;
    for (let j = 1; j < weights.length; j++) {
      weights[j] -= learningRate * (gradient[j] / matrix.length + l2 * weights[j]);
    }
  }
  return { means, scales, weights };
}

function predictLogistic(model, sample) {
  const raw = continuousFeatures(sample);
  let linear = model.weights[0];
  for (let j = 0; j < raw.length; j++) {
    linear += model.weights[j + 1] * ((raw[j] - model.means[j]) / model.scales[j]);
  }
  return sigmoid(linear);
}

function classificationMetrics(rows) {
  let tp = 0; let tn = 0; let fp = 0; let fn = 0;
  for (const row of rows) {
    if (row.predicted && row.actual) tp++;
    else if (!row.predicted && !row.actual) tn++;
    else if (row.predicted) fp++;
    else fn++;
  }
  const total = rows.length;
  return {
    samples: total,
    accuracy: total ? round((tp + tn) / total, 3) : null,
    precision: tp + fp ? round(tp / (tp + fp), 3) : null,
    recall: tp + fn ? round(tp / (tp + fn), 3) : null,
    specificity: tn + fp ? round(tn / (tn + fp), 3) : null,
    confusion: { tp, tn, fp, fn },
  };
}

function rocAuc(rows) {
  const positives = rows.filter(row => row.actual);
  const negatives = rows.filter(row => !row.actual);
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.score > negative.score) wins += 1;
      else if (positive.score === negative.score) wins += 0.5;
    }
  }
  return round(wins / (positives.length * negatives.length), 4);
}

function cohortOutcome(rows) {
  const bucket = newBucket();
  for (const row of rows) addSample(bucket, row.sample);
  return finalizeBucket(bucket);
}

function rankingDiagnostics(rows) {
  if (!rows.length) return { roc_auc: null, top_20pct: null, bottom_20pct: null };
  const sorted = rows.slice().sort((a, b) => b.score - a.score);
  const size = Math.max(1, Math.ceil(sorted.length * 0.2));
  const overall = cohortOutcome(sorted);
  const top = cohortOutcome(sorted.slice(0, size));
  const bottom = cohortOutcome(sorted.slice(-size));
  return {
    roc_auc: rocAuc(sorted),
    overall_profitable_rate: overall.profitable_rate,
    top_20pct: {
      ...top,
      profitable_rate_lift: overall.profitable_rate > 0 ? round(top.profitable_rate / overall.profitable_rate, 3) : null,
    },
    bottom_20pct: {
      ...bottom,
      below_floor_rate_lift: overall.below_floor_rate > 0 ? round(bottom.below_floor_rate / overall.below_floor_rate, 3) : null,
    },
  };
}

function evaluateModel(model, logisticModel, validationSamples, breakEven) {
  const stateRows = [];
  const recentRows = [];
  const cumulativeRows = [];
  let brier = 0;
  let absoluteErrorWeighted = 0;
  let spendTotal = 0;
  const predictionSources = {};
  const rankingRows = [];
  const logisticRows = [];
  let logisticBrier = 0;
  for (const sample of validationSamples) {
    const prediction = predict(model, sample);
    const actual = sample.outcome.profitable;
    const probability = prediction.predicted_profitable_probability;
    brier += (probability - (actual ? 1 : 0)) ** 2;
    absoluteErrorWeighted += Math.abs((prediction.predicted_future_net_roi || 0) - sample.outcome.net_roi) * sample.outcome.spend;
    spendTotal += sample.outcome.spend;
    predictionSources[prediction.source] = (predictionSources[prediction.source] || 0) + 1;
    rankingRows.push({ score: probability, actual, sample });
    const logisticProbability = predictLogistic(logisticModel, sample);
    logisticBrier += (logisticProbability - (actual ? 1 : 0)) ** 2;
    logisticRows.push({ score: logisticProbability, actual, sample });
    stateRows.push({ predicted: probability >= 0.5, actual });
    recentRows.push({ predicted: sample.features.recent_30_net_roi >= breakEven, actual });
    cumulativeRows.push({ predicted: sample.features.cumulative_net_roi >= breakEven, actual });
  }
  return {
    empirical_state_model: {
      ...classificationMetrics(stateRows),
      brier_score: validationSamples.length ? round(brier / validationSamples.length, 4) : null,
      spend_weighted_absolute_roi_error: spendTotal ? round(absoluteErrorWeighted / spendTotal, 3) : null,
      prediction_sources: predictionSources,
      ranking: rankingDiagnostics(rankingRows),
    },
    continuous_logistic_model: {
      brier_score: validationSamples.length ? round(logisticBrier / validationSamples.length, 4) : null,
      ranking: rankingDiagnostics(logisticRows),
      note: '仅用于时间外排序验证，未达到生产概率校准或自动动作授权标准',
    },
    recent_30m_threshold_baseline: classificationMetrics(recentRows),
    cumulative_roi_threshold_baseline: classificationMetrics(cumulativeRows),
  };
}

function summarizeStates(samples) {
  const buckets = bucketMap(samples, sample => sample.state_key);
  return Object.fromEntries(
    [...buckets.entries()]
      .sort((a, b) => b[1].samples - a[1].samples)
      .map(([key, bucket]) => [key, finalizeBucket(bucket)]),
  );
}

function runHistoricalBacktest(sessions, options = {}) {
  const breakEven = finite(options.breakEven) || 3;
  const floorRoi = finite(options.floorRoi) || 2.8;
  const holdoutFraction = Math.min(0.5, Math.max(0.1, finite(options.holdoutFraction) || 0.25));
  const eligibleSessions = sessions
    .map(session => ({ session, samples: buildSessionSamples(session, { ...options, breakEven, floorRoi }) }))
    .filter(item => item.samples.length > 0)
    .sort((a, b) => a.session.start_ts - b.session.start_ts);
  if (eligibleSessions.length < 2) throw new Error('可用历史场次不足，无法做按时间留出验证');
  const splitIndex = Math.max(1, Math.min(eligibleSessions.length - 1, Math.floor(eligibleSessions.length * (1 - holdoutFraction))));
  const trainItems = eligibleSessions.slice(0, splitIndex);
  const validationItems = eligibleSessions.slice(splitIndex);
  const trainSamples = trainItems.flatMap(item => item.samples);
  const validationSamples = validationItems.flatMap(item => item.samples);
  const model = buildEmpiricalModel(trainSamples, Math.max(5, finite(options.minStateSamples) || 20));
  const logisticModel = fitLogisticModel(trainSamples);
  const validationOverall = newBucket();
  for (const sample of validationSamples) addSample(validationOverall, sample);
  const validationMetrics = evaluateModel(model, logisticModel, validationSamples, breakEven);
  const continuousRanking = validationMetrics.continuous_logistic_model.ranking;
  const riskShadowReady = continuousRanking.roc_auc >= 0.65
    && continuousRanking.bottom_20pct.below_floor_rate >= finalizeBucket(validationOverall).below_floor_rate + 0.1;
  const opportunityShadowReady = continuousRanking.roc_auc >= 0.65
    && continuousRanking.top_20pct.spend_weighted_future_net_roi >= breakEven
    && continuousRanking.top_20pct.profitable_rate_ci95.low >= 0.4;
  const uniqueDates = items => new Set(items.map(item => String(item.session.start_time).slice(0, 10))).size;
  return {
    model: 'live-dynamics-observational-v1',
    evaluation: 'chronological_session_holdout_future_30m',
    thresholds: {
      break_even_roi: breakEven,
      floor_roi: floorRoi,
      horizon_minutes: Math.max(5, finite(options.horizonMinutes) || 30),
      history_minutes: Math.max(60, finite(options.historyMinutes) || 60),
      minimum_history_spend: Math.max(0, finite(options.minHistorySpend) || 10),
      minimum_future_spend: Math.max(0.01, finite(options.minFutureSpend) || 5),
    },
    split: {
      method: 'chronological_by_whole_session',
      train_sessions: trainItems.length,
      validation_sessions: validationItems.length,
      train_dates: uniqueDates(trainItems),
      validation_dates: uniqueDates(validationItems),
      train_samples: trainSamples.length,
      validation_samples: validationSamples.length,
      validation_from: validationItems[0].session.start_time,
      validation_to: validationItems[validationItems.length - 1].session.start_time,
      non_overlapping_future_windows_within_session: true,
    },
    validation_overall: finalizeBucket(validationOverall),
    validation_metrics: validationMetrics,
    readiness: {
      risk_triage_shadow: riskShadowReady,
      opportunity_scale_shadow: opportunityShadowReady,
      automatic_actions: false,
      interpretation: riskShadowReady
        ? '可作为追加专项诊断的风险排序信号；不能直接决定提ROI、暂停素材或其他写操作'
        : '风险排序尚未通过最低时间外验证门槛',
    },
    train_state_outcomes: summarizeStates(trainSamples),
    validation_state_outcomes: summarizeStates(validationSamples),
    limitations: [
      '这是历史观察性预测，不是调 ROI、追投或暂停素材的随机对照实验',
      '回放趋势只有场级消耗与结算净 GMV，不能定位到具体素材，也没有历史点击/CPC',
      '平台竞争、主播话术、排品和库存等未观测变量仍会影响未来结果',
      '模型只可用作 Agent 的风险与机会证据，不可直接生成自动写操作',
    ],
  };
}

module.exports = {
  FIVE_MINUTES_MS,
  parseTs,
  roiBand,
  flowBand,
  normalizeSession,
  readReplaySessions,
  buildSessionSamples,
  buildCurrentFeatureSample,
  wilson,
  buildEmpiricalModel,
  predict,
  continuousFeatures,
  fitLogisticModel,
  predictLogistic,
  rocAuc,
  rankingDiagnostics,
  runHistoricalBacktest,
};
