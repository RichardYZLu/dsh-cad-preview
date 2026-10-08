# 发布到 GitHub 与插件市场

这份清单是**冷启动用**的：照着做完，这个插件就能被任何 DSH 用户搜到并安装。
里面的机制结论都在本机实测过，命令可以直接复制。第 1 节的五个决策已定，记录在下面。

---

## 0. 现状（已具备发布条件）

| 项 | 状态 |
| --- | --- |
| 版本 | 0.3.5（`package.json`） |
| 仓库 | `RichardYZLu/dsh-cad-preview`（MIT，署名 `Richard YZ Lu`） |
| 前置依赖 | **只需 DSH 本身**。装了 `dsh-better-sidebar` 就注册成它的文件查看器；只有自带侧栏就注册进 DSH 自带的文档预览。见 README「安装」一节 |
| 挂载行 | 包内 `cordis.patch.yml` 自带 `insert` 行，`dsh plugin add` 会把它追加进 `dsh.profile.bundles` → **用户无需手改 profile** |
| 运行包内容 | `files` 白名单 8 个文件，无开发残留 |
| 许可 | MIT（`LICENSE`）；第三方声明 `lib/THIRD-PARTY-NOTICES.md`（含 OCCT 的 LGPL-2.1 + OCCT exception） |
| 界面截图 | `docs/screenshots/`（3 张，README 用绝对 raw 地址引用，因此在 npm 上也能显示） |
| 自检 | `pnpm test`（70 项）、`node scripts/verify-install.mjs`（15 项） |

## 1. 已定的五件事

1. **owner / 仓库名** —— `RichardYZLu/dsh-cad-preview`。
2. **LICENSE 署名** —— `Copyright (c) 2026 Richard YZ Lu`。
3. **是否同时发 npm** —— 发，这样 `dsh plugin add dsh-cad-preview` 也能用（需要仓库主的 npm 登录）。
4. **是否声明 `dsh-better-sidebar` 为 peer 依赖** —— **不声明**，只保留运行期探测。声明了会让没有该侧栏的机器多一条无意义的依赖警告，而挂载本来就不依赖它。
5. **截图 2–3 张** —— 已生成到 `docs/screenshots/`（`building-ao`、`building-lines`、`parts-ao`），由 `scripts/make-screenshots.mjs` 用无头 Chrome 驱动小样页复跑。

## 2. 操作步骤

### 2.1 建仓库

```bash
cd /Volumes/exSSD/DSH/DSH-Plugins/dsh-cad-preview
git init
cat > .gitignore <<'EOF'
node_modules/
dist/
*.log
EOF
```

**`.gitignore` 的红线：绝不能忽略 `lib/`。** `dsh plugin add github:…` 是按 `files` 白名单打包的；`lib/` 是构建产物、不在源码里生成，不提交的话别人装到的是**空包**。`vendor/`（2.5 MB，构建用的 three 附加模块）也建议提交，否则别人 clone 后 `pnpm build` 会失败。

### 2.2 补包元数据（已做）

`package.json` 里已加：

```json
"repository": { "type": "git", "url": "git+https://github.com/RichardYZLu/dsh-cad-preview.git" },
"homepage": "https://github.com/RichardYZLu/dsh-cad-preview#readme",
"bugs": { "url": "https://github.com/RichardYZLu/dsh-cad-preview/issues" }
```

`keywords` 已含 `dsh-plugin`（npm 侧的关键词，**不是**市场发现用的那个）。

### 2.3 README 加一节「公开安装」（已做）

README 的「安装」一节现在先给 GitHub 地址，本地 tarball 流程保留在它下面：

