# localIM · 局域网聊天室

局域网内开箱即用的聊天室：**免密登录（只填主机名）**、**文字 + 图片 + 文件**、**消息长期保存在服务端**、**Docker 部署 + 数据卷持久化**。

## 特性

| 能力 | 说明 |
| --- | --- |
| 免密登录 | 不校验密码，用户名按内网 IP 自动派生（192.168.5.102 → ID102），也可自己改 |
| 自动命名 | 同名自动加序号（ID102-2）；换 IP 后自动跟随；手动改过的名字不会被覆盖 |
| 自动登录 | 签名 Cookie 记录身份，关掉浏览器下次打开直接进 |
| 文字聊天 | Enter 发送 / Shift+Enter 换行，链接自动可点 |
| 图片收发 | 点击按钮选择、Ctrl+V 粘贴、直接拖拽到窗口三种方式 |
| 文件发送 | 📎 按钮发送任意类型文件（也可粘贴/拖拽）；服务端暂存 **24 小时**，过期自动清理，过期后聊天里的卡片会显示"已过期" |
| 历史消息 | 服务端长期保存，进入即看最近 50 条，向上滚动加载更早 |
| 在线状态 | 右上角查看在线成员与人数，进出有系统提示 |
| 持久化 | 消息、用户、图片、Cookie 密钥全部写入数据目录，容器重建不丢 |

## 用户名规则

用户名由**服务端**根据客户端的内网 IP 派生，前端改不了这个结果（只能改显示名）：

```
192.168.5.102  →  主机号 102  →  ID102
10.0.0.7       →  主机号   7  →  ID7
```

- **登录页自动预填**：打开页面时服务端把派生好的名字一起返回，输入框已经填好，直接点「进 入」即可；想改就改。
- **重名自动加序号**：两台机器主机号相同时，后到的显示 `ID102-2`、`ID102-3`。冲突只按**当前在线**的人判断，前一个下线后，后来者下次进入会自动收回 `ID102`。
- **换 IP 自动跟随**：名字仍是 `ID102` 这种自动格式的用户，换了 IP 后再次进入会更新为新的主机号（例如 `ID103`）。**手动改过名字的用户不会被覆盖**。
- **改名**：进聊天室后点右上角自己的名字即可修改；改名框留空提交，就恢复成按 IP 自动生成的名字。

## 快速开始

### 方式一：Docker（推荐）

```bash
docker compose up -d --build
# 局域网内访问 http://<宿主机IP>:3000
```

数据会落在本项目的 `./data` 目录，映射关系见 `docker-compose.yml`：

```yaml
volumes:
  - ./data:/app/data
```

常用命令：

```bash
docker compose logs -f      # 看日志
docker compose restart      # 重启（数据不丢）
docker compose down         # 停止并移除容器（./data 仍保留）
```

### 方式二：用 GHCR 上已构建好的镜像

项目自带 GitHub Actions 发布流程（见下文），镜像会推送到 `ghcr.io/<owner>/<repo>`：

```bash
docker pull ghcr.io/<owner>/<repo>:latest

docker run -d \
  --name localim \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ./data:/app/data \
  ghcr.io/<owner>/<repo>:latest
```

镜像同时提供 `linux/amd64` 与 `linux/arm64`，树莓派等 ARM 设备可直接拉取。

### 方式三：直接 Node 运行

```bash
npm install
npm start
# 默认 http://0.0.0.0:3000，数据写在 ./data
```

## 目录结构

```
localIM/
├── server/
│   ├── index.js      # Express + Socket.IO：登录、上传、文件下载、实时推送
│   ├── store.js      # 持久化层（messages.jsonl / users.json / files.json）+ 过期文件清理
│   ├── media.js      # 读取图片真实宽高、MIME 白名单
│   └── config.js     # 端口、目录、体积上限等配置
├── public/
│   ├── index.html    # 登录页 + 聊天室
│   ├── style.css     # 亮/暗主题
│   └── app.js        # 前端逻辑（收发、历史、在线成员）
├── scripts/smoke-test.js
├── Dockerfile
├── docker-compose.yml
└── data/             # 运行时生成，Docker 中映射到宿主机
    ├── messages.jsonl
    ├── users.json
    ├── files.json
    ├── .cookie-secret
    ├── uploads/YYYYMM/   # 聊天图片（长期保存）
    └── files/YYYYMM/     # 聊天文件（24 小时过期）
```

