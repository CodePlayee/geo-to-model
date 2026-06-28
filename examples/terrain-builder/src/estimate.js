// Pre-build data-volume estimator.
//
// Given origin/radius/zoom/features, computes the EXACT number of tiles that
// will be fetched (satellite, RGB-DEM, and Streets vector) and estimates the
// downloaded byte volume from measured per-tile averages. Tile counts are
// exact; byte sizes are estimates (real tiles vary by terrain/urban density).

import ThreeGeo from '../../../src/index.js';
import Fetch from '../../../src/models/fetch.js';

// Measured average compressed sizes (bytes) per tile type, @2x where relevant.
// Derived from sampling alpine + urban + ocean tiles; intentionally a bit
// generous so the estimate trends slightly high rather than low.
const AVG = {
    satellite: 90 * 1024,   // satellite-v9 jpg @ 512px
    rgbDem: 180 * 1024,     // terrain-rgb png @2x
    vector: 28 * 1024,      // mapbox-streets-v8 pbf (gzipped)
};

/**
 * @param {[number,number]} origin  [lat, lng]
 * @param {number} radius           km
 * @param {number} zoom             terrain zoom (satellite level)
 * @param {{terrain:boolean,water:boolean,road:boolean,building:boolean}} sel
 * @returns {{
 *   tiles: { satellite:number, rgbDem:number, vector:number, total:number },
 *   bytes: { satellite:number, rgbDem:number, vector:number, total:number },
 *   featureZoom: number|null,
 * }}
 */
export function estimate(origin, radius, zoom, sel) {
    const bbox = ThreeGeo.getBbox(origin, radius);

    let satTiles = 0, demTiles = 0, vecTiles = 0;
    let featureZoom = null;

    const needTerrain = sel.terrain;
    const needFeatures = sel.water || sel.road || sel.building;

    if (needTerrain) {
        const zpCovered = ThreeGeo.getZoomposCovered(bbox.feature, zoom);
        satTiles = zpCovered.length;
        demTiles = Fetch.getZoomposEle(zpCovered).length;
    }

    if (needFeatures) {
        featureZoom = Math.max(zoom, 14);
        const zpFeat = ThreeGeo.getZoomposCovered(bbox.feature, featureZoom);
        vecTiles = zpFeat.length;
    }

    const bSat = satTiles * AVG.satellite;
    const bDem = demTiles * AVG.rgbDem;
    const bVec = vecTiles * AVG.vector;

    const tilesTotal = satTiles + demTiles + vecTiles;
    return {
        tiles: { satellite: satTiles, rgbDem: demTiles, vector: vecTiles, total: tilesTotal },
        bytes: { satellite: bSat, rgbDem: bDem, vector: bVec, total: bSat + bDem + bVec },
        featureZoom,
    };
}

/** Human-readable byte size. */
export function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

export default estimate;
