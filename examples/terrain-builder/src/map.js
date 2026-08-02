// Map-based region picker (China only).
//
// A modal Leaflet map on a Gaode (AutoNavi) raster basemap — which, like the
// DataV administrative boundaries it draws, is in the GCJ-02 datum, so map and
// boundaries align. The user can:
//   - search a province/city/district by Chinese name or pinyin (offline index)
//   - pick one via cascading 省 / 市 / 区县 dropdowns
//   - draw or edit a custom polygon/rectangle to specify an arbitrary area
//
// On 确定 it returns the chosen area as GCJ-02 rings to a callback. If the user
// drew a custom shape it wins; otherwise the selected region's boundary is used.
// Datum conversion to WGS-84 happens in app.js, not here.

import L from 'leaflet';
import 'leaflet-draw';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';

const DATAV = 'https://geo.datav.aliyun.com/areas_v3/bound';
// Gaode raster street tiles (GCJ-02). style=7 -> standard map with labels.
const GAODE = 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}';

export default class MapPicker {
    constructor({ onConfirm } = {}) {
        this.onConfirm = onConfirm || (() => {});
        this.index = null;        // regions-index.json (lazy)
        this.map = null;
        this.regionLayer = null;  // display layer for a selected admin boundary
        this.drawnItems = null;   // editable user shapes (FeatureGroup)
        this.selected = null;     // { name, rings, source }
        this._built = false;
    }

    // ---- lifecycle ---------------------------------------------------------

    async open() {
        this._buildDom();
        this.modal.style.display = 'flex';
        if (!this.map) this._initMap();
        // Leaflet needs a re-measure once the container is visible.
        setTimeout(() => this.map.invalidateSize(), 0);
        if (!this.index) await this._loadIndex();
    }

    close() { if (this.modal) this.modal.style.display = 'none'; }

    // ---- data --------------------------------------------------------------

    // Candidate URLs for the offline admin index, most reliable first.
    //
    // A document-relative path ('./src/...') only works when the page happens
    // to sit one level above src/ — it breaks for deployments that ship just
    // index.html + dist/, or for a page served from a nested/extension-less
    // URL. Resolving against the bundle's own URL (import.meta.url, i.e.
    // .../dist/app.bundle.js) is layout-independent: build.mjs copies the JSON
    // next to the bundle, and ../src/ still covers a raw source checkout.
    static _indexUrls() {
        const urls = [];
        try {
            urls.push(new URL('regions-index.json', import.meta.url).href);
            urls.push(new URL('../src/regions-index.json', import.meta.url).href);
        } catch (_) { /* no import.meta (non-ESM host): fall back below */ }
        urls.push('./src/regions-index.json');
        return urls.filter((u, i, a) => a.indexOf(u) === i);
    }

    async _loadIndex() {
        this._setHint('正在加载行政区索引…');
        const tried = [];
        for (const url of MapPicker._indexUrls()) {
            try {
                const res = await fetch(url);
                if (!res.ok) { tried.push(`${url} → HTTP ${res.status}`); continue; }
                this.index = await res.json();
                this._byAdcode = new Map(this.index.map((e) => [e.adcode, e]));
                this._fillProvinces();
                this._setHint('');
                return;
            } catch (e) {
                tried.push(`${url} → ${e.message}`);
            }
        }
        console.error('[terrain-builder] 行政区索引加载失败：\n' + tried.join('\n'));
        this._setHint(`行政区索引加载失败（已尝试 ${tried.length} 个路径，详见浏览器控制台）`);
    }

    _children(parentAdcode, level) {
        return this.index
            .filter((e) => e.parent === parentAdcode && (!level || e.level === level))
            .sort((a, b) => a.adcode - b.adcode);
    }

    // ---- DOM ---------------------------------------------------------------

