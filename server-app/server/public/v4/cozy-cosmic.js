/* 左下角宇宙能量核心。纯展示组件；不读取、不写入任何业务数据。 */
(function () {
  'use strict';

  function installCosmicOrb() {
    const side = document.querySelector('.cozy-sidebar');
    if (!side || side.querySelector('.cozy-cosmic-orb')) return;

    const orb = document.createElement('div');
    orb.className = 'cozy-cosmic-orb';
    orb.setAttribute('aria-hidden', 'true');
    orb.innerHTML = [
      '<span class="cosmic-aura"></span>',
      '<span class="cosmic-glyph"></span>',
      '<span class="cosmic-ring r1"></span>',
      '<span class="cosmic-ring r2"></span>',
      '<span class="cosmic-ring r3"></span>',
      '<span class="cosmic-orbit-dot d1"></span>',
      '<span class="cosmic-orbit-dot d2"></span>',
      '<span class="cosmic-orbit-dot d3"></span>',
      '<span class="cosmic-core"></span>',
      '<span class="cosmic-spark s1"></span>',
      '<span class="cosmic-spark s2"></span>',
      '<span class="cosmic-spark s3"></span>',
      '<span class="cosmic-spark s4"></span>',
      '<span class="cosmic-spark s5"></span>',
      '<span class="cosmic-spark s6"></span>'
    ].join('');
    side.appendChild(orb);
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      installCosmicOrb();
    });
  }

  addEventListener('hashchange', schedule);
  document.addEventListener('v4:features', schedule);

  function start() {
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
