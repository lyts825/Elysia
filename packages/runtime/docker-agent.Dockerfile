# 构建包含固定版本 Codex/DSH 的终端代理镜像；这里只准备执行环境，任务权限和挂载由宿主运行时控制。
# EN: Builds a terminal-agent image with pinned Codex/DSH versions; host runtime owns task permissions and mounts.
# 显式构建：docker build -f packages/runtime/docker-agent.Dockerfile -t elysia-agents:0.13.0 .
# EN: Build explicitly: docker build -f packages/runtime/docker-agent.Dockerfile -t elysia-agents:0.13.0 .
# 运行时不会自动拉取镜像或复用宿主 CLI 凭据；认证由每次任务显式提供的隔离配置决定。
# EN: Runtime never pulls images or reuses host CLI credentials automatically; each task supplies isolated authentication configuration.
FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.162.1
ARG DSH_VERSION=0.2.1-alpha.2
# 构建阶段安装 CLI 及原生依赖并清理包缓存，准备非 root 用户可写的独立 HOME 和工作目录。
# EN: Installs CLIs/native build dependencies and clears package caches at build time, preparing nonroot-owned HOME/workspace directories.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git ca-certificates python3 make g++ \
    && npm install --global "@openai/codex@${CODEX_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/agent /workspace \
    && chown node:node /home/agent /workspace
# 任务使用普通用户；CLI 状态分别写入容器内 HOME，下列帮助命令仅作为镜像的默认入口。
# EN: Tasks use an unprivileged user with CLI state under container HOME; the help command is only the image default.
USER 1000:1000
WORKDIR /workspace
ENV HOME=/home/agent CODEX_HOME=/home/agent/.codex DSH_HOME=/home/agent/.dsh
CMD ["codex", "--help"]