```markdown
    dsh plugin --profile web add https://github.com/RichardYZLu/dsh-cad-preview

需要 DSH 本身即可；装了 `dsh-better-sidebar` 会额外注册到它的文件查看器。
升级：地址后面加 `#<tag>` 可锁定版本。
```

**注意用 HTTPS 地址，不要用 `github:owner/repo` 简写**（原因见第 4 节第 7 条）。

### 2.4 首次提交并推送（已做）

```bash
git add -A
git commit -F <提交信息文件>
gh repo create RichardYZLu/dsh-cad-preview --public --source=. --remote=origin --push
# 没有 gh 就在网页建空仓库后：git remote add origin … && git push -u origin main
```

### 2.5 打开市场发现开关（**唯一必做的一步**，已做）

```bash
gh repo edit RichardYZLu/dsh-cad-preview \
  --add-topic dsh-plugin --add-topic dsh --add-topic deepseek-harness \
  --add-topic cad --add-topic step --add-topic threejs \
  --add-topic opencascade --add-topic 3d-preview
```

在 GitHub 仓库页面右侧 **Topics** 里加 `dsh-plugin` 同样有效。插件的"市场"就是 **GitHub topic `dsh-plugin` 的实时搜索、按 star 排序**——没有单独的提审流程。加完 topic 后，用 `find_dsh_plugin` 工具（本机实测：加完 topic 立刻就能搜到，无需等待）应当能搜到。

### 2.6 社区插件市场 dsh-plugin.org（自动收录，无需提交）

[dsh-plugin.org](https://dsh-plugin.org)（DSH Plugin Hub）是社区维护的插件市场，也可以装成 DSH 插件，在「设置 → 插件市场」里图形化浏览/安装。它的说明写得很清楚：**发布公开仓库 + 加 `dsh-plugin` topic，它就定期扫描并自动收录**，再人工标注分类与兼容性；另有 [提交页](https://dsh-plugin.org/submit) 可以加速。

所以 2.5 那一步同时打通了 `find_dsh_plugin` 与这个 hub —— **没有需要单独投递的"上架申请"**。

### 2.7 可选：进入人工精选列表

**https://awesome-dsh-plugin.com** 是人工维护的列表，需要去它的仓库提 PR（条目格式照现有条目：名称、一句话说明、仓库链接、`dsh plugin add …` 命令）。

## 3. 发布后的验证（别凭感觉）

在一台**干净的 profile** 上验证"别人能不能装上"，而不是在自己的工作目录里试（下面这套在 0.3.5 发布时已跑通）：

```bash
NODE="$HOME/Library/Application Support/dsh-desktop/harness/.desktop-bin/node"
BIN="/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js"

