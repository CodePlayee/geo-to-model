// esbuild bundler for the terrain-builder app.
// Usage: node build.mjs [--watch] [--serve]

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const opts = {
    entryPoints: [path.join(__dirname, 'src/app.js')],
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser', 'import', 'default'],
    outfile: path.join(__dirname, 'dist/app.bundle.js'),
    sourcemap: true,
    logLevel: 'info',
    loader: {
        '.json': 'json',
        // Leaflet / leaflet-draw ship CSS that references marker PNGs and a GIF
        // spritesheet; inline images as data URLs so the single JS bundle is
        // self-contained (no extra asset files to serve).
        '.png': 'dataurl',
        '.gif': 'dataurl',
        '.svg': 'dataurl',
    },
    // get-pixels' browser build references a few node builtins; shim them.
    inject: [path.join(__dirname, 'build-shims.js')],
    define: {
        'process.env.NODE_ENV': '"production"',
        global: 'globalThis',
    },
    alias: {
        // Replace get-pixels' node-stream-heavy browser build with a native
        // <img>+canvas decoder (same { data, shape } shape).
        'get-pixels': path.join(__dirname, 'src/get-pixels-browser.js'),
    },
};

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

if (watch || serve) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    if (serve) {
        const { host, port } = await ctx.serve({
            servedir: __dirname,
            port: 8181,
        });
        console.log(`\n  ▶ http://localhost:${port}/index.html\n`);
    }
} else {
    await esbuild.build(opts);
    console.log('  ✓ bundled -> dist/app.bundle.js');
}
