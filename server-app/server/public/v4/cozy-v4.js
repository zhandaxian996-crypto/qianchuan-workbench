/* Cozy V4 contextual copy: workbench language only, never morning/night greetings. */
(function () {
  'use strict';
  let scheduled = false;

  function heroNodes() {
    const demo = document.querySelector('.demo-hero');
    if (demo) return { root: demo, title: demo.querySelector('h1'), text: demo.querySelector('p') };
    const real = document.querySelector('.cozy-hero');
    if (real) return { root: real, title: real.querySelector('h1'), text: real.querySelector('p') };
    return null;
  }

  function currentCopy() {
    const demo = document.body.classList.contains('demo-mode-active');
    const hasAccounts = !!(window.V4 && Array.isArray(V4.ACCTS) && V4.ACCTS.length);
    const live = !!document.querySelector('.live.on');
    if (demo) return {
      title: '让每一次投放更有把握',
      text: '把复杂数据理清，把每一分预算花明白；先看证据，再做动作。',
    };
    if (!hasAccounts) return {
      title: '先把工作台接起来',
      text: '接入账号后，这里会用真实数据陪你看清趋势、证据和每一次决策。',
    };
    if (live) return {
      title: '直播进行中，稳住节奏',
      text: '数据在变化，判断要更清楚；先确认信号，再决定下一步动作。',
    };
    return {
      title: '稳稳投，慢慢长',
      text: '愿每一分投入都有依据，每一次优化都更接近稳定增长。',
    };
  }

  function enhance() {
    scheduled = false;
    const nodes = heroNodes();
    if (!nodes) return;
    const copy = currentCopy();
    if (nodes.title && nodes.title.textContent !== copy.title) nodes.title.textContent = copy.title;
    if (nodes.text && nodes.text.textContent !== copy.text) nodes.text.textContent = copy.text;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  addEventListener('hashchange', schedule);
  document.addEventListener('v4:features', schedule);
  if (window.V4 && typeof V4.onAcctChange === 'function') V4.onAcctChange(schedule);
  if (window.V4 && typeof V4.onAccountsChange === 'function') V4.onAccountsChange(schedule);
  const observer = new MutationObserver(schedule);
  const start = () => { observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); schedule(); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
