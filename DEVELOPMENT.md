# 开发说明

面向要改这个插件的人。使用者请看 [`README.md`](README.md)，发布流程看 [`PUBLISHING.md`](PUBLISHING.md)。

## 项目结构

```
src/client/viewer.tsx        查看器：注册 FileViewer + three.js 场景 + 八个格式的解析调度
src/client/occt-kernel.ts   内核侧：内核入口选择、离散参数、打包成 typed array（无 three 依赖）
src/client/occt-worker.ts   Worker 入口：持有内核，收字节、回传网格
src/client/occt-remote.ts   主线程侧：起停 Worker、传字节、取消即杀线程
src/client/occt-glue.ts     浏览器端：内联的 emscripten 胶水 + 运行时求值（只被 worker 用）
src/client/occt-main-thread.ts  页面侧的内核占位：任何试图在主线程建内核的调用都会报错
src/client/occt-node-glue.ts  Node 端：同一条加载路径的另一种绑定（给测试用）
src/client/node-entry.ts    测试入口（把 wasm 从 test/fixtures 读进来）
src/client/scene.ts         场景装配：轨道相机、网格、取景（不依赖 React）
src/client/gizmo.ts         右下角方向指示器（第二个小 WebGL 视图）
src/samples/appearance.ts   外观小样页（不是插件代码，用来比较几种方案）
lib/index.js                Host 半边：/cad-preview 四条路线
lib/client.js               浏览器 bundle（three.js 内联；**不含** CAD 内核）
lib/client.worker.js        解析 Worker（内联 CAD 胶水；被 /cad-preview/worker.js 提供）
lib/client.occt.js          CAD 胶水 chunk（构建中间产物，同时保留作对照）
lib/occt-import-js.wasm     OpenCascade 内核（7.6 MB，浏览器按需下载并缓存）
vendor/three/               裁剪后的 three.js（见下）
```

## 四条路线（Host 半边）

| 路线 | 用途 |
| --- | --- |
| `GET /cad-preview/file?path=<abs>` | 模型字节，支持 HTTP Range，绝对路径 |
| `GET /cad-preview/asset?name=occt-import-js.wasm` | 包内资源（内核 wasm） |
| `GET /cad-preview/client.js` | 预构建的浏览器 bundle |
| `GET /cad-preview/worker.js` | 预构建的解析 Worker |
| `GET /cad-preview/ping` | 自检：返回插件名与版本 |

四条都走与宿主 `/api` 相同的浏览器信任栅栏（loopback Host + 同源标记），并且只认绝对路径 —— 与 `dsh-media-preview`、官方目录选择器的做法一致。`worker.js` 和 `client.js` 一样用 `no-cache`：worker 是脚本，升级后必须下一次刷新就换掉，不能像 wasm 那样吃一年强缓存。

## 关于 `vendor/three`

loaders 是**拷贝进来**的，而不是从 `three` 包导入：在这个 checkout 里 esbuild 解析不了裸标识符 `three/examples/jsm/loaders/ThreeMFLoader.js`，而且工作区在移动硬盘上，刚写入的**以数字开头**的文件（上游名是 `3MFLoader.js`）会短暂 stat 成 ENOENT。因此文件叫 `ThreeMFLoader.js`，**不要改回**上游名字。

查看器源码里仍然写 `import ... from 'three/examples/jsm/...'`，浏览器构建用 resolver 插件把它们指向 `vendor/`，Node 构建则从 `node_modules` 解析 —— 两边共用一套 import 拼写。

## 关于 CAD 内核

`occt-import-js` 是 emscripten 的**经典脚本**（`module.exports = factory`），既不能当 ESM，也不能当 external（DSH 的模块表只会服务启动图里已经物化的 `require`）。所以构建时把它打成包内 chunk 并把文本内联进 **Worker bundle**，运行时用一个内联 `require` shim 求值 —— 胶水里所有 `require`/`fs`/`path` 都落在 `ENVIRONMENT_IS_NODE` 的死分支里，浏览器不会走到。

内核为什么必须在 Worker 里：

