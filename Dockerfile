# VendBot — Koyeb (or any Docker) deployment
FROM node:20-slim

WORKDIR /app

# Install dependencies (production only for smaller image)
COPY package.json package-lock.json* ./
COPY patches ./patches
ENV NODE_ENV=production
RUN /usr/local/bin/npm install --omit=dev

# App code
COPY src ./src

# Server listens on PORT (Koyeb sets this)
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
