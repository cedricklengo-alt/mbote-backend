# Backend MboteCall — image Node 20 (Render, Docker)
# bookworm-slim (glibc) : better-sqlite3 fournit des binaires précompilés,
# contrairement à alpine/musl qui exige python3 + toolchain.
FROM node:20-bookworm-slim

# ffmpeg (miniatures vidéo) + toolchain native (repli si better-sqlite3
# n'a pas de binaire précompilé pour la version exacte de Node)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Code source
COPY src ./src
COPY public ./public

# Uploads persistants (Render disk) + base SQLite locale si pas de DATABASE_URL
RUN mkdir -p /app/uploads /app/data
VOLUME ["/app/uploads", "/app/data"]

ENV PORT=4791
EXPOSE 4791

# seed idempotent puis serveur
CMD ["sh", "-c", "node src/seed.js && node src/server.js"]
