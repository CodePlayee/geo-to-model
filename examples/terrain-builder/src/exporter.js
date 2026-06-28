// Model export: GLB / GLTF / OBJ / STL via three's official exporters, plus a
// self-contained ASCII FBX writer (geometry + per-mesh vertex colors; satellite
// textures are not embedded in FBX).

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

function downloadBlob(data, filename, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Some terrain meshes use MeshBasicMaterial with a DataTexture map. GLTFExporter
// needs an ImageBitmap/Canvas-backed texture to embed images. We convert any
// DataTexture map to a CanvasTexture so GLB/GLTF carry the satellite imagery.
function prepareForGltf(root) {
    const restores = [];
    root.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mat) => {
            const tex = mat.map;
            if (tex && tex.isDataTexture) {
                const canvasTex = dataTextureToCanvas(tex);
                restores.push([mat, tex]);
                // Replace with a canvas-backed texture GLTFExporter can embed,
                // or drop the map entirely when the source is unusable (corrupt
                // / partially-downloaded tile) so the export can't crash on it.
                mat.map = canvasTex; // canvasTex may be null -> no texture
            }
        });
    });
    return () => restores.forEach(([mat, tex]) => { mat.map = tex; });
}

function dataTextureToCanvas(tex) {
    const img = tex.image || {};
    const data = img.data;
    const width = img.width, height = img.height;
    if (!width || !height || !data) return null;
    // Guard against partially-downloaded / corrupt tiles: a DataTexture whose
    // buffer doesn't match its declared dimensions would make ImageData.set()
    // throw, or produce a canvas that canvas.toBlob() refuses to encode (null)
    // — which surfaces inside GLTFExporter as an un-catchable async crash.
    if (data.length < width * height * 4) return null;
    let canvas, ctx, imgData;
    try {
        canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        ctx = canvas.getContext('2d');
        imgData = ctx.createImageData(width, height);
        imgData.data.set(data.subarray ? data.subarray(0, width * height * 4) : data);
        ctx.putImageData(imgData, 0, 0);
    } catch (e) {
        console.warn('exporter: skipping unconvertible texture:', e.message);
        return null;
    }
    const ct = new THREE.CanvasTexture(canvas);
    ct.flipY = tex.flipY;
    ct.colorSpace = tex.colorSpace;
    ct.needsUpdate = true;
    return ct;
}

async function exportGltf(root, binary) {
    const restore = prepareForGltf(root);
    const exporter = new GLTFExporter();
    // GLTFExporter encodes the merged buffer (and any images) inside a
    // FileReader.onloadend callback that it does NOT await. If that callback
    // throws — e.g. a huge model exhausts memory so FileReader yields a null
    // result, giving "Cannot read properties of null (reading 'byteLength')" —
    // the error escapes as an uncaught window error and parseAsync() neither
    // resolves nor rejects (the export would hang). Trap such errors for the
    // duration of this export and convert them into a clean rejection.
    try {
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, arg) => { if (settled) return; settled = true; window.removeEventListener('error', onError); fn(arg); };
            const onError = (ev) => {
                const fromExporter = (ev.filename && /GLTFExporter/.test(ev.filename)) ||
                    /byteLength|GLTFExporter/i.test(ev.message || '');
                if (!fromExporter) return; // unrelated error — leave it alone
                ev.preventDefault();
                finish(reject, new Error(
                    'GLB/glTF 编码失败：模型或贴图过大导致内存不足。请缩小范围/降低缩放级别，或改用 OBJ/STL 导出。'));
            };
            window.addEventListener('error', onError);
            exporter.parseAsync(root, { binary, embedImages: true }).then(
                (result) => finish(resolve, binary
                    ? new Blob([result], { type: 'model/gltf-binary' })
                    : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' })),
                (err) => finish(reject, err),
            );
        });
    } finally {
        restore();
    }
}

function exportObj(root) {
    return new OBJExporter().parse(root); // string
}

function exportStl(root, binary = true) {
    const result = new STLExporter().parse(root, { binary });
    return binary ? new Blob([result], { type: 'application/octet-stream' })
                  : result;
}

// ---- FBX (ASCII 7.4) ------------------------------------------------------
// Minimal but valid ASCII FBX: one Model + Geometry per mesh, with vertex
// positions, polygon indices, normals, and per-vertex colors sampled from the
// material color (or vertex colors when present). No texture binding.

let _fbxId = 1000000;
const nextId = () => ++_fbxId;

function collectMeshes(root) {
    const meshes = [];
    root.updateWorldMatrix(true, true);
    root.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
    return meshes;
}

function meshToFbxGeometry(mesh) {
    let geom = mesh.geometry;
    if (geom.index) geom = geom.toNonIndexed();
    const pos = geom.attributes.position;
    const mat = mesh.matrixWorld;
    const v = new THREE.Vector3();

    const verts = [];
    const polyIdx = [];
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mat);
        verts.push(v.x, v.y, v.z);
        // every 3rd vertex closes a triangle: FBX marks the last index of a
        // polygon as bitwise-NOT (negative).
        polyIdx.push((i % 3 === 2) ? ~i : i);
    }

    let normals = null;
    if (geom.attributes.normal) {
        const na = geom.attributes.normal;
        const nm = new THREE.Matrix3().getNormalMatrix(mat);
        const n = new THREE.Vector3();
        normals = [];
        for (let i = 0; i < na.count; i++) {
            n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
            normals.push(n.x, n.y, n.z);
        }
    }

    // per-vertex color: from geometry color attr, else material color
    const colors = [];
    const cattr = geom.attributes.color;
    const matColor = (mesh.material && mesh.material.color) || new THREE.Color(0xcccccc);
    for (let i = 0; i < pos.count; i++) {
        if (cattr) colors.push(cattr.getX(i), cattr.getY(i), cattr.getZ(i), 1);
        else colors.push(matColor.r, matColor.g, matColor.b, 1);
    }

    return { verts, polyIdx, normals, colors };
}

