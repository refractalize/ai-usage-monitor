FROM node:26.2.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY app ./app
COPY server ./server
COPY react-router.config.ts vite.config.ts tsconfig.json ./
RUN npm run build

FROM node:26.2.0-bookworm-slim
WORKDIR /app
# npm installs Codex's native executable for the target architecture (amd64/arm64).
ARG CODEX_VERSION=0.160.0
ARG CLAUDE_VERSION=2.1.289
RUN npm install --global @openai/codex@${CODEX_VERSION} && codex --version
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_VERSION} && claude --version
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY server ./server
RUN mkdir -p /data /codex-home && chown node:node /data /codex-home
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AI_USAGE_DB=/data/usage-v2.sqlite3 CODEX_HOME=/codex-home DISABLE_AUTOUPDATER=1
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/index.ts"]
