# geo-to-model

[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**geo-to-model** 是一个浏览器端的三维地形生成器：输入经纬度或在地图上框选行政区，即可生成可自由浏览的卫星贴图三维地形（含水系 / 道路 / 建筑），并导出为 **GLB / glTF / OBJ / STL / FBX** 模型。

地形几何基于 Mapbox Maps API 的 RGB 编码 DEM（数字高程模型），要素来自 Mapbox Streets v8 矢量瓦片；行政区边界与底图来自高德 / DataV。整个项目构建于 [three.js](https://github.com/mrdoob/three.js)（r176）与 [three-geo](https://github.com/w3reality/three-geo) 之上。

> 本仓库 fork 自 [w3reality/three-geo](https://github.com/w3reality/three-geo)，在其地形库的基础上新增了完整的 **terrain-builder** 应用与若干库层增强。

## ✨ 主要功能

- **多格式坐标输入** — 十进制度、带方向后缀（N/S/E/W）、度分（DDM）、度分秒（DMS）、紧凑 DMS（`46d34m34sN`）等，实时预览解析结果。
- **地图选区（中国）** — 在高德底图上按**中文或拼音**搜索省 / 市 / 区县（如 `杭州` / `hangzhou` / `hz`），或用级联下拉选择；也可用**多边形 / 矩形工具手绘**任意区域。确定后自动换算坐标并**按区域边界裁剪**三维结果。
- **可勾选要素** — 地形、水系、道路、建筑，均贴合地形表面。
- **自由浏览** — OrbitControls（左键旋转 / 右键平移 / 滚轮缩放），自动框选模型。
- **数据量预估 + 加载进度 + 导出尺寸** — 构建前显示瓦片数与预计下载体积；构建时实时进度条；选择导出格式时实时测算文件大小。
- **多格式导出** — GLB / glTF / OBJ / STL（three 官方导出器）、FBX（内置 ASCII 几何写出器，含顶点色）。
- **稳健性** — 瓦片请求并发限流、超大范围二次确认、损坏贴图容错与导出异常兜底。

## 🚀 快速开始

```bash
# 安装依赖（在仓库根目录）
npm i --ignore-scripts

# 开发模式：监听构建 + 本地服务器
npm run tb:dev
# 打开 http://localhost:8181/index.html

# 或仅构建一次
npm run tb:build
```

首次打开页面时，侧栏会提示输入 **Mapbox Access Token**（`pk.` 开头的公开 token，可在 [account.mapbox.com](https://account.mapbox.com/access-tokens/) 免费获取）。Token 仅保存在本机浏览器的 `localStorage`，**不会上传或写入代码库**，后续打开无需再次输入。

> 应用必须经 HTTP 访问（`tb:dev` 已起本地服务器）；`file://` 下 ES module 与跨域贴图会被浏览器拦截。

应用的详细说明、实现原理与文件结构见 **[examples/terrain-builder/README.md](examples/terrain-builder/README.md)**。

## 📦 重新生成行政区索引

省 / 市 / 区县的离线索引（`examples/terrain-builder/src/regions-index.json`）由脚本从 [DataV.GeoAtlas](https://geo.datav.aliyun.com) 爬取生成。如需更新：

```bash
npm run tb:regions
```

## 🗺 数据与基准面说明

- **地形 / 卫星 / 要素**：Mapbox Maps API（WGS-84）。
- **行政区边界**：DataV.GeoAtlas；**二维底图**：高德地图。两者均为 **GCJ-02（火星坐标）** 基准，在地图上彼此对齐。
- 选区确定时会把边界由 GCJ-02 转为 WGS-84（误差 < 1 米）再驱动地形生成，避免地形与边界错位数百米。

---

## 底层库 `three-geo`

terrain-builder 构建于 three-geo 之上，并对其做了少量**向后兼容**的增强（新增 Streets v8 矢量瓦片 API、可选进度钩子 `Fetch.onTileDone`、可选并发上限 `Fetch.maxConcurrent`，以及 three r176 适配）。下面保留 three-geo 的核心编程接口，供直接以代码方式获取地形网格时参考。

### 用法示例

在 GPS 坐标 (46.5763, 7.9904) 处、半径 5 km、卫星 zoom 12 构建地形：

```js
import ThreeGeo from 'three-geo';

const tgeo = new ThreeGeo({
    tokenMapbox: '********', // <---- 你的 Mapbox API token
});

const terrain = await tgeo.getTerrainRgb(
    [46.5763, 7.9904], // [lat, lng]
    5.0,               // 外接圆半径（km）
    12);               // zoom 分辨率（最高 17）

const scene = new THREE.Scene();
scene.add(terrain);
```

### API

`origin` / `radius` / `zoom` 是以下方法的公共参数：

- `origin` **Array\<number\>** — 地形中心的 GPS 坐标 `[latitude, longitude]`。
- `radius` **number** — 外接圆半径（km）。
- `zoom` **number** — 卫星瓦片 zoom 分辨率，取值 {11–17}，越高瓦片调用越多。

**`ThreeGeo`**

- `constructor(opts={})`
  - `opts.tokenMapbox`=`""` **string** — Mapbox API token（必填）。
  - `opts.unitsSide`=`1.0` **number** — 地形外接正方形在 WebGL 空间的边长。
  - `opts.isNode`=`false` **boolean** — 在 NodeJS 中使用时须设为 `true`。

- `async getTerrainRgb(origin, radius, zoom)` — 返回表示地形三维表面的 **THREE.Group**，其 `.children` 为带卫星贴图的 **THREE.Mesh** 数组。

- `async getTerrainVector(origin, radius, zoom)` — 返回地形等高线图的 **THREE.Group**（拉伸面 + 等高线）。

- `getProjection(origin, radius, unitsSide=1.0)` — 返回 `{ proj, projInv, bbox, unitsPerMeter }`：
  - `proj(latlng)` — 把 `[lat, lng]` 映射到 WebGL 坐标 `[x, y]`。
  - `projInv(x, y)` — 把 WebGL 坐标 `[x, y]` 反映射回 `[lat, lng]`。
  - `bbox` — 计算出的边界框 `[w, s, e, n]`。
  - `unitsPerMeter` — WebGL 空间中每米对应的长度。

## 🙏 致谢

- [w3reality/three-geo](https://github.com/w3reality/three-geo) — 本项目所基于的三维地形库。
- 地理相关库 [mapbox](https://github.com/mapbox)、[Turf.js](https://github.com/Turfjs/turf) 与 [Mapbox Maps API](https://www.mapbox.com/api-documentation/#maps)。
- [DataV.GeoAtlas](https://datav.aliyun.com/portal/school/atlas/area_selector) 提供的中国行政区边界数据。
- [peterqliu](https://github.com/peterqliu) 关于三维地形的文章与实现。

## 许可

[MIT](LICENSE)