function fbxArray(nums, perLine = 3) {
    // join with commas; chunk lines for readability (not required by spec)
    let s = '';
    for (let i = 0; i < nums.length; i++) {
        s += nums[i];
        if (i < nums.length - 1) s += ',';
        if ((i + 1) % (perLine * 8) === 0) s += '\n\t\t\t\t';
    }
    return s;
}

function buildFbx(root) {
    const meshes = collectMeshes(root);
    const now = '2026-01-01T00:00:00:000';

    const objects = [];
    const connections = ['\t;Model::RootNode, Model::Scene\n\tC: "OO",0,0\n'];

    for (const mesh of meshes) {
        const geo = meshToFbxGeometry(mesh);
        const gId = nextId();
        const mId = nextId();
        const name = (mesh.name || 'mesh').replace(/[^\w\-]/g, '_');

        objects.push(
`\tGeometry: ${gId}, "Geometry::${name}", "Mesh" {
\t\tVertices: *${geo.verts.length} {
\t\t\ta: ${fbxArray(geo.verts)}
\t\t}
\t\tPolygonVertexIndex: *${geo.polyIdx.length} {
\t\t\ta: ${fbxArray(geo.polyIdx)}
\t\t}` +
(geo.normals ?
`\n\t\tLayerElementNormal: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "ByVertice"
\t\t\tReferenceInformationType: "Direct"
\t\t\tNormals: *${geo.normals.length} {
\t\t\t\ta: ${fbxArray(geo.normals)}
\t\t\t}
\t\t}` : '') +
`\n\t\tLayerElementColor: 0 {
\t\t\tVersion: 101
\t\t\tName: "color"
\t\t\tMappingInformationType: "ByVertice"
\t\t\tReferenceInformationType: "Direct"
\t\t\tColors: *${geo.colors.length} {
\t\t\t\ta: ${fbxArray(geo.colors, 4)}
\t\t\t}
\t\t}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement: { Type: "LayerElementNormal", TypedIndex: 0 }
\t\t\tLayerElement: { Type: "LayerElementColor", TypedIndex: 0 }
\t\t}
\t}
`);

        objects.push(
`\tModel: ${mId}, "Model::${name}", "Mesh" {
\t\tVersion: 232
\t\tProperties70: {
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
`);

        connections.push(`\t;Model::${name}, Model::RootNode\n\tC: "OO",${mId},0\n`);
        connections.push(`\t;Geometry::${name}, Model::${name}\n\tC: "OO",${gId},${mId}\n`);
    }

    const header =
`; FBX 7.4.0 project file
; Generated by three-geo terrain-builder
; ----------------------------------------------------

FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreationTimeStamp:  {
\t\tVersion: 1000
\t\tYear: 2026
\t\tMonth: 1
\t\tDay: 1
\t}
\tCreator: "three-geo terrain-builder"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",2
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",1
\t\tP: "FrontAxisSign", "int", "Integer", "",-1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
`;

    const objectsCount = meshes.length * 2;
    const definitions =
`Definitions:  {
\tVersion: 100
\tCount: ${objectsCount}
\tObjectType: "Geometry" {
\t\tCount: ${meshes.length}
\t}
\tObjectType: "Model" {
\t\tCount: ${meshes.length}
\t}
}
`;

    return header + definitions +
        'Objects:  {\n' + objects.join('') + '}\n' +
        'Connections:  {\n' + connections.join('') + '}\n';
}

/**
 * Build the export payload for a format WITHOUT downloading.
 * Returns { data, mime, ext, size } where data is a Blob or string.
 * @param {THREE.Object3D} root
 * @param {'glb'|'gltf'|'obj'|'stl'|'fbx'} format
 */
export async function buildExport(root, format) {
    let data, mime, ext;
    switch (format) {
        case 'glb':
            data = await exportGltf(root, true); mime = 'model/gltf-binary'; ext = 'glb'; break;
        case 'gltf':
            data = await exportGltf(root, false); mime = 'model/gltf+json'; ext = 'gltf'; break;
        case 'obj':
            data = exportObj(root); mime = 'text/plain'; ext = 'obj'; break;
        case 'stl':
            data = exportStl(root, true); mime = 'application/octet-stream'; ext = 'stl'; break;
        case 'fbx':
            data = buildFbx(root); mime = 'application/octet-stream'; ext = 'fbx'; break;
        default:
            throw new Error(`不支持的导出格式: ${format}`);
    }
    const size = data instanceof Blob ? data.size
        : new Blob([data]).size; // measure string byte length
    return { data, mime, ext, size };
}

/**
 * Export a THREE object tree to the given format and trigger a download.
 * Accepts an optional pre-built payload (from buildExport) to avoid
 * regenerating the data.
 * @param {THREE.Object3D} root
 * @param {'glb'|'gltf'|'obj'|'stl'|'fbx'} format
 * @param {string} [basename]
 * @param {{data:any,mime:string,ext:string}} [prebuilt]
 */
export async function exportModel(root, format, basename = 'terrain', prebuilt = null) {
    const { data, mime, ext } = prebuilt || await buildExport(root, format);
    return downloadBlob(data, `${basename}.${ext}`, mime);
}

export default exportModel;