    _buildDom() {
        if (this._built) return;
        this.modal = document.getElementById('map-modal');
        this.search = document.getElementById('map-search');
        this.searchList = document.getElementById('map-search-list');
        this.selProv = document.getElementById('map-prov');
        this.selCity = document.getElementById('map-city');
        this.selDist = document.getElementById('map-dist');
        this.hintEl = document.getElementById('map-hint');
        this.pickedEl = document.getElementById('map-picked');

        document.getElementById('map-close').addEventListener('click', () => this.close());
        document.getElementById('map-cancel').addEventListener('click', () => this.close());
        document.getElementById('map-confirm').addEventListener('click', () => this._confirm());
        this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });

        // search-as-you-type over name / pinyin / initials
        this.search.addEventListener('input', () => this._onSearch());
        this.search.addEventListener('focus', () => this._onSearch());
        document.addEventListener('click', (e) => {
            if (!this.searchList.contains(e.target) && e.target !== this.search) {
                this.searchList.style.display = 'none';
            }
        });

        this.selProv.addEventListener('change', () => this._onProv());
        this.selCity.addEventListener('change', () => this._onCity());
        this.selDist.addEventListener('change', () => this._onDist());

        this._built = true;
    }

    _setHint(msg) { if (this.hintEl) this.hintEl.textContent = msg || ''; }

    // ---- map ---------------------------------------------------------------

    // Work around leaflet-draw's buggy readableArea() (references an undeclared
    // `type`, throwing "ReferenceError: type is not defined"). Replace it with a
    // safe implementation so a stray call can't throw even though we also
    // disable showArea.
    static _patchLeafletDrawArea() {
        if (MapPicker._areaPatched) return;
        MapPicker._areaPatched = true;
        try {
            const GU = L.GeometryUtil;
            if (GU && typeof GU.readableArea === 'function') {
                GU.readableArea = function (area, isMetric, precision) {
                    const p = L.Util.extend({}, { km: 2, ha: 2, m: 0 }, precision);
                    let out;
                    if (isMetric) {
                        if (area >= 1000000) out = (area / 1000000).toFixed(p.km) + ' km²';
                        else if (area >= 10000) out = (area / 10000).toFixed(p.ha) + ' ha';
                        else out = area.toFixed(p.m) + ' m²';
                    } else {
                        area /= 0.836127;
                        if (area >= 3097600) out = (area / 3097600).toFixed(p.km) + ' mi²';
                        else if (area >= 4840) out = (area / 4840).toFixed(p.ha) + ' acres';
                        else out = Math.ceil(area).toFixed(p.m) + ' yd²';
                    }
                    return out;
                };
            }
        } catch (_) { /* non-fatal: showArea is already disabled */ }
    }

    _initMap() {
        this.map = L.map('map-canvas', { center: [35, 105], zoom: 4, zoomControl: true });
        L.tileLayer(GAODE, { subdomains: '1234', maxZoom: 18, attribution: '© 高德地图' })
            .addTo(this.map);

        this.drawnItems = new L.FeatureGroup().addTo(this.map);
        // leaflet-draw's readableArea() has a long-standing bug: it references
        // an undeclared `type` variable, throwing "ReferenceError: type is not
        // defined" on every mouse-move while drawing a polygon with showArea.
        // We don't need the live area tooltip (area is recomputed on confirm),
        // so disable showArea — and patch readableArea defensively in case any
        // internal path still calls it.
        MapPicker._patchLeafletDrawArea();
        const drawControl = new L.Control.Draw({
            position: 'topright',
            edit: { featureGroup: this.drawnItems, remove: true },
            draw: {
                polygon: { allowIntersection: false, showArea: false,
                    shapeOptions: { color: '#3b9dff' } },
                rectangle: { showArea: false, shapeOptions: { color: '#3b9dff' } },
                polyline: false, circle: false, marker: false, circlemarker: false,
            },
        });
        this.map.addControl(drawControl);

        this.map.on(L.Draw.Event.CREATED, (e) => {
            this.drawnItems.clearLayers();
            this.drawnItems.addLayer(e.layer);
            this._useCustom();
        });
        this.map.on(L.Draw.Event.EDITED, () => this._useCustom());
        this.map.on(L.Draw.Event.DELETED, () => {
            if (this.drawnItems.getLayers().length === 0) this._revertToRegion();
        });
    }

    // ---- selection: search box --------------------------------------------

    _onSearch() {
        if (!this.index) return;
        const q = this.search.value.trim().toLowerCase();
        if (!q) { this.searchList.style.display = 'none'; return; }
        const hits = [];
        for (const e of this.index) {
            if (e.name.includes(q) || e.pinyin.includes(q) || e.py.includes(q)) {
                hits.push(e);
                if (hits.length >= 30) break;
            }
        }
        if (!hits.length) {
            this.searchList.innerHTML = '<div class="ms-empty">无匹配</div>';
        } else {
            const LV = { province: '省', city: '市', district: '区县' };
            this.searchList.innerHTML = hits.map((e) =>
                `<div class="ms-item" data-ad="${e.adcode}">${e.name}` +
                `<span class="ms-lv">${LV[e.level] || ''}</span></div>`).join('');
            this.searchList.querySelectorAll('.ms-item').forEach((el) => {
                el.addEventListener('click', () => {
                    this.searchList.style.display = 'none';
                    this.search.value = '';
                    this._selectAdcode(parseInt(el.dataset.ad, 10), true);
                });
            });
        }
        this.searchList.style.display = 'block';
    }

    // ---- selection: cascading dropdowns -----------------------------------

    _fillProvinces() {
        this._fillSelect(this.selProv, this._children(100000), '选择省 / 直辖市');
        this._resetSelect(this.selCity, '市');
        this._resetSelect(this.selDist, '区县');
    }

    _fillSelect(sel, items, placeholder) {
        sel.innerHTML = `<option value="">${placeholder}</option>` +
            items.map((e) => `<option value="${e.adcode}">${e.name}</option>`).join('');
        sel.disabled = items.length === 0;
    }

    _resetSelect(sel, placeholder) {
        sel.innerHTML = `<option value="">${placeholder}</option>`;
        sel.disabled = true;
    }

    _onProv() {
        const ad = parseInt(this.selProv.value, 10);
        this._resetSelect(this.selDist, '区县');
        if (!ad) { this._resetSelect(this.selCity, '市'); return; }
        this._fillSelect(this.selCity, this._children(ad), '选择市');
        this._selectAdcode(ad, true);
    }

    _onCity() {
        const ad = parseInt(this.selCity.value, 10);
        if (!ad) { this._resetSelect(this.selDist, '区县'); return; }
        this._fillSelect(this.selDist, this._children(ad), '选择区县');
        this._selectAdcode(ad, true);
    }

    _onDist() {
        const ad = parseInt(this.selDist.value, 10);
        if (ad) this._selectAdcode(ad, true);
    }

    // Sync dropdowns to reflect a region picked via search.
    _syncDropdowns(entry) {
        const chain = [];
        let cur = entry;
        while (cur && cur.adcode !== 100000) {
            chain.unshift(cur);
            cur = this._byAdcode.get(cur.parent);
        }
        // chain is [province?, city?, district?]
        const prov = chain.find((e) => e.level === 'province');
        const city = chain.find((e) => e.level === 'city');
        const dist = chain.find((e) => e.level === 'district');
        if (prov) {
            this.selProv.value = String(prov.adcode);
            this._fillSelect(this.selCity, this._children(prov.adcode), '选择市');
        }
        if (city) {
            this.selCity.value = String(city.adcode);
            this._fillSelect(this.selDist, this._children(city.adcode), '选择区县');
        } else {
            this._resetSelect(this.selDist, '区县');
        }
        if (dist) this.selDist.value = String(dist.adcode);
    }

    // ---- boundary fetch + draw --------------------------------------------

    async _selectAdcode(adcode, syncDropdowns) {
        const entry = this._byAdcode.get(adcode);
        if (!entry) return;
        if (syncDropdowns) this._syncDropdowns(entry);
        this._setHint(`正在加载「${entry.name}」边界…`);
        try {
            // DataV hotlink-protects this endpoint: any Referer other than
            // *.aliyun.com gets a 403, while a request with no Referer at all
            // is served normally (and CORS is already `*`). Suppressing the
            // header is therefore what makes it usable from a third-party
            // origin such as GitHub Pages.
            const res = await fetch(`${DATAV}/${adcode}.json`, { referrerPolicy: 'no-referrer' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const gj = await res.json();
            const rings = this._geometryToRings(gj.features[0].geometry);
            this._drawRegion(entry.name, rings);
            this._setHint('');
        } catch (e) {
            this._setHint(`「${entry.name}」边界加载失败：${e.message}`);
        }
    }

    // GeoJSON Polygon|MultiPolygon -> array of outer rings ([[lng,lat],...]).
    _geometryToRings(geom) {
        if (!geom) return [];
        if (geom.type === 'Polygon') return [geom.coordinates[0]];
        if (geom.type === 'MultiPolygon') return geom.coordinates.map((poly) => poly[0]);
        return [];
    }

    _drawRegion(name, rings) {
        if (this.regionLayer) this.map.removeLayer(this.regionLayer);
        // clear any custom shape — picking a region resets to that region
        this.drawnItems.clearLayers();
        const latlngs = rings.map((r) => r.map(([lng, lat]) => [lat, lng]));
        this.regionLayer = L.polygon(latlngs, {
            color: '#4ad295', weight: 2, fillColor: '#4ad295', fillOpacity: 0.12,
        }).addTo(this.map);
        this.map.fitBounds(this.regionLayer.getBounds(), { padding: [24, 24] });
        this.selected = { name, rings, source: 'region' };
        this._showPicked();
    }

    // ---- custom-shape overrides -------------------------------------------

    _layerToRings(layer) {
        // L.Polygon.getLatLngs() -> [ring] or [[ring],...]; normalize to rings.
        let latlngsArr = layer.getLatLngs();
        if (latlngsArr.length && Array.isArray(latlngsArr[0]) &&
            latlngsArr[0].length && Array.isArray(latlngsArr[0][0])) {
            // multipolygon
            return latlngsArr.map((poly) => poly[0].map((p) => [p.lng, p.lat]));
        }
        if (latlngsArr.length && latlngsArr[0] instanceof L.LatLng) {
            return [latlngsArr.map((p) => [p.lng, p.lat])];
        }
        // [[LatLng,...]]
        return latlngsArr.map((ring) => ring.map((p) => [p.lng, p.lat]));
    }

    _useCustom() {
        const layers = this.drawnItems.getLayers();
        if (!layers.length) return;
        const rings = [];
        layers.forEach((ly) => rings.push(...this._layerToRings(ly)));
        if (this.regionLayer) { this.regionLayer.setStyle({ opacity: 0.4, fillOpacity: 0.04 }); }
        this.selected = { name: '自定义多边形', rings, source: 'custom' };
        this._showPicked();
    }

    _revertToRegion() {
        if (this.regionLayer && this.selected && this.selected.source === 'custom') {
            this.regionLayer.setStyle({ opacity: 1, fillOpacity: 0.12 });
        }
        if (this.regionLayer) {
            const latlngs = this.regionLayer.getLatLngs();
            const rings = latlngs.map((ring) => (Array.isArray(ring[0])
                ? ring[0].map((p) => [p.lng, p.lat])
                : ring.map((p) => [p.lng, p.lat])));
            const name = this.selected ? this.selected.name : '所选区域';
            this.selected = { name, rings, source: 'region' };
            this._showPicked();
        }
    }

    _showPicked() {
        if (!this.pickedEl) return;
        if (!this.selected) { this.pickedEl.textContent = ''; return; }
        const n = this.selected.rings.reduce((s, r) => s + r.length, 0);
        const tag = this.selected.source === 'custom' ? '（手绘）' : '（行政区边界）';
        this.pickedEl.textContent = `已选：${this.selected.name} ${tag} · ${n} 个顶点`;
        document.getElementById('map-confirm').disabled = false;
    }

    _confirm() {
        if (!this.selected || !this.selected.rings.length) {
            this._setHint('请先选择区域或绘制多边形。');
            return;
        }
        this.onConfirm(this.selected);
        this.close();
    }
}
