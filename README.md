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

### 方式二：直接 Node 运行

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

## 测试

```bash
npm test
```

会拉起一个临时实例，覆盖登录、Cookie 自动登录、文字与图片收发、类型白名单、历史分页、落盘与重连恢复，共 18 项检查。

## 说明

- 设计用于**可信局域网**，未做鉴权与端到端加密，请勿直接暴露到公网。
- 已做的基础防护：昵称/文本长度限制、纯文本渲染（不解析 HTML）、图片 MIME 白名单、体积上限、发送与上传频率限制。
