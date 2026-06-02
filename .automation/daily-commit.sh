#!/usr/bin/env bash
# daily-commit.sh
# Picks the next planned feature from features.json, materialises a small file,
# commits it, and pushes to origin/main. Idempotent — re-running on the same day
# is fine; it just moves to the next feature when one is already done.
#
# Run by launchd once per day (see com.rashi.astrareach.daily.plist).
#
set -euo pipefail

# -------- Resolve repo path (works under launchd, which has no $PWD) --------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

AUTO_DIR="$REPO_DIR/.automation"
STATE_FILE="$AUTO_DIR/.state"
LOG_FILE="$AUTO_DIR/run.log"
FEATURES="$AUTO_DIR/features.json"

# Make sure git is found when run from launchd
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "==== daily-commit start ===="

# -------- Determine which step we're on --------
if [ ! -f "$STATE_FILE" ]; then
  echo 1 > "$STATE_FILE"
fi
STEP="$(cat "$STATE_FILE")"

TOTAL=$(python3 -c "import json,sys; print(len(json.load(open('$FEATURES'))))")
if [ "$STEP" -gt "$TOTAL" ]; then
  log "All $TOTAL features applied. Nothing to do."
  exit 0
fi

# Pull message + type for current step
MSG=$(python3  -c "import json; d=json.load(open('$FEATURES')); print(next(x for x in d if x['id']==$STEP)['msg'])")
TYPE=$(python3 -c "import json; d=json.load(open('$FEATURES')); print(next(x for x in d if x['id']==$STEP)['type'])")

log "Step $STEP / $TOTAL : $MSG  (type=$TYPE)"

# -------- Apply the feature for this step --------
apply_feature() {
  case "$1" in
    license)
      cat > LICENSE <<'EOF'
MIT License

Copyright (c) 2026 rashisuman76-ops

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
EOF
      ;;
    contributing)
      cat > CONTRIBUTING.md <<'EOF'
# Contributing

Thanks for your interest in contributing!

## Workflow
1. Fork & branch off `main`.
2. Make focused commits.
3. Run `npm test` before opening a PR.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) in commit messages.

## Code style
- 2-space indent
- Prefer `const` / `let`, never `var`
- Run `npm run lint` before committing
EOF
      ;;
    changelog)
      cat > CHANGELOG.md <<'EOF'
# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
- Project re-initialised, clean history.
EOF
      ;;
    editorconfig)
      cat > .editorconfig <<'EOF'
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
EOF
      ;;
    nvmrc)
      echo "20" > .nvmrc
      ;;
    envexample)
      cat > .env.example <<'EOF'
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgres://user:password@localhost:5432/astrareach

# Redis
REDIS_URL=redis://localhost:6379

# Session
SESSION_SECRET=change-me

# Mail (pick one)
SENDGRID_API_KEY=
RESEND_API_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
EOF
      ;;
    healthz)
      mkdir -p routes
      cat > routes/health.js <<'EOF'
const express = require('express');
const router = express.Router();

router.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() });
});

module.exports = router;
EOF
      ;;
    version)
      mkdir -p routes
      cat > routes/version.js <<'EOF'
const express = require('express');
const pkg = require('../package.json');
const router = express.Router();

router.get('/version', (req, res) => {
  res.json({ name: pkg.name, version: pkg.version, node: process.version });
});

module.exports = router;
EOF
      ;;
    reqid)
      mkdir -p middleware
      cat > middleware/requestId.js <<'EOF'
const { randomUUID } = require('crypto');

module.exports = function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
};
EOF
      ;;
    ratelimit)
      mkdir -p middleware
      cat > middleware/rateLimit.js <<'EOF'
// Tiny in-memory rate limiter. Replace with redis-backed limiter for prod.
const WINDOW_MS = 60 * 1000;
const MAX = 120;
const hits = new Map();

module.exports = function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = hits.get(key) || { count: 0, ts: now };
  if (now - entry.ts > WINDOW_MS) { entry.count = 0; entry.ts = now; }
  entry.count += 1;
  hits.set(key, entry);
  if (entry.count > MAX) return res.status(429).json({ error: 'Too many requests' });
  next();
};
EOF
      ;;
    logger)
      mkdir -p utils
      cat > utils/logger.js <<'EOF'
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL || 'info'] || 20;

