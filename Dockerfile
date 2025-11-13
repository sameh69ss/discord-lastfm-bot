# Use Node 18 (Debian-based for node-canvas compatibility)
FROM node:18-bullseye-slim

# Install dependencies required for node-canvas and ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Clean install dependencies
RUN npm ci

# Copy project files
COPY . .

# Build TypeScript
RUN npm run build

# Expose the auth server port
EXPOSE 8080

# Start both the bot and the auth server
# You can import the auth server inside index.js, or start both here
CMD ["node", "dist/index.js"]
