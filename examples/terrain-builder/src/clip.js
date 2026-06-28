// Clip generated meshes to a region boundary.
//
// The terrain pipeline always fetches a square (center + radius) area. When the
// user picked an administrative region (or drew a polygon), we trim the result
// to that boundary so the exported model matches the requested shape.
//
// Both the terrain mesh vertices and the boundary are brought into the same
// terrain XY space (via three-geo's `proj`), then each triangle is kept or
// dropped by an inside test on its centroid. Triangle granularity means the cut
// edge is stair-stepped at mesh resolution — finer at higher zoom. Buildings
// that straddle the boundary may be cut mid-volume; this is acceptable for a
// best-effort region trim and is documented in the UI/README.

import * as THREE from 'three';

// Ray-casting point-in-polygon for a single ring of [x,y] points.
function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const hit = (yi > y) !== (yj > y) &&
            x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (hit) inside = !inside;
    }
    return inside;
}

// A region is a set of disjoint outer rings (MultiPolygon). A point belongs to
// the region if it lies inside any one of them.
function inRegion(x, y, ringsXY) {
    for (let k = 0; k < ringsXY.length; k++) {
        if (inRing(x, y, ringsXY[k])) return true;
    }
    return false;
}

// Project WGS-84 boundary rings ([lng,lat]) into terrain XY space using the
// three-geo projection (which takes [lat,lng]).
export function projectRings(ringsLngLat, proj) {
    return ringsLngLat.map((ring) =>
        ring.map(([lng, lat]) => {
            const p = proj([lat, lng]);
            return [p[0], p[1]];
        }));
}

// Axis-aligned bounds of the projected rings (fast reject before ray-casting).
function ringsBounds(ringsXY) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of ringsXY) {
        for (const [x, y] of ring) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    }
    return { minX, minY, maxX, maxY };
}

// Clip one mesh's geometry to the projected region; returns a new non-indexed
// BufferGeometry of the kept triangles, or null if nothing remains.
function clipGeometry(geom, ringsXY, bounds) {
    const src = geom.index ? geom.toNonIndexed() : geom;
    const pos = src.attributes.position;
    const nrm = src.attributes.normal;
    const uv = src.attributes.uv;
    const col = src.attributes.color;
    const triCount = pos.count / 3;

    const outPos = [], outNrm = uv ? null : [], outUv = uv ? [] : null;
    const arrPos = [], arrNrm = nrm ? [] : null, arrUv = uv ? [] : null, arrCol = col ? [] : null;

    const keepVert = (i) => {
        arrPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (arrNrm) arrNrm.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        if (arrUv) arrUv.push(uv.getX(i), uv.getY(i));
        if (arrCol) arrCol.push(col.getX(i), col.getY(i), col.getZ(i));
    };

    for (let t = 0; t < triCount; t++) {
        const a = t * 3, b = a + 1, c = a + 2;
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
        const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY) continue;
        if (!inRegion(cx, cy, ringsXY)) continue;
        keepVert(a); keepVert(b); keepVert(c);
    }

    if (arrPos.length === 0) return null;

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(arrPos, 3));
    if (arrNrm) out.setAttribute('normal', new THREE.Float32BufferAttribute(arrNrm, 3));
    if (arrUv) out.setAttribute('uv', new THREE.Float32BufferAttribute(arrUv, 2));
    if (arrCol) out.setAttribute('color', new THREE.Float32BufferAttribute(arrCol, 3));
    if (!arrNrm) out.computeVertexNormals();
    return out;
}

/**
 * Clip every mesh under `root` to a WGS-84 boundary.
 *
 * @param {THREE.Object3D} root     terrain + feature group (mutated in place)
 * @param {number[][][]} ringsLngLat  region rings, each [[lng,lat],...] (WGS-84)
 * @param {(latlng:number[])=>number[]} proj  three-geo projection
 * @returns {{ kept:number, dropped:number, trisBefore:number, trisAfter:number }}
 */
export function clipToRegion(root, ringsLngLat, proj) {
    const ringsXY = projectRings(ringsLngLat, proj);
    const bounds = ringsBounds(ringsXY);

    const toRemove = [];
    let kept = 0, dropped = 0, trisBefore = 0, trisAfter = 0;

    root.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
        const srcTris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
        trisBefore += srcTris;
        const clipped = clipGeometry(o.geometry, ringsXY, bounds);
        if (!clipped) { toRemove.push(o); dropped++; return; }
        trisAfter += clipped.attributes.position.count / 3;
        o.geometry.dispose();
        o.geometry = clipped;
        kept++;
    });

    toRemove.forEach((o) => {
        if (o.parent) o.parent.remove(o);
        if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
    });

    return { kept, dropped, trisBefore: Math.round(trisBefore), trisAfter: Math.round(trisAfter) };
}

export default clipToRegion;
