/* ===== 千川数据工作台 v4 · 素材诊断 ===== */
(function (V4) {
  'use strict';
  const { $, esc, fmtM, odo, fitV } = V4;
  const validNum = n => n !== null && n !== undefined && n !== '' && Number.isFinite(+n);
  const fmtNum = n => validNum(n) ? Number(n).toLocaleString('zh-CN') : '--';
  const fmtPct = v => validNum(v) ? (Math.round(+v * 1000) / 10).toFixed(1) + '%' : '--';

  /* 页面专属样式：全部 pg-mat- 前缀，不动 v4.css */
  const CSS = `
  .pg-mat-board { display:grid; grid-template-columns:repeat(4,1fr); gap:26px; margin-top:16px; }
  .pg-mat-board > div { min-width:0; } /* 网格项默认可被 nowrap 内容撑宽，窄屏假溢出 */
  .pg-mat-bc-head { display:flex; align-items:baseline; gap:9px; padding-bottom:10px;
    border-bottom:1px solid var(--line-2); margin-bottom:2px; }
  .pg-mat-bc-name { font-size:13px; font-weight:700; color:var(--ink-2); }
  .pg-mat-bc-hint { font-size:10px; color:var(--ink-3); letter-spacing:.05em; }
  .pg-mat-bc-count { margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--ink-3); }
  .pg-mat-mc { padding:11px 4px 10px; border-top:1px solid var(--line); cursor:pointer; transition:background .2s; }
  .pg-mat-mc:first-of-type { border-top:0; }
  .pg-mat-mc:hover { background:rgba(148,163,184,.045); }
  .pg-mat-mc-name { font-size:12.5px; font-weight:600; color:var(--ink-2); line-height:1.5;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pg-mat-mc:hover .pg-mat-mc-name { color:var(--ink); }
  .pg-mat-mc-m { display:flex; gap:13px; margin-top:5px; font-size:11px; color:var(--ink-3); flex-wrap:wrap; align-items:center; }
  .pg-mat-mc-m span { white-space:nowrap; }
  .pg-mat-mc-m b { font-family:var(--mono); font-variant-numeric:tabular-nums; font-weight:600; color:var(--ink-2); }
  .pg-mat-mc-m b.bad { color:var(--danger); }
  .pg-mat-mc-m b.warn { color:var(--st-warn); }
  .pg-mat-mc-m b.top, .pg-mat-mc-m b.good { color:var(--st-ok); }
  .pg-mat-mc-m b.gold { color:var(--gold); } /* 不用 .top：v4.css 的顶条 .top{display:flex} 会污染裸 class */
  .pg-mat-spark { width:64px; height:16px; display:block; margin-left:auto; flex:none; }

  .pg-mat-lists { display:grid; grid-template-columns:1fr 1fr; gap:26px; margin-top:34px; }
  .pg-mat-rk { font-family:var(--mono); font-size:10.5px; color:var(--ink-3); width:16px; flex:none; }
  .pg-mat-c { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:11px; color:var(--ink-3); }

  .pg-mat-tip { position:fixed; display:none; z-index:40; background:rgba(8,12,20,.96); border:1px solid var(--line-2); border-radius:8px; padding:7px 10px; font-size:11px; line-height:1.7; color:var(--ink-2); pointer-events:none; white-space:nowrap; box-shadow:0 4px 16px rgba(0,0,0,.45); }
  .pg-mat-tip b { color:var(--ink-1); font-family:var(--mono); }
  .pg-mat-mask { position:fixed; inset:0; background:rgba(5,8,12,.62); z-index:30;
    opacity:0; pointer-events:none; transition:opacity .3s; }
  .pg-mat-mask.on { opacity:1; pointer-events:auto; }
  .pg-mat-drawer { position:fixed; top:0; right:0; width:50vw; max-width:96vw; height:100%; z-index:31;
    background:var(--panel); border-left:1px solid var(--line-2); transform:translateX(103%);
    display:none; /* 关态不占位：translate 出屏的 fixed 元素会被 Chromium 算进文档 scrollWidth（390 下假溢出 188px） */
    visibility:hidden; transition:transform .38s cubic-bezier(.25,.8,.25,1), visibility 0s .38s;
    overflow-y:auto; padding:20px 26px 44px; }
  .pg-mat-drawer.on { transform:none; visibility:visible; transition:transform .38s cubic-bezier(.25,.8,.25,1), visibility 0s 0s; }
  .pg-mat-dw-head { display:flex; justify-content:space-between; align-items:flex-start; gap:14px;
    padding-bottom:14px; border-bottom:1px solid var(--line-2); }
  .pg-mat-dw-name { font-size:15px; font-weight:700; line-height:1.5; }
  .pg-mat-dw-stage { font-size:11px; color:var(--ink-3); margin-top:4px; }
  .pg-mat-dw-stage b { color:var(--ink-2); font-weight:600; }
  .pg-mat-dw-x { border:1px solid var(--line-2); background:transparent; color:var(--ink-3); width:26px; height:26px;
    border-radius:7px; cursor:pointer; font-size:14px; line-height:1; flex:none; transition:.15s; }
  .pg-mat-dw-x:hover { color:var(--ink); border-color:var(--steel); }
  .pg-mat-dw-sec { margin-top:17px; }
  .pg-mat-dw-sec > .sec-title { margin-bottom:8px; }
  .pg-mat-dw-grid { display:grid; grid-template-columns:1fr 1fr; border-top:1px solid var(--line); }
  .pg-mat-dw-kv { padding:8px 0; border-bottom:1px solid var(--line); }
  .pg-mat-dw-kv:nth-child(odd) { border-right:1px solid var(--line); padding-right:14px; }
  .pg-mat-dw-kv:nth-child(even) { padding-left:14px; }
  .pg-mat-dw-kv .k { font-size:10px; color:var(--ink-3); letter-spacing:.12em; }
  .pg-mat-dw-kv .v { font-size:13px; font-weight:600; margin-top:3px; }
  .pg-mat-dw-kv .v.num { font-size:15px; font-weight:650; font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .pg-mat-dw-kv .v.bad { color:var(--danger); }
  .pg-mat-dw-kv .v.warn { color:var(--st-warn); }
  .pg-mat-dw-kv .v.top, .pg-mat-dw-kv .v.good { color:var(--st-ok); }
  .pg-mat-dw-kv .v.gold { color:var(--gold); }
  .pg-mat-dw-chart { width:100%; display:block; cursor:crosshair; }
  .pg-mat-cbox { position:relative; } /* 悬停提示框绝对定位锚点 */
  .pg-mat-lg { display:flex; gap:16px; font-size:10.5px; color:var(--ink-3); margin-top:7px; align-items:center; }
  .pg-mat-lg span { white-space:nowrap; }
  .pg-mat-lg i { display:inline-block; width:15px; height:0; border-top:2px solid; vertical-align:middle; margin-right:5px; }
  .pg-mat-lg i.dash { border-top-style:dashed; border-top-width:1px; }
  .pg-mat-au-row { display:grid; grid-template-columns:46px 1fr 40px; gap:10px; align-items:center;
    padding:6px 0; border-top:1px solid var(--line); }
  .pg-mat-au-row:first-of-type { border-top:0; }
  .pg-mat-au-l { font-size:11px; color:var(--ink-3); }
  .pg-mat-au-bar { height:4px; background:rgba(148,163,184,.12); border-radius:2px; overflow:hidden; }
  .pg-mat-au-bar i { display:block; height:100%; background:var(--steel); border-radius:2px; }
  .pg-mat-au-v { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:11px; color:var(--ink-2); text-align:right; }
  .pg-mat-au-sep { font-size:10px; color:var(--ink-3); letter-spacing:.14em; padding:10px 0 2px; }
  .pg-mat-ret-m { display:flex; gap:16px; margin-top:7px; font-size:10.5px; color:var(--ink-3); }
  .pg-mat-ret-m b { font-family:var(--mono); font-variant-numeric:tabular-nums; color:var(--ink-2); font-weight:600; }
  .pg-mat-au-block { margin-top:14px; }
  .pg-mat-au-block:first-of-type { margin-top:0; }
  .pg-mat-au-t { font-size:11.5px; font-weight:650; color:var(--ink-2); margin-bottom:8px; }
  .pg-mat-au-chart { width:100%; max-height:180px; height:auto; display:block; }
  .pg-mat-au-chart text { fill:var(--ink-3); font-size:10px; font-family:var(--mono); }
  .pg-mat-au-chart line.grid { stroke:rgba(148,163,184,.12); stroke-width:1; }
  .pg-mat-au-chart rect.bar { rx:2; cursor:pointer; transition:opacity .15s; }
  .pg-mat-au-chart rect.bar:hover { opacity:.75; }
  .pg-mat-donuts { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .pg-mat-donut { text-align:center; }
  .pg-mat-donut svg { width:100%; max-height:150px; height:auto; }
  .pg-mat-donut path { cursor:pointer; transition:opacity .15s; }
  .pg-mat-donut path:hover { opacity:.75; }
  .pg-mat-donut .dn-t { font-size:11px; color:var(--ink-2); margin-top:6px; font-weight:600; }
  .pg-mat-donut .dn-leg { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:6px; font-size:10px; color:var(--ink-3); }
  .pg-mat-donut .dn-leg span { display:inline-flex; align-items:center; gap:4px; }
  .pg-mat-donut .dn-leg i { width:7px; height:7px; border-radius:50%; display:inline-block; }
  .pg-mat-au-tabs { display:flex; gap:6px; margin-bottom:8px; }
  .pg-mat-au-tabs button { border:1px solid var(--line-2); background:transparent; color:var(--ink-3);
    font-size:11px; padding:3px 9px; border-radius:6px; cursor:pointer; }
  .pg-mat-au-tabs button.on { color:var(--ink); border-color:var(--steel); background:var(--bg-raised); }
  .pg-mat-clickdrop { display:flex; flex-direction:column; gap:10px; margin-top:6px; }
  .pg-mat-clickdrop .cd-tabs { display:flex; gap:6px; }
  .pg-mat-clickdrop .cd-tabs button { border:1px solid var(--line-2); background:transparent; color:var(--ink-3);
    font-size:11px; padding:4px 10px; border-radius:6px; cursor:pointer; }
  .pg-mat-clickdrop .cd-tabs button.on { color:var(--ink); border-color:var(--steel); background:var(--bg-raised); }
  .pg-mat-clickdrop .cd-chart-wrap { background:var(--bg-raised); border:1px solid var(--line); border-radius:8px; padding:12px 14px 10px; }
  .pg-mat-clickdrop .cd-insight { font-size:11px; color:var(--ink-2); margin-bottom:8px; line-height:1.6; }
  .pg-mat-clickdrop .cd-insight b { font-family:var(--mono); color:var(--ink); }
  .pg-mat-clickdrop .cd-chart { width:100%; max-height:180px; height:auto; display:block; }
  .pg-mat-clickdrop .cd-chart text { fill:var(--ink-3); font-size:9px; font-family:var(--mono); }
  .pg-mat-clickdrop .cd-chart line.grid { stroke:rgba(148,163,184,.12); stroke-width:1; }
  .pg-mat-clickdrop .cd-chart polyline { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .pg-mat-clickdrop .cd-chart .area { fill-opacity:.12; stroke:none; }
  .pg-mat-clickdrop .cd-chart .peak { stroke:#fff; stroke-width:1.5; }
  .pg-mat-clickdrop .cd-chart .cd-guide { stroke:rgba(226,232,240,.35); stroke-width:1; stroke-dasharray:3 3; }
  .pg-mat-clickdrop .cd-chart .cd-hit { pointer-events:all; }
  .pg-mat-clickdrop .cd-totals { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .pg-mat-clickdrop .cd-cell { background:var(--bg-raised); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .pg-mat-clickdrop .cd-lab { font-size:11px; color:var(--ink-3); }
  .pg-mat-clickdrop .cd-val { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:24px; font-weight:700; color:var(--ink-1); margin-top:4px; }
  .pg-mat-clickdrop .cd-val.drop { color:var(--danger); }
  .pg-mat-dw-note { font-size:12.5px; color:var(--ink-2); line-height:1.9; white-space:pre-wrap; }
  .pg-mat-dw-summary { font-size:11.5px; color:var(--ink-3); line-height:1.8; margin-top:6px; }
  .pg-mat-load { font-size:11px; color:var(--ink-3); padding:14px 0; }
  .pg-mat-tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .pg-mat-tag { font-size:10.5px; color:var(--ink-2); border:1px solid var(--line-2); border-radius:6px; padding:3px 8px; }
  .pg-mat-rename { display:grid; grid-template-columns:112px 1fr auto; gap:8px; align-items:center; }
  .pg-mat-rename select, .pg-mat-rename input { min-width:0; background:var(--bg-1); border:1px solid var(--line-2); border-radius:6px; padding:7px 9px; color:var(--ink-1); font:12px/1.4 inherit; }
  .pg-mat-rename button { border:1px solid var(--steel); background:var(--bg-raised); color:var(--ink-1); border-radius:6px; padding:7px 12px; cursor:pointer; white-space:nowrap; }
  .pg-mat-rename button:disabled { opacity:.45; cursor:not-allowed; }
  .pg-mat-rename-state { margin-top:7px; min-height:18px; color:var(--ink-3); font-size:11px; line-height:1.6; }
  .pg-mat-rename-state.ok { color:var(--st-ok); }
  .pg-mat-rename-state.bad { color:var(--danger); }

  /* 搜索与排序工具栏 */
  .pg-mat-tools { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:10px 0 6px; }
  .pg-mat-search { position:relative; flex:1; min-width:220px; }
  .pg-mat-search input { width:100%; background:var(--bg-1); border:1px solid var(--line); border-radius:6px; padding:6px 12px 6px 30px; color:var(--ink-1); font-size:12px; font-family:inherit; }
  .pg-mat-search input:focus { outline:none; border-color:var(--steel); }
  .pg-mat-search i { position:absolute; left:10px; top:50%; transform:translateY(-50%); font-size:12px; color:var(--ink-3); font-style:normal; pointer-events:none; }
  .pg-mat-select { background:var(--bg-1); border:1px solid var(--line); border-radius:6px; padding:6px 10px; color:var(--ink-1); font-size:12px; font-family:inherit; cursor:pointer; }
  .pg-mat-select:focus { outline:none; border-color:var(--steel); }
  .pg-mat-select option { background:#0d1322; color:#e2e8f0; }

  @media (max-width:1100px) {
    .pg-mat-board { grid-template-columns:1fr 1fr; }
    .pg-mat-lists { grid-template-columns:1fr; }
  }
  @media (max-width:640px) {
    .pg-mat-board { grid-template-columns:1fr; }
    .pg-mat-lists { grid-template-columns:1fr; }
    .pg-mat-drawer { width:96vw; padding:16px 16px 34px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pg-mat-mask, .pg-mat-drawer, .pg-mat-mc, .pg-mat-dw-x { transition:none !important; }
  }`;

  const HTML = `
  <style>${CSS}</style>
  <section><div class="sec-title">素材诊断 <span class="cd">生命周期 · 实际表现</span></div></section>
  <section>
    <div class="sec-title">素材数据概览 <span class="cd" id="pgMatOvCd"></span></div>
    <div class="vitals">
      <div class="vital"><div class="l">在投素材</div><div class="v num" id="pgMatVN">-</div><div class="s" id="pgMatVNs"></div></div>
      <div class="vital"><div class="l">累计消耗</div><div class="v num" id="pgMatVCost">-</div><div class="s">全部在投素材合计</div></div>
      <div class="vital"><div class="l">累计净成交</div><div class="v num" id="pgMatVGmv">-</div><div class="s">扣退款口径</div></div>
      <div class="vital"><div class="l">综合净ROI</div><div class="v num" id="pgMatVRoi">-</div><div class="s" id="pgMatVRoiS"></div></div>
      <div class="vital"><div class="l">保本达成</div><div class="v num" id="pgMatVPass">-</div><div class="s" id="pgMatVPassS"></div></div>
    </div>
  </section>

  <section style="margin-top:30px">
    <div class="sec-title">素材生命周期 <span class="cd">点击卡片查看素材详情</span></div>
    <div class="pg-mat-tools">
      <div class="pg-mat-search">
        <i>🔍</i>
        <input type="text" id="pgMatSearch" placeholder="搜索素材名称或 ID..." autocomplete="off">
      </div>
      <select class="pg-mat-select" id="pgMatSort">
        <option value="cost_desc">消耗从高到低</option>
        <option value="cost_asc">消耗从低到高</option>
        <option value="roi_desc">净ROI从高到低</option>
        <option value="roi_asc">净ROI从低到高</option>
        <option value="days_desc">上线天数从长到短</option>
        <option value="days_asc">上线天数从短到长</option>
      </select>
    </div>
    <div class="pg-mat-board" id="pgMatBoard">${V4.emptyBox('加载中…')}</div>
  </section>

  <section class="pg-mat-lists">
    <div class="block">
      <div class="sec-title">净ROI 较高 <span class="cd">仅排序，不等于追投指令</span></div>
      <div id="pgMatRed">${V4.emptyBox('加载中…')}</div>
    </div>
    <div class="block">
      <div class="sec-title">高消耗低回报 <span class="cd">需要结合场次与完整周期复核</span></div>
      <div id="pgMatBlack">${V4.emptyBox('加载中…')}</div>
    </div>
  </section>

  <div class="pg-mat-mask" id="pgMatMask"></div>
  <aside class="pg-mat-drawer" id="pgMatDrawer" aria-label="素材详情">
    <div class="pg-mat-tip" id="pgMatTip"></div>
    <div class="pg-mat-dw-head">
      <div>
        <div class="pg-mat-dw-name" id="pgMatDwName"></div>
        <div class="pg-mat-dw-stage" id="pgMatDwStage"></div>
      </div>
      <button class="pg-mat-dw-x" id="pgMatDwX" aria-label="关闭">×</button>
    </div>
    <div class="pg-mat-dw-sec">
      <div class="sec-title">基础信息</div>
      <div class="pg-mat-dw-grid" id="pgMatDwGrid"></div>
    </div>
    <div class="pg-mat-dw-sec">
      <div class="sec-title">近30天 · 消耗 × 净ROI</div>
      <div class="pg-mat-cbox" id="pgMatDwChartBox"><div class="pg-mat-load">加载中…（千川实时，约 20 秒）</div></div>
      <div class="pg-mat-lg">
        <span><i style="border-color:#7EA6FF"></i>日消耗</span>
        <span><i style="border-color:#5FD68B"></i>净ROI</span>
        <span><i class="dash" style="border-color:rgba(245,184,78,.5)"></i><span id="pgMatLgBe">保本</span></span>
      </div>
    </div>
    <div class="pg-mat-dw-sec">
      <div class="sec-title">人群画像 · 成交用户</div>
      <div id="pgMatDwAu"><div class="pg-mat-load">加载中…</div></div>
    </div>
    <div class="pg-mat-dw-sec">
      <div class="sec-title">点击与流失 <span class="cd" id="pgMatRetTag"></span></div>
      <div class="pg-mat-clickdrop" id="pgMatDwRetBox"><div class="pg-mat-load">加载中…</div></div>
      <div class="pg-mat-ret-m" id="pgMatDwRetM"></div>
    </div>
    <div class="pg-mat-dw-sec">
      <div class="sec-title">脚本摘要</div>
      <div class="pg-mat-dw-note" id="pgMatDwNote">加载中…</div>
      <div class="pg-mat-tags" id="pgMatDwTags"></div>
      <div class="pg-mat-dw-summary" id="pgMatDwSummary"></div>
    </div>
    <div class="pg-mat-dw-sec">
      <div class="sec-title">素材角色与命名 <span class="cd">先预览，确认后才写入千川</span></div>
      <div class="pg-mat-rename">
        <select id="pgMatRenameRole" aria-label="素材角色">
          <option value="">选择角色</option>
          <option value="种草">种草</option>
          <option value="收割">收割</option>
          <option value="承接">承接</option>
          <option value="探索">探索</option>
          <option value="待定">待定</option>
        </select>
        <input id="pgMatRenamePreview" type="text" maxlength="50" readonly aria-label="新素材名称预览">
        <button id="pgMatRenameBtn" type="button" disabled>预检并改名</button>
      </div>
      <div class="pg-mat-rename-state" id="pgMatRenameState">选择角色后生成名称预览；不会自动批量改名。</div>
    </div>
  </aside>`;

  /* 列映射：接口列 → 展示定义（列头按健康度着色：探索=live 验证=warn S级=ok 衰退=danger 归档=ink-3） */
  const STAGES = [
    { key: 'explore',   name: '探索期', hint: '近90天累计消耗 < 客单价×1.5，且为新素材或近期有消耗', color: 'var(--st-live)' },
    { key: 'verifying', name: '成长期', hint: '过探索线 · 验证加投中', color: 'var(--st-warn)' },
    { key: 's_level',   name: '稳定期', hint: '账号动态：消耗前70%贡献者 + 有效活跃≥5天', color: 'var(--st-ok)' },
    { key: 'declining', name: '衰退期', hint: '近7日ROI较峰值跌 ≥50% · 建议汰换', color: 'var(--st-danger)' },
    { key: 'archived',  name: '沉睡',   hint: '上线久、近期无活跃、近7日消耗 < 10 元的归档素材', color: 'var(--ink-3)' },
  ];

  /* ROI 状态色：统一走共享口径（≥保本 ok / 保本×0.8~1.0 warn / <保本×0.8 danger） */
  const roiCls = (r, be) => V4.roiClass(r, be);

  /* AIGC/LIVE 集合：功能开关而非素材，没有"上线几天"的概念——cost_total>0 即投放中，否则未开启 */
  const isAigcSet = m => String(m.name || '').includes('AIGC')
    || ['-', '-2'].includes(String(m.material_id))
    || /^(AIGC|LIVE)::/.test(String(m.material_id || ''));

  /* spark7d 迷你走势：inline SVG 单色钢色 */
  function spark(arr) {
    const a = (arr || []).map(v => +v || 0);
    if (!a.length) return '';
    const W = 64, H = 16, max = Math.max(...a, 0.01);
    const pts = a.map((v, i) =>
      (i / ((a.length - 1) || 1) * (W - 2) + 1).toFixed(1) + ',' + (H - 2 - v / max * (H - 4)).toFixed(1)
    ).join(' ');
    return `<svg class="pg-mat-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="#7C8DA6" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  }

  V4.pages.materials = {
    mount(view) {
      view.innerHTML = HTML;
      const S = {
        be: V4.breakEven(), cols: {}, openId: null, drawerSeq: 0, search: '', sortBy: 'cost_desc',
        profileCache: new Map(), contentCache: new Map(),
      };
      let lastFocus = null;
      /* 账号快照：切账号后在途请求作废，防旧账号数据写进新页面 */
      const acct0 = V4.acct();
      let dead = false;
      const alive = () => !dead && V4.acct() === acct0;

      // 绑定搜索与排序事件
      const searchInp = $('pgMatSearch');
      const sortSel = $('pgMatSort');
      if (searchInp) {
        // 2026-07-31 审计P1修复：oninput 同步全量 renderBoard 重构大列表，资产上百条击键卡顿——200ms 防抖
        let searchTimer = null;
        searchInp.oninput = () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => { S.search = searchInp.value; renderBoard(); }, 200);
        };
      }
      if (sortSel) {
        sortSel.onchange = () => {
          S.sortBy = sortSel.value;
          renderBoard();
        };
      }

      const all = () => STAGES.reduce((acc, st) => acc.concat(S.cols[st.key] || []), []);
      /* 在投口径来自后端千川主计划清单；“沉睡”是生命周期状态，不等于已移出计划。 */
      const active = () => all().filter(m => m.in_plan !== false);

      /* ===== 总览 ===== */
      function renderVitals() {
        const ms = active();
        const n = ms.length;
        const cost = ms.reduce((s, m) => s + (+m.cost_total || 0), 0);
        const valid = ms.filter(m => validNum(m.roi));
        const gmv = valid.reduce((s, m) => s + (+m.cost_total || 0) * (+m.roi), 0);
        const validCost = valid.reduce((s, m) => s + (+m.cost_total || 0), 0);
        const pass = valid.filter(m => +m.roi >= S.be).length;
        const dec = (S.cols.declining || []).length;
        odo($('pgMatVN'), String(n));
        $('pgMatVNs').textContent = `衰退期 ${dec} 条待汰换`;
        odo($('pgMatVCost'), fmtM(cost));
        odo($('pgMatVGmv'), fmtM(gmv));
        odo($('pgMatVRoi'), validCost > 0 ? (gmv / validCost).toFixed(2) : '--');
        $('pgMatVRoiS').textContent = '保本 ' + S.be.toFixed(2);
        odo($('pgMatVPass'), pass + '/' + valid.length);
        $('pgMatVPassS').textContent = valid.length ? `有效样本中净ROI ≥ ${S.be.toFixed(1)} 占比 ${Math.round(pass / valid.length * 100)}%` : '暂无有效ROI样本';
        $('pgMatOvCd').textContent = V4.acctName() + ' · 全部素材';
        ['pgMatVN', 'pgMatVCost', 'pgMatVGmv', 'pgMatVRoi', 'pgMatVPass'].forEach(id => fitV($(id)));
      }

      /* ===== 生命周期看板 ===== */
      function renderBoard() {
        const searchTxt = (S.search || '').trim().toLowerCase();
        const sortKey = S.sortBy || 'cost_desc';

        $('pgMatBoard').innerHTML = STAGES.map(st => {
          let list = (S.cols[st.key] || []).slice();
          if (searchTxt) {
            list = list.filter(m => {
              const name = String(m.name || '').toLowerCase();
              const mid = String(m.material_id || '').toLowerCase();
              return name.includes(searchTxt) || mid.includes(searchTxt);
            });
          }
          list.sort((a, b) => {
            const cA = +a.cost_total || 0, cB = +b.cost_total || 0;
            const rA = validNum(a.roi) ? +a.roi : -Infinity, rB = validNum(b.roi) ? +b.roi : -Infinity;
            const dA = +a.days_live || 0, dB = +b.days_live || 0;
            if (sortKey === 'cost_desc') return cB - cA;
            if (sortKey === 'cost_asc') return cA - cB;
            if (sortKey === 'roi_desc') return rB - rA;
            if (sortKey === 'roi_asc') return rA - rB;
            if (sortKey === 'days_desc') return dB - dA;
            if (sortKey === 'days_asc') return dA - dB;
            return 0;
          });

          return `<div>
            <div class="pg-mat-bc-head" style="--stc:${st.color}">
              <span class="pg-mat-bc-name">${st.name}</span>
              <span class="pg-mat-bc-hint">${st.hint}</span>
              <span class="pg-mat-bc-count">${list.length}</span>
            </div>
            ${list.length ? list.map(m => {
              const r = validNum(m.roi) ? +m.roi : null;
              const cost = +m.cost_total || 0;
              // 冲刺进度条（缺口直观）：未达稳定期动态消耗线的素材显示差距；≥83% 接近线 → live 青
              let sprint = '';
              if (st.key !== 'declining' && S.sCost > 0 && cost < S.sCost) {
                const pct = Math.min(100, Math.round(cost / S.sCost * 100));
                const actGap = (m.active_days || 0) < S.stableActive ? ` · 活跃差${S.stableActive - (m.active_days||0)}天` : '';
                sprint = `<div class="pg-mat-sprint"><div class="pg-mat-sprint-bar"><span class="pg-mat-sprint-fill${pct >= 83 ? ' live' : ''}" style="width:${pct}%"></span></div><div class="pg-mat-sprint-label"><span>距稳定期线 差 ${fmtM(S.sCost - cost)}${actGap}</span><span>${pct}%</span></div></div>`;
              }
              return `<div class="pg-mat-mc" data-id="${esc(m.material_id)}" tabindex="0" role="button" aria-label="${esc(m.name)}">
                <div class="pg-mat-mc-name" title="${esc(m.name)}">${esc(m.name)}</div>
                <div class="pg-mat-mc-m">
                  <span>消耗 <b>${fmtM(m.cost_total)}</b></span>
                  <span>净ROI <b class="${roiCls(r, S.be)}">${r == null ? '--' : r.toFixed(2)}</b></span>
                  ${isAigcSet(m)
                    ? (cost > 0 ? '<span><b class="good">投放中</b></span>' : '<span><b style="color:var(--ink-3)">未开启</b></span>')
                    : m.days_live == null
                      ? '<span style="color:var(--ink-3)">--</span>'
                      : `<span>上线 <b>${+m.days_live || 0}</b> 天</span>`}
                  ${spark(m.spark7d)}
                </div>
                ${sprint}
              </div>`;
            }).join('') : V4.emptyBox('暂无素材')}
          </div>`;
        }).join('');
        view.querySelectorAll('.pg-mat-mc').forEach(el => {
          el.onclick = () => openDrawer(el.dataset.id);
          // 用户把鼠标移到卡片上时预读本地 SQLite；真正点击时通常已经命中内存。
          el.onpointerenter = () => loadProfile(el.dataset.id).catch(() => {});
          el.onkeydown = e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(el.dataset.id); }
          };
        });
      }

      function loadProfile(id) {
        const key = String(id);
        if (S.profileCache.has(key)) return S.profileCache.get(key);
        const pending = V4.api('/api/material-profile', { material_id: id }, {
          timeout: 2500,
          retryNetwork: false,
        }).then(result => {
          if (!result || !result.profile) throw new Error('暂无本地素材档案');
          return result.profile;
        }).catch(error => {
          S.profileCache.delete(key);
          throw error;
        });
        S.profileCache.set(key, pending);
        return pending;
      }

      function loadContentRefresh(id) {
        const key = String(id);
        if (S.contentCache.has(key)) return S.contentCache.get(key);
        const pending = V4.api('/api/material-content-refresh', { material_id: id }, {
          timeout: 12000,
          retryNetwork: false,
        }).then(result => {
          if (!result || !result.content) throw new Error('千川未返回素材内容');
          return result.content;
        }).catch(error => {
          S.contentCache.delete(key);
          throw error;
        });
        S.contentCache.set(key, pending);
        return pending;
      }

      function refreshContentIfMissing(id, profile, seq) {
        const current = profile || {};
        const localTags = Array.isArray(current.creative_tags) ? current.creative_tags.filter(Boolean) : [];
        if (current.script && localTags.length) return;
        if (!current.script) $('pgMatDwNote').textContent = '正在从千川补齐文案…';

        loadContentRefresh(id).then(content => {
          if (seq !== S.drawerSeq) return;
          const script = content.script || current.script || null;
          const tags = (Array.isArray(content.creative_tags) ? content.creative_tags : localTags)
            .filter(Boolean).slice(0, 12);
          $('pgMatDwNote').textContent = script || '暂无收录（千川内容接口未返回文案）';
          $('pgMatDwTags').innerHTML = tags.map(tag => `<span class="pg-mat-tag">${esc(tag)}</span>`).join('');
          const merged = { ...current, script, creative_tags: tags };
          S.profileCache.set(String(id), Promise.resolve(merged));
        }).catch(error => {
          if (seq !== S.drawerSeq) return;
          if (!current.script) $('pgMatDwNote').textContent = `暂无收录 · ${error && error.message ? error.message : '千川补齐失败'}`;
        });
      }

      /* ===== 红黑榜 ===== */
      function renderLists() {
        const ms = all();
        const row = (m, i, bad) => {
          const r = validNum(m.roi) ? +m.roi : null;
          const badge = bad ? '<span class="badge badge-danger">低效信号</span>' : '<span class="badge badge-ok">表现较好</span>';
          return `<div class="m-row">
            <span class="pg-mat-rk">${String(i + 1).padStart(2, '0')}</span>
            <span class="m-name" title="${esc(m.name)}">${esc(m.name)}</span>
            <span class="pg-mat-c">${fmtM(m.cost_total)}</span>
            ${badge}
            <span class="m-v ${roiCls(r, S.be)}">${r == null ? '--' : r.toFixed(2)}</span>
          </div>`;
        };
        const red = ms.filter(m => validNum(m.roi) && (+m.cost_total || 0) > 0).sort((a, b) => +b.roi - +a.roi).slice(0, 5);
        const black = ms.filter(m => validNum(m.roi) && +m.roi < S.be && (+m.cost_total || 0) > 0).sort((a, b) => (+b.cost_total || 0) - (+a.cost_total || 0)).slice(0, 5);
        $('pgMatRed').innerHTML = red.length ? red.map((m, i) => row(m, i, false)).join('') : V4.emptyBox('暂无有效样本');
        $('pgMatBlack').innerHTML = black.length ? black.map((m, i) => row(m, i, true)).join('') : V4.emptyBox('暂无需要复核的样本');
      }

      /* ===== 主数据 ===== */
      async function refresh() {
        let j;
        try { j = await V4.api('/api/material-lifecycle'); }
        catch (e) {
          if (!alive()) return;
          $('pgMatBoard').innerHTML = V4.errBox(e);
          $('pgMatRed').innerHTML = '';
          $('pgMatBlack').innerHTML = '';
          return;
        }
        if (!alive()) return;
        const th = j.thresholds || {};
        S.be = +(th.break_even_roi || V4.breakEven());
        S.sCost = +(th.stable_cost_line || 0);
        S.stableActive = +(th.stable_active_line || 5);
        S.cols = j.columns || {};

        // 动态更新稳定期 hint：显示当前账号的真实阈值
        const sStage = STAGES.find(s => s.key === 's_level');
        if (sStage && S.sCost > 0) {
          sStage.hint = `账号动态：消耗≥${fmtM(S.sCost)} + 有效活跃≥${S.stableActive}天（前70%贡献）`;
        }
        // 三个区域必须故障隔离。此前任一概览数字/动画渲染异常都会中断后续
        // renderBoard，页面便只剩“在投素材 N 条”的半截状态。
        try {
          renderVitals();
        } catch (error) {
          console.error('[materials] overview render failed', error);
        }
        try {
          renderBoard();
        } catch (error) {
          console.error('[materials] lifecycle render failed', error);
          $('pgMatBoard').innerHTML = V4.errBox(error);
        }
        try {
          renderLists();
        } catch (error) {
          console.error('[materials] ranking render failed', error);
          $('pgMatRed').innerHTML = V4.errBox(error);
          $('pgMatBlack').innerHTML = '';
        }
        V4.touch();
      }

      /* ===== 抽屉：基础信息 kv ===== */
      function renderKv(d) {
        const kv = [
          ['账号', esc(V4.acctName()), ''],
          ['生命周期', esc(d.stageText || '--'), ''],
          /* AIGC 集合无"上线天数"，改显示运行状态（投放中/未开启） */
          d.aigc
            ? ['运行状态', d.running ? '投放中' : '<span style="color:var(--ink-3)">未开启</span>', d.running ? 'good' : '']
            : ['上线天数', d.days != null ? (+d.days) + ' 天' : '--', 'num'],
          ['累计消耗', d.cost != null ? fmtM(d.cost) : '--', 'num'],
          ['累计净成交', d.gmv != null ? fmtM(d.gmv) : '--', 'num'],
          ['综合净ROI', d.roi != null ? (+d.roi).toFixed(2) : '--', 'num ' + (d.roi != null ? roiCls(+d.roi, S.be) : '')],
          ['保本线', S.be.toFixed(2), 'num'],
        ];
        $('pgMatDwGrid').innerHTML = kv.map(([k, v, c]) =>
          `<div class="pg-mat-dw-kv"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      }

      /* ===== 抽屉：人群画像条形（detail 实时分布） ===== */
      function renderAudience(au) {
        if (!au) { $('pgMatDwAu').innerHTML = V4.emptyBox('暂无收录'); return; }
        const PALETTE = ['#5B8FF9', '#5AD8A6', '#F6BD16', '#E8684A', '#6DC8EC', '#9270CA', '#FF9D4D', '#269A99', '#B9E78A'];

        function barChart(data, color) {
          if (!data || !data.length) return '';
          const W = 400, H = 130, PL = 38, PR = 8, PT = 10, PB = 28;
          const maxRate = Math.max(...data.map(d => +d.rate || 0), 0.01);
          let yMax = maxRate <= 0.5 ? 0.5 : (maxRate <= 0.6 ? 0.6 : 1);
          if (maxRate > 1) yMax = Math.ceil(maxRate * 10) / 10;
          const step = (W - PL - PR) / data.length;
          const barW = step * 0.55;
          const gridY = [0, yMax / 2, yMax];
          const Y = r => H - PB - (r / yMax) * (H - PT - PB);
          const bars = data.map((d, i) => {
            const r = +d.rate || 0;
            const y = Y(r);
            const h = H - PB - y;
            const x = PL + i * step + (step - barW) / 2;
            const tx = PL + i * step + step / 2;
            const label = esc(d.label).replace(/^(.{5})(.+)$/, '$1…');
            return `<rect class="bar" data-label="${esc(d.label)}" data-count="${d.count || 0}" data-rate="${r}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>` +
              `<text x="${tx.toFixed(1)}" y="${(H - PB + 12).toFixed(1)}" text-anchor="middle">${label}</text>` +
              `<text x="${tx.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="8.5">${fmtPct(r)}</text>`;
          }).join('');
          return `<svg class="pg-mat-au-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
            gridY.map(g => `<line class="grid" x1="${PL}" y1="${Y(g).toFixed(1)}" x2="${W - PR}" y2="${Y(g).toFixed(1)}"/>`).join('') +
            `<line class="grid" x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}"/>` +
            gridY.map(g => `<text x="${PL - 5}" y="${(Y(g) + 3).toFixed(1)}" text-anchor="end">${fmtPct(g)}</text>`).join('') +
            bars + '</svg>';
        }

        function donutChart(title, data) {
          if (!data || !data.length) return '';
          const total = data.reduce((s, d) => s + (+d.count || 0), 0) || 1;
          const W = 160, H = 120, R = 42, CX = W / 2, CY = H / 2 - 4;
          let ang = -Math.PI / 2;
          const slices = [];
          data.forEach((d, i) => {
            const pct = (+d.count || 0) / total;
            if (pct <= 0) return;
            const a = pct * Math.PI * 2;
            const x1 = CX + R * Math.cos(ang), y1 = CY + R * Math.sin(ang);
            const x2 = CX + R * Math.cos(ang + a), y2 = CY + R * Math.sin(ang + a);
            const large = a > Math.PI ? 1 : 0;
            const path = `M ${CX} ${CY} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
            slices.push({ path, color: PALETTE[i % PALETTE.length], label: d.label, rate: d.rate, count: d.count });
            ang += a;
          });
          if (!slices.length) return '';
          const donutHole = `<circle cx="${CX}" cy="${CY}" r="${R * 0.58}" fill="var(--bg-raised)"/>` +
            `<text x="${CX}" y="${CY + 1}" text-anchor="middle" dominant-baseline="middle" fill="var(--ink-2)" font-size="11" font-weight="600">${title}</text>`;
          return `<div class="pg-mat-donut"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
            slices.map(s => `<path d="${s.path}" fill="${s.color}" stroke="var(--bg-raised)" stroke-width="1.5" data-label="${esc(s.label)}" data-count="${s.count || 0}" data-rate="${s.rate || 0}"/>`).join('') + donutHole +
            '</svg><div class="dn-leg">' + slices.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)} ${fmtPct(s.rate)}</span>`).join('') + '</div></div>';
        }

        function regionBlock(prov, city) {
          const hasProv = Array.isArray(prov) && prov.length;
          const hasCity = Array.isArray(city) && city.length;
          if (!hasProv && !hasCity) return '';
          const state = { tab: hasProv ? 'prov' : 'city' };
          function render() {
            const isProv = state.tab === 'prov';
            const data = (isProv ? prov : city).slice(0, 10);
            $('pgMatDwAuRegion').innerHTML = `
              <div class="pg-mat-au-tabs">
                <button class="${isProv ? 'on' : ''}" data-tab="prov">省份</button>
                <button class="${!isProv ? 'on' : ''}" data-tab="city">城市</button>
              </div>
              ${barChart(data, '#5B8FF9')}
            `;
            $('pgMatDwAuRegion').querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); });
          }
          return `<div class="pg-mat-au-block" id="pgMatDwAuRegion"></div>`;
        }

        const crowd = au.user_group_label_name || [];
        const gender = au.gender || [];
        const age = au.age || [];
        const prov = au.province_name || [];
        const city = au.city_name || [];

        let html = '';
        if (crowd.length) {
          html += `<div class="pg-mat-au-block"><div class="pg-mat-au-t">八大人群分布</div>${barChart(crowd.slice(0, 8), '#5B8FF9')}</div>`;
        }
        if (gender.length || age.length) {
          html += `<div class="pg-mat-au-block"><div class="pg-mat-au-t">性别 / 年龄</div><div class="pg-mat-donuts">${donutChart('性别', gender)}${donutChart('年龄', age)}</div></div>`;
        }
        if (prov.length || city.length) {
          html += `<div class="pg-mat-au-block"><div class="pg-mat-au-t">地域分布</div><div id="pgMatDwAuRegion"></div></div>`;
        }
        $('pgMatDwAu').innerHTML = html || V4.emptyBox('暂无收录');
        bindBarTips($('pgMatDwAu'));
        if (prov.length || city.length) {
          // regionBlock renders into the placeholder after HTML insertion
          const el = $('pgMatDwAuRegion');
          if (el) {
            el.innerHTML = `
              <div class="pg-mat-au-tabs">
                <button class="on" data-tab="prov">省份</button>
                <button data-tab="city">城市</button>
              </div>
              <div class="pg-mat-au-chart">${barChart(prov.slice(0, 10), '#5B8FF9')}</div>
            `;
            el.querySelectorAll('button').forEach(b => b.onclick = () => {
              const isProv = b.dataset.tab === 'prov';
              el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.tab === b.dataset.tab));
              const data = isProv ? prov.slice(0, 10) : city.slice(0, 10);
              // 2026-07-31 审计P1修复：barChart 空数据返回空串时初始无 svg，outerHTML 找不到节点静默失效——容器 innerHTML 替换不依赖 svg 存在
              const chart = el.querySelector('.pg-mat-au-chart');
              if (chart) chart.innerHTML = barChart(data, '#5B8FF9');
              bindBarTips(el);
            });
          }
        }
      }

      /* ===== 提示框（人群画像 / 点击流失图表共用） ===== */
      function showTip(html, target) {
        const tip = $('pgMatTip');
        if (!tip) return;
        tip.innerHTML = html;
        tip.style.display = 'block';
        const tr = target.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = tr.left + tr.width / 2 - tw / 2 + window.scrollX;
        let top = tr.top - th - 8 + window.scrollY;
        if (left < 4) left = 4;
        if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      }
      function hideTip() { const tip = $('pgMatTip'); if (tip) tip.style.display = 'none'; }
      function bindBarTips(container) {
        if (!container) return;
        container.querySelectorAll('rect.bar').forEach(rect => {
          rect.addEventListener('mouseenter', () => showTip(`<b>${esc(rect.dataset.label)}</b><br>人数 ${fmtNum(rect.dataset.count)} · 占比 ${fmtPct(rect.dataset.rate)}`, rect));
          rect.addEventListener('mouseleave', hideTip);
        });
        container.querySelectorAll('.pg-mat-donut path').forEach(path => {
          path.addEventListener('mouseenter', () => showTip(`<b>${esc(path.dataset.label)}</b><br>人数 ${fmtNum(path.dataset.count)} · 占比 ${fmtPct(path.dataset.rate)}`, path));
          path.addEventListener('mouseleave', hideTip);
        });
      }
      function fmtTipPct(v) { return (Math.round((+v || 0) * 1000) / 10).toFixed(1) + '%'; }

      /* ===== 图表悬停绑定：热区 rect 接 mousemove → 最近点竖虚线 + 高亮点 + 玻璃提示框（复用 v4.css .trend-tip，交互仿作战室 trend） ===== */
      function bindHover(box, W, move) {
        const svg = box.querySelector('svg');
        const hit = svg && svg.querySelector('.pg-mat-hit');
        const g = svg && svg.querySelector('.pg-mat-hg');
        if (!svg || !hit || !g) return;
        const tip = document.createElement('div');
        tip.className = 'trend-tip';
        box.appendChild(tip);
        const line = g.querySelector('line'), dots = g.querySelectorAll('circle');
        hit.addEventListener('mousemove', e => {
          const r = svg.getBoundingClientRect();
          if (!r.width) return;
          const vx = (e.clientX - r.left) / r.width * W; /* clientX → viewBox 坐标 */
          const p = move(vx);
          if (!p) return;
          line.setAttribute('x1', p.x); line.setAttribute('x2', p.x);
          dots.forEach((d, k) => { if (p.dots[k]) { d.setAttribute('cx', p.dots[k].x); d.setAttribute('cy', p.dots[k].y); } });
          g.removeAttribute('display');
          tip.innerHTML = p.html;
          tip.style.display = 'block';
          const px = p.x / W * r.width;
          tip.style.left = (px / r.width > .62 ? Math.max(4, px - tip.offsetWidth - 12) : px + 12) + 'px';
        });
        hit.addEventListener('mouseleave', () => { g.setAttribute('display', 'none'); tip.style.display = 'none'; });
      }

      /* ===== 抽屉：近30天 消耗×净ROI 双折线 ===== */
      function drawDual(trend) {
        let days = [];
        if (trend && trend.length && trend[0].Dimensions) {
          // 千川原始行（来自 /api/material-detail）
          days = trend.map(d => ({
            date: d.Dimensions.stat_time_day.ValueStr,
            cost: +d.Metrics.stat_cost_for_roi2.Value || 0,
            roi: +d.Metrics.total_prepay_and_pay_settle_roi2_1h.Value || 0,
          })).filter(d => d.date).sort((a, b) => a.date < b.date ? -1 : 1);
        } else {
          // 本地 T+1 趋势（来自 /api/material-profile 的 trend_30d）
          days = (trend || []).map(d => ({ date: d.date, cost: +d.cost || 0, roi: +d.roi || 0 })).filter(d => d.date);
        }
        if (!days.length) { $('pgMatDwChartBox').innerHTML = V4.emptyBox('暂无收录'); return; }
        const W = 420, H = 132, PL = 34, PR = 8, PT = 10, PB = 20;
        const cMax = Math.max(...days.map(d => d.cost), 0.01) * 1.15;
        const rMax = Math.max(S.be * 1.25, ...days.map(d => d.roi)) + 0.2;
        const X = i => PL + i / ((days.length - 1) || 1) * (W - PL - PR);
        const Yc = v => PT + (1 - v / cMax) * (H - PT - PB);
        const Yr = v => PT + (1 - v / rMax) * (H - PT - PB);
        const pl = (arr, Y) => arr.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
        const yBE = Yr(S.be);
        const costs = days.map(d => d.cost), rois = days.map(d => d.roi);
        const last = days.length - 1;
        $('pgMatDwChartBox').innerHTML = `<svg class="pg-mat-dw-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <line x1="${PL}" y1="${yBE}" x2="${W - PR}" y2="${yBE}" stroke="rgba(245,184,78,.5)" stroke-dasharray="3 5" stroke-width="1"/>
          <text x="${PL + 2}" y="${yBE - 4}" font-size="10" fill="#F5B84E" opacity=".85">保本 ${S.be.toFixed(1)}</text>
          <polyline points="${pl(costs, Yc)}" fill="none" stroke="#7EA6FF" stroke-width="1.2" stroke-linejoin="round" opacity=".9"/>
          <polyline points="${pl(rois, Yr)}" fill="none" stroke="#5FD68B" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="${X(last)}" cy="${Yc(costs[last])}" r="2.4" fill="#7EA6FF"/>
          <circle cx="${X(last)}" cy="${Yr(rois[last])}" r="2.6" fill="#5FD68B"/>
          <text x="${PL}" y="${H - 5}" font-size="10" fill="#788391">${esc(days[0].date.slice(5))}</text>
          <text x="${W - PR}" y="${H - 5}" font-size="10" fill="#788391" text-anchor="end">${esc(days[last].date.slice(5))}</text>
          <text x="${PL - 4}" y="${Yc(cMax / 1.15) + 3}" font-size="10" fill="#788391" text-anchor="end">${Math.round(cMax / 1.15)}</text>
          <text x="${PL - 4}" y="${H - PB + 3}" font-size="10" fill="#788391" text-anchor="end">0</text>
          <g class="pg-mat-hg" display="none">
            <line y1="${PT}" y2="${H - PB}" stroke="rgba(226,232,240,.35)" stroke-width="1" stroke-dasharray="2 3"/>
            <circle r="3" fill="#7EA6FF" stroke="rgba(255,255,255,.85)" stroke-width="1.1"/>
            <circle r="3.2" fill="#5FD68B" stroke="rgba(255,255,255,.85)" stroke-width="1.1"/>
          </g>
          <rect class="pg-mat-hit" x="${PL}" y="0" width="${W - PL - PR}" height="${H}" fill="rgba(0,0,0,0)"/>
        </svg>`;
        bindHover($('pgMatDwChartBox'), W, vx => {
          const i = Math.max(0, Math.min(last, Math.round((vx - PL) / (W - PL - PR) * last)));
          const d = days[i];
          return { x: X(i), dots: [{ x: X(i), y: Yc(d.cost) }, { x: X(i), y: Yr(d.roi) }],
            html: `<b>${esc(d.date.slice(5))}</b> · 消耗 <b>${V4.fmtMoney(d.cost)}</b> · 净ROI <b>${d.roi.toFixed(2)}</b>` };
        });
      }

      /* ===== 抽屉：点击次数 & 流失次数（秒级留存拆回原始指标） ===== */
      function renderClickDrop(clickCount, dropCount, clickSeries, dropSeries) {
        const hasClick = clickCount != null && !isNaN(clickCount);
        const hasDrop = dropCount != null && !isNaN(dropCount);
        const hasClickSeries = Array.isArray(clickSeries) && clickSeries.length;
        const hasDropSeries = Array.isArray(dropSeries) && dropSeries.length;
        if (!hasClick && !hasDrop && !hasClickSeries && !hasDropSeries) {
          $('pgMatDwRetBox').innerHTML = V4.emptyBox('暂无收录');
          return;
        }
        const fmt = n => Number(n).toLocaleString('zh-CN');
        const state = { tab: 'click' };

        function peakOf(arr) {
          if (!arr || !arr.length) return null;
          let max = -Infinity, idx = -1;
          arr.forEach((p, i) => { const v = +p.value || +p.viewers || +p.lost || 0; if (v > max) { max = v; idx = i; } });
          return idx >= 0 ? { second: +arr[idx].second || idx, value: max } : null;
        }

        function drawSeries(arr, color) {
          if (!arr || !arr.length) return '';
          const W = 400, H = 110, PL = 26, PR = 10, PT = 8, PB = 18;
          const pts = arr.map(p => ({ second: +p.second || 0, value: +p.value || +p.viewers || +p.lost || 0 }));
          const maxSecond = Math.max(...pts.map(p => p.second), 1);
          const maxVal = Math.max(...pts.map(p => p.value), 1);
          const X = p => PL + (p.second / maxSecond) * (W - PL - PR);
          const Y = v => PT + (H - PT - PB) * (1 - v / maxVal);
          const line = pts.map(p => `${X(p).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
          const area = `${PL},${H - PB} ` + line + ` ${W - PR},${H - PB}`;
          const peak = peakOf(arr);
          const xTicks = [];
          const step = Math.ceil((maxSecond + 1) / 6) || 1;
          for (let s = 0; s <= maxSecond; s += step) xTicks.push(s);
          return `
            <svg class="cd-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" data-series='${JSON.stringify(pts)}' data-color="${color}">
              <defs><linearGradient id="cdGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".35"/><stop offset="100%" stop-color="${color}" stop-opacity=".05"/></linearGradient></defs>
              ${xTicks.map(s => `<line class="grid" x1="${X({second:s}).toFixed(1)}" y1="${PT}" x2="${X({second:s}).toFixed(1)}" y2="${H - PB}"/>`).join('')}
              <line class="grid" x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}"/>
              <polygon class="area" points="${area}" fill="url(#cdGrad)"/>
              <polyline points="${line}" stroke="${color}" stroke-width="2"/>
              ${peak ? `<circle cx="${X({second:peak.second}).toFixed(1)}" cy="${Y(peak.value).toFixed(1)}" r="3.5" fill="${color}" class="peak"/><circle cx="${X({second:peak.second}).toFixed(1)}" cy="${Y(peak.value).toFixed(1)}" r="1.8" fill="#fff"/>` : ''}
              ${xTicks.map(s => `<text x="${X({second:s}).toFixed(1)}" y="${H - 4}" text-anchor="middle">${s}s</text>`).join('')}
              <line class="cd-guide" x1="${PL}" y1="${PT}" x2="${PL}" y2="${H - PB}" display="none"/>
              <circle class="cd-guide-dot" r="3.5" fill="${color}" stroke="#fff" stroke-width="1.2" display="none"/>
              <rect class="cd-hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}" fill="rgba(0,0,0,0)" cursor="crosshair"/>
            </svg>`;
        }

        function render() {
          const isClick = state.tab === 'click';
          const series = isClick ? (hasClickSeries ? clickSeries : null) : (hasDropSeries ? dropSeries : null);
          const color = isClick ? '#7EA6FF' : '#F87171';
          const peak = peakOf(series);
          const insight = peak
            ? `整体${isClick ? '点击次数' : '流失数'}峰值在第<b>${peak.second}</b>秒，数值 <b>${fmt(peak.value)}</b>${isClick ? '，该峰值画面可用于视频混剪或指导后续创意制作' : ''}`
            : '';
          $('pgMatDwRetBox').innerHTML = `
            <div class="cd-tabs">
              <button class="${isClick ? 'on' : ''}" data-tab="click">整体点击次数</button>
              <button class="${!isClick ? 'on' : ''}" data-tab="drop" ${!hasDropSeries && !hasDrop ? 'disabled' : ''}>整体流失数</button>
            </div>
            <div class="cd-chart-wrap">
              ${insight ? `<div class="cd-insight">${insight}</div>` : ''}
              ${series ? drawSeries(series, color) : '<div class="pg-mat-load">暂无秒级数据</div>'}
            </div>
            <div class="cd-totals">
              <div class="cd-cell"><div class="cd-lab">整体点击次数</div><div class="cd-val">${hasClick ? fmt(clickCount) : '—'}</div></div>
              <div class="cd-cell"><div class="cd-lab">整体流失次数</div><div class="cd-val drop">${hasDrop ? fmt(dropCount) : '—'}</div></div>
            </div>
          `;
          $('pgMatDwRetBox').querySelectorAll('.cd-tabs button').forEach(b => {
            b.onclick = () => { if (b.disabled) return; state.tab = b.dataset.tab; render(); };
          });
          const svg = $('pgMatDwRetBox').querySelector('.cd-chart');
          if (svg) bindClickDropHover(svg, isClick ? '点击次数' : '流失数', '次');
        }
        render();
      }

      function bindClickDropHover(svg, name, unit) {
        const pts = JSON.parse(svg.dataset.series || '[]');
        if (!pts.length) return;
        const W = 400, H = 110, PL = 26, PR = 10, PT = 8, PB = 18;
        const maxSecond = Math.max(...pts.map(p => p.second), 1);
        const maxVal = Math.max(...pts.map(p => p.value), 1);
        const X = s => PL + (s / maxSecond) * (W - PL - PR);
        const Y = v => PT + (H - PT - PB) * (1 - v / maxVal);
        const guide = svg.querySelector('.cd-guide'), dot = svg.querySelector('.cd-guide-dot'), hit = svg.querySelector('.cd-hit');
        if (!hit) return;
        hit.addEventListener('mousemove', e => {
          const r = svg.getBoundingClientRect();
          const sx = (e.clientX - r.left) / r.width * W;
          let second = Math.round(((sx - PL) / (W - PL - PR)) * maxSecond);
          second = Math.max(0, Math.min(maxSecond, second));
          const p = pts.find(x => x.second === second) || pts[pts.length - 1];
          const x = X(p.second), y = Y(p.value);
          guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.removeAttribute('display');
          dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.removeAttribute('display');
          showTip(`第 <b>${p.second}</b> 秒 · ${name} <b>${fmtNum(p.value)}</b> ${unit || ''}`, hit);
        });
        hit.addEventListener('mouseleave', () => { guide.setAttribute('display', 'none'); dot.setAttribute('display', 'none'); hideTip(); });
      }

      /* profile 快路径的点击/流失读数 */
      function renderRetFast(r) {
        if (!r) return;
        const parts = [];
        if (r.click_count != null) parts.push(`<span>点击 <b>${(+r.click_count).toLocaleString('zh-CN')}</b></span>`);
        if (r.drop_count != null) parts.push(`<span>流失 <b>${(+r.drop_count).toLocaleString('zh-CN')}</b></span>`);
        if (r.total_seconds != null) parts.push(`<span>时长 <b>${(+r.total_seconds).toFixed(0)}s</b></span>`);
        if (r.clicks_7d != null) parts.push(`<span>近7天点击 <b>${(+r.clicks_7d).toLocaleString('zh-CN')}</b></span>`);
        if (r.cpc_7d != null) parts.push(`<span>近7天CPC <b>¥${(+r.cpc_7d).toFixed(2)}</b></span>`);
        if (parts.length) $('pgMatDwRetM').innerHTML = parts.join('');
      }

      function settleDrawerMissing(message, error) {
        $('pgMatDwChartBox').innerHTML = error ? V4.errBox(error) : V4.emptyBox(message);
        $('pgMatDwAu').innerHTML = V4.emptyBox(message);
        $('pgMatDwRetBox').innerHTML = V4.emptyBox(message);
        $('pgMatRetTag').textContent = 'T+1 · 暂无明细';
        $('pgMatDwNote').textContent = message;
      }

      /* profile 快路径的人群核心标签（分布到来前先给结论） */
      function renderAudienceFast(au) {
        if (!au || (!au.gender && !au.age && !(au.region_top || []).length)) return;
        $('pgMatDwAu').innerHTML = '<div class="pg-mat-dw-summary">核心人群：' +
          [au.gender, au.age].filter(Boolean).map(esc).join(' · ') +
          ((au.region_top || []).length ? '，主要分布 ' + au.region_top.slice(0, 3).map(esc).join('、') : '') +
          '<br>分布加载中…</div>';
      }

      /* ===== 抽屉：打开 / 关闭 ===== */
      function openDrawer(id) {
        const m = all().find(x => String(x.material_id) === String(id));
        if (!m) return;
        S.openId = id;
        const seq = ++S.drawerSeq;
        lastFocus = document.activeElement;
        const r = validNum(m.roi) ? +m.roi : null;
        const aigc = isAigcSet(m);
        const stKey = STAGES.find(st => (S.cols[st.key] || []).some(x => String(x.material_id) === String(id)));
        const st = stKey || STAGES[0];
        $('pgMatDwName').textContent = m.name || String(id);
        $('pgMatDwStage').innerHTML = `阶段 <b>${esc(st.name)}</b> · ${esc(st.hint)}`;
        renderKv({
          stageText: st.name + (aigc
            ? ' · ' + ((+m.cost_total || 0) > 0 ? '投放中' : '未开启')
            : (m.days_live == null ? '' : ' · 上线' + (+m.days_live || 0) + '天')),
          days: m.days_live == null ? null : (+m.days_live || 0),
          aigc, running: (+m.cost_total || 0) > 0,
          cost: +m.cost_total || 0,
          gmv: r == null ? null : (+m.cost_total || 0) * r,
          roi: r,
        });
        $('pgMatLgBe').textContent = '保本 ' + S.be.toFixed(1);
        // 先显示明确的本地缺省状态，避免任何异常分支留下永久“加载中”。
        $('pgMatDwChartBox').innerHTML = V4.emptyBox('暂无本地趋势');
        $('pgMatDwAu').innerHTML = V4.emptyBox('暂无本地成交用户画像');
        $('pgMatDwRetBox').innerHTML = V4.emptyBox('暂无点击与流失明细');
        $('pgMatDwRetM').innerHTML = '';
        $('pgMatRetTag').textContent = 'T+1 · 本地档案';
        $('pgMatDwNote').textContent = '暂无本地文案';
        $('pgMatDwTags').innerHTML = '';
        $('pgMatDwSummary').textContent = '';
        setupRename(m, seq);
        $('pgMatMask').classList.add('on');
        const dw = $('pgMatDrawer');
        dw.style.display = 'block';
        requestAnimationFrame(() => requestAnimationFrame(() => dw.classList.add('on')));
        setTimeout(() => { const x = $('pgMatDwX'); if (x) x.focus(); }, 80);

        /* 主路径：本地 DB profile（T+1，秒开） */
        loadProfile(id).then(p => {
          if (seq !== S.drawerSeq) return;
          renderKv({
            stageText: (p.lifecycle || st.name) + (aigc
              ? ' · ' + ((+m.cost_total || 0) > 0 ? '投放中' : '未开启')
              : (m.days_live == null && p.days_active == null ? '' : ' · 上线' + (p.days_active != null ? +p.days_active : (+m.days_live || 0)) + '天')),
            days: p.days_active != null ? +p.days_active : (m.days_live == null ? null : (+m.days_live || 0)),
            aigc, running: (+m.cost_total || 0) > 0,
            cost: +m.cost_total || 0,
            gmv: (+m.cost_total || 0) * r,
            roi: r,
          });
          if (p.lifecycle) {
            const ps = STAGES.find(s => s.name === p.lifecycle);
            $('pgMatDwStage').innerHTML = `阶段 <b>${esc(p.lifecycle)}</b>` + (ps ? ` · ${esc(ps.hint)}` : '');
          }
          drawDual(p.trend_30d || p.trend_14d || []);
          renderAudience(p.audience_full || null);
          renderRetFast(p.retention || null);
          const hasRetentionDetail = p.retention && (
            p.retention.click_count != null || p.retention.drop_count != null ||
            (Array.isArray(p.retention_curve) && p.retention_curve.length)
          );
          if (hasRetentionDetail) {
            renderClickDrop(p.retention.click_count, p.retention.drop_count, p.retention_curve || null, null);
            $('pgMatRetTag').textContent = '近30天累计 · T+1';
          } else {
            $('pgMatDwRetBox').innerHTML = V4.emptyBox('暂无点击与流失明细');
            $('pgMatRetTag').textContent = 'T+1 · 未采集';
          }
          $('pgMatDwNote').textContent = p.script ? String(p.script) : '暂无收录';
          const tags = Array.isArray(p.creative_tags) ? p.creative_tags.filter(Boolean).slice(0, 8) : [];
          $('pgMatDwTags').innerHTML = tags.map(t => `<span class="pg-mat-tag">${esc(t)}</span>`).join('');
          if (p.summary) $('pgMatDwSummary').textContent = p.summary;
          // 本地档案先完成首屏；仅在文案或标签缺失时，后台轻量补齐官方“内容”接口。
          // 画像、秒级时序、同行素材均不参与本请求，也不会阻塞抽屉。
          refreshContentIfMissing(id, p, seq);
        }).catch(e => {
          if (seq !== S.drawerSeq) return;
          settleDrawerMissing('暂无收录', e);
          refreshContentIfMissing(id, null, seq);
        });
      }

      const ROLE_PREFIX = /^\[(种草|收割|承接|探索|待定)\]\s*/;
      function roleName(currentName, role) {
        const base = String(currentName || '').replace(ROLE_PREFIX, '').trim();
        return role && base ? `[${role}]${base}` : String(currentName || '');
      }

      function setupRename(material, seq) {
        const roleEl = $('pgMatRenameRole');
        const previewEl = $('pgMatRenamePreview');
        const button = $('pgMatRenameBtn');
        const state = $('pgMatRenameState');
        const currentName = String(material.name || '');
        const match = currentName.match(ROLE_PREFIX);
        roleEl.value = match ? match[1] : '';
        previewEl.value = roleName(currentName, roleEl.value);
        button.disabled = !roleEl.value;
        state.className = 'pg-mat-rename-state';
        state.textContent = '选择角色后生成名称预览；不会自动批量改名。';

        roleEl.onchange = () => {
          previewEl.value = roleName(String(material.name || currentName), roleEl.value);
          button.disabled = !roleEl.value || !previewEl.value;
          state.className = 'pg-mat-rename-state';
          state.textContent = roleEl.value ? '尚未写入。点击按钮会先读取千川当前名称并进行预检。' : '请选择素材角色。';
        };

        button.onclick = async () => {
          if (!roleEl.value || button.disabled) return;
          button.disabled = true;
          state.className = 'pg-mat-rename-state';
          state.textContent = '正在预检千川当前名称…';
          try {
            const preview = await V4.apiPost('/api/material/rename', {
              materialId: material.material_id,
              role: roleEl.value,
              newName: previewEl.value,
              confirm: false,
            }, { timeout: 15000 });
            if (seq !== S.drawerSeq) return;
            const accepted = window.confirm(`确认修改素材名称？\n\n当前：${preview.current_name}\n修改为：${preview.proposed_name}\n\n此操作会同步写入千川视频库。`);
            if (!accepted) {
              state.textContent = '已取消，没有修改。';
              return;
            }
            state.textContent = '正在写入千川并回读确认…';
            const result = await V4.apiPost('/api/material/rename', {
              materialId: material.material_id,
              role: roleEl.value,
              newName: preview.proposed_name,
              expectedCurrentName: preview.current_name,
              confirm: true,
              source: 'api',
            }, { timeout: 55000 });
            if (seq !== S.drawerSeq) return;
            all().filter(x => String(x.material_id) === String(material.material_id))
              .forEach(x => { x.name = result.proposed_name; x.role = result.role; });
            $('pgMatDwName').textContent = result.proposed_name;
            previewEl.value = result.proposed_name;
            renderBoard(); renderLists();
            state.className = 'pg-mat-rename-state ok';
            state.textContent = result.verified
              ? '改名成功，千川回读与本地数据已同步。'
              : '千川已受理并同步本地数据；官方列表可能短暂延迟。';
          } catch (error) {
            if (seq !== S.drawerSeq) return;
            state.className = 'pg-mat-rename-state bad';
            state.textContent = error && error.message ? error.message : '改名失败';
          } finally {
            if (seq === S.drawerSeq) button.disabled = !roleEl.value;
          }
        };
      }

      function closeDrawer() {
        if (!$('pgMatDrawer').classList.contains('on')) return;
        S.openId = null;
        S.drawerSeq++; /* 作废在途请求 */
        $('pgMatMask').classList.remove('on');
        const dw = $('pgMatDrawer');
        dw.classList.remove('on');
        setTimeout(() => { if (!dw.classList.contains('on')) dw.style.display = ''; }, 420);
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
        lastFocus = null;
      }
      $('pgMatMask').onclick = closeDrawer;
      $('pgMatDwX').onclick = closeDrawer;
      const onKey = e => { if (e.key === 'Escape') closeDrawer(); };
      addEventListener('keydown', onKey);

      /* ===== 数据加载（静态查询，不轮询） ===== */
      refresh();

      return function unmount() {
        dead = true;
        S.drawerSeq++;
        removeEventListener('keydown', onKey);
      };
    },
  };

})(window.V4);
