# 发布到 GitHub 与插件市场

这份清单是**冷启动用**的：照着做完，这个插件就能被任何 DSH 用户搜到并安装。
里面的机制结论都在本机实测过，命令可以直接复制。第 1 节的五个决策已定，记录在下面。

---

## 0. 现状（已发布）

| 项 | 状态 |
| --- | --- |
| 版本 | 仓库里是 0.3.6；npm 上 `latest` 仍是 **0.3.5**（0.3.6 待发，只为把新 README 同步到 npm 页面） |
| 版本锁定 | git tag **`v0.3.5`**（→ `33f940d`）与 **`v0.3.6`**（→ `9deaebb`）已推到远端。实测 `add 'https://github.com/RichardYZLu/dsh-cad-preview#v0.3.6'` 装到的就是 0.3.6（8s）——README 里"加 `#tag` 锁版本"的说法成立 |
| 仓库 | `RichardYZLu/dsh-cad-preview`（MIT，署名 `Richard YZ Lu`）——已公开，已加 `dsh-plugin` 等 8 个 topic |
| npm | `dsh-cad-preview@0.3.5` 已上线；新包首次发布需网页 2FA 人工批准，见第 6 节 |
| 插件市场 | **已收录且 Verified**：https://dsh-plugin.org/plugins/richardyzlu/dsh-cad-preview —— 分类 Tools & Capabilities，收录于 2026-10-08。README 顶部已挂 `listed.svg` 徽章。**注意 slug 用全小写 owner**（`richardyzlu`），写成 `RichardYZLu` 会 404 |
| `find_dsh_plugin` | 搜得到（走 GitHub topic `dsh-plugin` 实时搜索） |
| DSH 兼容性 | 已在 **DSH 0.2.1-rc.2**（2026-10-28 更新后）上复验：npm 安装 1.8s、插件行进 `--dump-config`、四条路由全 200；客户端契约 `documentPreviews` 与 slot `sidebar.right.tab.document` 仍存在。0.2.1 相对开发时的 0.1.7-rc.2 是大版本跳变，**每次 DSH 大版本更新后都应重跑这组检查** |
| 前置依赖 | **只需 DSH 本身**。装了 `dsh-better-sidebar` 就注册成它的文件查看器；只有自带侧栏就注册进 DSH 自带的文档预览。见 README「安装」一节 |
| 挂载行 | 包内 `cordis.patch.yml` 自带 `insert` 行，`dsh plugin add` 会把它追加进 `dsh.profile.bundles` → **用户无需手改 profile** |
| 运行包内容 | `files` 白名单 8 个文件，无开发残留 |
| 许可 | MIT（`LICENSE` **只放纯 MIT 正文**，第三方清单在 `lib/THIRD-PARTY-NOTICES.md`；混写会让 GitHub 判成 `NOASSERTION`，见第 4 节第 13 条） |
| 界面截图 | `docs/screenshots/`（2 张：默认外观 + 线框，示例模型是罗马柱；README 用绝对 raw 地址引用，因此在 npm 上也能显示） |
| 自检 | `pnpm test`（70 项）、`node scripts/verify-install.mjs`（15 项） |

## 1. 已定的五件事

1. **owner / 仓库名** —— `RichardYZLu/dsh-cad-preview`。
2. **LICENSE 署名** —— `Copyright (c) 2026 Richard YZ Lu`。
3. **是否同时发 npm** —— **已发**（`dsh-cad-preview@0.3.5`）。发布路径比预想的曲折，全过程记在第 6 节。
4. **是否声明 `dsh-better-sidebar` 为 peer 依赖** —— **不声明**，只保留运行期探测。声明了会让没有该侧栏的机器多一条无意义的依赖警告，而挂载本来就不依赖它。
5. **截图 2–3 张** —— 已生成到 `docs/screenshots/`（`roman-column`、`roman-column-wireframe`，示例模型是罗马柱），由 `scripts/make-screenshots.mjs` 用无头 Chrome 驱动小样页复跑。

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

### 2.6 社区插件市场 dsh-plugin.org（已自动收录，Verified）

