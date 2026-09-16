const { num } = require('./utils');

const PHASES = {
  learning: { key: 'learning', name: '学习期', cls: 'phase-learning' },
  growth:   { key: 'growth',   name: '爬坡期', cls: 'phase-growth' },
  stable:   { key: 'stable',   name: '稳定期', cls: 'phase-stable' },
  declining:{ key: 'declining',name: '衰退期', cls: 'phase-declining' },
  dead:     { key: 'dead',     name: '死亡期', cls: 'phase-dead' },
  reviving: { key: 'reviving', name: '复活期', cls: 'phase-reviving' },
};

function safeDiv(a, b) { return b > 0 ? a / b : 0; }

function sumBy(arr, key) { return arr.reduce((s, r) => s + num(r[key]), 0); }

function zeroRow(statDate) {
  return { stat_date: statDate, cost: 0, gmv: 0, orders: 0, refund_rate: 0 };
}

function fillHistoryGaps(history, queryStart, queryEnd) {
  if (!history || history.length === 0) return [];
  const dailyMap = new Map();
  history.forEach(r => { dailyMap.set(r.stat_date, r); });
  const sortedDates = Array.from(dailyMap.keys()).sort();
  const start = queryStart || sortedDates[0];
  const end = queryEnd || sortedDates[sortedDates.length - 1];
  const dates = [];
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return dates.map(d => dailyMap.get(d) || zeroRow(d));
}