- **它是"一口气跑完"的**：`ReadStepFile` 是同步调用，中间不让出事件循环。放主线程上，界面在这段时间里完全不响应 —— 包括侧边栏自己的重绘和与 harness 的心跳。
- **它的堆能长到 2 GB**：这份胶水的 `getHeapMax()` 返回 2147483648；右侧栏又和聊天界面共用同一个渲染进程，于是"一个模型太大"直接等于"整个应用没了"。
- **右侧栏不是独立进程**：浏览器里每个标签页有自己的渲染进程，所以同一段代码在独立页面里测着没问题，在 DSH 里就是把主界面拖死。

分工因此是硬的，不是风格问题：

| 谁 | 拿什么 |
|---|---|
| `lib/client.js`（页面） | 只负责取字节、连 Worker、把回传的 typed array 包成 `BufferGeometry`。它连胶水都没有 |
| `lib/client.worker.js` | 持有内核，收 STEP/IGES/BREP 字节，回传 `positions`/`normals`/`indices`（**Transferable**，不回拷） |
| `src/client/occt-main-thread.ts` | 页面侧的内核占位：任何"没有 Worker 时退回主线程"的念头都会在这里报错，而不是悄悄冻住界面 |

工程上的三个约定：

1. **一个挂载的查看器一个 Worker**：关掉标签页即 `terminate()`，内核（和它的堆）立刻归还；坏文件最多烧掉它自己那个 Worker。
2. **取消即杀线程**：同步 wasm 解析没法协作式中断，`AbortSignal` 触发时只能 `terminate()`；下一次解析会透明地新建一个。
3. **上游内核字节只在新建 Worker 时传一次**：worker 会在消息里回 `kernelReady: true`，之后同一个 worker 不再重复搬运 7.6 MB。

## 开发

```sh
pnpm install
pnpm run build      # 资产同步 + 页面 bundle + worker bundle + headless bundle
pnpm test           # 三个套件，共 70 项：
                    #   smoke  55 —— 路线（真 HTTP）、八个格式的几何解析、路径还原、
                    #              向上轴映射、内核下载失败的校验与重试、首次绘制顺序守卫、
                    #              **Worker 契约**（字节 Transferable、内核只传一次、
                    #              取消即 terminate、worker 死掉后自愈、面数上限）、
                    #              **加载 effect 不得自我循环**（loader 身份稳定性）
                    #   gizmo   5 —— 指示器的 DOM 契约与相机镜像契约
                    #   wiring 10 —— 真的调用 createViewerScene：轨控构造内首次绘制、
                    #              指示器挂载、fit/resize 空场景、切换向上轴
node scripts/check-syntax.mjs   # 四个客户端入口（含 worker）能否解析与打包
node scripts/check-samples.mjs  # 小样页在假 WebGL 下能否 import
pnpm verify-install # 对着*正在运行*的 DSH 实例自检（可选 --port / --model）
pnpm stress         # 稳定性压测：真 Chromium + 真产物，量主线程卡顿/回收/上限
```

冒烟测试跑的是**构建产物**（`lib/`），所以打包失误会先在测试里炸，而不是等到浏览器。

## 加载 effect 不能依赖每帧新建的闭包

0.3.1 为了让 DSH 内置文档预览也能复用查看器，引入了 `loadBytes` 绑定，并把它放进了加载 effect 的依赖数组：

```tsx
const loadBytes = props.loadBytes ?? ((signal) => fetchModelBytes(absolutePath, signal))   // 每次渲染都是新函数
useEffect(() => { setStatus({ phase: 'loading', message: '' }); /* … */ }, [/* … */, loadBytes])
```

于是：渲染 → `loadBytes` 新身份 → effect 重跑 → `setStatus(新对象)` → 再渲染 → ……**无限自我循环**，而每一轮都会把上一轮 `cancelled = true`，所以解析永远完不成。表现就是右侧栏一直停在"正在解析模型…"，同时浏览器被请求洪水打满；在主线程解析的年代（≤0.3.2 的页面路径）它还会把整个渲染进程拖崩。

三条规矩，别再犯：

