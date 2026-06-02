-- ============================================================
-- AstraReach Enterprise Migration (additive — runs safely on
-- top of existing schema.sql without dropping any tables)
-- ============================================================

-- Extra extensions
CREATE EXTENSION IF NOT EXISTS "btree_gin";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- ============================================================
-- ORGANISATIONS (multi-tenant foundation)
-- ============================================================
CREATE TABLE IF NOT EXISTS organisations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  plan       TEXT DEFAULT 'enterprise',
  settings   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert a default org for all existing single-tenant data
INSERT INTO organisations (id, name, slug, plan)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organisation', 'default', 'enterprise')
ON CONFLICT DO NOTHING;

-- ============================================================
-- USERS — add org_id + enterprise columns
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

-- Back-fill existing users to default org
UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- ============================================================
-- RBAC — field visibility per role
-- ============================================================
CREATE TABLE IF NOT EXISTS field_permissions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organisations(id),
  role       TEXT NOT NULL,
  table_name TEXT NOT NULL,
  field_name TEXT NOT NULL,
  can_view   BOOLEAN DEFAULT TRUE,
  can_edit   BOOLEAN DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, role, table_name, field_name)
);

-- ============================================================
-- USER DATA SCOPES (row-level access control)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_data_scopes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL DEFAULT 'all',
  segment_id  UUID,
  filter_json JSONB,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PERMISSION GRANTS (per-user overrides)
-- ============================================================
CREATE TABLE IF NOT EXISTS permission_grants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource   TEXT NOT NULL,
  granted    BOOLEAN DEFAULT TRUE,
  granted_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL,
  user_id       UUID,
  role          TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   UUID,
  old_values    JSONB,
  new_values    JSONB,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_log(user_id, created_at DESC);

-- ============================================================
-- CONTACTS — add enterprise columns
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_score NUMERIC(5,2);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_score_reason TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_scored_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intent_signals JSONB DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS research_summary TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS research_done BOOLEAN DEFAULT FALSE;

UPDATE contacts SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_ai_score ON contacts(org_id, ai_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_contacts_fts ON contacts USING GIN (
  to_tsvector('english',
    coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
    coalesce(email,'')      || ' ' || coalesce(company,'')  || ' ' ||
    coalesce(job_title,'')
  )
);

-- ============================================================
-- IMPORT BATCHES — enterprise columns
-- ============================================================
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS error_log JSONB DEFAULT '[]';
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS progress_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS skipped_rows INT DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS imported_by UUID REFERENCES users(id);
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

UPDATE import_batches SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- ============================================================
-- SEGMENTS — enterprise columns
-- ============================================================
ALTER TABLE segments ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
ALTER TABLE segments ADD COLUMN IF NOT EXISTS filter_logic TEXT DEFAULT 'AND';
ALTER TABLE segments ADD COLUMN IF NOT EXISTS last_count_at TIMESTAMPTZ;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS is_dynamic BOOLEAN DEFAULT TRUE;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS ai_rationale TEXT;

UPDATE segments SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- ============================================================
-- TEMPLATES — A/B + AI columns
-- ============================================================
ALTER TABLE templates ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS ai_score NUMERIC(5,2);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES templates(id);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS variant_label TEXT;

UPDATE templates SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- ============================================================
-- CAMPAIGNS — enterprise columns
-- ============================================================
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_test_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_split_pct INT DEFAULT 50;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_winner_metric TEXT DEFAULT 'open';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'auto';

UPDATE campaigns SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- ============================================================
-- CAMPAIGN CONTACTS — enterprise columns
-- ============================================================
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS template_variant TEXT DEFAULT 'A';
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS send_score NUMERIC(5,2);
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS last_event_type TEXT;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS provider_used TEXT;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

UPDATE campaign_contacts SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_cc_scheduled ON campaign_contacts(scheduled_at)
  WHERE status = 'queued';

-- ============================================================
-- EMAIL TRACKING (latest status per campaign_contact, PG-side)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_tracking (
  campaign_contact_id UUID PRIMARY KEY,
  campaign_id         UUID NOT NULL,
  contact_id          UUID NOT NULL,
  org_id              UUID NOT NULL,
  delivered_at        TIMESTAMPTZ,
  first_opened_at     TIMESTAMPTZ,
  last_opened_at      TIMESTAMPTZ,
  open_count          INT DEFAULT 0,
  first_clicked_at    TIMESTAMPTZ,
  click_count         INT DEFAULT 0,
  booked_at           TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  bounce_type         TEXT,
  unsubscribed_at     TIMESTAMPTZ,
  spam_at             TIMESTAMPTZ
);

-- ============================================================
-- EMAIL EVENTS — add org_id, url columns
-- ============================================================
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS email_client TEXT;

UPDATE email_events SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_org_campaign ON email_events(org_id, campaign_id, created_at DESC);

-- booking_url moved to templates (2025-04)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS booking_url TEXT;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS skipped_rows INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS include_unsubscribe BOOLEAN NOT NULL DEFAULT FALSE;

-- Email campaigns: first allowed send instant (combined date + time in timezone)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;
