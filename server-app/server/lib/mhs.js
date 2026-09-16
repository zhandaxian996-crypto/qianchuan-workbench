/**
 * server/lib/mhs.js — 旧 MHS 研究公式与兼容护栏。
 * 综合评分已退出在线座舱、聚合摘要、前端与夜间调度；评分函数仅留离线回测。
 * pendingOps 仍使用这里的日期聚合、参数与删除复核护栏，不能整文件删除或放宽权限。
 *
  * 历史账户专用说明已从试用包移除。
 * 职责（§七-1/4/5 的纯函数部分）：
 *   - 特征计算：衰减加权净ROI / 消耗动量 / ROI动量 / CTR / 前5秒留存 / 年龄 / 给量响应度
 *   - MHS 综合评分：α·效益分 + β·趋势分 + γ·潜力分 − δ·年龄衰减
 *   - 删除子模型：急性衰退双闸门（§5.1）+ 慢性亏损 + 死缓复活判定
 *   - 执行约束（§4.3）：衰退过滤 / 信号过滤 / 账号止损线 / 熔断
 *   - 冷启动通道（§4.4）与追投额度通道分流（§4.6）
 *
  * 历史账户专用说明已从试用包移除。
 *   本文件不设任何业务数值；未填入前 calibrated=false，computeMhs 返回 mhs=null（未标定），
 *   决策卡降级为"特征值 + 删除子模型判定"。执行约束类数值的默认来自 config.mhs（文档明示口径）。
 *
 * 窗口口径（T+1，数据截止昨天）：
 *   近3天 = [昨天-2, 昨天]；前7天 = [昨天-9, 昨天-3]；近7天 = [昨天-6, 昨天]
 * 净成交口径：只认 net_gmv_1h；net_gmv 历史曾被支付GMV污染，严禁回退。
 */

const path = require('path');
const fs = require('fs');
const { asPercent } = require('./materialFunnel');

// ═══════════════════════════════════════════════════════════
// 参数读取与校验（§七-5）
// ═══════════════════════════════════════════════════════════

// 公式标定必需的参数（全部为数才算已标定）
const CALIBRATION_KEYS = ['alpha', 'beta', 'gamma', 'delta', 't_you', 't_qian', 't_lie'];

/**
 * 合并 MHS 参数：config.mhs（全局默认）← account_config[账号].mhs（按账号覆盖）
 * ← cache/mhs_versions.json 中 status='active' 的版本参数（版本管理工具产出，§七-6）。
 * @param {string} [accountId]
 * @returns {{params: object, calibrated: boolean, missing: string[], version: string, source: string}}
 */
function getMhsParams(accountId) {
  const config = require('./config');
  // 2026-08-12 修复：config 里实际字段是小写 mhs，代码读大写 MHS——大小写双收兼容（顶层全局默认此前从未被消费）
  let params = { ...(config.MHS || config.mhs || {}) };
  let source = 'config.mhs';
  const accCfg = (config.account_config && accountId && config.account_config[accountId]) || {};
  if (accCfg.mhs && typeof accCfg.mhs === 'object') {
    params = { ...params, ...accCfg.mhs };
    source = `account_config.${accountId}.mhs`;
  }
  // 历史账户专用说明已从试用包移除。
  try {
    const active = getActiveVersion(accountId);
    if (active && active.params && typeof active.params === 'object') {
      params = { ...params, ...active.params };
      params.version = active.version;
      source = `mhs_versions:${active.version}`;
    }
  } catch { /* 版本文件缺失/损坏时只用 config */ }

  const missing = CALIBRATION_KEYS.filter(k => typeof params[k] !== 'number');
  return {
    params,
    calibrated: missing.length === 0,
    missing,
    version: params.version || 'V1-uncalibrated',
    source,
  };
}