1. **任何进入 effect 依赖的函数都必须是 `useMemo`/`useCallback` 的产物**（两个挂载点都算）；
2. effect 里的 `setStatus` 要**按值退让**（相同状态返回原对象），让 React 跳过这次渲染；
3. 排查这类问题时，**对比打包产物比读源码快**：`for v in 0.3.0 0.3.1; do tar -xzf dist/dsh-cad-preview-$v.tgz -C $v package/lib/client.js; done`，然后 grep 依赖数组 —— 0.3.0 的数组里没有 `loadBytes`，0.3.1 有，一眼定案。

冒烟测试里现在有一条源码级守卫（`the file loader identity is stable, so the load effect cannot loop`），谁再把裸闭包放回依赖数组都会红。

## 稳定性压测：`pnpm stress`（解析期间界面必须跟手）

`pnpm test` 抓不到上面那类崩溃：它跑在 Node 里，既没有主线程可以被阻塞，也没有 worker 可以卡死。所以另有一套**对着构建产物、在真实 Chromium 里**跑的压测：

```sh
pnpm stress                      # 自带圆锥（1,391 面），约 20 秒
pnpm stress --preset a           # 1,728 球 → 1,499,904 面（缺模型时自动现造）
pnpm stress --preset b           # 4,913 球 → 4,264,484 面
pnpm stress --model <file.step>  # 任意模型
```

页面上挂了一个 16ms 定时器，测**解析期间主线程的最大卡顿**——这是唯一的判据：

| 场景 | 判据 |
|---|---|
| 探针自检（故意阻塞 300ms） | 必须测到 ≥250ms —— 否则下面几行数字都不可信 |
| worker 解析 | 主线程最大卡顿 **≤150ms**、必须有三角面、**必须回包**（超时即"worker 卡死"，判失败） |
| 取消 / 关标签 ×5 | 页面堆增长 ≤32MB（内核要真的还回去） |
| 面数上限 | 必须是可读报错，不是崩 |
| 3 个 worker 并发 | 主线程仍 ≤150ms，三份都出结果 |
| 对照：旧路径（页面主线程解析） | 必须**卡死 ≥ 解析时长的一半** —— 既解释 worker 为什么存在，也是探针的第二个自检 |

参考量级（M-series / 24GB）：

```
单锥        1,391 面   旧路径卡死    79ms · worker 17ms
preset a  1,499,904 面 旧路径卡死 1840ms · worker 17-18ms · payload 35.2MB
preset b  4,264,484 面 旧路径卡死 2200ms · worker 17ms    · payload 100.2MB
3 × preset b 并发       —               · worker 18ms    · 页面堆 210MB
```

重型模型由 `scripts/make-stress-fixtures.mjs` 现造，配方是**小包围盒 + 大量球面**：内核按 `bounding_box_ratio` 离散，把几个大零件摊开反而让每个零件更省（20 个锥摊开 5.7 米后每个只剩 419 面），而紧凑排布的小球能在 **2.28MB 的 STEP** 里产出 **426 万面**。生成物落在 `test/fixtures/stress/`（现造，不入库）。

三条边界必须说清：

1. **worker 自己的 wasm 堆在这里看不到** —— `performance.memory` 只报页面的堆，worker 的要读渲染进程 RSS，而 DSH 的沙箱不给 `ps`/`lsof`。所以"关标签后内核内存真的归还"这条，靠的是 `terminate()` 的代码路径 + 单元测试里 `terminated === true` 的断言，不是这里的数字。
2. **headless 不做 GPU 上传** —— 真机上还多一次显存/上传成本。
3. **面数上限是离散之后才判的** —— 撞上限那一次仍然要先付完整的解析时间和内存（压测里的"上限"场景就是这么跑的）。要更省，得在读文件前用文件大小/实体数做粗筛。

## 打包与升级的一个坑

profile 的 `package.json` 记的是**带版本号的绝对 tarball 路径**，pnpm 每次解析依赖图都会去读它。所以：

