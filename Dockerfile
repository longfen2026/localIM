FROM node:22-alpine

# 数据目录映射到宿主机后，容器内的写入用户最好与宿主机一致。
# 默认以 node 用户（uid 1000）运行，可用 PUID/PGID 覆盖，避免宿主机出现 root 属主文件。
ARG PUID=1000
ARG PGID=1000

RUN apk add --no-cache shadow \
 && (getent group ${PGID} || addgroup -g ${PGID} nodeapp) \
 && (getent passwd ${PUID} || adduser -D -H -u ${PUID} -G $(getent group ${PGID} | cut -d: -f1) nodeapp)

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000 \
    TZ=Asia/Shanghai

# 持久化目录：messages.jsonl / users.json / uploads / cookie 密钥
RUN mkdir -p /app/data/uploads && chown -R ${PUID}:${PGID} /app/data
VOLUME ["/app/data"]

USER ${PUID}:${PGID}
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