/** 参数校验：数值字段必须为 ≥0 的有限数或 null；返回错误列表（空数组=通过） */
function validateMhsParams(params) {
  const errors = [];
  if (!params || typeof params !== 'object') return ['params 必须是对象'];
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('_') || k === 'version' || k === 'vocab_file') continue;
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${k} 必须是数字或 null，当前: ${JSON.stringify(v)}`);
    }
  }
  // 档位阈值顺序：t_lie ≤ t_qian ≤ t_you（都填了才校验）
  const { t_lie, t_qian, t_you } = params;
  if ([t_lie, t_qian, t_you].every(v => typeof v === 'number')) {
    if (!(t_lie <= t_qian && t_qian <= t_you)) errors.push(`档位阈值需满足 t_lie ≤ t_qian ≤ t_you，当前 ${t_lie}/${t_qian}/${t_you}`);
  }
  return errors;
}

// ═══════════════════════════════════════════════════════════
// 版本存取（§七-6 的读取侧；写入侧在 lib/mhsVersions.js）
// ═══════════════════════════════════════════════════════════

const VERSIONS_FILE = path.join(__dirname, '..', '..', 'cache', 'mhs_versions.json');

function loadVersions() {
  try {
    const data = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
    if (data && Array.isArray(data.versions)) return data;
  } catch { /* 文件不存在或损坏 → 空库 */ }
  return { versions: [] };
}

/** 取激活版本：按账号匹配（version.account 为空=全局通用），无激活版本返回 null */
function getActiveVersion(accountId) {
  const { versions } = loadVersions();
  const actives = versions.filter(v => v.status === 'active');
  // 账号专属优先，其次全局
  return actives.find(v => v.account && v.account === accountId)
    || actives.find(v => !v.account)
    || null;
}

// ═══════════════════════════════════════════════════════════
// 工具：逐日行聚合（同素材同日可能有 marketing_goal 1/2 两行）
// ═══════════════════════════════════════════════════════════

/**
 * 行净成交：net_gmv_1h 优先（真净成交，扣 1h 退款）。
  * 历史账户专用说明已从试用包移除。
 * 实测 58% 素材因回退脏字段导致净ROI 不可信——是 8-05 误删事故的隐藏根因之一）。
 * 返回 0 时由调用方判断"净ROI 不可信，降级用支付ROI 判杀"。
 */
function netOf(row) {
  return +row.net_gmv_1h || 0;
}

/**
 * 行支付ROI：gmv / cost（DB gmv 字段是支付口径含退款，与净成交 netOf 对偶）。
  * 历史账户专用说明已从试用包移除。
 * 保留 payRoiOf 仅供"净ROI 不可信时降级判杀"使用。
 */
function payRoiOf(row) {
  if (!row) return null;
  const c = +row.cost || 0;
  if (c <= 0) return null;
  return (+row.gmv || 0) / c;
}

/**
  * 历史账户专用说明已从试用包移除。
 * 发布 3-14 天且净ROI≥保本×0.4 的素材判救——冲量期素材账面暂时难看但可能在爬坡，
 * 不一刀切。返回 true=保护生效（不删），false=不保护（按原判定走）。
 * v2 整改：窗口上限从 10 天扩展到 14 天（救回 7-24 梅菜烧肉2 12 天场景）。
 * 参数从 params.delete_protection 嵌套结构读（与 config.json account_config.mhs.delete_protection 对齐）。
 */
function surgeWindowProtect(opts) {
  const { ageDays, netRoi, breakEven, params } = opts || {};
  const p = params || {};
  const dp = p.delete_protection || {};
  if (dp.surge_window_enabled === false) return false;
  const win = Array.isArray(dp.surge_window_days) && dp.surge_window_days.length === 2
    ? dp.surge_window_days : [3, 14];
  const factor = dp.surge_protect_factor != null ? dp.surge_protect_factor : 0.4;
  if (ageDays == null || ageDays < win[0] || ageDays > win[1]) return false;
  const line = +(breakEven * factor).toFixed(2);
  if (netRoi == null || !Number.isFinite(+netRoi)) return false;
  if (+netRoi >= line) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════
// 历史账户专用说明已从试用包移除。
// V1.4（2026-08-05）：加 CPA 护栏 + 近期衰退反条件 + volatility 连续3天失效
// 设计依据：500+ 素材 DB 实测 + 千川官方"连续3天=衰退期"判据 + 平台"成本超30%自动下线"规则
// ═══════════════════════════════════════════════════════════

/**
 * V1.4 平台规则护栏（千川原生"成本超30%自动下线"，权威性最高，绕过所有保护锁）
 * 近7天 CPA > 目标CPA×1.3 → 直接放行判杀（目标CPA=客单价/保本ROI）
  * 历史账户专用说明已从试用包移除。
 * @param {object[]} daily - aggregateDaily 逐日行
 * @param {string} endDate - 基准日
 * @param {number} breakEven - 保本ROI
 * @param {object} params - MHS 参数
 * @param {number} avgOrder - 客单价（由调用方从 config 传入）
 * @returns {object|null} - 触发时返回 {active, cpa7, targetCpa, killCpa, why}，否则 null
 */
function cpaOverrideGuard(daily, endDate, breakEven, params, avgOrder) {
  const p = params || {};
  const dp = p.delete_protection || {};
  if (dp.cpa_override === false || !avgOrder) return null;
  const targetCpa = avgOrder / breakEven;
  const killCpaFactor = dp.cpa_override_factor != null ? dp.cpa_override_factor : 1.3;
  const killCpa = targetCpa * killCpaFactor;
  const w7 = sumWindow(daily, endDate, 7);
  let w7orders = 0;
  const start7 = shiftDate(endDate, -6);
  for (const d of daily) {
    if (d.date >= start7 && d.date <= endDate) w7orders += d.orders || 0;
  }
  const minCost = dp.cpa_override_min_cost != null ? dp.cpa_override_min_cost : 300;
  if (w7.cost >= minCost && w7orders > 0) {
    const cpa7 = w7.cost / w7orders;
    if (cpa7 > killCpa) {
      return {
        active: true,
        cpa7: round2(cpa7),
        targetCpa: round2(targetCpa),
        killCpa: round2(killCpa),
        why: `平台规则护栏：近7d CPA ${round2(cpa7)} > 目标${round2(targetCpa)}×${killCpaFactor}=${round2(killCpa)}（千川原生"成本超30%自动下线"），绕过所有保护锁`,
      };
    }
  }
  return null;
}

/**
 * 闸门1：全周期功劳锁
 * 素材全周期累计表现接近保本 → 禁止判杀（短窗口可能被波动拖累）
 * 救回场景：7-15 稻草扎肉（全周期净ROI 2.16 ≥ 保本×0.6=1.5）
 * V1.4 近期衰退反条件：近7天烂穿（净ROI<保本×0.5）→ 锁失效（历史功劳不能当免死金牌）
 * V1.5 活跃度反条件（食品行业适配）：近7天有消耗天数 < activeDaysMin → 锁失效
 *   依据：食品高复购品（预制菜/粽子）容易累计门槛达标但素材已无持续跑量能力，
 *         零星消耗假活不应被历史功劳保护（预制菜复购周期30-60天，近7天活跃<3天=已死）
 */
function fullCycleLock(features, daily, breakEven, params, endDate) {
  const p = params || {};
  const dp = p.delete_protection || {};
  if (dp.full_cycle_lock === false) return null;
  const netFactor = dp.full_cycle_net_factor != null ? dp.full_cycle_net_factor : 0.6;
  const gmvThreshold = dp.full_cycle_gmv_threshold != null ? dp.full_cycle_gmv_threshold : 5000;
  const orderThreshold = dp.full_cycle_order_threshold != null ? dp.full_cycle_order_threshold : 100;
  const activeDaysMin = dp.full_cycle_active_days_min != null ? dp.full_cycle_active_days_min : 3;

  // V1.4 近期衰退反条件：近7天烂穿（净ROI<保本×0.5）→ 锁失效
  if (endDate && Array.isArray(daily)) {
    const w7 = sumWindow(daily, endDate, 7);
    const roi7 = w7.cost > 0 ? w7.net / w7.cost : null;
    const burningLine = breakEven * (dp.burning_factor != null ? dp.burning_factor : 0.5);
    if (roi7 != null && roi7 < burningLine) return null;

    // V1.5 活跃度反条件：近7天有消耗天数 < activeDaysMin → 锁失效
    const start7 = shiftDate(endDate, -6);
    const daily7 = daily.filter(d => d.date >= start7 && d.date <= endDate);
    const activeDays7 = daily7.filter(d => d.cost > 0).length;
    if (activeDays7 < activeDaysMin) return null;
  }

  // 全周期累计（aggregateDaily 已升序，直接 reduce）
  let totalCost = 0, totalNet = 0, totalOrders = 0;
  for (const d of (daily || [])) {
    totalCost += d.cost;
    totalNet += d.net;
    totalOrders += d.orders || 0;
  }
  if (totalCost <= 0) return null;
  const fullNetRoi = totalNet / totalCost;
  const reasons = [];
  if (fullNetRoi >= breakEven * netFactor) {
    reasons.push(`全周期净ROI ${round2(fullNetRoi)} ≥ 保本×${netFactor}（${round2(breakEven * netFactor)}）`);
  }
  if (totalNet >= gmvThreshold) {
    reasons.push(`累计净成交 ${round2(totalNet)} ≥ ${gmvThreshold}`);
  }
  if (totalOrders >= orderThreshold) {
    reasons.push(`累计订单 ${totalOrders} ≥ ${orderThreshold}`);
  }
  if (reasons.length === 0) return null;
  return {
    active: true,
    fullNetRoi: round2(fullNetRoi),
    totalCost: round2(totalCost),
    totalNet: round2(totalNet),
    totalOrders,
    why: `全周期功劳锁：${reasons.join('，')}，禁止判杀`,
  };
}

/**
 * 闸门2：近期表现锁
 * 近 7d/30d 任一窗口表现接近保本 → 禁止判杀（近期有健康表现不该当死号删）
 * 救回场景：6-1 晚上六七点下班（7d ROI 13.05）/ 6-4 梅菜烧肉露营（7月 net_roi 1.90）
 * V1.4 近期衰退反条件：近7天烂穿（净ROI<保本×0.5）→ 锁失效（近期烂穿则锁自相矛盾）
 */
function recentPerformanceLock(features, breakEven, params) {
  const p = params || {};
  const dp = p.delete_protection || {};
  if (dp.recent_lock === false) return null;
  const roi7 = features.net_roi_7d;

  // V1.4 近期衰退反条件：近7天烂穿（净ROI<保本×0.5）→ 锁失效
  const burningLine = breakEven * (dp.burning_factor != null ? dp.burning_factor : 0.5);
  if (roi7 != null && roi7 < burningLine) return null;
  const roi30 = features.net_roi_30d;
  const breakEven7 = breakEven;
  const breakEven30 = breakEven * 0.85;
  const reasons = [];
  if (roi7 != null && roi7 >= breakEven7) {
    reasons.push(`7d 净ROI ${round2(roi7)} ≥ 保本 ${breakEven7}`);
  }
  if (roi30 != null && roi30 >= breakEven30) {
    reasons.push(`30d 净ROI ${round2(roi30)} ≥ 保本×0.85（${round2(breakEven30)}）`);
  }
  // 近7d 任一日 cost>0 且净ROI≥保本 → 有健康日，判救
  const daily7 = features.daily_7d || [];
  const healthyDays = daily7.filter(d => d.cost > 0 && d.net / d.cost >= breakEven);
  if (healthyDays.length > 0) {
    reasons.push(`近7d 有 ${healthyDays.length} 个健康日（净ROI≥保本）`);
  }
  if (reasons.length === 0) return null;
  return {
    active: true,
    roi_7d: roi7 != null ? round2(roi7) : null,
    roi_30d: roi30 != null ? round2(roi30) : null,
    healthy_days_7d: healthyDays.length,
    why: `近期表现锁：${reasons.join('，')}，禁止判杀`,
  };
}

/**
 * 闸门3：波动模式锁
 * 近 14d 有"断崖日"（cost<7d均值×0.2 或 gmv=0）+ 断崖后 1-3 日内反弹 → 禁止判杀
 * 救回场景：7-15 稻草扎肉（8-02 断崖 cost=14.92→8-03 反弹 cost=446 gmv=897）
 * V1.4 反条件（千川官方"连续3天=衰退期"判据）：断崖反弹后若近3天连续烂穿（ROI<保本×0.5）→ 锁失效
 *   依据：千川官方投放衰退阶段文档——"连续3天有规律数据变化，衰减期基本很难挽回"
 * V1.5 改动（食品行业适配）：
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *   b. 反弹持续性验证：反弹后必须连续 sustainDaysMin 天维持消耗≥avg7×0.5（默认2天）
 *      依据：行业"断崖式vs斜坡式"洞察——真反弹是持续维持，假反弹是单日脉冲后继续烂
 */
function volatilityLock(daily, endDate, breakEven, params) {
  const p = params || {};
  const dp = p.delete_protection || {};
  if (dp.volatility_lock === false) return null;
  if (!Array.isArray(daily) || daily.length === 0) return null;

  // 算 7d 均值（ endDate 前 7 天）
  const w7 = sumWindow(daily, endDate, 7);
  const avg7 = w7.cost / 7;
  if (avg7 <= 0) return null;

  // V1.4 burningLine（连续3天烂穿失效检查用）
  const burningLine = breakEven * (dp.burning_factor != null ? dp.burning_factor : 0.5);

  // V1.5 食品行业适配参数
  const cliffMinCost = dp.volatility_cliff_min_cost != null ? dp.volatility_cliff_min_cost : 50;
  const sustainDaysMin = dp.volatility_sustain_days_min != null ? dp.volatility_sustain_days_min : 2;

  // 扫近 14d 找断崖日
  const start14 = shiftDate(endDate, -13);
  const recent14 = daily.filter(d => d.date >= start14 && d.date <= endDate);
  for (const day of recent14) {
    if (day.cost <= 0) continue;
    // V1.5a 绝对消耗门槛：小日耗波动不算断崖
    if (day.cost < cliffMinCost) continue;
    const isCliff = day.cost < avg7 * 0.2 || day.gmv <= 0;
    if (!isCliff) continue;
    // 找断崖后 1-3 日内是否有反弹
    const dayIdx = daily.findIndex(d => d.date === day.date);
    for (let i = 1; i <= 3; i++) {
      const next = daily[dayIdx + i];
      if (!next) break;
      if (next.cost > avg7 * 0.5 && next.gmv > 0) {
        // V1.5b 反弹持续性验证：反弹后必须连续 sustainDaysMin 天维持消耗
        let sustainDays = 0;
        for (let k = 1; k <= sustainDaysMin; k++) {
          const sustainDay = daily[dayIdx + i + k];
          if (!sustainDay) break;
          if (sustainDay.cost > avg7 * 0.5 && sustainDay.gmv > 0) sustainDays++;
        }
        if (sustainDays < sustainDaysMin) continue; // 反弹未持续，单日脉冲，锁不触发
        // V1.4 连续3天烂穿失效检查（千川官方"连续3天=衰退期"判据）
        let burningStreak = 0;
        for (let k = 2; k >= 0; k--) {
          const checkDate = shiftDate(endDate, -k);
          const d = daily.find(x => x.date === checkDate);
          if (d && d.cost > 0 && d.net / d.cost < burningLine) burningStreak++;
        }
        if (burningStreak >= 3) break; // 近3天连续烂穿，已进入真衰退期，锁失效，跳出内层循环继续看下一个断崖日
        const nextRoi = next.cost > 0 ? next.net / next.cost : null;
        return {
          active: true,
          cliffDate: day.date,
          cliffCost: round2(day.cost),
          reboundDate: next.date,
          reboundCost: round2(next.cost),
          reboundGmv: round2(next.gmv),
          reboundRoi: nextRoi != null ? round2(nextRoi) : null,
          sustainDays,
          avg7Cost: round2(avg7),
          why: `波动模式锁：${day.date} 断崖（cost ${round2(day.cost)} < 7d均值×0.2 ${round2(avg7 * 0.2)}），但 ${next.date} 反弹（cost ${round2(next.cost)} > 7d均值×0.5 且 gmv ${round2(next.gmv)} > 0）持续${sustainDays}天，单日波动非真死，判救`,
        };
      }
    }
  }
  return null;
}

/**
 * 把 material_daily 原始行聚合成逐日行：{date, cost, gmv, net, orders, plays, shows, boost_cost, boost_net}
 * 同素材同日可能有 marketing_goal 1/2 两行：cost/gmv/net 合计入总口径，
 * 同时按渠道分列 cost_live（mg=2 直播）/ cost_product（mg=1 商品卡/乘方）供决策卡渠道构成展示（2026-07-30）。
 * @param {object[]} rows - 单素材 material_daily 行（任意顺序）
 * @returns {object[]} 按日期升序
 */
function aggregateDaily(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const d = r.stat_date;
    if (!d) continue;
    let o = byDate.get(d);
    if (!o) {
      o = { date: d, cost: 0, gmv: 0, net: 0, orders: 0, plays: 0, shows: 0, boost_cost: 0, boost_net: 0, refund_rate_max: 0, cost_live: 0, cost_product: 0, net_live: 0, net_product: 0 };
      byDate.set(d, o);
    }
    const c = +r.cost || 0;
    const n = netOf(r);
    o.cost += c;
    o.gmv += +r.gmv || 0;
    o.net += n;
    if ((+r.marketing_goal || 2) === 1) { o.cost_product += c; o.net_product += n; }
    else { o.cost_live += c; o.net_live += n; }
    o.orders += +r.orders || 0;
    o.plays += +r.plays || 0;
    o.shows += +r.shows || 0;
    o.boost_cost += +r.additional_cost || 0;
    o.boost_net += +r.additional_net_gmv || 0;
    o.refund_rate_max = Math.max(o.refund_rate_max, +r.refund_rate || 0);
  }
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

/** 日期串平移 n 天（本地时区） */
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function round4(n) { return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null; }

/** 窗口求和 */
function sumWindow(daily, endDate, days) {
  const start = shiftDate(endDate, -(days - 1));
  const w = daily.filter(d => d.date >= start && d.date <= endDate);
  const s = { cost: 0, gmv: 0, net: 0, orders: 0, plays: 0, shows: 0, boost_cost: 0, boost_net: 0, days_with_cost: 0, cost_live: 0, cost_product: 0, net_live: 0, net_product: 0 };
  for (const d of w) {
    s.cost += d.cost; s.gmv += d.gmv; s.net += d.net; s.orders += d.orders;
    s.plays += d.plays; s.shows += d.shows; s.boost_cost += d.boost_cost; s.boost_net += d.boost_net;
    s.cost_live += d.cost_live || 0; s.cost_product += d.cost_product || 0;
    s.net_live += d.net_live || 0; s.net_product += d.net_product || 0;
    if (d.cost > 0) s.days_with_cost++;
  }
  return s;
}

// ═══════════════════════════════════════════════════════════
// 特征计算（§4.1 组件）
// ═══════════════════════════════════════════════════════════

/**
 * 计算单素材特征（纯函数）。
 * @param {object[]} daily - aggregateDaily 产出的逐日行（升序）
 * @param {object} ctx - 上下文：
 *   { endDate: 'YYYY-MM-DD'（基准日=昨天）, accountCost7d, accountGmv7d, accountGmvList7d:number[],
 *     accountCtr7d:number|null, breakEven:number, retention5s:number|null, createdAt:string,
 *     params:object（getMhsParams 的 params） }
 * @returns {object} 特征对象（含 role/动量/CTR/留存/给量响应度/分数组件/age_days）
 */
function computeFeatures(daily, ctx) {
  const { endDate, params } = ctx;
  const p = params || {};
  const breakEven = ctx.breakEven || 2.0;
  const halfLife = p.decay_half_life_days || 7;
  const headShare = p.head_cost_share != null ? p.head_cost_share : 0.1;

  // ── 窗口 ──
  const w7 = sumWindow(daily, endDate, 7);
  const w3 = sumWindow(daily, endDate, 3);
  const wPrev7 = sumWindow(daily, shiftDate(endDate, -3), 7);
  const w14 = sumWindow(daily, endDate, 14);

  // ── 年龄：首耗日 → 基准日（无消耗日用 created_at 兜底）──
  const firstCostDate = (daily.find(d => d.cost > 0) || {}).date || ctx.createdAt || null;
  const ageDays = firstCostDate
    ? Math.max(0, Math.round((new Date(endDate + 'T00:00:00') - new Date(String(firstCostDate).slice(0, 10) + 'T00:00:00')) / 86400000))
    : 0;

  // ── 衰减加权净ROI：近14天 w=0.5^(距今天数/halfLife)，Σ(w·net)/Σ(w·cost) ──
  let wNet = 0, wCost = 0;
  for (const d of daily) {
    if (d.date > endDate) continue;
    const daysAgoN = Math.round((new Date(endDate + 'T00:00:00') - new Date(d.date + 'T00:00:00')) / 86400000);
    if (daysAgoN < 0 || daysAgoN > 13) continue;
    const w = Math.pow(0.5, daysAgoN / halfLife);
    wNet += w * d.net;
    wCost += w * d.cost;
  }
  const decayWeightedRoi = wCost > 0 ? wNet / wCost : null;

  // ── 动量：近3天日均 ÷ 前7天日均（前7天为 0 → null，新生素材不判动量）──
  const avg3 = w3.cost / 3, avgPrev7 = wPrev7.cost / 7;
  const costMomentum = avgPrev7 > 0 ? avg3 / avgPrev7 : null;
  const roi3 = w3.cost > 0 ? w3.net / w3.cost : null;
  const roiPrev7 = wPrev7.cost > 0 ? wPrev7.net / wPrev7.cost : null;
  const roiMomentum = (roi3 != null && roiPrev7 != null && roiPrev7 > 0) ? roi3 / roiPrev7 : null;

  // ── 真实点击漏斗：严禁再用“视频播放/展现”冒充 CTR。──
  // T+1 稳定漏斗由 materialFunnelStore 统一计算；缺失就明确 null。
  const funnel = ctx.funnel && ctx.funnel.metrics ? ctx.funnel : null;
  const ctr = funnel && funnel.metrics.ctr != null ? funnel.metrics.ctr / 100 : null;
  const ctrRel = funnel && funnel.metrics.ctr_rel != null ? funnel.metrics.ctr_rel : null;
  const cpc = funnel && funnel.metrics.cpc != null ? funnel.metrics.cpc : null;
  const cpcRel = funnel && funnel.metrics.cpc_rel != null ? funnel.metrics.cpc_rel : null;

  // ── 给量响应度：近7天 追投净ROI ÷ 自然流量净ROI（无追投 → null）──
  let boostResponse = null;
  if (w7.boost_cost > 0) {
    const boostRoi = w7.boost_net / w7.boost_cost;
    const naturalCost = w7.cost - w7.boost_cost;
    const naturalNet = w7.net - w7.boost_net;
    const naturalRoi = naturalCost > 0 ? naturalNet / naturalCost : null;
    boostResponse = (naturalRoi != null && naturalRoi > 0) ? boostRoi / naturalRoi : null;
  }

  // ── 角色判定（§2.2 素材分工论）：近7天消耗占账号比 ≥10% → 跑量担当 ──
  const costShare7d = ctx.accountCost7d > 0 ? w7.cost / ctx.accountCost7d : 0;
  const gmvShare7d = ctx.accountGmv7d > 0 ? w7.gmv / ctx.accountGmv7d : 0;
  const role = costShare7d >= headShare ? '跑量担当' : 'ROI担当';

  // ── 效益分 ──
  let benefitScore = null;
  if (role === '跑量担当') {
    // GMV 贡献分：素材 GMV 在账号全部素材中的分位值（0~1）
    const list = Array.isArray(ctx.accountGmvList7d) ? ctx.accountGmvList7d : [];
    if (list.length > 0) {
      const below = list.filter(v => v <= w7.gmv).length;
      benefitScore = below / list.length;
    }
  } else {
    // ROI 担当：衰减加权净ROI ÷ 保本线
    benefitScore = decayWeightedRoi != null ? decayWeightedRoi / breakEven : null;
  }

  // ── 趋势分 = 消耗动量 × ROI动量 ──
  const trendScore = (costMomentum != null && roiMomentum != null) ? costMomentum * roiMomentum : null;

  // ── 潜力分 = CTR相对值 × 前5秒留存率 × 给量响应度（组件缺失则该组件不参与，全缺 → null）──
  const normalizedRetention = ctx.retention5s != null ? (asPercent(ctx.retention5s) / 100) : null;
  const potParts = [ctrRel, normalizedRetention, boostResponse].filter(v => v != null);
  const potentialScore = potParts.length > 0 ? potParts.reduce((s, v) => s * v, 1) : null;

  // 历史账户专用说明已从试用包移除。
  const ageDecay = null;

  return {
    age_days: ageDays,
    role,
    decay_weighted_roi: round4(decayWeightedRoi),
    cost_momentum: round4(costMomentum),
    roi_momentum: round4(roiMomentum),
    ctr: round4(ctr),
    ctr_rel: round4(ctrRel),
    cpc: round2(cpc),
    cpc_rel: round4(cpcRel),
    retention_5s: normalizedRetention != null ? round4(normalizedRetention) : null,
    rate3s: funnel ? funnel.metrics.rate3s : null,
    finish_rate: funnel ? funnel.metrics.finish_rate : null,
    avg_watch_time: funnel ? funnel.metrics.avg_watch_time : null,
    watch_ratio: funnel ? funnel.metrics.watch_ratio : null,
    drop_count_30d: funnel ? funnel.metrics.drop_count_30d : null,
    drop_count_percentile: funnel ? funnel.metrics.drop_count_percentile : null,
    funnel_diagnosis: funnel ? funnel.diagnosis : null,
    funnel_failure_hits: funnel ? funnel.failure_hits : 0,
    funnel_signals: funnel ? funnel.signals : [],
    drop_amplifier: !!(funnel && funnel.drop_amplifier),
    boost_response: round4(boostResponse),
    cost_share_7d: round4(costShare7d),
    gmv_share_7d: round4(gmvShare7d),
    benefit_score: round4(benefitScore),
    trend_score: round4(trendScore),
    potential_score: round4(potentialScore),
    age_decay: ageDecay,
    // 旁证原始量（决策卡"计算依据"用）
    cost_7d: round2(w7.cost), net_roi_7d: w7.cost > 0 ? round2(w7.net / w7.cost) : null,
    cost_3d: round2(w3.cost), net_roi_3d: roi3 != null ? round2(roi3) : null,
    cost_prev7d: round2(wPrev7.cost), net_roi_prev7d: roiPrev7 != null ? round2(roiPrev7) : null,
    // 双轨制旁证（2026-08-01 专家团方案）：GPM骤降/流量断崖判定的窗口量
    gmv_3d: round2(w3.gmv), gmv_prev7d: round2(wPrev7.gmv),
    shows_3d: round2(w3.shows), shows_prev7d: round2(wPrev7.shows),
    cost_14d: round2(w14.cost),
    gmv_7d: round2(w7.gmv),
    boost_cost_7d: round2(w7.boost_cost),
    first_cost_date: firstCostDate ? String(firstCostDate).slice(0, 10) : null,
    // 渠道构成（2026-07-30 乘方接入）：直播(mg=2) vs 商品卡/乘方(mg=1) 近7天消耗/净成交分列
    cost_live_7d: round2(w7.cost_live), cost_product_7d: round2(w7.cost_product),
    net_live_7d: round2(w7.net_live), net_product_7d: round2(w7.net_product),
    product_share_7d: w7.cost > 0 ? round4(w7.cost_product / w7.cost) : null,
    channel: w7.cost <= 0 ? null : (w7.cost_product <= 0 ? 'live' : (w7.cost_live <= 0 ? 'product' : 'mixed')),
  };
}

// ═══════════════════════════════════════════════════════════
// MHS 综合评分（§4.1 公式）
// ═══════════════════════════════════════════════════════════

/**
 * MHS = α·效益分 + β·趋势分 + γ·潜力分 − δ·年龄衰减
 * 未标定（系数/阈值缺失）→ { mhs: null, tier: null, calibrated: false, missing }
 * 档位：≥t_you 优质；t_qian≤x<t_you 且趋势上行 潜力；<t_lie 且趋势下行 劣质；其余 观察
  * 历史账户专用说明已从试用包移除。
 *   字面 <0 恒假（劣质档曾因此永不触发=死代码）；trend_center 默认 1，"负"=下行(分<1)、"正"=上行(分>1)。
 * @param {object} features - computeFeatures 产出
 * @param {object} params - getMhsParams 的 params
 */
function computeMhs(features, params) {
  const missing = CALIBRATION_KEYS.filter(k => typeof (params || {})[k] !== 'number');
  if (missing.length > 0) {
    return { mhs: null, tier: null, calibrated: false, missing };
  }
  const p = params;
  const b = features.benefit_score || 0;
  const t = features.trend_score || 0;
  const pot = features.potential_score || 0;
  const age = features.age_decay || 0;
  const mhs = round4(p.alpha * b + p.beta * t + p.gamma * pot - p.delta * age);

  let tier = '观察';
  const center = typeof p.trend_center === 'number' ? p.trend_center : 1;
  const trendPos = (features.trend_score || 0) > center;
  const trendNeg = (features.trend_score || 0) < center;
  if (mhs >= p.t_you) tier = '优质';
  else if (mhs >= p.t_qian && trendPos) tier = '潜力';
  else if (mhs < p.t_lie && trendNeg) tier = '劣质';

  // 历史账户专用说明已从试用包移除。
  const isStagnantHighQuality = (b >= 0.6 || (features.decay_weighted_roi && features.decay_weighted_roi >= 1.0)) && (features.cost_momentum !== null && features.cost_momentum < 0.4);

  return { mhs, tier, is_stagnant_high_quality: isStagnantHighQuality, calibrated: true, missing: [] };
}

/**
  * 历史账户专用说明已从试用包移除。
 * ④ 年龄前置：年龄 < lie_min_age_days(默认7) 天不判劣质（官方教义"7 日观测再下结论"）
 * ② 历史功劳豁免：全周期 ROI≥lie_exempt_min_roi(默认2.0) 且累计消耗≥lie_exempt_min_cost(默认500)
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *   （近7天净ROI < kill_roi 斩杀线）时豁免失效。不吃肥膘案例：全周期 2.43 好，但近7天 2.01、
  * 历史账户专用说明已从试用包移除。
 * @param {string} tier - computeMhs 判定档位
 * @param {object} ctx - { ageDays, totalCost, totalGmv(净成交口径), recent7dRoi(近7天净ROI, null=7天无消耗), params }
 * @returns {{tier:string, note:string|null}}
 */
function fixLieTier(tier, ctx) {
  if (tier !== '劣质') return { tier, note: null };
  const { ageDays, totalCost, totalGmv } = ctx || {};
  const p = (ctx && ctx.params) || {};
  const minAge = p.lie_min_age_days != null ? p.lie_min_age_days : 7;
  const exemptCost = p.lie_exempt_min_cost != null ? p.lie_exempt_min_cost : 500;
  const exemptRoi = p.lie_exempt_min_roi != null ? p.lie_exempt_min_roi : 2.0;
  if (ageDays != null && ageDays < minAge) {
    return { tier: '观察', note: `劣质档豁免：年龄 ${ageDays} 天 <${minAge} 天前置（V1.1-④）` };
  }
  const tc = +totalCost || 0, tg = +totalGmv || 0;
  const totalRoi = tc > 0 ? tg / tc : 0;
  if (tc >= exemptCost && totalRoi >= exemptRoi) {
    // 历史账户专用说明已从试用包移除。
    // 历史账户专用说明已从试用包移除。
    // （net_roi_7d=null 是 7 天无消耗不算烂穿，豁免保持；0=7天烧钱零成交，失效）
    const recentFactor = p.lie_exempt_recent_factor != null ? p.lie_exempt_recent_factor : 0.85;
    const be = +(ctx && ctx.breakEven) || 2.1;
    const recentLine = +(be * recentFactor).toFixed(2);
    const r7 = ctx && ctx.recent7dRoi;
    if (r7 != null && Number.isFinite(+r7) && +r7 < recentLine) {
      return { tier, note: `历史功劳豁免失效：全周期净 ROI ${totalRoi.toFixed(2)} 但近7天净ROI ${(+r7).toFixed(2)} < 保本×${recentFactor}（${recentLine}）（维护者 8-1：近期衰退确凿拉低大盘，该处理就处理）` };
    }
    return { tier: '观察', note: `历史功劳豁免：全周期净 ROI ${totalRoi.toFixed(2)} ≥${exemptRoi} 且累计消耗 ${tc.toFixed(0)} ≥${exemptCost}，劣质降观察/冷藏（V1.1-②）` };
  }
  return { tier, note: null };
}

// ═══════════════════════════════════════════════════════════
// 删除子模型（§5.1 三层止损：①急性衰退 ②慢性亏损 ③人工直通在调用方）
// ═══════════════════════════════════════════════════════════

/**
 * ① 急性衰退双闸门（纯函数）。
 *   闸门A（流量维度）：近3天日均消耗 < 前7天日均消耗 × decline_cost_ratio(0.4)
 *   闸门B（亏损维度）：基准日消耗 ≥ 斩杀线（客单价×2，调用方传入）且 基准日净ROI < kill_roi(1.05)
 *
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *   - 新增 3 道前置判杀锁：全周期/近期/波动模式（基于素材历史表现）
 *   - netROI 不可信降级：netOf=0 但 cost>0 时降级用支付ROI 判杀
 *   - 冲量窗口保护：扩展到 3-14 天
 *
 * @param {object[]} daily - aggregateDaily 逐日行
 * @param {object} opts - { endDate, killLine, params, breakEven, ageDays }
 * @returns {{triggered:boolean, gateA:object, gateB:object, fullCycleLock?:object, recentPerformanceLock?:object, volatilityLock?:object, netRoiDegraded?:object, surgeProtect?:object}}
 */
function judgeAcuteDecline(daily, opts) {
  const { endDate, killLine } = opts;
  const p = opts.params || {};
  const dp = p.delete_protection || {};
  const ratio = p.decline_cost_ratio != null ? p.decline_cost_ratio : 0.4;
  const killRoi = p.kill_roi != null ? p.kill_roi : 1.05;
  const breakEven = opts.breakEven || 2.0;
  const ageDays = opts.ageDays != null ? opts.ageDays : null;
  const avgOrder = opts.avgOrder || null;

  // V1.6 节令豁免（食品行业适配）：节令窗口+保护期内直接禁止判杀，优先级高于所有锁/闸门
  const seasonal = (opts.accountId && opts.materialName && endDate)
    ? seasonalExempt(opts.accountId, opts.materialName, endDate)
    : { exempt: false };
  if (seasonal.exempt) {
    return {
      triggered: false,
      gateA: { pass: false, why: '节令豁免生效，跳过闸门A' },
      gateB: { pass: false, why: '节令豁免生效，跳过闸门B' },
      seasonalExempt: seasonal,
      cpaOverride: null,
      fullCycleLock: null,
      recentPerformanceLock: null,
      volatilityLock: null,
      surgeProtect: null,
      netRoiDegraded: null,
    };
  }

  // V1.4 平台规则护栏（CPA 超30% → 绕过所有锁）
  const cpaGuard = cpaOverrideGuard(daily, endDate, breakEven, p, avgOrder);

  // V1.4 isBurning 计算（冲量窗口保护反条件用）
  const w7now = sumWindow(daily, endDate, 7);
  const roi7now = w7now.cost > 0 ? w7now.net / w7now.cost : null;
  const burningLine = breakEven * (dp.burning_factor != null ? dp.burning_factor : 0.5);
  const isBurning = roi7now != null && roi7now < burningLine;

  // 3 道前置判杀锁（v2 整改核心）：基于素材历史表现，任一触发即判救
  // V1.4：CPA 护栏触发时跳过所有锁；fullCycleLock 传 endDate 支持 isBurning 反条件
  const fLock = cpaGuard ? null : fullCycleLock(null, daily, breakEven, p, endDate);
  const w30now = sumWindow(daily, endDate, 30);
  const rLock = cpaGuard ? null : recentPerformanceLock({
    net_roi_7d: roi7now,
    net_roi_30d: w30now.cost > 0 ? w30now.net / w30now.cost : null,
    daily_7d: daily.filter(d => d.date >= shiftDate(endDate, -6) && d.date <= endDate),
  }, breakEven, p);
  const vLock = cpaGuard ? null : volatilityLock(daily, endDate, breakEven, p);
  if (!cpaGuard && (fLock || rLock || vLock)) {
    return {
      triggered: false,
      gateA: { pass: false, why: '前置判杀锁触发，跳过闸门A' },
      gateB: { pass: false, why: '前置判杀锁触发，跳过闸门B' },
      fullCycleLock: fLock,
      recentPerformanceLock: rLock,
      volatilityLock: vLock,
      cpaOverride: null,
      surgeProtect: null,
      netRoiDegraded: null,
      seasonalExempt: seasonal,
    };
  }

  const w3 = sumWindow(daily, endDate, 3);
  const wPrev7 = sumWindow(daily, shiftDate(endDate, -3), 7);
  const avg3 = w3.cost / 3, avgPrev7 = wPrev7.cost / 7;
  const gateAPass = avgPrev7 > 0 && avg3 < avgPrev7 * ratio;
  const gateA = {
    pass: gateAPass,
    last3_avg_cost: round2(avg3),
    prev7_avg_cost: round2(avgPrev7),
    threshold: round2(avgPrev7 * ratio),
    why: gateAPass
      ? `近3天日均消耗 ${round2(avg3)} < 前7天日均 ${round2(avgPrev7)}×${ratio}（${round2(avgPrev7 * ratio)}），流量断崖`
      : `近3天日均消耗 ${round2(avg3)} 未跌破前7天日均×${ratio}`,
  };

  const today = daily.find(d => d.date === endDate) || { cost: 0, net: 0, gmv: 0 };
  const todayRoi = today.cost > 0 ? today.net / today.cost : null;
  let gateBPass = today.cost >= killLine && todayRoi != null && todayRoi < killRoi;

  // netROI 不可信降级（v2 整改）：netOf=0 但 cost>0 时用支付ROI 判杀
  let netRoiDegraded = null;
  if (gateBPass && today.cost > 0 && today.net === 0 && today.gmv > 0) {
    const payRoi = payRoiOf(today);
    if (payRoi != null) {
      netRoiDegraded = { active: true, payRoi: round2(payRoi), why: `净ROI 数据缺失（net_gmv_1h=0），降级用支付ROI ${round2(payRoi)} 判杀` };
      gateBPass = payRoi < killRoi;
    }
  }

  // 冲量窗口保护（前置）：3-14 天素材净ROI ≥ 保本×0.4 → 闸门B 不通过
  let surgeProtect = null;
  if (gateBPass && !isBurning && surgeWindowProtect({ ageDays, netRoi: todayRoi, breakEven, params: p })) {
    const surgeLine = +(breakEven * (p.surge_protect_factor != null ? p.surge_protect_factor : 0.4)).toFixed(2);
    surgeProtect = { active: true, ageDays, netRoi: round2(todayRoi), surgeLine, why: `冲量窗口保护（发布${ageDays}天）：净ROI ${round2(todayRoi)} ≥ 保本×0.4（${surgeLine}），判救观察` };
    gateBPass = false;
  }

  const gateB = {
    pass: gateBPass,
    date: endDate,
    cost: round2(today.cost),
    net_roi: round2(todayRoi),
    kill_line: killLine,
    kill_roi: killRoi,
    why: gateBPass
      ? `${endDate} 消耗 ${round2(today.cost)} ≥ 斩杀线 ${killLine} 且净ROI ${round2(todayRoi)} < ${killRoi}，亏损确认`
      : `${endDate} 消耗 ${round2(today.cost)}/净ROI ${round2(todayRoi)} 未触斩杀线 ${killLine}+ROI<${killRoi}`,
  };

  return { triggered: gateAPass && gateBPass, gateA, gateB, fullCycleLock: fLock, recentPerformanceLock: rLock, volatilityLock: vLock, cpaOverride: cpaGuard, netRoiDegraded, surgeProtect, seasonalExempt: seasonal };
}

/**
 * 死缓复活判定（§5.1：触发后 T+1/T+2 任一日 消耗 ≥ 斩杀线 且 净ROI ≥ stay_revive_roi(1.5) → 撤销）。
 * 连续 2 日达线才算（2026-08-01 回测实锤：原"任一日达线"把烂素材单日波动误判复活撤销——
 * 与 postVerdict 回春线同源的"单日波动"问题；改"当日+前一日均达线"防波动，真复活（连续达标）不误杀）
 * @param {object[]} daily - aggregateDaily 逐日行
 * @param {object} opts - { endDate, killLine, params }
 * @returns {{revived:boolean, why:string, day:object|null}}
 */
function judgeStayRevive(daily, opts) {
  const { endDate, killLine } = opts;
  const p = opts.params || {};
  const reviveRoi = p.stay_revive_roi != null ? p.stay_revive_roi : 1.5;
  const day = daily.find(d => d.date === endDate);
  if (!day || day.cost <= 0) {
    return { revived: false, day: null, why: `${endDate} 无消耗，未复活` };
  }
  const roi = day.net / day.cost;
  const dayPass = day.cost >= killLine && roi >= reviveRoi;
  // 前一日也达线（连续 2 日）才算真复活
  let prevPass = false;
  if (dayPass) {
    const prevDay = daily.find(d => d.date === shiftDate(endDate, -1));
    if (prevDay && prevDay.cost > 0) {
      prevPass = prevDay.cost >= killLine && (prevDay.net / prevDay.cost) >= reviveRoi;
    }
  }
  const revived = dayPass && prevPass;
  return {
    revived,
    day: { date: endDate, cost: round2(day.cost), net_roi: round2(roi), prev_pass: prevPass },
    why: revived
      ? `${endDate} 消耗 ${round2(day.cost)} ≥ 斩杀线 ${killLine} 且净ROI ${round2(roi)} ≥ ${reviveRoi}，死缓撤销`
      : `${endDate} 消耗 ${round2(day.cost)}/净ROI ${round2(roi)} 未达复活线（≥${killLine} 且 ROI≥${reviveRoi}）`,
  };
}

/**
  * 历史账户专用说明已从试用包移除。
 *   轨道1（绝对斩杀）：cost_7d ≥ chronic_min_cost 且 net_roi_7d < 保本×0.5 → 直接判杀（保召回）
 *   轨道2（边缘确诊）：cost_7d ≥ chronic_min_cost 且 net_roi_7d ∈ [保本×0.5, 保本×0.85)
 *     → 需旁证任一：消耗动量（近3天日均<前7天×0.5）/ GPM骤降（近3天 GPM<前7天×0.6）/ 流量断崖（近3天曝光<前7天×0.4）
 *   与原单线的区别：单线（roi7<保本×factor 一刀切）在 0.5~0.85 边缘带误伤多；双轨在边缘带要"旁证确诊"才杀（保精确），
 *   极烂区（<0.5）不看旁证直接杀（保召回）。旁证缺数据时消耗动量（cost 100%覆盖）兜底。
 *
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 *   - 新增 3 道前置判杀锁：全周期/近期/波动模式（基于素材历史表现）
 *   - netROI 不可信降级：netOf=0 但 cost>0 时降级用支付ROI 判杀
 *   - 冲量窗口保护：扩展到 3-14 天
 *
 * @param {object} features - computeFeatures 产出（cost_7d/net_roi_7d/cost_3d/cost_prev7d/gmv_3d/gmv_prev7d/shows_3d/shows_prev7d/gmv_7d/age_days/daily 全周期）
 * @param {object} opts - { breakEven, params, daily, endDate }
 */
function judgeChronicLoss(features, opts) {
  const p = (opts && opts.params) || {};
  const dp = p.delete_protection || {};
  const minCost = p.chronic_min_cost != null ? p.chronic_min_cost : 100;
  const breakEven = (opts && opts.breakEven) || 2.0;
  const daily = opts && opts.daily;
  const endDate = opts && opts.endDate;
  const avgOrder = (opts && opts.avgOrder) || null;
  const killLine = +(breakEven * 0.5).toFixed(2);  // 轨道1线（绝对斩杀）
  const wideFactor = p.chronic_wide_factor != null ? p.chronic_wide_factor : 0.85;
  const wideLine = +(breakEven * wideFactor).toFixed(2);
  const roi7 = features.net_roi_7d;
  const cost7 = features.cost_7d || 0;
  const ageDays = features.age_days != null ? features.age_days : null;

  // V1.6 节令豁免（食品行业适配）：节令窗口+保护期内直接禁止判杀，优先级高于所有锁/双轨
  const seasonal = (opts && opts.accountId && opts.materialName && endDate)
    ? seasonalExempt(opts.accountId, opts.materialName, endDate)
    : { exempt: false };
  if (seasonal.exempt) {
    return {
      triggered: false,
      track: null,
      cost_7d: cost7,
      roi_7d: roi7,
      kill_line: killLine,
      wide_line: wideLine,
      min_cost: minCost,
      evidence: { track: null },
      seasonalExempt: seasonal,
      cpaOverride: null,
      fullCycleLock: null,
      recentPerformanceLock: null,
      volatilityLock: null,
      surgeProtect: null,
      netRoiDegraded: null,
      why: seasonal.why,
    };
  }

  // V1.4 平台规则护栏（CPA 超30% → 绕过所有锁）
  const cpaGuard = cpaOverrideGuard(daily, endDate, breakEven, p, avgOrder);

  // V1.4 isBurning 计算（冲量窗口保护反条件用）
  const burningLine = breakEven * (dp.burning_factor != null ? dp.burning_factor : 0.5);
  const isBurning = roi7 != null && roi7 < burningLine;

  // 3 道前置判杀锁（v2 整改核心）：基于素材历史表现，任一触发即判救
  // V1.4：CPA 护栏触发时跳过所有锁；fullCycleLock 传 endDate 支持 isBurning 反条件
  const fLock = cpaGuard ? null : fullCycleLock(features, daily, breakEven, p, endDate);
  const rLock = cpaGuard ? null : recentPerformanceLock(features, breakEven, p);
  const vLock = cpaGuard ? null : volatilityLock(daily, endDate, breakEven, p);
  if (!cpaGuard && (fLock || rLock || vLock)) {
    return {
      triggered: false,
      track: null,
      cost_7d: cost7,
      roi_7d: roi7,
      kill_line: killLine,
      wide_line: wideLine,
      min_cost: minCost,
      evidence: { track: null },
      fullCycleLock: fLock,
      recentPerformanceLock: rLock,
      volatilityLock: vLock,
      cpaOverride: null,
      surgeProtect: null,
      netRoiDegraded: null,
      seasonalExempt: seasonal,
      why: (fLock || rLock || vLock).why,
    };
  }

  // 冲量窗口保护（前置）：3-14 天素材净ROI ≥ 保本×0.4 → 不判杀
  // V1.4 反条件：近7天烂穿时冲量保护失效
  let surgeProtect = null;
  if (!isBurning && surgeWindowProtect({ ageDays, netRoi: roi7, breakEven, params: p })) {
    const surgeLine = +(breakEven * (p.surge_protect_factor != null ? p.surge_protect_factor : 0.4)).toFixed(2);
    surgeProtect = { active: true, ageDays, netRoi: round2(roi7), surgeLine, why: `冲量窗口保护（发布${ageDays}天）：近7天净ROI ${round2(roi7)} ≥ 保本×0.4（${surgeLine}），判救观察` };
    return {
      triggered: false,
      track: null,
      cost_7d: cost7,
      roi_7d: roi7,
      kill_line: killLine,
      wide_line: wideLine,
      min_cost: minCost,
      evidence: { track: null },
      surgeProtect,
      cpaOverride: cpaGuard,
      fullCycleLock: null,
      recentPerformanceLock: null,
      volatilityLock: null,
      netRoiDegraded: null,
      seasonalExempt: seasonal,
      why: surgeProtect.why,
    };
  }

  // 轨道1：绝对斩杀（ROI 极烂不看旁证）
  let track1 = cost7 >= minCost && roi7 != null && roi7 < killLine;

  // 轨道2：边缘确诊（ROI 在边缘带，需旁证）
  let track2 = false;
  const evidenceMin = p.chronic_evidence_min != null ? p.chronic_evidence_min : 1;
  const evidence = {
    track: null, ev_momentum: false, ev_gpm: false, ev_flow: false,
    ev_hook: false, ev_persuasion: false, ev_cpc: false, drop_amplifier: !!features.drop_amplifier,
  };
  if (!track1 && cost7 >= minCost && roi7 != null && roi7 >= killLine && roi7 < wideLine) {
    const prev7Daily = (features.cost_prev7d || 0) / 7;
    const momentum = prev7Daily > 0 ? ((features.cost_3d || 0) / 3) / prev7Daily : null;
    evidence.momentum = momentum != null ? round2(momentum) : null;
    evidence.ev_momentum = prev7Daily > 0 && momentum != null && momentum < 0.5;
    const gpm3 = (features.shows_3d || 0) > 0 ? (features.gmv_3d || 0) / features.shows_3d * 1000 : null;
    const gpmP7 = (features.shows_prev7d || 0) > 0 ? (features.gmv_prev7d || 0) / features.shows_prev7d * 1000 : null;
    evidence.gpm_3d = gpm3 != null ? round2(gpm3) : null;
    evidence.gpm_prev7d = gpmP7 != null ? round2(gpmP7) : null;
    evidence.ev_gpm = gpm3 != null && gpmP7 != null && gpmP7 > 0 && gpm3 < gpmP7 * 0.6;
    evidence.ev_flow = (features.shows_prev7d || 0) > 0 && ((features.shows_3d || 0) / 3) < ((features.shows_prev7d || 0) / 7) * 0.4;
    const funnelSignals = new Set(Array.isArray(features.funnel_signals) ? features.funnel_signals : []);
    evidence.ev_hook = funnelSignals.has('HOOK_WEAK');
    evidence.ev_persuasion = funnelSignals.has('PERSUASION_WEAK');
    evidence.ev_cpc = funnelSignals.has('CPC_HIGH');
    evidence.funnel_diagnosis = features.funnel_diagnosis || null;
    evidence.evidence_hits = (evidence.ev_momentum ? 1 : 0) + (evidence.ev_gpm ? 1 : 0) +
      (evidence.ev_flow ? 1 : 0) + (evidence.ev_hook ? 1 : 0) +
      (evidence.ev_persuasion ? 1 : 0) + (evidence.ev_cpc ? 1 : 0);
    track2 = evidence.evidence_hits >= evidenceMin;
    evidence.insufficient_data = !track2
      && momentum == null && gpm3 == null && gpmP7 == null && (features.shows_prev7d || 0) === 0;
  }

  let pass = track1 || track2;

  // netROI 不可信降级（v2 整改）：净ROI 不可信时用支付ROI 判杀
  let netRoiDegraded = null;
  if (pass && roi7 == null && cost7 > 0 && (features.gmv_7d || 0) > 0) {
    const payRoi7 = (features.gmv_7d || 0) / cost7;
    netRoiDegraded = { active: true, payRoi7: round2(payRoi7), why: `净ROI 数据缺失（net_gmv_1h 全 0），降级用支付ROI ${round2(payRoi7)} 判杀` };
    pass = payRoi7 < killLine;
  }

  return {
    triggered: pass,
    track: pass ? (track1 ? 'track1' : (track2 ? 'track2' : null)) : null,
    cost_7d: cost7,
    roi_7d: roi7,
    kill_line: killLine,
    wide_line: wideLine,
    min_cost: minCost,
    evidence,
    surgeProtect,
    cpaOverride: cpaGuard,
    fullCycleLock: fLock,
    recentPerformanceLock: rLock,
    volatilityLock: vLock,
    netRoiDegraded,
    seasonalExempt: seasonal,
    why: pass
      ? (track1
        ? `轨道1绝对斩杀：近7天净ROI ${roi7} < 保本×0.5（${killLine}）且消耗 ${cost7} ≥ ${minCost}`
        : `轨道2边缘确诊：近7天净ROI ${roi7} ∈ [${killLine}, ${wideLine}) 且旁证成立≥${evidenceMin}项（命中${evidence.evidence_hits}项：动量${evidence.momentum ?? '-'}${evidence.ev_momentum ? '↓' : ''}${evidence.ev_gpm ? ' GPM↓' : ''}${evidence.ev_flow ? ' 流量↓' : ''}）`)
      : (netRoiDegraded ? netRoiDegraded.why : (surgeProtect ? surgeProtect.why : `近7天净ROI ${roi7}/消耗 ${cost7} 未达双轨判杀线`)),
  };
}

// ═══════════════════════════════════════════════════════════
// 执行约束（§4.3）
// ═══════════════════════════════════════════════════════════

/**
 * 衰退过滤 + 账号止损线（纯函数部分；余额/熔断计数由调用方补齐后走 checkBoostGate）。
 * @param {object} features - computeFeatures 产出
 * @param {object} params
 * @returns {{declineBlocked:boolean, why:string}}
 */
function checkDeclineFilter(features, params) {
  const p = params || {};
  const ratio = p.decline_cost_ratio != null ? p.decline_cost_ratio : 0.4;
  // cost_momentum null（前7天零消耗=新生）不拦截
  const blocked = features.cost_momentum != null && features.cost_momentum < ratio;
  return {
    declineBlocked: blocked,
    why: blocked
      ? `衰退过滤：消耗动量 ${features.cost_momentum} < ${ratio}（近3天日均 < 前7天×40%），禁止自动追投`
      : '衰退过滤通过',
  };
}

/**
 * 追投总闸（§4.3 + §4.6）：综合衰退过滤/账号止损线/余额/熔断/额度，输出能否自动建追投。
 * @param {object} input - { features, accountNetRoi, balance, autoCreatedToday, autoNewToday, autoCostToday, nextBudget, todayNetRoi, isNewMaterial, params }
 * @returns {{allowed:boolean, reasons:string[]}}
 */
function checkBoostGate(input) {
  const p = input.params || {};
  const reasons = [];
  // 衰退过滤
  const decline = checkDeclineFilter(input.features || {}, p);
  if (decline.declineBlocked) reasons.push(decline.why);
  // 账号止损线：账号净ROI < account_stop_roi(1.05) 禁止一切自动追投
  const stopRoi = p.account_stop_roi != null ? p.account_stop_roi : 1.05;
  if (input.accountNetRoi == null) {
    // 2026-08-01 二轮审计 P1：原仅在 !=null 时判止损——数据缺失（未开播/取数失败）止损闸静默跳过等于裸奔。
    // 对齐"数据不可用不盲动"纪律：净ROI拿不到时保守拦截（追投建议在无盘面时不该出可执行项）。
    reasons.push('账号今日净ROI数据不可用（未开播或取数失败），保守拦截自动追投建议');
  } else if (input.accountNetRoi < stopRoi) {
    reasons.push(`账号止损线：账号净ROI ${input.accountNetRoi} < ${stopRoi}，禁止一切自动追投`);
  }
  // 余额 < account_stop_balance(800) 禁止一切自动追投
  const stopBalance = p.account_stop_balance != null ? p.account_stop_balance : 800;
  if (input.balance != null && input.balance < stopBalance) {
    reasons.push(`余额 ${input.balance} < ${stopBalance}，禁止一切自动追投`);
  }
  // 熔断：每账号每日自动建追投预算合计 ≤ boost_daily_budget_cap(1200)，其中新素材 ≤ boost_new_daily_cap(1) 条
  // 历史账户专用说明已从试用包移除。
  //   autoCostToday 为今日已建预算合计（提交时口径），nextBudget 为本次拟建预算，合计超线即拦）
  const budgetCap = p.boost_daily_budget_cap != null ? p.boost_daily_budget_cap : 1200;
  const nextBudget = input.nextBudget || 0;
  if ((input.autoCostToday || 0) + nextBudget > budgetCap) {
    reasons.push(`熔断：今日自动建追投预算合计 ${input.autoCostToday || 0} 元 + 拟建 ${nextBudget} 元 > 上限 ${budgetCap} 元`);
  }
  const newCap = p.boost_new_daily_cap != null ? p.boost_new_daily_cap : 1;
  if (input.isNewMaterial && (input.autoNewToday || 0) >= newCap) {
    reasons.push(`熔断：今日新素材自动建追投已达 ${input.autoNewToday}/${newCap} 条`);
  }
  // 熔断：当日自动建合计消耗 ≥ boost_stop_cost(500) 且综合净ROI < boost_stop_roi(1.5) → 当日停手
  const stopCost = p.boost_stop_cost != null ? p.boost_stop_cost : 500;
  const stopCostRoi = p.boost_stop_roi != null ? p.boost_stop_roi : 1.5;
  if ((input.autoCostToday || 0) >= stopCost && input.todayNetRoi != null && input.todayNetRoi < stopCostRoi) {
    reasons.push(`熔断：当日自动建合计消耗 ${input.autoCostToday} ≥ ${stopCost} 且综合净ROI ${input.todayNetRoi} < ${stopCostRoi}，当日停手复盘`);
  }
  return { allowed: reasons.length === 0, reasons };
}

// ═══════════════════════════════════════════════════════════
// 冷启动通道（§4.4）
// ═══════════════════════════════════════════════════════════

/**
 * 冷启动判定：上线 ≤ cold_max_days(2) 日的素材走独立通道。
 * 24~48h 定级（仅用潜力分组件）：转培养 / 止损候选 / 观察中。
 * @param {object[]} daily - aggregateDaily 逐日行
 * @param {object} ctx - { endDate, accountCtr7d, createdAt, params }
 * @returns {{isCold:boolean, verdict:string|null, why:string, signals:object}}
 */
function judgeColdStart(daily, ctx) {
  const p = (ctx && ctx.params) || {};
  const maxDays = p.cold_max_days != null ? p.cold_max_days : 2;
  const firstCostDate = (daily.find(d => d.cost > 0) || {}).date || (ctx && ctx.createdAt) || null;
  if (!firstCostDate) return { isCold: false, verdict: null, why: '无首耗日，非冷启动通道', signals: {} };
  const endDate = ctx.endDate;
  const ageDays = Math.max(0, Math.round((new Date(endDate + 'T00:00:00') - new Date(String(firstCostDate).slice(0, 10) + 'T00:00:00')) / 86400000));
  if (ageDays > maxDays) return { isCold: false, verdict: null, why: `上线 ${ageDays} 天 > ${maxDays} 天，并轨主公式`, signals: { age_days: ageDays } };

  // 定级信号（累计口径，冷启动窗口短）
  const total = sumWindow(daily, endDate, 3650);
  const netRoi = total.cost > 0 ? total.net / total.cost : null;
  const ctr = total.shows > 0 ? total.plays / total.shows : null;
  const promoteRoi = p.cold_promote_roi != null ? p.cold_promote_roi : 2.0;
  const promoteOrders = p.cold_promote_orders != null ? p.cold_promote_orders : 3;
  const ctrFactor = p.cold_promote_ctr_factor != null ? p.cold_promote_ctr_factor : 1.2;
  const killCost = p.cold_kill_cost != null ? p.cold_kill_cost : 100;

  const hitRoi = netRoi != null && netRoi >= promoteRoi;
  const hitOrders = total.orders >= promoteOrders;
  const hitCtr = ctr != null && ctx.accountCtr7d != null && ctx.accountCtr7d > 0 && ctr >= ctx.accountCtr7d * ctrFactor;
  const signals = {
    age_days: ageDays, cost: round2(total.cost), orders: total.orders,
    net_roi: round2(netRoi), ctr: round4(ctr), account_ctr: round4(ctx.accountCtr7d),
    hit_roi: hitRoi, hit_orders: hitOrders, hit_ctr: hitCtr,
  };

  if (hitRoi || hitOrders || hitCtr) {
    const hits = [hitRoi && `净ROI ${round2(netRoi)}≥${promoteRoi}`, hitOrders && `成交 ${total.orders}≥${promoteOrders}单`, hitCtr && `CTR ${round4(ctr)}≥账号均值×${ctrFactor}`].filter(Boolean).join('、');
    return { isCold: true, verdict: '转培养', why: `冷启动定级转培养：${hits}`, signals };
  }
  if (total.cost >= killCost && total.orders === 0) {
    return { isCold: true, verdict: '止损候选', why: `冷启动定级止损候选：消耗 ${round2(total.cost)} ≥ ${killCost} 且 0 成交，进入删除评估`, signals };
  }
  return { isCold: true, verdict: '观察中', why: `冷启动观察中（上线 ${ageDays} 天，累计消耗 ${round2(total.cost)}、${total.orders} 单）`, signals };
}

// ═══════════════════════════════════════════════════════════
// 追投额度通道分流（§4.6）
// ═══════════════════════════════════════════════════════════

// 建议用途优先级：优质放大 > 新素材测试（额度不足时按序取舍）
const PURPOSE_PRIORITY = ['优质放大', '新素材测试'];

/**
 * 通道选择（纯函数）：默认控成本；额度不足且对象为新素材测试 → 降级放量（不占额度）；
 * 其他情况额度不足 → 不可执行（禁止输出无法执行的建议）。
 * @param {object} input - { purpose, budget, quotaLeft, params }
 * @returns {{executable:boolean, channel:string|null, budget:number|null, duration_hours:number|null, warnings:string[], why:string}}
 */
function planBoostChannel(input) {
  const p = (input && input.params) || {};
  const purpose = (input && input.purpose) || '优质放大';
  const budget = (input && input.budget) || 0;
  const quotaLeft = input && input.quotaLeft;
  const warnings = [];
  const warnLine = p.quota_warn_line != null ? p.quota_warn_line : 300;
  const fallbackBudget = p.fallback_boost_budget != null ? p.fallback_boost_budget : 150;

  if (!PURPOSE_PRIORITY.includes(purpose)) {
    return { executable: false, channel: null, budget: null, duration_hours: null, warnings, why: `未知用途 ${purpose}（支持：${PURPOSE_PRIORITY.join('/')}）` };
  }
  if (quotaLeft == null) {
    // 额度数据不可用：不降级为"可执行"，保守标不可执行并告警（纪律：数据不可用不盲动）
    return { executable: false, channel: null, budget: null, duration_hours: null, warnings: ['追投额度数据不可用，保守起见不输出可执行建议'], why: 'quota_left 不可用' };
  }
  if (quotaLeft < warnLine) {
    warnings.push(`额度紧张预警：剩余额度 ${round2(quotaLeft)} < ${warnLine}`);
  }
  if (quotaLeft >= budget) {
    return { executable: true, channel: '控成本', budget, duration_hours: null, warnings, why: `额度充足（余 ${round2(quotaLeft)} ≥ 预算 ${budget}），控成本通道` };
  }
  if (purpose === '新素材测试') {
    return {
      executable: true, channel: '放量', budget: Math.min(budget, fallbackBudget), duration_hours: 24,
      warnings: warnings.concat([`额度不足（余 ${round2(quotaLeft)} < 预算 ${budget}），降级放量通道：预算 ≤${fallbackBudget}、时长 12~24h、不占额度`]),
      why: '额度不足，新素材测试降级放量通道',
    };
  }
  return { executable: false, channel: null, budget: null, duration_hours: null, warnings, why: `额度不足（余 ${round2(quotaLeft)} < 预算 ${budget}），${purpose} 不降级，建议等周一额度更新或释放存量任务` };
}

// ═══════════════════════════════════════════════════════════
// 账号级批量特征计算（IO 侧：夜任务与决策卡共用）
// ═══════════════════════════════════════════════════════════

/**
 * 可评估闸门（纯函数）：基准日无消耗 或 前7天日均消耗 < signalMinCost → 无有效信号。
 * 无此闸，全零/沉寂素材会被误判为劣质档。
 */
function hasEvalSignal(daily, end, signalMinCost) {
  const yRow = daily.find(d => d.date === end);
  if (!yRow || yRow.cost <= 0) return false;
  let prev7Cost = 0;
  for (let i = 7; i >= 1; i--) {
    const d = daily.find(x => x.date === shiftDate(end, -i));
    if (d) prev7Cost += d.cost;
  }
  return (prev7Cost / 7) >= signalMinCost;
}

/**
 * 计算某账号全部素材在基准日的特征快照（读 DB，纯计算共用 computeFeatures）。
 * @param {string} accountId
 * @param {string} [endDate] - 基准日（默认昨天）
 * @returns {Map<string, object>} material_id → 特征对象（含 mhs/tier 合并结果）
 */
function computeAccountFeatures(accountId, endDate) {
  const { getDB } = require('./db');
  const { yesterday, getLocalDateStr } = require('./utils');
  const { getAccountParams } = require('./api-helpers');
  const end = endDate || yesterday();
  const start14 = shiftDate(end, -13);
  const db = getDB();

  // 近14天全部行（覆盖 近3/前7/近7/近14 全部窗口；年龄/首耗日单独补查）
  const rows = db.prepare(`
    SELECT * FROM material_daily
    WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
    ORDER BY material_id, stat_date
  `).all(accountId, start14, end);
  // 首耗日/created_at/全周期累计：全历史补查（轻量聚合）
  // 历史账户专用说明已从试用包移除。
  // 2026-08-06 审计修复 P0-2：SQL 必须与 netOf 同口径（只读 net_gmv_1h，不回退 net_gmv 脏字段），
  // 此前 CASE WHEN 回退使豁免 ROI 虚高，净 1.78 的素材也能拿到 ≥2.0 豁免
  const firstRows = db.prepare(`
    SELECT material_id, MIN(CASE WHEN cost > 0 THEN stat_date END) AS first_cost_date, MAX(created_at) AS created_at,
           SUM(cost) AS total_cost, SUM(net_gmv_1h) AS total_net_gmv
    FROM material_daily WHERE account_id = ? AND material_id != '__EMPTY__' GROUP BY material_id
  `).all(accountId);
  const firstMap = new Map(firstRows.map(r => [r.material_id, r]));

  // 按素材分组聚合逐日
  const byMat = new Map();
  for (const r of rows) {
    if (!byMat.has(r.material_id)) byMat.set(r.material_id, []);
    byMat.get(r.material_id).push(r);
  }

  // 账号级上下文：近7天总消耗/总GMV/素材GMV列表/账号CTR
  const w7start = shiftDate(end, -6);
  let accountCost7d = 0, accountGmv7d = 0, accountPlays7d = 0, accountShows7d = 0;
  const gmvList = [];
  const matDaily = new Map();
  for (const [mid, mrows] of byMat) {
    const daily = aggregateDaily(mrows);
    matDaily.set(mid, daily);
    const w7 = sumWindow(daily, end, 7);
    accountCost7d += w7.cost;
    accountGmv7d += w7.gmv;
    accountPlays7d += w7.plays;
    accountShows7d += w7.shows;
    gmvList.push(w7.gmv);
  }
  const accountCtr7d = accountShows7d > 0 ? accountPlays7d / accountShows7d : null;

  const { params, calibrated, version } = getMhsParams(accountId);
  const breakEven = getAccountParams(accountId).break_even_roi;
  let stableFunnelMap = new Map();
  try {
    const { loadStableFunnelContext } = require('./materialFunnelStore');
    stableFunnelMap = loadStableFunnelContext(db, accountId, end, 7, params.material_funnel || {}).materials;
  } catch {
    // 旧库/局部测试表缺少新列时只降级漏斗，不影响财务特征计算。
  }

  // 前5秒留存：最近一次深度采集（material_insight.lose_rate_5s），缺失回退 rate3s
  const insightStmt = db.prepare(`
    SELECT lose_rate_5s FROM material_insight
    WHERE account_id = ? AND material_id = ? ORDER BY stat_date DESC LIMIT 1
  `);
  const rate3sStmt = db.prepare(`
    SELECT rate3s FROM material_daily
    WHERE account_id = ? AND material_id = ? AND rate3s > 0 ORDER BY stat_date DESC LIMIT 1
  `);

  const out = new Map();
  for (const [mid, daily] of matDaily) {
    const first = firstMap.get(mid) || {};
    let retention5s = null;
    try {
      const ir = insightStmt.get(accountId, mid);
      if (ir && ir.lose_rate_5s != null && ir.lose_rate_5s > 0) {
        retention5s = Math.max(0, 1 - asPercent(ir.lose_rate_5s) / 100);
      }
      if (retention5s == null) {
        const r3 = rate3sStmt.get(accountId, mid);
        if (r3 && r3.rate3s > 0) retention5s = asPercent(r3.rate3s) / 100;
      }
    } catch { /* 留存缺失不阻断 */ }

    const features = computeFeatures(daily, {
      endDate: end,
      accountCost7d, accountGmv7d, accountGmvList7d: gmvList, accountCtr7d,
      breakEven,
      retention5s,
      funnel: stableFunnelMap.get(String(mid)) || null,
      createdAt: first.created_at || first.first_cost_date || null,
      params,
    });
    // 首耗日用全历史补查修正（14 天窗口内可能没有首耗）
    if (first.first_cost_date) {
      features.first_cost_date = first.first_cost_date;
      features.age_days = Math.max(0, Math.round((new Date(end + 'T00:00:00') - new Date(first.first_cost_date + 'T00:00:00')) / 86400000));
    }
    const score = computeMhs(features, params);
    // 可评估闸门（与时序回测 §六 口径一致）：基准日无消耗 或 前7天日均消耗<20 → 无有效信号，不评分不评档。
    // 没有这道闸，全零特征的沉寂素材会满足 "mhs<t_lie 且趋势<1" 被误判劣质（2026-07-29 激活首日实测 96% 卡片全中劣质即此因）
    const signalMinCost = params.signal_min_cost != null ? params.signal_min_cost : 20;
    const hasSignal = hasEvalSignal(daily, end, signalMinCost);
    if (!hasSignal) {
      score.mhs = null;
      score.tier = null;
      score.no_signal = true;

      const fastMinCost = params.fast_track_min_cost != null ? params.fast_track_min_cost : 100;
      const fastRoiFactor = params.fast_track_roi_factor != null ? params.fast_track_roi_factor : 1.15;
      const fastRecentDays = params.fast_track_recent_days != null ? params.fast_track_recent_days : 3;
      const recentCost = (fastRecentDays === 3 ? features.cost_3d : features[`cost_${fastRecentDays}d`]) || 0;

      // 历史账户专用说明已从试用包移除。
      // 此前用全渠道聚合（cost_7d/net_roi_7d 含 mg=1 商品卡），纯商品卡素材直播零消耗也会触发——
      // 实证 2026-08-01 首批 3 条 fast_track 中 2 条为纯 mg=1（错配）。商品卡素材的发现归商品卡巡检轮，不进 fast_track。
      const liveCost7d = features.cost_live_7d || 0;
      const liveRoi7d = liveCost7d > 0 && features.net_live_7d != null ? round2(features.net_live_7d / liveCost7d) : null;

      if (
        liveCost7d >= fastMinCost &&
        liveRoi7d != null &&
        liveRoi7d >= breakEven * fastRoiFactor &&
        recentCost > 0
      ) {
        score.tier = '潜力';
        features.fast_track = true;
        features.tier_note = `信号闸快速通道：近7天直播耗${liveCost7d}元≥${fastMinCost} 且 直播净ROI ${liveRoi7d}≥保本×${fastRoiFactor} 且 近${fastRecentDays}天有消耗（2026-08-01 拍板：只发现不追投，observe透出盯盘轮人工复核——任务M实证自动追投维持率仅41.9%不上；2026-08-02 起直播口径）`;
      }
    }

    // 历史账户专用说明已从试用包移除。
    if (score.tier === '劣质') {
      const fix = fixLieTier(score.tier, { ageDays: features.age_days, totalCost: first.total_cost, totalGmv: first.total_net_gmv, recent7dRoi: features.net_roi_7d, breakEven, params });
      if (fix.tier !== score.tier) features.tier_orig = score.tier; // 2026-07-30 审计补：豁免降档留痕（与 applyTodaySignal 的 tier_orig 对称）
      score.tier = fix.tier;
      if (fix.note) features.tier_note = fix.note;
    }

    features.mhs = score.mhs;
    features.tier = score.tier;
    features.calibrated = score.calibrated;
    if (score.no_signal) features.no_signal = true;
    features.params_version = version;

    // 历史账户专用说明已从试用包移除。
    // 只作展示参考，严禁判杀/降级——盘中是 1h 结算口径，终值才可判（纪律硬约束，judgeAcuteDecline/judgeChronicLoss/冷启动定级均不读此段）。
    // 固定查"今天"（决策卡主体是 T+1 昨日口径，此段补今天实时情况；昨日盘中快照已被夜间 prune 或终值覆盖）
    try {
      const { getLatestSnapshots } = require('./intradayStore');
      const todayStr = getLocalDateStr();
      const snaps = getLatestSnapshots(accountId, todayStr);
      const snap = snaps.find(s => String(s.material_id) === String(mid));
      if (snap && (snap.cost > 0 || snap.net_gmv_1h > 0 || snap.orders > 0)) {
        features.intraday = {
          available: true,
          cost: round2(snap.cost),
          net_gmv_1h: round2(snap.net_gmv_1h),
          roi_1h: snap.cost > 0 ? round2(snap.net_gmv_1h / snap.cost) : null,
          orders: Math.round(snap.orders || 0),
          refund_rate: round4(snap.refund_rate),
          boost_cost: round2(snap.boost_cost),
          boost_settle_roi: round4(snap.boost_settle_roi),
          snapshot_time: snap.snapshot_time || null,
          note: '盘中1h口径，非终值，仅参考',
        };
      }
    } catch (e) {
      // 盘中库不可用不阻断评估
      console.log(`[mhs] intraday 参考段读取失败(静默): ${e.message}`);
    }
    features._daily = daily; // 调用方（删除子模型/冷启动）复用，不落库
    out.set(mid, features);
  }
  return { features: out, endDate: end, params, calibrated, version, account: { cost_7d: round2(accountCost7d), gmv_7d: round2(accountGmv7d), ctr_7d: round4(accountCtr7d), w7_start: w7start } };
}

// ═══════════════════════════════════════════════════════════
// 历史账户专用说明已从试用包移除。
// ═══════════════════════════════════════════════════════════
// 依据：节令食品（粽子/月饼/年货礼盒）节后需求断崖是正常市场现象，不是素材衰退。
//      节令窗口内及节后保护期内禁止判杀，避免把"节后清仓期"误判为素材死亡。
// 配置：config.seasonal_products.<account>.products[]（keywords 匹配素材名，festivals 定义窗口+保护期）
// 调用方：在 judgeAcuteDecline/judgeChronicLoss 之前调用，结果通过 opts.seasonalExempt 传入短路返回。
// 纯函数：不读 DB，只读 config.seasonal_products；调用方负责传 accountId/materialName/date。

/**
 * 节令型产品豁免判定
  * 历史账户专用说明已从试用包移除。
 * @param {string} materialName - 素材名（用于关键词匹配）
 * @param {string} date - 基准日 YYYY-MM-DD（判断是否在节令窗口+保护期内）
 * @returns {{exempt:boolean, product?:string, festival?:string, window?:string, why?:string}}
 *   exempt=true 表示命中节令豁免，禁止判杀
 */
function seasonalExempt(accountId, materialName, date) {
  if (!accountId || !materialName || !date) return { exempt: false };
  const config = require('./config');
  const sp = config.seasonal_products;
  if (!sp || typeof sp !== 'object') return { exempt: false };
  const accCfg = sp[accountId];
  if (!accCfg || accCfg.enabled !== true || !Array.isArray(accCfg.products)) return { exempt: false };

  for (const prod of accCfg.products) {
    if (!Array.isArray(prod.keywords) || prod.keywords.length === 0) continue;
    const hit = prod.keywords.some(kw => typeof kw === 'string' && kw.length > 0 && materialName.includes(kw));
    if (!hit) continue;
    // 命中该产品，再判断是否在任一节令窗口+保护期内
    for (const fest of (prod.festivals || [])) {
      const start = fest.start;
      const end = fest.end;
      const protectDays = fest.protect_days_after != null ? fest.protect_days_after : 0;
      if (!start || !end) continue;
      // 保护期截止日 = 节令 end + protectDays
      const protectEnd = shiftDate(end, protectDays);
      if (date >= start && date <= protectEnd) {
        return {
          exempt: true,
          product: prod.name,
          festival: fest.name || `${start}~${end}`,
          window: `${start} ~ ${end}（含节后保护 ${protectDays} 天，截止 ${protectEnd}）`,
          why: `节令豁免：素材名命中"${prod.name}"关键词，当前 ${date} 在节令窗口 ${start}~${end} + 保护期 ${protectDays} 天内（截止 ${protectEnd}），节后需求断崖属正常市场现象，禁止判杀`,
        };
      }
    }
  }
  return { exempt: false };
}

// ═══════════════════════════════════════════════════════════
// MHS 2.0 动态素材健康分与五级动作矩阵（2026-08-21 架构升级）
// ═══════════════════════════════════════════════════════════

/**
 * 计算 MHS 2.0 动态健康分
 * @param {object} mat - 素材数据（含累计与实时指标）
 * @param {object} ctx - 实时上下文（包含时段slot、边际差分、保本线等）
 * @returns {object} { mhs: number, tier: string, action: string, explanation: object }
 */
function computeMhsV2(mat, ctx = {}) {
  const p = ctx.params || {};
  const finite = (v, fallback) => Number.isFinite(+v) ? +v : fallback;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const round = (v, n = 2) => Number.isFinite(v) ? +v.toFixed(n) : null;

  const breakEven = finite(ctx.breakEven, 3.0);
  const profitRoi = finite(ctx.profitRoi, breakEven + 0.2);
  const floorRoi = finite(ctx.floorRoi, Math.max(0, breakEven - 0.2));
  const roiSpan = Math.max(profitRoi - breakEven, 0.01);
  const smallSpendThreshold = finite(p.small_spend_threshold, 100);
  const mainScaleMinCost = finite(p.main_scale_min_cost, 100);
  const pauseMinCost = finite(p.pause_min_cost, 100);
  const minActionConfidence = finite(p.min_action_confidence, 0.60);
  const mainScoreLine = finite(p.main_score, 75);
  const potentialScoreLine = finite(p.potential_score, 60);
  const pauseScoreLine = finite(p.pause_score, 35);

  const cost = finite(mat.cost != null ? mat.cost : mat.spend, 0);
  const orders = finite(mat.orders, 0);
  // 净口径铁律：只接受明确的 1h 结算字段或调用方声明的 canonical netGmv。
  // 严禁回退 net_gmv（历史标脏）或 gmv（支付口径）。
  const hasNet1h = mat.net_gmv_1h != null || mat.netGmv1h != null;
  const hasCanonicalNet = mat.netGmv != null;
  const netDataValid = ctx.netDataValid != null
    ? !!ctx.netDataValid
    : (mat.net_data_valid != null ? !!mat.net_data_valid : false);
  const netGmv = hasNet1h
    ? finite(mat.net_gmv_1h != null ? mat.net_gmv_1h : mat.netGmv1h, 0)
    : (hasCanonicalNet ? finite(mat.netGmv, 0) : 0);
  const netRoi = netDataValid && cost > 0 ? netGmv / cost : null;

  const status = String(mat.status == null ? '' : mat.status);
  const activeStatuses = new Set(['', '1', '投放中', 'active', 'learning']);
  const isActive = ctx.isActive != null ? !!ctx.isActive : activeStatuses.has(status);
  const stale = ctx.stale === true;
  const funnel = ctx.funnel && typeof ctx.funnel === 'object' ? ctx.funnel : null;
  const funnelFailureHits = funnel && Number.isFinite(+funnel.failure_hits) ? +funnel.failure_hits : 0;
  const funnelUsable = !!(funnel && !['insufficient', 'unavailable'].includes(funnel.data_quality));
  const funnelPenalty = funnelUsable
    ? Math.max(0.55, 1 - 0.12 * Math.min(funnelFailureHits, 3) - (funnel.drop_amplifier ? 0.08 : 0))
    : 1;

  // 1. 基础质量分 Q_i。转化率缺失时用中性分，不伪装成实测基准。
  let baseQualityScore = null;
  if (netDataValid && netRoi != null) {
    const fRoi = clamp((netRoi - breakEven) / roiSpan, -1, 2);
    const fCost = 1 - Math.exp(-cost / 50.0);
    const fOrders = 1 - Math.exp(-orders / 3.0);
    const hasWtp = mat.wtp != null || mat.watch_to_pay != null;
    const hasCtp = mat.ctp != null || mat.click_to_pay != null;
    let convComponent = 0.5; // 未提供素材级转化数据时保持中性
    if (hasWtp || hasCtp) {
      const wtp = finite(mat.wtp != null ? mat.wtp : mat.watch_to_pay, 0);
      const ctp = finite(mat.ctp != null ? mat.ctp : mat.click_to_pay, 0);
      const parts = [];
      if (hasWtp) parts.push(wtp / 0.035);
      if (hasCtp) parts.push(ctp / 0.08);
      convComponent = clamp(parts.reduce((a, b) => a + b, 0) / parts.length / 2, 0, 1);
    }
    baseQualityScore = clamp(100 * (
      0.40 * (fRoi + 1) / 2 +
      0.20 * fCost +
      0.25 * fOrders +
      0.15 * convComponent
    ), 0, 100);
  }

  // 2. 真边际窗口：优先 5m/15m/60m 差分。兼容纯函数测试传入单个 5m 差分，
  // 但生产调用严禁再用累计值×系数伪造。
  const windowWeights = { 5: 0.50, 15: 0.30, 60: 0.20 };
  const inputWindows = ctx.marginalWindows || mat.marginal_windows || {};
  const windows = [];
  for (const minutes of [5, 15, 60]) {
    const w = inputWindows[`m${minutes}`] || inputWindows[minutes];
    if (!w || w.stale || w.net_data_valid === false || ['stale', 'unavailable', 'conflicted', 'backfilled'].includes(w.data_quality)) continue;
    const deltaSpend = finite(w.delta_spend, NaN);
    const deltaNet = finite(w.delta_net_gmv, NaN);
    const actualMinutes = finite(w.actual_window_minutes || w.window_minutes, minutes);
    if (!(deltaSpend >= 0) || !Number.isFinite(deltaNet) || actualMinutes <= 0) continue;
    const roi = deltaSpend > 0 ? deltaNet / deltaSpend : null;
    windows.push({
      minutes,
      deltaSpend,
      deltaNet,
      deltaOrders: finite(w.delta_orders, 0),
      actualMinutes,
      roi,
      flow: deltaSpend * 60 / actualMinutes,
      weight: windowWeights[minutes],
      dataQuality: w.data_quality || 'complete',
    });
  }
  // 不再兼容 marginalCost/marginalGmv 这类无来源裸值；历史版本曾在生产端
  // 用“累计值 × 0.1”伪造它们。MHS 2.1 只接受带窗口和质量标记的真实差分。

  let marginalScore = null;
  if (windows.length) {
    let scoreSum = 0, weightSum = 0;
    for (const w of windows) {
      const roiForScore = w.roi == null ? 0 : w.roi;
      const fMarginalRoi = clamp((roiForScore - breakEven) / roiSpan, -1, 2);
      const fMarginalOrders = w.deltaOrders >= 2 ? 1 : (w.deltaOrders >= 1 ? 0.6 : 0);
      const fMarginalFlow = clamp(w.flow / 100, 0, 1);
      const s = clamp(100 * (0.55 * (fMarginalRoi + 1) / 2 + 0.25 * fMarginalOrders + 0.20 * fMarginalFlow), 0, 100);
      scoreSum += s * w.weight;
      weightSum += w.weight;
    }
    marginalScore = weightSum > 0 ? scoreSum / weightSum : null;
  }
  const primaryWindow = windows.find(w => w.minutes === 5) || windows[0] || null;
  const marginalRoi = primaryWindow ? primaryWindow.roi : null;
  const marginalCost = primaryWindow ? primaryWindow.deltaSpend : 0;
  const marginalFlow = primaryWindow ? primaryWindow.flow : 0;

  // 3. 泊松小耗出单增益项 P_i (0 ~ 30)，仅净口径有效时计算。
  let smallSpendGain = 0;
  if (netDataValid && netRoi != null && cost > 0 && cost < smallSpendThreshold && orders >= 1) {
    const gamma = finite(p.poisson_gamma, 14.0);
    const c0 = finite(p.poisson_cost_center, 50.0);
    const roiFactor = clamp(netRoi / breakEven, 0, 2);
    const sampleConfidence = 1 - Math.exp(-cost / 20.0);
    smallSpendGain = gamma * Math.log(1 + orders) * Math.sqrt(c0 / (cost + 1)) * roiFactor * sampleConfidence;
  }

  // 4. Slot 只有服务端提供“已验证素材时段因子”时才生效；用户传 slot 名称不再统一提权。
  const slotVerified = ctx.slotDataQuality === 'complete' && Number.isFinite(+ctx.slotFactor);
  const slotFactor = slotVerified ? clamp(+ctx.slotFactor, 0.65, 1.35) : 1.0;

  // 5. 动态衰退只使用真实边际窗口。
  const consecutiveLow = finite(ctx.consecutiveLow != null ? ctx.consecutiveLow : mat.consecutive_low_rounds, 0);
  let decayFactor = 1.0;
  if (primaryWindow && (consecutiveLow >= 2 || (marginalCost > 20 && marginalRoi != null && marginalRoi < 1.5))) {
    decayFactor = Math.max(1.0 - 0.15 * Math.min(consecutiveLow, 3) - 0.10 * (marginalRoi != null && marginalRoi < 1.0 ? 1 : 0), 0.5);
  }

  const isNew = cost < smallSpendThreshold && orders <= 2;
  const wQ = isNew ? 0.25 : 0.50;
  const wM = isNew ? 0.45 : 0.35;
  const wP = isNew ? 0.30 : 0.15;
  let scoreNumerator = 0, scoreDenominator = 0;
  if (baseQualityScore != null) { scoreNumerator += wQ * baseQualityScore; scoreDenominator += wQ; }
  if (marginalScore != null) { scoreNumerator += wM * marginalScore; scoreDenominator += wM; }
  // 将 0~30 的泊松增益归一到 0~100 后再参与权重，量纲一致。
  scoreNumerator += wP * clamp(smallSpendGain / 30 * 100, 0, 100);
  scoreDenominator += wP;
  // 净成交口径无效时整分置空：即便边际窗口存在，也不得把支付口径污染的累计底座
  // 与真实边际混合成一个看似可信的 MHS。
  const rawMhs = netDataValid && scoreDenominator > 0
    ? scoreNumerator / scoreDenominator * slotFactor * decayFactor * funnelPenalty
    : null;
  const mhs = rawMhs == null ? null : clamp(Math.round(rawMhs * 10) / 10, 0, 100);

  // 6. 数据质量与置信度。低置信只排序，不给写操作方向。
  const marginalCoverage = windows.reduce((s, w) =>
    s + w.weight * (w.dataQuality === 'complete' ? 1 : 0.5), 0);
  let confidence = (netDataValid ? 0.35 : 0)
    + 0.25 * (1 - Math.exp(-Math.max(cost, 0) / 50))
    + 0.30 * clamp(marginalCoverage, 0, 1)
    + 0.10 * clamp(orders / 3, 0, 1);
  if (stale) confidence *= 0.2;
  if (!isActive) confidence *= 0.5;
  confidence = clamp(confidence, 0, 1);

  let dataQuality = 'insufficient';
  if (stale) dataQuality = 'stale';
  else if (!netDataValid) dataQuality = 'unavailable';
  else if (windows.length >= 3 && windows.every(w => w.dataQuality === 'complete')) dataQuality = 'complete';
  else if (windows.length > 0) dataQuality = 'partial';

  const rank = finite(ctx.rank, 9999);
  // 官方保护的是头部 GMV 贡献，不是“按消耗排序前10”。头部只禁止贸然删除，
  // 当实时财务与稳定内容漏斗同时恶化时，仍可给出可逆 PAUSE 建议。
  const headProtected = ctx.headGmvProtected === true;
  const strongFunnelFailure = funnelUsable && funnelFailureHits >= 2;
  const initialTrial = cost < smallSpendThreshold && orders === 0;
  // 动作必须有 5m/15m 的完整、正消耗真差分；仅有 60m、跨休播大间隔或零消耗回填
  // 只允许评分/排序，不能据此给追投或暂停方向。
  const completeShortEvidence = windows.filter(w =>
    w.minutes <= 15 && w.dataQuality === 'complete' && w.deltaSpend > 0);
  const hasFreshShortEvidence = completeShortEvidence.length > 0;
  const pauseEvidence = [5, 15].every(minutes => {
    const w = completeShortEvidence.find(x => x.minutes === minutes);
    return w && w.roi != null && w.roi < breakEven * 0.6;
  });
  const actionable = netDataValid && isActive && !stale && hasFreshShortEvidence && confidence >= minActionConfidence;
  const reasonCodes = [];
  if (!netDataValid) reasonCodes.push('NET_DATA_UNAVAILABLE');
  if (!isActive) reasonCodes.push('INACTIVE_MATERIAL');
  if (stale) reasonCodes.push('STALE_DATA');
  if (!windows.length) reasonCodes.push('NO_REAL_MARGINAL');
  else if (!hasFreshShortEvidence) reasonCodes.push('NO_FRESH_SHORT_WINDOW');
  if (confidence < minActionConfidence) reasonCodes.push('LOW_CONFIDENCE');
  if (initialTrial) reasonCodes.push('INITIAL_TRIAL_PROTECTED');
  if (headProtected) reasonCodes.push('HEAD_GMV_PROTECTED');
  if (strongFunnelFailure) reasonCodes.push('MULTI_DIMENSION_FAILURE');

  let tier = netDataValid ? '观察' : '未知';
  let recommendedAction = 'OBSERVE';
  if (actionable && mhs >= mainScoreLine && netRoi >= floorRoi && cost >= mainScaleMinCost) {
    tier = '优质';
    recommendedAction = 'MAIN_PLAN_SCALE';
  } else if (actionable && (mhs >= potentialScoreLine || smallSpendGain >= 8) && cost < 120 && orders >= 1 && netRoi >= floorRoi) {
    tier = '潜力';
    recommendedAction = 'SINGLE_BOOST';
  } else if (actionable && slotVerified && slotFactor >= 1.15 && netRoi >= floorRoi * 0.9) {
    tier = '时段强';
    recommendedAction = 'SLOT_WAKE';
  } else if (
    actionable && (!headProtected || strongFunnelFailure) && !initialTrial && cost >= pauseMinCost &&
    consecutiveLow >= 2 && pauseEvidence && marginalCost > 20 && marginalRoi != null &&
    marginalRoi < breakEven * 0.6 && mhs < pauseScoreLine
  ) {
    tier = '劣质';
    recommendedAction = 'PAUSE';
    if (headProtected) reasonCodes.push('HEAD_GMV_REVERSIBLE_PAUSE_ONLY');
  } else if (
    netDataValid && isActive && !stale && !initialTrial && funnelUsable &&
    funnelFailureHits >= 1 && cost >= Math.min(pauseMinCost, 50) && netRoi != null && netRoi < breakEven
  ) {
    // 内容问题明确但尚未满足暂停闸门时，输出重剪/换素材建议；这不是投放写动作。
    tier = '内容待修';
    recommendedAction = 'REEDIT';
  }

  return {
    mhs,
    tier,
    recommended_action: recommendedAction,
    actionable: recommendedAction !== 'OBSERVE',
    confidence: round(confidence, 3),
    data_quality: dataQuality,
    reason_codes: reasonCodes,
    explanation: {
      base_quality_score: round(baseQualityScore, 1),
      marginal_score: round(marginalScore, 1),
      small_spend_gain: round(smallSpendGain, 1),
      slot_factor: round(slotFactor, 2),
      slot_verified: slotVerified,
      decay_factor: round(decayFactor, 2),
      funnel_penalty: round(funnelPenalty, 2),
      funnel_diagnosis: funnel ? funnel.diagnosis : null,
      funnel_failure_hits: funnelFailureHits,
      net_roi: round(netRoi, 2),
      marginal_roi: round(marginalRoi, 2),
      marginal_flow_hour: round(marginalFlow, 2),
      marginal_windows: windows.map(w => ({
        minutes: w.minutes,
        delta_spend: round(w.deltaSpend, 2),
        delta_net_gmv: round(w.deltaNet, 2),
        delta_orders: w.deltaOrders,
        roi: round(w.roi, 2),
        flow_hour: round(w.flow, 2),
        data_quality: w.dataQuality,
      })),
    }
  };
}

module.exports = {
  CALIBRATION_KEYS,
  PURPOSE_PRIORITY,
  getMhsParams,
  validateMhsParams,
  loadVersions,
  getActiveVersion,
  netOf,
  aggregateDaily,
  shiftDate,
  sumWindow,
  computeFeatures,
  computeMhs,
  computeMhsV2,
  fixLieTier,
  judgeAcuteDecline,
  judgeStayRevive,
  judgeChronicLoss,
  checkDeclineFilter,
  checkBoostGate,
  judgeColdStart,
  planBoostChannel,
  computeAccountFeatures,
  seasonalExempt,
  _test: { round2, round4, hasEvalSignal },
};
