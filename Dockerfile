FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .

# better-sqlite3 native rebuild for container arch
RUN npm rebuild better-sqlite3

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/memory.db

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "--require", "./src/selfhost/register-cf-shim.cjs", "--import", "tsx", "src/server.ts"]
