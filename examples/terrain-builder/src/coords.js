// Multi-format geographic coordinate parser.
//
// Accepts a single string containing a latitude/longitude pair in a wide
// range of common notations and returns `[lat, lng]` (decimal degrees), or
// throws an Error describing why parsing failed.
//
// Supported notations (separators are flexible — comma, whitespace, or `/`):
//   - Decimal degrees:        "46.5763, 7.9904"   "46.5763 7.9904"
//   - Signed decimal:         "-33.8688, 151.2093"
//   - Decimal + hemisphere:   "46.5763N, 7.9904E"  "7.9904 E 46.5763 N"
//   - Degrees-minutes (DDM):  "46 34.578 N, 7 59.424 E"
//   - Degrees-min-sec (DMS):  "46°34'34.7\"N 7°59'25.4\"E"
//   - Compact DMS:            "46d34m34sN 7d59m25sE"
//
// Strategy: tokenize into numbers / unit-symbols (deg,min,sec) / hemispheres /
// separators, then group tokens into exactly two coordinate groups. Hemisphere
// letters and commas act as hard group boundaries; unit symbols classify each
// number as degrees/minutes/seconds. Without any hemispheres or symbols, a flat
// list of numbers is split in half (e.g. "46 34 34 7 59 25" -> DMS pair).

const HEMIS = { N: 'N', S: 'S', E: 'E', W: 'W' };

// Tokenize. Returns array of { type, value } tokens.
function tokenize(str) {
    const tokens = [];
    const re = /([+-]?\d+(?:\.\d+)?)|([°dDºo])|(['′mM])|(["″sS])|([NSEWnsew])|([,/;])|(\s+)/g;
    let m;
    let lastIndex = 0;
    while ((m = re.exec(str)) !== null) {
        if (m.index !== lastIndex) {
            const stray = str.slice(lastIndex, m.index).trim();
            if (stray) throw new Error(`无法识别的字符: "${stray}"`);
        }
        lastIndex = re.lastIndex;
        if (m[1] !== undefined) tokens.push({ type: 'num', value: parseFloat(m[1]) });
        else if (m[2] !== undefined) tokens.push({ type: 'deg' });
        else if (m[3] !== undefined) tokens.push({ type: 'min' });
        else if (m[4] !== undefined) tokens.push({ type: 'sec' });
        else if (m[5] !== undefined) tokens.push({ type: 'hemi', value: m[5].toUpperCase() });
        else if (m[6] !== undefined) tokens.push({ type: 'sep' });
        // whitespace (m[7]) is skipped
    }
    if (lastIndex < str.length) {
        const stray = str.slice(lastIndex).trim();
        if (stray) throw new Error(`无法识别的字符: "${stray}"`);
    }
    return tokens;
}

// Group tokens into coordinate groups. Each group: { nums:[deg,min,sec], hemi }.
function groupTokens(tokens) {
    const groups = [];
    let cur = { nums: [], hemi: null };
    const flush = () => {
        if (cur.nums.length || cur.hemi) groups.push(cur);
        cur = { nums: [], hemi: null };
    };

    for (const t of tokens) {
        if (t.type === 'num') {
            cur.nums.push(t.value);
        } else if (t.type === 'deg' || t.type === 'min' || t.type === 'sec') {
            // unit symbols just annotate the preceding number's role implicitly
            // by position; nothing extra to store.
        } else if (t.type === 'hemi') {
            if (cur.nums.length === 0 && groups.length && groups[groups.length - 1].hemi === null) {
                // leading hemisphere for the *next* group, or trailing for prev:
                // attach to previous group if it has no hemi yet.
                groups[groups.length - 1].hemi = t.value;
            } else {
                cur.hemi = t.value;
                flush();
            }
        } else if (t.type === 'sep') {
            flush();
        }
    }
    flush();
    return groups;
}

function groupToDecimal(g) {
    const [deg = NaN, min = 0, sec = 0] = g.nums;
    if (Number.isNaN(deg)) return null;
    if (min >= 60 || sec >= 60) {
        throw new Error(`无效的分/秒数值（必须 < 60）: ${g.nums.join(' ')}`);
    }
    let value = Math.abs(deg) + min / 60 + sec / 3600;
    if (deg < 0) value = -value;
    return { value, hemi: g.hemi };
}

/**
 * Parse a coordinate string into [lat, lng] decimal degrees.
 * @param {string} input
 * @returns {[number, number]}
 */
export function parseCoords(input) {
    const str = String(input == null ? '' : input).trim();
    if (!str) throw new Error('坐标为空');

    const tokens = tokenize(str);
    let groups = groupTokens(tokens);

    // Flat list of numbers, no hemispheres/separators -> split in half.
    if (groups.length === 1 && !groups[0].hemi) {
        const nums = groups[0].nums;
        if (nums.length === 2) {
            groups = [{ nums: [nums[0]], hemi: null }, { nums: [nums[1]], hemi: null }];
        } else if (nums.length === 4 || nums.length === 6) {
            const half = nums.length / 2;
            groups = [
                { nums: nums.slice(0, half), hemi: null },
                { nums: nums.slice(half), hemi: null },
            ];
        }
    }

    if (groups.length !== 2) {
        throw new Error(`无法识别两个坐标分量，请检查格式: "${str}"`);
    }

    const a = groupToDecimal(groups[0]);
    const b = groupToDecimal(groups[1]);
    if (!a || !b) throw new Error(`坐标解析失败: "${str}"`);

    const applyHemi = (t) => {
        if (t.hemi === 'S' || t.hemi === 'W') return -Math.abs(t.value);
        if (t.hemi === 'N' || t.hemi === 'E') return Math.abs(t.value);
        return t.value;
    };

    const aIsLat = a.hemi === 'N' || a.hemi === 'S';
    const aIsLng = a.hemi === 'E' || a.hemi === 'W';
    const bIsLat = b.hemi === 'N' || b.hemi === 'S';

    let lat, lng;
    if (aIsLng || bIsLat) {
        // first token is longitude, so order is lng,lat
        lat = applyHemi(b); lng = applyHemi(a);
    } else {
        // default / explicit lat-first
        lat = applyHemi(a); lng = applyHemi(b);
    }

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        throw new Error(`坐标解析失败: "${str}"`);
    }
    if (lat < -90 || lat > 90) throw new Error(`纬度超出范围 [-90, 90]: ${lat}`);
    if (lng < -180 || lng > 180) throw new Error(`经度超出范围 [-180, 180]: ${lng}`);
    return [lat, lng];
}

/** Format [lat, lng] back to a readable decimal string. */
export function formatCoords([lat, lng], digits = 5) {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(digits)}°${ns}, ${Math.abs(lng).toFixed(digits)}°${ew}`;
}

export default parseCoords;