function log(level, msg, meta) {
  if (LEVELS[level] < min) return;
  const line = { level, msg, time: new Date().toISOString(), ...(meta || {}) };
  console.log(JSON.stringify(line));
}

module.exports = {
  debug: (m, x) => log('debug', m, x),
  info:  (m, x) => log('info',  m, x),
  warn:  (m, x) => log('warn',  m, x),
  error: (m, x) => log('error', m, x),
};
EOF
      ;;
    pagination)
      mkdir -p utils
      cat > utils/pagination.js <<'EOF'
function parsePage(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  let limit = parseInt(query.limit, 10) || defaultLimit;
  limit = Math.min(Math.max(limit, 1), maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function buildMeta({ page, limit, total }) {
  const pages = Math.ceil(total / limit) || 1;
  return { page, limit, total, pages, hasNext: page < pages, hasPrev: page > 1 };
}

module.exports = { parsePage, buildMeta };
EOF
      ;;
    slug)
      mkdir -p utils
      cat > utils/slug.js <<'EOF'
module.exports = function slug(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
};
EOF
      ;;
    dateutil)
      mkdir -p utils
      cat > utils/date.js <<'EOF'
const MS_PER_DAY = 86400000;

function startOfDay(d = new Date())  { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d   = new Date())  { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function addDays(d, n)               { return new Date(d.getTime() + n * MS_PER_DAY); }
function daysBetween(a, b)           { return Math.round((startOfDay(b) - startOfDay(a)) / MS_PER_DAY); }

module.exports = { startOfDay, endOfDay, addDays, daysBetween };
EOF
      ;;
    cache)
      mkdir -p utils
      cat > utils/cache.js <<'EOF'
// Very small TTL cache. Replace with redis for multi-instance deploys.
const store = new Map();

function set(key, value, ttlMs = 60_000) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}
function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { store.delete(key); return undefined; }
  return hit.value;
}
function del(key) { store.delete(key); }
function clear()  { store.clear(); }

module.exports = { get, set, del, clear };
EOF
      ;;
    validate)
      mkdir -p utils
      cat > utils/validate.js <<'EOF'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(s)    { return typeof s === 'string' && EMAIL_RE.test(s); }
function isNonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }
function isUUID(s)     { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

function required(obj, fields) {
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) {
    const e = new Error('Missing required fields: ' + missing.join(', '));
    e.status = 400;
    throw e;
  }
}

module.exports = { isEmail, isNonEmpty, isUUID, required };
EOF
      ;;
    helmet)
      mkdir -p config
      cat > config/helmet.js <<'EOF'
const helmet = require('helmet');

module.exports = helmet({
  contentSecurityPolicy: false, // EJS views inline some scripts; tighten later
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});
EOF
      ;;
    cors)
      mkdir -p config
      cat > config/cors.js <<'EOF'
const ALLOW = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && (ALLOW.includes('*') || ALLOW.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
EOF
      ;;
    errorhandler)
      mkdir -p middleware
      cat > middleware/errorHandler.js <<'EOF'
module.exports = function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const payload = { error: err.message || 'Internal Server Error', requestId: req.id };
  if (process.env.NODE_ENV !== 'production') payload.stack = err.stack;
  res.status(status).json(payload);
};
EOF
      ;;
    test)
      mkdir -p tests
      cat > tests/slug.test.js <<'EOF'
const slug = require('../utils/slug');

test('basic slugify', () => {
  expect(slug('Hello World')).toBe('hello-world');
});
test('strips punctuation', () => {
  expect(slug('  Foo!! Bar?? ')).toBe('foo-bar');
});
EOF
      ;;
    ci)
      mkdir -p .github/workflows
      cat > .github/workflows/ci.yml <<'EOF'
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci --no-audit --no-fund || npm install
      - run: npm test --if-present