[dsh-plugin.org](https://dsh-plugin.org)（DSH Plugin Hub）是社区维护的插件市场，也可以装成 DSH 插件，在「设置 → 插件市场」里图形化浏览/安装。它的说明写得很清楚：**发布公开仓库 + 加 `dsh-plugin` topic，它就定期扫描并自动收录**，再人工标注分类与兼容性；另有 [提交页](https://dsh-plugin.org/submit) 可以加速。

**实际结果**：2.5 加完 topic 后**当天就自动收录了**，无需提交 Issue，并被标成 Verified：

```
https://dsh-plugin.org/plugins/richardyzlu/dsh-cad-preview
分类 Tools & Capabilities · Verified · Listed on 2026-10-08
```

两个实测注意点：

1. **URL 用全小写 owner**（`richardyzlu`）。按仓库名原样写 `RichardYZLu` 会 404，很容易误判成"没被收录"——排查时先换小写再试。
2. 收录后可以在 README 顶部挂官方徽章（模板见提交页），链接指向上面那个小写 slug 地址：

   ```markdown
   [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/richardyzlu/dsh-cad-preview)
   ```

所以 2.5 那一步同时打通了 `find_dsh_plugin` 与这个 hub —— **没有需要单独投递的"上架申请"**。

### 2.7 可选：进入人工精选列表

**https://awesome-dsh-plugin.com** 是人工维护的列表，需要去它的仓库提 PR（条目格式照现有条目：名称、一句话说明、仓库链接、`dsh plugin add …` 命令）。

### 2.8 打 tag（README 那句"加 `#tag` 锁版本"靠它才成立）

**只发版本不打 tag，README 里教用户锁版本的命令就是坏的。** 第一次发布时漏了这一步，`#v0.3.5` 其实哪都不指向。补法：

```bash
cd /Volumes/exSSD/DSH/DSH-Plugins/dsh-cad-preview
# 打成 annotated tag，指向"该版本发布时的那个提交"
git tag -a v0.3.6 9deaebb -m "dsh-cad-preview 0.3.6"
git push origin v0.3.6
# 一次推多个：git push origin v0.3.5 v0.3.6
```

验证远端确实有：

```bash
gh api repos/RichardYZLu/dsh-cad-preview/tags --jq '.[] | "\(.name)  \(.commit.sha[0:7])"'
```

再验一次**用户实际走的那条路**（这条命令会 `git ls-remote` 到 github.com，网络不通时会失败，别误判成 tag 有问题）：

```bash
"$NODE" "$BIN" plugin --profile tagtest add 'https://github.com/RichardYZLu/dsh-cad-preview#v0.3.6'
```

装完确认 `profiles/tagtest/node_modules/dsh-cad-preview/package.json` 里的 `version` 就是 tag 对应的版本。实测 0.3.6：8s 完成，装在 0.3.6。

## 3. 发布后的验证（别凭感觉）

在一台**干净的 profile** 上验证"别人能不能装上"，而不是在自己的工作目录里试（这套在 0.3.5 首发、以及 DSH 升到 0.2.1-rc.2 后都跑通过）：

```bash
NODE="$HOME/Library/Application Support/dsh-desktop/harness/.desktop-bin/node"

# CLI 的位置随 DSH 版本变过：≤0.1.x 在 app.asar.unpacked，≥0.2.1 挪进了 app.asar
# （packed asar 用随应用分发的 Electron 版 node 可以透读）。逐个试，谁能 --version 就用谁。
RES="/Applications/DSH Desktop.app/Contents/Resources"
BIN=""
for c in "$RES/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js" \
         "$RES/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
  "$NODE" "$c" --version >/dev/null 2>&1 && { BIN="$c"; break; }
done
echo "CLI: $BIN — $("$NODE" "$BIN" --version)"

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
9. **`pnpm publish` 不是 pnpm 实现的，它转调 npm CLI。** 本机没有 npm，所以 `pnpm login` / `pnpm publish` 都只报 `spawnSync npm ENOENT`。要发 npm 得先临时解出 npm（见 6.1）。
10. **新包第一次发布不会真的上线，而是进 stage 队列等人用 2FA 批准**，期间只发一个 `0.0.0-stage` 占位版本。`npm publish` 返回 `202` 看着像成功，重复发布报 `E409` 也只是"已在队列里"。批准入口在网页的 Staged Packages 一栏（见 6.4）。**这条不在 npm 的常规发布文档里，只能靠实际发一次才会发现。**
11. **别把 npm 的「安全只读保护」当成封号。**
    账号做过安全敏感操作（用 2FA recovery code 登录、改邮箱等）后，npm 会把它置为 **72 小时只读**。此时新建 access token 会报：

    > your account has been temporarily suspended due to a recent security-sensitive action.

    `suspended` 这个词很吓人，但它**不是违规封禁**：固定 72 小时、**自动解除、无需申诉、没有重新确认步骤**，期间登录/浏览/安装/下载都正常，只有发布、**管理 token**、改包可见性、改动组织成员被暂停。**已发布的包对所有人照常可用**，不受任何影响。
    从**触发那一动作**起算 72 小时，所以触发时刻能反推解除时刻（邮箱里通常有 npm 的安全提醒）。期间**别反复重试**、更**别开小号重发**——后者容易被判定为规避风控，把 72 小时自动恢复变成真的封禁。只有 72 小时后仍被拦，才该走 https://www.npmjs.com/support。
12. **bypass-2FA 的 token 路线有保质期，长期方案要用 OIDC。**
    npm 已在废弃 2FA-bypass 的 Granular Access Token：**2026-08 起**不能做账号/包/组织的敏感管理操作（建删 token、改设置、改包权限等），**约 2027-01 起**连直接发布都不行，只剩「读私有包 + stage 发布（仍需人工 2FA 批准）」。所以 6.2 那套 token 只是当下能用；仓库已经在 GitHub 上，迁移目标是 [trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) ——配好后由 GitHub Actions 发布，本机不存任何凭据，钥匙串/`.npmrc` 的问题一并消失。
13. **`LICENSE` 必须只放纯 MIT 正文，第三方清单不能附在同一个文件里。**
    原来的 `LICENSE` 在 MIT 正文后面紧接着写了「Bundled third-party components: three.js / occt-import-js / OpenCascade…」。GitHub 的许可证匹配器要求文件是标准原文，附加段落直接让它判不出来：

    ```
    gh api repos/RichardYZLu/dsh-cad-preview/license
    → {"key":"other","name":"Other","spdx_id":"NOASSERTION"}
    ```

    后果是连锁的：仓库侧栏显示 Other，dsh-plugin.org 的条目 `License` 一栏也跟着显示 `Other` —— 而 MIT 本身是用户判断"能不能放心用"的信号之一，白丢一个信任项。
    而且这在法律表述上也不对：MIT 标题不能罩住同文件里列出的 LGPL 组件。**正确做法是 LICENSE 只留 MIT 原文，第三方清单单独放在 `lib/THIRD-PARTY-NOTICES.md`**（它在 `files` 里，随包分发），README 的「许可」一节指向它。改完 GitHub 才会认出 `MIT`。

## 5. 顺带补的文档（已做）

- `test/fixtures/stress/` 里的 1700+ 球体 STEP 与 `scripts/stress-browser.mjs`、`scripts/make-stress-fixtures.mjs` 是**压力测试**资产（用于验证"重模型不再冻界面/进安全模式"）。README 开发一节已说明它们的用途与运行方式。
- `test/browser/samples.mjs` 是外观方案的**小样页**（三种外观 × 面色 × 描边 × 背景对照），README 已提到：

  ```bash
  node test/browser/samples.mjs --port 8100
  ```

- `scripts/make-screenshots.mjs` 是本次新增的：用无头 Chrome 驱动上面这个小样页，重新生成 README 与市场条目用的截图到 `docs/screenshots/`。截图不是手截的，改完外观可以一键复跑。**示例模型是罗马柱**（`CAD/roman-column/roman-column.stl`），已经在 `test/browser/samples.mjs` 的模型菜单里；换模型只要给那个脚本加 `--model <任意.stl>`。

  ```bash
  node scripts/make-screenshots.mjs                       # 全部
  node scripts/make-screenshots.mjs --only roman-column
  ```

## 6. 发布到 npm（已做：0.3.5）

npm 上 `dsh-cad-preview` 这个名字未被占用。发出去之后 `dsh plugin add dsh-cad-preview` 就能用，而且**完全不经过 git 解析**——实测安装 4.1s，比走 GitHub 的 10.8s 快一倍多。

### 6.1 先解决一个前提：本机没有 npm CLI

**`pnpm login` 和 `pnpm publish` 都不是 pnpm 自己实现的，它们会转调 npm CLI**（`pnpm.cjs` 里 `runNpm(opts.npmPath, ['publish', ...])`）。而这台机器上只有随应用分发的 Electron 版 node（`harness/.desktop-bin/node`），**没有任何 npm**：

```
pnpm login   → spawnSync npm ENOENT
pnpm publish → spawnSync npm ENOENT
```

所以发布前先把 npm 从 registry 里解出来用（不装进系统，纯临时）：

```bash
mkdir -p /tmp/npm-boot && cd /tmp/npm-boot
VER=$(curl -s https://registry.npmjs.org/npm/latest | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))")
curl -sL "https://registry.npmjs.org/npm/-/npm-$VER.tgz" -o npm.tgz && tar xzf npm.tgz
node package/bin/npm-cli.js --version     # 12.2.0
```

之后所有 npm 命令都写成 `node /tmp/npm-boot/package/bin/npm-cli.js <子命令>`。注意本机 `~/.npm/_logs` 不可写（沙箱），加一个工作区内的缓存目录即可：

```bash
export npm_config_cache=/Volumes/exSSD/DSH/DSH-Plugins/.npm-publish-cache
```

### 6.2 认证：npm 账号开了 auth-and-writes 就没有捷径

`npm login` 的浏览器授权流在本机跑不通（npm 打出的授权链接里 ID 被它自己打码）。两条可用路径：

- `npm publish --otp=<6 位码>` —— 需要能拿到验证码；
- **带 `Bypass 2FA` 的 Granular Access Token**（推荐，一次配好以后都不用码）。在 https://www.npmjs.com/settings/RichardYZLu/tokens 建，要点：**Allow this token to bypass two-factor authentication 打开**、Permissions 选 **Read and write**。写进去时用 `read` 从 stdin 读，别在命令里手打 token：

  ```bash
  read -rs TOKEN && printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > ~/.npmrc && echo "写入完成：${#TOKEN} 字符"
  ```

  验证：`node .../npm-cli.js whoami` 应回 `richardyzlu`。**只勾了权限没勾 Bypass 2FA 的 token 能过 `whoami`、但 `publish` 会报 `EOTP`**——读操作不需要 2FA，写操作需要。

### 6.3 发布

```bash
cd /Volumes/exSSD/DSH/DSH-Plugins/dsh-cad-preview
export npm_config_cache=/Volumes/exSSD/DSH/DSH-Plugins/.npm-publish-cache
node /tmp/npm-boot/package/bin/npm-cli.js pack --dry-run      # 确认只有 files 白名单 8 个 + package.json
node /tmp/npm-boot/package/bin/npm-cli.js publish --access public
```

### 6.4 ⚠️ 新包的首次发布不是发布完成，而是进了 stage 队列

**这是整个清单里最容易误判的一步。** npm 从 2026-10-02 起支持"新包走分阶段发布"，于是**新包的第一个版本不会直接上线**：

- `npm publish` 返回的是 **`HTTP 202 Accepted`**（不是 201），并提示 *"Your package is being processed and may take a few minutes to become available."* —— 这看着像成功，其实只是**入队**；
- npm 会先自动发一个占位版本 **`0.0.0-stage`** 把包名占住（占位符公开可见，但真实版本的内容在批准前不公开）；
- 再发同版本会报 **`E409 Cannot publish over previously staged version`** —— 这个报错恰恰证明版本正躺在队列里等批准；
- **必须有 maintainer 用 2FA 人工批准**（官方原文：*A human maintainer with a 2FA challenge is required to approve*）。批准这一步无论如何都要过 2FA，所以 CLI 的 bypass token 也替不了。

批准入口（网页，一分钟）：**https://www.npmjs.com/settings/RichardYZLu/staged** —— 即账号设置左侧栏的 **Staged Packages** 一栏（同栏还有 Profile / Packages / Account / Billing Info / Access Tokens），找到 `dsh-cad-preview 0.3.5 latest`，点 **Approve**（旁边还有 Reject 和 Inspect，别点 Reject）。

CLI 侧 `npm stage approve <stage-id>` 理论同效，但**本机 `npm stage list` 返回空数组**（文档说它只列"你有权限访问"的 staged 包，而 granular token 的 Packages 范围覆盖不到一个发布时还不存在的新包），所以拿不到 stage id —— 走网页更省事。

### 6.5 发布后的实测结果（0.3.5）

| 检查 | 结果 |
| --- | --- |
| `dist-tags.latest` | `0.3.5`（批准于 03:19:26 UTC） |
| `versions` | `0.0.0-stage`（占位符，保留）+ `0.3.5` |
| tarball shasum | `c4135aff76971059735c8653bff49b1eb48965fd`（与本地 `npm pack` 一致） |
| 包内文件 | 9 个 = `files` 白名单 8 个 + `package.json`；`lib/occt-import-js.wasm` 与仓库里的同一份 |
| `dsh plugin add dsh-cad-preview` | 干净 profile 里 **4.1s** 装好，`id: cad-preview` / `0.3.5` 出现在 `--dump-config` |
| 四条路由 | `ping`（`{"ok":true,...,"version":"0.3.5"}`）、`client.js`、`worker.js`、`asset?name=occt-import-js.wasm` 全部 200 |

### 6.6 两个仍然要注意的点

- **`npm publish` 不会替你跑 `pnpm test`。** 本包只有 `pretest`（构建），没有 `prepublishOnly`；`lib/` 是提交进仓库的构建产物，`publish` 也不会重新构建。发布前自己跑一次 `pnpm test`。
- **版本号即发布号。** 改完 `package.json` 的 `version` 先提交再发；npm 不允许覆盖已发布的版本，要改只能发新版本号。已存在的包再发新版本**不会再触发 stage 队列**，直接上线。
