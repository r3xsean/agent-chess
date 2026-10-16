# The public, read-only Agent Chess mirror (Railway). Games are played on the local server, which
# pushes them here; this image runs no engine and no agents.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx vite build

ENV NODE_ENV=production \
    PUBLIC_MODE=1 \
    AGENT_CHESS_DATA=/data
EXPOSE 8080
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
