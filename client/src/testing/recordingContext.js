/**
 * Test harness: a CanvasRenderingContext2D stand-in that records every
 * call (jsdom has no canvas). Text is measured at 0.6 em per character.
 * Each record carries the transform it was made under (translate / scale /
 * rotate are tracked), so a test can say WHERE a face drew something.
 */
export function recordingContext() {
  const calls = [];
  const stack = [];
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const state = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 };
  const apply = (n) => {
    m = { a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f };
  };
  const point = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const rec = (op, args) => {
    const [x, y] = op === 'fillText' || op === 'strokeText' ? [args[1], args[2]] : [args[0], args[1]];
    calls.push({ op, args, ...state, at: point(x ?? 0, y ?? 0), m: { ...m } });
  };
  const ctx = {
    calls,
    canvas: { width: 0, height: 0 },
    save() { stack.push({ m: { ...m }, s: { ...state } }); rec('save', []); },
    restore() { const t = stack.pop(); if (t) { m = t.m; Object.assign(state, t.s); } rec('restore', []); },
    translate(x, y) { apply({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); },
    scale(x, y) { apply({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); },
    rotate(r) { const c = Math.cos(r); const s = Math.sin(r); apply({ a: c, b: s, c: -s, d: c, e: 0, f: 0 }); },
    measureText(t) { const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] || 10); return { width: String(t).length * px * 0.6 }; },
    get depth() { return stack.length; },
  };
  for (const op of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'rect', 'fill', 'stroke', 'clip', 'fillRect', 'clearRect', 'fillText', 'strokeText', 'drawImage']) {
    ctx[op] = (...args) => rec(op, args);
  }
  for (const k of Object.keys(state)) {
    Object.defineProperty(ctx, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  }
  return ctx;
}