EOF
      ;;
    eslint)
      cat > .eslintrc.json <<'EOF'
{
  "env": { "node": true, "es2022": true, "jest": true },
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "script" },
  "rules": {
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": "off",
    "eqeqeq": ["error", "smart"]
  }
}
EOF
      ;;
    prettier)
      cat > .prettierrc.json <<'EOF'
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2
}
EOF
      ;;
    dockerfile)
      cat > Dockerfile <<'EOF'
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
EOF
      ;;
    compose)
      cat > docker-compose.yml <<'EOF'
version: "3.9"
services:
  app:
    build: .
    ports: ["3000:3000"]
    env_file: .env
    depends_on: [db, redis]
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: astra
      POSTGRES_PASSWORD: astra
      POSTGRES_DB: astrareach
    volumes: ["pgdata:/var/lib/postgresql/data"]
    ports: ["5432:5432"]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  pgdata:
EOF
      ;;
    dockerignore)
      cat > .dockerignore <<'EOF'
node_modules
npm-debug.log
.git
.gitignore
.env
.env.*
logs
*.log
.DS_Store
EOF
      ;;
    issuetemplates)
      mkdir -p .github/ISSUE_TEMPLATE
      cat > .github/ISSUE_TEMPLATE/bug_report.md <<'EOF'
---
name: Bug report
about: Report a problem so we can fix it
labels: bug
---

**What happened?**

**What did you expect?**

**Steps to reproduce**
1.
2.

**Environment**
- OS:
- Node:
EOF
      cat > .github/ISSUE_TEMPLATE/feature_request.md <<'EOF'
---
name: Feature request
about: Suggest an idea
labels: enhancement
---

**Problem**

**Proposed solution**

**Alternatives considered**
EOF
      ;;
    prtemplate)
      mkdir -p .github
      cat > .github/PULL_REQUEST_TEMPLATE.md <<'EOF'
## Summary

## Changes
-

## Test plan
- [ ] `npm test`
- [ ] Smoke-tested locally
EOF
      ;;
    metrics)
      mkdir -p middleware
      cat > middleware/metrics.js <<'EOF'
const counters = { total: 0, byStatus: {}, byPath: {} };

function inc(map, key) { map[key] = (map[key] || 0) + 1; }

function middleware(req, res, next) {
  res.on('finish', () => {
    counters.total += 1;
    inc(counters.byStatus, String(res.statusCode));
    inc(counters.byPath, req.method + ' ' + (req.route?.path || req.path));
  });
  next();
}

function snapshot() { return JSON.parse(JSON.stringify(counters)); }

module.exports = { middleware, snapshot };
EOF
      ;;
    readmeupdate)
      # Append a roadmap section if not already present
      if ! grep -q "## Roadmap" README.md; then
        cat >> README.md <<'EOF'

---

## Roadmap

- [x] Health & version endpoints
- [x] Request-id + rate-limit middleware
- [x] Logger / pagination / cache / validation utilities
- [x] Helmet & CORS configuration
- [x] Central error handler
- [x] Jest test scaffold + GitHub Actions CI
- [x] Dockerfile + docker-compose
- [ ] Prometheus-format /metrics endpoint
- [ ] OpenAPI spec
- [ ] Multi-tenant rate limiting via Redis
EOF
      fi
      ;;
    *)
      log "Unknown feature type: $1 — skipping"
      ;;
  esac
}

apply_feature "$TYPE"

# -------- Commit & push --------
git add -A
if git diff --cached --quiet; then
  log "No changes to commit for step $STEP (already applied?). Advancing anyway."
else
  git commit -m "$MSG" >> "$LOG_FILE" 2>&1
  log "Committed: $MSG"
fi

if git remote get-url origin >/dev/null 2>&1; then
  if git push origin main >> "$LOG_FILE" 2>&1; then
    log "Pushed to origin/main"
  else
    log "Push FAILED — check credentials / network. State NOT advanced."
    exit 1
  fi
else
  log "No 'origin' remote configured. Skipping push."
fi

# -------- Advance state --------
echo $((STEP + 1)) > "$STATE_FILE"
log "Advanced state to $((STEP + 1))"
log "==== daily-commit end ===="
