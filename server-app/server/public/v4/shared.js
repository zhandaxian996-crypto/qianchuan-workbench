/* ===== 千川投控 v4 · 共享工具层 ===== */
window.V4 = window.V4 || {};
(function (V4) {
  'use strict';

  /* ----- 会话级缓存（sessionStorage：刷新保留、关标签页清；隐私模式/超限静默降级） ----- */
  V4.cget = function (key, maxAgeMs) {
    if (key && V4.acct && !key.includes(V4.acct())) console.warn('V4.cget: key 不含当前账号', key);
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.ts == null) return null;
      if (maxAgeMs && Date.now() - o.ts > maxAgeMs) return null; // 数据过老不用
      return o;
    } catch (e) { return null; }
  };
  V4.cset = function (key, data) {
    if (key && V4.acct && !key.includes(V4.acct())) console.warn('V4.cset: key 不含当前账号', key);
    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
  };

  /* ----- 开播时间/时长（parseT 兼容 Safari：YYYY-MM-DD HH:mm:ss → 本地 Date） ----- */
  V4.parseT = s => new Date(String(s || '').replace(/-/g, '/'));
  V4.durTxt = ms => { const m = Math.max(0, Math.floor(ms / 60000)); const h = Math.floor(m / 60); return h ? h + '小时' + V4.p2(m % 60) + '分' : m + '分钟'; };

  /* ----- 基础工具 ----- */
  const $ = id => document.getElementById(id);
  V4.$ = $;
  V4.p2 = n => String(n).padStart(2, '0');
  V4.nowStr = () => { const d = new Date(); return V4.p2(d.getHours()) + ':' + V4.p2(d.getMinutes()) + ':' + V4.p2(d.getSeconds()); };
  /**
   * 将 ISO 时间（UTC）格式化为北京时间 {md, hm, full}。
   * 不依赖 Intl 时区表，直接按 UTC+8 偏移，避免部分环境缺少 Asia/Shanghai 数据。
   */
  V4.fmtCnTime = iso => {
    const s = String(iso || '').trim();
    if (!s) return { md: '--', hm: '--:--', full: '--' };
    // 先尝试原生 Date.parse（Chrome/Firefox 对 ISO-8601 带 Z 支持良好）
    let ts = Date.parse(s);
    // Safari/旧浏览器：把 2026-07-27T01:37:02Z → 2026/07/27 01:37:02 再试
    if (!Number.isFinite(ts)) {
      ts = Date.parse(s.replace(/-/g, '/').replace(/T/g, ' ').replace(/Z$/, ''));
    }
    if (!Number.isFinite(ts)) return { md: '--', hm: '--:--', full: '--' };
    const u = new Date(ts + 8 * 3600 * 1000);
    const m = u.getUTCMonth() + 1, day = u.getUTCDate();
    const h = u.getUTCHours(), min = u.getUTCMinutes();
    return {
      md: `${V4.p2(m)}-${V4.p2(day)}`,
      hm: `${V4.p2(h)}:${V4.p2(min)}`,
      full: `${V4.p2(m)}-${V4.p2(day)} ${V4.p2(h)}:${V4.p2(min)}`
    };
  };
  const finite = n => n !== null && n !== undefined && n !== '' && Number.isFinite(+n);
  V4.fmtM = n => finite(n) ? '¥' + Math.round(+n).toLocaleString() : '--';
  V4.fmtM2 = n => finite(n) ? '¥' + (+n).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '--';
  // 金额精确到分：消耗/GMV/成交金额用（千川接口本身到分，整数显示会四舍五入掩盖误差）；大额汇总（余额/预算/配额）仍用 fmtM
  V4.fmtMoney = n => finite(n) ? '¥' + (+n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
  V4.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  V4.RM = matchMedia('(prefers-reduced-motion: reduce)');

  /* ----- 状态词体系（单一来源：ROI 相对保本线比例 → 模式） -----
     方向A 语义四色：≥保本×1.5 健康(绿) / ≥保本 健康(绿) / ≥保本×0.8 临界(黄) / 其余 亏损中(红) / 冷启动 / 已下播
     （top/low 为兼容保留：top 并入 ok 绿、low 并入 warn 黄；阈值对齐官方纪律 ×0.8） */
  V4.WORD = { top: '健康', good: '健康', warn: '临界', low: '临界', bad: '亏损中', cold: '冷启动', off: '已下播', uncalibrated: '待校准' };
  const validBreakEven = value => Number.isFinite(+value) && +value > 0;
  V4.hasBreakEven = validBreakEven;
  V4.breakEven = acct => {
    const meta = V4.accountMeta && V4.accountMeta(acct);
    return meta && validBreakEven(meta.break_even_roi) ? +meta.break_even_roi : null;
  };
  V4.greenLine = acct => V4.breakEven(acct);
  V4.modeOf = (roi, be, acct) => {
    const b = validBreakEven(be) ? +be : V4.breakEven(acct);
    if (!validBreakEven(b) || !finite(roi)) return 'uncalibrated';
    return roi >= b * 1.5 ? 'top' : roi >= b ? 'good' : roi >= b * 0.8 ? 'warn' : 'bad';
  };
  V4.roiClass = (r, be, acct) => V4.modeOf(r, be, acct);
  /* 状态语义类：统一返回 st-ok / st-warn / st-danger，供新组件直接使用（替代 roiClass 的 top/good/warn/low/bad） */
  V4.stateClass = (r, be) => {
    const c = V4.roiClass(r, be);
    return c === 'top' || c === 'good' ? 'st-ok' : c === 'warn' || c === 'low' ? 'st-warn' : c === 'bad' ? 'st-danger' : '';
  };
  V4.PULSE_COLOR = { top: '#34d399', good: '#34d399', warn: '#fbbf24', low: '#fbbf24', bad: '#f87171', cold: '#6b7280', off: '#6b7280', uncalibrated: '#6b7280' };

  /* ----- 翻牌 ----- */
  V4.flip = function (el, txt) {
    if (!el || el.textContent === txt) return;
    el.textContent = txt; el.classList.remove('flip'); void el.offsetWidth; el.classList.add('flip');
  };

  /* ----- 超长数字自动降字号，防断行（以真实文本为准） ----- */
  V4.fitV = function (el) {
    if (!el) return;
    const n = (el.dataset.odo || el.textContent).length;
    el.classList.toggle('sm', n >= 7 && n < 9);
    el.classList.toggle('xs', n >= 9);
  };

  /* ----- 里程表滚动数字：列内 0-9 两圈；目标位小于当前位时前滚一圈再瞬移归位；
         只滚变化的位，级联从右往左，时长 clamp(80ms×|Δ|, 200, 900) ----- */
  V4.odo = function (el, txt) {
    if (!el) return;
    txt = String(txt);
    const prev = el.dataset.odo;
    if (prev === txt) return;
    el.dataset.odo = txt;
    const still = V4.RM.matches;
    const total = (txt.match(/\d/g) || []).length;
    let cols = el.querySelectorAll('.od-in');
    if (cols.length !== total || el.children.length !== txt.length) {
      let html = '';
      for (const ch of txt) {
        if (/\d/.test(ch)) {
          let spans = ''; for (let k = 0; k < 20; k++) spans += '<span>' + (k % 10) + '</span>';
          html += '<span class="od"><span class="od-in" data-d="">' + spans + '</span></span>';
        } else html += '<span class="od-static">' + V4.esc(ch) + '</span>';
      }
      el.innerHTML = html;
      cols = el.querySelectorAll('.od-in');
    }
    let di = 0;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (!/\d/.test(ch)) continue;
      const col = cols[di]; di++;
      if (col.dataset.d === ch) continue;
      const curD = col.dataset.d === '' ? null : +col.dataset.d;
      col.dataset.d = ch;
      if (still || curD === null) {
        col.style.transition = 'none';
        col.style.transform = 'translateY(-' + (+ch) + 'em)';
        continue;
      }
      let target = +ch, wrap = false;
      if (target < curD) { target += 10; wrap = true; }
      const dist = Math.abs(target - curD);
      col.style.transition = '';
      col.style.transitionDelay = ((total - di) * 30) + 'ms';
      col.style.transitionDuration = Math.min(900, Math.max(200, 80 * dist)) + 'ms';
      col.style.transform = 'translateY(-' + target + 'em)';
      if (wrap) {
        const snap = () => {
          col.removeEventListener('transitionend', snap);
          col.style.transition = 'none';
          col.style.transform = 'translateY(-' + (+ch) + 'em)';
          requestAnimationFrame(() => requestAnimationFrame(() => { col.style.transition = ''; }));
        };
        col.addEventListener('transitionend', snap);
      }
    }
  };

  /* ----- 账号状态（id 以 config.json 为准；从 /api/accounts 动态获取，避免硬编码） ----- */
  const ACCT_KEY = 'v4-acct';
  V4.ACCTS = []; // 启动时从 /api/accounts 获取
  V4.features = {};
  V4.setFeatures = features => {
    V4.features = Object.assign({}, features || {});
    document.dispatchEvent(new CustomEvent('v4:features', { detail: V4.features }));
    return V4.features;
  };
  V4.acct = () => {
    const v = localStorage.getItem(ACCT_KEY);
    return V4.ACCTS.some(a => a.id === v) ? v : (V4.ACCTS[0] && V4.ACCTS[0].id) || '';
  };
  V4.acctName = id => (V4.ACCTS.find(a => a.id === (id || V4.acct())) || {}).name || id;
  V4.accountMeta = id => V4.ACCTS.find(a => a.id === (id || V4.acct())) || null;
  const acctListeners = [];
  const accountsListeners = [];
  V4.onAcctChange = fn => acctListeners.push(fn);
  V4.onAccountsChange = fn => accountsListeners.push(fn);
  V4.setAccounts = function (accounts, options) {
    const opts = options || {};
    const previousId = V4.acct();
    const previous = new Map(V4.ACCTS.map(a => [a.id, a]));
    const seen = new Set();
    const next = (Array.isArray(accounts) ? accounts : []).reduce((list, account) => {
      const id = String((account && (account.id || account.accountId)) || '').trim();
      if (!id || seen.has(id)) return list;
      seen.add(id);
      const prior = previous.get(id) || {};
      const source = account || {};
      list.push(Object.assign({}, opts.merge ? prior : {}, source, {
        id,
        name: String(source.name || source.accountName || prior.name || id),
      }));
      return list;
    }, []);
    const changed = JSON.stringify(next) !== JSON.stringify(V4.ACCTS);
    V4.ACCTS = next;
    const currentId = V4.acct();
    if (currentId && currentId !== previousId) {
      try { localStorage.setItem(ACCT_KEY, currentId); } catch (e) {}
    }
    if (changed) accountsListeners.forEach(fn => { try { fn(next); } catch (e) { console.error(e); } });
    if (currentId !== previousId) acctListeners.forEach(fn => { try { fn(currentId); } catch (e) { console.error(e); } });
    return next;
  };
  V4.setAcct = id => {
    if (!V4.ACCTS.some(a => a.id === id)) return false;
    if (id === V4.acct()) { localStorage.setItem(ACCT_KEY, id); return true; }
    localStorage.setItem(ACCT_KEY, id);
    acctListeners.forEach(fn => { try { fn(id); } catch (e) { console.error(e); } });
    return true;
  };

  /* ----- 写令牌（2026-07-28 修复：手机/局域网访问点执行 401） -----
     非本机写操作需携带 WRITE_API_TOKEN：URL 带 ?token=xxx 打开一次即存入本地并清出地址栏；
     apiPost 自动带 x-api-token 头。书签保存带 token 的链接可长期使用。 */
  const TOKEN_KEY = 'v4_write_token';
  try {
    const urlq = new URLSearchParams(location.search);
    const tk = urlq.get('token');
    if (tk) {
      localStorage.setItem(TOKEN_KEY, tk);
      urlq.delete('token');
      history.replaceState(null, '', location.pathname + (urlq.toString() ? '?' + urlq.toString() : '') + location.hash);
    }
  } catch (e) { /* localStorage 不可用时不阻断页面 */ }

  /* ----- API（默认 60s 超时，挂死请求自动中断，防轮询堆积） ----- */
  V4.api = async function (path, params, opts) {
    const q = new URLSearchParams(params || {});
    const baseOptions = Object.assign({}, opts || {});
    if (!baseOptions.skipAccountParam && !q.has('account') && !q.has('accountId')) q.set('account', V4.acct());
    const url = path + (q.toString() ? '?' + q.toString() : '');
    // 只对瞬时网络错误重试一次。超时代表本轮预算已耗尽，立即显式失败；
    // 不复用上一轮的 AbortSignal，否则计时器清理后可能留下一个再也不会中断的请求。
    let lastErr;
    const method = String(baseOptions.method || 'GET').toUpperCase();
    // 写请求断网时可能已被服务端接受；不能自动重发，交给操作回执/只读查询确认。
    const canRetryRead = method === 'GET' || method === 'HEAD';
    const attempts = canRetryRead && baseOptions.retryNetwork !== false ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1500 * attempt));
      try { return await apiOnce(url, Object.assign({}, baseOptions)); }
      catch (e) {
        lastErr = e;
        if (!(e instanceof TypeError) || attempt + 1 >= attempts) throw e;
      }
    }
    throw lastErr;
  };
  async function apiOnce(url, o) {
    const options = Object.assign({}, o || {});
    const ms = options.timeout || 60000;
    delete options.timeout;
    delete options.retryNetwork;
    delete options.skipAccountParam;
    let t = null;
    let ctl = null;
    if (!options.signal) {
      ctl = new AbortController();
      options.signal = ctl.signal;
      t = setTimeout(() => ctl.abort(), ms);
    }
    try {
      const r = await fetch(url, options);
      let j = null;
      try { j = await r.json(); } catch (e) { /* 非 JSON */ }
      if (!r.ok || (j && j.ok === false)) {
        const err = new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
        err.status = r.status;
        err.body = j;
        err.code = j && j.code || (r.ok ? 'api_error' : `http_${r.status}`);
        err.component = j && j.component || 'http_api';
        err.retryable = !!(j && j.retryable);
        throw err;
      }
      return j;
    } catch (e) {
      if (ctl && ctl.signal.aborted && e && e.name === 'AbortError') {
        const timeoutError = new Error(`请求超时（${Math.round(ms / 1000)} 秒），本轮已停止等待`);
        timeoutError.name = 'ClientTimeoutError';
        timeoutError.code = 'client_timeout';
        timeoutError.component = 'browser_client';
        timeoutError.retryable = true;
        timeoutError.timeout_ms = ms;
        throw timeoutError;
      }
      throw e;
    } finally {
      if (t) clearTimeout(t);
    }
  }
  V4.apiJson = function (path, method, body, opts) {
    const options = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const wtk = localStorage.getItem(TOKEN_KEY);
    if (wtk) headers['x-api-token'] = wtk;
    const includeAccount = options.includeAccount !== false;
    const payload = includeAccount ? Object.assign({ accountId: V4.acct() }, body || {}) : (body || {});
    const requestOptions = Object.assign({}, options, {
      method,
      headers,
      body: JSON.stringify(payload),
      skipAccountParam: !includeAccount,
    });
    delete requestOptions.includeAccount;
    return V4.api(path, null, requestOptions);
  };
  V4.apiPost = function (path, body, opts) {
    return V4.apiJson(path, 'POST', body, opts);
  };

  // 账号表是前端唯一的账号来源：配置增删账号后，刷新页面即可同步；接口失败时不伪造旧账号。
  let accountsLoadPromise = null;
  V4.loadAccounts = function () {
    if (accountsLoadPromise) return accountsLoadPromise;
    accountsLoadPromise = (async () => {
      try {
        const j = await apiOnce('/api/accounts', { timeout: 10000 });
        if (!j || !j.ok || !Array.isArray(j.accounts)) throw new Error((j && j.error) || '账号列表格式错误');
        V4.accountsError = null;
        V4.archivedAccounts = Array.isArray(j.archived_accounts) ? j.archived_accounts : [];
        V4.setFeatures(j.ui_features);
        return V4.setAccounts(j.accounts);
      } catch (e) {
        V4.accountsError = (e && e.message) || '账号列表加载失败';
        console.error('[v4] 获取账号列表失败:', e);
        return V4.ACCTS;
      }
    })();
    return accountsLoadPromise;
  };
  V4.loadAccounts();

  /* ----- 轮询（等本轮结束再计时；隐藏时不发起请求，回前台最多补一轮） ----- */
  V4.poll = function (fn, ms) {
    let timer = null, stopped = false, running = false;
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const schedule = () => {
      if (stopped || document.hidden) return;
      const delay = Number(typeof ms === 'function' ? ms() : ms);
      timer = setTimeout(run, Number.isFinite(delay) && delay > 0 ? delay : 60000);
    };
    const run = async () => {
      clear();
      if (stopped || document.hidden || running) return;
      running = true;
      try { await fn(); }
      catch (error) { console.error('[v4] 本轮刷新失败', error); }
      finally { running = false; schedule(); }
    };
    const onVis = () => { clear(); if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVis);
    run();
    const stop = () => { stopped = true; clear(); document.removeEventListener('visibilitychange', onVis); };
    stop.refresh = run; // 子面板切换复用同一个在途锁，不另起一条刷新链。
    return stop;
  };

  /* ----- 粒子背景（余光状态层；减弱动效只画一帧） ----- */
  V4.initPulse = function (canvasId) {
    const pc = $(canvasId); if (!pc) return { setMode() {} };
    const px = pc.getContext('2d');
    let W, H, ps = [], mode = 'good';
    const cur = { r: 52, g: 211, b: 153 };
    const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
    function rs() {
      W = pc.width = innerWidth; H = pc.height = innerHeight;
      ps = Array.from({ length: 64 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5), vy: (Math.random() - .5), r: .8 + Math.random() * 1.4 }));
    }
    function frame(moving) {
      const t = hex(V4.PULSE_COLOR[mode] || V4.PULSE_COLOR.good);
      cur.r += (t.r - cur.r) * .03; cur.g += (t.g - cur.g) * .03; cur.b += (t.b - cur.b) * .03;
      const col = `rgba(${cur.r | 0},${cur.g | 0},${cur.b | 0}`;
      const sp = !moving ? 0 : (mode === 'off' ? .05 : (mode === 'good' || mode === 'top') ? .3 : mode === 'warn' ? .7 : 1.6);
      px.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.x += p.vx * sp; p.y += p.vy * sp;
        if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20; if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
        px.beginPath(); px.arc(p.x, p.y, p.r, 0, 7); px.fillStyle = col + ',.45)'; px.fill();
      }
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j], d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (d < 11000) { px.beginPath(); px.moveTo(a.x, a.y); px.lineTo(b.x, b.y); px.strokeStyle = col + `,${(1 - d / 11000) * .12})`; px.lineWidth = .55; px.stroke(); }
      }
    }
    rs();
    addEventListener('resize', () => { rs(); if (V4.RM.matches) frame(false); });
    if (V4.RM.matches) frame(false);
    else (function loop() { if (!document.hidden) frame(true); requestAnimationFrame(loop); })();
    return {
      setMode(m) { mode = m; if (V4.RM.matches) frame(false); },
    };
  };

  /* ----- 空态 / 错误态 ----- */
  V4.emptyBox = t => `<div class="empty">${V4.esc(t)}</div>`;
  V4.errBox = e => {
    const expired = e && [e.code, e.message, e.body && e.body.code, e.body && e.body.error].includes('cookie_expired');
    const msg = expired ? '账户登录已过期，请更新登录后重试' : (e && e.status === 401)
      ? '访问验证失败，请检查工作台访问令牌'
      : ('加载失败：' + ((e && e.message) || e));
    const action = expired ? ' <a href="#/onboarding">更新账户登录</a>' : '';
    return `<div class="err-box"><span class="signal-dot warn"></span> ${V4.esc(msg)}${action}</div>`;
  };

  /* ----- 顶条「更新于」 ----- */
  V4.touch = () => { const u = $('upd'); if (u) u.textContent = '更新于 ' + V4.nowStr(); };

})(window.V4);

