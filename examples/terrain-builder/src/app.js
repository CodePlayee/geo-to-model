// terrain-builder main application.
//
// Wires together: coordinate parsing, three-geo terrain (RGB), Streets v8
// feature layers (water/road/building), an OrbitControls viewer, and multi-
// format model export.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ThreeGeo from '../../../src/index.js';
import Fetch from '../../../src/models/fetch.js';
import { parseCoords, formatCoords } from './coords.js';
import StreetsModel from './streets.js';
import { exportModel, buildExport } from './exporter.js';
import { estimate, fmtBytes } from './estimate.js';
import MapPicker from './map.js';
import { ringGcj02ToWgs84 } from './gcj02.js';
import { clipToRegion } from './clip.js';
import LoadingGrid from './loading-grid.js';

// The Mapbox access token is normally supplied by the user at runtime and
// persisted in localStorage — it is never hard-coded or committed. A public
// `pk.` token is safe to keep client-side (it is exposed to the browser by
// design); restrict it by URL in your Mapbox account if you want to limit
// where it can be used. A deployment may also bake in its own default by
// building with MAPBOX_TOKEN set (see build.mjs); a token entered by the user
// still takes precedence.
const TOKEN_KEY = 'tb.mapboxToken';
const BUILTIN_TOKEN = (__MAPBOX_TOKEN__ || '').trim();
const getStoredToken = () => {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim() || BUILTIN_TOKEN; }
    catch (_) { return BUILTIN_TOKEN; }
};
const storeToken = (t) => {
    try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch (_) { /* private mode */ }
};
const clearStoredToken = () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
};

const $ = (sel) => document.querySelector(sel);

class App {
    constructor() {
        THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);

