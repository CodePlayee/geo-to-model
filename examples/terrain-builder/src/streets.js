// Streets feature model: builds water / road / building 3D geometry from
// Mapbox Streets v8 vector tiles and drapes it onto an existing three-geo
// RGB terrain.
//
// Alignment note: `proj([lat,lng])` (from ThreeGeo#getProjection) returns
// `[x,y]` in the SAME coordinate space as the RGB terrain mesh vertices (both
// derive from `_projectCoord`, and the terrain mesh carries no rotation). So a
// feature placed at `proj()` coords sits directly above the terrain, and a
// downward raycast resolves its ground elevation.

import * as THREE from 'three';
import Fetch from '../../../src/models/fetch.js';

const DOWN = new THREE.Vector3(0, 0, -1);

// Road width (meters) by Streets v8 road `class`. Fallback handles unknowns.
const ROAD_WIDTH_M = {
    motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8,
    street: 6, service: 4, path: 2, pedestrian: 3, footway: 2, cycleway: 2,
};
const roadWidth = (cls) => ROAD_WIDTH_M[cls] || 5;

export default class StreetsModel {
    /**
     * @param {object} opts
     * @param {string} opts.token       Mapbox token
     * @param {boolean} opts.isNode
     * @param {Function} opts.proj      ([lat,lng]) => [x,y]
     * @param {number} opts.unitsPerMeter
     * @param {THREE.Object3D} opts.terrain  RGB terrain group (raycast target)
     * @param {Array} opts.zpCovered    [[z,x,y], ...] tiles covering the ROI
     */
    constructor(opts) {
        this.token = opts.token;
        this.isNode = opts.isNode || false;
        this.proj = opts.proj;
        this.unitsPerMeter = opts.unitsPerMeter;
        this.terrain = opts.terrain;
        this.zpCovered = opts.zpCovered;
        this._ray = new THREE.Raycaster();
        this._terrainMeshes = [];
        this.terrain.traverse((o) => { if (o.isMesh) this._terrainMeshes.push(o); });
    }

    // Resolve terrain elevation (z) at WebGL (x,y). Returns 0 if no hit.
    _z(x, y) {
        this._ray.set(new THREE.Vector3(x, y, 1e4), DOWN);
        const hits = this._ray.intersectObjects(this._terrainMeshes, false);
        return hits.length ? hits[0].point.z : 0;
    }

    _xy(lng, lat) { return this.proj([lat, lng]); } // geojson is [lng,lat]

    /**
     * Fetch tiles and build selected feature layers.
     * @param {{water:boolean, road:boolean, building:boolean}} sel
     * @param {(msg:string)=>void} [onProgress]
     * @returns {Promise<THREE.Group>} group with `.userData.report`:
     *   { counts:{water,waterway,road,building}, tilesOk, tilesTotal, empty:[...] }
     */
    async build(sel, onProgress = () => {}) {
        const group = new THREE.Group();
        group.name = 'streets';

        // Accumulate parsed features across tiles, keyed by layer kind.
        const acc = { water: [], waterway: [], road: [], building: [] };

        let done = 0;
        let tilesOk = 0;
        await Promise.all(this.zpCovered.map(async (zoompos) => {
            const tile = await Fetch.fetchTile(
                zoompos, 'mapbox-streets-vector', this.token, this.isNode);
            done++;
            onProgress(`矢量瓦片 ${done}/${this.zpCovered.length}`);
            if (!tile) return;
            tilesOk++;
            this._collect(tile, zoompos, sel, acc);
        }));

        if (sel.water) {
            this._addWater(group, acc.water);
            this._addWaterways(group, acc.waterway);
        }
        if (sel.road) this._addRoads(group, acc.road);
        if (sel.building) this._addBuildings(group, acc.building);

        // Per-layer data-availability report for the UI.
        const counts = {
            water: acc.water.length,
            waterway: acc.waterway.length,
            road: acc.road.length,
            building: acc.building.length,
        };
        const empty = [];
        if (sel.water && counts.water === 0 && counts.waterway === 0) empty.push('water');
        if (sel.road && counts.road === 0) empty.push('road');
        if (sel.building && counts.building === 0) empty.push('building');

        group.userData.report = {
            counts,
            tilesOk,
            tilesTotal: this.zpCovered.length,
            featureZoom: this.zpCovered.length ? this.zpCovered[0][0] : null,
            empty,
        };
        return group;
    }

