// In-viewport loading indicator.
//
// While tiles download the 3D scene is otherwise empty, so we drop a wireframe
// grid into it and ripple its vertices with pseudo-random noise. Every vertex
// draws a rank in [0,1) up front and keeps oscillating only while
// progress < rank, so the population of moving vertices shrinks as loading
// advances: frozen vertices ease back onto the plane and dim out, and the
// sheet is perfectly flat and dark at 100%. Progress is therefore readable
// straight off the geometry, without any text.

import * as THREE from 'three';

const SEG = 40;              // cells per side -> (SEG+1)^2 vertices
const AMP = 0.085;           // peak vertical displacement, in base units
const LIVE = new THREE.Color(0x5ec8ff);   // still animating
const DONE = new THREE.Color(0x1b3346);   // settled

// Frame-rate independent easing factor for `x += (target - x) * f`.
const ease = (dt, k) => 1 - Math.exp(-k * dt);

export default class LoadingGrid {
    constructor() {
        const n = SEG + 1;
        const count = n * n;

        const position = new Float32Array(count * 3);
        const color = new Float32Array(count * 3);
        this.rank = new Float32Array(count);    // freeze order, [0,1)
        this.phase = new Float32Array(count);
        this.speed = new Float32Array(count);
        this.gain = new Float32Array(count);    // per-vertex amplitude
        this.life = new Float32Array(count);    // 1 = moving, 0 = settled

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const k = j * n + i;
                position[k * 3] = (i / SEG) * 2 - 1;
                position[k * 3 + 1] = (j / SEG) * 2 - 1;
                position[k * 3 + 2] = 0;
                this.rank[k] = Math.random();
                this.phase[k] = Math.random() * Math.PI * 2;
                this.speed[k] = 0.7 + Math.random() * 1.8;
                this.gain[k] = 0.35 + Math.random() * 0.65;
                this.life[k] = 1;
            }
        }

        // Line segments along both grid directions, sharing the vertex buffer.
        const index = [];
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const k = j * n + i;
                if (i < SEG) index.push(k, k + 1);
                if (j < SEG) index.push(k, k + n);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
        geometry.setIndex(index);
        this.geometry = geometry;

        this.lineMat = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
        });
        // Points share the same buffers but are drawn unindexed, so they need
        // their own geometry view; reuse the attributes to keep it in sync.
        const dots = new THREE.BufferGeometry();
        dots.setAttribute('position', geometry.attributes.position);
        dots.setAttribute('color', geometry.attributes.color);
        this.dotsGeometry = dots;
        this.pointMat = new THREE.PointsMaterial({
            vertexColors: true, size: 2.6, sizeAttenuation: false,
            transparent: true, opacity: 0.95, depthWrite: false,
        });

        this.object = new THREE.Group();
        this.object.name = 'loading-grid';
        this.object.frustumCulled = false;
        this.object.visible = false;
        const lines = new THREE.LineSegments(geometry, this.lineMat);
        const points = new THREE.Points(dots, this.pointMat);
        lines.frustumCulled = points.frustumCulled = false;
        this.object.add(lines, points);

        this.time = 0;
        this.progress = 0;      // displayed (eased) progress
        this.target = 0;        // reported progress
        this._settling = false; // true once finish() was called
        this._fadeT = 0;
        this._paint();
    }

    get active() { return this.object.visible; }

    /** Show the grid centered on `center`, spanning `size` world units. */
    start(center, size) {
        this.object.position.copy(center);
        this.object.scale.setScalar(size / 2);

        const pos = this.geometry.attributes.position.array;
        for (let k = 0; k < this.life.length; k++) {
            pos[k * 3 + 2] = 0;
            this.life[k] = 1;
        }
        this.geometry.attributes.position.needsUpdate = true;

        this.time = 0;
        this.progress = this.target = 0;
        this._settling = false;
        this._fadeT = 0;
        this._setOpacity(1);
        this._paint();
        this.object.visible = true;
    }

    /** Report loading progress in [0,1]. */
    setProgress(frac) {
        if (!Number.isFinite(frac)) return;
        this.target = Math.max(this.target, Math.min(1, Math.max(0, frac)));
    }

    /** Loading is over: flatten every remaining vertex, then fade out. */
    finish() {
        if (!this.object.visible) return;
        this.target = 1;
        this._settling = true;
        this._fadeT = 0;
    }

    hide() {
        this.object.visible = false;
        this._settling = false;
    }

    update(dt) {
        if (!this.object.visible || !(dt > 0)) return;
        const t = (this.time += Math.min(dt, 0.1));

        this.progress += (this.target - this.progress) * ease(dt, 4);
        const settle = ease(dt, 5);
        const dim = ease(dt, 6);

        const pos = this.geometry.attributes.position.array;
        const col = this.geometry.attributes.color.array;
        for (let k = 0; k < this.life.length; k++) {
            const moving = !this._settling && this.rank[k] > this.progress;
            let z;
            if (moving) {
                const s = this.speed[k], p = this.phase[k];
                z = AMP * this.gain[k] *
                    (Math.sin(t * s + p) * 0.75 + Math.sin(t * s * 1.7 + p * 2.3) * 0.25);
                this.life[k] += (1 - this.life[k]) * dim;
            } else {
                z = pos[k * 3 + 2] * (1 - settle);
                this.life[k] += (0 - this.life[k]) * dim;
            }
            pos[k * 3 + 2] = z;

            // Brighter where a live vertex peaks; frozen vertices fade to DONE.
            const l = this.life[k] * (0.6 + 0.4 * Math.min(1, Math.abs(z) / AMP));
            col[k * 3] = DONE.r + (LIVE.r - DONE.r) * l;
            col[k * 3 + 1] = DONE.g + (LIVE.g - DONE.g) * l;
            col[k * 3 + 2] = DONE.b + (LIVE.b - DONE.b) * l;
        }
        this.geometry.attributes.position.needsUpdate = true;
        this.geometry.attributes.color.needsUpdate = true;

        if (this._settling) {
            // Hold briefly on the flat grid, then dissolve.
            this._fadeT += dt;
            const o = 1 - Math.max(0, (this._fadeT - 0.25) / 0.6);
            if (o <= 0) { this.hide(); return; }
            this._setOpacity(o);
        }
    }

    _setOpacity(o) {
        this.lineMat.opacity = 0.85 * o;
        this.pointMat.opacity = 0.95 * o;
    }

    // Paint the initial (all-live) colors so the first frame isn't black.
    _paint() {
        const col = this.geometry.attributes.color.array;
        for (let k = 0; k < this.life.length; k++) {
            const l = this.life[k] * 0.6;
            col[k * 3] = DONE.r + (LIVE.r - DONE.r) * l;
            col[k * 3 + 1] = DONE.g + (LIVE.g - DONE.g) * l;
            col[k * 3 + 2] = DONE.b + (LIVE.b - DONE.b) * l;
        }
        this.geometry.attributes.color.needsUpdate = true;
    }
}
