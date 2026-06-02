require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
CREATE TABLE IF NOT EXISTS contact_enrichments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id              UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  org_id                  UUID NOT NULL,
  company_website         TEXT,
  company_linkedin_url    TEXT,
  company_description     TEXT,
  company_founded_year    INT,
  company_employee_range  TEXT,
  company_revenue_range   TEXT,
  company_industry        TEXT,
  company_hq_city         TEXT,
  company_hq_country      TEXT,
  company_tech_stack      TEXT[],
  company_funding_stage   TEXT,
  company_total_funding   TEXT,
  company_investors       TEXT[],
  company_recent_news     JSONB,
  company_g2_rating       NUMERIC(3,1),
  company_alexa_rank      INT,
  person_linkedin_url     TEXT,
  person_twitter_url      TEXT,
  person_bio              TEXT,
  person_location         TEXT,
  person_skills           TEXT[],
  person_past_companies   TEXT[],
  person_education        TEXT,
  person_languages        TEXT[],
  person_publications     TEXT[],
  signal_hiring_roles     TEXT[],
  signal_recently_funded  BOOLEAN DEFAULT FALSE,
  signal_job_change       BOOLEAN DEFAULT FALSE,
  signal_tech_adoption    TEXT[],
  signal_pain_keywords    TEXT[],
  field_confidence        JSONB DEFAULT '{}',
  field_sources           JSONB DEFAULT '{}',
  enrichment_model        TEXT DEFAULT 'claude-sonnet-4-20250514',
  enrichment_version      INT DEFAULT 1,
  enrichment_status       TEXT DEFAULT 'pending',
  enrichment_passes       INT DEFAULT 0,
  enrichment_started_at   TIMESTAMPTZ,
  enrichment_completed_at TIMESTAMPTZ,
  tokens_used             INT,
  error_message           TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id)
);

CREATE TABLE IF NOT EXISTS enrichment_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  job_type      TEXT NOT NULL,
  contact_ids   UUID[],
  segment_id    UUID,
  total         INT DEFAULT 0,
  completed     INT DEFAULT 0,
  failed        INT DEFAULT 0,
  status        TEXT DEFAULT 'queued',
  triggered_by  UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_enrichment_org      ON contact_enrichments (org_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_status   ON contact_enrichments (enrichment_status);
CREATE INDEX IF NOT EXISTS idx_enrichment_funding  ON contact_enrichments (signal_recently_funded) WHERE signal_recently_funded = TRUE;
CREATE INDEX IF NOT EXISTS idx_enrichment_hiring   ON contact_enrichments USING GIN (signal_hiring_roles);
CREATE INDEX IF NOT EXISTS idx_enrichment_tech     ON contact_enrichments USING GIN (company_tech_stack);
CREATE INDEX IF NOT EXISTS idx_enrichment_confidence ON contact_enrichments USING GIN (field_confidence);
CREATE INDEX IF NOT EXISTS idx_enrichjob_org       ON enrichment_jobs (org_id);
CREATE INDEX IF NOT EXISTS idx_enrichjob_status    ON enrichment_jobs (status);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS research_done BOOLEAN DEFAULT FALSE;
`;

pool.query(sql)
  .then(() => { console.log('Enrichment migration OK'); pool.end(); })
  .catch(e => { console.error('Migration failed:', e.message); pool.end(); process.exit(1); });
