'use strict';
// Small local canvas. No libraries, network, video, or work while Setup is closed.
window.setupEffects = (() => {
  const hero = document.getElementById('setupHero');
  const canvas = document.getElementById('setupFlow');
  const context = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const toggle = document.getElementById('motionToggle');
  const colors = ['116,227,205', '119,172,255', '178,151,255'];
  let visible = false, enabled = true, frame = null, lastPaint = 0, time = 0;
  let width = 1, height = 1, targetX = 0, targetY = 0, x = 0, y = 0;
  const moving = () => visible && enabled && !reduced.matches && !document.hidden;
  function resize() {
    width = Math.max(1, hero.clientWidth); height = Math.max(1, hero.clientHeight);
    const scale = Math.min(devicePixelRatio || 1, 1.25);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    context?.setTransform(scale, 0, 0, scale, 0, 0);
  }
  function paint() {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const cx = width * .78 + x * 13, cy = height * .48 + y * 9;
    const glow = context.createRadialGradient(cx, cy, 3, cx, cy, height * .9);
    glow.addColorStop(0, 'rgba(102,180,219,.17)'); glow.addColorStop(1, 'rgba(80,125,220,0)');
    context.fillStyle = glow; context.fillRect(0, 0, width, height);
    for (let i = 0; i < 60; i++) {
      const depth = .3 + (i % 7) / 7;
      const px = ((i * .61803398875 + time * .000012 * depth) % 1) * width + x * 13 * depth;
      const py = ((i * .41421356237 - time * .000009 * depth) % 1 + 1) % 1 * height + y * 11 * depth;
      context.strokeStyle = `rgba(${colors[i % 3]},${.16 + depth * .35})`;
      context.lineWidth = depth * 1.5;
      context.beginPath(); context.moveTo(px, py); context.lineTo(px + 2 + depth * 3, py - 3 * depth); context.stroke();
    }
    for (let lane = 0; lane < 5; lane++) {
      const at = u => ({ x: width * (.26 + .76 * u) + x * (lane + 2), y: height * .64 + (lane - 2) * 18 + Math.sin(u * 5.1 + lane * .18 + time * .00012) * 21 + y * 5 });
      context.beginPath();
      for (let j = 0; j <= 50; j++) { const p = at(j / 50); if (!j) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); }
      context.strokeStyle = `rgba(${colors[lane % 3]},.1)`; context.lineWidth = .7; context.stroke();
      for (let n = 0; n < 3; n++) {
        const u = (time * (.00004 + lane * .000006) + n / 3 + lane * .11) % 1;
        const p = at(u), trail = at(Math.max(0, u - .018));
        context.strokeStyle = `rgba(${colors[lane % 3]},${Math.sin(u * Math.PI) * .65})`;
        context.lineWidth = 2; context.beginPath(); context.moveTo(trail.x, trail.y); context.lineTo(p.x, p.y); context.stroke();
        if (n === 1 && lane % 2 === 0) { context.fillStyle = `rgba(${colors[lane % 3]},.4)`; context.font = '8px Consolas, monospace'; context.fillText(lane === 0 ? '01' : '10', p.x + 5, p.y - 5); }
      }
    }
    context.save(); context.translate(cx, cy); context.rotate(-.35 + x * .04);
    for (let i = 0; i < 3; i++) {
      context.strokeStyle = `rgba(${colors[i]},${.14 + i * .02})`;
      context.lineWidth = 1; context.beginPath(); context.ellipse(0, 0, 31 + i * 18, 56 + i * 10, i * .7 + time * .00002, 0, Math.PI * 2); context.stroke();
    }
    context.restore();
  }
  function draw(now) {
    frame = null;
    if (!moving()) return;
    if (now - lastPaint >= 1000 / 30) {
      time += Math.min(70, now - (lastPaint || now)); lastPaint = now;
      x += (targetX - x) * .12; y += (targetY - y) * .12;
      paint();
    }
    frame = requestAnimationFrame(draw);
  }
  function sync() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; lastPaint = 0;
    const active = enabled && !reduced.matches;
    toggle.textContent = reduced.matches ? 'Reduced motion' : enabled ? 'Motion on' : 'Motion off';
    toggle.setAttribute('aria-pressed', String(active)); toggle.disabled = reduced.matches;
    hero.classList.toggle('motion-paused', !active);
    hero.dataset.motion = moving() ? 'running' : 'paused';
    if (visible) { resize(); paint(); }
    if (moving()) frame = requestAnimationFrame(draw);
  }
  hero.addEventListener('pointermove', event => {
    if (!moving()) return;
    const bounds = hero.getBoundingClientRect();
    targetX = (event.clientX - bounds.left) / bounds.width * 2 - 1;
    targetY = (event.clientY - bounds.top) / bounds.height * 2 - 1;
  });
  hero.addEventListener('pointerleave', () => { targetX = targetY = 0; });
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(() => { if (visible) { resize(); paint(); } }).observe(hero);
  return {
    open() { visible = true; sync(); },
    close() { visible = false; targetX = targetY = x = y = 0; sync(); },
    setEnabled(value) { enabled = !!value; sync(); },
    enabled: () => enabled,
  };
})();