function computeLifecycle(row, history, queryStart, queryEnd) {
  const createTime = row['创建时间'];
  const now = new Date();
  let ageDays = 1;
  if (createTime && createTime !== '-') {
    const created = new Date(createTime);
    ageDays = Math.max(1, Math.floor((now - created) / 86400000));
  }

  // 按日期排序，补全缺失日期为 0
  const allDays = fillHistoryGaps(history, queryStart, queryEnd);
  if (allDays.length === 0) {
    return { phase: PHASES.stable, signals: {}, isSeeding: false, ageDays };
  }

  const endDate = queryEnd || allDays[allDays.length - 1].stat_date;
  const totalCost = sumBy(allDays, 'cost');

  // 窗口切片（从最后一天往前数）
  const sliceDays = n => allDays.slice(-n);
  const recent30 = sliceDays(30);
  const recent7  = sliceDays(7);
  const recent3  = sliceDays(3);
  const prev7    = allDays.slice(-14, -7);

  const cost30 = sumBy(recent30, 'cost');
  const cost7  = sumBy(recent7,  'cost');
  const cost3  = sumBy(recent3,  'cost');
  const cost1  = num(allDays[allDays.length - 1].cost);

  const roi30 = cost30 > 0 ? sumBy(recent30, 'gmv') / cost30 : 0;
  const roi7  = cost7  > 0 ? sumBy(recent7,  'gmv') / cost7  : 0;
  const roi3  = cost3  > 0 ? sumBy(recent3,  'gmv') / cost3  : 0;

  const avgSpend7 = cost7 / 7;
  const avgSpend30 = cost30 / 30;

  // 连续无消耗天数
  let noSpendStreak = 0;
  for (let i = allDays.length - 1; i >= 0; i--) {
    if (num(allDays[i].cost) <= 0) noSpendStreak++;
    else break;
  }

  // 衰退信号：历史不足时取中性值 1，避免单日窗口产生虚假信号
  const has3 = recent3.length >= 3;
  const has7 = recent7.length >= 7;
  const has30 = recent30.length >= 30;

  const roiDecay = (has30 && has3 && roi30 > 0) ? roi3 / roi30 : 1;
  const spendDecay = (has7 && has3 && avgSpend7 > 0) ? (cost3 / 3) / avgSpend7 : 1;

  const orders30 = sumBy(recent30, 'orders');
  const orders3  = sumBy(recent3,  'orders');
  const costPerOrder30 = orders30 > 0 ? cost30 / orders30 : 0;
  const costPerOrder3  = orders3  > 0 ? cost3  / orders3  : 0;
  const costPerOrderIncrease = (has30 && has3 && costPerOrder30 > 0) ? costPerOrder3 / costPerOrder30 : 1;

  const refund30 = orders30 > 0 ? recent30.reduce((s, r) => s + num(r.refund_rate) * num(r.orders), 0) / orders30 : 0;
  const refund3  = orders3  > 0 ? recent3.reduce((s, r) => s + num(r.refund_rate) * num(r.orders), 0) / orders3  : 0;
  const refundSpike = (has30 && has3 && refund30 > 0) ? refund3 / refund30 : 1;

  const signals = {
    roiDecay: +roiDecay.toFixed(2),
    spendDecay: +spendDecay.toFixed(2),
    costPerOrderIncrease: +costPerOrderIncrease.toFixed(2),
    refundSpike: +refundSpike.toFixed(2),
    noSpendStreak,
  };

  // 死亡期：连续无消耗 >= 7 天
  // 但如果当日有消耗且 ROI 达标（>1.0），判为复活期而非死亡
  if (noSpendStreak >= 7) {
    // 复活校验：当日有消耗，且当日 ROI > 1.0（保本线）
    const todayRoi = cost1 > 0 ? num(allDays[allDays.length - 1].gmv) / cost1 : 0;
    if (cost1 > 0 && todayRoi > 1.0) {
      return { phase: PHASES.reviving, signals, isSeeding: false, ageDays };
    }
    return { phase: PHASES.dead, signals, isSeeding: false, ageDays };
  }

  // 学习期：新素材消耗还没跑开
  if (ageDays <= 7 && totalCost < 30 * ageDays) {
    return { phase: PHASES.learning, signals, isSeeding: false, ageDays };
  }

  // 新素材保护期：ageDays <= 7 的素材不判 declining，最多判 learning
  // 原因：3-7 天的新素材 ROI 波动大，declining 会误杀
  if (ageDays <= 7) {
    // 已度过 learning（消耗够），但仍在保护期内，标记为 learning 而非 declining
    return { phase: PHASES.learning, signals, isSeeding: false, ageDays };
  }

  // 衰退期：ROI 或消耗明显下滑（需有足够历史+足够消耗，避免低消耗噪声）
  const isDecliningROI = has30 && has3 && roi30 > 0 && roi3 > 0 && roi3 < roi30 * 0.7 && cost3 >= 50 && spendDecay < 1.5;
  const isDecliningSpend = has7 && has3 && avgSpend7 > 0 && cost3 < avgSpend7 * 3 * 0.4 && cost3 > 0;
  if (isDecliningROI || isDecliningSpend) {
    return { phase: PHASES.declining, signals, isSeeding: false, ageDays };
  }

  // 爬坡期：消耗在放量且 ROI 健康（需有前后两周对比）
  const prev7Cost = sumBy(prev7, 'cost');
  if (ageDays <= 30 && prev7.length >= 7 && prev7Cost > 0 && cost7 > prev7Cost * 1.2 && roi7 >= 1.5) {
    return { phase: PHASES.growth, signals, isSeeding: false, ageDays };
  }

  // 稳定期：近期表现与长期一致
  const roiStable = has30 && has7 && roi30 > 0 ? Math.abs(roi7 - roi30) / roi30 <= 0.2 : true;
  const spendStable = has30 && has7 && avgSpend30 > 0 ? avgSpend7 >= avgSpend30 * 0.7 : true;
  if (roiStable && spendStable) {
    return { phase: PHASES.stable, signals, isSeeding: false, ageDays };
  }

  // 默认稳定期
  return { phase: PHASES.stable, signals, isSeeding: false, ageDays };
}

