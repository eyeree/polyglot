// Tiny DOM helpers plus a few shared widgets (modal, toast, settings panel).

/**
 * h('div.card.red#id', { onClick, style: {..}, data: {..}, text }, ...children)
 * Children may be nodes, strings, arrays, or null/false (skipped).
 */
export function h(spec, attrs = {}, ...children) {
  const tag = (spec.match(/^[a-zA-Z0-9-]+/) || ['div'])[0];
  const el = document.createElement(tag);
  for (const tok of spec.slice(tag.length).match(/[.#][^.#]+/g) || []) {
    if (tok[0] === '#') el.id = tok.slice(1);
    else el.classList.add(tok.slice(1));
  }
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * modal({ title, body, buttons: [{label, value, primary}], dismissable }) -> Promise<value|null>
 * body may be a string or a node.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], dismissable = true, wide = false }) {
  return new Promise((resolve) => {
    const close = (v) => { backdrop.remove(); resolve(v); };
    const box = h('div.modal' + (wide ? '.modal-wide' : ''), {},
      title ? h('h2.modal-title', { text: title }) : null,
      h('div.modal-body', {}, body),
      h('div.modal-buttons', {}, buttons.map(b => h('button.btn' + (b.primary ? '.btn-primary' : ''), { text: b.label, onClick: () => close(b.value) }))),
    );
    const backdrop = h('div.modal-backdrop', { onClick: (e) => { if (dismissable && e.target === backdrop) close(null); } }, box);
    document.body.append(backdrop);
  });
}

export function confirm(message, { ok = 'OK', cancel = 'Cancel', title } = {}) {
  return modal({ title, body: message, buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: true }] }).then(Boolean);
}

let toastEl = null, toastTimer = null;
export function toast(msg, ms = 1800) {
  if (!toastEl) { toastEl = h('div.toast'); document.body.append(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/**
 * Build a settings form from a schema.
 * schema: [{ key, label, type: 'number'|'range'|'bool'|'select'|'color'|'text', min, max, step, options:[{value,label}], help }]
 * settings: object from makeSettings(). Changes are written immediately.
 */
export function settingsPanel(schema, settings, { onReset } = {}) {
  const rows = schema.map((f) => {
    const val = settings.get(f.key);
    let input;
    const set = (v) => settings.set(f.key, v);
    switch (f.type) {
      case 'bool':
        input = h('input', { type: 'checkbox', checked: !!val, onChange: (e) => set(e.target.checked) });
        break;
      case 'select':
        input = h('select', { onChange: (e) => set(coerce(e.target.value, f.options)) },
          f.options.map(o => h('option', { value: String(o.value), selected: String(o.value) === String(val), text: o.label ?? String(o.value) })));
        break;
      case 'range': {
        const out = h('span.settings-value', { text: String(val) });
        input = h('div.settings-range', {},
          h('input', { type: 'range', min: f.min, max: f.max, step: f.step ?? 1, value: val,
            onInput: (e) => { const v = Number(e.target.value); out.textContent = String(v); set(v); } }),
          out);
        break;
      }
      case 'color':
        input = h('input', { type: 'color', value: val, onInput: (e) => set(e.target.value) });
        break;
      case 'number':
        input = h('input', { type: 'number', min: f.min, max: f.max, step: f.step ?? 1, value: val, onChange: (e) => set(Number(e.target.value)) });
        break;
      default:
        input = h('input', { type: 'text', value: val ?? '', onChange: (e) => set(e.target.value) });
    }
    return h('label.settings-row', {}, h('div.settings-label', {}, f.label, f.help ? h('div.settings-help', { text: f.help }) : null), input);
  });
  return h('div.settings', {}, rows,
    h('div.settings-footer', {}, h('button.btn', { text: 'Reset to defaults', onClick: () => { settings.reset(); onReset?.(); } })));
}

function coerce(str, options) {
  const o = options.find(o => String(o.value) === str);
  return o ? o.value : str;
}

/** Simple drawer that slides up from the bottom; returns {el, open, close, body}. */
export function drawer({ title, onClose } = {}) {
  const body = h('div.drawer-body');
  const el = h('div.drawer', {},
    h('div.drawer-header', {}, h('div.drawer-title', { text: title || '' }), h('button.btn.btn-icon', { text: '✕', 'aria-label': 'Close', onClick: () => api.close() })),
    body);
  const api = {
    el, body,
    open() { if (!el.isConnected) document.body.append(el); requestAnimationFrame(() => el.classList.add('open')); },
    close() { el.classList.remove('open'); onClose?.(); },
    isOpen() { return el.classList.contains('open'); },
    setTitle(t) { el.querySelector('.drawer-title').textContent = t; },
  };
  return api;
}

export function fmtInt(n) { return n.toLocaleString(); }
