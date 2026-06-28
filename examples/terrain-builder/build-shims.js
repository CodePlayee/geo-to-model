// Browser shims injected into the bundle (esbuild `inject`).
// Provides a minimal `Buffer` and `process` for transitive deps that expect
// a Node-ish environment (get-pixels' browser path, pbf, etc.).
import { Buffer as _Buffer } from 'buffer';

export const Buffer = _Buffer;
export const process = { env: { NODE_ENV: 'production' }, browser: true, nextTick: (fn, ...a) => setTimeout(() => fn(...a), 0) };
