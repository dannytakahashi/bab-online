# DevOps and Deployment

## Overview
The project lacks essential DevOps infrastructure for reliable deployment and maintenance.

## Current Problems

- No `.gitignore` file - .env is committed!
- No CI/CD pipeline
- No health check endpoints
- No graceful shutdown handling
- No Docker configuration
- No environment separation (dev/prod)
- Manual deployment only

---

## Task 1: Create .gitignore

**Create:** `.gitignore`

```gitignore
# Environment variables
.env
.env.local
.env.*.local
.env.production
.env.development

# Dependencies
node_modules/

# Logs
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Coverage
coverage/
.nyc_output/

# Build artifacts
dist/
build/

# IDE and editors
.idea/
.vscode/
*.swp
*.swo
*~
.project
.classpath
.settings/

# OS files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# Temporary files
*.tmp
*.temp
.cache/

# Runtime data
pids/
*.pid
*.seed
*.pid.lock
```

---

## Task 2: Remove .env from Git History

**Warning:** This rewrites git history. Coordinate with team members.

```bash
# Option 1: Using git filter-branch
git filter-branch --force --index-filter \
    "git rm --cached --ignore-unmatch .env" \
    --prune-empty --tag-name-filter cat -- --all

# Force push (after coordinating with team)
git push origin --force --all

# Option 2: Using BFG Repo Cleaner (faster for large repos)
# Install: brew install bfg
bfg --delete-files .env
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push origin --force --all
```

**After removal:**
1. Rotate all secrets (MongoDB password, etc.)
2. Update Railway.app environment variables
3. Notify team to re-clone repository

---

## Task 3: Create .env.example

**Create:** `.env.example`

```bash
# ===================
# Server Configuration
# ===================
NODE_ENV=development
PORT=3000

# ===================
# Database
# ===================
MONGO_URI=mongodb://localhost:27017/bab-online

# ===================
# Security
# ===================
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=your-secret-key-min-32-characters-here

# Comma-separated list of allowed origins
ALLOWED_ORIGINS=http://localhost:3000

# ===================
# Logging
# ===================
LOG_LEVEL=debug
```

---

## Task 4: Add Health Check Endpoints

**Add to:** `server/routes/index.js`

```javascript
const express = require('express');
const router = express.Router();
const { getDB } = require('../database');

// Basic health check - is the server running?
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            unit: 'MB'
        }
    });
});

// Readiness check - is the server ready to accept traffic?
router.get('/ready', async (req, res) => {
    try {
        // Check database connection
        const db = getDB();
        await db.command({ ping: 1 });

        res.json({
            status: 'ready',
            checks: {
                database: 'ok'
            }
        });
    } catch (error) {
        res.status(503).json({
            status: 'not ready',
            checks: {
                database: 'failed'
            },
            error: error.message
        });
    }
});

// Liveness check - is the server alive and not deadlocked?
router.get('/live', (req, res) => {
    res.json({ status: 'alive' });
});

module.exports = router;
```

---

## Task 5: Implement Graceful Shutdown

**Add to:** `server/index.js`

```javascript
const { logger } = require('./utils/logger');

let isShuttingDown = false;
let connections = new Set();

// Track connections
server.on('connection', (conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
});

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        logger.warn('Shutdown already in progress');
        return;
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown`);

    // Set a hard timeout
    const forceExitTimeout = setTimeout(() => {
        logger.error('Forcing exit after timeout');
        process.exit(1);
    }, 30000);

    try {
        // Stop accepting new connections
        server.close(() => {
            logger.info('HTTP server closed');
        });

        // Notify connected clients
        io.emit('serverShutdown', {
            message: 'Server is restarting'
        });

        // Wait a moment for message to send
        await new Promise(r => setTimeout(r, 500));

        // Close existing connections
        for (const conn of connections) {
            conn.destroy();
        }

        // Close Socket.IO
        io.close(() => {
            logger.info('Socket.IO closed');
        });

        // Close database
        const db = require('./database');
        await db.close();
        logger.info('Database closed');

        clearTimeout(forceExitTimeout);
        logger.info('Graceful shutdown complete');
        process.exit(0);

    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
});
```

---

## Task 6: Create Dockerfile

**Create:** `Dockerfile`

```dockerfile
# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source
COPY . .

