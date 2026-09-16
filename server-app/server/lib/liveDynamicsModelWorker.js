'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const {
  readReplaySessions,
  buildSessionSamples,
  fitLogisticModel,
  predictLogistic,
  runHistoricalBacktest,
} = require('./liveDynamicsBacktest');

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

try {
  const { sessions, coverage } = readReplaySessions(workerData.replayDir, workerData.accountId);
  const report = runHistoricalBacktest(sessions, workerData.options);
  const samples = sessions.flatMap(session => buildSessionSamples(session, workerData.options));
  if (samples.length < 100) throw new Error(`历史标签不足: ${samples.length}`);
  const model = fitLogisticModel(samples);
  const scores = samples.map(sample => predictLogistic(model, sample)).sort((a, b) => a - b);
  const validation = report.validation_metrics.continuous_logistic_model;
  parentPort.postMessage({
    ok: true,
    model,
    score_distribution: scores,
    samples: samples.length,
    sessions: report.split.train_sessions + report.split.validation_sessions,
    dates: report.split.train_dates + report.split.validation_dates,
    coverage,
    cutoffs: {
      high_risk_profitability_index: quantile(scores, 0.2),
      elevated_risk_profitability_index: quantile(scores, 0.5),
    },
    validation: {
      samples: report.split.validation_samples,
      roc_auc: validation.ranking.roc_auc,
      brier_score: validation.brier_score,
      bottom_20pct_below_floor_rate: validation.ranking.bottom_20pct.below_floor_rate,
      top_20pct_future_net_roi: validation.ranking.top_20pct.spend_weighted_future_net_roi,
      risk_triage_shadow: report.readiness.risk_triage_shadow,
      opportunity_scale_shadow: report.readiness.opportunity_scale_shadow,
    },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