# 从随应用分发的模板造一个干净 profile
"$NODE" "$BIN" --profile publishtest --from-default-profile web --dump-config >/dev/null
# 用公开 HTTPS 地址安装（验证的就是别人走的那条路）
"$NODE" "$BIN" plugin --profile publishtest add https://github.com/RichardYZLu/dsh-cad-preview
# 插件行应当出现在组合后的配置里
"$NODE" "$BIN" --profile publishtest --dump-config | grep -A5 'id: cad-preview'
# 起一个独立端口看效果
"$NODE" "$BIN" --profile publishtest --host 127.0.0.1 --port 4321 --no-open
```

这一趟的实测结果（0.3.5）：

| 检查 | 结果 |
| --- | --- |
| `pnpm add` 耗时 | 10.8s（含克隆公开仓库） |
| `--dump-config` | 出现 `- id: cad-preview / name: dsh-cad-preview`，`version: 0.3.5` |
| `/cad-preview/ping` | 200 · `{"ok":true,"plugin":"dsh-cad-preview","version":"0.3.5"}` |
| `/cad-preview/client.js` | 200 |
| `/cad-preview/worker.js` | 200 |
| `/cad-preview/asset?name=occt-import-js.wasm` | 200 · `application/wasm` · 7,604,031 字节 |

验证完删掉 `profiles/publishtest/`。

发布前的本机自检：

```bash
pnpm test                        # 70 项
node scripts/check-syntax.mjs    # 四个入口能否解析/打包
node scripts/verify-install.mjs --model <某个 .step>
```

## 4. 踩过的坑（别再踩一次）

1. **不要把 `dsh-better-sidebar` 写进 `package.json` 的 `dsh.client.inject`。**
   客户端加载器读的是这里（`optionalStringArray(pkgName, "dsh.client.inject", decl.inject)`），**不是**模块里的 `export const inject`。旧包声明了它，结果没有 better-sidebar 的机器上插件**整块不执行**、还不报错。现在 manifest 不声明，挂载靠运行期 `ctx.inject([...])` 探测；`pnpm test` 里有一条测试专门守这个。
2. **`files` 是白名单**：新增运行时资源（例如 `lib/client.worker.js`）必须同时加进 `files`，否则包能装上但功能缺失。
3. **别删 profile 还在引用的 tarball**：profile 的 `package.json` 记的是带版本的绝对 tarball 路径，删掉会让后续任何 `dsh plugin add` 只报 `exit code 254`，真实原因是 `ENOENT … .tgz`。升级顺序是**先 pack 新版本、再 add 新 tarball**。
4. **`lib/` 必须提交**（见 2.1）。
5. **OCCT 的许可声明必须随仓库发布**：`lib/THIRD-PARTY-NOTICES.md` 已在 `files` 里，别从仓库里删。
6. **不要提交 `node_modules/`、`dist/`**；`dist/*.tgz` 是本地安装用的历史产物。
7. **分享给用户的安装命令必须是完整 HTTPS 地址，不能写 `github:owner/repo` 简写。**
   pnpm 会把简写解析成 `git+ssh://git@github.com/owner/repo.git` 再 `git ls-remote`；没配 GitHub SSH key 的机器（大多数用户）当场 `Permission denied (publickey)`，报错还伪装成"仓库不存在或没权限"。本机用一个干净 profile 实测复现：`add github:RichardYZLu/dsh-cad-preview` 失败，`add https://github.com/RichardYZLu/dsh-cad-preview` 成功。**这条只在真发布之后才会暴露**——写清单时仓库还不存在，命令是"看起来对"的。
8. **README 里的图用绝对 raw 地址**（`https://raw.githubusercontent.com/…`），不要用相对路径：`docs/` 不在 npm 包的 `files` 白名单里，相对路径在 npm 页面上是坏图。

## 5. 顺带补的文档（已做）

- `test/fixtures/stress/` 里的 1700+ 球体 STEP 与 `scripts/stress-browser.mjs`、`scripts/make-stress-fixtures.mjs` 是**压力测试**资产（用于验证"重模型不再冻界面/进安全模式"）。README 开发一节已说明它们的用途与运行方式。
- `test/browser/samples.mjs` 是外观方案的**小样页**（三种外观 × 面色 × 描边 × 背景对照），README 已提到：

  ```bash
  node test/browser/samples.mjs --port 8100
  ```

- `scripts/make-screenshots.mjs` 是本次新增的：用无头 Chrome 驱动上面这个小样页，重新生成 README 与市场条目用的三张截图到 `docs/screenshots/`。截图不是手截的，改完外观可以一键复跑。

  ```bash
  node scripts/make-screenshots.mjs            # 全部
  node scripts/make-screenshots.mjs --only building-ao
  ```

## 6. 发布到 npm

npm 上 `dsh-cad-preview` 这个名字**未被占用**（实测 `https://registry.npmjs.org/dsh-cad-preview` 返回 404）。发出去之后 `dsh plugin add dsh-cad-preview` 就能用，而且**完全不经过 git 解析**——比自己写 HTTPS 地址还稳。

```bash
# 一次性登录；开了 2FA 的账号会要 OTP
pnpm login

# 先确认包里到底是什么：files 白名单 8 个文件
pnpm pack --dry-run

# 发布（非 scoped 包默认就是 public）
pnpm publish --access public
```

发布后验证：

```bash
npm view dsh-cad-preview version dist.tarball
"$NODE" "$BIN" plugin --profile publishtest2 add dsh-cad-preview
```

两个容易踩的点：

- **`pnpm publish` 不会替你跑 `pnpm test`。** 本包只有 `pretest`（构建），没有 `prepublishOnly`；`lib/` 是提交进仓库的构建产物，`publish` 也不会重新构建。所以发布前自己跑一次 `pnpm test`。
- **版本号即发布号。** 改完 `package.json` 的 `version` 先提交再发；npm 不允许覆盖已发布的版本，要改只能发新版本号。