        this.canvas = $('#viewer');
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b0f14);

        this.camera = new THREE.PerspectiveCamera(60, 1, 0.001, 1000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(0, -1.2, 1.0);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        this._initLights();
        this._initHelpers();

        // Token-driven setup: build the three-geo client only once we have a
        // token. Without one, the app still loads (map picker, UI) but building
        // is gated behind entering a token.
        this.token = getStoredToken();
        this.tgeo = this.token ? new ThreeGeo({ tokenMapbox: this.token }) : null;
        // Cap simultaneous tile requests. Firing thousands at once (large area
        // * high zoom) makes the browser/Mapbox close connections en masse
        // (ERR_CONNECTION_CLOSED). 6 keeps the pipeline busy without overload.
        Fetch.maxConcurrent = 6;
        this.model = null;       // current THREE.Group (terrain + features)

        this._bindUI();
        this._resize();
        window.addEventListener('resize', () => this._resize());
        this._animate();
    }

    _initLights() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
        const sun = new THREE.DirectionalLight(0xffffff, 2.0);
        sun.position.set(1, -1, 2);
        this.scene.add(sun);
        const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
        fill.position.set(-1, 1, 0.5);
        this.scene.add(fill);
    }

    _initHelpers() {
        this.grid = new THREE.GridHelper(2, 20, 0x224466, 0x162635);
        this.grid.rotation.x = Math.PI / 2; // grid in XY plane (z up)
        this.scene.add(this.grid);
        this.axes = new THREE.AxesHelper(0.6);
        this.scene.add(this.axes);
        // Rippling grid shown while data downloads (see loading-grid.js).
        this.loadingGrid = new LoadingGrid();
        this.scene.add(this.loadingGrid.object);
        this.clock = new THREE.Clock();
    }

    _bindUI() {
        // Mapbox token panel: prompt on first run, persist, allow changing.
        $('#btn-token-save').addEventListener('click', () => this._saveToken());
        $('#token-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._saveToken();
        });
        $('#btn-token-change').addEventListener('click', () => this._showTokenPanel());
        this._refreshTokenUI();

        $('#btn-build').addEventListener('click', () => this.build());
        $('#btn-export').addEventListener('click', () => this.doExport());
        $('#coords').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.build();
        });
        // live coordinate preview
        $('#coords').addEventListener('input', () => { this._previewCoords(); this._updateEstimate(); });
        this._previewCoords();

        // live zoom-vs-feature hint + data-volume estimate (before building)
        const refresh = () => { this._featureHint(); this._updateEstimate(); };
        $('#zoom').addEventListener('input', refresh);
        $('#radius').addEventListener('input', refresh);
        ['f-terrain', 'f-water', 'f-road', 'f-building'].forEach((id) =>
            $('#' + id).addEventListener('change', refresh));
        refresh();

        // export format change -> measure actual file size of that format
        $('#export-format').addEventListener('change', () => this._updateExportSize());

        // map-based region picker (China)
        this._regionPoly = null; // WGS-84 rings of the active region (for clip)
        this._mapPicker = new MapPicker({
            onConfirm: (sel) => this._onRegionConfirm(sel),
        });
        $('#btn-map').addEventListener('click', () => this._mapPicker.open());
        // typing coordinates by hand clears any map-selected region
        $('#coords').addEventListener('input', () => {
            if (this._regionPoly && !this._suppressRegionClear) this._clearRegion();
        });
    }

    // A region was confirmed in the map modal. `sel.rings` are GCJ-02 [lng,lat]
    // outer rings (admin boundary or a hand-drawn polygon). Convert to WGS-84,
    // fill the center/radius inputs (the fetch pipeline stays center+radius
    // driven), and stash the WGS-84 polygon for post-build clipping.
    _onRegionConfirm(sel) {
        const ringsWgs = sel.rings.map((r) => ringGcj02ToWgs84(r));
        this._regionPoly = ringsWgs;

        // Bounding box over all rings (WGS-84).
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        for (const ring of ringsWgs) {
            for (const [lng, lat] of ring) {
                if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
                if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
            }
        }
        const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;

        // Enclosing radius (km): three-geo's radius is half the bbox diagonal,
        // since originRadiusToBbox builds a square of side radius*sqrt(2).
        // Half-extents in km (lng scaled by cos(lat)).
        const kmPerDegLat = 111.32;
        const halfH = (maxLat - cLat) * kmPerDegLat;
        const halfW = (maxLng - cLng) * kmPerDegLat * Math.cos(cLat * Math.PI / 180);
        const radius = Math.max(0.5, Math.sqrt(halfW * halfW + halfH * halfH));

        // Write inputs without triggering the "manual edit clears region" path.
        this._suppressRegionClear = true;
        $('#coords').value = `${cLat.toFixed(6)}, ${cLng.toFixed(6)}`;
        $('#radius').value = radius.toFixed(1);
        this._suppressRegionClear = false;

        $('#clip-row').style.display = 'flex';
        $('#clip-row').classList.toggle('on', $('#f-clip').checked);
        const tag = $('#region-tag');
        tag.style.display = 'block';
        const src = sel.source === 'custom' ? '手绘多边形' : '行政区边界';
        tag.textContent = `📍 已选区域：${sel.name}（${src}）— 中心/半径已自动填入`;

        this._previewCoords();
        this._featureHint();
        this._updateEstimate();
    }

    _clearRegion() {
        this._regionPoly = null;
        $('#region-tag').style.display = 'none';
        $('#clip-row').style.display = 'none';
    }

    // ---- Mapbox token -----------------------------------------------------

    // Reflect current token state in the UI: show the input panel when no token
    // is stored, otherwise show a compact "token set" row with a change button.
    _refreshTokenUI() {
        const has = !!this.token;
        $('#token-panel').style.display = has ? 'none' : 'block';
        $('#token-set').style.display = has ? 'flex' : 'none';
        $('#btn-build').disabled = !has;
        if (has) {
            const t = this.token;
            const masked = t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t;
            $('#token-set-label').textContent = `Mapbox Token：${masked}`;
        }
    }

    _showTokenPanel(msg) {
        $('#token-panel').style.display = 'block';
        $('#token-set').style.display = 'none';
        $('#token-input').value = this.token || '';
        $('#token-msg').textContent = msg || '';
        $('#token-input').focus();
    }

    _saveToken() {
        const t = $('#token-input').value.trim();
        if (!t) { $('#token-msg').textContent = '请输入 Token。'; return; }
        if (!/^(pk|sk)\./.test(t)) {
            $('#token-msg').textContent = 'Token 应以 pk. 或 sk. 开头，请检查。';
            return;
        }
        this.token = t;
        storeToken(t);
        // (Re)create the three-geo client with the new token.
        this.tgeo = new ThreeGeo({ tokenMapbox: t });
        this._exportCache = {};
        this._refreshTokenUI();
        this.setStatus('✓ Token 已保存（存于本机 localStorage，下次无需再输入）。');
    }

    _forgetToken() {
        clearStoredToken();
        this.token = '';
        this.tgeo = null;
        this._refreshTokenUI();
        this._showTokenPanel('已清除本机保存的 Token。');
    }

    // Estimate tile count + download volume from current inputs (exact tile
    // counts, approximate bytes). Shown before the user commits to building.
    _updateEstimate() {
        const el = $('#estimate');
        let origin, radius, zoom;
        try {
            origin = parseCoords($('#coords').value);
            radius = parseFloat($('#radius').value);
            zoom = parseInt($('#zoom').value, 10);
            if (!(radius > 0) || !Number.isFinite(zoom)) throw 0;
        } catch (_) { el.style.display = 'none'; return; }

        const sel = {
            terrain: $('#f-terrain').checked, water: $('#f-water').checked,
            road: $('#f-road').checked, building: $('#f-building').checked,
        };
        if (!sel.terrain && !sel.water && !sel.road && !sel.building) {
            el.style.display = 'none'; return;
        }

        const est = estimate(origin, radius, zoom, sel);
        this._estTiles = est.tiles.total; // denominator for progress
        const parts = [];
        if (est.tiles.satellite) parts.push(`卫星 ${est.tiles.satellite}`);
        if (est.tiles.rgbDem) parts.push(`高程 ${est.tiles.rgbDem}`);
        if (est.tiles.vector) parts.push(`矢量 ${est.tiles.vector}`);
        el.style.display = 'block';
        el.innerHTML =
            `<span class="est-vol">预计下载 ≈ ${fmtBytes(est.bytes.total)}</span>` +
            `<span class="est-tiles">${est.tiles.total} 个瓦片（${parts.join(' · ')}）</span>`;
    }

    // Pre-emptive hint about known data-coverage limits, shown before building.
    _featureHint() {
        const zoom = parseInt($('#zoom').value, 10);
        const msgs = [];
        // Buildings have minzoom 13 in Mapbox Streets v8; the app uses feature
        // zoom = max(zoom, 14), so checked buildings are always fetched at >=14.
        // The real risk is a region simply not being mapped — noted post-build.
        if ($('#f-building').checked && zoom < 13) {
            msgs.push('建筑要素会以缩放级别 14 抓取（低于 13 的地形级别无建筑数据）。');
        }
        if (Number.isFinite(zoom) && (zoom < 11 || zoom > 17)) {
            msgs.push('地形缩放级别建议在 11–17 之间。');
        }
        const el = $('#feature-hint');
        if (msgs.length) {
            el.style.display = 'block';
            el.textContent = 'ℹ ' + msgs.join(' ');
        } else {
            el.style.display = 'none';
        }
    }

    _previewCoords() {
        const el = $('#coord-preview');
        try {
            const ll = parseCoords($('#coords').value);
            el.textContent = '✓ ' + formatCoords(ll);
            el.className = 'hint ok';
        } catch (e) {
            el.textContent = '· ' + e.message;
            el.className = 'hint err';
        }
    }

    setStatus(msg, busy = false) {
        $('#status').textContent = msg;
        $('#btn-build').disabled = busy;
        $('#spinner').style.display = busy ? 'inline-block' : 'none';
    }

    // Progress bar (0..1). Pass null to hide.
    setProgress(frac, label) {
        const wrap = $('#progress');
        if (frac == null) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'block';
        const pct = Math.max(0, Math.min(1, frac)) * 100;
        $('#progress-bar').style.width = pct.toFixed(1) + '%';
        $('#progress-label').textContent = label || `${pct.toFixed(0)}%`;
        this.loadingGrid.setProgress(frac);
    }

    // Show the loading grid filling the current view: centered on the orbit
    // target and sized from the camera distance, so it is visible whatever
    // scale the previous model left the camera at. The static helpers are
    // hidden meanwhile to keep the animation legible.
    _startLoadingGrid() {
        const dist = this.camera.position.distanceTo(this.controls.target);
        const visibleH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        this.loadingGrid.start(this.controls.target, visibleH * 0.6);
        this.grid.visible = false;
        this.axes.visible = false;
    }

    _stopLoadingGrid() {
        this.loadingGrid.finish();
        this.grid.visible = true;
        this.axes.visible = true;
    }

    // Render a list of data-availability warnings (empty list clears the panel).
    setWarnings(list) {
        const el = $('#warnings');
        if (!list || !list.length) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        el.style.display = 'block';
        el.innerHTML = '<div class="warn-title">⚠ 数据提示</div>' +
            list.map((w) => `<div class="warn-item">· ${w}</div>`).join('');
    }

    async build() {
        // Require a Mapbox token before any fetching.
        if (!this.token || !this.tgeo) {
            this._showTokenPanel('请先填写 Mapbox Access Token 才能生成。');
            return;
        }
        let origin, radius, zoom, sel;
        try {
            origin = parseCoords($('#coords').value);
            radius = parseFloat($('#radius').value);
            zoom = parseInt($('#zoom').value, 10);
            if (!(radius > 0)) throw new Error('范围必须为正数 (km)');
            sel = {
                terrain: $('#f-terrain').checked,
                water: $('#f-water').checked,
                road: $('#f-road').checked,
                building: $('#f-building').checked,
            };
            if (!sel.terrain && !sel.water && !sel.road && !sel.building) {
                throw new Error('请至少勾选一个要素');
            }
        } catch (e) {
            this.setStatus('⚠ ' + e.message);
            return;
        }

        // Volume guard: a large area at a high zoom can mean thousands of tiles
        // and hundreds of MB — slow, memory-heavy, and prone to rate limiting.
        // Warn and require explicit confirmation past a threshold.
        const pre = estimate(origin, radius, zoom, sel);
        const TILE_WARN = 800;
        if (pre.tiles.total > TILE_WARN) {
            const msg =
                `所选范围较大：约 ${pre.tiles.total} 个瓦片、` +
                `预计下载 ${fmtBytes(pre.bytes.total)}。\n\n` +
                `浏览器端处理如此大的数据会很慢且可能失败。建议：\n` +
                `· 降低缩放级别（当前 ${zoom}），或\n` +
                `· 缩小范围半径（当前 ${radius.toFixed(1)} km），或\n` +
                `· 选择更小的行政区（如区县而非地级市）。\n\n` +
                `仍要继续吗？`;
            if (!window.confirm(msg)) {
                this.setStatus('已取消：范围过大。请降低缩放级别或缩小范围后重试。');
                return;
            }
        }

        this.setStatus('正在生成地形…', true);
        this._clearModel();
        this._startLoadingGrid();
        this.setWarnings([]);

        const warnings = [];

        // Progress: count tile fetches against the pre-computed estimate.
        const est = estimate(origin, radius, zoom, sel);
        const totalTiles = Math.max(1, est.tiles.total);
        let fetched = 0;
        Fetch.onTileDone = ({ api }) => {
            fetched++;
            const kind = api.includes('satellite') ? '卫星'
                : api.includes('rgb') ? '高程'
                : api.includes('streets') ? '矢量' : '瓦片';
            this.setProgress(fetched / totalTiles,
                `下载${kind}瓦片 ${fetched}/${totalTiles}`);
        };
        this.setProgress(0, `准备下载 ${totalTiles} 个瓦片…`);

        const root = new THREE.Group();
        root.name = 'terrain-model';

        try {
            // Terrain is the raycast base for draping features; build it even if
            // the user unchecked "terrain" (we just won't add it to the scene).
            const terrain = await this.tgeo.getTerrainRgb(origin, radius, zoom);
            terrain.name = 'terrain';

            // Detect empty/over-zoomed terrain (no DEM/satellite tiles returned).
            let terrainMeshes = 0;
            terrain.traverse((o) => { if (o.isMesh) terrainMeshes++; });
            if (sel.terrain && terrainMeshes === 0) {
                warnings.push('地形：该位置/缩放级别无地形瓦片数据，未生成地形。');
            }

            if (sel.terrain) root.add(terrain);

            // Projection for this area — used by feature draping and region clip.
            const { proj, unitsPerMeter } = this.tgeo.getProjection(origin, radius);

            const needFeatures = sel.water || sel.road || sel.building;
            if (needFeatures) {
                this.setStatus('正在生成水系/道路/建筑…', true);
                const bbox = ThreeGeo.getBbox(origin, radius);
                // Use a feature zoom that has buildings/roads (>=14 recommended).
                const fz = Math.max(zoom, 14);
                const zpCovered = ThreeGeo.getZoomposCovered(bbox.feature, fz);

                const streets = new StreetsModel({
                    token: this.token, proj, unitsPerMeter,
                    terrain, zpCovered,
                });
                const featGroup = await streets.build(sel, (m) => this.setStatus(m, true));
                root.add(featGroup);

                // Data-availability warnings from the feature report.
                const rep = featGroup.userData.report || {};
                const LABEL = { water: '水系', road: '道路', building: '建筑' };
                (rep.empty || []).forEach((layer) => {
                    let msg = `${LABEL[layer]}：该区域在缩放级别 ${rep.featureZoom} 无矢量数据，未生成。`;
                    if (layer === 'building') {
                        msg += '（建筑数据通常需缩放级别 ≥ 13，且偏远地区可能本就未覆盖）';
                    }
                    warnings.push(msg);
                });
                if (rep.tilesOk === 0 && rep.tilesTotal > 0) {
                    warnings.push('要素：所有矢量瓦片请求均失败（请检查网络或 Mapbox token）。');
                }
            }

            // Clip the square result to the selected region boundary, if any.
            if (this._regionPoly && $('#f-clip').checked) {
                this.setStatus('正在按区域边界裁剪…', true);
                const { kept, dropped, trisBefore, trisAfter } =
                    clipToRegion(root, this._regionPoly, proj);
                if (kept === 0) {
                    warnings.push('裁剪：所选区域与生成范围无重叠，裁剪后无网格（请检查中心/半径）。');
                } else {
                    const cut = Math.max(0, trisBefore - trisAfter);
                    const pct = trisBefore ? Math.round((cut / trisBefore) * 100) : 0;
                    let msg = `已按区域边界裁剪：裁掉 ${cut.toLocaleString()} 三角面（约 ${pct}%）`;
                    if (dropped > 0) msg += `，移除 ${dropped} 个完全在界外的网格`;
                    msg += '。';
                    warnings.push(msg);
                }
            }

            this.scene.add(root);
            this.model = root;
            this._frameModel(root);

            this.setWarnings(warnings);
            const counts = this._summary(root);
            const ok = warnings.length ? `✓ 完成（${warnings.length} 项提示）` : '✓ 完成';
            this.setStatus(`${ok} — ${counts}`);
            $('#btn-export').disabled = false;
            this._exportCache = {}; // invalidate cached export sizes
            this._updateExportSize(); // measure current format's size
        } catch (e) {
            console.error(e);
            this.setStatus('✗ 生成失败: ' + (e.message || e));
        } finally {
            Fetch.onTileDone = null;
            this.setProgress(null);
            this._stopLoadingGrid();
        }
    }

    _summary(root) {
        let tris = 0, meshes = 0;
        root.traverse((o) => {
            if (o.isMesh && o.geometry) {
                meshes++;
                const p = o.geometry.attributes.position;
                if (p) tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
            }
        });
        return `${meshes} 个网格, ${Math.round(tris).toLocaleString()} 三角面`;
    }

    _clearModel() {
        if (!this.model) return;
        this.scene.remove(this.model);
        this.model.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
            }
        });
        this.model = null;
        $('#btn-export').disabled = true;
    }

    // Fit camera to the model's bounding box.
    _frameModel(root) {
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        this.controls.target.copy(center);
        this.camera.position.set(
            center.x,
            center.y - maxDim * 1.1,
            center.z + maxDim * 0.9,
        );
        this.camera.near = maxDim / 1000;
        this.camera.far = maxDim * 100;
        this.camera.updateProjectionMatrix();
        this.controls.update();

        // scale helpers to model
        this.grid.scale.setScalar(maxDim * 1.5);
        this.grid.position.set(center.x, center.y, box.min.z);

        // Re-seat the loading grid on the new framing before it fades out, so
        // the transition happens around the model instead of off-screen.
        if (this.loadingGrid.active) {
            this.loadingGrid.object.position.set(center.x, center.y, box.min.z);
            this.loadingGrid.object.scale.setScalar(maxDim * 0.75);
        }
    }

    // Measure the actual byte size of the currently selected export format by
    // building (and caching) its payload. Shown next to the format selector.
    async _updateExportSize() {
        const el = $('#export-size');
        if (!this.model) { el.textContent = ''; return; }
        const fmt = $('#export-format').value;
        this._exportCache = this._exportCache || {};

        if (this._exportCache[fmt]) {
            el.textContent = `${fmt.toUpperCase()} ≈ ${fmtBytes(this._exportCache[fmt].size)}`;
            return;
        }

        el.textContent = `正在测算 ${fmt.toUpperCase()} 大小…`;
        const token = (this._sizeToken = (this._sizeToken || 0) + 1);
        try {
            const payload = await buildExport(this.model, fmt);
            if (token !== this._sizeToken) return; // a newer request superseded us
            this._exportCache[fmt] = payload;
            el.textContent = `${fmt.toUpperCase()} ≈ ${fmtBytes(payload.size)}`;
        } catch (e) {
            console.error(e);
            el.textContent = `${fmt.toUpperCase()} 测算失败`;
        }
    }

    async doExport() {
        if (!this.model) return;
        const fmt = $('#export-format').value;
        const base = $('#export-name').value.trim() || 'terrain';
        const btn = $('#btn-export');
        btn.disabled = true;
        this.setStatus(`正在导出 ${fmt.toUpperCase()}…`);
        try {
            // Reuse the cached payload from size measurement when available.
            this._exportCache = this._exportCache || {};
            const prebuilt = this._exportCache[fmt] || null;
            await exportModel(this.model, fmt, base, prebuilt);
            const sz = prebuilt ? `（${fmtBytes(prebuilt.size)}）` : '';
            this.setStatus(`✓ 已导出 ${base}.${fmt} ${sz}`);
        } catch (e) {
            console.error(e);
            this.setStatus('✗ 导出失败: ' + (e.message || e));
        } finally {
            btn.disabled = false;
        }
    }

    _resize() {
        const wrap = this.canvas.parentElement;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    _animate() {
        requestAnimationFrame(() => this._animate());
        this.loadingGrid.update(this.clock.getDelta());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
