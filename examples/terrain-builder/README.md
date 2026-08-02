# terrain-builder

基于 [three-geo](../../README.md) 的三维地形生成器。输入中心点经纬度与范围，勾选要素，即可在浏览器中生成可自由浏览的三维地形，并导出为多种 3D 模型格式。

## 功能

- **多格式坐标输入**：十进制度、带方向后缀（N/S/E/W）、度分（DDM）、度分秒（DMS）、紧凑 DMS（`46d34m34sN`）等，输入框实时预览解析结果。
- **地图选区（中国）**：点击「在地图上选择区域」打开地图弹窗，
  - 在高德底图（GCJ-02）上按**中文或拼音**搜索省/市/区县（如 `杭州` / `hangzhou` / `hz`），或用**省 / 市 / 区县级联下拉**选择；
  - 选中后从 [DataV.GeoAtlas](https://geo.datav.aliyun.com) 拉取该行政区边界并高亮；
  - 也可用**多边形 / 矩形绘制工具**手绘、编辑任意区域（手绘优先于行政区边界）；
  - 「确定」后自动换算为 WGS-84，并填入中心点与半径，构建后**按所选区域边界裁剪**三维结果。
- **可勾选要素**
  - 地形 — three-geo RGB DEM + 卫星贴图
  - 水系 — Mapbox Streets v8 `water` / `waterway` 图层，贴合地形表面
  - 道路 — `road` 图层，按道路等级生成不同宽度的带状面
  - 建筑 — `building` 图层，按 `height` / `render_height` 属性拉伸
- **自由浏览**：OrbitControls（左键旋转 / 右键平移 / 滚轮缩放），自动框选模型。
- **数据量预估**：确定范围/缩放/要素后，构建前即显示精确瓦片数与预计下载体积。
- **加载进度条**：构建时实时显示瓦片下载进度（高程 → 卫星 → 矢量）。
- **三维加载动画**：构建期间视口内不再是空场景——一张格网以随机噪声起伏，随进度推进可起伏的顶点越来越少（冻结的顶点回落并变暗），100% 时完全展平后淡出。
- **导出尺寸**：选择导出格式时实时测算并显示该格式的实际文件大小，导出时复用已生成数据。
- **数据可用性提示**：勾选了但该区域/缩放级别无数据的要素会给出明确提示。
- **导出 3D 模型**：GLB、glTF、OBJ、STL（three 官方导出器），FBX（内置 ASCII 写出器，含顶点色）。

## 运行

```bash
# 在仓库根目录安装依赖（首次）
npm i --ignore-scripts

# 构建一次
npm run tb:build

# 或开发模式（监听 + 本地服务器 http://localhost:8181/index.html）
npm run tb:dev
```

构建模式下，用任意静态服务器打开 `examples/terrain-builder/index.html` 即可。
（必须经 HTTP 访问，`file://` 下 ES module 与跨域贴图会被浏览器拦截。）

## Mapbox Token

首次打开页面时，侧栏会提示输入 **Mapbox Access Token**（`pk.` 开头的公开 token，可在 [account.mapbox.com](https://account.mapbox.com/access-tokens/) 免费获取）。保存后 token 仅存于本机浏览器的 `localStorage`（键 `tb.mapboxToken`），不会上传或提交到代码库，后续打开无需再次输入。点侧栏的「更换」可重新设置。

> 代码中**不再硬编码** token。`pk.` 公开 token 在前端本就会暴露给浏览器，建议在 Mapbox 账号中按 URL 限制其使用范围。地图选区用的高德底图与 DataV 行政区边界不需要 Mapbox token。

## 实现说明

- **坐标对齐**：`ThreeGeo#getProjection()` 返回的 `proj([lat,lng]) → [x,y]` 与 RGB 地形网格顶点处于同一坐标系。要素先投影到该坐标，再向下做射线求交（raycast）取得地形高程后贴合。
- **行政区数据与基准面（datum）**：DataV 行政区边界与高德底图均为 **GCJ-02（火星坐标）** 基准，二者在地图上对齐；而 three-geo / Mapbox 地形管线为 **WGS-84**。因此选区确定时会经 `src/gcj02.js` 把边界由 GCJ-02 转为 WGS-84（前向公式 + 迭代求逆，误差 < 1 米），再驱动地形生成，避免地形与边界错位数百米。中国境外坐标按 WGS-84 原样通过。
- **区域裁剪**：地形仍按「中心点 + 半径」的方形抓取（复用既有预估/进度/导出逻辑）；构建完成后由 `src/clip.js` 把边界投影到地形坐标系，对每个网格逐三角面按质心做内外判断裁剪。裁剪边缘为网格分辨率级的锯齿（缩放级别越高越细），跨界建筑可能被切断，属尽力而为的区域裁剪。可用「裁剪到所选区域边界」复选框关闭（保留方形）。
- **行政区索引**：`scripts/gen-regions.mjs` 爬取 DataV（国→省→市→区县）生成离线索引 `src/regions-index.json`（adcode/名称/拼音/中心点，约 0.4 MB），供搜索与级联下拉使用；区县边界几何在选中时按 adcode 按需拉取，不打包。重新生成：`npm run tb:regions`。该索引在打开地图弹窗时才按需请求：`build.mjs` 会把它复制一份到 `dist/regions-index.json`，运行时以 **bundle 自身的 URL**（`import.meta.url`）为基准解析（依次尝试 `dist/` 旁的副本 → 源码树 `src/` → 文档相对路径），因此页面部署在任意路径、或只发布 `index.html + dist/` 都能取到，不会出现「行政区索引加载失败：HTTP 404」。
- **边界接口的防盗链**：DataV 的 `areas_v3/bound/<adcode>.json` 按 `Referer` 做防盗链——非 `*.aliyun.com` 来源一律 403，而不带 `Referer` 的请求正常返回（其 CORS 本身已是 `*`）。因此 `map.js` 用 `fetch(url, { referrerPolicy: 'no-referrer' })` 抑制该头，页面部署在 GitHub Pages 等第三方域名下也能取到边界。
- **要素数据**：复用 three-geo 的矢量瓦片解析（`@mapbox/vector-tile`），新增 `mapbox-streets-vector` API 拉取 Streets v8 瓦片。要素几何构建在 `src/streets.js`。
- **加载动画**：`src/loading-grid.js`。41×41 顶点的线框格网共用一份 position/color 缓冲（`LineSegments` + `Points`）。每个顶点在初始化时抽取一个 `rank ∈ [0,1)`，仅当 `进度 < rank` 时继续按各自的相位/频率做正弦起伏；进度越高，还在动的顶点越少，被冻结的顶点缓动回落到平面并渐变为暗色。格网按当前相机距离定位到轨道中心，因此上一次构建把相机留在任何尺度都能看见；构建结束（成功或失败）后整体展平并淡出。
- **导出**：`src/exporter.js`。GLB/glTF 会把卫星 `DataTexture` 转为 `CanvasTexture` 以便嵌入图像；FBX 为纯几何（顶点 + 法线 + 顶点色），不含卫星贴图，可用 Blender / FBX2glTF 进一步转换。
- **打包**：esbuild（`build.mjs`）。浏览器端用 `src/get-pixels-browser.js`（原生 `<img>` + canvas 解码）替换 `get-pixels`，避免其 Node 流依赖。Leaflet / leaflet-draw 的 CSS 一并打包为 `dist/app.bundle.css`（其图标 PNG/GIF 内联为 data URL），由 `index.html` 引入。

## 文件结构

```
terrain-builder/
├── index.html              # 表单 + 视口 + 地图弹窗 UI
├── build.mjs               # esbuild 打包脚本
├── build-shims.js          # Buffer/process 浏览器垫片
└── src/
    ├── app.js              # 主应用：编排 three-geo + 要素 + 视口 + 导出 + 选区
    ├── coords.js           # 多格式坐标解析器
    ├── map.js              # 地图选区弹窗（Leaflet + 高德底图 + DataV 边界 + 绘制）
    ├── gcj02.js            # GCJ-02 ⇄ WGS-84 基准面转换
    ├── clip.js             # 按区域边界裁剪生成的网格
    ├── loading-grid.js     # 加载动画：顶点随机起伏的格网，按进度逐步冻结
    ├── regions-index.json  # 离线行政区索引（由 scripts/gen-regions.mjs 生成）
    ├── streets.js          # 水系/道路/建筑要素模型（Streets v8）
    ├── estimate.js         # 瓦片数 + 下载体积预估
    ├── exporter.js         # GLB/glTF/OBJ/STL/FBX 导出（含尺寸测算）
    └── get-pixels-browser.js  # 浏览器图像解码（替换 get-pixels）
```

## 对底层库的改动

为支持本应用，对 `../../src/` 做了少量改动：

- `models/fetch.js` — 新增 `mapbox-streets-vector` 瓦片 URI 与矢量解析分支；新增可选进度钩子 `Fetch.onTileDone`（每个瓦片下载完成时回调，默认不设置，用于加载进度条）；新增可选并发上限 `Fetch.maxConcurrent`（默认 `null` 不限流；设为正整数时同时在飞的瓦片请求不超过该值，避免大范围 × 高缩放时数千请求并发导致浏览器/Mapbox `ERR_CONNECTION_CLOSED`，本应用设为 6）。
- `models/rgb.js` — `PlaneBufferGeometry → PlaneGeometry`，卫星纹理设置 `SRGBColorSpace`（适配 three r152+）。
- `utils.js` — `BoxBufferGeometry → BoxGeometry`。

这些改动向后兼容，不影响原有 API。
