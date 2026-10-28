// localStorage JSON helpers. Everything is namespaced per game by the caller.

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/**
 * Settings object that merges stored overrides over defaults and persists changes.
 * Usage: const settings = makeSettings('yukon.settings', DEFAULTS); settings.get('cardScale'); settings.set('cardScale', 1.1);
 */
export function makeSettings(key, defaults) {
  const stored = load(key, {}) || {};
  const values = { ...defaults, ...stored };
  const listeners = new Set();
  return {
    defaults,
    values,
    get(k) { return values[k]; },
    set(k, v) {
      values[k] = v;
      const diff = {};
      for (const [dk, dv] of Object.entries(values)) if (dv !== defaults[dk]) diff[dk] = dv;
      save(key, diff);
      for (const fn of listeners) fn(k, v, values);
    },
    reset() {
      for (const k of Object.keys(values)) values[k] = defaults[k];
      remove(key);
      for (const fn of listeners) fn(null, null, values);
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
