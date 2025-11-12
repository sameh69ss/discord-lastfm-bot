# Use a Node.js 18 image based on Debian (Bullseye)
# This is MUCH more reliable for 'node-canvas' than Alpine
FROM node:18-bullseye-slim

# Install system dependencies
# - 'ffmpeg' (which includes ffprobe)
# - 'build-essential' (for compiling)
# - The other packages are required by node-canvas
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

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install npm dependencies using 'ci' (clean install)
RUN npm ci

# Copy the rest of your project's code
COPY . .

# Run the TypeScript build script
RUN npm run build

EXPOSE 8080


# Default command to run when the container starts
# This will start the BOT. We will override this for the auth server.
CMD ["node", "dist/index.js"]