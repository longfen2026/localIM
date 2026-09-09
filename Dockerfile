# localIM 精简镜像
#
# 思路：node:22-alpine 解压后有 159.5MB（含 npm / corepack / 头文件 / 文档），
# 而 Alpine 官方源的 nodejs 包只要 18.5MB。运行时根本不需要 npm，所以：
#   - 构建阶段用 node:22-alpine（只为跑 npm ci，不进最终镜像）
#   - 运行阶段用 alpine:3.22 + apk add nodejs，只带 node 二进制和运行时依赖
# 预计体积 166MB → 约 55MB。
#
# 回退：如果精简版在你的环境有问题，用 docker build -f Dockerfile.full .

# ---------------- 构建阶段（不会进入最终镜像） ----------------
FROM node:22-alpine AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && rm -rf /root/.npm

# 依赖里运行时用不到的部分：类型声明、文档、示例、source map（约省 4MB）
# 用 shell 通配而非 find -prune，避免 busybox find 的行为差异
RUN rm -rf /build/node_modules/@types \
 && rm -rf /build/node_modules/*/docs /build/node_modules/*/*/docs \
 && rm -rf /build/node_modules/*/doc /build/node_modules/*/*/doc \
 && rm -rf /build/node_modules/*/examples /build/node_modules/*/*/examples \
 && rm -rf /build/node_modules/*/example /build/node_modules/*/*/example \
 && rm -rf /build/node_modules/*/.github /build/node_modules/*/*/.github \
 && find /build/node_modules -type f \( \
      -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name '*.d.ts' \
      -o -name 'LICENSE*' -o -name 'AUTHORS*' -o -name 'CHANGELOG*' -o -name '.travis.yml' \
    \) -delete

COPY server ./server
COPY public ./public

# ---------------- 运行阶段 ----------------
FROM alpine:3.22

ARG PUID=1000
ARG PGID=1000

# nodejs 18.5MB + 依赖（libcrypto / icu / brotli 等）约 42MB
# icu-data-full + tzdata 保证中文与 Asia/Shanghai 时区正确；
# 若只需要英文与 UTC，可换成 icu-data-en 并去掉 tzdata，再省约 12MB。
RUN apk add --no-cache nodejs icu-data-full tzdata ca-certificates

# 让容器内运行用户的 uid/gid 与宿主机保持一致，避免映射出来的数据目录出现 root 属主文件
RUN GRP=$(awk -F: -v g="${PGID}" '$3==g{print $1}' /etc/group) \
 && [ -n "$GRP" ] || { GRP=localim; addgroup -g "${PGID}" "$GRP"; } \
 && USR=$(awk -F: -v u="${PUID}" '$3==u{print $1}' /etc/passwd) \
 && [ -n "$USR" ] || { USR=localim; adduser -D -H -u "${PUID}" -G "$GRP" "$USR"; }

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000 \
    TZ=Asia/Shanghai

WORKDIR /app
COPY --from=builder --chown=${PUID}:${PGID} /build/node_modules ./node_modules
COPY --from=builder --chown=${PUID}:${PGID} /build/server ./server
COPY --from=builder --chown=${PUID}:${PGID} /build/public ./public

# 持久化目录：messages.jsonl / users.json / uploads / cookie 密钥
RUN mkdir -p /app/data/uploads && chown -R ${PUID}:${PGID} /app/data
VOLUME ["/app/data"]

USER ${PUID}:${PGID}
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health', r=>process.exit(r.statusCode===200?0:1)).on('error', ()=>process.exit(1))"

CMD ["node", "server/index.js"]
