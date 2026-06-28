// GCJ-02 <-> WGS-84 datum transform (no dependencies).
//
// China publishes map data (and the DataV administrative boundaries used by
// this app) in the GCJ-02 "Mars" datum — an obfuscated offset of true WGS-84.
// Gaode/AutoNavi raster basemap tiles are also GCJ-02, so the 2D map and the
// boundaries line up there. The three-geo / Mapbox terrain pipeline, however,
// is plain WGS-84, so a selected region must be converted GCJ-02 -> WGS-84
// before it drives terrain generation, or the 3D terrain lands ~hundreds of
// meters off the boundary.
//
// The forward transform is the well-known published approximation; the inverse
// is an iterative refinement (the forward map has no closed-form inverse). Both
// are accurate to well under a meter, far below tile resolution.

const PI = Math.PI;
const A = 6378245.0;            // Krasovsky 1940 semi-major axis (m)
const EE = 0.00669342162296594323; // eccentricity^2

// Points outside the rough China bounding box are returned unchanged: GCJ-02
// only offsets coordinates inside mainland China (Hong Kong/Macau/Taiwan and
// everything abroad are effectively WGS-84 on these tiles).
function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y +
        0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x +
        0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
}

// The (dLat, dLng) offset added to a WGS-84 point to obtain its GCJ-02 image.
function delta(wgsLng, wgsLat) {
    let dLat = transformLat(wgsLng - 105.0, wgsLat - 35.0);
    let dLng = transformLng(wgsLng - 105.0, wgsLat - 35.0);
    const radLat = wgsLat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [dLng, dLat];
}

/** WGS-84 [lng, lat] -> GCJ-02 [lng, lat]. */
export function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    const [dLng, dLat] = delta(lng, lat);
    return [lng + dLng, lat + dLat];
}

/**
 * GCJ-02 [lng, lat] -> WGS-84 [lng, lat].
 * Iteratively inverts the forward transform; ~4 iterations reach sub-mm.
 */
export function gcj02ToWgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let wgsLng = lng, wgsLat = lat;
    for (let i = 0; i < 6; i++) {
        const [gLng, gLat] = wgs84ToGcj02(wgsLng, wgsLat);
        wgsLng += lng - gLng;
        wgsLat += lat - gLat;
    }
    return [wgsLng, wgsLat];
}

/** Convert a ring/array of GCJ-02 [lng,lat] pairs to WGS-84 (new array). */
export function ringGcj02ToWgs84(ring) {
    return ring.map(([lng, lat]) => gcj02ToWgs84(lng, lat));
}

export default { wgs84ToGcj02, gcj02ToWgs84, ringGcj02ToWgs84, outOfChina };
