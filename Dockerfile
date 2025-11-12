# Use Node.js 20 on Alpine (lightweight)
FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache \
    ffmpeg \
    ffprobe \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    libjpeg-turbo-dev \
    giflib-dev \
    pixman-dev \
    wget \
    bash

# Install cloudflared for auth tunnel
RUN wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Set workdir
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript (adjust if your output is different)
RUN npx tsc

# Expose auth server
EXPOSE 8080

# Start bot
CMD ["node", "dist/index.js"]