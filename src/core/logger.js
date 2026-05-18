// All logs go to stderr; stdout is reserved for machine-readable summaries.
export function createLogger({ quiet = false } = {}) {
  return {
    info(msg, ...rest) { if (!quiet) process.stderr.write(`[info] ${msg} ${rest.map(fmt).join(' ')}\n`.trimEnd() + '\n'); },
    warn(msg, ...rest) { process.stderr.write(`[warn] ${msg} ${rest.map(fmt).join(' ')}\n`.trimEnd() + '\n'); },
    error(msg, ...rest) { process.stderr.write(`[error] ${msg} ${rest.map(fmt).join(' ')}\n`.trimEnd() + '\n'); },
  };
}

function fmt(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
