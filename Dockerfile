# Backend MboteCall — image Node 20 (Render, Docker)
FROM node:20-alpine

# ffmpeg pour les miniatures vidéo (video_thumb)
RUN apk add --no-cache ffmpeg

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