## 持久化说明

| 文件 | 内容 |
| --- | --- |
| `data/messages.jsonl` | 每行一条消息的追加日志，启动时全量载入内存 |
| `data/users.json` | 用户 ID → 名字、最后活跃时间 |
| `data/files.json` | 已发送文件的注册表（fileId → 文件名、过期时间等），供下载接口定位 |
| `data/uploads/YYYYMM/` | 聊天图片原文件（长期保存） |
| `data/files/YYYYMM/` | 聊天文件（文件名编码过期时间，24 小时后由服务端自动清理） |
| `data/.cookie-secret` | Cookie 签名密钥，保留它重启后仍保持登录态 |

备份整个 `data` 目录即可迁移聊天记录。

## 文件发送与过期清理

- 聊天中的**图片长期保存**；其他类型文件（压缩包、文档、视频等）**服务端暂存 24 小时**。
- 有效期从**上传时刻**起算，过期时间同时写进落盘文件名（`${fileId}-${expiresAt}${ext}`）与消息数据（`file.expiresAt`），前端据此把过期文件渲染为"已过期"卡片。
- 服务端每隔一段时间（默认 10 分钟）扫描清理：
  1. 按文件名里的过期时间删除 `files/` 下已过期文件（权威依据，注册表丢失也不影响清理）；
  2. 同步移除 `files.json` 注册表中过期条目；
  3. 上传后超过 30 分钟仍未发送的孤儿文件一并删除。
- 下载接口 `GET /api/files/:fileId` 对过期/已清理的文件返回 `410 Gone` / `404`，前端对应显示"文件已过期"。
- 下载响应强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`，任意类型的文件都只会被保存而不会被浏览器渲染，避免 HTML/SVG 类文件的脚本注入。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `<项目>/data` | 数据目录，Docker 内为 `/app/data` |
| `MAX_UPLOAD_MB` | `10` | 单张图片大小上限（MB） |
| `MAX_FILE_MB` | `200` | 单个文件大小上限（MB），`0` 表示不限 |
| `FILE_TTL_HOURS` | `24` | 发送的文件有效期（小时），过期后下载失效并被清理 |
| `FILE_GC_MINUTES` | `10` | 过期文件清理的扫描间隔（分钟） |
| `HISTORY_PAGE` | `50` | 进入聊天室时下发的历史条数 |
| `NAME_PREFIX` | `ID` | 自动派生名字的前缀，改成 `PC` 就是 `PC102` |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | 信任哪些上游代理的 `X-Forwarded-For`。默认只信任本机和内网代理，避免伪造 IP 冒用身份；若前面是**公网**反向代理，设为 `true` |
| `PUID` / `PGID` | `1000` | Docker 内运行用户，避免数据目录出现 root 属主 |

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/me` | 当前登录用户；未登录时一并返回 `ip`、`suggestedName`（按 IP 派生好的名字）与 `limits`（上传上限） |
| POST | `/api/login` | `{name}` 登录或改名；`name` 留空则按 IP 自动派生 |
| POST | `/api/logout` | 清除 Cookie |
| GET | `/api/messages?limit=&before=` | 历史消息 |
| POST | `/api/upload` | `multipart` 上传：字段 `image`（图片，长期保存）或 `file`（任意文件，24 小时过期），返回 `fileId` |
| GET | `/api/files/:fileId` | 下载文件；过期或已被清理返回 `410`/`404` |

WebSocket 事件：`init` / `msg:new` / `sys` / `presence` / `history:load` / `msg:send`。

