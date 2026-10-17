// Pointer smoothing, local glare and button ripples adapted from UI参考/assets/app.js.
export function initPointerLighting() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  if (reduced.matches || !fine.matches) return;
  let x = innerWidth / 2, y = innerHeight / 2, tx = 0, ty = 0, sx = 0, sy = 0, active = false;
  let frame = 0;
  const states = new WeakMap();
  const elements = () => [...document.querySelectorAll('[data-spec], [data-liquid-blob]')].filter(node => node.getClientRects().length);
  function tick() {
    if (!document.hidden) {
      sx += (tx - sx) * .055; sy += (ty - sy) * .055;
      document.documentElement.style.setProperty('--px', sx.toFixed(3));
      document.documentElement.style.setProperty('--py', sy.toFixed(3));
      for (const node of elements()) {
        const r = node.getBoundingClientRect();
        const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
        const distance = Math.hypot(dx, dy), reach = node.hasAttribute('data-liquid-blob') ? 240 : 175;
        const target = active ? Math.max(0, 1 - distance / reach) : 0;
        const state = states.get(node) ?? { bright: 0, angle: 2.4 };
        state.bright += (target - state.bright) * .16;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const angle = Math.atan2(cy - y, x - cx);
        const diff = ((angle - state.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        state.angle += diff * .13;
        states.set(node, state);
        node.style.setProperty('--spec-bright', (state.bright ** 2 * (3 - 2 * state.bright)).toFixed(3));
        node.style.setProperty('--spec-angle', `${state.angle.toFixed(3)}rad`);
        if (node.hasAttribute('data-liquid-blob')) {
          const localX = Math.max(0, Math.min(100, (x - r.left) / r.width * 100));
          const localY = Math.max(0, Math.min(100, (y - r.top) / r.height * 100));
          node.style.setProperty('--card-light-x', `${localX.toFixed(1)}%`);
          node.style.setProperty('--card-light-y', `${localY.toFixed(1)}%`);
          node.style.setProperty('--blob-shift-x', `${((localX - 50) * .055).toFixed(2)}px`);
          node.style.setProperty('--blob-shift-y', `${((localY - 50) * .055).toFixed(2)}px`);
        }
      }
    }
    frame = requestAnimationFrame(tick);
  }
  addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    x = event.clientX; y = event.clientY; tx = x / innerWidth * 2 - 1; ty = y / innerHeight * 2 - 1; active = true;
    const button = event.target.closest?.('[data-motion-button]');
    if (button) { const r = button.getBoundingClientRect(); button.style.setProperty('--mx', `${((x - r.left) / r.width * 100).toFixed(1)}%`); button.style.setProperty('--my', `${((y - r.top) / r.height * 100).toFixed(1)}%`); }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { tx = 0; ty = 0; active = false; });
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-motion-button]'); if (!button) return;
    const r = button.getBoundingClientRect(); const ripple = document.createElement('span');
    ripple.className = 'motion-ripple'; ripple.style.left = `${event.clientX - r.left}px`; ripple.style.top = `${event.clientY - r.top}px`;
    button.append(ripple); ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  });
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
