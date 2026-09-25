# ============================================================
# 对象存储管理系统 —— 生产镜像（多阶段构建）
#
# 特性：
#  - 多阶段：仅把运行时依赖与源码带进最终镜像
#  - 非 root 用户运行（node 用户），降低容器逃逸后的影响面
#  - /app/data 声明为 VOLUME：配置加密密钥、用户、日志必须持久化，
#    否则容器重建即丢失全部配置（含 AES 主密钥，丢钥不可逆）
#  - 内置 HEALTHCHECK，配合 CI / 编排系统做就绪探测
# ============================================================

# ---------- 阶段 1：安装依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 只装生产依赖，且忽略生命周期脚本（本项目依赖无需编译）
RUN npm ci --omit=dev --ignore-scripts

# ---------- 阶段 2：运行 ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HTTPS_PORT=3443

# 容器内需监听 0.0.0.0 才能被外部访问；此时务必配合反向代理或仅内网暴露
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# data 目录预创建并交给 node 用户（之后由卷挂载覆盖）
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

EXPOSE 3000 3443

# 健康检查：未登录也应返回 200（/api/health 在鉴权中间件里属于受保护路径，
# 因此改为探测 TCP 端口可用性 + 静态首页，避免误判为不健康）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 作为 PID 1：正确转发 SIGTERM/SIGINT，使 gracefulShutdown 生效（释放端口与单实例锁）
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
