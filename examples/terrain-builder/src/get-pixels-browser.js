// Browser replacement for `get-pixels` (used by three-geo's fetch.js to decode
// satellite JPEG / RGB-DEM PNG tiles). The upstream browser build pulls in a
// Node stream stack; in a real browser we can decode images natively with an
// <img> + canvas and return the same ndarray-like { data, shape } object.
//
// Signature matches get-pixels: getPixels(url, [type], cb) where cb(err, pixels)
// and pixels = { data: Uint8Array(rgba), shape: [w, h, 4] }.

function getPixels(url, typeOrCb, maybeCb) {
    const cb = typeof typeOrCb === 'function' ? typeOrCb : maybeCb;
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        let imgData;
        try {
            imgData = ctx.getImageData(0, 0, w, h);
        } catch (e) {
            return cb(e);
        }
        cb(null, {
            data: new Uint8Array(imgData.data.buffer.slice(0)),
            shape: [w, h, 4],
            // ndarray-ish accessors three-geo doesn't use, but harmless:
            width: w, height: h,
        });
    };
    img.onerror = () => cb(new Error('image load failed: ' + url));
    img.src = url;
}

export default getPixels;
