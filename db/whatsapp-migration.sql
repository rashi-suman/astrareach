-- ============================================================
-- WhatsApp Marketing Module — Database Migration
-- Run once against the astrareach PostgreSQL database
-- ============================================================

-- 1. Extend contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_phone         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_opted_in      BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_opted_in_at   TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_session_active BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_last_reply_at  TIMESTAMPTZ;

-- 2. WABA phone numbers
CREATE TABLE IF NOT EXISTS wa_phone_numbers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  display_name        TEXT NOT NULL,
  phone_number        TEXT NOT NULL,
  phone_number_id     TEXT NOT NULL UNIQUE,
  waba_id             TEXT NOT NULL,
  bsp                 TEXT NOT NULL CHECK (bsp IN ('360dialog','twilio','meta_cloud')),
  bsp_api_key         TEXT,
  access_token        TEXT,
  tier                INT DEFAULT 1 CHECK (tier IN (1,2,3,4)),
  daily_limit         INT DEFAULT 1000,
  quality_score       TEXT DEFAULT 'GREEN' CHECK (quality_score IN ('GREEN','YELLOW','RED')),
  quality_updated_at  TIMESTAMPTZ,
  is_active           BOOLEAN DEFAULT TRUE,
  is_paused           BOOLEAN DEFAULT FALSE,
  pause_reason        TEXT,
  messages_sent_today INT DEFAULT 0,
  last_reset_date     DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 3. WhatsApp message templates
CREATE TABLE IF NOT EXISTS wa_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  phone_number_id  TEXT NOT NULL,
  name             TEXT NOT NULL,
  meta_template_id TEXT,
  category         TEXT NOT NULL CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  language         TEXT DEFAULT 'en',
  status           TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PAUSED')),
  header_type      TEXT CHECK (header_type IN ('TEXT','IMAGE','VIDEO','DOCUMENT')),
  header_content   TEXT,
  body_text        TEXT NOT NULL,
  footer_text      TEXT,
  buttons          JSONB DEFAULT '[]',
  variables        TEXT[] DEFAULT '{}',
  rejected_reason  TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, phone_number_id, name, language)
);

-- 4. WhatsApp campaigns
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','paused','completed','stopped','blocked')),
  phone_number_id     UUID REFERENCES wa_phone_numbers(id),
  template_id         UUID REFERENCES wa_templates(id),
  segment_id          UUID REFERENCES segments(id),
  daily_limit         INT DEFAULT 1000,
  messages_per_second NUMERIC(4,1) DEFAULT 1.0,
  send_time           TIME DEFAULT '10:00',
  timezone            TEXT DEFAULT 'Asia/Kolkata',
  total_contacts      INT DEFAULT 0,
  messages_sent       INT DEFAULT 0,
  messages_sent_today INT DEFAULT 0,
  last_reset_date     DATE,
  variable_mapping    JSONB DEFAULT '{}',
  booking_url         TEXT,
  scheduled_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Campaign contact records
CREATE TABLE IF NOT EXISTS wa_campaign_contacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  campaign_id       UUID NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  contact_id        UUID NOT NULL REFERENCES contacts(id),
  phone_number      TEXT NOT NULL,
  status            TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','queued','sent','delivered','read','replied','failed','opted_out','invalid_number')),
  personalized_vars JSONB DEFAULT '{}',
  wa_message_id     TEXT,
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  replied_at        TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  failure_code      TEXT,
  failure_reason    TEXT,
  retry_count       INT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_wacc_campaign_status ON wa_campaign_contacts (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_wacc_wa_message_id   ON wa_campaign_contacts (wa_message_id);
CREATE INDEX IF NOT EXISTS idx_wacc_phone           ON wa_campaign_contacts (phone_number);

-- 6. Opt-in / opt-out registry
CREATE TABLE IF NOT EXISTS wa_opt_ins (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  contact_id       UUID REFERENCES contacts(id),
  phone_number     TEXT NOT NULL,
  status           TEXT DEFAULT 'opted_in' CHECK (status IN ('opted_in','opted_out')),
  source           TEXT,
  opted_in_at      TIMESTAMPTZ DEFAULT NOW(),
  opted_out_at     TIMESTAMPTZ,
  opted_out_reason TEXT,
  UNIQUE(org_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_optins_phone ON wa_opt_ins (org_id, phone_number, status);

-- 7. Inbound messages
CREATE TABLE IF NOT EXISTS wa_inbound_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  phone_number_id   TEXT NOT NULL,
  from_phone        TEXT NOT NULL,
  contact_id        UUID REFERENCES contacts(id),
  wa_message_id     TEXT UNIQUE,
  message_type      TEXT,
  message_body      TEXT,
  button_payload    TEXT,
  media_url         TEXT,
  in_reply_to_wamid TEXT,
  session_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_inbound_from ON wa_inbound_messages (from_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_inbound_contact ON wa_inbound_messages (contact_id, created_at DESC);

-- 8. WhatsApp events (PostgreSQL analytics store)
CREATE TABLE IF NOT EXISTS wa_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID,
  campaign_id    UUID,
  wacc_id        UUID,
  contact_id     UUID,
  phone_number   TEXT,
  event_type     TEXT,
  failure_code   TEXT,
  button_payload TEXT,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_events_campaign ON wa_events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_events_org      ON wa_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_events_type     ON wa_events (event_type, created_at DESC);

-- Audience for WA campaigns: contacts_opted_in = contacts.whatsapp_opted_in + optional segment;
-- wa_registry = intersection with wa_opt_ins (status opted_in) + optional segment
ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS audience_source TEXT DEFAULT 'contacts_opted_in';