    _collect(tile, zoompos, sel, acc) {
        const [z, x, y] = zoompos;
        const readLayer = (name, kind) => {
            const layer = tile.layers[name];
            if (!layer) return;
            for (let i = 0; i < layer.length; i++) {
                const feat = layer.feature(i).toGeoJSON(x, y, z);
                acc[kind].push(feat);
            }
        };
        if (sel.water) { readLayer('water', 'water'); readLayer('waterway', 'waterway'); }
        if (sel.road) readLayer('road', 'road');
        if (sel.building) readLayer('building', 'building');
    }

    // ---- geometry helpers -------------------------------------------------

    // Flatten a GeoJSON geometry into an array of polygon rings (each ring is
    // an array of [lng,lat]). Only outer rings are returned (holes ignored for
    // simplicity of draped water/building footprints).
    static _polygons(geom) {
        if (geom.type === 'Polygon') return [geom.coordinates];
        if (geom.type === 'MultiPolygon') return geom.coordinates;
        return [];
    }
    static _lines(geom) {
        if (geom.type === 'LineString') return [geom.coordinates];
        if (geom.type === 'MultiLineString') return geom.coordinates;
        return [];
    }

    // ---- water ------------------------------------------------------------

    _addWater(group, feats) {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x2b6fb3, roughness: 0.2, metalness: 0.1,
            transparent: true, opacity: 0.82, side: THREE.DoubleSide,
        });
        const merged = [];
        for (const f of feats) {
            for (const poly of StreetsModel._polygons(f.geometry)) {
                const ring = poly[0];
                if (!ring || ring.length < 3) continue;
                const shape = new THREE.Shape();
                let sx = 0, sy = 0, n = 0;
                ring.forEach(([lng, lat], idx) => {
                    const [px, py] = this._xy(lng, lat);
                    sx += px; sy += py; n++;
                    idx === 0 ? shape.moveTo(px, py) : shape.lineTo(px, py);
                });
                // Water is level: sit the whole polygon at the terrain z of its
                // centroid, lifted a hair to avoid z-fighting with the surface.
                const z = this._z(sx / n, sy / n) + 0.0008;
                const geom = new THREE.ShapeGeometry(shape);
                geom.translate(0, 0, z);
                merged.push(geom);
            }
        }
        if (merged.length) {
            const mesh = new THREE.Mesh(mergeGeometries(merged), mat);
            mesh.name = 'water';
            group.add(mesh);
        }
    }

    _addWaterways(group, feats) {
        const segs = [];
        for (const f of feats) {
            for (const line of StreetsModel._lines(f.geometry)) {
                segs.push(this._ribbon(line, roadWidth(f.properties.class) || 3, 0.0008));
            }
        }
        const geoms = segs.filter(Boolean);
        if (geoms.length) {
            const mesh = new THREE.Mesh(mergeGeometries(geoms),
                new THREE.MeshStandardMaterial({ color: 0x2b6fb3, roughness: 0.3 }));
            mesh.name = 'waterway';
            group.add(mesh);
        }
    }

    // ---- roads ------------------------------------------------------------

    _addRoads(group, feats) {
        const geoms = [];
        for (const f of feats) {
            const w = roadWidth(f.properties.class);
            for (const line of StreetsModel._lines(f.geometry)) {
                const g = this._ribbon(line, w, 0.0012);
                if (g) geoms.push(g);
            }
        }
        if (geoms.length) {
            const mesh = new THREE.Mesh(mergeGeometries(geoms),
                new THREE.MeshStandardMaterial({
                    color: 0x3a3a3a, roughness: 0.9, side: THREE.DoubleSide }));
            mesh.name = 'road';
            group.add(mesh);
        }
    }

    // Build a flat ribbon (triangle strip) of given width (meters) following a
    // polyline, draped vertex-by-vertex onto the terrain.
    _ribbon(lineCoords, widthM, lift) {
        const pts = lineCoords.map(([lng, lat]) => {
            const [x, y] = this._xy(lng, lat);
            return new THREE.Vector3(x, y, this._z(x, y) + lift);
        });
        if (pts.length < 2) return null;
        const halfW = (widthM * this.unitsPerMeter) / 2;

        const positions = [];
        const left = [], right = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const a = pts[Math.max(0, i - 1)];
            const b = pts[Math.min(pts.length - 1, i + 1)];
            // tangent in XY, perpendicular = (-ty, tx)
            let tx = b.x - a.x, ty = b.y - a.y;
            const len = Math.hypot(tx, ty) || 1;
            tx /= len; ty /= len;
            const nx = -ty * halfW, ny = tx * halfW;
            left.push(new THREE.Vector3(p.x + nx, p.y + ny, p.z));
            right.push(new THREE.Vector3(p.x - nx, p.y - ny, p.z));
        }
        for (let i = 0; i < pts.length - 1; i++) {
            const l0 = left[i], r0 = right[i], l1 = left[i + 1], r1 = right[i + 1];
            // two triangles per segment
            positions.push(l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z);
            positions.push(r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, l1.x, l1.y, l1.z);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position',
            new THREE.BufferAttribute(new Float32Array(positions), 3));
        geom.computeVertexNormals();
        return geom;
    }

    // ---- buildings --------------------------------------------------------

    _addBuildings(group, feats) {
        const geoms = [];
        for (const f of feats) {
            const props = f.properties || {};
            const height = (props.height != null ? props.height
                : props.render_height != null ? props.render_height : 6);
            const minH = props.min_height != null ? props.min_height : 0;
            for (const poly of StreetsModel._polygons(f.geometry)) {
                const g = this._extrudeBuilding(poly, height, minH);
                if (g) geoms.push(g);
            }
        }
        if (geoms.length) {
            const mesh = new THREE.Mesh(mergeGeometries(geoms),
                new THREE.MeshStandardMaterial({
                    color: 0xcabfa6, roughness: 0.85, flatShading: true }));
            mesh.name = 'building';
            group.add(mesh);
        }
    }

    _extrudeBuilding(poly, heightM, minHM) {
        const ring = poly[0];
        if (!ring || ring.length < 3) return null;

        const shape = new THREE.Shape();
        let sx = 0, sy = 0, n = 0;
        ring.forEach(([lng, lat], idx) => {
            const [px, py] = this._xy(lng, lat);
            sx += px; sy += py; n++;
            idx === 0 ? shape.moveTo(px, py) : shape.lineTo(px, py);
        });
        // Holes (courtyards)
        for (let h = 1; h < poly.length; h++) {
            const hp = new THREE.Path();
            poly[h].forEach(([lng, lat], idx) => {
                const [px, py] = this._xy(lng, lat);
                idx === 0 ? hp.moveTo(px, py) : hp.lineTo(px, py);
            });
            shape.holes.push(hp);
        }

        const upm = this.unitsPerMeter;
        const depth = Math.max(heightM - minHM, 1) * upm;
        const geom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        // Sit base on terrain at footprint centroid (+ optional min_height).
        const base = this._z(sx / n, sy / n) + minHM * upm;
        geom.translate(0, 0, base);
        return geom;
    }
}

// Minimal BufferGeometry merge (positions + normals), avoids pulling the
// three addon. Inputs may be indexed or non-indexed; all are normalized to
// non-indexed position (+ normal) before concatenation.
export function mergeGeometries(geomsRaw) {
    const geoms = geomsRaw.map((g) => {
        let n = g.index ? g.toNonIndexed() : g;
        if (!n.attributes.normal) n.computeVertexNormals();
        return n;
    });
    let total = 0;
    for (const g of geoms) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    let off = 0;
    for (const g of geoms) {
        pos.set(g.attributes.position.array, off * 3);
        nrm.set(g.attributes.normal.array, off * 3);
        off += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return out;
}
