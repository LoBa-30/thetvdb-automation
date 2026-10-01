if (!globalThis.CSS) globalThis.CSS = {};
if (typeof globalThis.CSS.escape !== 'function') {
  globalThis.CSS.escape = value => String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
