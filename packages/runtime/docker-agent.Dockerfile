# Build explicitly: docker build -f packages/runtime/docker-agent.Dockerfile -t elysia-agents:0.13.0 .
# Runtime never pulls images or reuses host CLI credentials automatically.
FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.162.1
ARG DSH_VERSION=0.2.1-alpha.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git ca-certificates python3 make g++ \
    && npm install --global "@openai/codex@${CODEX_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/agent /workspace \
    && chown node:node /home/agent /workspace
USER 1000:1000
WORKDIR /workspace
ENV HOME=/home/agent CODEX_HOME=/home/agent/.codex DSH_HOME=/home/agent/.dsh
CMD ["codex", "--help"]