function classifySeeding(row, history, accountTotals) {
  if (!history || history.length === 0) return false;
  const today = history[history.length - 1];
  const todayCost = num(today.cost);
  const todayGmv = num(today.gmv);
  const todayRoi = todayCost > 0 ? todayGmv / todayCost : 0;

  // 今日有消耗、ROI 低于账号整体、且今日消耗占比 > 5%
  const accountCost = accountTotals.cost || 0;
  const accountRoi = accountCost > 0 ? (accountTotals.gmv || 0) / accountCost : 0;
  const spendShare = accountCost > 0 ? todayCost / accountCost : 0;

  // 近7天消耗高于前7天（放量中）
  const recent7 = history.slice(-7);
  const prev7 = history.slice(-14, -7);
  const recent7Cost = sumBy(recent7, 'cost');
  const prev7Cost = sumBy(prev7, 'cost');
  const isAccelerating = prev7Cost > 0 ? recent7Cost > prev7Cost * 1.1 : recent7Cost > todayCost * 3;

  return todayCost > 0 && todayRoi < accountRoi && spendShare > 0.05 && isAccelerating;
}

function attachLifecycle(rows, histories, queryStart, queryEnd, accountTotals) {
  rows.forEach(r => {
    const history = histories[r['素材ID']] || [];
    const lc = computeLifecycle(r, history, queryStart, queryEnd);
    r._lifecycle = lc.phase.key;
    r._lifecycleName = lc.phase.name;
    r._lifecycleClass = lc.phase.cls;
    r._decaySignals = lc.signals;
    r._ageDays = lc.ageDays;
    r._isSeeding = r._action === 'boost_roi' || r._action === 'boost_open' || classifySeeding(r, history, accountTotals);
  });

  // lifecycle 修正 role：衰退/死亡期的素材不能 scale/volume，降级为 hold/replace
  rows.forEach(r => {
    reconcileActionByLifecycle(r);
  });

  return rows;
}

/**
 * 根据 lifecycle 修正 _action（操作建议），确保建议是投手能直接执行的动作。
 *
 * 操作值：boost_roi / boost_open / pause_boost / raise_roi / lower_roi / delist / watch
 *
 * 修正规则：
 * - declining：不能追投（关追投或下架）
 * - dead：强制下架
 * - reviving：先观察，不追投
 * - learning：只观察，不追投（模型还在学，追投会打断学习）
 * - 退款率≥30% 且有追投：关追投；无追投则下架
 * - 7天净投入产出比<1.0 且有追投：关追投；无追投则下架
 */
function reconcileActionByLifecycle(row) {
  if (!row._lifecycle || !row._action) return;
  const lc = row._lifecycle;
  const action = row._action;

  // 追投类动作统一判定
  const isBoost = action === 'boost_roi' || action === 'boost_open';

  // 当前是否有追投任务在跑（追投调控消耗 > 0 说明有追投任务）
  const boostCost = num(row['追投调控消耗(元)']);
  const hasBoost = boostCost > 0;

  // 退款率≥30%：有追投就关追投，没追投就下架
  const refundRate = num(row['1h退款率']);
  if (refundRate >= 30 && isBoost) {
    row._action = hasBoost ? 'pause_boost' : 'delist';
    return;
  }

  // 7天净投入产出比<1.0：有追投就关追投，没追投就下架
  if (row._avgNetRoi7d !== undefined && row._avgNetRoi7d < 1.0 && isBoost) {
    row._action = hasBoost ? 'pause_boost' : 'delist';
    return;
  }

  if (lc === 'dead') {
    row._action = 'delist';
    return;
  }
  if (lc === 'declining') {
    // 衰退期：亏损的下架；有追投的关追投；没追投的观察不动
    if (isBoost) {
      if (row._roiStatus === 'bleeding') {
        row._action = 'delist';
      } else {
        row._action = hasBoost ? 'pause_boost' : 'watch';
      }
    }
    return;
  }
  if (lc === 'reviving') {
    // 复活期：先观察，不追投
    if (isBoost) {
      row._action = 'watch';
    }
    return;
  }
  if (lc === 'learning') {
    // 学习期：只观察，不追投（追投会打断模型学习）
    if (isBoost) {
      row._action = 'watch';
    }
    return;
  }
}

module.exports = {
  computeLifecycle,
  classifySeeding,
  attachLifecycle,
  reconcileActionByLifecycle,
  PHASES,
};
