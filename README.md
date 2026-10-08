# dsh-cad-preview

在 DSH 右侧栏里直接查看 3D 模型。打开文件树里的 `.step`、`.stl` 这些文件，侧栏里就是一个可以旋转、缩放、剖视的几何体，不用切到别的软件。

![罗马柱 · 默认外观](https://raw.githubusercontent.com/RichardYZLu/dsh-cad-preview/main/docs/screenshots/roman-column.png)

## 支持的格式

| 格式 | 解析方式 | 说明 |
| --- | --- | --- |
| `.step` `.stp` | OpenCascade（WASM） | B-rep 离散：读实体、曲面与单位 |
| `.iges` `.igs` | OpenCascade（WASM） | 同上 |
| `.brep` `.brp` | OpenCascade（WASM） | OCCT 原生 BREP |
| `.stl` | three.js STLLoader | 二进制与 ASCII 均可 |
| `.3mf` | three.js 3MFLoader | 按 OPC 包解析 |
| `.obj` | three.js OBJLoader | 只取几何，忽略材质 |
| `.ply` | three.js PLYLoader | ASCII 与二进制均可 |

打开文件后，顶栏会显示：文件大小 · 包围盒尺寸（mm）· 三角面数 · 解析耗时。

## 大模型不会拖住界面

`.step` 这类 B-rep 文件要交给 OpenCascade 才能算出形状，而这一步是**同步、一口气跑完**的，内存需求能到 GB 级。DSH 的右侧栏和聊天界面共用同一个渲染进程，因此这段计算如果放在页面主线程上，会把整个界面按住不放。

预览器把它放进了 **Web Worker**：页面 bundle 里没有 CAD 内核，内核只存在于 `lib/client.worker.js`。由此得到：

- 解析期间界面照常响应，可以继续滚动、切换标签；
- 关掉标签页即刻释放内核内存；
- 取消解析直接终止线程，不必等它跑完；
- 坏文件最多烧掉它自己那个 Worker。

## 安装

**前置只有 DSH 本身**，没有其它依赖。预览器会挂到它能找到的侧栏上：

| 你的环境 | 挂到哪里 |
| --- | --- |
| 装了 `dsh-better-sidebar` | 注册成它的文件查看器（`.step` 等直接开标签页） |
| 只有 DSH 自带侧栏 | 注册进 DSH 自带的文档预览 |
| 两者都有 | 两处都注册，互不影响 |

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-cad-preview
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add https://github.com/RichardYZLu/dsh-cad-preview
```

> 请用**完整的 HTTPS 地址**，不要写成 `github:RichardYZLu/dsh-cad-preview` 简写：pnpm 会把简写解析成 `git+ssh://`，没配 GitHub SSH key 的机器会直接 `Permission denied (publickey)` 装不上。

装完**重启 DSH Desktop**，插件的两半都在启动时挂载。

升级：地址后面加 `#<tag>` 可锁定版本（例如 `https://github.com/RichardYZLu/dsh-cad-preview#v0.3.5`）；不带 `#` 则跟随默认分支上的最新提交。

### 卸载

```sh
dsh plugin --profile web remove dsh-cad-preview
```

## 操作

鼠标 / 触控板：

- **左键拖动**旋转
- **右键拖动**（或 Shift + 左键）平移
- **滚轮**缩放；触控板与触屏支持双指缩放

工具条与快捷键：

| 按钮 | 快捷键 | 作用 |
| --- | --- | --- |
| 线框 | `W` | 隐藏面，只画结构线 |
| Z/Y 轴向上 | `U` | 在 CAD（Z 向上）与图形（Y 向上）两种约定之间切换 |
| 网格 | `G` | 地面网格 + 坐标轴 |
| 适配 | `F` | 重新框选模型，**不改变当前视角** |
| 重置 | `R` | 模型重新居中落地 + 全部进画面 + 视角回到初始 |

右下角三根带字母的彩色箭头（红 X / 绿 Y / 蓝 Z）是方向指示器，随视角实时旋转，用来看清模型自身坐标系的朝向。

## 外观

默认外观是 `ao+strong`：环境光遮蔽压暗接缝，再用 30° 结构线勾出块面 —— CAD 的块面结构主要靠明暗差读出来。本页最上面那张就是默认外观。

点工具条的「线框」切到 `lines`：隐藏面、只留结构线，并把提取阈值降到 1°，这样圆柱侧面的折边也能保留下来。

![罗马柱 · 线框](https://raw.githubusercontent.com/RichardYZLu/dsh-cad-preview/main/docs/screenshots/roman-column-wireframe.png)

两张图都是真实模型的实际渲染（罗马柱，柱身凹槽与柱础、柱头的曲面），由 [`scripts/make-screenshots.mjs`](scripts/make-screenshots.mjs) 生成，可以重新复跑。

## 常见问题

### 通过隧道 / 局域网域名访问时全是 403

插件内部的几条路线都带 Host 信任栅栏，默认只认 loopback。用 `dsh.example.com` 这类域名打开 GUI 时，需要把这个域名加进信任列表：

```yaml
# profile 的 cordis.patch.yml
- id: cad-preview
  name: dsh-cad-preview
  config:
    trustedHosts:
      - dsh.example.com
    maxModelBytes: 8589934592
```

信任名单每次请求都会重新收集，并且**已经给 `/api`、`/sidebar` 放行过的域名会被自动继承**——通常只要在 DSH 那边配过一次，这里就不用再配。被拒绝时，响应体会直接写出是哪个域名被挡下、该改哪个配置项。

### 界面上的提示是什么意思

| 提示 | 含义 | 处理 |
| --- | --- | --- |
| `CAD 内核下载失败：…` | 7.6 MB 的 OpenCascade 内核没取到（网络中断等） | 点「重试」；插件本身也会自动重试一次 |
| `这个环境没有 Web Worker…` | 当前页面没有 `Worker`，主线程解析被刻意拒绝 | 在正常的 DSH 窗口里打开 |
| `网格太大（… 超过上限 12000000）` | 三角面数超过上限 | 导出时简化模型，或只预览局部 |
| `CAD 解析已取消` | 关标签页 / 切换文件导致的中断，属正常路径 | 无需处理 |
| `CAD 解析线程出错：…` | 解析线程的脚本没加载到，或线程内异常 | 确认版本 ≥ 0.3.2 后重装 |

## 许可

MIT。`lib/occt-import-js.wasm` 打包了 [occt-import-js](https://github.com/kovacsv/occt-import-js)（MIT）与 OpenCascade Technology（LGPL-2.1 + OCCT exception），许可全文随包提供：`lib/THIRD-PARTY-NOTICES.md`。

---

要改这个插件、或了解内部实现与设计取舍，见 [`DEVELOPMENT.md`](DEVELOPMENT.md)；发布流程见 [`PUBLISHING.md`](PUBLISHING.md)。