# Production stage
FROM node:18-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code
COPY --from=builder /app/server ./server
COPY --from=builder /app/client ./client

# Create logs directory
RUN mkdir -p logs && chown -R nodejs:nodejs logs

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Start command
CMD ["node", "server/index.js"]
```

---

## Task 7: Create Docker Compose for Development

**Create:** `docker-compose.yml`

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - PORT=3000
      - MONGO_URI=mongodb://mongo:27017/bab-online
      - JWT_SECRET=dev-secret-not-for-production
      - ALLOWED_ORIGINS=http://localhost:3000
      - LOG_LEVEL=debug
    depends_on:
      mongo:
        condition: service_healthy
    volumes:
      # Mount source for hot reload in development
      - ./server:/app/server:ro
      - ./client:/app/client:ro
    restart: unless-stopped

  mongo:
    image: mongo:6
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: echo 'db.runCommand("ping").ok' | mongosh localhost:27017/test --quiet
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

volumes:
  mongo-data:
```

**Commands:**
```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop all services
docker-compose down

# Rebuild after changes
docker-compose up -d --build
```

---

## Task 8: Create GitHub Actions CI/CD

**Create:** `.github/workflows/ci.yml`

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      mongo:
        image: mongo:6
        ports:
          - 27017:27017

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run linter
        run: npm run lint --if-present

      - name: Run tests
        run: npm test
        env:
          MONGO_URI: mongodb://localhost:27017/test
          JWT_SECRET: test-secret-for-ci
          NODE_ENV: test

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        if: always()
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          fail_ci_if_error: false

  build:
    runs-on: ubuntu-latest
    needs: test

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Build Docker image
        run: docker build -t bab-online:${{ github.sha }} .

      - name: Test Docker image
        run: |
          docker run -d --name test-container -p 3000:3000 \
            -e NODE_ENV=test \
            -e JWT_SECRET=test-secret \
            -e MONGO_URI=mongodb://host.docker.internal:27017/test \
            bab-online:${{ github.sha }}
          sleep 5
          curl -f http://localhost:3000/health || exit 1
          docker stop test-container

  deploy:
    runs-on: ubuntu-latest
    needs: [test, build]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Deploy to Railway
        uses: bervProject/railway-deploy@main
        with:
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          service: bab-online
```

---

## Task 9: Create Railway Configuration

**Create:** `railway.toml`

```toml
[build]
builder = "NIXPACKS"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

---

## Task 10: Environment-Based Configuration

**Create:** `server/config/index.js`

```javascript
require('dotenv').config();

const config = {
    // Environment
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',

    // Server
    port: parseInt(process.env.PORT, 10) || 3000,

    // Database
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/bab-online',

    // Security
    jwtSecret: process.env.JWT_SECRET,
    allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : ['http://localhost:3000'],

    // Logging
    logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
};

// Validate required config in production
if (config.isProduction) {
    const required = ['jwtSecret', 'mongoUri'];
    const missing = required.filter(key => !config[key]);

    if (missing.length > 0) {
        throw new Error(`Missing required config: ${missing.join(', ')}`);
    }

    if (config.jwtSecret.length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters');
    }
}

module.exports = config;
```

---

## Verification Checklist

1. [x] `.gitignore` created and working
2. [ ] `.env` removed from git history (optional - requires force push)
3. [ ] Secrets rotated after removal
4. [x] `.env.example` created with documentation
5. [x] Health endpoints return correct status (`/health`, `/ready`, `/live`)
6. [x] Graceful shutdown works (test with `kill -SIGTERM`)
7. [x] Docker build succeeds (Dockerfile created)
8. [x] Docker container starts and responds (docker-compose.yml created)
9. [x] GitHub Actions runs on push (`.github/workflows/ci.yml` created)
10. [ ] Tests pass in CI (verify after first push)
11. [ ] Deployment to Railway works (requires RAILWAY_TOKEN secret)
12. [ ] Production environment variables configured
