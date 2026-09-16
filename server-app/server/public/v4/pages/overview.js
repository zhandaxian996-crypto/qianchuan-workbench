/* ===== 千川投控 v4 · 总览（全店驾驶舱：多账号平视对比，点击进作战室深挖） ===== */
(function (V4) {
  'use strict';
  const { $, esc, fmtM, fmtMoney } = V4;
  let BE = V4.breakEven(); // 保本净ROI：由当前账号元数据或 /api/config 确认，绝不按账号名猜测

  // 启动时获取保本线（支持按账号差异化）
  (async () => {
    try {
      const r = await fetch('/api/config?account=' + (V4.acct() || ''));
      const j = await r.json();
      if (j && j.ok && j.account_params && j.account_params.break_even_roi != null) {
        BE = j.account_params.break_even_roi;
      }
    } catch (e) { /* 保留账号列表已确认的保本线 */ }
  })();

  const HTML = `
  <style>
  .pg-ov-band { background:radial-gradient(320% 130% at 53% 130%, rgba(5,8,16,0) 0%, rgba(5,41,136,.20) 30%, rgba(0,102,255,.32) 100%), var(--panel);
    border:1px solid rgba(0,102,255,.15); border-radius:28.8px; padding:16px 22px 13px; }
  :root[data-theme="paper"] .pg-ov-band { background:radial-gradient(320% 130% at 53% 130%, rgba(255,253,246,0) 0%, rgba(34,168,216,.07) 35%, rgba(34,168,216,.16) 100%), var(--bg-panel);
    border:1.5px solid rgba(34,168,216,.22); }
  
  .skel { animation: skel-load 1.4s ease-in-out infinite; background: var(--line); border-radius: 4px; color: transparent !important; }
  @keyframes skel-load { 0% { opacity: 0.4; } 50% { opacity: 0.8; } 100% { opacity: 0.4; } }
  .pg-ov-band .row { display:flex; }
  .pg-ov-cell { flex:1; min-width:0; padding:0 16px; border-left:1px solid rgba(128,160,255,.14); }
  .pg-ov-cell:first-child { border-left:0; padding-left:0; }
  .pg-ov-cell .l { font-size:11px; color:var(--ink-3); }
  .pg-ov-cell .v { font-size:26px; font-weight:800; font-family:var(--font-data); margin-top:4px; color:var(--ink); }
  .pg-ov-cell.hero .v { font-size:34px; }
  .pg-ov-cell .s { font-size:10.5px; color:var(--ink-3); margin-top:2px; }
  .pg-ov-split-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 10px; }
  .pg-ov-split-head .title { font-size:13px; font-weight:750; color:var(--ink-2); }
  .pg-ov-split-account { padding:4px 0 12px; }
  .pg-ov-split-account + .pg-ov-split-account { border-top:1px solid var(--line); padding-top:14px; }
  .pg-ov-split-name { font-size:12px; font-weight:700; margin-bottom:9px; color:var(--ink-2); }
  .pg-ov-split-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); }
  .pg-ov-split-cell { min-width:0; padding:2px 20px; border-left:1px solid var(--line); }
  .pg-ov-split-cell:first-child { border-left:0; padding-left:0; }
  .pg-ov-split-cell .lab { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:12px; color:var(--ink-2); }
  .pg-ov-split-cell .rf { font-size:10.5px; color:var(--ink-3); }
  .pg-ov-split-cell .cost { font-size:28px; font-weight:750; font-family:var(--font-data); margin-top:4px; }
  .pg-ov-split-cell .sub { display:flex; gap:14px; flex-wrap:wrap; margin-top:3px; font-size:11.5px; color:var(--ink-3); }
  .pg-ov-split-cell .sub b { color:var(--ink-2); font-family:var(--mono); }

  .pg-ov-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(430px,100%),1fr)); gap:24px; margin-top:24px; }
  .pg-ov-card { background:var(--panel); border:1px solid var(--line); border-radius:var(--r); padding:16px 18px; cursor:pointer; transition:border-color .18s, transform .18s; min-width:0; }
  .pg-ov-card:hover { border-color:var(--steel); transform:translateY(-2px); }
  .pg-ov-h { display:flex; align-items:baseline; gap:10px; }
  .pg-ov-h .nm { font-size:15px; font-weight:800; }
  .pg-ov-h .st { font-size:10.5px; padding:1px 8px; border-radius:99px; border:1px solid var(--line); color:var(--ink-3); }
  .pg-ov-h .st.live { color:var(--st-live); border-color:var(--st-live); }
  .pg-ov-h .go { margin-left:auto; font-size:11px; color:var(--ink-3); }
  .pg-ov-kpis { display:flex; margin-top:12px; }
  .pg-ov-kpi { flex:1; min-width:0; padding-left:12px; border-left:1px solid var(--line); }
  .pg-ov-kpi:first-child { border-left:0; padding-left:0; }
  .pg-ov-kpi .l { font-size:10px; color:var(--ink-3); letter-spacing:.08em; }
  .pg-ov-kpi .v { font-size:19px; font-weight:700; font-family:var(--font-data); margin-top:3px; }
  .pg-ov-kpi .v.gd { color:var(--st-ok); } .pg-ov-kpi .v.wn { color:var(--st-warn); } .pg-ov-kpi .v.bd { color:var(--st-danger); }
  .pg-ov-spark { height:64px; margin-top:10px; }
  .pg-ov-dd { display:flex; gap:16px; margin-top:10px; font-size:11.5px; color:var(--ink-2); flex-wrap:wrap; }
  .pg-ov-dd b { font-family:var(--mono); }
  .pg-ov-dd span i { font-style:normal; color:var(--ink-3); margin-right:5px; }
  .pg-ov-ops { margin-top:10px; border-top:1px solid var(--line); padding-top:10px; font-size:11.5px; color:var(--ink-3);
    display:flex; gap:14px; flex-wrap:wrap; align-items:center; }
  .pg-ov-ops .dec { flex:1 1 100%; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pg-ov-alerts { margin-top:24px; }
  .pg-ov-intro { display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:16px; }
  .pg-ov-intro h1 { margin:0 0 6px;font-size:24px; }.pg-ov-intro p { margin:0;color:var(--ink-3);font-size:12.5px;line-height:1.7; }
  .pg-ov-trust { display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;max-width:620px; }.pg-ov-trust span { padding:5px 9px;border:1px solid var(--line);border-radius:999px;font-size:10.5px;color:var(--ink-3); }
  .pg-ov-trust span.good { color:var(--good); }.pg-ov-trust span.warn { color:var(--st-warn); }.pg-ov-trust span.bad { color:var(--danger); }
  .pg-ov-more { margin-top:22px;border-top:1px solid var(--line);padding-top:2px; }.pg-ov-more summary { cursor:pointer;padding:13px 0;color:var(--ink-2);font-size:12px;font-weight:650;list-style:none; }
  .pg-ov-more summary:after { content:'展开';float:right;color:var(--ink-3);font-size:10.5px;font-weight:400; }.pg-ov-more[open] summary:after { content:'收起'; }
  .pg-ov-more-note { font-size:11px;color:var(--ink-3);line-height:1.7;margin:-4px 0 10px; }
  .pg-ov-al { display:flex; gap:8px; padding:8px 0; border-top:1px solid var(--line); font-size:12px; }
  .pg-ov-al:first-child { border-top:0; }
  .pg-ov-al .tag { flex-shrink:0; font-size:10px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--ink-3); height:fit-content; }
  .pg-ov-al.danger { color:var(--st-danger); }
  .pg-ov-al.warn { color:var(--st-warn); }
  /* 人群/漏斗/最近直播（罗盘快照 enrich，2026-07-26） */
  .pg-ov-crowd { display:flex; gap:12px; margin-top:8px; font-size:11px; color:var(--ink-2); flex-wrap:wrap; align-items:center; }
  .pg-ov-crowd .tag8 { font-size:10px; padding:1px 8px; border-radius:99px; border:1px solid var(--steel); color:var(--steel); }
  .pg-ov-funnel { margin-top:8px; }
  .pg-ov-funnel .fr { display:grid; grid-template-columns:52px 1fr 84px; gap:8px; align-items:center; font-size:10.5px; color:var(--ink-3); margin-top:3px; }
  .pg-ov-funnel .bar { height:8px; border-radius:4px; background:var(--line); overflow:hidden; }
  .pg-ov-funnel .bar i { display:block; height:100%; border-radius:4px; background:var(--steel); }
  .pg-ov-funnel .bar i.hot { background:var(--st-ok); }
  .pg-ov-funnel .peer { color:var(--st-danger); }
  .pg-ov-lastlive { margin-top:8px; font-size:11px; color:var(--ink-3); border-top:1px dashed var(--line); padding-top:8px; }
  .pg-ov-lastlive b { font-family:var(--mono); color:var(--ink-2); }
  /* 商品榜 */
  .pg-ov-goods { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(430px,100%),1fr)); gap:24px; margin-top:12px; }
  .pg-ov-gcol { background:var(--panel); border:1px solid var(--line); border-radius:var(--r); padding:12px 16px; }
  .pg-ov-gcol .gh { font-size:12.5px; font-weight:700; padding-bottom:8px; }
  .pg-ov-gcol .gh .s { font-weight:400; font-size:10px; color:var(--ink-3); margin-left:8px; }
  .pg-ov-grow { display:grid;grid-template-columns:1fr 86px 86px 52px; gap:10px; align-items:center; padding:7px 0; border-top:1px solid var(--line); font-size:11.5px; }
  .pg-ov-grow .nm { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-2); }
  .pg-ov-grow .m { font-family:var(--mono); text-align:right; }
  .pg-ov-grow .hd { font-size:10px; color:var(--ink-3); border-top:0; }
  @media (max-width:640px) { .pg-ov-goods { grid-template-columns:minmax(0,1fr); } }
  @media (max-width:640px) { .pg-ov-cards { grid-template-columns:minmax(0,1fr); } }
  /* 手机适配（2026-07-26）：Band 折行、KPI 缩小、商品榜列压缩 */
  @media (max-width:640px) {
    .pg-ov-intro { display:block; }.pg-ov-trust { justify-content:flex-start;margin-top:10px; }
    .pg-ov-band { padding:12px 12px 8px; border-radius:18px; }
    .pg-ov-band .row { flex-wrap:wrap; }
    .pg-ov-cell { flex:1 1 33%; padding:8px 8px 4px; border-left:0; }
    .pg-ov-cell .v { font-size:18px; }
    .pg-ov-cell.hero .v { font-size:22px; }
    .pg-ov-cell .s { font-size:9.5px; }
    .pg-ov-card { padding:12px 12px; }
    .pg-ov-kpis { flex-wrap:wrap; }
    .pg-ov-kpi { flex:1 1 28%; padding:4px 0 4px 10px; }
    .pg-ov-kpi .v { font-size:15px; }
    .pg-ov-spark { height:48px; }
    .pg-ov-funnel .fr { grid-template-columns:44px 1fr 74px; }
    .pg-ov-grow { grid-template-columns:1fr 70px 70px 42px; gap:6px; font-size:11px; }
    .pg-ov-gcol { padding:10px 10px; }
    .pg-ov-split-grid { grid-template-columns:1fr; }
    .pg-ov-split-cell { border-left:0; border-top:1px solid var(--line); padding:10px 0 6px; }
    .pg-ov-split-cell:first-child { border-top:0; padding-top:2px; }
  }
  </style>

  <section class="pg-ov-intro"><div><h1>投放数据工作台</h1><p>先确认数据是否可信，再看盘面变化与 Agent 决策。投放操作不在这里执行。</p></div><div class="pg-ov-trust" id="ovTrust"><span>正在确认数据来源…</span></div></section>
  <div class="pg-ov-split-head"><span class="title">店铺成交（千川首页口径）</span><span class="m-tabs" id="ovSplitTabs"><button data-d="yesterday">昨日</button><button class="on" data-d="today">今日</button></span></div>
  <div class="pg-ov-band" id="ovBand"></div>
  <div class="sec-title" style="margin-top:24px">账户与 Agent 状态 <span class="cd" id="ovMeta"></span></div>
  <div class="pg-ov-cards" id="ovCards"></div>
  <div class="sec-title pg-ov-alerts">需要关注的证据 <span class="cd" id="ovAlCnt"></span></div>
  <div id="ovAlerts"></div>
  <details class="pg-ov-more" id="ovMore"><summary>经营与商品诊断（低频查看）</summary>
    <p class="pg-ov-more-note">“上线前后”只能作为相关性线索，不等同于系统带来的因果收益；请结合直播场次、素材与人工操作复核。</p>
    <div class="sec-title">效果归因线索 <span class="cd">上线后 vs 上线前 7 天 · 千川首页口径</span></div><div class="pg-ov-goods" id="ovValue"></div>
    <div class="sec-title" style="margin-top:24px">商品卡（全域 · 乘方） <span class="cd">只读镜像 · 操盘在千川后台</span></div><div class="pg-ov-goods" id="ovCf"></div>
    <div class="sec-title" style="margin-top:24px">商品榜 Top5 <span class="cd">近7天 · 罗盘口径</span></div><div class="pg-ov-goods" id="ovGoods"></div>
  </details>
  `;

  // 2026-07-30 审计修复：保本线逐店取（dash.thresholds.break_even_roi），全局 BE 仅兜底
  function beOf(d) { return (d && d.dash && d.dash.thresholds && d.dash.thresholds.break_even_roi) || BE; }
  function roiCls(v, be) {
    if (v == null || !Number.isFinite(Number(v))) return '';
    const B = be || BE;
    return v >= B ? 'gd' : v >= B * 0.85 ? 'wn' : 'bd';
  }

  // 核心盘面与低频诊断必须是两条独立状态流。低频请求耗时更长，若把它携带的
  // dash 直接展开到核心对象上，会让稍早返回的旧盘面覆盖下一轮新盘面。
  function mergeCoreAccount(account, pack, slowState) {
    const a = account || {};
    const p = pack || {};
    return {
      ...(slowState || {}),
      id: a.accountId,
      name: a.accountName,
      watch: a,
      error: p.__error || null,
      errors: p.errors || [],
      dash: p.dash || a,
      split: p.split,
      rounds: p.rounds,
      pend: p.pend,
    };
  }

  function mergeSlowState(previous, pack, now = Date.now()) {
    const p = pack || {};
    const next = { ...(previous || {}) };
    const failed = !!p.__error || p.ok === false || p.partial === true || (Array.isArray(p.errors) && p.errors.length > 0);
    next.slowError = p.__error || (p.ok === false ? { code: p.code, message: p.error || p.message || '读取失败' } : null);
    next.slowErrors = p.errors || [];
    // 成功/null 分开：失败帧或 null 不得擦掉上一轮已成功的低频数据。
    if (p.dash && p.dash.ok !== false) next.slowDash = p.dash;
    for (const key of ['crowd', 'goods', 'value']) {
      if (Object.prototype.hasOwnProperty.call(p, key) && p[key] != null) next[key] = p[key];
    }
    next.slowComplete = !failed;
    next.slowRetryAt = failed ? now + 30000 : null;
    return next;
  }

  function splitRows(payload) {
    if (!payload || payload.ok === false) return { available: false, rows: [], error: payload && (payload.error || payload.code) || 'home_split_unavailable' };
    const rows = [payload.all, payload.product, payload.live].filter(Boolean);
    if (rows.length !== 3 || rows.some(row => row.unavailable || row.base_unavailable || row.cf_unavailable)) {
      return { available: false, rows: [], error: 'home_split_unavailable' };
    }
    return { available: true, rows };
  }

  // 给 Node 回归测试使用；不参与页面展示，也不暴露运行数据。
  V4.__overviewTest = { mergeCoreAccount, mergeSlowState, splitRows };

  /* 迷你趋势线：累计净ROI + 保本虚线（canvas，64px） */
  function drawSpark(cv, trend, be) {
    const B = be || BE;
    const tx = cv.getContext('2d');
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = w * dpr; cv.height = h * dpr;
    tx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tx.clearRect(0, 0, w, h);
    let cg = 0, cc = 0;
    const pts = (trend || []).map(p => { cg += +p.gmvSettle || 0; cc += +p.cost || 0; return cc > 0 ? cg / cc : 0; });
    const all = pts.length ? pts : [B];
    const min = Math.min(...all, B) - .15, max = Math.max(...all, B) + .15;
    const X = i => i / (all.length - 1) * (w - 4) + 2, Y = v => h - 4 - (v - min) / (max - min) * (h - 10);
    tx.strokeStyle = 'rgba(148,163,184,.3)'; tx.setLineDash([3, 4]); tx.lineWidth = 1;
    tx.beginPath(); tx.moveTo(0, Y(B)); tx.lineTo(w, Y(B)); tx.stroke(); tx.setLineDash([]);
    if (pts.length < 2) return;
    const last = pts[pts.length - 1];
    const col = last >= B ? 'var(--st-ok)' : 'var(--st-danger)';
    const colRaw = last >= B ? '#2fbf8a' : '#ee6a6a';
    tx.beginPath();
    pts.forEach((v, i) => { const x = X(i), y = Y(v); i ? tx.lineTo(x, y) : tx.moveTo(x, y); });
    tx.strokeStyle = colRaw; tx.lineWidth = 1.8; tx.lineJoin = 'round'; tx.stroke();
    const lx = X(pts.length - 1), ly = Y(last);
    tx.beginPath(); tx.arc(lx, ly, 3, 0, 7); tx.fillStyle = colRaw; tx.fill();
  }

  V4.pages.overview = {
    mount(view) {
      view.innerHTML = HTML;
      let dead = false;
      const stoppers = [];
      const sparks = []; // {cv, trend}，resize 重绘
      const slowByAccount = new Map();
      const splitByAccount = new Map();
      let currentData = [];
      let slowLoading = false;
      let splitDay = 'today';
      let splitFlight = false;

      function localDate(offset = 0) {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${V4.p2(d.getMonth() + 1)}-${V4.p2(d.getDate())}`;
      }

      function renderSkeletonCards(accts) {
        const h = accts.map(a => `
          <div class="pg-ov-card" style="pointer-events:none">
            <div class="pg-ov-h">
              <span class="nm">${esc(a.accountName)}</span>
              <span class="st skel">.......</span>
            </div>
            <div class="pg-ov-kpis">
              <div class="pg-ov-kpi"><div class="l">消耗</div><div class="v skel" style="width:60%">0000</div></div>
              <div class="pg-ov-kpi"><div class="l">净成交</div><div class="v skel" style="width:80%">0000</div></div>
              <div class="pg-ov-kpi"><div class="l">净ROI</div><div class="v skel" style="width:50%">00</div></div>
            </div>
            <div class="pg-ov-spark skel" style="margin-top:16px"></div>
          </div>
        `).join('');
        $('ovCards').innerHTML = h;
      }

      async function load() {
        let watch;
        try {
          watch = await V4.api('/api/live-watch', { accountId: '' }, { timeout: 25000 });
        } catch (error) {
          if (dead) return;
          $('ovTrust').innerHTML = `<span class="bad">数据探针失败 · ${esc(error.code || error.message || 'unknown_error')}</span>`;
          $('ovBand').innerHTML = V4.errBox(error);
          $('ovCards').innerHTML = V4.emptyBox('未取得店铺盘面，本轮没有用空值或旧值伪装成功');
          $('ovAlerts').innerHTML = V4.emptyBox('数据恢复后将自动刷新');
          return;
        }
        const accts = (watch && watch.accounts) || [];
        if (!accts.length) {
          $('ovTrust').innerHTML = '<span class="warn">未发现可读取账号</span>';
          $('ovCards').innerHTML = V4.emptyBox('请先在顶部添加并预检账号');
          return;
        }

        // live-watch 已经给出独立状态探针和最近一次可信盘面。先立即绘制，
        // 不让任何经营/罗盘慢接口把工作台留在骨架屏。
        currentData = accts.map(a => mergeCoreAccount(a, {
          dash: a, split: null, rounds: null, pend: null, errors: [],
        }, slowByAccount.get(a.accountId)));
        renderTrust(currentData);
        renderBand(currentData);
        renderCards(currentData);
        renderAlerts(currentData);

        if (watch.background_collection_enabled === false) {
          $('ovTrust').innerHTML = '<span class="warn">按需只读模式 · 连续采集未开启</span>';
          $('ovBand').innerHTML = V4.emptyBox('请让 Agent 按需查询千川数据；连续盯盘指标在此模式下不更新。');
          return;
        }
        // 核心聚合每账号一个请求，后端各子项独立超时；前端再加 12 秒总期限。
        const data = await Promise.all(accts.map(async a => {
          const id = a.accountId;
          const pack = await V4.api('/api/v4-overview', { account: id }, { timeout: 20000 }).catch(error => ({ __error: error }));
          const p = pack || {};
          if (p.split) splitByAccount.set(`${id}|${localDate(0)}`, p.split);
          return mergeCoreAccount(a, p, slowByAccount.get(id));
        }));
        if (dead) return;
        currentData = data;
        renderTrust(currentData);
        renderBand(currentData);
        renderCards(currentData);
        renderAlerts(currentData);
        if (slowByAccount.size) {
          renderValue(currentData);
          renderCf(currentData);
          renderGoods(currentData);
        }
        if (more.open) loadSlow();
        V4.touch();
      }

      async function loadSplitDay(which) {
        splitDay = which === 'yesterday' ? 'yesterday' : 'today';
        view.querySelectorAll('#ovSplitTabs button').forEach(button => button.classList.toggle('on', button.dataset.d === splitDay));
        const date = splitDay === 'today' ? localDate(0) : localDate(-1);
        const targets = currentData.filter(d => !splitByAccount.has(`${d.id}|${date}`));
        if (!targets.length) { renderBand(currentData); return; }
        if (splitFlight) return;
        splitFlight = true;
        renderBand(currentData);
        try {
          await Promise.all(targets.map(async d => {
            const payload = await V4.api('/api/home-split', { account: d.id, date }, { timeout: 20000 })
              .catch(error => ({ __error: error }));
            splitByAccount.set(`${d.id}|${date}`, payload);
          }));
        } finally {
          splitFlight = false;
          if (!dead) renderBand(currentData);
        }
      }
      view.querySelectorAll('#ovSplitTabs button').forEach(button => {
        button.onclick = () => loadSplitDay(button.dataset.d);
      });

      async function loadSlow() {
        if (dead || slowLoading || !currentData.length) return;
        const now = Date.now();
        const targets = currentData.filter(d => {
          const state = slowByAccount.get(d.id);
          return !state || (!state.slowComplete && (!state.slowRetryAt || state.slowRetryAt <= now));
        });
        if (!targets.length) return;
        slowLoading = true;
        $('ovValue').innerHTML = V4.emptyBox('正在读取低频经营数据…');
        $('ovCf').innerHTML = V4.emptyBox('正在读取商品卡数据…');
        $('ovGoods').innerHTML = V4.emptyBox('正在读取商品榜数据…');
        try {
          const packs = await Promise.all(targets.map(async d => {
            const p = await V4.api('/api/v4-overview', { account: d.id, include_slow: 1 }, { timeout: 60000 })
              .catch(error => ({ __error: error }));
            return { id: d.id, pack: p || {} };
          }));
          if (dead) return;
          for (const { id, pack: p } of packs) {
            slowByAccount.set(id, mergeSlowState(slowByAccount.get(id), p));
          }
          currentData = currentData.map(d => ({ ...d, ...(slowByAccount.get(d.id) || {}) }));
          renderValue(currentData);
          renderCf(currentData);
          renderGoods(currentData);
          renderAlerts(currentData);
        } finally {
          slowLoading = false;
        }
      }

      function renderTrust(data) {
        const host = $('ovTrust');
        if (!host) return;
        host.innerHTML = data.map(d => {
          if (d.error) return `<span class="bad">${esc(d.name)} · 读取失败 · ${esc(d.error.code || d.error.message || 'unknown_error')}</span>`;
          const dash = d.dash || {};
          const isLive = !!(d.watch && d.watch.isLive);
          const sourceAt = isLive ? (dash.fetchedAt || dash.liveCheckedAt || null) : (dash.liveCheckedAt || null);
          const age = sourceAt ? Math.max(0, Date.now() - Date.parse(sourceAt)) : null;
          const invalid = isLive && (dash.dataValid !== true || !dash.fetchedAt);
          const stale = dash.status_stale === true || (isLive && dash.stale === true) || !sourceAt;
          const partial = dash.partial === true;
          const cls = invalid ? 'bad' : stale || partial ? 'warn' : 'good';
          const state = invalid ? '在播数据不可用' : stale ? '状态已陈旧' : partial ? '部分数据可用' : isLive ? '数据可信' : '状态可信·未在直播';
          const when = age == null || !Number.isFinite(age) ? '来源时间未知' : `${Math.round(age / 1000)}秒前`;
          return `<span class="${cls}">${esc(d.name)} · ${state} · ${when}</span>`;
        }).join('');
      }

      /* ===== 上线前后对比线索（仅作相关性证据，不作系统收益归因）=====
         上线后累计（截止昨天终值）vs 上线前 7 天（千川首页 /api/overview 区间口径）；
         多赚/少亏 = (后ROI − 前ROI) × 后消耗——反事实法：若 ROI 停留上线前水平，这些消耗少产多少净成交。
         修正1：post 区间截止昨天（终值），今日单列"今日预估"（1h 口径未结算，标注防漂移误读）；
         修正2：补充消耗变化（前日均 vs 后日均），防"消耗收缩被 ROI 差掩盖"——反事实法假设消耗结构不变才成立 */
      function renderValue(data) {
        const box = $('ovValue');
        if (!box) return;
        const metOf = o => ((o && o.data && o.data.row && o.data.row.Metrics) || null);
        const cards = data.map(d => {
          const v = d.value;
          const pm = v && metOf(v.pre), qm = v && metOf(v.post), tm = v && metOf(v.today);
          if (!v || !pm || !qm) {
            return `<div class="pg-ov-gcol"><div class="gh">${esc(d.name)}<span class="s">系统价值</span></div>
              <div style="color:var(--ink-3);font-size:11.5px;padding:8px 0">价值数据暂不可用（接口未返回，下轮重试）</div></div>`;
          }
          const preCost = +pm.stat_cost_for_roi2 || 0, postCost = +qm.stat_cost_for_roi2 || 0;
          const preGmv = +pm.total_order_settle_amount_for_roi2_1h || 0, postGmv = +qm.total_order_settle_amount_for_roi2_1h || 0;
          const preRoi = preCost > 0 ? preGmv / preCost : 0, postRoi = postCost > 0 ? postGmv / postCost : 0;
          const days = Math.max(1, Math.floor((Date.now() - new Date(v.launch + 'T00:00:00').getTime()) / 86400000) + 1);
          const postDays = Math.max(1, Math.round((Date.now() - new Date(v.launch + 'T00:00:00').getTime()) / 86400000)); // 截止昨天
          if (postCost <= 0) {
            return `<div class="pg-ov-gcol"><div class="gh">${esc(d.name)}<span class="s">系统上线第 ${days} 天</span></div>
              <div style="color:var(--ink-3);font-size:11.5px;padding:8px 0">上线首日，数据累计中</div></div>`;
          }
          const gain = (postRoi - preRoi) * postCost;
          const gainCls = gain >= 0 ? 'var(--st-ok)' : 'var(--st-danger)';
          const roiDiff = postRoi - preRoi;
          const roiCls2 = roiDiff >= 0 ? 'var(--st-ok)' : 'var(--st-danger)';
          // 消耗变化（修正2）：前7天日均 vs 后段日均，暴露"盘子收缩/放大"——反事实法的隐含假设
          const preDailyCost = preCost / 7;
          const postDailyCost = postCost / postDays;
          const costDeltaPct = preDailyCost > 0 ? ((postDailyCost - preDailyCost) / preDailyCost * 100) : 0;
          const costCls = costDeltaPct >= 0 ? 'var(--st-ok)' : 'var(--st-warn)';
          // 今日预估（修正1）：1h 口径未结算，单独展示并标注
          let todayBit = '';
          if (tm) {
            const tCost = +tm.stat_cost_for_roi2 || 0, tGmv = +tm.total_order_settle_amount_for_roi2_1h || 0;
            if (tCost > 0) {
              const tRoi = tGmv / tCost;
              todayBit = `<div style="font-size:10.5px;color:var(--ink-3);margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)">今日预估（1h 口径未结算，终值明日落定）：耗 ${fmtMoney(tCost)} · 净成交 ${fmtMoney(tGmv)} · ROI ${tRoi.toFixed(2)}</div>`;
            }
          }
          return `<div class="pg-ov-gcol">
            <div class="gh">${esc(d.name)}<span class="s">观察窗口第 ${days} 天 · 锚定 ${v.launch.slice(5)}</span></div>
            <div style="display:flex;align-items:baseline;gap:14px;margin-top:8px;flex-wrap:wrap">
              <div><div style="font-size:10px;color:var(--ink-3)">净投产比（前 7 天 → 上线后·截止昨日终值）</div>
                <div style="font-size:22px;font-weight:800;font-family:var(--font-data);color:${roiCls2}">${preRoi.toFixed(2)} → ${postRoi.toFixed(2)} <span style="font-size:12px">(${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)})</span></div></div>
              <div><div style="font-size:10px;color:var(--ink-3)">净成交差额线索（按上线前 ROI 水平估算）</div>
                <div style="font-size:22px;font-weight:800;font-family:var(--font-data);color:${gainCls}">${gain >= 0 ? '+' : ''}${fmtMoney(gain)}</div></div>
              <div><div style="font-size:10px;color:var(--ink-3)">日均消耗（前 7 天 → 上线后）</div>
                <div style="font-size:15px;font-weight:700;font-family:var(--font-data);color:${costCls}">${fmtMoney(preDailyCost)} → ${fmtMoney(postDailyCost)} <span style="font-size:11px">(${costDeltaPct >= 0 ? '+' : ''}${costDeltaPct.toFixed(0)}%)</span></div></div>
            </div>
            <div style="font-size:10.5px;color:var(--ink-3);margin-top:8px">前 7 天：消耗 ${fmtMoney(preCost)} · 净成交 ${fmtMoney(preGmv)} ｜ 上线后 ${postDays} 天（终值）：消耗 ${fmtMoney(postCost)} · 净成交 ${fmtMoney(postGmv)}</div>
            ${todayBit}
          </div>`;
        }).join('');
        box.innerHTML = cards;
      }

      /* ===== 商品卡（全域·乘方）两店并排（2026-07-30 维护者拍板：从作战室挪入总览——全局数据归全局页） =====
         数据源：v4-overview 打包的 dash（live-dashboard 全量）的 uni_product（标准全域 mar_goal=1）与 chengfang 段；
         ROI 着色对照各计划自己的 roi_goal（全域=ecpRoi2Goal 综合ROI目标，乘方=愿接受线），不用直播间保本线 */
      function renderCf(data) {
        const box = $('ovCf');
        if (!box) return;
        const rowHtml = (p, viewTag, compTag) => {
          const roi = +(p.roi || 0);
          const goal = +(p.roi_goal || 0);
          const explored = (+p.cost || 0) >= 1; // 消耗<1元=没跑起来，ROI 无意义不着色
          const rc = explored && roi > 0 && goal > 0 ? V4.roiClass(roi, goal) : '';
          return `<div class="b-row">
            <div class="b-top"><span class="b-name" title="${esc(p.name)}"><span class="b-st" style="margin:0 7px 0 0">${viewTag}</span>${esc(p.name)}<span class="b-st">${esc(p.status || '')}</span></span></div>
            <div class="b-m"><span>消耗 <b>${fmtMoney(p.cost)}</b></span><span>成交 <b>${fmtMoney(p.gmv)}</b></span><span>ROI <b${rc ? ` class="${rc}"` : ''}>${explored && roi > 0 ? roi.toFixed(2) : '--'}</b></span><span>目标 <b>${goal ? goal.toFixed(2) : '--'}</b></span>${p.suggest_roi != null ? `<span>官方建议 <b>${(+p.suggest_roi).toFixed(2)}</b></span>` : ''}${compTag || ''}</div>
          </div>`;
        };
        const cols = data.map(d => {
          const dash = d.slowDash || d.dash || {};
          const cf = dash.chengfang;
          const up = dash.uni_product;
          const cfPlans = (cf && cf.has_chengfang && cf.plans) || [];
          const upPlans = (up && up.has_plans && up.plans) || [];
          const sumBits = [];
          if (up && up.has_plans && up.summary) {
            const s = up.summary;
            let t = `全域 消耗 <b>${fmtMoney(s.cost)}</b> 成交 <b>${fmtMoney(s.gmv)}</b>`;
            if (s.roi) t += ` ROI <b>${(+s.roi).toFixed(2)}</b>`;
            sumBits.push(t);
          }
          if (cf && cf.has_chengfang && cf.summary) {
            const s = cf.summary;
            let t = `乘方 消耗 <b>${fmtMoney(s.cost)}</b> 成交 <b>${fmtMoney(s.gmv)}</b>`;
            if (s.roi) t += ` ROI <b>${(+s.roi).toFixed(2)}</b>`;
            if (cf.service_fee_saved) t += ` 服务费减免 <b>${fmtMoney(cf.service_fee_saved)}</b>`;
            sumBits.push(t);
          }
          const rows =
            upPlans.map(p => rowHtml(p, '全域')).join('') +
            cfPlans.map(p => {
              const compTag = p.compensate_status === 2 ? '<span style="color:var(--st-ok)">保障中</span>'
                : p.compensate_status === 4 ? '<span>赔付核实中</span>' : '';
              return rowHtml(p, p.view === 'shop' ? '托管' : '自选', compTag);
            }).join('');
          return `<div class="pg-ov-gcol">
            <div class="gh">${esc(d.name)}<span class="s">${sumBits.join(' · ') || '商品卡计划'}</span></div>
            ${rows || '<div style="color:var(--ink-3);font-size:11.5px;padding:8px 0">未开商品卡计划（全域/乘方均无）</div>'}
          </div>`;
        }).join('');
        box.innerHTML = cols;
      }

      // 快照新鲜度：超过 36h 的罗盘数据不在总览展示（防拿陈数据装新鲜）
      function snapFresh(d) {
        const ts = d.crowd && d.crowd.snapshot && d.crowd.snapshot.collected_at;
        return ts && (Date.now() - new Date(ts).getTime()) < 36 * 3600 * 1000;
      }

      function renderBand(data) {
        const date = splitDay === 'today' ? localDate(0) : localDate(-1);
        $('ovBand').innerHTML = data.map(d => {
          const payload = splitByAccount.get(`${d.id}|${date}`) || (splitDay === 'today' ? d.split : null);
          if (!payload) {
            const splitError = (d.errors || []).find(error => error && error.component === 'home_split');
            const body = splitError
              ? V4.errBox(new Error('千川首页数据读取失败；没有使用本场直播数据代替'))
              : V4.emptyBox(splitFlight ? '正在读取千川首页数据…' : '千川首页数据尚未返回');
            return `<div class="pg-ov-split-account"><div class="pg-ov-split-name">${esc(d.name)} · ${date}</div>${body}</div>`;
          }
          if (payload.__error) {
            return `<div class="pg-ov-split-account"><div class="pg-ov-split-name">${esc(d.name)} · ${date}</div>${V4.errBox(payload.__error)}</div>`;
          }
          const viewData = splitRows(payload);
          if (!viewData.available) {
            return `<div class="pg-ov-split-account"><div class="pg-ov-split-name">${esc(d.name)} · ${date}</div>${V4.emptyBox('千川首页该口径暂不可用；没有使用本场直播数据代替')}</div>`;
          }
          const beAcct = beOf(d);
          const cells = viewData.rows.map(row => {
            const refund = row.refund_rate != null && Number.isFinite(Number(row.refund_rate)) ? Number(row.refund_rate) : null;
            const orders = row.orders != null && Number.isFinite(Number(row.orders)) ? Math.round(Number(row.orders)) : null;
            const roi = row.roi != null && Number.isFinite(Number(row.roi)) ? Number(row.roi) : null;
            return `<div class="pg-ov-split-cell">
              <div class="lab">${esc(row.label)}<span class="rf">退款 ${refund != null ? refund.toFixed(1) + '%' : '--'} · ${orders != null ? orders : '--'} 单${payload.cached ? ' · 终值' : ''}</span></div>
              <div class="cost">${fmtMoney(row.cost)}</div>
              <div class="sub"><span>净成交 <b>${fmtMoney(row.gmv)}</b></span><span>ROI <b class="${roiCls(roi, beAcct)}">${roi != null ? roi.toFixed(2) : '--'}</b></span></div>
            </div>`;
          }).join('');
          return `<div class="pg-ov-split-account"><div class="pg-ov-split-name">${esc(d.name)} · ${date}</div><div class="pg-ov-split-grid">${cells}</div></div>`;
        }).join('');
      }

      function renderCards(data) {
        $('ovCards').innerHTML = '';
        $('ovMeta').textContent = '只放账户状态与 Agent 留痕 · 点击进入直播场次';
        data.forEach(d => {
          const w = d.watch || {};
          const dash = d.dash || {};
          const isLive = !!w.isLive;
          const statusKnown = !!w.liveCheckedAt && w.status_stale !== true;
          // 下播副文案不再重复状态词：今日播过显示场次信息，没播过留空（胶囊始终显示"已下播"）
          const tsSess = dash.today_sessions;
          const played = !isLive && tsSess && tsSess.count > 0;
          let since = played ? `今日已播 ${tsSess.count} 场` : '';
          const start = w.room && (w.room.startTime || w.room.start_time);
          if (isLive && start) {
            const ms = V4.parseT(String(start)).getTime();
            if (ms && Date.now() > ms) since = '已播 ' + V4.durTxt(Date.now() - ms);
          }
          const alerts = (dash.riskAlerts || []).length + (dash.suggestions || []).length;
          const rounds = (d.rounds && d.rounds.rounds) || [];
          const latestRound = rounds[0];
          const pendN = ((d.pend && d.pend.items) || []).length;
          const dataState = d.error ? '读取失败' : (w.status_stale || dash.stale) ? '已陈旧' : dash.partial ? '部分可用' : '可信';
          const pq = dash.plan || {};

          // ---- 罗盘快照 enrich（2026-07-26）：新鲜才显示，断档/陈旧整体隐藏不装坏 ----
          const snap = snapFresh(d) ? d.crowd.snapshot : null;
          const prof = snap && snap.profile;
          const pc = snap && snap.prod_crowd;
          const lc = snap && snap.live_crowd;

          // 罗盘快照更新时间与手动刷新按钮（2026-07-26 优化：让用户知道不是实时，并能手动触发采集）
          let snapLine = '';
          if (d.crowd && d.crowd.snapshot && d.crowd.snapshot.collected_at) {
            const ts = new Date(d.crowd.snapshot.collected_at).getTime();
            const ageH = Math.floor((Date.now() - ts) / 3600000);
            const ageTxt = ageH < 1 ? '1小时内' : ageH + '小时前';
            snapLine = `<div class="pg-ov-crowd" style="color:var(--ink-3);font-size:10.5px;align-items:center">
              <span>罗盘更新于 ${ageTxt}</span>
              <button class="pg-ov-refresh" data-acct="${esc(d.id)}" style="font-size:10px;padding:1px 6px;border-radius:99px;border:1px solid var(--line);background:transparent;color:var(--ink-3);cursor:pointer">刷新</button>
            </div>`;
          }

          // 人群行：top 八大人群 + 性别 top + 年龄 top1
          let crowdLine = '';
          if (prof) {
            const topC = [...(prof.consumer || [])].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
            const topS = [...(prof.sex || [])].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
            const topA = [...(prof.age || [])].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
            const bits = [];
            if (topC) bits.push(`<span class="tag8">${esc(topC.name)} ${(topC.value * 100).toFixed(0)}%</span>`);
            if (topS) bits.push(`${esc(/性$/.test(topS.name) ? topS.name : topS.name + '性')} ${(topS.value * 100).toFixed(0)}%`);
            if (topA) bits.push(`${esc(topA.name)} ${(topA.value * 100).toFixed(0)}%`);
            if (bits.length) crowdLine = `<div class="pg-ov-crowd"><span style="color:var(--ink-3)">人群</span>${bits.join('')}</div>`;
          }

          // 商品漏斗行：曝光→点击→加购→成交（近7天） + 同行竞争人群
          let funnelLine = '';
          if (pc && pc.funnel && pc.funnel.exposure_crowd) {
            const f = pc.funnel;
            const steps = [
              ['曝光', f.exposure_crowd.value], ['点击', f.click_crowd && f.click_crowd.value],
              ['加购', f.shopping_cart_crowd && f.shopping_cart_crowd.value], ['成交', f.purchase_crowd && f.purchase_crowd.value],
            ].filter(s => s[1] != null);
            const max = steps[0] ? steps[0][1] || 1 : 1;
            const rows = steps.map(([nm, v], i) => {
              const prev = i > 0 ? steps[i - 1][1] : 0;
              // 上级不是严格父级时（成交人群多未经加购直接购买，成交>加购），v/prev 会爆 >100%——
              // 回退为相对首步（曝光）的转化率，口径与罗盘"曝光-成交转化"一致
              const denom = (i > 0 && prev > 0 && v <= prev) ? prev : max;
              const conv = i > 0 && denom > 0 ? ` ${(v / denom * 100).toFixed(1)}%` : '';
              return `<div class="fr"><span>${nm}</span><div class="bar"><i class="${i === steps.length - 1 ? 'hot' : ''}" style="width:${Math.max(2, v / max * 100).toFixed(1)}%"></i></div><span style="text-align:right;font-family:var(--mono)">${(+v).toLocaleString()}${conv}</span></div>`;
            }).join('');
            const peerV = pc.loss && pc.loss.peer_crowd && pc.loss.peer_crowd.value;
            funnelLine = `<div class="pg-ov-funnel">${rows}
              ${peerV != null ? `<div class="fr peer"><span>流失</span><div></div><span style="text-align:right;font-family:var(--mono)">${(+peerV).toLocaleString()} 同行买</span></div>` : ''}
            </div>`;
          }

          // 最近一场直播行
          let liveLine = '';
          if (lc && lc.room && lc.room.live_time) {
            const r = lc.room;
            const wV = lc.crowd && lc.crowd.watch && lc.crowd.watch.value;
            const pV = lc.crowd && lc.crowd.purchase && lc.crowd.purchase.value;
            const rate = wV > 0 && pV != null ? `（${(pV / wV * 100).toFixed(1)}%）` : '';
            liveLine = `<div class="pg-ov-lastlive">最近直播 ${esc(String(r.live_time).split(' ')[0])} · 支付 <b>¥${r.pay_amt_yuan != null ? r.pay_amt_yuan.toLocaleString() : '--'}</b> · 观看 <b>${wV != null ? wV.toLocaleString() : '--'}</b> / 成交 <b>${pV != null ? pV : '--'}${rate}</b></div>`;
          }

          // home-split：推商品 vs 推直播间流量拆分
          let splitLine = '';
          if (d.split && d.split.ok) {
            const sProd = d.split.product || {};
            const sLive = d.split.live || {};
            if (sProd.cost > 0 || sLive.cost > 0) {
              const pGmv = sProd.gmv > 0 ? ` (净¥${sProd.gmv.toLocaleString()})` : '';
              const lGmv = sLive.gmv > 0 ? ` (净¥${sLive.gmv.toLocaleString()})` : '';
              splitLine = `<div class="pg-ov-dd" style="margin-top:6px;border-top:1px dashed var(--line);padding-top:6px">
                <span><i>推商品</i><b>¥${sProd.cost.toLocaleString()}${pGmv}</b></span>
                <span><i>推直播间</i><b>¥${sLive.cost.toLocaleString()}${lGmv}</b></span>
              </div>`;
            }
          }

          // 历史账户专用说明已从试用包移除。
          let quotaLine = '';
          if (pq && (pq.quota_left != null || pq.quota_exceeded || pq.other_plans)) {
            const qd = pq.quota_detail || {};
            quotaLine = `<div class="pg-ov-dd" style="margin-top:6px;border-top:1px dashed var(--line);padding-top:6px">
              <span><i>追投额度</i><b style="${pq.quota_exceeded ? 'color:var(--st-danger)' : ''}">${pq.quota_exceeded ? '已用完' : fmtM(pq.quota_left)}</b></span>
              <span><i>${pq.quota_source === 'api' ? '今日预算' : '日均×30%'}</i><b>${qd.daily != null ? fmtM(qd.daily) : '--'}</b></span>
              <span><i>在投占用</i><b>${qd.in_use != null ? fmtM(qd.in_use) : '--'}</b></span>
              <span><i>停删消耗</i><b>${qd.used_cost != null ? fmtM(qd.used_cost) : '--'}</b></span>
              <span><i>口径</i><b>${pq.quota_source === 'api' ? '接口真值·周一重算' : '近14日估算'}</b></span>
              ${pq.other_plans ? `<span><i>另${pq.plan_count - 1}计划</i><b>${pq.other_plans.map(o => `出价${(+o.roi_goal).toFixed(2)}（${fmtM(o.budget)}）`).join('；')}</b></span>` : ''}
            </div>`;
          }

          const card = document.createElement('div');
          card.className = 'pg-ov-card';
          card.innerHTML = `
            <div class="pg-ov-h">
              <span class="nm">${esc(d.name)}</span>
              <span class="st ${isLive ? 'live' : ''}">${!statusKnown ? '状态未知' : isLive ? '直播中' : '未在直播'}</span>
              <span style="font-size:10.5px;color:var(--ink-3)">${esc(since)}</span>
              <span class="go">作战室 →</span>
            </div>
            <div class="pg-ov-kpis">
              <div class="pg-ov-kpi"><div class="l">Agent 轮次</div><div class="v">${rounds.length}</div></div>
              <div class="pg-ov-kpi"><div class="l">风险信号</div><div class="v ${alerts ? 'wn' : ''}">${alerts}</div></div>
              <div class="pg-ov-kpi"><div class="l">待执行</div><div class="v ${pendN ? 'wn' : ''}">${pendN}</div></div>
              <div class="pg-ov-kpi"><div class="l">数据状态</div><div class="v" style="font-size:15px">${dataState}</div></div>
            </div>
            <div class="pg-ov-ops">
              ${latestRound ? `<span class="dec" title="${esc(latestRound.title || '')}">最近决策：${esc((latestRound.title || '').slice(0, 40))}</span>` : '<span class="dec">最近决策：暂无</span>'}
            </div>`;
          card.onclick = () => { V4.setAcct(d.id); location.hash = '#/warroom'; };
          // 罗盘手动刷新：触发采集器后台拉新，10 分钟限频（与后端 /api/compass/refresh 对齐）
          const refreshBtn = card.querySelector('.pg-ov-refresh');
          if (refreshBtn) {
            refreshBtn.onclick = async (e) => {
              e.stopPropagation();
              const acct = refreshBtn.dataset.acct;
              const key = 'v4-compass-refresh-' + acct;
              const last = +localStorage.getItem(key) || 0;
              if (Date.now() - last < 600000) {
                refreshBtn.textContent = '冷却中';
                setTimeout(() => { refreshBtn.textContent = '刷新'; }, 2000);
                return;
              }
              refreshBtn.textContent = '采集中…';
              refreshBtn.disabled = true;
              try {
                const r = await V4.apiPost('/api/compass/refresh', { account: acct, range: '30d' });
                if (r && r.ok) {
                  localStorage.setItem(key, String(Date.now()));
                  refreshBtn.textContent = '已触发';
                  setTimeout(() => { refreshBtn.textContent = '刷新'; refreshBtn.disabled = false; }, 5000);
                } else {
                  refreshBtn.textContent = '失败';
                  setTimeout(() => { refreshBtn.textContent = '刷新'; refreshBtn.disabled = false; }, 3000);
                }
              } catch (err) {
                refreshBtn.textContent = '失败';
                setTimeout(() => { refreshBtn.textContent = '刷新'; refreshBtn.disabled = false; }, 3000);
              }
            };
          }
          $('ovCards').appendChild(card);
        });
      }

      /* 商品榜 Top5：两账号并排，罗盘商品榜（近7天，缓存口径） */
      function renderGoods(data) {
        const box = $('ovGoods');
        if (!box) return;
        const cols = data.map(d => {
          const rows = (((d.goods && d.goods.goods) || [])).filter(g => (g.pay_amt || 0) > 0).slice(0, 5);
          if (!rows.length) return '';
          const body = rows.map((g, i) => `
            <div class="pg-ov-grow">
              <span class="nm" title="${esc(g.name)}">${i + 1}. ${esc(g.name)}</span>
              <span class="m">¥${(g.pay_amt || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</span>
              <span class="m" style="color:var(--ink-3)">净¥${(g.net_trans_amt || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</span>
              <span class="m" style="color:var(--ink-3)">${g.pay_cnt ?? '--'}单</span>
            </div>`).join('');
          return `<div class="pg-ov-gcol">
            <div class="gh">${esc(d.name)}<span class="s">成交金额·支付口径 / 净成交·退款后（净>支付为官方口径特性）</span></div>
            <div class="pg-ov-grow hd"><span>商品</span><span class="m">成交金额</span><span class="m">净成交</span><span class="m">订单</span></div>
            ${body}
          </div>`;
        }).filter(Boolean).join('');
        box.innerHTML = cols || '<div style="color:var(--ink-3);font-size:12px;padding:10px 2px">暂无商品榜数据（罗盘缓存缺失或取数失败，不影响其他板块）</div>';
      }

      function renderAlerts(data) {
        const items = [];
        data.forEach(d => {
          if (d.error) items.push({ lv: 'danger', acct: d.name, msg: `核心盘面读取失败：${d.error.code || d.error.message || 'unknown_error'}` });
          if (d.slowError) items.push({ lv: 'warn', acct: d.name, msg: `低频诊断读取失败：${d.slowError.code || d.slowError.message || 'unknown_error'}` });
          [...(d.errors || []), ...(d.slowErrors || [])].forEach(error => {
            items.push({ lv: 'warn', acct: d.name, msg: `${error.component || '子项'}：${error.message || error.code || '读取失败'}` });
          });
          ((d.dash && d.dash.riskAlerts) || []).forEach(a => items.push({ lv: a.level === 'danger' ? 'danger' : 'warn', acct: d.name, msg: a.msg }));
          ((d.dash && d.dash.suggestions) || []).forEach(s => items.push({ lv: (s.level === 'warn' || s.level === 'warning') ? 'warn' : 'info', acct: d.name, msg: s.msg }));
        });
        items.sort((a, b) => (a.lv === 'danger' ? 0 : 1) - (b.lv === 'danger' ? 0 : 1));
        $('ovAlCnt').textContent = items.length ? items.length + ' 条' : '';
        $('ovAlerts').innerHTML = items.length ? items.slice(0, 10).map(a =>
          `<div class="pg-ov-al ${a.lv}"><span class="tag">${esc(a.acct)}</span><span>${esc(a.msg)}</span></div>`).join('')
          : '<div style="color:var(--ink-3);font-size:12px;padding:10px 0">暂无已记录的风险信号；请结合上方数据状态判断</div>';
      }

      const onResize = () => sparks.forEach(s => drawSpark(s.cv, s.trend, s.be));
      addEventListener('resize', onResize);
      const more = $('ovMore');
      const onMoreToggle = () => { if (more.open) loadSlow(); };
      more.addEventListener('toggle', onMoreToggle);
      $('ovValue').innerHTML = V4.emptyBox('展开后按需读取，不占用工作台首屏时间');
      $('ovCf').innerHTML = V4.emptyBox('展开后按需读取，不占用工作台首屏时间');
      $('ovGoods').innerHTML = V4.emptyBox('展开后按需读取，不占用工作台首屏时间');

      load();
      stoppers.push(V4.poll(load, 30000));
      return function unmount() {
        dead = true;
        stoppers.forEach(s => s());
        removeEventListener('resize', onResize);
        more.removeEventListener('toggle', onMoreToggle);
      };
    },
  };

})(window.V4);
