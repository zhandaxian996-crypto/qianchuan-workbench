/* 温暖中性工作台增强：仅改视觉与展示文案，不改变 API、Agent 或投放逻辑。 */
(function (V4) {
  'use strict';
  let scheduled = false;
  const iconMap = { overview: '⌂', warroom: '◉', decisions: '☷', replay: '◔', system: '⚙', onboarding: '⌁' };
  const chipMap = {
    warroom: '直播场次 · 稳住节奏，先看证据',
    decisions: '决策记录 · 看清每一次判断的依据',
    replay: '复盘 · 把经验留给下一场',
    system: '设置 · 让工作台保持清楚可靠',
    onboarding: '接入与配置 · 简单、安全、凭据只留本机',
  };

  function routeName() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    return h || 'overview';
  }

  function installSidebar() {
    let side = document.querySelector('.cozy-sidebar');
    if (!side) {
      side = document.createElement('aside');
      side.className = 'cozy-sidebar';
      side.innerHTML = '<div class="cozy-brand">千川投放工作台<span>DATA WORKBENCH</span></div><nav aria-label="工作台导航"></nav><div class="cozy-side-note"><b>稳稳投，慢慢长</b>把复杂的数据理清，把时间留给判断。</div>';
      document.body.appendChild(side);
    }
    const sourceNav = document.querySelector('header.top #nav');
    const targetNav = side.querySelector('nav');
    if (sourceNav && targetNav) {
      const signature = [...sourceNav.querySelectorAll('a')].map(a => a.getAttribute('href') + ':' + a.textContent.trim()).join('|');
      if (targetNav.dataset.signature !== signature) {
        targetNav.dataset.signature = signature;
        targetNav.innerHTML = '';
        sourceNav.querySelectorAll('a').forEach(a => {
          const c = a.cloneNode(true);
          c.removeAttribute('id');
          const key = c.dataset.r || String(c.getAttribute('href') || '').replace(/^#\/?/, '');
          c.dataset.cozyIcon = iconMap[key] || '·';
          targetNav.appendChild(c);
        });
      }
    }
    syncSidebarActive();
  }

  function syncSidebarActive() {
    const name = routeName();
    document.querySelectorAll('.cozy-sidebar nav a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
  }

  function installClouds() {
    if (!document.querySelector('.cozy-float-cloud.c1')) {
      const a = document.createElement('i'); a.className = 'cozy-float-cloud c1'; a.setAttribute('aria-hidden', 'true'); document.body.appendChild(a);
      const b = document.createElement('i'); b.className = 'cozy-float-cloud c2'; b.setAttribute('aria-hidden', 'true'); document.body.appendChild(b);
    }
  }

  function updateThemeAffordance() {
    const paper = document.documentElement.getAttribute('data-theme') === 'paper';
    const btn = document.getElementById('themeToggle');
    if (btn) {
      const label = paper ? '夜间风格' : '日间风格';
      const title = paper ? '切换到夜间风格' : '切换到日间风格';
      if (btn.textContent !== label) btn.textContent = label;
      if (btn.title !== title) btn.title = title;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    const color = paper ? '#f5f8fc' : '#0c1728';
    if (meta && meta.getAttribute('content') !== color) meta.setAttribute('content', color);
  }

  function enhanceOverview() {
    const intro = document.querySelector('#view .pg-ov-intro');
    if (!intro) return;
    if (!intro.classList.contains('cozy-hero')) {
      intro.classList.add('cozy-hero');
      const h1 = intro.querySelector('h1');
      const p = intro.querySelector('p');
      if (h1) h1.textContent = '让每一次投放更有把握';
      if (p) p.textContent = '今天也把每一分预算花明白。稳稳投，慢慢长；先看证据，再做动作。';
      const copy = intro.querySelector(':scope > div:first-child');
      if (copy && !copy.querySelector('.cozy-hero-badge')) {
        const badge = document.createElement('span');
        badge.className = 'cozy-hero-badge';
        badge.innerHTML = '<i></i>只读展示 · 投放操作由外部 Agent 完成';
        copy.appendChild(badge);
      }
    }
    if (!document.querySelector('#view .cozy-companion')) {
      const anchor = document.querySelector('#view #ovMore') || document.querySelector('#view #ovAlerts') || document.querySelector('#view .pg-ov-cards');
      if (anchor) {
        const strip = document.createElement('section');
        strip.className = 'cozy-companion';
        strip.innerHTML = '<strong>数据在变，方向要更清楚</strong><span>愿每一分投入都有依据，每一次调整都有回声。</span>';
        anchor.insertAdjacentElement('afterend', strip);
      }
    }
  }

  function enhanceOtherPage() {
    const route = routeName();
    if (route === 'overview') return;
    const view = document.getElementById('view');
    if (!view || !view.firstElementChild || view.querySelector(':scope > .cozy-page-chip')) return;
    const text = chipMap[route];
    if (!text) return;
    const chip = document.createElement('div');
    chip.className = 'cozy-page-chip';
    chip.textContent = text;
    view.insertBefore(chip, view.firstElementChild);
  }

  function softenLabels() {
    document.querySelectorAll('.acct-manager header p').forEach(p => {
      if (p.textContent !== '添加或彻底删除账号') p.textContent = '添加或彻底删除账号';
    });
  }

  function enhance() {
    scheduled = false;
    installSidebar();
    installClouds();
    updateThemeAffordance();
    syncSidebarActive();
    if (routeName() === 'overview') enhanceOverview(); else enhanceOtherPage();
    softenLabels();
    document.body.classList.add('cozy-ready');
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  addEventListener('hashchange', schedule);
  document.addEventListener('v4:features', schedule);
  const domObserver = new MutationObserver(schedule);
  const themeObserver = new MutationObserver(schedule);
  const start = () => {
    domObserver.observe(document.body, { childList: true, subtree: true });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    schedule();
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})(window.V4 || {});
