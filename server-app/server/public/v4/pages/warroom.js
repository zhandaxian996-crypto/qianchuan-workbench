/* ===== 千川投控 v4 · 作战室 ===== */
(function (V4) {
  'use strict';
  const { $, esc, fmtM, fmtMoney, odo, fitV, flip } = V4;

  /* 按账号的数据缓存（模块级，跨 mount 存活）：切账号先秒上缓存再后台刷新（stale-while-revalidate），
     消灭"切账号 → 整页空白等加载" */
  const CACHE = {};

  const HTML = `
  <section class="band-state">
    <!-- 第一行：三秒看完 -->
    <div class="band-head">
      <span class="state-word off" id="stateWord">--</span>
      <span class="live-since" id="liveSince" style="display:none"></span>
      <span class="band-vitals" id="bandVitals"></span>
      <span class="live-links" id="liveLinks" style="display:none"></span>
    </div>
    <div id="coreFreshness" style="font-size:12px;color:var(--ink-3);padding:4px 0" role="status">核心数据等待首次采集</div>
    <!-- 第二行：本轮判定 -->
    <div class="band-judgment" id="bandJudgment" style="display:none">
      <span class="j-signal" id="jEmoji"></span>
      <span class="j-text" id="jText">--</span>
    </div>
    <!-- 第三行：关注素材（最多3条） -->
    <div class="band-watch" id="bandWatch" style="display:none"></div>
    <!-- 指标网格 -->
    <div class="band">
      <div class="band-row r1">
        <div class="bcell hero"><div class="l">净ROI</div><div class="v num" id="roiNum">--</div><div class="s"><span class="delta" id="roiDelta"></span></div></div>
        <div class="bcell"><div class="l" id="lGmv">净成交</div><div class="v num" id="vGmv">--</div><div class="s" id="vGmvS"></div></div>
        <div class="bcell"><div class="l" id="lCost">今日消耗</div><div class="v num" id="vCost">--</div><div class="s" id="vCostS"></div></div>
        <div class="bcell"><div class="l">总流速（15m）</div><div class="v num" id="vFlow">--</div><div class="s" id="vFlowS">主计划＋追投</div></div>
        <div class="bcell"><div class="l">主计划流速</div><div class="v num" id="vBasicFlow">--</div><div class="s" id="vBasicFlowS">近15分钟拆分</div></div>
        <div class="bcell"><div class="l">追投流速</div><div class="v num" id="vAssistFlow">--</div><div class="s" id="vAssistFlowS">近15分钟拆分</div></div>
        <div class="bcell"><div class="l" id="lOrd">订单</div><div class="v num" id="vOrd">--</div><div class="s">净口径</div></div>
        <div class="bcell"><div class="l">在线</div><div class="v num" id="vOn">--</div><div class="s" id="vOnS"></div></div>
        <div class="bcell"><div class="l">GPM</div><div class="v num" id="vGpm">--</div><div class="s" id="vGpmS">千次观看成交</div></div>
      </div>
      <div class="band-row r2">
        <div class="bcell"><div class="l">观看-成交率</div><div class="v num" id="vW2P">--</div><div class="s">人数口径</div></div>
        <div class="bcell"><div class="l">曝光-观看率</div><div class="v num" id="vS2W">--</div><div class="s">次数口径</div></div>
        <div class="bcell"><div class="l">整体支付ROI</div><div class="v num" id="vRoiAll">--</div><div class="s">账面口径含退款</div></div>
        <div class="bcell"><div class="l">退款率</div><div class="v num" id="vRefund">--</div><div class="s" id="vRefundS">全部口径 · 1h</div></div>
        <div class="bcell"><div class="l">计划出价</div><div class="v num" id="vPlanRoi">--</div><div class="s">主计划 ROI 目标</div></div>
        <div class="bcell"><div class="l">余额</div><div class="v num" id="vBal">--</div><div class="s" id="vBalS"></div></div>
        <div class="bcell"><div class="l">预算消耗</div><div class="v num" id="vBudPct">--</div><div class="s"><span id="vBudS">--</span><div class="pbar" style="margin:4px 0 0"><i id="vBudBar" style="width:0%"></i></div></div></div>
      </div>
    </div>
  </section>

  <section class="wr-live" id="wrLive">
    <div class="wl-main block">
      <div class="sec-title">综合趋势
        <span class="cd" id="trendMeta"></span>
      </div>
      <div class="trend big"><canvas id="trend"></canvas><div class="trend-tip" id="trendTip"></div></div>
      <div class="trend-events"><span class="te-label">事件</span><span class="te-track" id="teTrack"></span><span class="te-legend"><i class="te-dot put"></i>投放<i class="te-dot warn"></i>预警</span></div>
    </div>
    <div class="wl-side block">
      <div class="sec-title">追投任务 <span class="cd" id="boostSum"></span><span class="cd" style="float:right">只读 · 操盘在千川后台</span></div>
      <div class="b-list" id="boosts"></div>
      <div class="b-foot" id="boostFoot"></div>
    </div>
  </section>

  <section class="wr-midrow" id="wrMidRow" style="display:none">
    <div class="block">
      <div class="sec-title">直播间核心漏斗 · 本场</div>
      <div class="wl-funnel2" id="wrFunnel"></div>
    </div>
    <div class="block">
      <div class="sec-title">成交渠道构成 · 本场 <button class="chan-toggle" id="chanToggle" style="display:none">⇆ 观看次数</button></div>
      <div class="wl-channel" id="wrChannel"></div>
    </div>
    <div class="block">
      <div class="sec-title">人群画像 · 实时（罗盘）</div>
      <div class="wl-portrait" id="wrPortrait"></div>
    </div>
  </section>

  <section class="block" id="wrBoostTime" style="display:none">
    <div class="sec-title">追投时段效果 <span class="cd">当月 · 样本不足自动标注</span>
    </div>
    <div class="bt-disclaimer">仅人工参考 · 禁止作为追投决策依据（历史平均受素材/大盘/主播影响，波动大）</div>
    <div class="bt-live-slots" id="btLiveSlots" style="display:none"></div>
    <div class="wr-bt" id="btBox">${V4.emptyBox('加载中…')}</div>
  </section>

  <section class="block" id="wrMatsWrap">
    <div class="sec-title">素材榜 <span class="cd">表现较好 / 待观察 / 低效信号</span></div>
    <div class="m3" id="mats3"></div>
  </section>

  <section class="main wr-main">
    <div class="block">
      <div class="sec-title">决策流
        <span class="m-tabs"><button class="on" data-flow="today">今日</button><button data-flow="all">全部</button></span>
        <input type="date" id="flowDate" style="display:none">
      </div>
      <div class="flow" id="flow">${V4.emptyBox('加载中…')}</div>
    </div>
    <div class="col wr-col">
      <div class="block" id="wrScrBox" style="display:none">
        <div class="sec-title">罗盘实况 · 近5分钟 <span class="cd" id="wrScrUpd"></span></div>
        <div class="wl-pulse" id="wrScrVitals"></div>
        <div class="sec-title" style="margin-top:14px">本场热卖</div>
        <div class="wl-prods" id="wrScrProducts"></div>
        <div class="sec-title" style="margin-top:14px">直播间订单 · 本场已支付 <span class="cd" id="wrOrdUpd"></span></div>
        <div class="wl-orders" id="wrOrders"></div>
        <div class="wr-scr-extra" id="wrScrExtra"></div>
      </div>
      <div class="block" id="bossBlock" style="display:none">
        <div class="sec-title">老板评审</div>
        <div class="boss">
          <div class="g" id="bossG">-</div>
          <div><div class="s" id="bossS"></div>
          <div class="q" id="bossQ"></div></div>
        </div>
      </div>
    </div>
  </section>`;

  V4.pages.warroom = {
    mount(view) {
      view.innerHTML = HTML;
      const S = { mode: 'off', roi: 0, be: V4.breakEven(), delta: 0, hasToday: false, previousSessionRoi: null, decisions: { redList: [], blackList: [] }, dash: null, splitTab: 'today', splitToday: null, flowMode: 'today', marginalFlow: null, marginalRoomId: null };
      const stoppers = [];
      /* 账号快照 + 存活判断：切账号/切页后，在途请求统一作废（不写缓存不写 DOM） */
      const acct0 = V4.acct();
      let dead = false;
      const alive = () => !dead && V4.acct() === acct0;

      /* ===== 趋势图（2026-08-18 维护者改令：四线合一，双轴，无切换按钮） =====
         净ROI=累计口径（左轴，状态色+渐变+保本线）；区间ROI=每5分钟边际（左轴，橙虚线）；
         净成交/消耗=5分钟区间值（右轴，青/灰蓝细线） */
      const tc = $('trend'), tx = tc.getContext('2d');
      let trendRaw = [], trendRoi = [], trendRoiSeg = [], trendGmv = [], trendCost = [];
      function drawTrendFrame(hoverIdx) {
        const dpr = devicePixelRatio || 1, w = tc.clientWidth, h = tc.clientHeight;
        if (!w || !h) return;
        if (tc.width !== w * dpr) { tc.width = w * dpr; tc.height = h * dpr; }
        tx.setTransform(dpr, 0, 0, dpr, 0, 0);
        tx.clearRect(0, 0, w, h);
        const off = S.mode === 'off';
        const roi = trendRoi && trendRoi.length ? trendRoi : (off ? [] : [S.be]);
        const len = Math.max(roi.length, trendGmv.length, trendCost.length);
        if (!len) return;
        const min = Math.min(...roi, S.be) - .15, max = Math.max(...roi, S.be) + .15;
        const amax = Math.max(...trendGmv, ...trendCost, 1) * 1.12;
        const X = i => i / (len - 1) * (w - 4) + 2;
        const Yr = v => h - 4 - (v - min) / (max - min) * (h - 12);   // ROI 左轴
        const Ya = v => h - 4 - (v / amax) * (h - 12);                 // 金额右轴
        // 保本虚线（左轴 ROI 刻度）
        tx.strokeStyle = 'rgba(148,163,184,.3)'; tx.setLineDash([3, 5]); tx.lineWidth = 1;
        tx.beginPath(); tx.moveTo(0, Yr(S.be)); tx.lineTo(w, Yr(S.be)); tx.stroke(); tx.setLineDash([]);
        tx.fillStyle = 'rgba(120,131,145,.8)'; tx.font = '9px ' + getComputedStyle(document.body).fontFamily;
        tx.fillText('保本 ' + S.be.toFixed(1), 4, Yr(S.be) - 5);
        if (off) return;
        const traceSmooth = (P) => {
          tx.beginPath();
          P.forEach((p, i) => {
            if (!i) { tx.moveTo(p.x, p.y); return; }
            const p0 = P[Math.max(0, i - 2)], p1 = P[i - 1], p2 = p, p3 = P[Math.min(P.length - 1, i + 1)];
            tx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
                             p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
          });
          tx.stroke();
        };
        // 历史账户专用说明已从试用包移除。
        if (trendRoiSeg && trendRoiSeg.length > 1) {
          const P = trendRoiSeg.map((v, i) => ({ x: X(i), y: Yr(Math.max(min, Math.min(max, v))) }));
          tx.strokeStyle = '#f59e0b'; tx.lineWidth = 1.2; tx.setLineDash([4, 3]);
          tx.lineJoin = 'round'; tx.lineCap = 'round';
          traceSmooth(P);
          tx.setLineDash([]);
        }
        // 净ROI（主曲线：渐变填充 + 状态色）
        if (roi.length > 1) {
          const col = V4.PULSE_COLOR[S.mode];
          const P = roi.map((v, i) => ({ x: X(i), y: Yr(v) }));
          tx.save();
          tx.beginPath();
          P.forEach((p, i) => { if (!i) { tx.moveTo(p.x, p.y); return; } const a = P[Math.max(0, i - 2)], b = P[i - 1], c = p, d = P[Math.min(P.length - 1, i + 1)]; tx.bezierCurveTo(b.x + (c.x - a.x) / 6, b.y + (c.y - a.y) / 6, c.x - (d.x - b.x) / 6, c.y - (d.y - b.y) / 6, c.x, c.y); });
          tx.lineTo(w, h); tx.lineTo(0, h); tx.closePath();
          const grad = tx.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, col + '2e'); grad.addColorStop(1, col + '00');
          tx.fillStyle = grad; tx.fill();
          tx.restore();
          tx.strokeStyle = col; tx.lineWidth = 2.2; tx.lineJoin = 'round'; tx.lineCap = 'round';
          traceSmooth(P);
          const lx = X(roi.length - 1), ly = Yr(roi[roi.length - 1]);
          tx.beginPath(); tx.arc(lx, ly, 5, 0, 7); tx.fillStyle = 'rgba(255,255,255,.9)'; tx.fill();
          tx.beginPath(); tx.arc(lx, ly, 3, 0, 7); tx.fillStyle = col; tx.fill();
        }
        // 净成交（青）/ 消耗（灰蓝）：细线右轴
        const aux = (arr, col) => {
          if (!arr || arr.length < 2) return;
          const P = arr.map((v, i) => ({ x: X(i), y: Ya(v) }));
          tx.strokeStyle = col; tx.lineWidth = 1.4; tx.lineJoin = 'round'; tx.lineCap = 'round';
          traceSmooth(P);
        };
        aux(trendGmv, '#22d3ee');
        aux(trendCost, '#7c8da6');
        // 悬停引导线 + 各序列高亮点
        if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < len) {
          const hx = X(hoverIdx);
          tx.strokeStyle = 'rgba(226,232,240,.35)'; tx.setLineDash([2, 3]); tx.lineWidth = 1;
          tx.beginPath(); tx.moveTo(hx, 2); tx.lineTo(hx, h - 4); tx.stroke(); tx.setLineDash([]);
          const dot = (arr, Yf, col) => { if (hoverIdx < arr.length) { const y = Yf(arr[hoverIdx]); tx.beginPath(); tx.arc(hx, y, 3.2, 0, 7); tx.fillStyle = col; tx.fill(); } };
          dot(trendRoi, Yr, V4.PULSE_COLOR[S.mode]);
          dot(trendRoiSeg, Yr, '#f59e0b');
          dot(trendGmv, Ya, '#22d3ee');
          dot(trendCost, Ya, '#7c8da6');
        }
      }
      const onResize = () => drawTrendFrame();
      addEventListener('resize', onResize);

      /* 趋势序列（2026-08-18 维护者改令：四线合一）——净ROI=累计；区间ROI=每5分钟边际；净成交/消耗=5分钟区间值 */
      function applyTrendMetric() {
        if (!trendRaw || !trendRaw.length) { trendRoi = []; trendRoiSeg = []; trendGmv = []; trendCost = []; drawTrendFrame(); return; }
        trendGmv = trendRaw.map(p => +p.gmvSettle || 0);
        trendCost = trendRaw.map(p => +p.cost || 0);
        let cg = 0, cc = 0;
        trendRoi = trendRaw.map(p => { cg += +p.gmvSettle || 0; cc += +p.cost || 0; return cc > 0 ? +(cg / cc).toFixed(3) : 0; });
        // 区间ROI（边际）：每 5 分钟区间的净成交/消耗（0 消耗点置 0）
        trendRoiSeg = trendRaw.map(p => { const c = +p.cost || 0, g = +p.gmvSettle || 0; return c > 0 ? +(g / c).toFixed(3) : 0; });
        drawTrendFrame();
        const meta = $('trendMeta');
        if (meta) meta.textContent = '净ROI(累计) · 区间ROI · 净成交/消耗';
        renderTrendEvents();
      }

      /* 趋势图事件打点轨道（2026-08-18 吸收罗盘大屏：动作/事件与数据波动强绑定）
         数据源：op-log（投放=create_boost 绿点；告警=suggest/alert 红点），30s 节流拉取 */
      let lastEvtFetch = 0, lastEvts = [];
      async function renderTrendEvents() {
        const track = $('teTrack');
        if (!track || !trendRaw || trendRaw.length < 2) { if (track) track.innerHTML = ''; return; }
        const t0 = String(trendRaw[0].time || ''), t1 = String(trendRaw[trendRaw.length - 1].time || '');
        if (!t0 || !t1) return;
        const base = new Date().toDateString();
        const p0 = new Date(base + ' ' + t0).getTime(), p1 = new Date(base + ' ' + t1).getTime();
        if (!(p1 > p0)) return;
        const now = Date.now();
        if (now - lastEvtFetch > 30000 || !lastEvts.length) {
          try {
            const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
            const j = await V4.api('/api/op-log', { limit: 100, accountId: acct0, start: today, end: today });
            lastEvts = (j && j.logs) || [];
          } catch (e) { return; }
          lastEvtFetch = now;
        }
        const dots = [];
        for (const l of lastEvts) {
          const ts = new Date(String(l.ts || '').replace(' ', 'T')).getTime();
          if (!ts || ts < p0 || ts > p1) continue;
          const a = String(l.action || '');
          const kind = a === 'create_boost' ? 'put' : (/alert|suggest|_stop/i.test(a) ? 'warn' : null);
          if (!kind) continue;
          const x = (ts - p0) / (p1 - p0) * 100;
          dots.push(`<span class="te-dot ${kind}" style="left:${x.toFixed(1)}%" title="${esc(l.ts || '')} ${esc(a)}${l.result_msg ? ' · ' + esc(String(l.result_msg).slice(0, 80)) : ''}"></span>`);
        }
        track.innerHTML = dots.join('');
      }
      // 趋势刷新后同步打点（applyTrendMetric 末尾已调用 renderTrendEvents）
      tc.addEventListener('mousemove', e => {
        const len = Math.max(trendRoi.length, trendGmv.length, trendCost.length);
        if (len < 2) return;
        const rect = tc.getBoundingClientRect();
        const w = tc.clientWidth;
        const frac = idx => idx / (len - 1);
        const i = Math.round((e.clientX - rect.left - 2) / (w - 4) * (len - 1));
        const idx = Math.max(0, Math.min(len - 1, i));
        drawTrendFrame(idx);
        const tip = $('trendTip');
        if (!tip) return;
        const raw = trendRaw[idx];
        const tiptime = raw && raw.time ? V4.fmtCnTime(raw.time).full : '--';
        const roiV = idx < trendRoi.length ? (+trendRoi[idx]).toFixed(2) : '--';
        const roiSegV = idx < trendRoiSeg.length ? (+trendRoiSeg[idx]).toFixed(2) : '--';
        const gmvV = idx < trendGmv.length ? fmtMoney(trendGmv[idx]) : '--';
        const costV = idx < trendCost.length ? fmtMoney(trendCost[idx]) : '--';
        tip.innerHTML = raw
          ? `<b>${esc(tiptime)}</b>　累计净ROI <b>${roiV}</b>　区间ROI <b>${roiSegV}</b><br>净成交 ${gmvV} · 消耗 ${costV}`
          : `累计净ROI <b>${roiV}</b>　区间ROI <b>${roiSegV}</b>　净成交 ${gmvV} · 消耗 ${costV}`;
        tip.style.display = 'block';
        tip.style.left = (frac(idx) > 0.62 ? Math.max(4, frac(idx) * (w - 4) - 260) : frac(idx) * (w - 4) + 12) + 'px';
      });
      tc.addEventListener('mouseleave', () => {
        drawTrendFrame();
        const tip = $('trendTip');
        if (tip) tip.style.display = 'none';
      });

      /* ===== 切账号秒上：内存 CACHE → sessionStorage（刷新存活）→ 立即上屏（缓存标记），后台拉新覆盖 ===== */
      // 先清画布与序列，避免残留上一账号的趋势线
      trendRoi = []; trendGmv = []; trendCost = []; trendRaw = [];
      drawTrendFrame();
      // F5刷新时跳过缓存恢复，直接拉新数据（避免双层缓存叠加导致旧数据）
      const isReload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
      if (isReload) { try { const ks = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith('v4c_')) ks.push(k); } ks.forEach(k => sessionStorage.removeItem(k)); } catch (e) {} }
      let C0 = isReload ? null : CACHE[acct0];
      if (!C0) {
        const pd = V4.cget('v4c_dash_' + acct0, 2 * 3600 * 1000);
        const ps = V4.cget('v4c_split_' + acct0 + '_' + localDate(0), 2 * 3600 * 1000);
        const pr = V4.cget('v4c_rounds_' + acct0, 2 * 3600 * 1000);
        const pp = V4.cget('v4c_pend_' + acct0, 2 * 3600 * 1000);
        const pb = V4.cget('v4c_boss_' + acct0, 2 * 3600 * 1000);
        if (pd || ps || pr || pp || pb) {
          C0 = {};
          if (pd && pd.data) { C0.j = pd.data.j; C0.trendRaw = pd.data.trendRaw; C0.updText = pd.data.updText; }
          if (ps && ps.data) { C0.split = ps.data; C0.splitToday = { payload: ps.data, date: localDate(0), ts: ps.ts }; }
          if (pr && pr.data) C0.rounds = pr.data;
          if (pp && pp.data) C0.pend = pp.data;
          if (pb && pb.data !== undefined) C0.boss = pb.data;
          CACHE[acct0] = C0; // 回写内存层，后续按内存路径走
        }
      }
      if (C0) {
        if (C0.j) applyDash(C0.j, { fromCache: true }); // 缓存渲染：跳过 home-split 回填与 touch，避免与首轮刷新交错
        if (C0.trendRaw && C0.trendRaw.length) { trendRaw = C0.trendRaw; applyTrendMetric(); }
        if (C0.rounds) renderRoundsData(C0.rounds);
        if (C0.boss !== undefined) renderBossData(C0.boss);
        if (C0.split) renderSplitData(C0.split);
        if (C0.splitToday) S.splitToday = C0.splitToday;
        if (C0.j) renderCoreFreshness(C0.j);
      } else {
        // 无缓存 → 显示加载中，避免残留上一账号数据
        $('stateWord').textContent = '加载中…';
        $('roiNum').textContent = '--';
        $('upd').textContent = '正在拉取数据…';
      }

      /* ===== 五档状态判定（替代原 top/good/warn/bad 一刀切） =====
         告警 > 亏损 > 偏弱 > 健康 > 观望
         输入：live-dashboard payload j；输出：{state, word, colorClass, reason, actionText} */
      function computeLiveState(j) {
        const today = j && j.today;
        const lm = j && j.live_metrics || {};
        const balance = j && j.balance || {};
        const th = j && j.thresholds || {};
        const be = +(th.break_even_roi || (today && today.break_even_roi) || V4.breakEven());
        const avgPrice = +(th.avg_order_price || (today && today.avg_order_price) || 50);
        const exploreLine = avgPrice * 2;
        const netRoi = today ? +(today.netRoi || today.net_roi || 0) : 0;
        const cost = today ? +(today.cost || 0) : 0;
        const isLive = !!(j && j.live && j.live.isLive);

        // 告警优先
        if (balance.days_left != null && +balance.days_left < 1) {
          return { state: 'alert', word: '告警', colorClass: 'st-alert', reason: `余额仅 ${V4.fmtMoney(balance.total_yuan || 0)}（${(+balance.days_left).toFixed(1)} 天）`, actionText: '建议充值' };
        }

        // 不在播：单独一档（对接直播复盘场次：今天播过=已下播并保留终场数据；没播过=未在播）
        if (!isLive) {
          const ts = j && j.today_sessions;
          const played = ts && ts.count > 0;
          return {
            state: 'off',
            word: played ? '已下播' : '未在播',
            colorClass: 'st-off',
            reason: played ? `今日已播 ${ts.count} 场，全部已结束` : '当前无直播，低频待命',
            actionText: '',
          };
        }

        // 亏损：净ROI < 保本×0.5 且 本场消耗 ≥ 客单价×2
        if (netRoi < be * 0.5 && cost >= exploreLine) {
          return { state: 'loss', word: '亏损', colorClass: 'st-loss', reason: `净ROI ${netRoi.toFixed(2)} 低于保本线 ${be.toFixed(2)} 的一半，本场消耗 ${V4.fmtMoney(cost)} 已过探索线 ${V4.fmtMoney(exploreLine)}`, actionText: '建议止损或删素材' };
        }

        // 偏弱：保本×0.5 ≤ 净ROI < 保本线
        if (netRoi < be) {
          return { state: 'weak', word: '偏弱', colorClass: 'st-weak', reason: `净ROI ${netRoi.toFixed(2)} 低于保本线 ${be.toFixed(2)}，但未触发止损线 ${(be * 0.5).toFixed(2)}`, actionText: '继续观察' };
        }

        // 健康：净ROI ≥ 保本线（优先级高于观望——ROI 站线上即使消耗未过线也判健康）
        if (netRoi >= be) {
          return { state: 'ok', word: '健康', colorClass: 'st-ok', reason: `净ROI ${netRoi.toFixed(2)} ≥ 保本线 ${be.toFixed(2)}`, actionText: '盘面健康' };
        }

        // 观望（兜底）：净ROI 深度低于保本但消耗未过探索线 → 样本不足
        return { state: 'watch', word: '观望', colorClass: 'st-watch', reason: `净ROI ${netRoi.toFixed(2)} 偏低但全素材消耗未过探索线 ${V4.fmtMoney(exploreLine)}，样本不足`, actionText: '耐心等消耗过线' };
      }

      /* ===== 第二行：本轮判定（emoji + 状态词 + 原因 + 建议动作） =====
         之前 apply() 调用但未定义，ReferenceError 把后面的 odo(roiNum) 全堵死，净ROI 卡片永远 -- */
      function renderJudgment() {
        const box = $('bandJudgment');
        if (!box) return;
        const st = S.liveState;
        if (!st) { box.style.display = 'none'; return; }
        box.className = 'band-judgment ' + st.colorClass;
        $('jText').textContent = `${st.word}——${st.reason}${st.actionText ? '，' + st.actionText : ''}`;
        box.style.display = '';
      }

      function currentRoomId(j) {
        const room = j && j.live && j.live.rooms && j.live.rooms[0];
        return room && (room.roomId != null || room.room_id != null)
          ? String(room.roomId != null ? room.roomId : room.room_id)
          : null;
      }

      function renderMarginalFlow() {
        const live = !!(S.dash && S.dash.live && S.dash.live.isLive);
        const slice = S.marginalFlow;
        const quality = slice && slice.data_quality;
        const hasRate = !!(slice && (slice.total_spend_rate_hour != null || slice.spend_rate_hour != null));
        const hasMinutes = !!(slice && slice.actual_window_minutes != null);
        const rate = hasRate ? Number(slice.total_spend_rate_hour != null ? slice.total_spend_rate_hour : slice.spend_rate_hour) : NaN;
        const minutes = hasMinutes ? Number(slice.actual_window_minutes) : NaN;
        const available = live && slice && slice.stale !== true
          && (quality === 'complete' || quality === 'partial')
          && hasRate && hasMinutes && Number.isFinite(rate) && Number.isFinite(minutes) && minutes > 0;
        const room = S.dash && S.dash.live && S.dash.live.rooms && S.dash.live.rooms[0];
        const startMs = room && room.startTime ? V4.parseT(room.startTime).getTime() : 0;
        const sessionSpend = S.dash && S.dash.today && S.dash.today.cost != null && Number.isFinite(+S.dash.today.cost)
          ? +S.dash.today.cost : null;
        const elapsedMinutes = live && startMs > 0 ? Math.max(0, (Date.now() - startMs) / 60000) : 0;
        const sessionAverage = sessionSpend != null && elapsedMinutes > 0
          ? sessionSpend * 60 / elapsedMinutes : null;
        const liveMetrics = S.dash && S.dash.live_metrics;
        const sessionBasicCost = liveMetrics && liveMetrics.basicCost != null && Number.isFinite(Number(liveMetrics.basicCost))
          ? Number(liveMetrics.basicCost) : NaN;
        const sessionAssistCost = liveMetrics && liveMetrics.assistCost != null && Number.isFinite(Number(liveMetrics.assistCost))
          ? Number(liveMetrics.assistCost) : NaN;
        const sessionBasicAverage = elapsedMinutes > 0 && Number.isFinite(sessionBasicCost)
          ? sessionBasicCost * 60 / elapsedMinutes : NaN;
        const sessionAssistAverage = elapsedMinutes > 0 && Number.isFinite(sessionAssistCost)
          ? sessionAssistCost * 60 / elapsedMinutes : NaN;
        const splitQuality = slice && slice.flow_split_quality;
        const splitMinutes = slice && Number.isFinite(Number(slice.flow_split_actual_minutes))
          ? Math.max(0, Number(slice.flow_split_actual_minutes)) : 0;
        const splitPendingText = splitQuality === 'partial' || splitQuality === 'collecting'
          ? `拆分采样 ${Math.round(splitMinutes)}/15分钟 · 暂不可用于决策`
          : `拆分${splitQuality || '采样中'} · 暂不可用`;
        const basicRate = slice && slice.basic_spend_rate_hour != null ? Number(slice.basic_spend_rate_hour) : NaN;
        const assistRate = slice && slice.assist_spend_rate_hour != null ? Number(slice.assist_spend_rate_hour) : NaN;
        const assistShare = slice && slice.assist_share_pct != null ? Number(slice.assist_share_pct) : NaN;
        const splitAvailable = available && splitQuality === 'complete'
          && Number.isFinite(basicRate) && Number.isFinite(assistRate) && Number.isFinite(assistShare);
        const sessionSplitAvailable = !splitAvailable && live
          && Number.isFinite(sessionBasicAverage) && Number.isFinite(sessionAssistAverage);
        odo($('vFlow'), available ? '¥' + Math.round(rate) + '/h' : '--');
        $('vFlowS').textContent = available
          ? `主计划＋追投 · 实际${minutes}分钟${quality === 'partial' ? ' · 区间形成中' : ''}${sessionAverage != null ? ` · 整场均速 ¥${Math.round(sessionAverage)}/h` : ''}`
          : (live ? '区间不可用' : '未在直播');
        odo($('vBasicFlow'), splitAvailable ? `¥${Math.round(basicRate)}/h`
          : (sessionSplitAvailable ? `¥${Math.round(sessionBasicAverage)}/h` : '--'));
        $('vBasicFlowS').textContent = splitAvailable
          ? `占总流速 ${Math.max(0, 100 - assistShare).toFixed(1)}%`
          : (sessionSplitAvailable ? `本场均速 · ${splitPendingText}` : (live ? splitPendingText : '未在直播'));
        odo($('vAssistFlow'), splitAvailable ? `¥${Math.round(assistRate)}/h`
          : (sessionSplitAvailable ? `¥${Math.round(sessionAssistAverage)}/h` : '--'));
        $('vAssistFlowS').textContent = splitAvailable
          ? `追投占比 ${assistShare.toFixed(1)}%`
          : (sessionSplitAvailable ? `本场均速 · ${splitPendingText}` : (live ? splitPendingText : '未在直播'));
        fitV($('vFlow'));
        fitV($('vBasicFlow'));
        fitV($('vAssistFlow'));
      }

      /* ===== 状态渲染 ===== */
      function apply() {
        const st = computeLiveState(S.dash);
        S.liveState = st;
        const w = $('stateWord');
        flip(w, st.word);
        w.className = 'state-word ' + st.colorClass;
        // 生动化：整站粒子背景随盘面盈亏呼吸变色变速（健康绿缓流/临界黄/亏损红湍流/下播灰静止）；
        // 作战室顶部同步状态色环境光晕——颜色唯一来源仍是状态计算，不为装饰新增色彩
        if (V4.pulse) V4.pulse.setMode(S.mode);
        const bandEl = view.querySelector('.band-state');
        if (bandEl) bandEl.style.setProperty('--wrGlow', (V4.PULSE_COLOR[S.mode] || V4.PULSE_COLOR.off) + '2e');
        renderJudgment();
        // 未在播：顶部只留计划出价/余额；净ROI 空或固定上一场终值，不拿今日累计冒充本场
        view.querySelector('.band').classList.toggle('off-compact', S.mode === 'off');
        view.querySelectorAll('.band .bcell').forEach(el => {
          const vidEl = el.querySelector('.v');
          const vid = vidEl ? vidEl.id : '';
          el.style.display = S.mode === 'off' && vid !== 'vPlanRoi' && vid !== 'vBal' ? 'none' : '';
        });
        odo($('roiNum'), S.mode === 'off'
          ? (S.previousSessionRoi != null ? S.previousSessionRoi.toFixed(2) : '--')
          : (S.hasToday === false ? '--' : S.roi.toFixed(2)));
        const d = S.delta;
        $('roiDelta').textContent = S.mode === 'off'
          ? (S.previousSessionRoi != null ? '上一场净ROI · 终值' : '未在播 · 无本场ROI')
          : `${st.reason} · ${st.actionText}${d ? ' · 较上轮 ' + (d >= 0 ? '+' : '') + (+d).toFixed(2) : ''}`;
        // 记分牌状态色：净ROI 对照净保本线三档（2026-07-30 审计修复：此前用支付ROI(tdy.roi)对照净保本线，
        // 支付 2.20/净 1.95 也会被染绿"健康"，偏乐观）/ 余额可用天数<2 danger / 退款率>15% warn、>25% danger
        const tdy = S.dash && S.dash.today;
        const roiAll = tdy && tdy.netRoi != null ? +tdy.netRoi : (tdy && tdy.roi != null ? +tdy.roi : (S.splitAll && S.splitAll.roi != null ? +S.splitAll.roi : null));
        setSt('vRoiAll', roiAll == null ? '' : ROI_ST[V4.modeOf(roiAll, S.be)]);
        const daysLeft = S.dash && S.dash.balance && S.dash.balance.days_left;
        setSt('vBal', daysLeft != null && +daysLeft < 2 ? 'st-danger' : '');
        const rf = S.splitAll && S.splitAll.refund_rate != null ? +S.splitAll.refund_rate : null;
        setSt('vRefund', rf == null ? '' : rf > 25 ? 'st-danger' : rf > 15 ? 'st-warn' : '');
        ['vCost', 'vFlow', 'vBasicFlow', 'vAssistFlow', 'vGmv', 'vOrd', 'vBal', 'vOn', 'vRoiAll', 'vRefund', 'vGpm', 'vW2P', 'vS2W', 'vPlanRoi'].forEach(id => fitV($(id)));
        drawTrendFrame(); // 2026-08-18 三线合一：原 tweenTrend 动画已移除，数据到位直绘
      }

      /* ===== 开播时间/已播时长（直播中"今日第 N 场 · 已播 XhYm"秒级跟手；下播"今日已播 N 场 · 终场定格"） ===== */
      function updateSince(j) {
        const sinceEl = $('liveSince');
        if (!sinceEl) return;
        const room = (j && j.live && j.live.rooms && j.live.rooms[0]) || null;
        const startMs = room && room.startTime ? V4.parseT(room.startTime).getTime() : 0;
        const tSess = (j && j.today_sessions) || null;
        const live = !!(j && j.live && j.live.isLive);
        if (live && startMs && Date.now() > startMs) {
          const st = new Date(startMs);
          const sessTag = tSess && tSess.live_index ? `今日第 ${tSess.live_index} 场 · ` : '';
          sinceEl.textContent = `${sessTag}开播 ${V4.p2(st.getHours())}:${V4.p2(st.getMinutes())} · 已播 ${V4.durTxt(Date.now() - startMs)}`;
          sinceEl.style.display = '';
        } else if (!live && tSess && tSess.count > 0) {
          const last = (tSess.list || []).slice(-1)[0] || null;
          const endD = last && last.endTime ? V4.parseT(last.endTime) : null;
          sinceEl.textContent = `今日已播 ${tSess.count} 场${endD ? ` · 最近 ${V4.p2(endD.getHours())}:${V4.p2(endD.getMinutes())} 下播` : ''}${view.classList.contains('is-frozen') ? ' · 终场定格' : ''}`;
          sinceEl.style.display = '';
        } else {
          sinceEl.style.display = 'none';
        }
      }

      /* ===== 主数据渲染（payload → 全页，不含拉取；off 回落优先复用 home-split 缓存） ===== */
      async function applyDash(j, opts) {
        const fromCache = !!(opts && opts.fromCache);
        S.dash = j;
        const isLive = !!(j.live && j.live.isLive);
        const roomId = currentRoomId(j);
        if (!isLive || !roomId || S.marginalRoomId !== roomId) {
          S.marginalFlow = null;
          S.marginalRoomId = roomId;
        }
        renderMarginalFlow();
        const sessList = (j.today_sessions && j.today_sessions.list) || [];
        const lastSess = sessList[sessList.length - 1] || null;
        S.previousSessionRoi = lastSess && lastSess.netRoi != null ? +lastSess.netRoi : null;
        if (!isLive) j.today = null; // 未在播不拿今日累计当本场；上一场净ROI 走 previousSessionRoi 固定展示
        let today = j.today;
        // 上游异常时 today 可能是 {error:...} 异形对象（liveDashboard catch 兜底）：缺核心数值字段按无 today 处理——显示 --，且放行下面的 home-split 回填
        if (today && (typeof today !== 'object' || (typeof today.cost !== 'number' && typeof today.netRoi !== 'number'))) today = null;
        if (!today && !isLive && !fromCache && !j.collecting) { // 在播核心缺失不等待日汇总，更不能把当日冒充本场
          // F1：优先复用 refreshSplit 的今日缓存（60s 轮询会刷新它），避免与 refreshSplit 双倍消耗频控额度
          try {
            let sp = (S.splitToday && S.splitToday.date === localDate(0)) ? S.splitToday.payload : null;
            if (!sp) {
              sp = await V4.api('/api/home-split', { date: localDate(0) });
              if (!alive()) return;
              S.splitToday = { payload: sp, date: localDate(0), ts: Date.now() };
              const C = CACHE[acct0] = CACHE[acct0] || {};
              C.splitToday = S.splitToday;
            }
            const L = sp && sp.live;
            if (L && !L.unavailable) today = { cost: L.cost, netRoi: L.roi, netGmv: L.gmv, orderCount: L.orders, roi: L.roi };
          } catch (e) {}
        }
        j.today = today; // 让 renderPlan 等下游用上回填后的 today（本场/今日口径随 isLive 而定）
        /* ===== 下播冻结：直播中持续快照最后一帧；下播后用快照填满页面（终场定格），不整页清空 ===== */
        if (isLive && !fromCache) {
          S.frozenLive = {
            at: Date.now(),
            funnel: j.funnel || null,
            source: j.source || [],
            decisions: j.decisions || null,
            materials_top: j.materials_top || [],
          };
          V4.cset('v4c_frozen_' + acct0, S.frozenLive); // F5 刷新也能恢复终场
        }
        if (!S.frozenLive) { // 懒恢复：切账号/F5 后第一轮下播态也有终场可看
          const pf = V4.cget('v4c_frozen_' + acct0, 12 * 3600 * 1000);
          if (pf && pf.data) S.frozenLive = pf.data;
        }
        const fz = (!isLive && S.frozenLive) ? S.frozenLive : null;
        if (fz) {
          if (!j.funnel) j.funnel = fz.funnel;
          if (!j.source || !j.source.length) j.source = fz.source;
          const dj = j.decisions || {};
          const dEmpty = !(dj.redList && dj.redList.length) && !(dj.blackList && dj.blackList.length) && !(dj.potentialList && dj.potentialList.length);
          if (dEmpty && fz.decisions) j.decisions = fz.decisions;
          if ((!j.materials_top || !j.materials_top.length) && fz.materials_top && fz.materials_top.length) j.materials_top = fz.materials_top;
        }
        view.classList.toggle('is-frozen', !!fz); // CSS：冻结区降饱和，视觉上"定格"
        const th = j.thresholds || {};
        S.be = +(th.break_even_roi || (today && today.break_even_roi) || V4.breakEven());
        const netRoi = today ? +(today.netRoi || 0) : 0;
        S.roi = netRoi;
        S.hasToday = !!(isLive && today);
        // 冷启动：开播初期消耗未达探索线时 ROI 无统计意义，不判盈亏（避免"刚开播=正在亏损"的误报）
        const avgPrice = +(th.avg_order_price || (today && today.avg_order_price) || 50);
        const exploreLine = +(th.explore_line || (today && today.avg_order_price ? today.avg_order_price * 1.5 : 0) || 80);
        const costNow = today ? +today.cost || 0 : 0;
        S.avgPrice = avgPrice;
        S.exploreLine = exploreLine;
        S.mode = !isLive ? 'off' : costNow < exploreLine ? 'cold' : V4.modeOf(netRoi, S.be);
        S.delta = (j.context && +j.context.roi_delta) || 0;
        const lm = j.live_metrics || {};
        // 文案口径：直播中=本场会话（直播大屏），下播=今日（推直播间日累计）
        $('lCost').textContent = isLive ? '本场消耗' : '今日消耗';
        $('lGmv').textContent = isLive ? '本场净成交' : '今日净成交';
        $('lOrd').textContent = isLive ? '本场订单' : '今日订单';
        odo($('vCost'), today ? fmtMoney(today.cost) : '--');
        $('vCostS').textContent = today && today.cost ? (isLive ? '本场会话' : '今日累计') : '';
        odo($('vGmv'), today ? fmtMoney(today.netGmv) : '--');
        $('vGmvS').textContent = today && today.netGmv ? '扣退款净口径' : '';
        const ordV = today ? (today.orderCount != null ? today.orderCount : today.orders) : null;
        odo($('vOrd'), ordV != null ? String(Math.round(ordV)) : '--'); // 场次聚合口径无订单数，显示 -- 不显示假零
        odo($('vBal'), j.balance && j.balance.total_yuan != null ? fmtM(j.balance.total_yuan) : '--'); // 余额获取失败显示 --，不显示假零
        $('vBalS').textContent = j.balance && j.balance.days_left ? `可用 ${(+j.balance.days_left).toFixed(1)} 天` : '';
        odo($('vOn'), isLive ? (lm.online == null ? '--' : String(Math.round(lm.online))) : '0');
        $('vOnS').textContent = isLive && lm.gpm ? `GPM ${Math.round(lm.gpm)}` : ''; // 下播时顶部状态词已表达"已下播/未在播"，副文案留空不重复
        // 新增三格：整体支付ROI（账面）/ 退款率（home-split 全部口径）/ GPM
        odo($('vRoiAll'), today && today.roi ? (+today.roi).toFixed(2) : (S.splitAll && S.splitAll.roi ? (+S.splitAll.roi).toFixed(2) : '--'));
        odo($('vRefund'), S.splitAll && S.splitAll.refund_rate != null ? (+S.splitAll.refund_rate).toFixed(1) + '%' : '--');
        odo($('vGpm'), isLive && lm.gpm ? String(Math.round(lm.gpm)) : '--');
        // 大屏版式新增：观看-成交率 / 曝光-观看率（live_metrics 现成字段）
        odo($('vW2P'), isLive && lm.watchToPayRate != null ? (+lm.watchToPayRate).toFixed(2) + '%' : '--');
        odo($('vS2W'), isLive && lm.showToWatchRate != null ? (+lm.showToWatchRate).toFixed(2) + '%' : '--');
        // 第一行紧凑 vitals（三秒看完）：账号 | 净ROI | 消耗 | 在线 | 余额
        const vitBits = [`<b>${esc(V4.acctName())}</b>`];
        if (today) {
          vitBits.push(`净ROI <b>${(+(today.netRoi || 0)).toFixed(2)}</b>`);
          vitBits.push(`消耗 <b>${fmtMoney(today.cost)}</b>`);
        }
        if (isLive) vitBits.push(`在线 <b>${lm.online == null ? '--' : Math.round(lm.online)}</b>`);
        if (j.balance && j.balance.total_yuan != null) {
          vitBits.push(`余额 <b>${fmtM(j.balance.total_yuan)}</b>${j.balance.days_left != null ? `（${(+j.balance.days_left).toFixed(1)}天）` : ''}`);
        }
        $('bandVitals').innerHTML = vitBits.join('<span class="sep">|</span>');
        // 开播时间与已播时长（抽成 updateSince：applyDash 调一次 + 秒级 tick 本地推算，时钟跟手）
        updateSince(j);
        // 大屏原始入口（直播中显示）：罗盘大屏 + 千川大屏，新标签打开
        const linksEl = $('liveLinks');
        const room = (j.live && j.live.rooms && j.live.rooms[0]) || null;
        if (linksEl) {
          if (isLive && room && room.roomId) {
            const ai = j.account_info || {};
            const compassUrl = `https://compass.jinritemai.com/screen/live/shop?live_room_id=${room.roomId}&live_app_id=2079&source=compass-live-overview`;
            const qcUrl = `https://qianchuan.jinritemai.com/board-next?live_room_id=${room.roomId}&anchorId=${ai.anchorId || ''}&aavid=${ai.aavid || ''}&fromModule=uni_promotion_v2`;
            linksEl.innerHTML = `<a href="${compassUrl}" target="_blank" rel="noopener">罗盘大屏↗</a><a href="${qcUrl}" target="_blank" rel="noopener">千川大屏↗</a>`;
            linksEl.style.display = '';
          } else {
            linksEl.style.display = 'none';
          }
        }
        renderBoosts(j);
        renderPlan(j);
        S.funnel = j.funnel || null;
        renderFunnel();
        renderChannel();
        S.decisions = j.decisions || { redList: [], blackList: [] };
        renderMats();
        apply();
        renderWatchList(j);
        renderCoreFreshness(j);
      }


      function renderWatchList(j) {
        const box = $('bandWatch');
        if (!box) return;
        const today = j && j.today;
        const th = j && j.thresholds || {};
        const be = +(th.break_even_roi || (today && today.break_even_roi) || V4.breakEven());
        const avgPrice = +(th.avg_order_price || (today && today.avg_order_price) || 50);
        const exploreLine = avgPrice * 2;
        const mats = (j && j.materials_top) || [];
        const items = [];
        for (const m of mats) {
          const cost = +(m.cost || 0);
          const roi = +(m.net_roi || m.roiSettle || m.roi || 0);
          const orders = +(m.orders || 0);
          const overLine = cost >= exploreLine;
          let iconSt = '', text = '';
          if (overLine && orders === 0) {
            iconSt = 'warn'; text = `空耗中，消耗到 ${V4.fmtMoney(exploreLine)} 仍无单`;
          } else if (overLine && roi < be * 0.5) {
            iconSt = 'danger'; text = `净ROI ${roi.toFixed(2)} 低于止损线 ${(be * 0.5).toFixed(2)}`;
          } else if (roi >= be * 1.3 && cost < exploreLine) {
            iconSt = 'ok'; text = `净ROI ${roi.toFixed(2)} 表现好，消耗未过 ${V4.fmtMoney(exploreLine)}`;
          } else if (roi >= be * 1.3 && overLine) {
            iconSt = 'ok'; text = `净ROI ${roi.toFixed(2)} 已达标`;
          }
          if (iconSt) items.push({ iconSt, name: m.name || '--', cost, roi, text });
        }
        if (!items.length) { box.style.display = 'none'; return; }
        box.style.display = '';
        box.innerHTML = items.slice(0, 3).map(it => `
          <div class="w-item">
            <span class="w-icon"><span class="signal-dot ${it.iconSt}"></span></span>
            <span class="w-name" title="${esc(it.name)}">${esc(it.name)}</span>
            <span class="w-cost">${V4.fmtMoney(it.cost)}</span>
            <span class="w-roi ${V4.stateClass(it.roi, be)}">${it.roi.toFixed(2)}</span>
            <span class="w-text">${esc(it.text)}</span>
          </div>
        `).join('');
      }

      function renderCoreFreshness(j) {
        const sourceAt = j?.component_times?.core?.source_at || j?.fetchedAt;
        const ts = Date.parse(sourceAt);
        const age = Number.isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 1000)) : null;
        const isLive = j?.live?.isLive === true;
        const text = age == null ? '核心数据缺失，等待采集' :
          `核心采集 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })} · ${age}秒前` +
          (S.coreReadFailed ? ' · 读取失败，保留旧值' : (isLive && age > 30 ? ' · 更新延迟' : ''));
        const el = $('coreFreshness');
        if (el) {
          el.textContent = text;
          el.style.color = S.coreReadFailed || (isLive && (age == null || age > 30)) ? 'var(--warn)' : 'var(--ink-3)';
          el.title = '显示核心请求的采集起点，不是页面刷新时间；不代表平台内部更新时刻。趋势、素材、人群独立更新。';
        }
        if ($('upd')) $('upd').textContent = text;
      }

      /* ===== 核心 5s 读内存；趋势/在投素材独立轮询，不占核心在飞锁 ===== */
      let dashFlight = false, dashSeq = 0;
      async function refreshDash() {
        if (dashFlight) return; // 在飞锁：慢接口叠加 30s 轮询会双发
        dashFlight = true;
        const my = ++dashSeq;
        try {
          let j;
          try { j = await V4.api('/api/live-dashboard', {}, { timeout: 10000 }); }
          catch (e) { // 无感刷新：有旧帧就不砸错误框，下轮自愈；从未有过数据才显示错误
            if (alive()) { S.coreReadFailed = true; renderCoreFreshness(S.dash); }
            if (alive() && !(S.lastBoosts && S.lastBoosts.length)) $('boosts').innerHTML = V4.errBox(e);
            return;
          }
          if (!alive() || my !== dashSeq) return; // 旧响应不得覆盖新数据
          const C = CACHE[acct0] = CACHE[acct0] || {};
          S.coreReadFailed = false;
          C.j = j; C.updText = j.fetchedAt || null;
          await applyDash(j);
          if (!alive() || my !== dashSeq) return;
          V4.cset('v4c_dash_' + acct0, { j, trendRaw, updText: C.updText });
        } finally { dashFlight = false; }
      }

      async function refreshTrend() {
          const j = S.dash;
          if (!j) return;
          const roomAtRequest = currentRoomId(j);
          try {
            const t = await V4.api('/api/live-trend');
            if (!alive() || currentRoomId(S.dash) !== roomAtRequest) return;
            const trendRoom = t && t.room && (t.room.roomId != null || t.room.room_id != null)
              ? String(t.room.roomId != null ? t.room.roomId : t.room.room_id)
              : null;
            const dashRoom = currentRoomId(j);
            S.marginalFlow = dashRoom && trendRoom === dashRoom && t.marginal ? t.marginal.m15 : null;
            S.marginalRoomId = dashRoom;
            renderMarginalFlow();
            trendRaw = t.trend || [];
            // 下播冻结：接口清空后用终场快照的趋势曲线定格，趋势图不空白
            if (!trendRaw.length && S.frozenLive && S.frozenLive.trendRaw && S.frozenLive.trendRaw.length) {
              trendRaw = S.frozenLive.trendRaw;
            } else if (trendRaw.length && S.frozenLive) {
              S.frozenLive.trendRaw = trendRaw.slice();
              V4.cset('v4c_frozen_' + acct0, S.frozenLive);
            }
            applyTrendMetric();
            const C = CACHE[acct0] = CACHE[acct0] || {};
            C.trendRaw = trendRaw;
          } catch (e) {}
      }

      async function refreshActiveMaterials() {
          const roomAtRequest = currentRoomId(S.dash);
          // 在投素材集合（materials/live status=1）：已暂停/已移除的素材不出操作按钮（失败不更新，fail-open 不误藏）
          try {
            const ml = await V4.api('/api/materials/live', { status: 1, pageSize: 50 });
            if (!alive() || currentRoomId(S.dash) !== roomAtRequest) return;
            if (ml && ml.ok && Array.isArray(ml.rows)) {
              S.activeMats = new Set(ml.rows.map(r => String((r.dimensions && r.dimensions.materialId) || '')).filter(x => x && x !== '0' && x !== '-2'));
              renderMats(); // 拿到在投状态后重渲染素材榜按钮
            }
          } catch (e) {}
      }

      /* ===== 追投占比（告警用） ===== */
      function boostPct(j) {
        const lm = j.live_metrics || {};
        if (lm.assistCost == null) return null;
        const cost = (j.today && j.today.cost) || lm.cost || 0;
        const assist = lm.assistCost || 0;
        return cost > 0 ? +(assist / cost * 100).toFixed(1) : null;
      }
      /* 记分牌数值状态色（颜色唯一来源=状态计算）：st-* class 开关 */
      const ROI_ST = { top: 'st-ok', good: 'st-ok', warn: 'st-warn', low: 'st-warn', bad: 'st-danger' };
      function setSt(id, cls) {
        const el = $(id);
        if (!el) return;
        el.classList.remove('st-ok', 'st-warn', 'st-danger', 'st-live');
        if (cls) el.classList.add(cls);
      }

      /* ===== 告警与待确认操作板块已整体删除（2026-08-03 维护者拍板："需要我管的"卡片多余）——
         pending-ops 人工拍板通道已废（写操作收归 AI+对话拍板）；告警改由维护会话巡查渠道上报 ===== */

      /* ===== 追投任务（无感刷新：快速路径空档时保留旧帧，只有从未有过数据才显示加载态） ===== */
      function renderBoosts(j) {
        const list = j.boost_tasks || [];
        const sum = j.boost_summary;
        // 历史账户专用说明已从试用包移除。
        const pq = j.plan;
        const quotaFoot = pq ? `追投 ${pq.boost_count != null ? pq.boost_count : list.length}/${pq.boost_max || 40} · ${pq.quota_exceeded ? '<b style="color:var(--danger)">控成本额度已用完</b>' : `控成本额度 ${pq.quota_left != null ? fmtM(pq.quota_left) : '--'}<span style="color:var(--ink-3)">（${pq.quota_source === 'api' ? '实时' : '估算'}）</span>`}` : '';
        // 快速路径返回空追投但数据可能还在后台刷新，不误报"无追投"
        if (!list.length) {
          if (j.from_fast_path) {
            if (S.lastBoosts && S.lastBoosts.length) {
              $('boostSum').textContent = '更新中…'; // 旧帧保留，只标状态
              return; // 不动 DOM——消灭每轮"加载中"闪烁
            }
            // 无旧帧：显示轻量占位（任务数已知就不干等明细），完整路径后台跑完自动上屏（2026-08-18 提速）
            const pc = pq && pq.boost_count != null ? `追投 ${pq.boost_count} 个 · 明细加载中…` : '追投明细加载中…';
            $('boosts').innerHTML = V4.emptyBox(pc);
          } else {
            S.lastBoosts = []; // 完整路径的权威空：确实无任务，清掉旧帧
            $('boosts').innerHTML = V4.emptyBox('今日无追投任务');
          }
          $('boostSum').textContent = j.from_fast_path ? $('boostSum').textContent : '—';
          $('boostFoot').innerHTML = quotaFoot; // footer 独立于 b-list 滚动区，常驻可见
          return;
        }
        S.lastBoosts = list;
        if (sum && sum.count) $('boostSum').textContent = `总消耗 ${fmtMoney(sum.total_cost)} · 综合ROI ${(+sum.total_roi).toFixed(2)}`;
        else $('boostSum').textContent = list.length + ' 个任务';
        // 历史账户专用说明已从试用包移除。
        const groupRank = { active: 0, passive_stop: 1, offline_wait: 2, manual_paused: 3 };
        const sortedList = list.slice().sort((a, b) => (groupRank[a.board_group] ?? 0) - (groupRank[b.board_group] ?? 0) || (+b.cost || 0) - (+a.cost || 0));
        $('boosts').innerHTML = sortedList.map(t => {
          const active = t.status === '投放中';
          const pausedDim = t.board_group === 'manual_paused' || t.board_group === 'offline_wait';
          const roi = +(t.net_roi || 0);
          const rc = V4.stateClass(roi, S.be);
          // 亏损任务：在跑且净ROI < 保本×0.8 且消耗 ≥100 → 行左边框 danger；在投任务前置 live 呼吸点
          const bleeding = active && roi < S.be * 0.8 && (+t.cost || 0) >= 100;
          // 历史账户专用说明已从试用包移除。
          return `<div class="b-row${bleeding ? ' bleed' : ''}"${pausedDim ? ' style="opacity:.55"' : ''}>
            <div class="b-top"><span class="b-name" title="${esc(t.name)}">${active ? '<i class="b-live-dot"></i>' : ''}${esc(t.name)}<span class="b-st${t.passive_stop ? ' warn' : ''}">${esc(t.status)}</span></span></div>
            <div class="b-m"><span>消耗 <b>${fmtMoney(t.cost)}</b></span><span>净成交 <b>${fmtMoney(t.net_gmv != null ? t.net_gmv : t.gmv)}</b></span><span><b>${t.order_count || 0}</b> 单</span><span>ROI <b class="${rc}">${roi.toFixed(2)}</b></span><span>目标 <b>${t.roi_goal != null ? (+t.roi_goal).toFixed(2) : '--'}</b></span><span>预算 <b>${fmtM(t.budget)}</b></span></div>
          </div>`;
        }).join('');
        $('boostFoot').innerHTML = quotaFoot;
      }

      /* ===== 主计划（无感刷新：快速路径 plan 空档时保留旧帧） ===== */
      function renderPlan(j) {
        const p = j.plan;
        if (!p) {
          if (S.lastPlan) return; // 旧帧保留，等完整路径带回新值
          return; // 顶部格保持初始 --（2026-07-31 右列独立卡片已删，无空态可填）
        }
        S.lastPlan = p;
        // 历史账户专用说明已从试用包移除。
        if ($('vPlanRoi')) odo($('vPlanRoi'), p.roi_goal != null ? (+p.roi_goal).toFixed(2) : '--');
        // 历史账户专用说明已从试用包移除。
        const hasCost = S.dash && S.dash.today;
        const pct = +(p.spent_pct || 0);
        if ($('vBudPct')) {
          $('vBudPct').textContent = hasCost ? pct.toFixed(1) + '%' : '--';
          $('vBudPct').style.color = hasCost && pct >= 90 ? 'var(--st-danger)' : hasCost && pct >= 70 ? 'var(--st-warn)' : '';
        }
        // 直播中 today.cost 是本场会话口径，下播无 today 时显示 --（不拿错误口径充数）
        if ($('vBudS')) $('vBudS').textContent = (hasCost ? `${fmtM(S.dash.today.cost)} / ` : '预算 ') + fmtM(p.budget);
        if ($('vBudBar')) $('vBudBar').style.width = Math.min(100, pct) + '%';
      }

      /* ===== 素材榜（2026-07-30 维护者拍板：红/潜力/黑三栏并排直出，免切换） ===== */
      function renderMats() {
        const d = S.decisions || {};
        const boosts = (S.dash && S.dash.boost_tasks) || [];
        const COLS = [
          { key: 'red', label: '表现较好', list: d.redList || [] },
          { key: 'pot', label: '继续观察', list: d.potentialList || [] },
          { key: 'black', label: '需要复核', list: d.blackList || [] },
        ];
        const rowHtml = (m, kind) => {
          const roi = +(m.netRoi != null ? m.netRoi : m.roiSettle || 0);
          const cost = +(m.todayCost || m.cost || 0);
          const cpc = m.cpc != null && Number.isFinite(+m.cpc) ? +m.cpc : null;
          const funnelHits = m.funnel && Number.isFinite(+m.funnel.failure_hits) ? +m.funnel.failure_hits : null;
          const rc = V4.stateClass(roi, S.be);
          // 页面只表达证据状态，不在工作台给出直接投放按钮。
          const badge = kind === 'red'
            ? '<span class="badge badge-ok">达标</span>'
            : kind === 'pot'
              ? '<span class="badge badge-ok">潜力信号</span>'
              : (m.exempt || m.action === '保护观察'
                ? '<span class="badge badge-warn">保护观察</span>'
                : `<span class="badge badge-danger">${m.action === '可逆暂停候选' ? '暂停候选' : m.action === '重剪' ? '建议重剪' : '需要复核'}</span>`);
          const activeBoost = boosts.find(t => t.status === '投放中' && String(t.name || '').trim() === String(m.name || '').trim());
          const matGone = S.activeMats && m.material_id && !S.activeMats.has(String(m.material_id));
          const stateHtml = matGone
            ? '<span class="m-off">已暂停/移出</span>'
            : activeBoost
              ? '<span class="m-off">追投中</span>'
              : '';
          const acquisition = cpc != null
            ? `CPC ${cpc.toFixed(2)}${funnelHits != null ? ` · 漏斗${funnelHits}项` : ''}`
            : (funnelHits != null ? `CPC -- · 漏斗${funnelHits}项` : 'CPC --');
          return `<div class="m-row" title="${esc(m.reason || '')}"><span class="m-name" title="${esc(m.name)}">${esc(m.name)}</span>${badge}<span class="m-cost">${V4.fmtMoney(cost)}<small class="m-cpc">${acquisition}</small></span><span class="m-v ${rc}">${roi.toFixed(2)}</span>${stateHtml}</div>`;
        };
        $('mats3').innerHTML = COLS.map(c => `
          <div class="m3-col">
            <div class="m3-h">${c.label} <span class="cd">${c.list.length} 条</span></div>
            ${c.list.length ? c.list.map(m => rowHtml(m, c.key)).join('') : `<div class="m3-empty">本轮无${c.label}素材</div>`}
          </div>`).join('')
          // 历史账户专用说明已从试用包移除。
          + (d.aigc ? `<div class="m3-aigc">AIGC 动态创意集合行：今日消耗 <b>${V4.fmtMoney(d.aigc.cost)}</b> · 净成交 <b>${V4.fmtMoney(d.aigc.net)}</b> · 净ROI <b>${d.aigc.netRoi != null ? d.aigc.netRoi.toFixed(2) : '--'}</b> · ${d.aigc.orders || 0} 单 <span class="cd">（开关非素材，不处置 · 治本=清理低质输入原素材）</span></div>` : '');
      }

      /* ===== Agent 决策流（60s） ===== */
      function filterRounds(rounds) {
        if (!Array.isArray(rounds)) return [];
        if (S.flowMode === 'all') return rounds;
        const d = S.flowDate || localDate(0);
        return rounds.filter(r => String(r.time || '').startsWith(d));
      }
      function renderRoundsData(rounds) {
        const list = filterRounds(rounds);
        if (!list.length) { $('flow').innerHTML = V4.emptyBox(S.flowMode === 'all' ? '暂无巡检记录' : '今日暂无巡检记录'); return; }
        $('flow').innerHTML = list.map((r, i) => {
          const cn = V4.fmtCnTime(r.time);
          const hhmm = cn.full || String(r.round || '');

          /* 操作留痕：优先结构化 actions；旧字符串仅作兼容展示，不再靠原文推断轮次类型。 */
          const NOOP = /^(无操作|无写操作|无|null|none|观望)$/i;
          let ops = Array.isArray(r.actions)
            ? r.actions.map(a => typeof a === 'string' ? a : (a.message || a.description || a.code || a.action || ''))
            : Array.isArray(r.actions_raw) ? r.actions_raw.slice() : String(r.actions || '').split(/[,，]/);
          ops = ops.map(s => String(s || '').trim()).filter(s => s && !NOOP.test(s));

          /* 轮次性质由服务端结构化 code/status 归类，禁止自然语言猜测。 */
          const badge = r.type === 'attention'
            ? '<span class="f-tag stop">需要关注</span>'
            : r.type === 'action' || ops.length
              ? `<span class="f-tag exec">动作轮 · ${ops.length} 项操作</span>`
              : '<span class="f-tag wait">观望轮</span>';

          /* 数字带：消耗 / 净投产比 / 订单（余额不进决策卡，属告警体系） */
          const rawSnapshot = r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : (r.data_snapshot && typeof r.data_snapshot === 'object' ? r.data_snapshot : {});
          const snap = rawSnapshot.metrics && typeof rawSnapshot.metrics === 'object' ? rawSnapshot.metrics : rawSnapshot;
          const pick = (...keys) => { for (const k of keys) { const v = snap[k]; if (v != null && v !== '' && Number.isFinite(+v)) return +v; } return null; };
          const cost = pick('cost', 'today_cost', '消耗');
          const netRoi = pick('net_roi', 'netRoi', 'today_net_roi', '净ROI', '净投产比');
          const orders = pick('orders', 'orders_pay', 'order_count', 'orderCount', '订单', '订单数');
          const be = pick('break_even_roi', 'breakEvenRoi', 'breakEven', 'break_even', '保本线', '保本') || S.be || V4.breakEven();
          const mItems = [];
          if (cost != null) mItems.push(`<div class="f-metric"><div class="fm-l">消耗</div><div class="fm-v num">${V4.fmtMoney(cost)}</div></div>`);
          if (netRoi != null) mItems.push(`<div class="f-metric"><div class="fm-l">净投产比（保本 ${be.toFixed(2)}）</div><div class="fm-v num ${V4.stateClass(netRoi, be)}">${netRoi.toFixed(2)}</div></div>`);
          if (orders != null) mItems.push(`<div class="f-metric"><div class="fm-l">订单</div><div class="fm-v num">${Math.round(orders).toLocaleString('zh-CN')}</div></div>`);
          const metrics = mItems.length ? `<div class="f-metrics">${mItems.join('')}</div>` : '';

          /* 操作留痕区：类型徽章 + 原文（止损红、暂停黄、其余青） */
          const opsHtml = ops.length ? `
            <div class="f-sec-l">本轮操作 · 留痕</div>
            <div class="f-ops">${ops.map(op => {
              const cls = /止损|删除|下线/.test(op) ? 'stop' : /暂停/.test(op) ? 'pause' : 'exec';
              const tag = /删除/.test(op) ? '删除' : /止损/.test(op) ? '止损' : /暂停/.test(op) ? '暂停' : /新建|创建/.test(op) ? '新建追投' : /调.{0,4}(ROI|投产比)/i.test(op) ? '调投产比' : /调预算/.test(op) ? '调预算' : /充值/.test(op) ? '充值' : '操作';
              return `<div class="f-op"><span class="f-op-tag ${cls}">${tag}</span><span class="f-op-t">${esc(op)}</span></div>`;
            }).join('')}</div>` : '';

          /* 决策依据：结构化 judgments 优先，旧 decisions 仅作兼容。 */
          let decRaw = [];
          if (Array.isArray(r.judgments)) {
            decRaw = r.judgments.map(d => typeof d === 'string' ? d : String((d && (d.message || d.reason || d.code)) || ''));
          } else if (Array.isArray(r.decisions)) {
            decRaw = r.decisions.map(d => typeof d === 'string' ? d : String((d && (d.reason || [d.material, d.reason].filter(Boolean).join('：'))) || ''));
          } else if (typeof r.decisions === 'string' && r.decisions.trim()) decRaw = [r.decisions.trim()];
          decRaw = decRaw.map(s => String(s || '').trim()).filter(Boolean);
          const decsHtml = decRaw.length ? `
            <div class="f-sec-l">每轮四问 · 决策依据</div>
            <div class="f-decs">${decRaw.map(d => {
              const m = d.match(/^([^：:，。；;\s]{2,6})[：:]\s*([\s\S]+)$/);
              const tag = m ? m[1] : '决策';
              const bodyText = m ? m[2] : d;
              const cls = /止损|删/.test(tag) ? 'stop' : '';
              return `<div class="f-dec"><span class="f-dec-tag ${cls}">${esc(tag)}</span><span class="f-dec-t">${esc(bodyText)}</span></div>`;
            }).join('')}</div>` : '';

          /* 预期仅作记录；后续事实在决策记录页查看，不显示分数。 */
          const eff = r.expected_effect && typeof r.expected_effect === 'object' ? JSON.stringify(r.expected_effect) : String(r.expected_effect || '').trim();
          const hasEvidence = !!(r.outcome && r.outcome.details && r.outcome.details.after_snapshot_id);
          const loopHtml = (eff || hasEvidence) ? `
            <div class="f-loop">
              <span class="f-loop-l">预期与观测</span>
              <span class="f-loop-t">${esc(eff || '前后快照已保存，见决策记录')}</span>
              <span class="f-loop-s">${hasEvidence ? '已有后续事实 · 不作因果归因' : '仅记录预期'}</span>
            </div>` : '';

          const title = String(r.summary || r.title || r.desc || '巡检记录').trim();
          return `<div class="f-item ${i === 0 ? 'fresh' : ''}">
            <div class="f-meta">${esc(hhmm)} ${badge}</div>
            <div class="f-title">${esc(title)}</div>
            ${metrics}
            ${opsHtml}
            ${decsHtml}
            ${loopHtml}
          </div>`;
        }).join('');
      }
      function bindFlowTabs() {
        const tabs = document.querySelectorAll('[data-flow]');
        const dateIn = $('flowDate');
        tabs.forEach(b => b.onclick = () => {
          tabs.forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          S.flowMode = b.dataset.flow;
          if (S.flowMode === 'today') {
            S.flowDate = null;
            dateIn.style.display = 'none';
          } else if (S.flowMode === 'date') {
            dateIn.style.display = '';
            if (!S.flowDate) dateIn.value = localDate(0);
            S.flowDate = dateIn.value;
          } else {
            dateIn.style.display = 'none';
          }
          renderRoundsData(CACHE[acct0] && CACHE[acct0].rounds ? CACHE[acct0].rounds : []);
        });
        if (dateIn) dateIn.onchange = () => {
          S.flowDate = dateIn.value;
          renderRoundsData(CACHE[acct0] && CACHE[acct0].rounds ? CACHE[acct0].rounds : []);
        };
      }
      bindFlowTabs();
      // 成交渠道构成：成交金额 ⇆ 观看次数 切换
      const chanT = $('chanToggle');
      if (chanT) chanT.onclick = () => { S.chanMetric = S.chanMetric === 'watch' ? 'pay' : 'watch'; renderChannel(); };
      async function refreshRounds() {
        let j;
        try { j = await V4.api('/api/agent-rounds'); }
        catch (e) { if (alive()) $('flow').innerHTML = V4.errBox(e); return; }
        if (!alive()) return;
        const C = CACHE[acct0] = CACHE[acct0] || {};
        C.rounds = j.rounds || [];
        V4.cset('v4c_rounds_' + acct0, C.rounds); // 持久化：F5 刷新秒恢复
        renderRoundsData(C.rounds);
      }

      /* ===== 老板评审（60s） ===== */
      function renderBossData(c) {
        if (!c) { $('bossBlock').style.display = 'none'; return; }
        $('bossBlock').style.display = '';
        $('bossG').textContent = c.grade || '-';
        $('bossG').className = 'g g-' + (c.grade || 'B');
        $('bossS').innerHTML = `${esc(c.date || '')} 评定 <b>${c.total_score != null ? esc(String(c.total_score)) : '--'}</b> / 100`;
        $('bossQ').textContent = '"' + (c.summary || c.scoring_note || '').slice(0, 120) + '"';
      }
      async function refreshBoss() {
        try {
          const j = await V4.api('/api/agent-memory', { type: 'decisions', limit: 50, accountId: '' });
          if (!alive()) return;
          const list = (j.decisions || j.items || []).filter(r => /critique$/.test(String(r.round || '')));
          list.sort((a, b) => String(b.date || b.time || '').localeCompare(String(a.date || a.time || '')));
          const C = CACHE[acct0] = CACHE[acct0] || {};
          C.boss = list.length ? list[0] : null;
          V4.cset('v4c_boss_' + acct0, C.boss); // 持久化：F5 刷新秒恢复
          renderBossData(C.boss);
        } catch (e) {}
      }

      /* ===== 店铺成交三分口径（全部/推商品/推直播间） ===== */
      function localDate(offset) { const d = new Date(Date.now() + offset * 86400000); return `${d.getFullYear()}-${V4.p2(d.getMonth() + 1)}-${V4.p2(d.getDate())}`; }
      function renderSplitData(j) {
        const box = $('splitBox');
        const rows = [j.all, j.product, j.live].filter(Boolean);
        // 失败必须与真零区分：mergeSplit 把失败侧静默填 0 并打 base_unavailable/cf_unavailable 标记，
        // 只查 r.unavailable 会把"获取失败"当 ¥0.00 真值展示，还会压掉退款告警（2026-07-29 审计修复）
        if (rows.some(r => r.unavailable || r.base_unavailable || r.cf_unavailable)) {
          if (box) box.innerHTML = V4.errBox(new Error('千川限频或网络波动，该口径暂时获取失败（不是 ¥0），稍后自动重试'));
          return false;
        }
        S.splitAll = j.all || null; // 退款率/整体ROI 给顶部 vitals 用
        apply();
        if (box) box.innerHTML = rows.map(r => {
          const rc = V4.stateClass(r.roi, S.be);
          const rfTxt = Number.isFinite(+r.refund_rate) ? (+r.refund_rate).toFixed(1) : '--'; // 缺字段不上 NaN
          const ordTxt = Number.isFinite(+r.orders) ? Math.round(r.orders) : '--';
          const roiTxt = Number.isFinite(+r.roi) ? (+r.roi).toFixed(2) : '--';
          return `<div class="cell">
            <div class="lab">${esc(r.label)}<span class="rf">退款 ${rfTxt}% · ${ordTxt} 单${j.cached ? ' · 终值' : ''}</span></div>
            <div class="cost num">${fmtMoney(r.cost)}</div>
            <div class="sub"><span>净成交 <b>${fmtMoney(r.gmv)}</b></span><span>ROI <b class="${rc}">${roiTxt}</b></span></div>
          </div>`;
        }).join('');
        return true;
      }
      let splitFlight = false;
      async function refreshSplit(which) {
        if (splitFlight) return; // 在飞锁：tab 点击与 60s 轮询可并发
        splitFlight = true;
        const box = $('splitBox');
        try {
          const date = which === 'today' ? localDate(0) : localDate(-1);
          const j = await V4.api('/api/home-split', { date });
          if (!alive()) return;
          const C = CACHE[acct0] = CACHE[acct0] || {};
          C.split = j;
          if (which === 'today') { // F1：缓存今日 payload 给 applyDash 下播回落复用
            S.splitToday = { payload: j, date, ts: Date.now() };
            C.splitToday = S.splitToday;
            V4.cset('v4c_split_' + acct0 + '_' + date, j); // 会话持久化
          }
          renderSplitData(j); // 失败不单独重试，由 60s 轮询统一重试
        } catch (e) { if (alive() && box) box.innerHTML = V4.errBox(e); }
        finally { splitFlight = false; }
      }
      // 仅后台读取今日千川首页汇总，供退款率和下播兜底使用；可视化已移至工作台。

      /* ===== 追投时段效果（当月窗口 + 不分来源，2026-08-13 维护者指令：只看当月、不分人工和 AI） ===== */
      function renderBoostTime(j) {
        const box = $('btBox');
        if (!j || !j.ok) { box.innerHTML = V4.errBox(j ? (j.error || '加载失败') : '接口无响应'); return; }
        const hts = j.hours || [];
        if (!hts.length) {
          box.innerHTML = '<div style="color:var(--ink-3);font-size:11px;padding:8px 0">当月无追投任务，暂无时段结论</div>';
          return;
        }
        const be = S.be || V4.breakEven();
        // 全时段 ROI 区间 → 热力色（相对该窗口内表现，进化而非固定刻度）
        const rel = hts.filter(h => h.reliable);
        const rois = rel.map(h => h.roi).filter(r => r > 0);
        const mx = Math.max(...rois, be), mn = Math.min(...rois, be);
        const span = Math.max(mx - mn, 0.1);
        const rows = hts.map(h => {
          const t = (h.roi - mn) / span; // 0(差)~1(好)
          const heat = h.reliable ? `rgba(255,255,255,${(0.08 + t * 0.45).toFixed(2)})` : 'transparent';
          const border = h.reliable ? `1px solid ${t >= 0.5 ? 'rgba(74,222,128,.45)' : 'rgba(251,146,60,.35)'}` : '1px dashed rgba(148,163,184,.25)';
          const cls = h.roi >= be ? 'st-ok' : (h.roi >= be * 0.7 ? 'st-warn' : 'st-danger');
          return `<div class="bt-cell" style="background:${heat};border:${border}" title="${h.hour}时 · ${h.tasks}任务 · 耗¥${h.cost} · 净GMV¥${h.gmv}${h.reliable ? '' : '（样本不足，仅供参考）'}">
            <div class="bt-h">${h.hour}时${h.reliable ? '' : ' <em>?</em>'}</div>
            <div class="bt-roi ${cls}">${h.roi > 0 ? h.roi.toFixed(2) : '--'}</div>
            <div class="bt-sub">${h.tasks}任务</div>
          </div>`;
        }).join('');
        const best = j.summary.best_hour, worst = j.summary.worst_hour;
        const sTxt = [
          (j.summary.range ? j.summary.range.start + ' ~ ' + j.summary.range.end : (j.start + ' ~ ' + j.end)) + '（当月）',
          '耗¥' + j.summary.total_cost + ' · ROI ' + (j.summary.total_roi || 0).toFixed(2),
          best ? '最佳 <b class="st-ok">' + best.hour + '时</b> ROI ' + best.roi.toFixed(2) : '样本不足无最佳结论',
          worst ? '最差 <b class="st-danger">' + worst.hour + '时</b> ROI ' + worst.roi.toFixed(2) : '',
        ].filter(Boolean).map(x => '<span>' + x + '</span>').join('');
        box.innerHTML = `<div class="bt-grid">${rows}</div><div class="bt-sum">${sTxt}</div>`;
        // 直播场次联动：常播时段标注（追投时段对着直播场次看）
        const slots = j.live_slots || [];
        const slotEl = $('btLiveSlots');
        if (slots.length) {
          slotEl.style.display = '';
          slotEl.innerHTML = '常播场次 <span class="cd">当月开播时段</span>：' + slots.map(s => `<b>${s.hour}时</b>×${s.sessions}场`).join('　');
        } else { slotEl.style.display = 'none'; }
      }
      let btFlight = false;
      async function refreshBoostTime() {
        if (btFlight) return;
        btFlight = true;
        try {
          // 历史账户专用说明已从试用包移除。
          const dn = new Date();
          const mStart = dn.getFullYear() + '-' + V4.p2(dn.getMonth() + 1) + '-01';
          const mEnd = dn.getFullYear() + '-' + V4.p2(dn.getMonth() + 1) + '-' + V4.p2(dn.getDate());
          const j = await V4.api('/api/boost-time-analysis', { start: mStart, end: mEnd });
          if (!alive()) return;
          S.btData = j;
          renderBoostTime(j);
          $('wrBoostTime').style.display = '';
        } catch (e) { if (alive()) $('btBox').innerHTML = V4.errBox(e); }
        finally { btFlight = false; }
      }
      // 历史账户专用说明已从试用包移除。


      /* ===== 直播间核心漏斗（罗盘大屏版式：横条 + SVG 连接线/箭头，2026-07-27 抄截图） ===== */
      function renderFunnel() {
        const f = S.funnel;
        const el = $('wrFunnel');
        if (!el) return;
        const counts = f && f.counts && typeof f.counts === 'object' ? f.counts : {};
        const ratesMap = f && f.rates && typeof f.rates === 'object' ? f.rates : {};
        const metric = (modern, legacy) => {
          const value = modern != null ? modern : legacy;
          return value != null && Number.isFinite(+value) ? +value : null;
        };
        const show = metric(counts.shows, f && f.show);
        const watch = metric(counts.views, f && f.watch);
        const click = metric(counts.product_clicks, f && f.click);
        const order = metric(counts.pay_orders, f && f.order);
        const hasCounts = [show, watch, click, order].some(v => v != null);
        if (!f || f.data_valid === false || !hasCounts) { el.innerHTML = '<div style="color:var(--ink-3);font-size:11px;padding:8px 0">暂无漏斗数据（开播后出现）</div>'; return; }
        const steps = [
          ['直播间整体曝光次数', show],
          ['直播间观看次数', watch],
          ['商品点击次数', click],
          ['成交订单数', order],
        ];
        const showToWatchRate = metric(ratesMap.show_to_watch, f.showToWatchRate);
        const watchToClickRate = metric(ratesMap.watch_to_click, f.watchToClickRate);
        const clickToPayRate = metric(ratesMap.click_to_pay, f.clickToPayRate);
        const watchToPayRate = metric(ratesMap.watch_to_pay, f.watchToPayRate);
        const rates = [null, showToWatchRate, watchToClickRate, clickToPayRate];
        const rateTips = ['', '曝光→观看', '观看→点击', '点击→成交'];
        const max = Math.max(...steps.map(s => s[1] == null ? 0 : s[1]), 1);
        const ROW = 32, GAP = 7, MAXW = 72; // 条宽上限 72%，右侧留给连接线与转化率
        const H = steps.length * ROW + (steps.length - 1) * GAP;
        const w = steps.map(s => Math.max(24, Math.round((s[1] == null ? 0 : s[1]) / max * MAXW)));
        const bars = steps.map(([n, v], i) =>
          `<div class="fn2-bar" style="width:${w[i]}%;top:${i * (ROW + GAP)}px"><span>${n}</span><b>${v == null ? '--' : v.toLocaleString()}</b></div>`).join('');
        const paths = [], labels = [];
        // 逐级连接线：上条底边右缘 → 右移 → 竖线下探 → 左进本条顶边（箭头指入）
        for (let i = 1; i < steps.length; i++) {
          const x1 = w[i - 1] * 10, x2 = w[i] * 10;
          const lx = Math.max(x1, x2) + 25;
          const y1 = (i - 1) * (ROW + GAP) + ROW;
          const y2 = i * (ROW + GAP);
          paths.push(`<path d="M${x1},${y1} H${lx} V${y2} H${x2}" class="fn2-ln" marker-end="url(#fnArr)"/>`);
          if (rates[i] != null) labels.push(`<div class="fn2-lb" title="${rateTips[i]}" style="left:${(lx / 10 + 1).toFixed(1)}%;top:${(y1 + y2) / 2 - 8}px">${(+rates[i]).toFixed(2)}%</div>`);
        }
        // 长括号（截图右下 2.37%）：观看 → 成交 整体转化，虚线
        // 从观看条【中点】出发、到成交条【中点】进入——与逐级连接线（底边→顶边）错开 y 区间，不打架
        if (watchToPayRate != null && steps.length >= 4) {
          const x1 = w[1] * 10, x2 = w[3] * 10;
          const lx = 840; // 固定在 84%，避开逐级标注（~43%）与条体（≤72%）
          const y1 = 1 * (ROW + GAP) + ROW / 2;
          const y2 = 3 * (ROW + GAP) + ROW / 2;
          paths.push(`<path d="M${x1},${y1} H${lx} V${y2} H${x2}" class="fn2-ln fn2-ln-total" marker-end="url(#fnArr)"/>`);
          labels.push(`<div class="fn2-lb fn2-lb-total" title="观看→成交整体转化" style="left:${(lx / 10 + 1).toFixed(1)}%;top:${(y1 + y2) / 2 - 8}px">${watchToPayRate.toFixed(2)}%</div>`);
        }
        el.innerHTML = `<div class="fn2-stage" style="height:${H}px">${bars}
          <svg class="fn2-svg" viewBox="0 0 1000 ${H}" preserveAspectRatio="none">
            <defs><marker id="fnArr" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="fn2-arr"/></marker></defs>
            ${paths.join('')}
          </svg>${labels.join('')}</div>`;
        $('wrMidRow').style.display = '';
      }

      /* ===== 成交渠道构成（环形图 + 图例，⇆ 成交金额/观看次数 切换） ===== */
      const CH_COLORS = ['#dbe7ff', '#a8c7fa', '#6ea8fe', '#3d7bfd', '#1f56d8', '#123a9e'];
      function renderChannel() {
        const el = $('wrChannel');
        const toggle = $('chanToggle');
        if (!el) return;
        const rawSource = S.dash && S.dash.source;
        const src = Array.isArray(rawSource) ? rawSource : [];
        const metric = S.chanMetric === 'watch' ? 'watch' : 'pay';
        const rows = src.map(c => ({ name: c.channel || '其他', pay: +c.pay || 0, watch: +c.watch || 0 }))
          .filter(c => c.pay > 0 || c.watch > 0);
        if (!rows.length) {
          el.innerHTML = '<div style="color:var(--ink-3);font-size:11px;padding:8px 0">暂无渠道数据（开播后出现）</div>';
          if (toggle) toggle.style.display = 'none';
          return;
        }
        if (toggle) { toggle.style.display = ''; toggle.textContent = metric === 'pay' ? '⇆ 观看次数' : '⇆ 成交金额'; }
        const total = rows.reduce((s, c) => s + c[metric], 0) || 1;
        const sorted = rows.slice().sort((a, b) => b[metric] - a[metric]);
        // Top4 + 其余合并（源数据若已有"其他"渠道则并入它，避免图例出现两个"其他"），再按当前口径降序
        const items = sorted.slice(0, 4);
        const rest = sorted.slice(4);
        if (rest.length) {
          const exist = items.find(c => c.name === '其他');
          if (exist) {
            exist.pay += rest.reduce((s, c) => s + c.pay, 0);
            exist.watch += rest.reduce((s, c) => s + c.watch, 0);
          } else {
            items.push({ name: '其他', pay: rest.reduce((s, c) => s + c.pay, 0), watch: rest.reduce((s, c) => s + c.watch, 0) });
          }
        }
        items.sort((a, b) => b[metric] - a[metric]);
        el.innerHTML = `<div class="chan-wrap">
          <canvas class="chan-donut" width="224" height="224"></canvas>
          <div class="chan-legend">${items.map((c, i) => `<div class="chan-li"><i style="background:${CH_COLORS[i % CH_COLORS.length]}"></i><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span><b>${(c[metric] / total * 100).toFixed(2)}%</b></div>`).join('')}</div>
        </div>`;
        drawDonut(el.querySelector('canvas'), items.map((c, i) => ({ v: c[metric], color: CH_COLORS[i % CH_COLORS.length] })), metric === 'pay' ? '成交金额' : '观看次数');
        $('wrMidRow').style.display = '';
      }
      function drawDonut(cv, segs, label) {
        if (!cv) return;
        const ctx = cv.getContext('2d');
        const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
        const R = Math.min(W, H) / 2 - 8, r = R * 0.62;
        ctx.clearRect(0, 0, W, H);
        const total = segs.reduce((s, x) => s + x.v, 0) || 1;
        let a = -Math.PI / 2;
        for (const s of segs) {
          const a2 = a + (s.v / total) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, R, a, a2);
          ctx.arc(cx, cy, r, a2, a, true);
          ctx.closePath();
          ctx.fillStyle = s.color;
          ctx.fill();
          a = a2;
        }
        const ink = (getComputedStyle(document.documentElement).getPropertyValue('--ink') || '#f1f5f9').trim();
        ctx.fillStyle = ink;
        ctx.font = `600 ${Math.round(R * 0.26)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy);
      }
      function renderPortrait() {
        const p = S.portrait || {};
        const el = $('wrPortrait');
        if (!el) return;
        const sections = [
          { key: 'diff', label: '只看不买用户画像', badge: 'Top3', empty: '暂无相关数据' },
          { key: 'watch', label: '看播核心用户画像', empty: S.portraitError ? '罗盘画像读取失败，正在重试' : '当前看播样本不足' },
          { key: 'pay', label: '购买核心用户画像', empty: '近5分钟成交人数过少' },
        ];
        el.innerHTML = sections.map(section => {
          const item = p[section.key];
          const rows = item && item.map ? Object.values(item.map).filter(Boolean) : [];
          const stale = section.key === 'watch' && S.portraitStale ? '<span class="portrait-stale">上次成功</span>' : '';
          const badge = section.badge ? `<span class="portrait-badge">${section.badge}</span>` : '';
          const body = rows.length
            ? `<div class="portrait-values">${rows.map(v => `<span class="portrait-chip">${esc(v)}</span>`).join('')}</div>`
            : `<div class="portrait-empty">${esc(section.empty)}</div>`;
          return `<div class="pc"><div class="t">${esc(section.label)} ${badge}${stale}</div>${body}</div>`;
        }).join('');
        $('wrMidRow').style.display = '';
      }

      /* ===== 罗盘大屏侧栏：近5分钟脉搏/本场热卖/画像/预警（120s，仅在播显示；服务端 90s 缓存） ===== */
      async function refreshScreen() {
        let j;
        try { j = await V4.api('/api/compass/screen'); } catch (e) { return; } // 失败静默：下次轮询再来
        if (!alive()) return;
        const box = $('wrScrBox');
        if (!j || !j.ok || !j.live) { box.style.display = 'none'; return; }
        box.style.display = '';
        // 2026-07-29 起纯 API 无浏览器兜底：five/products 是签名端点，via=direct 时长期为空——
        // 空态文案要实话（通道未启用），不能显示"暂无成交/暂无数据"误导
        const signedOff = String(j.via || '').startsWith('direct');
        const pick = ['用户支付金额', '在线人数', '进入人数', '离开人数', '评论次数', 'UV价值'];
        const fiveCards = (j.five || []).filter(c => pick.includes(c.name));
        $('wrScrVitals').innerHTML = fiveCards.length ? fiveCards.map(c => {
          const v = c.value == null ? '--' : (c.unit === '元'
            ? '¥' + (+c.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
            : (+c.value).toLocaleString('zh-CN', { maximumFractionDigits: 1 }));
          const s = c.change_pct == null ? '' :
            `<b class="${c.change_pct >= 0 ? 'good' : 'bad'}">${c.change_pct >= 0 ? '↑' : '↓'}${Math.abs(c.change_pct)}%</b>`;
          // Sparkline 迷你走势（2026-08-18 吸收罗盘大屏：卡片背景叠分钟级波形）
          const pts = (c.trend || []).filter(p => p.v != null).map(p => +p.v);
          let spark = '';
          if (pts.length > 1) {
            const mn = Math.min(...pts), mx = Math.max(...pts), rg = (mx - mn) || 1;
            const px = pts.map((val, i) => `${(i / (pts.length - 1) * 100).toFixed(1)},${(19 - (val - mn) / rg * 16).toFixed(1)}`).join(' ');
            spark = `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline points="${px}" fill="none" stroke="rgba(93,150,248,.7)" stroke-width="1.4"/></svg>`;
          }
          return `<div class="p" title="${esc(c.tip || '')}"><div class="l">${esc(c.name)}</div><div class="v num">${v}</div><div class="s">${s}</div>${spark}</div>`;
        }).join('')
          : (signedOff ? '<div style="color:var(--ink-3);font-size:11px;padding:6px 0">近5分钟脉搏需签名数据，浏览器通道已停用，当前不提供</div>' : '');
        const prods = (j.products || []).filter(p => p.pay_gmv > 0).slice(0, 5);
        $('wrScrProducts').innerHTML = prods.length ? prods.map(p =>
          `<div class="pr">${p.image ? `<img src="${esc(p.image)}" loading="lazy" onerror="this.style.display='none'">` : ''}<span class="t" title="${esc(p.title)}">${esc(p.title)}</span><b>¥${(+p.pay_gmv).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></div>`).join('')
          : `<div style="color:var(--ink-3);font-size:11px;padding:6px 0">${signedOff ? '本场热卖需签名数据，浏览器通道已停用，当前不提供' : '本场暂无成交商品'}</div>`;
        // 直播间订单流（2026-08-18：罗盘 live_order 签名端点，服务端 20s 缓存；失败静默）
        // 两级展示：①按品聚合（哪个品卖了多少单，主导）②订单明细流（辅助）
        // 2026-08-18 修复：品名(product_title)优先展示，规格(sku_product_title)作后缀标注——此前规格优先看不出卖的是啥
        let ords = null;
        try { ords = await V4.api('/api/compass/live-orders'); } catch (e) { ords = null; }
        if (alive() && ords && ords.ok) {
          const prods = ords.products || [];
          const olist = ords.orders || [];
          const shortName = (t, n = 14) => (t && t.length > n ? t.slice(0, n) + '…' : (t || '未知品'));
          const prodHtml = prods.length ? prods.map(p => {
            const name = p.product_title || '未知品';
            const spec = p.sku_title && p.sku_title !== name ? `·${p.sku_title}` : '';
            return `<div class="op" title="${esc(name)}"><span class="t">${esc(shortName(name))}</span><span class="s">${esc(spec)}</span><span class="c">${p.order_cnt}单${p.item_num > p.order_cnt ? '·' + p.item_num + '件' : ''}</span><b>¥${(+p.amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></div>`;
          }).join('')
            : '<div style="color:var(--ink-3);font-size:11px;padding:6px 0">本场暂无已支付订单</div>';
          const ordHtml = olist.length ? `<div style="font-size:10.5px;color:var(--ink-3);padding:6px 0 2px">最近订单</div><div class="wl-ordgrid">` + olist.slice(0, 10).map(o => {
            const name = o.product_title || '未知品';
            const time = o.order_ts ? new Date(o.order_ts * 1000).toTimeString().slice(0, 8) : '';
            return `<div class="oc">
              <div class="oc-top"><span class="oc-buyer">${esc(o.nick_name || '')}</span><span class="oc-time">${esc(time)}</span><span class="oc-paid">●已支付</span></div>
              <div class="oc-mid">${o.sku_product_img ? `<img src="${esc(o.sku_product_img)}" loading="lazy" onerror="this.style.display='none'">` : ''}<div class="oc-txt"><div class="oc-name" title="${esc(name)}">${esc(shortName(name, 16))}</div><div class="oc-spec"><span>${esc(o.sku_product_title || '')}</span><i>×${o.item_num || 1}</i></div></div></div>
              <div class="oc-bot"><button class="oc-copy" data-oid="${esc(o.order_id || '')}" title="复制订单号">单号 ${esc(String(o.order_id || '').slice(-6))}</button><b>¥${o.order_amount != null ? (+o.order_amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-'}</b></div>
            </div>`;
          }).join('') + '</div>' : '';
          $('wrOrders').innerHTML = prodHtml + ordHtml;
          $('wrOrdUpd').textContent = ords.total != null ? `${ords.total} 单` : '';
          // 复制单号按钮（卡片式订单，2026-08-18）
          document.querySelectorAll('#wrOrders .oc-copy').forEach(b => {
            b.onclick = (ev) => {
              ev.stopPropagation();
              const oid = b.dataset.oid || '';
              if (!oid) return;
              (navigator.clipboard ? navigator.clipboard.writeText(oid) : Promise.reject(new Error('no-clipboard'))).then(() => {
                const old = b.textContent; b.textContent = '已复制';
                setTimeout(() => { b.textContent = old; }, 1500);
              }).catch(() => { b.textContent = oid.slice(-6); setTimeout(() => { b.textContent = '单号'; }, 2500); });
            };
          });
        }
        const extras = [];
        (j.warn || []).slice(0, 2).forEach(w => extras.push(`<span class="warn"><span class="signal-dot warn"></span> ${esc(w.text)}</span>`));
        $('wrScrExtra').innerHTML = extras.join('<br>');
        $('wrScrUpd').textContent = String(j.fetched_at || '').slice(11, 19) + (j.stale ? '（旧）' : '');
        S.portrait = j.portrait || null;
        S.portraitError = j.portrait_error || (j.errors && j.errors.portrait) || null;
        S.portraitStale = !!j.portrait_stale;
        renderPortrait();
      }

      /* ===== 轮询 ===== */
      // 已播时长秒级跳动：直播中"已播 XhYm"每秒本地推算（数据仍 15s 轮询，只是时钟跟手）
      const sinceTimer = setInterval(() => { if (alive() && S.dash) { updateSince(S.dash); renderCoreFreshness(S.dash); } }, 1000);
      stoppers.push(() => clearInterval(sinceTimer));
      // 核心 5s 读服务端内存；趋势与素材独立在飞锁，慢请求不阻塞核心卡片。
      stoppers.push(V4.poll(refreshDash, 5000));
      stoppers.push(V4.poll(refreshTrend, 15000));
      stoppers.push(V4.poll(refreshActiveMaterials, 60000));
      // 决策流/评审：首次立即执行（本地缓存秒恢复），后续 60s 轮询
      stoppers.push(V4.poll(() => Promise.allSettled([refreshRounds(), refreshBoss(), refreshSplit('today'), refreshBoostTime()]), 60000));
      // 首轮由 poll 发起一次；不再额外调用造成重复请求。
      stoppers.push(V4.poll(refreshScreen, 30000));  // 历史账户专用说明已从试用包移除。

      return function unmount() {
        dead = true; // 在途请求统一作废
        stoppers.forEach(s => s());
        removeEventListener('resize', onResize);
        if (trendAnim) cancelAnimationFrame(trendAnim);
      };
    },
  };

})(window.V4);
