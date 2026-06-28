// Build-time generator for the offline China administrative-region index.
//
// Crawls Aliyun DataV GeoAtlas (areas_v3) from country -> province -> city and
// emits a compact JSON the app loads for search + cascading dropdowns:
//
//   examples/terrain-builder/src/regions-index.json
//
// Each entry: { adcode, name, pinyin, py (initials), level, parent, center }.
// District-level (区县) geometry is NOT bundled — it's fetched lazily by adcode
// at selection time. We do include district *names* (one more crawl level) so
// the dropdown and search can reach them; their boundary is fetched on demand.
//
// Data: https://geo.datav.aliyun.com/areas_v3/bound/{adcode}[_full].json
// Datum: GCJ-02 (handled at selection time, not here).
//
// Usage:  node scripts/gen-regions.mjs

import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { pinyin } from 'pinyin-pro';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../examples/terrain-builder/src/regions-index.json');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (i === tries - 1) throw e;
            await sleep(400 * (i + 1));
        }
    }
}

function py(name) {
    const full = pinyin(name, { toneType: 'none', type: 'array' }).join('');
    const initials = pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('');
    return { pinyin: full, py: initials };
}

function entry(p, parentAdcode) {
    const { pinyin: full, py: initials } = py(p.name);
    return {
        adcode: p.adcode,
        name: p.name,
        pinyin: full,
        py: initials,
        level: p.level,
        parent: parentAdcode,
        center: p.center, // [lng, lat] GCJ-02
    };
}

async function main() {
    const out = [];
    console.log('· country -> provinces');
    const country = await fetchJson(`${BASE}/100000_full.json`);
    const provinces = country.features.map((f) => f.properties);

    let pi = 0;
    for (const prov of provinces) {
        pi++;
        out.push(entry(prov, 100000));
        // Municipalities (直辖市) and special regions may have no city tier;
        // crawl _full to get whatever children exist (cities or districts).
        let provFull;
        try {
            provFull = await fetchJson(`${BASE}/${prov.adcode}_full.json`);
        } catch (e) {
            console.warn(`  ! ${prov.name} (${prov.adcode}) full failed: ${e.message}`);
            continue;
        }
        const children = provFull.features.map((f) => f.properties);
        console.log(`  [${pi}/${provinces.length}] ${prov.name}: ${children.length} children`);

        for (const child of children) {
            out.push(entry(child, prov.adcode));
            // If the child is a city, crawl one more level for its districts.
            if (child.level === 'city') {
                let cityFull;
                try {
                    cityFull = await fetchJson(`${BASE}/${child.adcode}_full.json`);
                } catch (e) {
                    // Some cities have no _full (or it 404s) — skip districts.
                    continue;
                }
                for (const dist of cityFull.features.map((f) => f.properties)) {
                    out.push(entry(dist, child.adcode));
                }
                await sleep(60);
            }
        }
        await sleep(80);
    }

    // De-duplicate by adcode, and drop DataV marker artifacts (e.g. the
    // "100000_JD" 南海诸岛 inset, which has no name/level/real adcode).
    const seen = new Map();
    for (const e of out) {
        if (!e.name || !e.level) continue;
        if (typeof e.adcode !== 'number') continue;
        if (!seen.has(e.adcode)) seen.set(e.adcode, e);
    }
    const list = [...seen.values()];

    const byLevel = list.reduce((m, e) => ((m[e.level] = (m[e.level] || 0) + 1), m), {});
    await writeFile(OUT, JSON.stringify(list));
    console.log(`\n✓ ${list.length} regions -> ${path.relative(process.cwd(), OUT)}`);
    console.log('  by level:', byLevel);
}

main().catch((e) => { console.error(e); process.exit(1); });
