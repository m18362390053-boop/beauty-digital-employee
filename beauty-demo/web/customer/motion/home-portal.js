// Keep the reference's point-light → chosen-card → navigation rhythm separate from business routes.
export function initHomePortal(root) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const buttons = [...root.querySelectorAll('[data-portal]')];
  let navigating = false;
  for (const button of buttons) {
    button.addEventListener('pointerenter', () => { root.dataset.portalHover = button.dataset.portal; });
    button.addEventListener('pointerleave', () => { if (root.dataset.portalHover === button.dataset.portal) root.dataset.portalHover = ''; });
    button.addEventListener('focus', () => { root.dataset.portalHover = button.dataset.portal; });
    button.addEventListener('blur', () => { if (root.dataset.portalHover === button.dataset.portal) root.dataset.portalHover = ''; });
    button.addEventListener('pointermove', event => {
      const rect = button.getBoundingClientRect();
      button.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width * 100).toFixed(1)}%`);
      button.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height * 100).toFixed(1)}%`);
    }, { passive: true });
  }
  function reset() {
    navigating = false;
    root.dataset.portalActive = '';
    buttons.forEach(button => button.classList.remove('is-chosen'));
  }
  async function choose(name, action) {
    if (navigating) return;
    navigating = true;
    root.dataset.portalActive = name;
    root.querySelector(`[data-portal="${name}"]`)?.classList.add('is-chosen');
    if (!reduced.matches) await new Promise(resolve => setTimeout(resolve, 340));
    try { await action(); } finally { if (name === 'moment') reset(); }
  }
  return { choose, reset };
}
