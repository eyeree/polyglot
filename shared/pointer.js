// Unified tap/drag handling with pointer events (works for mouse and touch).
//
// onPress(el, {
//   threshold: 6,            // px of movement before a press becomes a drag
//   onTap(e),                // pointer released without dragging
//   onDragStart(e),          // return false to refuse the drag (e.g. the element isn't movable)
//   onDragMove(e, dx, dy),
//   onDragEnd(e, dx, dy),    // called after a drag (not after a tap)
//   onLongPress(e),          // optional, fires once if held ~450ms without moving
// })
// The handler object passed to callbacks has clientX/clientY and the original event as `.ev`.

export function onPress(el, opts) {
  const threshold = opts.threshold ?? 6;
  let active = null;

  // downTarget is the element the press started on (pointer capture makes later events target `el`).
  const info = (ev) => ({ clientX: ev.clientX, clientY: ev.clientY, target: ev.target, downTarget: active?.target ?? ev.target, ev });

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (active) return;
    if (opts.filter && !opts.filter(ev)) return;
    active = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, dragging: false, longTimer: null, refused: false, target: ev.target };
    try { el.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    if (opts.onLongPress) {
      active.longTimer = setTimeout(() => {
        if (active && !active.dragging) { active.long = true; opts.onLongPress(info(ev)); }
      }, opts.longPressMs ?? 450);
    }
    if (opts.preventDefault !== false) ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
    if (!active || ev.pointerId !== active.id) return;
    const dx = ev.clientX - active.x0, dy = ev.clientY - active.y0;
    if (!active.dragging) {
      if (Math.hypot(dx, dy) < threshold) return;
      clearTimeout(active.longTimer);
      if (active.long) return;
      if (opts.onDragStart && opts.onDragStart(info(ev)) === false) { active.refused = true; }
      active.dragging = true;
    }
    if (active.refused) return;
    if (opts.onDragMove) opts.onDragMove(info(ev), dx, dy);
  });

  const finish = (ev, cancelled) => {
    if (!active || ev.pointerId !== active.id) return;
    clearTimeout(active.longTimer);
    const a = active;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    const i = info(ev);
    active = null;
    if (cancelled) { if (a.dragging && !a.refused && opts.onDragEnd) opts.onDragEnd(i, 0, 0, true); return; }
    const dx = ev.clientX - a.x0, dy = ev.clientY - a.y0;
    if (a.dragging) { if (!a.refused && opts.onDragEnd) opts.onDragEnd(i, dx, dy, false); }
    else if (!a.long && opts.onTap) opts.onTap(i);
  };
  el.addEventListener('pointerup', (ev) => finish(ev, false));
  el.addEventListener('pointercancel', (ev) => finish(ev, true));
}

/** Element under a point, ignoring the elements in `ignore` (e.g. the thing being dragged). */
export function elementAt(x, y, ignore = []) {
  const hidden = [];
  for (const el of ignore) { if (el) { hidden.push([el, el.style.pointerEvents]); el.style.pointerEvents = 'none'; } }
  const found = document.elementFromPoint(x, y);
  for (const [el, pe] of hidden) el.style.pointerEvents = pe;
  return found;
}