/* ===== 主题切换（暗夜 ⇄ 纸张卡通，localStorage v4-theme 持久化） ===== */
(function (V4) {
  'use strict';
  const KEY = 'v4-theme';

  function apply(theme) {
    if (theme === 'paper') document.documentElement.setAttribute('data-theme', 'paper');
    else document.documentElement.removeAttribute('data-theme');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'paper' ? '纸张主题' : '暗夜主题';
  }

  V4.theme = () => localStorage.getItem(KEY) || 'dark';
  V4.toggleTheme = function () {
    const next = V4.theme() === 'paper' ? 'dark' : 'paper';
    localStorage.setItem(KEY, next);
    apply(next);
  };

  function init() {
    apply(V4.theme());
    const btn = document.getElementById('themeToggle');
    if (btn) btn.onclick = V4.toggleTheme;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window.V4);

/* ===== 部署检测 + 全局异常可视化（2026-07-30） =====
   背景：维护者标签页连开多天，服务端已部署新版，内存旧 JS 异常导致按钮"点击无反应"。
   ① 每 5 分钟比对 /api/version，不一致顶部横幅提示刷新；② window 错误/未捕获 Promise 显性提示。
   都只提示一次、点击横幅即刷新，不自动强刷（不打断未读决策流）。 */
(function (V4) {
  'use strict';

  function showBanner(text, title) {
    if (document.getElementById('v4StaleBanner')) return; // 只插一次
    const b = document.createElement('div');
    b.id = 'v4StaleBanner';
    b.textContent = text;
    if (title) b.title = title;
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 14px;text-align:center;font-size:13px;cursor:pointer;background:var(--st-warn,#e6a23c);color:#1a1a1a;font-weight:600';
    b.onclick = () => location.reload();
    document.body.appendChild(b);
  }

  /* ① 部署版本检测：页面可见时才轮询（对齐 V4.poll 后台停表纪律） */
  V4._ver = null;
  async function checkVer() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = await r.json();
      if (!j || !j.ok || !j.v) return;
      if (!V4._ver) { V4._ver = j.v; return; } // 首次只记录
      if (j.v !== V4._ver) showBanner('系统已更新，点击刷新获取新版');
    } catch (e) { /* 网络失败静默，下轮再试 */ }
  }
  checkVer();
  setInterval(() => { if (!document.hidden) checkVer(); }, 5 * 60 * 1000);

  /* ② 全局异常可视化：静默死按钮 → 显性"请刷新" */
  function onErr(msg) {
    showBanner('页面脚本异常，点击刷新（Ctrl+F5）', String(msg || '').slice(0, 200));
  }
  window.addEventListener('error', e => onErr(e.message || (e.error && e.error.message)));
  window.addEventListener('unhandledrejection', e => onErr(e.reason && (e.reason.message || e.reason)));
})(window.V4);
