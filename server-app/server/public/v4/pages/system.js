/* ===== 千川投控 v4 · 系统记录（操作记录 / 老板评审 / 回填监控 / 账号状态） ===== */
(function (V4) {
  'use strict';
  const { $, esc, fmtM, odo } = V4;

  const HTML = `
  <style>
  /* ===== 子 tab：细线下划线 ===== */
  .pg-sys-tabs { display:flex; gap:26px; border-bottom:1px solid var(--line); overflow-x:auto; }
  .pg-sys-tabs button { border:0; background:transparent; color:var(--ink-3); font-size:13px; font-weight:600;
    padding:10px 2px 12px; cursor:pointer; position:relative; transition:color .2s; letter-spacing:.02em;
    white-space:nowrap; flex-shrink:0; font-family:inherit; }
  .pg-sys-tabs button:hover { color:var(--ink-2); }
  .pg-sys-tabs button.on { color:var(--ink); }
  .pg-sys-tabs button.on::after { content:''; position:absolute; left:0; right:0; bottom:-1px; height:2px;
    background:var(--steel); border-radius:1px; }
  .pg-sys-tabs button .n { font-family:var(--mono); font-size:10.5px; color:var(--ink-3); margin-left:6px; }
  .pg-sys-panel { display:none; margin-top:24px; }
  .pg-sys-panel.on { display:block; }
  .pg-sys-intro { display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:18px; }
  .pg-sys-intro h1 { margin:0 0 6px;font-size:24px; }.pg-sys-intro p { margin:0;color:var(--ink-3);font-size:12.5px;line-height:1.7; }
  .pg-sys-feature { padding:9px 12px;border:1px solid var(--line);border-radius:var(--r);font-size:11px;color:var(--ink-2);white-space:nowrap; }
  .pg-sys-health { display:grid;grid-template-columns:repeat(4,1fr);gap:12px; }
  .pg-sys-health-card { border:1px solid var(--line);border-radius:var(--r);padding:14px 15px;background:var(--panel);min-width:0; }
  .pg-sys-health-card .l { font-size:10px;color:var(--ink-3);letter-spacing:.1em; }.pg-sys-health-card .v { margin-top:7px;font-size:15px;font-weight:700;color:var(--ink); }
  .pg-sys-health-card .v.good { color:var(--good); }.pg-sys-health-card .v.warn { color:var(--st-warn); }.pg-sys-health-card .v.bad { color:var(--danger); }
  .pg-sys-health-card .s { margin-top:5px;font-size:10.5px;color:var(--ink-3);line-height:1.55;overflow-wrap:anywhere; }

  /* ===== 操作记录：时间线表格 ===== */
  .pg-sys-op-head, .pg-sys-op-row { display:grid; grid-template-columns: 132px 88px 62px 68px 1fr; gap:14px; align-items:start; }
  .pg-sys-op-head { padding:0 0 10px; font-size:10px; letter-spacing:.14em; color:var(--ink-3); }
  .pg-sys-op-row { padding:12px 0 11px; border-top:1px solid var(--line); font-size:12.5px; }
  .pg-sys-op-row .t { font-family:var(--mono); font-size:11.5px; color:var(--ink-3); padding-top:1px; }
  .pg-sys-op-row .k { color:var(--ink); font-weight:600; min-width:0; overflow-wrap:anywhere; }
  .pg-sys-op-row .o { font-size:11.5px; color:var(--ink-2); }
  .pg-sys-op-row .r { display:flex; align-items:center; gap:7px; font-size:11.5px; }
  .pg-sys-op-row .r i { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
  .pg-sys-op-row .r.ok { color:var(--ink-2); }
  .pg-sys-op-row .r.ok i { background:var(--good); }
  .pg-sys-op-row .r.fail { color:var(--danger); }
  .pg-sys-op-row .r.fail i { background:var(--danger); box-shadow:0 0 7px var(--danger); }
  .pg-sys-op-row .d { color:var(--ink-2); line-height:1.7; min-width:0; word-break:break-all; }
  .pg-sys-op-row .d .mline { margin-top:2px; }
  .pg-sys-op-row .d .mline:first-child { margin-top:0; }
  .pg-sys-op-row .d .mline b { color:var(--ink); font-weight:600; }
  .pg-sys-op-row .d .mline code { font-family:var(--mono); font-size:10.5px; color:var(--ink-3); margin-left:7px; }
  .pg-sys-op-row .d .failmsg { color:var(--danger); font-size:11.5px; margin-top:3px; }
  .pg-sys-op-row.fresh .k, .pg-sys-op-row.fresh .t { color:var(--ink); }

  /* ===== 回填监控：进度条 + 日志流 ===== */
  .pg-sys-fill-grid { display:grid; grid-template-columns: 1fr 1.25fr; gap:34px; align-items:start; }
  .pg-sys-fill-item { padding:14px 0 13px; border-top:1px solid var(--line); }
  .pg-sys-fill-item:first-child { border-top:0; padding-top:4px; }
  .pg-sys-fill-top { display:flex; justify-content:space-between; align-items:baseline; font-size:12.5px; color:var(--ink-2); gap:10px; }
  .pg-sys-fill-top b { font-family:var(--mono); color:var(--ink); font-weight:650; font-size:14px; white-space:nowrap; }
  .pg-sys-fill-top .st { font-size:10.5px; color:var(--ink-3); margin-left:10px; letter-spacing:.08em; white-space:nowrap; }
  .pg-sys-fill-sub { font-size:11px; color:var(--ink-3); font-family:var(--mono); }
  .pg-sys-logbox { background:var(--panel); border:1px solid var(--line); border-radius:var(--r); padding:14px 16px;
    height:338px; overflow-y:auto; position:relative; scrollbar-width:thin; scrollbar-color:var(--ink-3) transparent; }
  .pg-sys-logbox::after { content:''; position:absolute; left:0; right:0; top:0; height:44px;
    background:linear-gradient(var(--panel), transparent); pointer-events:none; }
  .pg-sys-log { font-family:var(--mono); font-size:11.5px; line-height:2.05; color:var(--ink-3);
    white-space:pre-wrap; word-break:break-all; }
  .pg-sys-log b { color:var(--ink-2); font-weight:500; }
  .pg-sys-log.fresh { color:var(--ink-2); }

  /* ===== 账号状态 ===== */
  .pg-sys-acct-grid { display:grid; grid-template-columns:1fr 1fr; gap:26px; }
  .pg-sys-acct.bad { border-color:rgba(248,113,113,.45); }
  .pg-sys-acct-name { font-size:15px; font-weight:700; display:flex; align-items:center; gap:10px; }
  .pg-sys-st { font-size:10.5px; font-weight:600; padding:2px 9px; border-radius:4px; letter-spacing:.06em; white-space:nowrap; }
  .pg-sys-st.good { background:rgba(52,211,153,.1); color:var(--good); }
  .pg-sys-st.danger { background:rgba(248,113,113,.12); color:var(--danger); }
  .pg-sys-ck { display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin-top:12px;
    font-size:11.5px; color:var(--ink-3); }
  .pg-sys-ck b { font-family:var(--mono); color:var(--ink-2); font-weight:500; white-space:nowrap; }

  @media (max-width:1100px) {
    .pg-sys-fill-grid, .pg-sys-acct-grid { grid-template-columns:1fr; }
    .pg-sys-health { grid-template-columns:1fr 1fr; }
  }
  @media (max-width:640px) {
    .pg-sys-tabs { gap:18px; }
    /* 操作时间线改卡片式：表头隐藏，每行自含字段 */
    .pg-sys-op-head { display:none; }
    .pg-sys-op-row { grid-template-columns:1fr auto auto; gap:3px 10px; }
    .pg-sys-op-row .k { order:1; }
    .pg-sys-op-row .r { order:2; }
    .pg-sys-op-row .o { order:3; }
    .pg-sys-op-row .t { order:4; grid-column:1 / -1; }
    .pg-sys-op-row .d { order:5; grid-column:1 / -1; }
    .pg-sys-fill-grid, .pg-sys-acct-grid { grid-template-columns:1fr; }
    .pg-sys-health { grid-template-columns:1fr; }.pg-sys-intro{display:block}.pg-sys-feature{margin-top:10px;white-space:normal}
    .pg-sys-logbox { height:260px; }
  }
  </style>

  <section class="pg-sys-intro"><div><h1>设置与数据健康</h1><p>这里管理账户能力、数据链状态和系统维护；投放决策与动作溯源请到“决策记录”。</p></div><div class="pg-sys-feature" id="pgSysFeature"></div></section>
  <nav class="pg-sys-tabs" id="pgSysTabs" role="tablist" aria-label="设置分类">
    <button data-p="health" class="on" role="tab" aria-selected="true" aria-controls="pgSysP-health" id="pgSysT-health">数据可信度</button>
    <button data-p="acct" role="tab" aria-selected="false" aria-controls="pgSysP-acct" id="pgSysT-acct">账号与能力<span class="n" id="pgSysN-acct"></span></button>
    <button data-p="ops" role="tab" aria-selected="false" aria-controls="pgSysP-ops" id="pgSysT-ops">操作审计<span class="n" id="pgSysN-ops"></span></button>
    <button data-p="fill" role="tab" aria-selected="false" aria-controls="pgSysP-fill" id="pgSysT-fill">数据维护<span class="n" id="pgSysN-fill"></span></button>
  </nav>

  <section class="pg-sys-panel on" id="pgSysP-health" role="tabpanel" aria-labelledby="pgSysT-health">
    <div class="sec-title">当前数据链 <span class="cd" id="pgSysHealthAt">读取中…</span></div>
    <div class="pg-sys-health" id="pgSysHealth">${V4.emptyBox('正在读取分层健康状态…')}</div>
  </section>

  <section class="pg-sys-panel" id="pgSysP-ops" role="tabpanel" aria-labelledby="pgSysT-ops">
    <div class="sec-title">操作时间线 <span class="cd" id="pgSysOpsAcct"></span></div>
    <div class="pg-sys-op-head"><span>时间</span><span>操作类型</span><span>结果</span><span>操作人</span><span>详情</span></div>
    <div id="pgSysOpList">${V4.emptyBox('加载中…')}</div>
  </section>

  <section class="pg-sys-panel" id="pgSysP-fill" role="tabpanel" aria-labelledby="pgSysT-fill">
    <div class="sec-title">数据回填 <span class="cd">全部账号</span></div>
    <div class="pg-sys-fill-grid">
      <div id="pgSysFillList">${V4.emptyBox('加载中…')}</div>
      <div class="pg-sys-logbox" id="pgSysLogbox"></div>
    </div>
  </section>

  <section class="pg-sys-panel" id="pgSysP-acct" role="tabpanel" aria-labelledby="pgSysT-acct">
    <div class="sec-title">账号健康 <span class="cd">全部账号</span></div>
    <div class="pg-sys-acct-grid" id="pgSysAcctGrid">${V4.emptyBox('加载中…')}</div>
  </section>`;

  /* ----- 映射 ----- */
  const ACT_CN = {
    create_boost: '创建追投', delete_material: '删除素材', update_budget: '修改预算', update_roi: '修改ROI',
    pause: '暂停', resume: '恢复', delete_boost: '删除追投', update_status: '改状态',
    // 历史账户专用说明已从试用包移除。
    add_material: '添加素材', enable: '开启', update_budget_roi: '修改预算与ROI',
    delete_material_precheck: '删除素材预检', pause_blocked: '暂停被拦',
    flow_depleted_alert: '流量枯竭告警', flow_recovered_alert: '流量恢复告警',
    material_bleeding_suggest: '素材低效建议', boost_stoploss_suggest: '追投止损建议',
    boost_refund_alert: '追投退款告警',
  };
  const TGT_CN = { plan: '计划', boost_task: '追投', material: '素材' };
  const KEY_CN = { budget: '预算', roiGoal: 'ROI目标', ecpRoi2Goal: 'ROI目标', status: '状态', smartBidType: '出价方式', duration: '投放时长', name: '任务名',
    // 历史账户专用说明已从试用包移除。
    rate: '实际速率', baseline_median: '基线中位数', slot: '时段', rule: '规则',
    today_cost: '今日耗', today_net_roi_1h: '今日净ROI', d7_cost: '近7天耗', d7_net_roi: '近7天净ROI',
    refund_rate_1h: '退款率', reason: '原因', count: '条数', confirm: '确认' };
  const SRC_CN = { api: '投手', agent: 'Agent', manual: '人工', e2e: '测试' };
  const STATUS_CN = { 1: '投放中', 2: '暂停', '1': '投放中', '2': '暂停' };
  const BID_CN = { 0: '控成本', 7: '放量', '0': '控成本', '7': '放量' };

  /* 单字段翻译：状态码/出价方式转中文，其余原样 */
  function trVal(k, v) {
    if (v == null) return '—';
    if (k === 'status' || k === 'old_status') return STATUS_CN[v] || String(v);
    if (k === 'smartBidType') return BID_CN[v] || String(v);
    if (k === 'budget') return '¥' + v;
    if (k === 'duration') return Math.round(+v / 3600) + 'h';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  /* 参数详情：新值 + 原值（old_value 内字段按 原→新 展示），mids/task_id 由素材行/目标行承担 */
  function fmtKv(p) {
    if (!p || typeof p !== 'object') return '';
    const skip = new Set(['mids', 'legoMids', 'lego_mids', 'task_id', 'old_value', 'confirm']);
    const parts = [];
    for (const k of Object.keys(p)) {
      if (skip.has(k)) continue;
      const v = p[k];
      if (v == null) continue;
      parts.push(esc(KEY_CN[k] || k) + ' ' + esc(trVal(k, v)));
      if (parts.length >= 5) break;
    }
    const ov = p.old_value;
    if (ov && typeof ov === 'object') {
      for (const k of Object.keys(ov)) {
        if (ov[k] == null) continue;
        const newV = p[k] != null ? trVal(k, p[k]) : '—';
        parts.push(esc(KEY_CN[k] || k) + ' ' + esc(trVal(k, ov[k])) + ' → ' + esc(newV));
        if (parts.length >= 6) break;
      }
    }
    return parts.join(' · ');
  }

  /* 操作详情：转中文口语化句子，老板评审一眼看懂（2026-08-05 维护者：技术字段/素材ID正文不展示，ID 移入 title） */
  function opDetail(l) {
    const p = l.params || {};
    const oldV = (p.old_value && typeof p.old_value === 'object') ? p.old_value : null;
    const m0 = (l.materials && l.materials[0]) || null;
    // 素材引用：有名字用《名字》，否则用 ID；完整 ID 放 title 悬浮
    let matRef = '';
    if (m0) {
      matRef = m0.name && m0.name !== m0.id
        ? `<b title="素材ID ${esc(m0.id)}">《${esc(m0.name)}》</b>`
        : `<b title="素材ID ${esc(m0.id)}">（素材 ${esc(m0.id)}）</b>`;
    }
    // 目标对象（非素材）：主计划 / 追投
    const tgtRef = (l.target_type && l.target_type !== 'material' && l.target_id != null)
      ? `${esc(TGT_CN[l.target_type] || l.target_type)} <code title="${esc(String(l.target_id))}">#${esc(String(l.target_id))}</code>`
      : '';

    const fail = (!l.success && l.result_msg)
      ? `<div class="failmsg">${esc(l.result_msg)}</div>` : '';

    const act = l.action;
    let s = '';

    if (act === 'delete_material') {
      s = `删除素材 ${matRef}`;
    } else if (act === 'create_boost') {
      const parts = [];
      if (p.budget != null) parts.push(`预算 ¥${esc(String(p.budget))}`);
      if (p.roiGoal != null) parts.push(`ROI 目标 ${esc(String(p.roiGoal))}`);
      else if (p.ecpRoi2Goal != null) parts.push(`ROI 目标 ${esc(String(p.ecpRoi2Goal))}`);
      if (p.smartBidType != null && BID_CN[p.smartBidType]) parts.push(esc(BID_CN[p.smartBidType]));
      if (p.duration != null) parts.push(`时长 ${Math.round(+p.duration / 3600)}h`);
      if (p.name) parts.push(`任务名「${esc(String(p.name))}」`);
      s = `创建追投${matRef ? ' · 素材 ' + matRef : ''}${parts.length ? `（${parts.join(' · ')}）` : ''}`;
    } else if (act === 'update_budget') {
      const from = oldV && oldV.budget != null ? '¥' + oldV.budget : '—';
      const to = p.budget != null ? '¥' + p.budget : '—';
      s = `把预算从 ${esc(String(from))} 改成 ${esc(String(to))}${matRef ? ' · ' + matRef : (tgtRef ? ' · ' + tgtRef : '')}`;
    } else if (act === 'update_roi') {
      const from = oldV && (oldV.roiGoal != null || oldV.ecpRoi2Goal != null) ? (oldV.roiGoal != null ? oldV.roiGoal : oldV.ecpRoi2Goal) : '—';
      const to = (p.roiGoal != null || p.ecpRoi2Goal != null) ? (p.roiGoal != null ? p.roiGoal : p.ecpRoi2Goal) : '—';
      s = `把 ROI 目标从 ${esc(String(from))} 改成 ${esc(String(to))}${matRef ? ' · ' + matRef : (tgtRef ? ' · ' + tgtRef : '')}`;
    } else if (act === 'pause') {
      s = `暂停${matRef || tgtRef || ''}`;
    } else if (act === 'resume') {
      s = `恢复${matRef || tgtRef || ''}`;
    } else if (act === 'delete_boost') {
      s = `删除追投 ${tgtRef}`;
    } else if (act === 'update_status') {
      const from = oldV && oldV.status != null ? (STATUS_CN[oldV.status] || oldV.status) : '—';
      const to = p.status != null ? (STATUS_CN[p.status] || p.status) : '—';
      s = `把状态从 ${esc(String(from))} 改成 ${esc(String(to))}${matRef ? ' · ' + matRef : (tgtRef ? ' · ' + tgtRef : '')}`;
    } else if (act === 'flow_depleted_alert') {
      // 历史账户专用说明已从试用包移除。
      const rate = p.rate != null ? String(p.rate) : '—';
      const base = p.baseline_median != null ? String(p.baseline_median) : '—';
      const slotCn = { morning: '早间', noon: '午间', afternoon: '午后', evening: '晚间' }[p.slot] || p.slot || '';
      s = `${slotCn ? slotCn + '时段' : ''}流量枯竭：实际速率 ${esc(String(rate))} 元/15分钟，低于基线中位数 ${esc(String(base))}（${esc(String(p.rule || '枯竭告警'))}）`;
    } else if (act === 'flow_recovered_alert') {
      const rate = p.rate != null ? String(p.rate) : '—';
      const base = p.baseline_median != null ? String(p.baseline_median) : '—';
      const slotCn = { morning: '早间', noon: '午间', afternoon: '午后', evening: '晚间' }[p.slot] || p.slot || '';
      s = `${slotCn ? slotCn + '时段' : ''}流量恢复：实际速率 ${esc(String(rate))} 元/15分钟，回到基线 ${esc(String(base))} 以上（${esc(String(p.rule || '恢复告警'))}）`;
    } else if (act === 'material_bleeding_suggest') {
      // 素材高消耗低回报建议：今天耗/净ROI + 近7天耗/净ROI
      const parts = [];
      if (p.today_cost != null) parts.push(`今日耗 ${esc(String(p.today_cost))} 元`);
      if (p.today_net_roi_1h != null) parts.push(`今日净ROI ${esc(String(p.today_net_roi_1h))}`);
      if (p.d7_cost != null) parts.push(`近7天耗 ${esc(String(p.d7_cost))} 元`);
      if (p.d7_net_roi != null) parts.push(`近7天净ROI ${esc(String(p.d7_net_roi))}`);
      s = `素材高消耗低回报 ${matRef || ''}${parts.length ? '（' + parts.join(' · ') + '）' : ''}`;
    } else if (act === 'boost_stoploss_suggest') {
      s = `追投止损建议 ${matRef || tgtRef || ''}（${esc(String(p.reason || p.rule || '止损触发'))}）`;
    } else if (act === 'boost_refund_alert') {
      s = `追投退款告警 ${matRef || tgtRef || ''}（退款率 ${esc(String(p.refund_rate_1h != null ? p.refund_rate_1h : p.refund_rate || '—'))}）`;
    } else if (act === 'delete_material_precheck') {
      s = `删除素材预检 ${matRef || ''}（${p.confirm ? '确认删除' : '预检通过，待确认'}）`;
    } else if (act === 'pause_blocked') {
      s = `暂停被拦截 ${matRef || tgtRef || ''}：${esc(String(p.reason || p.error || '规则拦截'))}`;
    } else if (act === 'update_budget_roi') {
      const fromB = oldV && oldV.budget != null ? '¥' + oldV.budget : '—';
      const toB = p.budget != null ? '¥' + p.budget : '—';
      const fromR = oldV && (oldV.roiGoal != null || oldV.ecpRoi2Goal != null) ? (oldV.roiGoal != null ? oldV.roiGoal : oldV.ecpRoi2Goal) : '—';
      const toR = (p.roiGoal != null || p.ecpRoi2Goal != null) ? (p.roiGoal != null ? p.roiGoal : p.ecpRoi2Goal) : '—';
      s = `预算 ${esc(String(fromB))} → ${esc(String(toB))} · ROI ${esc(String(fromR))} → ${esc(String(toR))}${matRef ? ' · ' + matRef : (tgtRef ? ' · ' + tgtRef : '')}`;
    } else if (act === 'add_material') {
      s = `添加素材 ${matRef || ''}${p.count != null ? `（${esc(String(p.count))} 条）` : ''}`;
    } else {
      // 兜底：未知 action 走通用键值渲染
      const kv = fmtKv(l.params);
      const head = matRef || tgtRef || (ACT_CN[act] || act || '操作');
      s = head + (kv ? ` · ${kv}` : '');
    }

    return `<div class="mline">${s}</div>${fail}`;
  }

  V4.pages.system = {
    mount(view) {
      view.innerHTML = HTML;
      const stoppers = [];
      /* 账号快照：切账号后在途请求作废，防旧账号操作记录写进新页面 */
      const acct0 = V4.acct();
      let dead = false;
      const alive = () => !dead && V4.acct() === acct0;
      let activePanel = 'health';
      const panelPolls = {};

      /* ===== Tab 切换（ARIA 同步） ===== */
      view.querySelectorAll('#pgSysTabs button').forEach(b => b.onclick = () => {
        view.querySelectorAll('#pgSysTabs button').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-selected', 'false'); });
        view.querySelectorAll('.pg-sys-panel').forEach(x => x.classList.remove('on'));
        b.classList.add('on'); b.setAttribute('aria-selected', 'true');
        $('pgSysP-' + b.dataset.p).classList.add('on');
        activePanel = b.dataset.p;
        if (panelPolls[activePanel]) panelPolls[activePanel].refresh();
      });
      $('pgSysFeature').textContent = '账号添加、登录更新与移出请使用顶部“管理”';

      function healthCard(label, value, state, note) {
        return `<div class="pg-sys-health-card"><div class="l">${esc(label)}</div><div class="v ${state || ''}">${esc(value)}</div><div class="s">${esc(note || '')}</div></div>`;
      }
      function bytes(value) {
        const n = +value;
        return Number.isFinite(n) ? (n / 1024 / 1024).toFixed(1) + ' MB' : '--';
      }
      async function refreshHealth() {
        if (!alive()) return;
        try {
          const j = await V4.api('/api/status', { account: acct0 }, { timeout: 8000 });
          if (!alive()) return;
          const layers = j.layers || {};
          const resources = layers.resources || {};
          const loop = resources.event_loop_delay_ms || {};
          const queue = layers.queue && layers.queue[acct0] || {};
          const collector = j.collector || {};
          const sqlite = layers.sqlite || {};
          const upstream = j.upstream || {};
          const cards = [
            healthCard('HTTP 数据服务', layers.http && layers.http.state === 'available' ? '可用' : '异常', layers.http && layers.http.state === 'available' ? 'good' : 'bad', `PID ${j.runtime && j.runtime.pid || '--'} · 运行 ${j.runtime && j.runtime.uptime_s || 0}s`),
            healthCard('Cookie', j.cookie_valid ? '本地格式有效' : '需要处理', j.cookie_valid ? 'good' : 'bad', j.cookie_reason || '仍以上游只读响应为准'),
            healthCard('千川上游', upstream.last_error ? '最近有错误' : (upstream.last_success_at ? '最近请求成功' : '尚无请求证据'), upstream.last_error ? 'warn' : (upstream.last_success_at ? 'good' : ''), upstream.last_error || upstream.last_success_at || '不因未知状态重启服务'),
            healthCard('SQLite', sqlite.state === 'available' ? '可读' : '不可用', sqlite.state === 'available' ? 'good' : 'bad', sqlite.code || sqlite.check || '轻量只读探测'),
            healthCard('Collector', collector.state || (collector.last_success_at ? '已运行' : '未启动'), collector.last_error ? 'warn' : (collector.last_success_at ? 'good' : ''), collector.last_error || collector.last_success_at || '等待下一轮状态探测'),
            healthCard('账号请求队列', queue.processing ? `执行中 · 排队 ${queue.length || 0}` : `空闲 · 排队 ${queue.length || 0}`, queue.length > 2 ? 'warn' : 'good', queue.current_task ? `${queue.current_task} · ${Math.round((queue.current_task_age_ms || 0) / 1000)}s` : `间隔 ${queue.interval_ms || '--'}ms`),
            healthCard('事件循环延迟', loop.p95 == null ? '--' : `P95 ${loop.p95} ms`, loop.p95 > 250 ? 'bad' : loop.p95 > 100 ? 'warn' : 'good', `mean ${loop.mean == null ? '--' : loop.mean} ms · max ${loop.max == null ? '--' : loop.max} ms`),
            healthCard('进程资源', bytes(resources.memory && resources.memory.rss_bytes), '', `活跃句柄 ${resources.active_handles == null ? '--' : resources.active_handles}`),
          ];
          $('pgSysHealth').innerHTML = cards.join('');
          $('pgSysHealthAt').textContent = V4.acctName(acct0) + ' · ' + V4.nowStr();
          V4.touch();
        } catch (error) {
          if (alive()) $('pgSysHealth').innerHTML = V4.errBox(error);
        }
      }

      /* ===== 操作记录（随外壳账号，60s） ===== */
      async function refreshOps() {
        if (!alive()) return;
        $('pgSysOpsAcct').textContent = V4.acctName();
        let j;
        try { j = await V4.api('/api/op-log', { limit: 30, accountId: acct0 }); }
        catch (e) { if (alive()) $('pgSysOpList').innerHTML = V4.errBox(e); return; }
        if (!alive()) return;
        const logs = j.logs || [];
        $('pgSysN-ops').textContent = logs.length || '';
        if (!logs.length) { $('pgSysOpList').innerHTML = V4.emptyBox('暂无操作记录'); V4.touch(); return; }
        $('pgSysOpList').innerHTML = logs.map((l, i) => {
          const ts = String(l.ts || '');
          // op-log ts 是本地时间（SQLite localtime），"今天"必须用本地日期——
          // UTC 日期会在北京时间 00:00~08:00 把当天上午的记录错判成昨天（2026-07-29 审计修复）
          const dn = new Date();
          const todayStr = `${dn.getFullYear()}-${V4.p2(dn.getMonth() + 1)}-${V4.p2(dn.getDate())}`;
          const isToday = ts.slice(0, 10) === todayStr;
          // 完整到秒；当天省略日期，跨天带 MM-DD
          const time = isToday ? ts.slice(11, 19) : ts.slice(5, 19);
          const actCn = ACT_CN[l.action] || l.action || '--';
          const ok = !!l.success;
          const src = SRC_CN[l.source] || l.source || '—';
          return `<div class="pg-sys-op-row${i === 0 ? ' fresh' : ''}">
            <span class="t" title="${esc(ts)}">${esc(time)}</span>
            <span class="k">${esc(actCn)}</span>
            <span class="r ${ok ? 'ok' : 'fail'}"><i></i>${ok ? '成功' : '失败'}</span>
            <span class="o">${esc(src)}</span>
            <span class="d">${opDetail(l)}</span>
          </div>`;
        }).join('');
        V4.touch();
      }

      /* ===== 回填监控（active 10s / 否则 60s） ===== */
      let fillMs = 60000, filling = false;
      async function refreshFill() {
        if (!alive() || filling) return;
        filling = true;
        try {
          const j = await V4.api('/api/backfill-status', { accountId: '' }); // 全部账号，抑制自动 account 过滤
          if (!alive()) return;
          const accts = j.accounts || [];
          const anyActive = accts.some(a => a.active || a.busy);
          $('pgSysN-fill').textContent = !accts.length ? '' : anyActive
            ? accts.reduce((s, a) => s + (+a.completed || 0), 0) + '/' + accts.reduce((s, a) => s + (+a.total || 0), 0)
            : '完成';
          if (!accts.length) {
            $('pgSysFillList').innerHTML = V4.emptyBox('暂无回填任务');
            $('pgSysLogbox').innerHTML = '';
          } else {
            $('pgSysFillList').innerHTML = accts.map(a => {
              const total = +a.total || 0, completed = +a.completed || 0;
              const running = !!(a.active || a.busy);
              const stTxt = running ? '进行中' : (total === 0 && a.done) ? '无待回填' : a.done ? '完成' : '待命';
              const pct = total > 0 ? Math.min(100, Math.round(completed / total * 100)) : (a.done ? 100 : 0);
              // 历史账户专用说明已从试用包移除。
              // 显示停在 7-20 误导"十天没回填"。实际数据链健康（db 到昨天、对账到昨天）。优先显示对账日期
              const sub = a.current ? '正在回填 ' + a.current
                : (a.reconcile && a.reconcile.date) ? '数据已对账至 ' + a.reconcile.date + (a.reconcile.anomaly ? '（偏差告警）' : '')
                : a.log_mtime ? '最近日志 ' + fmtTs(a.log_mtime) : '';
              return `<div class="pg-sys-fill-item">
                <div class="pg-sys-fill-top"><span>${esc(a.account_name || a.account)}回填<span class="st">${stTxt}</span></span><b>${stTxt === '无待回填' ? '—' : pct + '%'}</b></div>
                <div class="pbar"><i style="width:${pct}%"></i></div>
                <div class="pg-sys-fill-sub">${esc(sub)}</div>
              </div>`;
            }).join('');
            const lines = [];
            accts.slice().sort((a, b) => (+b.log_mtime || 0) - (+a.log_mtime || 0)).forEach(a => {
              (a.log_tail || []).forEach(t => lines.push({ tag: a.account_name || a.account, text: t }));
            });
            $('pgSysLogbox').innerHTML = lines.length
              ? lines.slice(0, 16).map((l, i) => `<div class="pg-sys-log${i === 0 ? ' fresh' : ''}"><b>${esc(l.tag)}</b> ${esc(l.text)}</div>`).join('')
              : V4.emptyBox('暂无回填日志');
          }
          fillMs = anyActive ? 10000 : 60000;
          V4.touch();
        } catch (e) {
          if (alive()) {
            $('pgSysFillList').innerHTML = V4.errBox(e);
            fillMs = 60000;
          }
        } finally {
          filling = false;
        }
      }
      function fmtTs(ms) {
        const d = new Date(+ms);
        if (isNaN(d)) return '';
        return V4.p2(d.getMonth() + 1) + '-' + V4.p2(d.getDate()) + ' ' + V4.p2(d.getHours()) + ':' + V4.p2(d.getMinutes());
      }

      /* ===== 账号状态（全部账号，60s） ===== */
      async function refreshAccts() {
        if (!alive()) return;
        let accts;
        try {
          const j = await V4.api('/api/status', { accountId: '' }); // 全部账号，抑制自动 account 过滤
          accts = j.accounts || [];
        } catch (e) { if (alive()) $('pgSysAcctGrid').innerHTML = V4.errBox(e); return; }
        if (!alive()) return;
        $('pgSysN-acct').textContent = accts.length || '';
        if (!accts.length) { $('pgSysAcctGrid').innerHTML = V4.emptyBox('未配置账号'); V4.touch(); return; }
        $('pgSysAcctGrid').innerHTML = accts.map((a, i) => `
          <div class="block pg-sys-acct${a.cookie_valid ? '' : ' bad'}">
            <div class="pg-sys-acct-name">${esc(a.account_name || a.account)}
              <span class="pg-sys-st ${a.cookie_valid ? 'good' : 'danger'}">${a.cookie_valid ? 'COOKIE 有效' : 'COOKIE 失效'}</span></div>
            <div class="vitals" id="pgSysBal-${i}">
              <div class="vital"><div class="l">账户余额</div><div class="v num">--</div><div class="s">加载中…</div></div>
            </div>
            <div class="pg-sys-ck"><span>cookie 大小</span><b>${a.cookie_size ? (a.cookie_size / 1024).toFixed(1) + ' KB' : '--'}</b></div>
            <div class="pg-sys-ck"><span>会话</span><b>${a.has_session ? '有会话' : '无会话'}</b></div>
          </div>`).join('');
        V4.touch();
        await Promise.all(accts.map(async (a, i) => {
          const box = $('pgSysBal-' + i);
          if (!box) return;
          try {
            const b = await V4.api('/api/balance', { account: a.account });
            if (!alive()) return; // 页面已卸载/账号已切，不写旧 DOM
            box.innerHTML = `
              <div class="vital"><div class="l">账户余额</div><div class="v num">${esc(fmtM(b.total_balance_yuan))}</div><div class="s">总余额</div></div>
              <div class="vital"><div class="l">有效余额</div><div class="v num">${esc(fmtM(b.valid_balance_yuan))}</div><div class="s">可用</div></div>
              <div class="vital"><div class="l">冻结余额</div><div class="v num">${esc(fmtM(b.frozen_balance_yuan))}</div><div class="s">冻结</div></div>`;
          } catch (e) {
            box.innerHTML = `<div class="vital"><div class="l">账户余额</div><div class="v num">--</div><div class="s">${esc('获取失败')}</div></div>`;
          }
        }));
      }

      /* ===== 轮询 ===== */
      // 只刷新正在看的子面板；隐藏的账号页不轮询所有账号余额。
      for (const [key, refresh, interval] of [
        ['health', refreshHealth, 30000], ['ops', refreshOps, 60000],
        ['acct', refreshAccts, 60000], ['fill', refreshFill, () => fillMs],
      ]) {
        panelPolls[key] = V4.poll(() => alive() && activePanel === key ? refresh() : undefined, interval);
        stoppers.push(panelPolls[key]);
      }

      return function unmount() {
        dead = true;
        stoppers.forEach(s => s());
      };
    },
  };

})(window.V4);
