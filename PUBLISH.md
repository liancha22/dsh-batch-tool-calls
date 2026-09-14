# 发布 dsh-batch-tool-calls

这份部署里，DSH 插件管理器支持的来源总共五种（`plugin-manager.py` 的子命令）：
`npm` / `github` / `release` / `download`（任意压缩包 URL）/ `import`（本地压缩包）。
按「别人怎么装」挑一条即可。

## 0. 先搞清楚 npm 现在的 token 规则（2026-09 现状）

npm 的安全策略这两年改了几轮，网上很多老教程已经不对了：

- **经典 token（Classic Token / Automation Token）已经不存在**：2025-11-05 起禁止新建，2025-11-19 全部吊销。
- 现在只有一种：**Granular Access Token（细粒度令牌，GAT）**。新建的写权限 token 默认**强制 2FA**，
  另有一个 **Bypass 2FA** 开关。带写权限的 GAT **最长 90 天**。
- **Bypass 2FA 的 GAT 已被限制**：不能再做建/删 token、改包权限与维护者等敏感操作（2026-07-31 起）；
  npm 计划 **2027-01 起连「直接发布」也取消**，届时自动化发布要走 **Trusted Publishing（OIDC）** 或 staged publishing。
- 本机交互式登录给的是**短期会话凭据（约 2 小时）**，不再发长期本地发布 token。

所以：**本机发一次 = 用浏览器登录（不用 token）；长期/CI = 用 Trusted Publishing（也不用 token）。**

来源：[npm 经典 token 废止](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/) ·
[Bypass 2FA token 限制](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/) ·
[Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers)

## 1. 发布前检查（都已实测过，方便你复用到别的插件）

| 项 | 命令 | 现状 |
| --- | --- | --- |
| 包名没被占用 | `npm view dsh-batch-tool-calls version` | 404 = 可用（2026-09-14 实测；registry 可达） |
| 测试 | `npm install && npm test` | 25 + 6 项通过 |
| 打包内容 | `npm pack --dry-run` | 8 文件 / ~12 KB，无多余文件、无密钥 |
| 许可证 | — | MIT（`LICENSE` 已带） |
| `repository` 字段 | — | **建议填**：插件管理器读它当插件来源（UI 里可点进仓库） |
| `author` 字段 | — | 建议填（npm 页面上显示） |

填元数据：

```bash
cd /root/.dsh/plugin-src/dsh-batch-tool-calls
npm pkg set author="你的名字 <you@example.com>" \
          repository.type=git \
          repository.url="git+https://github.com/<you>/dsh-batch-tool-calls.git" \
          homepage="https://github.com/<you>/dsh-batch-tool-calls" \
          bugs.url="https://github.com/<you>/dsh-batch-tool-calls/issues"
```

## 路线 A：npm（推荐 —— 别人一条命令就能装，还能自动检查更新）

### A-1 本机发布（推荐，不需要自己建 token）

```bash
# 1) 手机浏览器登录 npmjs.com（没账号先注册 + 验证邮箱），保持登录状态
# 2) 在终端跑：终端会给出一个网址和短码，用手机浏览器打开那个网址确认授权
npm login --auth-type=web
npm whoami          # 应打印你的用户名

# 3) 立刻发布（本机凭据约 2 小时有效，过期重新 login；无 scope 的包默认 public）
npm publish
# 如果账号开了 2FA 并提示要验证码：npm publish --otp=123456
```

### A-2 想用 token（给 CI，或不想每次登录）

1. 打开 <https://www.npmjs.com/settings/~/tokens> → **Generate New Token** → **Granular Access Token**。
2. 表单怎么填：
   - **Token name**：随意，例如 `publish-dsh-batch-tool-calls`
   - **Expiration**：临时用选 7 天；给 CI 用选允许的最长（写权限上限 90 天）
   - **Packages and scopes → Permissions**：**Read and write**（发布必须写权限）
   - **包范围**：还没发布过就选 **All packages**（发布后再改成限定到本包更安全）
   - **Bypass 2FA**：勾上 → 终端发布不必输验证码（但如上所述，这类 token 的敏感操作已被限制、2027-01 起会失去直接发布能力）；不勾 → 每次 `npm publish --otp=123456`
3. Generate → 复制那串 `npm_...`（**只显示一次**）。
4. 写进本机配置（**不要提交进 git、不要贴到聊天里**）：

   ```bash
   npm config set //registry.npmjs.org/:_authToken=npm_xxxxx
   npm whoami
   ```

5. 泄漏了就回同一个页面 **Revoke** 掉，重新生成一个。

### A-3 别人怎么装

```bash
# 应用内：插件页 → 从 npm 安装 → 填 dsh-batch-tool-calls（可带 @版本）
python3 "$DSH_HOME/plugin-manager.py" npm dsh-batch-tool-calls
# 或者 dsh CLI：dsh plugin --profile <profile> add dsh-batch-tool-calls
```

装完**重启该 profile** 才生效（提示段在插件激活时注册）。

### A-4 发新版 / 发错了

```bash
npm version patch -m "v%s"   # 没有 git 仓库时只改版本号，不报错
npm publish
npm deprecate dsh-batch-tool-calls@1.0.0 "有问题的原因"   # 发错了用这个
# 发布 72 小时内可 npm unpublish dsh-batch-tool-calls@1.0.0（更推荐 deprecate）
```

## 路线 B：GitHub 仓库（不需要 npm 账号，也不需要 GitHub token）

