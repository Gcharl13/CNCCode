FROM node:20-alpine

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# App code
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# Default mount point for the persisted job store (overlaid by a volume at runtime)
RUN mkdir -p /data/jobs

EXPOSE 8080

CMD ["node", "server/index.js"]
