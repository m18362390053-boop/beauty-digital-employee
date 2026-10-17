// Adapted from UI参考/assets/app.js navigateTo(): animate only the customer views.
export function createPageTransition({ render, afterRender }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let serial = 0;
  return async function navigate(view, { animate = true, focus = false } = {}) {
    const current = ++serial;
    const shouldAnimate = animate && !reduced.matches && typeof document.startViewTransition === 'function';
    if (!shouldAnimate) {
      render(view, focus);
      afterRender?.(view, false);
      return;
    }
    const transition = document.startViewTransition(() => render(view, false));
    try {
      await transition.ready;
      if (current === serial) afterRender?.(view, true);
      await transition.finished;
    } catch {
      // A rapid second navigation can cancel the first transition; state is already rendered.
    }
    if (current === serial && focus) document.querySelector('#message')?.focus();
  };
}