**前提：仓库必须 public。** 下载器不带任何鉴权（`plugin-manager.py` 匿名请求 `api.github.com`
和 `codeload.github.com`），私有仓库只会得到 404。

**仓库布局**：`package.json`（含 `dsh.bundle.patch`）放在仓库根目录最稳。管理器解包后向下最多
5 层寻找带 `dsh.bundle` 的 `package.json`，一个仓库最多 30 个插件；多插件仓库要装某一个时，
把子目录写进第 3 个参数。

**当前状态：已发布并推送完成。** 仓库 <https://github.com/liancha22/dsh-batch-tool-calls>
（public，默认分支 `main`），本机用 SSH key 推上去，远端 HEAD = 本地 commit。以后每改一版：

```bash
cd /root/.dsh/plugin-src/dsh-batch-tool-calls
git add -A && git commit -m "feat: ..." && git push
```

推送凭据是本机 `/root/.ssh/id_ed25519`（对应 GitHub 上名为 `dsh-android` 的那把 SSH key），
remote 已设成 `git@github.com:liancha22/dsh-batch-tool-calls.git`；HTTPS + fine-grained PAT 的
做法见 B-1（现在用不到）。别人安装：

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-batch-tool-calls
```

**别人怎么装**（应用内：插件页 → 从 GitHub 安装 → 填 `owner/repo`，可带 `/分支或标签/子目录`）：

```bash
python3 "$DSH_HOME/plugin-manager.py" github <owner> <repo>           # 默认 HEAD
python3 "$DSH_HOME/plugin-manager.py" github <owner> <repo> v1.0.0    # 指定标签或分支
python3 "$DSH_HOME/plugin-manager.py" github <owner> <repo> main/lib  # 分支 + 子目录
```

第 3 个参数支持 `feature/foo` 这类带斜杠的分支（最长匹配探测）。管理器先把这个 ref 解析成
commit SHA，再下载该 commit 的 tar.gz —— 所以**每个人装到的是固定版本**，仓库后来的改动
不会影响已经装好的人；要让他们拿到新版，得让他们重新执行一次安装。

### B-1 那 GitHub 什么时候要 token？

只有「推代码」才需要，**分享/安装插件永远不需要**。二选一：

- **SSH key（推荐，不用管过期）**：`ssh-keygen -t ed25519 -C "你的邮箱"` → 把
  `~/.ssh/id_ed25519.pub` 贴到 <https://github.com/settings/keys> → remote 用
  `git@github.com:<owner>/<repo>.git`
- **fine-grained PAT**：<https://github.com/settings/personal-access-tokens/new> →
  Repository access 选目标仓库 → Permissions → **Contents: Read and write** → 生成
  `github_pat_...`。push 时用户名填 GitHub 用户名、密码位置填这个 token，或直接：
  `git push https://<用户名>:<token>@github.com/<owner>/<repo>.git main`
  （token 会留在 shell 历史和 `git remote` 里，用完记得 Revoke）

GitHub Actions 里自动发 npm **不需要** 用 GitHub token 做 npm 认证 —— 那是 npm 侧的
Trusted Publisher（OIDC）；只有退化成 Granular token 时才要把 `NPM_TOKEN` 存进仓库 Secrets。

## 路线 C：GitHub Release 附件

Release 里放**恰好一个** `.zip` / `.tar.gz` / `.tgz` 附件（放多个会被拒绝），然后：

```bash
python3 "$DSH_HOME/plugin-manager.py" release <owner> <repo> latest   # 或指定 tag
```

## 路线 D：直接分享压缩包（最快，零账号）

```bash
# 导出（应用插件页也有"导出"按钮；插件得先装进某个 profile）
python3 "$DSH_HOME/plugin-manager.py" export '["dsh-batch-tool-calls"]' /sdcard/dsh-batch-tool-calls.zip

# 对方安装：应用插件页 → 本地导入 / 从链接导入
python3 "$DSH_HOME/plugin-manager.py" import <本地压缩包>
python3 "$DSH_HOME/plugin-manager.py" download <压缩包直链>
```

## 可选：打 tag 自动发布（GitHub Actions）

npm 现在推荐 **Trusted Publishing（OIDC）**：在 npm 网站上把「包 ↔ GitHub 仓库 ↔ workflow 文件」绑好，
Actions 里用 `id-token: write` 就能发布，**一个长期密钥都不用存**。
先在 <https://www.npmjs.com/> 的包设置里配置 Trusted Publisher（owner / repo / workflow 文件名，例如 `publish.yml`），
再放这个 workflow：

```yaml
name: publish
on:
  push:
    tags: ['v*']
jobs:
  npm:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write          # Trusted Publishing 必需
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm install
      - run: npm test
      - run: npm publish --provenance --access public
```

如果暂时只有 Granular token（不推荐长期使用，2027-01 起会失去直接发布能力），把最后一步换成
`env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }`，并把这个 token 存进仓库 Secrets。

## 发布之后

- 别人装完同样要**重启 profile**：提示段是在插件激活时注册的。
- 插件管理器把 `repository` 字段当插件来源显示，填好后 UI 里能直接跳到仓库。
- 想验证「别人视角」的安装流程，最省事的办法是先自己走一遍路线 D：
  `export` 出压缩包 → `import` 回去，确认能装、能重启生效。
- 版本升级时记得同步 `README.md` 里提到的行为（配置键、默认值）。