- **不要在 profile 还引用旧版本时删掉旧 tarball** —— 会得到 `ENOENT … dsh-cad-preview-0.1.1.tgz`，而且 `dsh plugin add` 只报 `exit code 254`，真正的错误在
  `profiles/web/.plugin-manager/logs/operation-*/pnpm.log` 里；
- 升级版本的顺序是：**先 `pnpm pack` 出新版本，再 `plugin add` 新 tarball**，旧的那份等 profile 切换过去之后再清理；
- 已经删掉了就用 `pnpm run pack:past` 从当前源码重新生成一份补回去（构建产物与版本号无关，足够骗过那一次解析）。

## 场景装配为什么要独立成 `src/client/scene.ts`

`OrbitRig` 的构造函数最后调用 `update()`，而它会在 `new` **还没返回时**就触发 `onChange`——也就是"第一次绘制发生在 `rig` 这个绑定完成初始化之前"。任何在这一帧里读到 `rig` 的代码都会撞上暂时性死区，报 `Cannot access 'rig' before initialization`，界面上表现为整个预览面板只剩这一行错误。

所以：装配逻辑放在 `scene.ts`（不依赖 React），能把 `rig` 之前就必须存在的绑定一次性看清；`test/wiring.mjs` 直接调用 `createViewerScene(canvas)`，让那条构造内绘制的路径**真的跑一遍**——把 bug 临时改回去时，这个测试会 4 项全红并报出同一句话。冒烟测试里另有一条源码级守卫，防止 `frame` 再次引用 `rig`。

## 内核下载

7.6 MB 的内核由 `/cad-preview/asset` 提供（浏览器强缓存一年）。这条路径上有两处刻意的设计：

- **字节先在客户端校验**（magic word `\0asm`）。把截断的或 HTML 错误页当 wasm 交给 emscripten，只会得到
  `Aborted(both async and sync fetching of the wasm failed). Build with -sASSERTIONS for more info.` ——
  这句话对用户毫无信息量。校验之后失败会直接说明"返回的不是 WebAssembly（N 字节，前 4 字节 …）"。
- **失败重试一次**，第二次带 `&retry=<ts>` 绕开缓存。刷新页面时正在下载的内核会中断，没有重试的话
  用户只能再刷一次页面。

校验通过后的字节交给 Worker（首次任务携带，worker 回 `kernelReady` 后不再重复搬运），内核对象活在 Worker 里，页面从不持有。

排错对照表：

| 界面上的提示 | 含义 | 处理 |
| --- | --- | --- |
| `读取失败（HTTP 400）：absolute path required` | 传了相对路径（老版本行为） | 0.1.2 起在客户端用 `scope.cwd` 还原 |
| `CAD 内核下载失败：…` | 7.6 MB 内核没拿到（网络/刷新中断） | 点「重试」；0.1.3 起会自动重试一次 |
| `Aborted(both async…)` | 内核字节缺失且未被拦截的旧路径 | 0.1.3 起这条路径已被前置校验取代 |
| `CompileError: … section … extends past end` | 字节被截断 | 同上，会先被字节校验拦下 |
| `CAD 解析线程出错：…` | worker 脚本没拿到（路由 404，通常是安装体里缺 `lib/client.worker.js`）或 worker 内异常 | 确认版本 ≥ 0.3.2 且重装过；`pnpm verify-install` 会直接检查这条路线 |
| `这个环境没有 Web Worker…` | 页面里没有 `Worker` 构造器，主线程解析被刻意拒绝 | 在正常的 DSH 窗口里打开；这不是可以"回退"的场景 |
| `网格太大（N 三角面，超过上限 12000000）` | 触发了面数上限（`MAX_TRIANGLES`） | 导出时简化模型，或只预览局部 |
| `CAD 解析已取消` | 关标签页/切文件导致的中断，属正常路径 | 无需处理：worker 已被 terminate，内存已归还 |
| **界面跟手，但永远停在「正在解析模型…」** | 加载 effect 在自我循环：某个依赖每次渲染都是新身份 | 0.3.1 的回归，0.3.3 修复；见上文 |
| 界面**卡死**（不是跟手），CPU 飙高 | 内核跑在主线程（≤0.3.1 的页面路径），或被请求洪水打满 | 升到 ≥0.3.2：页面 bundle 里已经没有任何能跑内核的代码 |

