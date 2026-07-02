# AstraReach — Enterprise B2B Outbound CRM

> A production-grade outbound sales automation platform built for high-volume B2B teams. Send personalised cold email campaigns at scale, enrich contacts with AI-powered research, and track every interaction in real time.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [USPs](#unique-selling-points)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Project Structure](#project-structure)
- [Roles & Permissions](#roles--permissions)
- [AI Features](#ai-features)
- [Email Pipeline](#email-pipeline)
- [Scripts](#scripts)

---

## Overview

AstraReach is a self-hosted, enterprise-grade outbound CRM designed for B2B sales teams that need complete control over their outreach pipeline. It handles everything from contact management and segmentation to AI-enriched personalisation and real-time email analytics — all in a single, dark-themed, HubSpot-style interface.

Built to scale to **10 million+ contacts** and **1 million+ emails/day**.

---

## Key Features

### Contact Management
- Import contacts from CSV / XLSX files with AI-assisted column mapping
- Real-time import progress with live row counts and error reporting
- Bulk operations — delete, tag, export, and AI enrich across all matching contacts
- Advanced multi-value filters (industry, country, status, source) with search
- Cross-page "Select All" for bulk actions beyond the current page
- Custom fields — add, edit and delete arbitrary key-value data per contact
- Keyset pagination optimised for millions of rows

### AI Contact Enrichment
- 3-pass Claude AI research pipeline (Company → Person → Cross-verify)
- Uses `web_search` tool to pull live public data
- **Never overwrites existing data** — only fills empty fields
- Strict confidence threshold (70%+) — low-confidence data is discarded
- Every enriched field stores its **source URL and confidence score**
- Enriches: company description, tech stack, funding stage, LinkedIn, skills, hiring signals, pain keywords and more
- Bulk enrichment via BullMQ queue with priority and rate limiting
- Real-time SSE progress updates on the contact detail page

### Segments
- Rule-based dynamic segments with AND/OR logic
- AI Segment Builder — describe your audience in plain English, Claude builds the filters
- Live contact count with one-click refresh
- Segments feed directly into campaign audience selection

### Email Campaigns
- Multi-step campaign wizard (name → audience → template → schedule)
- Daily sending limits with configurable send time and timezone
- Automatic campaign completion detection
- Start / Pause / Resume / Stop controls per campaign
- Per-campaign email template preview

### Email Tracking
- 1×1 open tracking pixel per email
- Every link in email body is auto-encoded for click tracking
- Bounce, unsubscribe, and spam complaint handling via Resend webhooks
- Per-contact email history with full event timeline

### Real-Time Analytics
- Dashboard cards: contacts, campaigns, emails sent, open rate, click rate
- Open & Click Rate trend chart (last 30 days)
- Recent activity feed
- Per-campaign stats: sent, delivered, opened, clicked, bounced, unsubscribed
- Time-aware greeting (IST-based good morning/afternoon/evening)

### Email Templates
- Rich HTML email editor with variable placeholders `{{first_name}}`, `{{company}}` etc.
- Optional booking URL field per template
- Configurable unsubscribe link toggle per template
- AI Template Generator — generate full email copy from industry, job title, tone and goal
- Full-screen preview modal

### RBAC — Role-Based Access Control
- 5 roles: `superadmin`, `admin`, `editor`, `lead_manager`, `campaign_manager`
- Column-level field visibility per role (`field_permissions` table)
- Row-level data scoping (`user_data_scopes` table)
- Per-user permission overrides (`permission_grants` table)
- Export restricted to admin and superadmin only
- Delete restricted by role across all modules

### User Management
- Invite and manage team members
- Role assignment and permission override UI
- Audit log for all sensitive actions

### Infrastructure
- Background job queues for all async work (send, events, AI, enrichment)
- Graceful shutdown with SIGTERM/SIGINT handling
- Session stored in PostgreSQL (no Redis session dependency)
- Redis used exclusively for BullMQ queues

---

## Unique Selling Points

| USP | Detail |
|-----|--------|
| **AI Enrichment with Source Tracking** | Every AI-filled field has a source URL and confidence score. No hallucinated data ever reaches the database. |
| **Scale-first Architecture** | Keyset pagination, GIN indexes, streaming CSV import, and BullMQ workers built for 10M+ contacts from day one. |
| **Zero-overwrite Enrichment** | Existing contact data is never modified by AI. Only blank fields are filled. |
| **Full Email Attribution** | Every link in every email is individually tracked. Know exactly which contact clicked which link in which campaign. |
| **Self-hosted & Private** | Your contact data never leaves your server. No third-party CRM SaaS fees. |
| **Role-gated at Column Level** | Not just page-level access control — individual database columns can be hidden or locked per role. |
| **AI Segment Builder** | Non-technical users describe their target audience in plain English and get a correctly structured segment instantly. |
| **Live Import Progress** | CSV/XLSX imports stream progress in real time. Crashes mid-import leave no partial data. |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Web Framework | Express 4 |
| Templating | EJS + Express EJS Layouts |
| Database | PostgreSQL 16 |
| Cache / Queues | Redis 7 + BullMQ 5 |
| AI | Anthropic Claude (`claude-sonnet-4-20250514`) via `@anthropic-ai/sdk` |
| Email Sending | Resend |
| Authentication | Passport.js (Local Strategy) + bcryptjs |
| Scheduler | node-cron |
| File Uploads | Multer + csv-parser + xlsx |
| Frontend Styling | Tailwind CSS (CDN) + Font Awesome 6 |
| Charts | Chart.js |
| Process Manager | PM2 |
| Reverse Proxy | Nginx |
| SSL | Let's Encrypt (Certbot) |

---

## Architecture

```
Browser
  │
  ▼
Nginx (reverse proxy + SSL termination)
  │
  ▼
Express App (port 9800)
  ├── Routes → Controllers → PostgreSQL (pg pool)
  ├── Session → PostgreSQL (connect-pg-simple)
  ├── BullMQ Queues → Redis
  │
  └── Background Workers (same process)
        ├── sendWorker       — email sending via Resend
        ├── eventsWorker     — webhook event processing
        ├── campaignWorker   — campaign orchestration
        ├── aiWorker         — AI batch scoring & ICP generation
        └── enrichmentWorker — AI contact enrichment (Claude + web_search)
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+

### Local Setup

```bash
# Clone the repo
git clone https://github.com/your-org/astrareach.git
cd astrareach

# Install dependencies
npm install

# Copy env template and fill in values
cp .env.example .env

# Run database schema
psql $DATABASE_URL -f db/schema.sql
psql $DATABASE_URL -f db/migration.sql
node scripts/migrate-enrichment.js

# Seed superadmin user
npm run seed:admin

# Start the app
npm run dev
```

Open `http://localhost:9800`

---

## Environment Variables

```env
NODE_ENV=production
PORT=9800

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/astrareach

# Redis (explicit vars recommended)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Sessions
SESSION_SECRET=long-random-string-min-32-chars

# AI
ANTHROPIC_API_KEY=sk-ant-...

# Email
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
FROM_EMAIL=you@yourdomain.com
FROM_NAME=Your Company

# App
APP_URL=https://astrareach.yourdomain.com
BOOKING_URL=https://yourdomain.com/book-call
```

---

## Database Setup

The schema is split into three files that must be run in order:

| File | Purpose |
|------|---------|
| `db/schema.sql` | Core tables — users, contacts, segments, templates, campaigns, events |
| `db/migration.sql` | Enterprise columns — orgs, RBAC, enrichment columns, email tracking |
| `scripts/migrate-enrichment.js` | AI enrichment tables — `contact_enrichments`, `enrichment_jobs` |

All statements use `IF NOT EXISTS` / `IF NOT EXISTS` — safe to re-run.

---

## Project Structure

```
astrareach/
├── app.js                  # Express app setup, middleware, routes
├── server.js               # HTTP server, workers, scheduler boot
├── config/
│   ├── db.js               # PostgreSQL pool
│   └── redis.js            # IORedis connection
├── controllers/            # Route handler logic
├── middleware/
│   ├── rbac.js             # requirePermission, applyFieldFilter, applyRowScope
│   ├── paginate.js         # getPagination helper
│   └── auditLog.js         # logAction middleware
├── routes/                 # Express routers
├── services/
│   ├── enrichmentService.js  # Claude 3-pass enrichment pipeline
│   ├── queueService.js       # BullMQ queue definitions
│   ├── schedulerService.js   # node-cron jobs
│   └── importService.js      # Streaming CSV/XLSX import
├── workers/
│   ├── sendWorker.js
│   ├── eventsWorker.js
│   ├── campaignWorker.js
│   ├── aiWorker.js
│   └── enrichmentWorker.js
├── views/                  # EJS templates
│   ├── layout/             # _head, _sidebar, _header partials
│   ├── contacts/
│   ├── campaigns/
│   ├── segments/
│   ├── templates/
│   ├── analytics/
│   └── dashboard/
├── public/                 # Static assets (CSS, JS, images)
├── db/
│   ├── schema.sql
│   └── migration.sql
└── scripts/                # Utility and seed scripts
```

---

## Roles & Permissions

| Role | Contacts | Segments | Templates | Campaigns | Analytics | Users | Export | Delete |
|------|----------|----------|-----------|-----------|-----------|-------|--------|--------|
| `superadmin` | Full | Full | Full | Full | Full | Full | Yes | Yes |
| `admin` | Full | Full | Full | Full | Full | Manage | Yes | Yes |
| `editor` | View + Edit | View + Create | View + Create | View | View | No | No | No |
| `lead_manager` | View + Create | View + Create | View | View | View | No | No | No |
| `campaign_manager` | View | View | View + Create | Full | Full | No | No | No |

---

## AI Features

### Contact Enrichment
Triggered per-contact or in bulk from the contacts list. Runs a 3-pass research pipeline:
1. **Pass 1** — Company research (website, tech stack, funding, team size, HQ, recent news)
2. **Pass 2** — Person research (LinkedIn, bio, skills, past companies, education)
3. **Pass 3** — Cross-verification (reconcile conflicting data, remove low-confidence fields)

Each field stores: `value`, `confidence (0–100)`, `source_url`.
Fields below 70% confidence are discarded before writing to the database.

### AI Segment Builder
Accepts a plain-English description and returns a structured segment with filters applied automatically. Example:
> *"SaaS companies in India with 50–500 employees where the contact is a VP or above"*

### AI Template Generator
Generates a complete cold email from: industry, target job title, tone, goal, and company size.

---

## Email Pipeline

```
Campaign starts
  │
  ▼
campaign_contacts rows created (status = pending)
  │
  ▼
sendWorker picks up pending rows (respects daily_limit)
  │
  ▼
Email sent via Resend
  │
  ├── Success → status = sent, email_tracking updated
  └── Failure → status = failed, error logged, retry queued
  │
  ▼
Resend Webhook → /webhooks/resend
  │
  ▼
eventsWorker processes: delivered / opened / clicked / bounced / unsubscribed
  │
  ▼
email_events row inserted + email_tracking upserted
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run seed:admin` | Create / update superadmin user |
| `node scripts/migrate-enrichment.js` | Run AI enrichment table migration |
| `node scripts/set-superadmin.js` | Promote existing user to superadmin |
| `node scripts/check-schema.js` | Verify all required tables exist |
| `node scripts/fix-stuck-batches.js` | Recover stuck import batches after crash |

---

## License

Private — AstraByte Solutions. All rights reserved.

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
