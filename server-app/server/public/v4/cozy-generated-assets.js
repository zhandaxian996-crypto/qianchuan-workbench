/* Restore the generated bitmap atlas and expose six real-image CSS assets. */
(function () {
  'use strict';

  const base = '/v4/assets/generated/';
  const parts = [
    'atlas-part-00.txt', 'atlas-part-01.txt', 'atlas-part-02.txt',
    'atlas-cont-00.txt', 'atlas-cont-01.txt', 'atlas-cont-02.txt',
    'atlas-cont-03.txt', 'atlas-cont-04.txt', 'atlas-cont-05.txt',
    'atlas-cont-06.txt', 'atlas-cont-07.txt'
  ];
  const objectUrls = [];

  async function text(url) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`generated asset chunk ${res.status}`);
    return (await res.text()).trim();
  }

  function decodeBase64(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas export failed')), 'image/webp', 0.96);
    });
  }

  async function crop(img, x, y, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
    const blob = await canvasBlob(canvas);
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }

  async function install() {
    try {
      const chunks = await Promise.all(parts.map(name => text(base + name)));
      const atlasBlob = new Blob([decodeBase64(chunks.join(''))], { type: 'image/webp' });
      const atlasUrl = URL.createObjectURL(atlasBlob);
      objectUrls.push(atlasUrl);
      const img = await loadImage(atlasUrl);

      const assets = {
        heroDay: await crop(img, 0, 0, 900, 300),
        heroNight: await crop(img, 0, 300, 900, 300),
        bottomDay: await crop(img, 125, 600, 650, 217),
        bottomNight: await crop(img, 125, 817, 650, 217),
        sideDay: await crop(img, 330, 1034, 240, 320),
        sideNight: await crop(img, 330, 1354, 240, 320)
      };

      const root = document.documentElement;
      root.style.setProperty('--cozy-bitmap-hero-day', `url("${assets.heroDay}")`);
      root.style.setProperty('--cozy-bitmap-hero-night', `url("${assets.heroNight}")`);
      root.style.setProperty('--cozy-bitmap-bottom-day', `url("${assets.bottomDay}")`);
      root.style.setProperty('--cozy-bitmap-bottom-night', `url("${assets.bottomNight}")`);
      root.style.setProperty('--cozy-bitmap-side-day', `url("${assets.sideDay}")`);
      root.style.setProperty('--cozy-bitmap-side-night', `url("${assets.sideNight}")`);
      root.classList.add('cozy-generated-ready');
      document.dispatchEvent(new CustomEvent('cozy:generated-assets-ready'));
    } catch (error) {
      console.warn('[cozy] generated bitmap assets unavailable, keeping SVG fallback', error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();

  addEventListener('beforeunload', () => objectUrls.forEach(url => URL.revokeObjectURL(url)), { once: true });
})();
