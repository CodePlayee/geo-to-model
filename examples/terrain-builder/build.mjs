// esbuild bundler for the terrain-builder app.
// Usage: node build.mjs [--watch] [--serve]

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The offline admin index is fetched at runtime (lazily, ~0.4 MB) rather than
// bundled. Copy it next to the bundle so it resolves via import.meta.url no
// matter how the app is hosted — including deployments that ship only
// index.html + dist/. Runs on every rebuild, and in --serve mode too (esbuild
// serves unknown /dist/* paths from disk).
const copyRegionsIndex = {
    name: 'copy-regions-index',
    setup(build) {
        const from = path.join(__dirname, 'src/regions-index.json');
        const to = path.join(__dirname, 'dist/regions-index.json');
        build.onEnd(() => {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
        });
    },
};

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
    plugins: [copyRegionsIndex],
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
        // Optional default Mapbox token for a deployment that wants the demo
        // usable without the visitor pasting their own. Empty by default, in
        // which case the app keeps prompting for one.
        __MAPBOX_TOKEN__: JSON.stringify(process.env.MAPBOX_TOKEN || ''),
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
