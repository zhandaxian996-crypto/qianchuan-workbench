/**
 * SOP 自动诊断引擎 — 把操盘纪律（references/discipline.md）的前置诊断/生命周期止损代码化
 *
 * 输入：todaySnapshot 的 rows + liveDashboard 的 thresholds
 * 输出：结构化诊断结果 + 操作建议（含风险等级和执行参数）
 *
 * SOP 规则：
 *   Step 1: 全域承载力诊断（在线/GPM 判断直播间是否崩了）
 *   Step 2: 素材质量前置（5s流失率，T+1数据当天跳过）
 *   Step 3: 动态生命周期止损
 *     - 消耗 ≥ P×1.5 且 0成交 → 暂停（新素材<3天且消耗<P×2 豁免）
 *     - 消耗 ≥ P×2 且 净ROI < nROI_t×0.5 → 暂停
 *     - 消耗速度连续2天环比下降>30% 且 净ROI < nROI_t×0.9 → 暂停
 *
 * 操作边界：
 *   - 追投任务（有 assistTaskId）→ 可暂停/删除/调ROI
 *   - 素材（无 assistTaskId）→ 只能删除（计划不能暂停，铁律）
 */

/**
 * @param {Object} params
 * @param {Array} params.rows - todaySnapshot 的 rows（素材明细）
 * @param {Object} params.thresholds - liveDashboard 的 thresholds
 * @param {Object} params.today - 今日汇总数据
 * @param {Object} params.live - 直播状态
 * @param {Array} params.boostTasks - 追投任务列表
 * @returns {Object} 诊断结果
 */