## 路径解析

dsh-better-sidebar 把文件交给预览器时，`path` 是**tab 里记的原样路径**，通常相对于会话 cwd（例如 `cad-build/named/part.step`），而插件的宿主路线只收绝对路径（浏览器没有 cwd 可解析）。因此还原发生在客户端：`load()` 拿到 `scope.cwd`，组件用 `resolveViewerPath(cwd, path)` 拼成绝对路径后再请求。这段逻辑有专门的冒烟测试覆盖。

## 外观：`ao+strong` 默认，`lines` 给「线框」按钮

| 项 | 实现 | 为什么 |
|---|---|---|
| 默认外观 | 环境光遮蔽 + 30° 结构线 + 高对比配光（ambient 0.1 / key 2.4） | 明暗差是块面可读的前提；环境光接近 1 会把所有朝向照成同一色 |
| **「线框」按钮** | 切换到 `lines`：**面隐藏 + 1° 结构线** | 30° 会滤掉圆柱侧面（24 分段每片折角 15°），1° 才留得住；而 `material.wireframe` 画的是**全部三角剖分**，几十万面时是一团噪声 |
| 结构线 | **粗线（`LineSegments2`）1px、不透明** | 以像素计宽 → 缩放时线宽与深浅恒定；粗线是 instanced 四边形，所以 `polygonOffset` **真的生效**（`GL_LINES` 不受该状态影响） |
| 深度偏移 | **只加在线上**（factor −2 / units −4），面不加 | 两处叠加只会把"面后几何透出"的余量翻倍 |
| 裁剪面 | `near = 距离×0.2%`、`far = 距离 + 半径×6`，逐帧更新 | 原来固定 0.01/100000（比值 10⁷）在建筑尺度上只有约 9 米的深度分辨力，接缝必闪；而把 `near` 按模型半径设下限又会**切掉模型** |
| 描边 / 网格 | 从 canvas 向上找到第一个不透明背景色，据此反色 | GUI 可能是深色或浅色；监听 `prefers-color-scheme` 与 documentElement 属性变化 |

## 网格格式的法向兜底

STL 允许把每个面片的法向写成 `0 0 0`，由读取方自行推导（不少导出工具就是这样）。照单全收的话 `dot(normal, light)` 处处为 0，**整个模型渲染成黑色**，看起来像预览器的缺陷而不是文件的特性。所以网格路径统一过一道 `withUsableNormals()`：法向缺失、数量不匹配、全零或含 NaN 时用 `computeVertexNormals()` 从面推导；**法向正常的文件原样保留**（文件里存的可能比推导出来的更平滑）。

STL/PLY/OBJ 的几何通常是非索引的，因此推导结果是**逐面法向**——正是 CAD 零件要的硬边着色，而不是被平均糊掉。

## 工具栏：「适配」与「重置」的分工

| 动作 | 做什么 | 不做什么 |
|---|---|---|
| **适配**（F） | 只调整相机距离，让模型全部进画面 | **不改变视角**（theta/phi 原样保留），不重新居中 |
| **重置**（R） | 模型重新居中落地 + 全部进画面 + 视角回到初始 3/4 | — |

内部对应三个动作：`place()`（居中、落地、摆 helper、测量）／`frameAll()`（只调距离）／
`resetView()`（= `place()` + `frameAll()` + 初始角度）。`place()` 必须幂等，测试里连续调用三次验证。

## 网格与坐标轴：全部在模型坐标系里

