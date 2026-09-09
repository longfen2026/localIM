# localIM · 局域网聊天室

局域网内开箱即用的聊天室：**免密登录（只填主机名）**、**文字 + 图片**、**消息长期保存在服务端**、**Docker 部署 + 数据卷持久化**。

## 特性

| 能力 | 说明 |
| --- | --- |
| 免密登录 | 输入主机名/昵称即可进入，不校验密码 |
| 自动登录 | 签名 Cookie 记录身份，关掉浏览器下次打开直接进 |
| 文字聊天 | Enter 发送 / Shift+Enter 换行，链接自动可点 |
| 图片收发 | 点击按钮选择、Ctrl+V 粘贴、直接拖拽到窗口三种方式 |
| 历史消息 | 服务端长期保存，进入即看最近 50 条，向上滚动加载更早 |
| 在线状态 | 右上角查看在线成员与人数，进出有系统提示 |
| 持久化 | 消息、用户、图片、Cookie 密钥全部写入数据目录，容器重建不丢 |

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
│   ├── index.js      # Express + Socket.IO：登录、上传、实时推送
│   ├── store.js      # 持久化层（messages.jsonl / users.json）
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
    ├── .cookie-secret
    └── uploads/YYYYMM/
```

## 持久化说明

| 文件 | 内容 |
| --- | --- |
| `data/messages.jsonl` | 每行一条消息的追加日志，启动时全量载入内存 |
| `data/users.json` | 用户 ID → 名字、最后活跃时间 |
| `data/uploads/YYYYMM/` | 聊天图片原文件 |
| `data/.cookie-secret` | Cookie 签名密钥，保留它重启后仍保持登录态 |

备份整个 `data` 目录即可迁移聊天记录。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `<项目>/data` | 数据目录，Docker 内为 `/app/data` |
| `MAX_UPLOAD_MB` | `10` | 单张图片大小上限（MB） |
| `HISTORY_PAGE` | `50` | 进入聊天室时下发的历史条数 |
| `PUID` / `PGID` | `1000` | Docker 内运行用户，避免数据目录出现 root 属主 |

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/me` | 当前登录用户（自动登录用） |
| POST | `/api/login` | `{name}` 登录或改名 |
| POST | `/api/logout` | 清除 Cookie |
| GET | `/api/messages?limit=&before=` | 历史消息 |
| POST | `/api/upload` | `multipart` 上传图片，返回 `fileId` |

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

## 测试

```bash
npm test
```

会拉起一个临时实例，覆盖登录、Cookie 自动登录、文字与图片收发、类型白名单、历史分页、落盘与重连恢复，共 18 项检查。

## 说明

- 设计用于**可信局域网**，未做鉴权与端到端加密，请勿直接暴露到公网。
- 已做的基础防护：昵称/文本长度限制、纯文本渲染（不解析 HTML）、图片 MIME 白名单、体积上限、发送与上传频率限制。