function diagnose(params) {
  const { rows = [], thresholds = {}, today = {}, live = {}, boostTasks = [] } = params;

  const P = thresholds.avg_order_price || 50;        // 客单价
  const nROI_t = thresholds.break_even_roi || 2.0;   // 保本净ROI
  const exploreLine = P * 1.5;                        // 探索期验证线
  const sLevelCost = P * 2;                           // S级消耗达标线
  const stopLossROI = nROI_t * 0.5;                  // 深度亏损止损线
  const aLevelROI = nROI_t * 0.9;                    // A级盈利守线
  const sLevelROI = nROI_t * 1.3;                    // S级盈利反哺线

  const result = {
    thresholds: { P, nROI_t, exploreLine, sLevelCost, stopLossROI, aLevelROI, sLevelROI },
    step1: null,      // 全域承载力
    step2: null,      // 素材质量（T+1，当天跳过）
    step3: [],        // 止损建议（数组，每条一个素材）
    boost_diagnosis: [], // 追投任务诊断
    summary: null,    // 总结
  };

  // === Step 1: 全域承载力诊断 ===
  const onlineCount = live.online || (live.live_metrics && live.live_metrics.online) || 0;
  const gpm = live.gpm || (live.live_metrics && live.live_metrics.gpm) || 0;
  const watchUcount = live.watchUcount || (live.live_metrics && live.live_metrics.watchUcount) || 0;

 let step1Level = 'ok';
 let step1Msg = '';
  if (onlineCount > 0 && onlineCount < 3) {
    step1Level = 'danger';
    step1Msg = `在线仅${onlineCount}人，人货场崩盘（场观${watchUcount}，GPM ${gpm}）`;
  } else if (gpm > 0 && gpm < 300) {
    step1Level = 'danger';
    step1Msg = `GPM仅${gpm}极低，人货场崩盘（在线${onlineCount}）`;
  } else if (onlineCount >= 3 && onlineCount < 10) {
    step1Level = 'warn';
    step1Msg = `在线仅${onlineCount}人，直播间承接力偏弱（场观${watchUcount}，GPM ${gpm}）`;
  } else if (gpm >= 300 && gpm < 800) {
    step1Level = 'warn';
    step1Msg = `GPM仅${gpm}，远低于爆量线（5000+），直播间效率低`;
  } else if (gpm >= 5000) {
    step1Level = 'good';
    step1Msg = `GPM ${gpm}表现优秀，直播间承接力强`;
  } else {
    step1Msg = `在线${onlineCount}人，场观${watchUcount}，GPM ${gpm}`;
  }
  result.step1 = { level: step1Level, msg: step1Msg, skip_stop_loss: step1Level === 'danger' };

  if (result.step1.skip_stop_loss) {
    result.summary = { action: 'skip', reason: '直播间承接力崩了，调投放没用，先优化人货场' };
    return result;
  }

  // === Step 2: 素材质量前置（5s流失率 T+1，当天无数据跳过）===
  result.step2 = { skipped: true, reason: '5s流失率为T+1数据，当天不可用' };

  // === Step 3: 动态生命周期止损 ===
  for (const r of rows) {
    if (r.status === '已删除') continue;
    const cost = r.todayCost || 0;
    const netROI = r.todayNetROI || 0;
    const orders = r.todayOrders || 0;
    const ageDays = r.ageDays || 0;
    const materialId = r.materialId;
    const materialName = r.materialName;

    // 跳过消耗太低的
    if (cost < 10) continue;

    let action = null;
    let reason = '';
    let riskLevel = 'low';

    // 规则1：消耗 ≥ P×1.5 且 0成交 → 暂停/删除
    if (cost >= exploreLine && orders === 0) {
      // 豁免：新素材上线未满3天且消耗未达 P×2
      if (ageDays <= 3 && cost < sLevelCost) {
        action = 'watch';
        reason = `消耗${cost}元0成交，但新素材(${ageDays}天)且消耗<P×2(${sLevelCost}元)，SOP豁免`;
        riskLevel = 'info';
      } else {
        // 无追投任务的素材只能删
        const hasBoost = boostTasks.some(t => t.material_id === materialId);
        action = hasBoost ? 'pause_boost' : 'delete_material';
        reason = `消耗${cost}元≥P×1.5(${exploreLine}元)且0成交，深度空耗`;
        riskLevel = 'high';
      }
    }

    // 规则2：消耗 ≥ P×2 且 净ROI < 止损线 → 暂停/删除
    if (!action && cost >= sLevelCost && netROI > 0 && netROI < stopLossROI) {
      const hasBoost = boostTasks.some(t => t.material_id === materialId);
      action = hasBoost ? 'pause_boost' : 'delete_material';
      reason = `消耗${cost}元≥P×2(${sLevelCost}元)且净ROI ${netROI.toFixed(2)}<止损线${stopLossROI.toFixed(2)}`;
      riskLevel = 'high';
    }

    // 规则3：净ROI < 止损线 且消耗 > P×1（放宽版，覆盖更多亏损素材）
    if (!action && netROI > 0 && netROI < stopLossROI && cost >= P) {
      const hasBoost = boostTasks.some(t => t.material_id === materialId);
      action = hasBoost ? 'pause_boost' : 'delete_material';
      reason = `净ROI ${netROI.toFixed(2)}<止损线${stopLossROI.toFixed(2)}且消耗${cost}元>P(${P}元)`;
      riskLevel = 'high';
    }

    if (action) {
      result.step3.push({
        materialId, materialName,
        todayCost: cost, todayNetROI: netROI, todayOrders: orders, ageDays,
        action, reason, riskLevel,
        boostTask: boostTasks.find(t => t.material_id === materialId) || null,
      });
    }
  }

  // === 追投任务诊断 ===
  for (const t of boostTasks) {
    let boostAction = 'watch';
    let boostReason = '';
    let boostRisk = 'low';

    if (t.cost > 200 && t.order_count === 0) {
      boostAction = 'pause';
      boostReason = `追投消耗${t.cost}元0成交（>200元空耗线）`;
      boostRisk = 'high';
    } else if (t.net_roi > 0 && t.net_roi < stopLossROI && t.cost > 100) {
      boostAction = 'pause';
      boostReason = `追投净ROI ${t.net_roi}<止损线${stopLossROI.toFixed(2)}且消耗${t.cost}>100`;
      boostRisk = 'high';
    } else if (t.net_roi >= sLevelROI) {
      boostAction = 'consider_boost';
      boostReason = `追投净ROI ${t.net_roi}≥S级反哺线${sLevelROI.toFixed(2)}，可考虑加预算`;
      boostRisk = 'low';
    } else if (t.net_roi >= aLevelROI) {
      boostAction = 'watch';
      boostReason = `追投净ROI ${t.net_roi}≥A级守线${aLevelROI.toFixed(2)}，正常投放`;
    } else {
      boostReason = `追投净ROI ${t.net_roi}，消耗${t.cost}元`;
    }

    result.boost_diagnosis.push({
      taskId: t.id,
      taskName: t.name,
      materialName: t.material_name,
      cost: t.cost,
      netROI: t.net_roi,
      orders: t.order_count,
      action: boostAction,
      reason: boostReason,
      riskLevel: boostRisk,
      primaryAdId: t.primary_ad_id,
      assistTaskId: t.assist_aid || t.id,
    });
  }

  // === 总结 ===
  const highRisk = result.step3.filter(s => s.riskLevel === 'high');
  const boostHighRisk = result.boost_diagnosis.filter(b => b.riskLevel === 'high');

  result.summary = {
    total_materials: rows.length,
    stop_loss_count: result.step3.length,
    high_risk_count: highRisk.length,
    boost_action_count: boostHighRisk.length,
    action: (highRisk.length > 0 || boostHighRisk.length > 0) ? 'execute' : 'monitor',
    message: highRisk.length > 0
      ? `${highRisk.length}个素材需要止损（${highRisk.filter(s=>s.action==='delete_material').length}个删素材，${highRisk.filter(s=>s.action==='pause_boost').length}个暂停追投）`
      : '暂无紧急止损项，继续监控',
  };

  return result;
}

module.exports = { diagnose };