- **网格**：`GridHelper` 的线本来就建在自身的 XY 平面（y = 0）上，**水平是它的默认姿态，不需要任何旋转**。边长按模型 footprint 缩放，位置落在模型被落地的那一层——CAD 文件里的 `z = 0`。
- **原点环**：模型原点处的细蓝环，标出 `z = 0`。`RingGeometry` 建在自身的 XY 平面（竖直），所以**它需要 -90° X 旋转**——与网格相反。把两者的约定混用，正好会把其中一个立成墙。
- **取景**：相机环绕**模型体积中心**（不是地面原点），并且地面必须**完整落在画面内**——一块近边和远边都溢出画面的水平面，读起来和墙没有区别。
- **不变量**：
  1. `fit()` 里测量包围盒时，**任何由模型推导出来的对象都不得参与**（网格曾作为模型子节点被算进去，导致每次 `fit()` 漂移 6–19 m）；
  2. `fit()` 必须**幂等**（连续调用后模型位置与网格位置都不许变）；
  3. 测试断言水平面的法向用**局部 +Y**（`GridHelper` 的平面法向），用局部 +Z 测会让"竖起来的网格"显示为"水平 ✓"。

## 向上轴

CAD 与大多数三维打印/网格导出器用 **Z 轴向上**，而 three.js 的渲染习惯是 **Y 轴向上**。查看器默认按 CAD 惯例把模型绕 X 轴旋转 -90°，于是模型自身的竖直轴落到屏幕竖直方向上；`U` 按钮在两种约定之间切换，适合那些按图形惯例导出的 Y-up 网格。

「适配」会在**转正之后**重新计算包围盒，因此地面网格永远贴在模型底座上，而不是贴在一个只对某种约定成立的平面上。

## 可复跑的工具页

```bash
node test/browser/samples.mjs --port 8100          # 外观小样：三种外观 × 面色 × 描边 × 背景对照
node test/browser/samples.mjs --port 8100 --model <任意.stl>   # 追加自定义模型到菜单
node scripts/stress-browser.mjs                    # 压力页：大模型下界面是否仍然流畅
node scripts/make-screenshots.mjs                  # 用无头 Chrome 驱动小样页，重出 README 截图
```

`test/fixtures/stress/` 里是自动生成的压力测试件（例如 1728 个球体的 STEP），用来验证重模型不会冻住界面；用 `node scripts/make-stress-fixtures.mjs` 重新生成。

## 开发脚本一览

| 脚本 | 用途 |
|---|---|
| `pnpm test` | 70 项：解析、摆放、取景、外观切换、裁剪面、结构线不变量、Worker 契约 |
| **`pnpm stress`** | **稳定性压测**：拿真产物在 headless Chromium 里量"解析期间主线程卡不卡、取消能不能回收、上限是不是只报错" |
| `pnpm stress:fixtures` | 用 FreeCAD 现造重型 B-rep 模型（preset a/b），`pnpm stress` 会自动调用 |
| `scripts/check-syntax.mjs` | 客户端四个入口（含 worker）能否解析与打包 |
| `scripts/check-samples.mjs` | 在 Node 里真的 import 小样页（假 WebGL），抓未定义引用与容器缺失 |
| `scripts/probe-clip.mjs` | 全缩放范围内裁剪面不得切进模型 |
| `scripts/probe-depth.mjs` | 固定 vs 自适应裁剪面的深度分辨力对比（10⁷ 比值那笔账） |
| `scripts/probe-fatlines.mjs` | 粗线的属性与构建成本（含 `instanceStart` 段数） |
| `scripts/probe-offset.mjs` | 深度偏移折算成世界单位的量级 |
| `scripts/probe-palette.mjs` | 面色 × 背景 × 描边策略的对比度（仅供参考，见脚本内注释） |
| `scripts/probe-dupes.mjs` | 网格是否存在重复/退化面、法向是否一致 |
| `scripts/make-cone-fixture.mjs` | 生成坐标标定用圆锥（STEP 走 FreeCAD，STL 直接三角化） |
| `scripts/make-screenshots.mjs` | 无头 Chrome 驱动小样页，重新生成 README 用的截图 |

## 测试夹具

`test/fixtures/cube.step|.igs|.brep` 来自 occt-import-js 自己的测试样例（`pnpm run fetch-fixtures` 重新下载）；`.stl/.obj/.ply/.3mf` 由 `test/fixtures/make-fixtures.mjs` 现场生成，其中一个 OPC 结构合法的 3MF 是手写 ZIP 出来的（无第三方 zip 依赖）。