## 自动发布（GitHub Actions）

工作流：`.github/workflows/docker-publish.yml`

| 触发条件 | 行为 |
| --- | --- |
| push 到 `main` / `master` | 跑测试 → 构建 amd64 + arm64 → 推送 `latest` 与分支标签 |
| push tag `v1.2.3` | 额外推送 `v1.2.3`、`1.2` |
| Pull Request | 只构建 amd64 验证，**不推送** |
| 手动触发 (`workflow_dispatch`) | 可指定平台、可关闭推送 |

产物推送到 **GitHub Container Registry**：`ghcr.io/<owner>/<repo>`。

使用前提：

1. 仓库 **Settings → Actions → General → Workflow permissions** 选 *Read and write permissions*（工作流已声明 `packages: write`，用的是内置 `GITHUB_TOKEN`，无需额外配置密钥）。
2. 发版打标签即可：

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. 镜像默认**私有**，需要在仓库的 Packages 页面改为 Public，或让拉取方用 `docker login ghcr.io` 登录。

要点：依赖安装用 `npm ci`（以 `package-lock.json` 为准），镜像构建用 GitHub Actions 缓存（`type=gha`）加速，ARM 架构通过 QEMU 模拟构建。

## 镜像体积

`docker images` 显示的是**解压后**大小， registry（GHCR）上显示的是**压缩后**大小，两者差 2~3 倍。

| 方案 | 解压后 | 构成 |
| --- | --- | --- |
| `Dockerfile.full`（Node 官方镜像） | ~166 MB | base 159.5 MB（node 运行时层 146 MB，含 npm / corepack / 头文件）+ 应用 7 MB |
| `Dockerfile`（默认，Alpine 官方 nodejs 包） | ~55 MB | alpine 8 MB + nodejs 及依赖 42 MB + 应用 7 MB |

精简做法：

1. **多阶段构建** —— 构建期用 `node:22-alpine` 跑 `npm ci`，运行期换 `alpine:3.22` + `apk add nodejs`（18.5 MB）。运行时不需要 npm / corepack / C++ 头文件，这些占了官方镜像的大头。
2. **清理依赖** —— 删除 `node_modules` 里的 `@types`、`*.d.ts`、`*.md`、`LICENSE`、`*.map`（约 4 MB）。
3. `icu-data-full` + `tzdata`（12 MB）是为了中文和 `Asia/Shanghai` 时区正确；若只要英文/UTC，换成 `icu-data-en` 并去掉 `tzdata` 可再省 12 MB。

> 注意：在 Dockerfile 里 `rm -rf` 基础镜像自带的文件**不会**让镜像变小——overlayfs 只是加了 whiteout，底层数据还在。要变小必须在最终阶段里不包含它们（即换基础镜像 / 多阶段复制），这也是上面方案 1 的原因。

想排查体积分布：

```bash
docker history localim:1.0.0          # 看每层大小
dive localim:1.0.0                    # 交互式查看（需装 dive）
```

如果精简版在你环境有问题，用 `docker build -f Dockerfile.full -t localim:full .` 回退到官方镜像版本。

## 测试

```bash
npm test
```

会拉起临时实例（另起一个短 TTL 实例验证文件过期清理），用 `X-Forwarded-For` 模拟不同内网 IP，覆盖：按 IP 自动命名、空名字登录、同主机号冲突加序号、手动名字不被覆盖、Cookie 自动登录、文字与图片收发、类型白名单、文件上传/发送/下载、大小上限、文件 24 小时过期与服务端自动清理、历史分页、落盘与重连恢复，共 39 项检查。

## 说明

- 设计用于**可信局域网**，未做鉴权与端到端加密，请勿直接暴露到公网。
- 已做的基础防护：昵称/文本长度限制、纯文本渲染（不解析 HTML）、图片 MIME 白名单、文件下载强制附件（nosniff，防 HTML/SVG 脚本注入）、体积上限、发送与上传频率限制。
