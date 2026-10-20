// Isolated adaptation of UI参考/assets/app.js 239–267. Anchors belong to this page.
const center = element => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const bezier = (a, b, c, d, t) => { const m = 1 - t; return { x: m ** 3 * a.x + 3 * m * m * t * b.x + 3 * m * t * t * c.x + t ** 3 * d.x,
  y: m ** 3 * a.y + 3 * m * m * t * b.y + 3 * m * t * t * c.y + t ** 3 * d.y }; };
const distanceToRect = (point, rect) => Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right), Math.max(rect.top - point.y, 0, point.y - rect.bottom));

function plan(start, end, target) {
  const dx = end.x - start.x, dy = end.y - start.y, distance = Math.hypot(dx, dy);
  const arc = Math.min(115, 30 + distance * .13);
  const x1 = start.x + dx * .3, x2 = start.x + dx * .72;
  const y1 = start.y + dy * .28, y2 = start.y + dy * .76;
  const options = [
    [{ x: x1, y: y1 - arc }, { x: x2, y: y2 - arc }],
    [{ x: x1, y: y1 + arc }, { x: x2, y: y2 + arc }],
    [{ x: x1 - arc, y: y1 }, { x: x2 - arc, y: y2 }],
    [{ x: x1 + arc, y: y1 }, { x: x2 + arc, y: y2 }],
  ];
  const obstacles = [...document.querySelectorAll('[data-flight-obstacle]')]
    .filter(node => !node.hidden && node !== target && !node.contains(target)).map(node => node.getBoundingClientRect());
  const score = ([p1, p2], index) => {
    let value = index * .35;
    for (let i = 1; i <= 22; i++) {
      const p = bezier(start, p1, p2, end, i / 22);
      if (p.x < 12 || p.x > innerWidth - 12 || p.y < 12 || p.y > innerHeight - 12) value += 80;
      for (const rect of obstacles) { const d = distanceToRect(p, rect); if (d === 0) value += 70; else if (d < 20) value += 20 * (1 - d / 20); }
    }
    return value;
  };
  const best = options.map((points, index) => ({ points, score: score(points, index) })).sort((a, b) => a.score - b.score)[0].points;
  return { p1: best[0], p2: best[1], distance };
}

export function createButterflyFlight(element) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let initialized = false;
  let currentView = 'home';
  const put = point => { element.style.left = `${point.x}px`; element.style.top = `${point.y}px`; };
  function moveTo(view, animate = true) {
    currentView = view;
    const target = document.querySelector(`[data-butterfly-anchor="${view}"]`);
    if (!target) { element.hidden = true; return; }
    element.hidden = false;
    const end = center(target);
    cancelAnimationFrame(frame);
    if (!initialized || !animate || reduced.matches) {
      put(end); element.style.rotate = '-9deg'; element.dataset.state = 'resting'; initialized = true; return;
    }
    const rect = element.getBoundingClientRect();
    const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const route = plan(start, end, target);
    const duration = Math.min(1050, 480 + route.distance * .85);
    const started = performance.now();
    element.dataset.state = 'takingOff';
    const tick = now => {
      const raw = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - raw) ** 3;
      const fresh = center(target);
      const destination = { x: end.x + (fresh.x - end.x) * raw, y: end.y + (fresh.y - end.y) * raw };
      const p = bezier(start, route.p1, route.p2, destination, eased);
      put(p);
      const tangent = bezier(start, route.p1, route.p2, destination, Math.min(.99, eased + .01));
      const angle = Math.max(-20, Math.min(20, Math.atan2(tangent.y - p.y, tangent.x - p.x) * 180 / Math.PI));
      element.style.rotate = `${(angle * (1 - raw) - 9 * raw).toFixed(1)}deg`;
      element.dataset.state = raw > .83 ? 'landing' : 'flying';
      if (raw < 1) frame = requestAnimationFrame(tick);
      else { put(center(target)); element.dataset.state = 'resting'; frame = 0; }
    };
    frame = requestAnimationFrame(tick);
  }
  addEventListener('resize', () => { if (element.dataset.state === 'resting') moveTo(currentView, false); }, { passive: true });
  return { moveTo };
}
