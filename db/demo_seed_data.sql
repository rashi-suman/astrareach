-- =============================================================================
-- AstraReach — Demo seed data (SQL)
-- =============================================================================
-- IDs: omitted wherever the column has DEFAULT gen_random_uuid() / serial.
-- Links: resolved via organisations.slug, users.email, contacts.email, and
--        stable demo names (campaigns, segments, templates, WA meta ids).
--
-- Prerequisites: schema.sql → migration.sql → migrate-enrichment.js →
--                  whatsapp-migration.sql (run the full file through the end;
--                  tail adds wa_campaigns.audience_source — optional for app UI)
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/demo_seed_data.sql
--
-- Demo login:
--   demo.seed@astrareach.local / DemoSeed2026!
--
-- Organisation: uses existing row organisations.slug = 'default' (from
-- migration.sql). No hardcoded org UUID in this file.
--
-- Analytics (30-day charts): extra email_events / wa_events use metadata
--   demo_seed = email_analytics_30d | wa_analytics_30d | wa_analytics_optout
--   (idempotent — delete those rows to re-insert the series only).
-- =============================================================================

BEGIN;

-- Keep in sync with db/whatsapp-migration.sql (line ~170). Harmless if already applied.
ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS audience_source TEXT DEFAULT 'contacts_opted_in';

-- -----------------------------------------------------------------------------
-- DEMO CLEANUP (optional — uncomment to remove previous demo rows)
-- -----------------------------------------------------------------------------
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM email_events WHERE campaign_id IN (SELECT id FROM campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM email_tracking WHERE campaign_id IN (SELECT id FROM campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM campaign_contacts WHERE campaign_id IN (SELECT id FROM campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM wa_events WHERE org_id = (TABLE o) AND campaign_id IN (SELECT id FROM wa_campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM wa_inbound_messages WHERE org_id = (TABLE o) AND wa_message_id LIKE 'demo_wamid_%';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM wa_campaign_contacts WHERE campaign_id IN (SELECT id FROM wa_campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM wa_campaigns WHERE org_id = (TABLE o) AND name LIKE 'Demo:%';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM wa_opt_ins WHERE org_id = (TABLE o) AND source = 'demo_seed';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM contact_enrichments WHERE org_id = (TABLE o) AND contact_id IN (SELECT id FROM contacts WHERE org_id = (TABLE o) AND email LIKE '%@demo.astrareach.local');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM enrichment_jobs WHERE org_id = (TABLE o) AND triggered_by IN (SELECT id FROM users WHERE email = 'demo.seed@astrareach.local');
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM contacts WHERE org_id = (TABLE o) AND email LIKE '%@demo.astrareach.local';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM wa_templates WHERE org_id = (TABLE o) AND name LIKE 'demo_%';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM wa_phone_numbers WHERE org_id = (TABLE o) AND phone_number_id = 'DEMO_META_PN_ID_001';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM segments WHERE org_id = (TABLE o) AND name LIKE 'Demo:%';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM templates WHERE org_id = (TABLE o) AND name LIKE 'Demo:%';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1) DELETE FROM import_batches WHERE org_id = (TABLE o) AND filename = 'demo_import_batch.csv';
-- DELETE FROM users WHERE email = 'demo.seed@astrareach.local';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM email_events WHERE org_id = (TABLE o) AND metadata->>'demo_seed' = 'email_analytics_30d';
-- WITH o AS (SELECT id FROM organisations WHERE slug = 'default' LIMIT 1)
-- DELETE FROM wa_events WHERE org_id = (TABLE o) AND metadata->>'demo_seed' IN ('wa_analytics_30d','wa_analytics_optout');

-- -----------------------------------------------------------------------------
-- 1) Demo user
-- -----------------------------------------------------------------------------
INSERT INTO users (name, email, password_hash, role, avatar_initials, org_id, is_active)
SELECT
  'Demo Administrator',
  'demo.seed@astrareach.local',
  '$2a$12$don0kGvuSAQMk2TrcWdEoOUVHZLkEo7ajgWzxNUbFbTQb81fds5B2',
  'superadmin',
  'DA',
  o.id,
  TRUE
FROM organisations o
WHERE o.slug = 'default'
LIMIT 1
ON CONFLICT (email) DO UPDATE SET
  name              = EXCLUDED.name,
  org_id            = EXCLUDED.org_id,
  role              = EXCLUDED.role,
  avatar_initials   = EXCLUDED.avatar_initials,
  is_active         = EXCLUDED.is_active;

-- -----------------------------------------------------------------------------
-- 2) Import batch
-- -----------------------------------------------------------------------------
INSERT INTO import_batches (
  org_id, filename, total_rows, imported_rows, duplicate_rows, error_rows,
  column_mapping, status, uploaded_by, imported_by, progress_pct, completed_at
)
SELECT
  o.id,
  'demo_import_batch.csv',
  12, 12, 0, 0,
  '{"email":"email","first_name":"first_name","company":"company","industry":"industry","country":"country"}'::jsonb,
  'completed',
  u.id,
  u.id,
  100,
  NOW() - INTERVAL '5 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM import_batches ib
    WHERE ib.org_id = o.id AND ib.filename = 'demo_import_batch.csv'
  );

-- -----------------------------------------------------------------------------
-- 3) Contacts
-- -----------------------------------------------------------------------------
INSERT INTO contacts (
  org_id, email, first_name, last_name, company, job_title, phone, website,
  industry, city, country, linkedin_url, revenue_range, employee_count, tags,
  custom_fields, research_summary, research_done, enriched_at, status, source,
  import_batch_id, ai_score, ai_score_reason, intent_signals,
  whatsapp_phone, whatsapp_opted_in, whatsapp_opted_in_at, whatsapp_session_active, whatsapp_last_reply_at
)
SELECT
  o.id,
  v.email,
  v.first_name,
  v.last_name,
  v.company,
  v.job_title,
  v.phone,
  v.website,
  v.industry,
  v.city,
  v.country,
  v.linkedin_url,
  v.revenue_range,
  v.employee_count,
  v.tags,
  v.custom_fields,
  v.research_summary,
  v.research_done,
  v.enriched_at,
  v.status,
  v.source,
  CASE WHEN v.source = 'demo_csv' THEN ib.id ELSE NULL END,
  v.ai_score,
  v.ai_score_reason,
  v.intent_signals,
  v.whatsapp_phone,
  v.whatsapp_opted_in,
  v.whatsapp_opted_in_at,
  v.whatsapp_session_active,
  v.whatsapp_last_reply_at
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('priya.verma@demo.astrareach.local','Priya','Verma','Northwind Analytics Pvt Ltd','VP of Revenue Operations','+91-98765-43201','https://northwind-analytics.demo','Computer Software','Bengaluru','India','https://linkedin.com/in/demo-priya-verma','USD 10M–50M','200–500',ARRAY['enterprise','saas','decision-maker']::text[],'{"crm":"HubSpot","outreach_volume":"high","budget_cycle":"Q2"}'::jsonb,'Fast-growing SaaS; evaluating outbound tooling for APAC expansion.',TRUE,NOW() - INTERVAL '2 days','active','demo_csv',88.50,'Strong ICP fit: B2B SaaS leadership, hiring SDRs, recent funding signal.','{"signals":["hiring_sdrs","evaluating_crms"],"intent":"high"}'::jsonb,'+919876543201',TRUE,NOW() - INTERVAL '30 days',TRUE,NOW() - INTERVAL '1 day'),
  ('arjun.mehta@demo.astrareach.local','Arjun','Mehta','BlueRiver FinTech','Director of Growth','+91-98765-43202','https://blueriver-fintech.demo','Financial Services','Mumbai','India','https://linkedin.com/in/demo-arjun-mehta','USD 50M–100M','500–1000',ARRAY['fintech','mid-market']::text[],'{"compliance":"SOC2","stack":"Salesforce"}'::jsonb,'Regulated lender digitizing customer onboarding; exploring automation.',TRUE,NOW() - INTERVAL '3 days','active','demo_csv',76.00,'Good fit; compliance-heavy sales cycle.','{"intent":"medium"}'::jsonb,'+919876543202',TRUE,NOW() - INTERVAL '20 days',FALSE,NULL),
  ('ananya.iyer@demo.astrareach.local','Ananya','Iyer','Helio Commerce','Head of Sales','+91-98765-43203','https://helio-commerce.demo','E-commerce Technology','Hyderabad','India',NULL,'USD 5M–10M','50–200',ARRAY['ecommerce','pipeline']::text[],'{"channels":"email_first"}'::jsonb,NULL,FALSE,NULL,'active','demo_csv',NULL,NULL,'{}'::jsonb,'+919876543203',FALSE,NULL,FALSE,NULL),
  ('marcus.chen@demo.astrareach.local','Marcus','Chen','Apex Ledger Capital','Chief Operating Officer','+1-415-555-0104','https://apex-ledger.demo','Capital Markets','San Francisco','United States','https://linkedin.com/in/demo-marcus-chen','USD 100M+','1000+',ARRAY['enterprise','fintech','us']::text[],'{"expansion":"emea"}'::jsonb,'Large institution; multi-stakeholder buying committee.',TRUE,NOW() - INTERVAL '7 days','active','linkedin',92.00,'Enterprise account; high LTV potential.','{"intent":"high"}'::jsonb,'+14155550104',TRUE,NOW() - INTERVAL '10 days',FALSE,NULL),
  ('sofia.rossi@demo.astrareach.local','Sofia','Rossi','Alpine Manufacturing S.p.A.','Procurement Director','+39-02-5555-0105','https://alpine-mfg.demo','Industrial Manufacturing','Milan','Italy',NULL,'USD 25M–50M','500–1000',ARRAY['manufacturing','eu']::text[],'{"erp":"SAP"}'::jsonb,NULL,FALSE,NULL,'active','web_form',64.50,'Operational buyer; longer cycle.','{"intent":"low"}'::jsonb,NULL,FALSE,NULL,FALSE,NULL),
  ('liam.obrien@demo.astrareach.local','Liam','O''Brien','HarborStack Technologies','IT Director','+353-1-555-0106','https://harborstack.demo','Information Technology','Dublin','Ireland',NULL,'USD 10M–25M','200–500',ARRAY['tech','eu']::text[],'{}'::jsonb,NULL,FALSE,NULL,'bounced','purchased_list',NULL,NULL,'{}'::jsonb,NULL,FALSE,NULL,FALSE,NULL),
  ('emma.wright@demo.astrareach.local','Emma','Wright','Crescent Health Systems','Clinical Operations Lead','+44-20-7946-0107','https://crescent-health.demo','Hospital & Health Care','London','United Kingdom',NULL,'USD 50M–100M','1000+',ARRAY['healthcare']::text[],'{"privacy":"HIPAA-like"}'::jsonb,NULL,FALSE,NULL,'unsubscribed','event',55.00,'Unsubscribed after nurture sequence.','{"intent":"cold"}'::jsonb,NULL,FALSE,NULL,FALSE,NULL),
  ('diego.martinez@demo.astrareach.local','Diego','Martinez','Solstice Solar Co.','Founder','+34-91-555-0108','https://solstice-solar.demo','Renewables & Environment','Madrid','Spain',NULL,'USD 1M–5M','11–50',ARRAY['startup','green_energy']::text[],'{"stage":"seed"}'::jsonb,NULL,FALSE,NULL,'active','referral',70.00,'Founder-led; quick decisions if value is clear.','{"intent":"medium"}'::jsonb,NULL,FALSE,NULL,FALSE,NULL),
  ('yuki.tanaka@demo.astrareach.local','Yuki','Tanaka','Kite Mobility KK','GM of Business Development','+81-3-5555-0109','https://kite-mobility.demo','Computer Software','Tokyo','Japan',NULL,'USD 25M–50M','200–500',ARRAY['enterprise','apac']::text[],'{"localization":"required"}'::jsonb,'Completed enrichment: strong product-market fit in mobility SaaS.',TRUE,NOW() - INTERVAL '1 day','active','partner',81.25,'APAC expansion motion; multi-language outreach.','{"intent":"high"}'::jsonb,'+819012345678',TRUE,NOW() - INTERVAL '14 days',FALSE,NULL),
  ('olivia.nguyen@demo.astrareach.local','Olivia','Nguyen','Vertex Cyber Labs','CISO','+61-2-5550-0110','https://vertex-cyber.demo','Computer & Network Security','Sydney','Australia',NULL,'USD 50M–100M','500–1000',ARRAY['security','enterprise']::text[],'{"procurement":"rfp"}'::jsonb,'Security buyer; prefers concise technical proof points.',TRUE,NOW() - INTERVAL '4 days','active','demo_csv',85.00,'Security vertical; high scrutiny.','{"intent":"medium"}'::jsonb,'+61491570156',TRUE,NOW() - INTERVAL '8 days',TRUE,NOW() - INTERVAL '2 days'),
  ('noah.kim@demo.astrareach.local','Noah','Kim','PulseHR','VP People & Talent','+82-2-555-0111','https://pulsehr.demo','Human Resources Technology','Seoul','South Korea',NULL,'USD 5M–10M','50–200',ARRAY['hr_tech']::text[],'{"ats":"Greenhouse"}'::jsonb,NULL,FALSE,NULL,'active','inbound',NULL,NULL,'{}'::jsonb,'+821012345678',FALSE,NULL,FALSE,NULL),
  ('ava.thompson@demo.astrareach.local','Ava','Thompson','Lumen Retail Group','Chief Digital Officer','+1-212-555-0112','https://lumen-retail.demo','Retail','New York','United States',NULL,'USD 100M+','1000+',ARRAY['retail','enterprise','decision-maker']::text[],'{"omnichannel":"priority"}'::jsonb,'Retail transformation program; evaluating vendor consolidation.',TRUE,NOW() - INTERVAL '6 hours','active','conference',90.00,'Strategic digital leader; multi-brand rollouts.','{"intent":"high"}'::jsonb,'+12125550112',TRUE,NOW() - INTERVAL '3 days',FALSE,NULL)
) AS v(
  email, first_name, last_name, company, job_title, phone, website, industry, city, country,
  linkedin_url, revenue_range, employee_count, tags, custom_fields, research_summary,
  research_done, enriched_at, status, source, ai_score, ai_score_reason, intent_signals,
  whatsapp_phone, whatsapp_opted_in, whatsapp_opted_in_at, whatsapp_session_active, whatsapp_last_reply_at
)
LEFT JOIN LATERAL (
  SELECT ib.id FROM import_batches ib
  WHERE ib.org_id = o.id AND ib.filename = 'demo_import_batch.csv'
  ORDER BY ib.created_at DESC LIMIT 1
) ib ON TRUE
WHERE o.slug = 'default'
ON CONFLICT (email) DO UPDATE SET
  org_id            = EXCLUDED.org_id,
  first_name        = EXCLUDED.first_name,
  last_name         = EXCLUDED.last_name,
  company           = EXCLUDED.company,
  job_title         = EXCLUDED.job_title,
  phone             = EXCLUDED.phone,
  website           = EXCLUDED.website,
  industry          = EXCLUDED.industry,
  city              = EXCLUDED.city,
  country           = EXCLUDED.country,
  linkedin_url      = EXCLUDED.linkedin_url,
  revenue_range     = EXCLUDED.revenue_range,
  employee_count    = EXCLUDED.employee_count,
  tags              = EXCLUDED.tags,
  custom_fields     = EXCLUDED.custom_fields,
  research_summary  = EXCLUDED.research_summary,
  research_done     = EXCLUDED.research_done,
  enriched_at       = EXCLUDED.enriched_at,
  status            = EXCLUDED.status,
  source            = EXCLUDED.source,
  import_batch_id   = COALESCE(EXCLUDED.import_batch_id, contacts.import_batch_id),
  ai_score          = EXCLUDED.ai_score,
  ai_score_reason   = EXCLUDED.ai_score_reason,
  intent_signals    = EXCLUDED.intent_signals,
  whatsapp_phone    = EXCLUDED.whatsapp_phone,
  whatsapp_opted_in = EXCLUDED.whatsapp_opted_in,
  whatsapp_opted_in_at = EXCLUDED.whatsapp_opted_in_at,
  whatsapp_session_active = EXCLUDED.whatsapp_session_active,
  whatsapp_last_reply_at = EXCLUDED.whatsapp_last_reply_at,
  updated_at        = NOW();

-- Patch import_batch_id for demo_csv rows (UPSERT may have left it null on conflict)
UPDATE contacts c SET import_batch_id = ib.id, updated_at = NOW()
FROM import_batches ib
JOIN organisations o ON o.id = ib.org_id AND o.slug = 'default'
WHERE c.org_id = o.id AND c.source = 'demo_csv' AND c.email LIKE '%@demo.astrareach.local'
  AND ib.filename = 'demo_import_batch.csv';

-- -----------------------------------------------------------------------------
-- 4) Segments
-- -----------------------------------------------------------------------------
INSERT INTO segments (org_id, name, description, filters, filter_logic, contact_count, is_dynamic, ai_generated, ai_rationale, created_by, last_count_at)
SELECT o.id, 'Demo: India — Software leaders', 'Indian contacts in software-related industries (for regional campaigns).',
  '{"logic":"AND","rules":[{"field":"country","op":"equals","value":"India"},{"field":"industry","op":"contains","value":"Software"}]}'::jsonb,
  'AND', 6, TRUE, FALSE, NULL, u.id, NOW() - INTERVAL '1 hour'
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: India — Software leaders');

INSERT INTO segments (org_id, name, description, filters, filter_logic, contact_count, is_dynamic, ai_generated, ai_rationale, created_by, last_count_at)
SELECT o.id, 'Demo: Enterprise tag audience', 'Contacts tagged as enterprise or decision-maker.',
  '{"logic":"AND","rules":[{"field":"tags","op":"contains_any","value":["enterprise","decision-maker"]}]}'::jsonb,
  'AND', 5, TRUE, FALSE, NULL, u.id, NOW() - INTERVAL '1 hour'
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: Enterprise tag audience');

INSERT INTO segments (org_id, name, description, filters, filter_logic, contact_count, is_dynamic, ai_generated, ai_rationale, created_by, last_count_at)
SELECT o.id, 'Demo: WhatsApp opted-in', 'Contacts who opted in for WhatsApp (template + broadcast demos).',
  '{"logic":"AND","rules":[{"field":"whatsapp_opted_in","op":"equals","value":true}]}'::jsonb,
  'AND', 7, TRUE, FALSE, NULL, u.id, NOW() - INTERVAL '1 hour'
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: WhatsApp opted-in');

INSERT INTO segments (org_id, name, description, filters, filter_logic, contact_count, is_dynamic, ai_generated, ai_rationale, created_by, last_count_at)
SELECT o.id, 'Demo: US + Fintech (AI-style label)', 'US-based financial services audience — useful for “AI segment” storyline in demos.',
  '{"logic":"AND","rules":[{"field":"country","op":"equals","value":"United States"},{"field":"industry","op":"contains","value":"Fin"}]}'::jsonb,
  'AND', 2, TRUE, TRUE, 'Plain-English intent: United States financial services buyers and operators.', u.id, NOW() - INTERVAL '1 hour'
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: US + Fintech (AI-style label)');

-- -----------------------------------------------------------------------------
-- 5) Email templates (primary first, then variant with parent_id subquery)
-- -----------------------------------------------------------------------------
INSERT INTO templates (org_id, name, subject, body_html, variables, preview_text, booking_url, include_unsubscribe, ai_generated, ai_score, version, parent_id, variant_label, created_by)
SELECT o.id, 'Demo: Executive outbound — primary', 'A cleaner outbound motion for {{company}}',
$html$
  <p>Hi {{first_name}},</p>
  <p>Teams like <strong>{{company}}</strong> usually outgrow spreadsheet tracking once they pass ~50k outbound touches / quarter.</p>
  <p>I put together a 6-minute walkthrough that shows how {{company}} could:</p>
  <ul>
    <li>segment faster,</li>
    <li>personalize at scale,</li>
    <li>and prove pipeline impact by campaign.</li>
  </ul>
  <p>If you are open to it, pick a time here: <a href="{{booking_url}}">book a short call</a>.</p>
  <p>Best,<br/>Demo Team</p>
  <p style="font-size:11px;color:#888;">If you prefer not to hear from us, <a href="{{unsubscribe_url}}">unsubscribe</a>.</p>
$html$,
  ARRAY['first_name','company','booking_url','unsubscribe_url']::text[],
  'Short executive note with CTA and unsubscribe.',
  'https://cal.example.com/astrareach-demo', TRUE, FALSE, NULL, 1, NULL, NULL, u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Executive outbound — primary');

INSERT INTO templates (org_id, name, subject, body_html, variables, preview_text, booking_url, include_unsubscribe, ai_generated, ai_score, version, parent_id, variant_label, created_by)
SELECT o.id, 'Demo: Executive outbound — variant B', 'Quick question on {{company}}''s outbound stack',
$html$
  <p>{{first_name}} — quick question.</p>
  <p>Are you still owning outbound tooling decisions at {{company}}?</p>
  <p>If yes, I can share how similar teams cut manual research time by ~40% without sacrificing personalization.</p>
  <p><a href="{{booking_url}}">15-minute fit call</a></p>
$html$,
  ARRAY['first_name','company','booking_url']::text[],
  'Alternate angle — shorter ask.',
  'https://cal.example.com/astrareach-demo', FALSE, TRUE, 82.50, 2,
  (SELECT t.id FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Executive outbound — primary' LIMIT 1),
  'B', u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Executive outbound — variant B');

INSERT INTO templates (org_id, name, subject, body_html, variables, preview_text, booking_url, include_unsubscribe, ai_generated, version, created_by)
SELECT o.id, 'Demo: Nurture follow-up', 'Following up: resources for {{job_title}} teams',
$html$
  <p>Hi {{first_name}},</p>
  <p>Sending the deck we discussed — tailored for <strong>{{job_title}}</strong> leaders in {{industry}}.</p>
  <p>Reply with “metrics” and I will share the benchmark pack.</p>
$html$,
  ARRAY['first_name','job_title','industry']::text[],
  'Low-friction nurture.', NULL, FALSE, FALSE, 1, u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Nurture follow-up');

-- -----------------------------------------------------------------------------
-- 6) Campaigns
-- -----------------------------------------------------------------------------
INSERT INTO campaigns (
  org_id, name, description, status, template_id, segment_id,
  daily_limit, send_time, timezone, total_contacts, emails_sent, emails_sent_today,
  last_reset_date, ai_research_enabled, booking_url, started_at, completed_at,
  created_by, ab_test_enabled, ab_split_pct, ab_winner_metric, provider, scheduled_start_at
)
SELECT
  o.id, 'Demo: Q2 — Enterprise pulse (completed)', 'Completed campaign showcasing opens, clicks, replies, and bounces in analytics.',
  'completed',
  (SELECT t.id FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Executive outbound — primary' LIMIT 1),
  (SELECT s.id FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: Enterprise tag audience' LIMIT 1),
  400, '10:15'::time, 'Asia/Kolkata', 10, 10, 0, CURRENT_DATE, TRUE, 'https://cal.example.com/astrareach-demo',
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '2 days', u.id, TRUE, 50, 'open', 'resend', NULL
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.org_id = o.id AND c.name = 'Demo: Q2 — Enterprise pulse (completed)');

INSERT INTO campaigns (
  org_id, name, description, status, template_id, segment_id,
  daily_limit, send_time, timezone, total_contacts, emails_sent, emails_sent_today,
  last_reset_date, ai_research_enabled, booking_url, started_at, completed_at,
  created_by, ab_test_enabled, ab_split_pct, ab_winner_metric, provider, scheduled_start_at
)
SELECT
  o.id, 'Demo: Active pilot — India SaaS', 'In-flight campaign for India software leaders.', 'active',
  (SELECT t.id FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Executive outbound — primary' LIMIT 1),
  (SELECT s.id FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: India — Software leaders' LIMIT 1),
  250, '09:30'::time, 'Asia/Kolkata', 6, 3, 3, CURRENT_DATE, TRUE, 'https://cal.example.com/astrareach-demo',
  NOW() - INTERVAL '2 days', NULL, u.id, FALSE, 50, 'open', 'resend', NULL
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.org_id = o.id AND c.name = 'Demo: Active pilot — India SaaS');

INSERT INTO campaigns (
  org_id, name, description, status, template_id, segment_id,
  daily_limit, send_time, timezone, total_contacts, emails_sent, emails_sent_today,
  last_reset_date, ai_research_enabled, booking_url, started_at, completed_at,
  created_by, ab_test_enabled, ab_split_pct, ab_winner_metric, provider, scheduled_start_at
)
SELECT
  o.id, 'Demo: Draft — Product launch teaser', 'Draft state for wizard / approval demos.', 'draft',
  (SELECT t.id FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Nurture follow-up' LIMIT 1),
  (SELECT s.id FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: US + Fintech (AI-style label)' LIMIT 1),
  100, '11:00'::time, 'America/New_York', 0, 0, 0, NULL, FALSE, NULL, NULL, NULL, u.id, FALSE, 50, 'open', 'auto', NULL
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.org_id = o.id AND c.name = 'Demo: Draft — Product launch teaser');

INSERT INTO campaigns (
  org_id, name, description, status, template_id, segment_id,
  daily_limit, send_time, timezone, total_contacts, emails_sent, emails_sent_today,
  last_reset_date, ai_research_enabled, booking_url, started_at, completed_at,
  created_by, ab_test_enabled, ab_split_pct, ab_winner_metric, provider, scheduled_start_at
)
SELECT
  o.id, 'Demo: Scheduled — Monday kickoff', 'Scheduled start demo (future send window).', 'scheduled',
  (SELECT t.id FROM templates t WHERE t.org_id = o.id AND t.name = 'Demo: Executive outbound — variant B' LIMIT 1),
  (SELECT s.id FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: WhatsApp opted-in' LIMIT 1),
  80, '08:00'::time, 'Europe/London', 0, 0, 0, NULL, TRUE, 'https://cal.example.com/astrareach-demo', NULL, NULL, u.id, FALSE, 50, 'click', 'resend', NOW() + INTERVAL '3 days'
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.org_id = o.id AND c.name = 'Demo: Scheduled — Monday kickoff');

-- -----------------------------------------------------------------------------
-- 7) Campaign contacts
-- -----------------------------------------------------------------------------
INSERT INTO campaign_contacts (
  org_id, campaign_id, contact_id, status, personalized_subject, personalized_body_html,
  sent_at, last_event_at, retry_count, error_message, template_variant, send_score, scheduled_at,
  last_event_type, provider_used, provider_message_id
)
SELECT o.id, camp.id, ct.id, v.status, v.personalized_subject, v.personalized_body_html,
  v.sent_at, v.last_event_at, v.retry_count, v.error_message, v.template_variant, v.send_score, v.scheduled_at,
  v.last_event_type, v.provider_used, v.provider_message_id
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local','booked','Re: A cleaner outbound motion for Northwind Analytics Pvt Ltd',NULL::text,NOW() - INTERVAL '18 days',NOW() - INTERVAL '1 day',0,NULL::text,'A',91::numeric,NULL::timestamptz,'booked'::text,'resend','demo_msg_priya_001'),
  ('Demo: Q2 — Enterprise pulse (completed)','arjun.mehta@demo.astrareach.local','clicked',NULL,NULL,NOW() - INTERVAL '17 days',NOW() - INTERVAL '5 days',0,NULL,'A',84,NOW() - INTERVAL '17 days','clicked','resend','demo_msg_arjun_002'),
  ('Demo: Q2 — Enterprise pulse (completed)','marcus.chen@demo.astrareach.local','opened',NULL,NULL,NOW() - INTERVAL '16 days',NOW() - INTERVAL '4 days',0,NULL,'B',79,NOW() - INTERVAL '16 days','opened','resend','demo_msg_marcus_003'),
  ('Demo: Q2 — Enterprise pulse (completed)','olivia.nguyen@demo.astrareach.local','delivered',NULL,NULL,NOW() - INTERVAL '15 days',NOW() - INTERVAL '15 days',0,NULL,'A',72,NOW() - INTERVAL '15 days','delivered','resend','demo_msg_olivia_004'),
  ('Demo: Q2 — Enterprise pulse (completed)','ava.thompson@demo.astrareach.local','sent',NULL,NULL,NOW() - INTERVAL '14 days',NOW() - INTERVAL '14 days',0,NULL,'A',68,NOW() - INTERVAL '14 days','sent','resend','demo_msg_ava_005'),
  ('Demo: Q2 — Enterprise pulse (completed)','liam.obrien@demo.astrareach.local','bounced',NULL,NULL,NOW() - INTERVAL '14 days',NOW() - INTERVAL '14 days',0,'Mailbox unavailable','A',NULL,NOW() - INTERVAL '14 days','bounced','resend',NULL),
  ('Demo: Q2 — Enterprise pulse (completed)','emma.wright@demo.astrareach.local','unsubscribed',NULL,NULL,NOW() - INTERVAL '13 days',NOW() - INTERVAL '12 days',0,NULL,'A',61,NOW() - INTERVAL '12 days','unsubscribed','resend','demo_msg_emma_007'),
  ('Demo: Q2 — Enterprise pulse (completed)','yuki.tanaka@demo.astrareach.local','failed',NULL,NULL,NULL,NOW() - INTERVAL '10 days',2,'Rate limit exceeded','B',55,NULL,'failed','resend',NULL),
  ('Demo: Active pilot — India SaaS','priya.verma@demo.astrareach.local','opened',NULL,NULL,NOW() - INTERVAL '1 day',NOW() - INTERVAL '20 hours',0,NULL,'A',88,NULL,'opened','resend','demo_active_009'),
  ('Demo: Active pilot — India SaaS','arjun.mehta@demo.astrareach.local','queued',NULL,NULL,NULL,NULL,0,NULL,'A',80,NOW() + INTERVAL '2 hours',NULL,'resend',NULL),
  ('Demo: Active pilot — India SaaS','ananya.iyer@demo.astrareach.local','pending',NULL,NULL,NULL,NULL,0,NULL,'A',NULL,NULL,NULL,NULL,NULL),
  ('Demo: Active pilot — India SaaS','diego.martinez@demo.astrareach.local','researching',NULL,NULL,NULL,NULL,0,NULL,'A',NULL,NULL,NULL,NULL,NULL),
  ('Demo: Active pilot — India SaaS','sofia.rossi@demo.astrareach.local','ready',NULL,NULL,NULL,NULL,0,NULL,'A',74,NULL,NULL,NULL,NULL),
  ('Demo: Active pilot — India SaaS','noah.kim@demo.astrareach.local','pending',NULL,NULL,NULL,NULL,0,NULL,'A',NULL,NULL,NULL,NULL,NULL)
) AS v(campaign_name, contact_email, status, personalized_subject, personalized_body_html, sent_at, last_event_at, retry_count, error_message, template_variant, send_score, scheduled_at, last_event_type, provider_used, provider_message_id)
INNER JOIN campaigns camp ON camp.org_id = o.id AND camp.name = v.campaign_name
INNER JOIN contacts ct ON ct.org_id = o.id AND ct.email = v.contact_email
WHERE o.slug = 'default'
ON CONFLICT (campaign_id, contact_id) DO UPDATE SET
  status               = EXCLUDED.status,
  personalized_subject = EXCLUDED.personalized_subject,
  personalized_body_html = EXCLUDED.personalized_body_html,
  sent_at              = EXCLUDED.sent_at,
  last_event_at        = EXCLUDED.last_event_at,
  retry_count          = EXCLUDED.retry_count,
  error_message        = EXCLUDED.error_message,
  template_variant     = EXCLUDED.template_variant,
  send_score           = EXCLUDED.send_score,
  scheduled_at         = EXCLUDED.scheduled_at,
  last_event_type      = EXCLUDED.last_event_type,
  provider_used        = EXCLUDED.provider_used,
  provider_message_id  = EXCLUDED.provider_message_id;

-- -----------------------------------------------------------------------------
-- 8) Email events (id omitted — uses DEFAULT gen_random_uuid())
-- -----------------------------------------------------------------------------
INSERT INTO email_events (campaign_contact_id, campaign_id, contact_id, event_type, metadata, ip_address, user_agent, org_id, url, country, device_type, email_client, created_at)
SELECT cc.id, camp.id, ct.id, v.event_type, v.metadata::jsonb, v.ip_address, v.user_agent, o.id, v.url, v.country, v.device_type, v.email_client, v.created_at
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local','sent','{}','203.0.113.10','Mozilla/5.0 Demo',NULL::text,'IN','desktop','Gmail',NOW() - INTERVAL '18 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local','delivered','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '18 days' + INTERVAL '2 minutes'),
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local','opened','{}','203.0.113.10','Mozilla/5.0 Demo',NULL::text,'IN','desktop','Gmail',NOW() - INTERVAL '17 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local','clicked','{"url":"https://cal.example.com/astrareach-demo"}','203.0.113.10','Mozilla/5.0 Demo','https://cal.example.com/astrareach-demo','IN','desktop','Gmail',NOW() - INTERVAL '16 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local','booked','{"source":"demo"}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '1 day'),
  ('Demo: Q2 — Enterprise pulse (completed)','arjun.mehta@demo.astrareach.local','sent','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '17 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','arjun.mehta@demo.astrareach.local','delivered','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '17 days' + INTERVAL '90 seconds'),
  ('Demo: Q2 — Enterprise pulse (completed)','arjun.mehta@demo.astrareach.local','opened','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '16 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','arjun.mehta@demo.astrareach.local','clicked','{"url":"https://northwind-analytics.demo/resources/outbound-checklist"}',NULL,NULL,'https://northwind-analytics.demo/resources/outbound-checklist','IN','mobile','Gmail',NOW() - INTERVAL '5 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','liam.obrien@demo.astrareach.local','sent','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '14 days'),
  ('Demo: Q2 — Enterprise pulse (completed)','liam.obrien@demo.astrareach.local','bounced','{"reason":"smtp 550"}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '14 days' + INTERVAL '30 seconds'),
  ('Demo: Q2 — Enterprise pulse (completed)','emma.wright@demo.astrareach.local','unsubscribed','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '12 days'),
  ('Demo: Active pilot — India SaaS','priya.verma@demo.astrareach.local','sent','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '26 hours'),
  ('Demo: Active pilot — India SaaS','priya.verma@demo.astrareach.local','delivered','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '25 hours'),
  ('Demo: Active pilot — India SaaS','priya.verma@demo.astrareach.local','opened','{}',NULL,NULL,NULL::text,NULL,NULL,NULL,NOW() - INTERVAL '20 hours')
) AS v(campaign_name, contact_email, event_type, metadata, ip_address, user_agent, url, country, device_type, email_client, created_at)
INNER JOIN campaigns camp ON camp.org_id = o.id AND camp.name = v.campaign_name
INNER JOIN contacts ct ON ct.org_id = o.id AND ct.email = v.contact_email
INNER JOIN campaign_contacts cc ON cc.campaign_id = camp.id AND cc.contact_id = ct.id
WHERE o.slug = 'default';

-- -----------------------------------------------------------------------------
-- 8b) Email analytics — 30-day daily funnel (main /analytics + dashboard rates)
--     Chart joins on calendar day; dashboard open/click rates use 'sent' as base.
--     Idempotent: skipped if rows with demo_seed = email_analytics_30d already exist.
-- -----------------------------------------------------------------------------
INSERT INTO email_events (campaign_contact_id, campaign_id, contact_id, event_type, metadata, org_id, created_at)
SELECT cc.id, camp.id, ct.id, et.event_type,
       jsonb_build_object('demo_seed', 'email_analytics_30d', 'day_offset', gs.n, 'step', et.step),
       o.id,
       date_trunc('day', NOW() - (gs.n || ' days')::interval) + (et.minute_offset || ' minutes')::interval
FROM organisations o
INNER JOIN campaigns camp ON camp.org_id = o.id AND camp.name = 'Demo: Q2 — Enterprise pulse (completed)'
INNER JOIN contacts ct ON ct.org_id = o.id AND ct.email = 'priya.verma@demo.astrareach.local'
INNER JOIN campaign_contacts cc ON cc.campaign_id = camp.id AND cc.contact_id = ct.id
CROSS JOIN generate_series(0, 29) AS gs(n)
CROSS JOIN LATERAL (
  SELECT step, minute_offset, event_type FROM (VALUES
    (0, 30, 'sent'),
    (1, 60, 'delivered'),
    (2, 90, 'delivered'),
    (3, 180, 'opened'),
    (4, 240, 'opened'),
    (5, 300, 'clicked')
  ) AS x(step, minute_offset, event_type)
  WHERE event_type <> 'clicked' OR gs.n % 2 = 0
  UNION ALL
  SELECT 6, 360, 'booked' WHERE gs.n % 5 = 0
  UNION ALL
  SELECT 7, 420, 'bounced' WHERE gs.n % 9 = 0
) AS et
WHERE o.slug = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM email_events e
    WHERE e.org_id = o.id AND e.metadata->>'demo_seed' = 'email_analytics_30d'
    LIMIT 1
  );

-- -----------------------------------------------------------------------------
-- 9) Email tracking
-- -----------------------------------------------------------------------------
INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id, delivered_at, first_opened_at, last_opened_at, open_count, first_clicked_at, click_count, booked_at, bounced_at, bounce_type, unsubscribed_at, spam_at)
SELECT cc.id, camp.id, ct.id, o.id, v.delivered_at, v.first_opened_at, v.last_opened_at, v.open_count, v.first_clicked_at, v.click_count, v.booked_at, v.bounced_at, v.bounce_type, v.unsubscribed_at, v.spam_at
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('Demo: Q2 — Enterprise pulse (completed)','priya.verma@demo.astrareach.local',NOW() - INTERVAL '18 days',NOW() - INTERVAL '17 days',NOW() - INTERVAL '16 days',3,NOW() - INTERVAL '16 days',2,NOW() - INTERVAL '1 day',NULL::timestamptz,NULL::text,NULL::timestamptz,NULL::timestamptz),
  ('Demo: Q2 — Enterprise pulse (completed)','arjun.mehta@demo.astrareach.local',NOW() - INTERVAL '17 days',NOW() - INTERVAL '16 days',NOW() - INTERVAL '16 days',2,NOW() - INTERVAL '5 days',1,NULL,NULL,NULL,NULL,NULL),
  ('Demo: Active pilot — India SaaS','priya.verma@demo.astrareach.local',NOW() - INTERVAL '25 hours',NOW() - INTERVAL '20 hours',NOW() - INTERVAL '20 hours',1,NULL,0,NULL,NULL,NULL,NULL,NULL)
) AS v(campaign_name, contact_email, delivered_at, first_opened_at, last_opened_at, open_count, first_clicked_at, click_count, booked_at, bounced_at, bounce_type, unsubscribed_at, spam_at)
INNER JOIN campaigns camp ON camp.org_id = o.id AND camp.name = v.campaign_name
INNER JOIN contacts ct ON ct.org_id = o.id AND ct.email = v.contact_email
INNER JOIN campaign_contacts cc ON cc.campaign_id = camp.id AND cc.contact_id = ct.id
WHERE o.slug = 'default'
ON CONFLICT (campaign_contact_id) DO UPDATE SET
  delivered_at     = EXCLUDED.delivered_at,
  first_opened_at  = EXCLUDED.first_opened_at,
  last_opened_at   = EXCLUDED.last_opened_at,
  open_count       = EXCLUDED.open_count,
  first_clicked_at = EXCLUDED.first_clicked_at,
  click_count      = EXCLUDED.click_count,
  booked_at        = EXCLUDED.booked_at,
  bounced_at       = EXCLUDED.bounced_at,
  bounce_type      = EXCLUDED.bounce_type,
  unsubscribed_at  = EXCLUDED.unsubscribed_at,
  spam_at          = EXCLUDED.spam_at;

-- -----------------------------------------------------------------------------
-- 10) Contact enrichments + jobs
-- -----------------------------------------------------------------------------
INSERT INTO contact_enrichments (
  contact_id, org_id, company_website, company_linkedin_url, company_description,
  company_founded_year, company_employee_range, company_revenue_range, company_industry,
  company_hq_city, company_hq_country, company_tech_stack, company_funding_stage,
  company_total_funding, company_investors, company_recent_news, company_g2_rating,
  person_linkedin_url, person_bio, person_location, person_skills, person_past_companies,
  signal_hiring_roles, signal_recently_funded, signal_job_change, signal_pain_keywords,
  field_confidence, field_sources, enrichment_status, enrichment_passes,
  enrichment_started_at, enrichment_completed_at, tokens_used, enrichment_model
)
SELECT c.id, o.id, v.company_website, v.company_linkedin_url, v.company_description,
  v.company_founded_year, v.company_employee_range, v.company_revenue_range, v.company_industry,
  v.company_hq_city, v.company_hq_country, v.company_tech_stack, v.company_funding_stage,
  v.company_total_funding, v.company_investors, v.company_recent_news, v.company_g2_rating,
  v.person_linkedin_url, v.person_bio, v.person_location, v.person_skills, v.person_past_companies,
  v.signal_hiring_roles, v.signal_recently_funded, v.signal_job_change, v.signal_pain_keywords,
  v.field_confidence, v.field_sources, v.enrichment_status, v.enrichment_passes,
  v.enrichment_started_at, v.enrichment_completed_at, v.tokens_used, v.enrichment_model
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('priya.verma@demo.astrareach.local','https://northwind-analytics.demo','https://linkedin.com/company/demo-northwind-analytics','Revenue intelligence platform for B2B teams; focuses on funnel diagnostics and forecasting.',2016,'200–500','USD 10M–50M','Computer Software','Bengaluru','India',ARRAY['AWS','Kubernetes','PostgreSQL','Snowflake']::text[],'Series C','USD 45M',ARRAY['Sequoia Demo Capital','Riverstone Demo Partners']::text[],'[{"headline":"Opened Singapore office","url":"https://example.com/news/nw-sg"}]'::jsonb,4.6,'https://linkedin.com/in/demo-priya-verma','GTM leader with background in sales ops and revenue analytics.','Bengaluru, India',ARRAY['Outbound strategy','RevOps','Forecasting']::text[],ARRAY['Contoso Ltd','Fabrikam Inc']::text[],ARRAY['Enterprise AE','RevOps Analyst']::text[],TRUE,FALSE,ARRAY['tool_sprawl','attribution']::text[],'{"company_description":92,"person_bio":88,"company_funding_stage":85}'::jsonb,'{"company_description":"https://northwind-analytics.demo/about","person_bio":"https://linkedin.com/in/demo-priya-verma"}'::jsonb,'completed',3,NOW() - INTERVAL '3 days',NOW() - INTERVAL '2 days',18420,'claude-sonnet-4-20250514'),
  ('yuki.tanaka@demo.astrareach.local','https://kite-mobility.demo',NULL,'Fleet and logistics optimization software for mobility operators in APAC.',2014,'200–500','USD 25M–50M','Computer Software','Tokyo','Japan',ARRAY['GCP','BigQuery','React']::text[],'Series B','USD 28M',ARRAY['Global Demo Ventures']::text[],'[]'::jsonb,NULL::numeric,NULL,'BD leader expanding partner channel across APAC.','Tokyo, Japan',ARRAY['Partnerships','Enterprise sales']::text[],ARRAY['Sunrise Motors Demo']::text[],ARRAY['Solutions Engineer']::text[],FALSE,TRUE,ARRAY['localization','latency']::text[],'{"company_description":90,"signal_job_change":80}'::jsonb,'{"company_description":"https://kite-mobility.demo"}'::jsonb,'completed',3,NOW() - INTERVAL '2 days',NOW() - INTERVAL '1 day',16210,'claude-sonnet-4-20250514')
) AS v(email, company_website, company_linkedin_url, company_description, company_founded_year, company_employee_range, company_revenue_range, company_industry, company_hq_city, company_hq_country, company_tech_stack, company_funding_stage, company_total_funding, company_investors, company_recent_news, company_g2_rating, person_linkedin_url, person_bio, person_location, person_skills, person_past_companies, signal_hiring_roles, signal_recently_funded, signal_job_change, signal_pain_keywords, field_confidence, field_sources, enrichment_status, enrichment_passes, enrichment_started_at, enrichment_completed_at, tokens_used, enrichment_model)
INNER JOIN contacts c ON c.org_id = o.id AND c.email = v.email
WHERE o.slug = 'default'
ON CONFLICT (contact_id) DO NOTHING;

INSERT INTO enrichment_jobs (org_id, job_type, contact_ids, total, completed, failed, status, triggered_by, created_at, completed_at)
SELECT o.id, 'bulk', ARRAY[c1.id, c2.id], 2, 2, 0, 'completed', u.id, NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN contacts c1 ON c1.org_id = o.id AND c1.email = 'priya.verma@demo.astrareach.local'
INNER JOIN contacts c2 ON c2.org_id = o.id AND c2.email = 'yuki.tanaka@demo.astrareach.local'
WHERE o.slug = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM enrichment_jobs ej
    WHERE ej.org_id = o.id AND ej.job_type = 'bulk' AND ej.status = 'completed'
      AND ej.contact_ids = ARRAY[c1.id, c2.id]
  );

INSERT INTO enrichment_jobs (org_id, job_type, contact_ids, total, completed, failed, status, triggered_by, created_at, completed_at)
SELECT o.id, 'single', ARRAY[c.id], 1, 0, 0, 'queued', u.id, NOW() - INTERVAL '2 hours', NULL
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN contacts c ON c.org_id = o.id AND c.email = 'ananya.iyer@demo.astrareach.local'
WHERE o.slug = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM enrichment_jobs ej
    WHERE ej.org_id = o.id AND ej.job_type = 'single' AND ej.status = 'queued'
      AND ej.contact_ids = ARRAY[c.id]
      AND ej.created_at > NOW() - INTERVAL '7 days'
  );

INSERT INTO contact_enrichments (contact_id, org_id, enrichment_status, enrichment_passes, enrichment_started_at, error_message)
SELECT c.id, o.id, 'pending', 0, NULL, NULL
FROM organisations o
INNER JOIN contacts c ON c.org_id = o.id AND c.email = 'ananya.iyer@demo.astrareach.local'
WHERE o.slug = 'default'
ON CONFLICT (contact_id) DO UPDATE SET enrichment_status = 'pending', updated_at = NOW();

-- -----------------------------------------------------------------------------
-- 11) WhatsApp
-- -----------------------------------------------------------------------------
INSERT INTO wa_phone_numbers (org_id, display_name, phone_number, phone_number_id, waba_id, bsp, bsp_api_key, access_token, tier, daily_limit, quality_score, is_active, is_paused, messages_sent_today, last_reset_date)
SELECT o.id, 'Demo — APAC Marketing Line', '+918069001234', 'DEMO_META_PN_ID_001', 'DEMO_WABA_001', 'twilio', 'demo_twilio_key_********', NULL, 3, 2000, 'GREEN', TRUE, FALSE, 12, CURRENT_DATE
FROM organisations o WHERE o.slug = 'default'
ON CONFLICT (phone_number_id) DO NOTHING;

INSERT INTO wa_templates (org_id, phone_number_id, name, meta_template_id, category, language, status, header_type, header_content, body_text, footer_text, buttons, variables, rejected_reason, created_by)
SELECT o.id, 'DEMO_META_PN_ID_001', 'demo_q1_product_launch', 'demo_meta_tpl_1001', 'MARKETING', 'en', 'APPROVED', 'TEXT', 'Hi from AstraReach Demo',
  'Hello {{1}}, thanks for your interest in *AstraReach*. We built a short overview for {{2}}. Reply *YES* to receive it.',
  'Demo only — not a live send.',
  '[{"type":"QUICK_REPLY","text":"Yes, send it"},{"type":"URL","text":"Book a call","url":"https://cal.example.com/wa-demo"}]'::jsonb,
  ARRAY['1','2']::text[], NULL, u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default'
ON CONFLICT (org_id, phone_number_id, name, language) DO NOTHING;

INSERT INTO wa_templates (org_id, phone_number_id, name, meta_template_id, category, language, status, header_type, header_content, body_text, footer_text, buttons, variables, rejected_reason, created_by)
SELECT o.id, 'DEMO_META_PN_ID_001', 'demo_order_status_stub', 'demo_meta_tpl_1002', 'UTILITY', 'en_IN', 'APPROVED', NULL, NULL,
  'Your demo order #{{1}} is *on the way*. Expected: {{2}}. Questions? Reply here.',
  'Automated demo message', '[]'::jsonb, ARRAY['1','2']::text[], NULL, u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default'
ON CONFLICT (org_id, phone_number_id, name, language) DO NOTHING;

INSERT INTO wa_templates (org_id, phone_number_id, name, meta_template_id, category, language, status, header_type, header_content, body_text, footer_text, buttons, variables, rejected_reason, created_by)
SELECT o.id, 'DEMO_META_PN_ID_001', 'demo_pending_review_template', NULL, 'MARKETING', 'en', 'PENDING', NULL, NULL,
  'This template is still *pending approval* — used only for UI demos.', NULL, '[]'::jsonb, '{}'::text[], NULL, u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default'
ON CONFLICT (org_id, phone_number_id, name, language) DO NOTHING;

INSERT INTO wa_opt_ins (org_id, contact_id, phone_number, status, source, opted_in_at)
SELECT o.id, c.id, v.phone, 'opted_in', 'demo_seed', v.opted_in_at
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('priya.verma@demo.astrareach.local','+919876543201',NOW() - INTERVAL '30 days'),
  ('arjun.mehta@demo.astrareach.local','+919876543202',NOW() - INTERVAL '20 days'),
  ('marcus.chen@demo.astrareach.local','+14155550104',NOW() - INTERVAL '10 days'),
  ('yuki.tanaka@demo.astrareach.local','+819012345678',NOW() - INTERVAL '14 days'),
  ('olivia.nguyen@demo.astrareach.local','+61491570156',NOW() - INTERVAL '8 days'),
  ('ava.thompson@demo.astrareach.local','+12125550112',NOW() - INTERVAL '3 days')
) AS v(email, phone, opted_in_at)
INNER JOIN contacts c ON c.org_id = o.id AND c.email = v.email
WHERE o.slug = 'default'
ON CONFLICT (org_id, phone_number) DO NOTHING;

INSERT INTO wa_campaigns (
  org_id, name, description, status, phone_number_id, template_id, segment_id,
  daily_limit, messages_per_second, send_time, timezone, total_contacts, messages_sent, messages_sent_today,
  last_reset_date, variable_mapping, booking_url, scheduled_at, started_at, completed_at, created_by
)
SELECT
  o.id, 'Demo: WA — Product launch blast', 'Active WhatsApp campaign demo with variable mapping.', 'active',
  pn.id,
  (SELECT wt.id FROM wa_templates wt WHERE wt.org_id = o.id AND wt.name = 'demo_q1_product_launch' AND wt.language = 'en' LIMIT 1),
  (SELECT s.id FROM segments s WHERE s.org_id = o.id AND s.name = 'Demo: WhatsApp opted-in' LIMIT 1),
  500, 2.0, '10:30'::time, 'Asia/Kolkata', 4, 4, 4, CURRENT_DATE,
  '{"1":"first_name","2":"company"}'::jsonb, 'https://cal.example.com/wa-demo', NULL, NOW() - INTERVAL '3 days', NULL, u.id
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN wa_phone_numbers pn ON pn.org_id = o.id AND pn.phone_number_id = 'DEMO_META_PN_ID_001'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM wa_campaigns w WHERE w.org_id = o.id AND w.name = 'Demo: WA — Product launch blast');

INSERT INTO wa_campaigns (
  org_id, name, description, status, phone_number_id, template_id, segment_id,
  daily_limit, messages_per_second, send_time, timezone, total_contacts, messages_sent, messages_sent_today,
  last_reset_date, variable_mapping, booking_url, scheduled_at, started_at, completed_at, created_by
)
SELECT
  o.id, 'Demo: WA — Utility follow-ups (completed)', 'Completed campaign for funnels + analytics cards.', 'completed',
  pn.id,
  (SELECT wt.id FROM wa_templates wt WHERE wt.org_id = o.id AND wt.name = 'demo_order_status_stub' AND wt.language = 'en_IN' LIMIT 1),
  NULL,
  1000, 1.0, '15:00'::time, 'Asia/Kolkata', 2, 2, 0, CURRENT_DATE - 1,
  '{"1":"order_id","2":"eta"}'::jsonb, NULL, NULL, NOW() - INTERVAL '12 days', NOW() - INTERVAL '10 days', u.id
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN wa_phone_numbers pn ON pn.org_id = o.id AND pn.phone_number_id = 'DEMO_META_PN_ID_001'
WHERE o.slug = 'default' AND NOT EXISTS (SELECT 1 FROM wa_campaigns w WHERE w.org_id = o.id AND w.name = 'Demo: WA — Utility follow-ups (completed)');

UPDATE wa_campaigns wc SET audience_source = 'wa_registry'
FROM organisations o
WHERE wc.org_id = o.id AND o.slug = 'default'
  AND wc.name = 'Demo: WA — Utility follow-ups (completed)';

INSERT INTO wa_campaign_contacts (org_id, campaign_id, contact_id, phone_number, status, personalized_vars, wa_message_id, sent_at, delivered_at, read_at, replied_at, failed_at, failure_code, failure_reason, retry_count)
SELECT o.id, wc.id, c.id, v.phone, v.status, v.personalized_vars::jsonb, v.wa_message_id, v.sent_at, v.delivered_at, v.read_at, v.replied_at, v.failed_at, v.failure_code, v.failure_reason, v.retry_count
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('Demo: WA — Product launch blast','priya.verma@demo.astrareach.local','+919876543201','read','{"1":"Priya","2":"Northwind Analytics"}','demo_wamid_wa_001',NOW() - INTERVAL '3 days',NOW() - INTERVAL '3 days' + INTERVAL '8 seconds',NOW() - INTERVAL '3 days' + INTERVAL '2 minutes',NULL::timestamptz,NULL::timestamptz,NULL::text,NULL::text,0),
  ('Demo: WA — Product launch blast','arjun.mehta@demo.astrareach.local','+919876543202','delivered','{"1":"Arjun","2":"BlueRiver FinTech"}','demo_wamid_wa_002',NOW() - INTERVAL '2 days',NOW() - INTERVAL '2 days' + INTERVAL '5 seconds',NULL,NULL,NULL,NULL,NULL,0),
  ('Demo: WA — Product launch blast','yuki.tanaka@demo.astrareach.local','+819012345678','replied','{"1":"Yuki","2":"Kite Mobility KK"}','demo_wamid_wa_003',NOW() - INTERVAL '1 day',NOW() - INTERVAL '1 day' + INTERVAL '4 seconds',NOW() - INTERVAL '23 hours',NOW() - INTERVAL '22 hours',NULL,NULL,NULL,0),
  ('Demo: WA — Product launch blast','olivia.nguyen@demo.astrareach.local','+61491570156','pending','{"1":"Olivia","2":"Vertex Cyber Labs"}',NULL::text,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0),
  ('Demo: WA — Utility follow-ups (completed)','marcus.chen@demo.astrareach.local','+14155550104','sent','{"1":"D-104892","2":"Apr 12"}','demo_wamid_wa_004',NOW() - INTERVAL '11 days',NULL,NULL,NULL,NULL,NULL,NULL,0),
  ('Demo: WA — Utility follow-ups (completed)','ava.thompson@demo.astrareach.local','+12125550112','failed','{"1":"D-104893","2":"Apr 14"}',NULL::text,NULL,NULL,NULL,NULL,NOW() - INTERVAL '10 days','131026','Template paused by provider (demo)',0)
) AS v(campaign_name, email, phone, status, personalized_vars, wa_message_id, sent_at, delivered_at, read_at, replied_at, failed_at, failure_code, failure_reason, retry_count)
INNER JOIN wa_campaigns wc ON wc.org_id = o.id AND wc.name = v.campaign_name
INNER JOIN contacts c ON c.org_id = o.id AND c.email = v.email
WHERE o.slug = 'default'
ON CONFLICT (campaign_id, contact_id) DO UPDATE SET
  phone_number       = EXCLUDED.phone_number,
  status             = EXCLUDED.status,
  personalized_vars  = EXCLUDED.personalized_vars,
  wa_message_id      = EXCLUDED.wa_message_id,
  sent_at            = EXCLUDED.sent_at,
  delivered_at       = EXCLUDED.delivered_at,
  read_at            = EXCLUDED.read_at,
  replied_at         = EXCLUDED.replied_at,
  failed_at          = EXCLUDED.failed_at,
  failure_code       = EXCLUDED.failure_code,
  failure_reason     = EXCLUDED.failure_reason,
  retry_count        = EXCLUDED.retry_count;

UPDATE wa_campaigns wc SET total_contacts = 4, messages_sent = 3, messages_sent_today = 3
FROM organisations o
WHERE wc.org_id = o.id AND o.slug = 'default' AND wc.name = 'Demo: WA — Product launch blast';

UPDATE wa_campaigns wc SET total_contacts = 2, messages_sent = 2
FROM organisations o
WHERE wc.org_id = o.id AND o.slug = 'default' AND wc.name = 'Demo: WA — Utility follow-ups (completed)';

INSERT INTO wa_inbound_messages (org_id, phone_number_id, from_phone, contact_id, wa_message_id, message_type, message_body, button_payload, media_url, in_reply_to_wamid, session_expires_at, created_at)
SELECT o.id, 'DEMO_META_PN_ID_001', v.from_phone, c.id, v.wa_message_id, 'text', v.message_body, NULL, NULL, v.in_reply_to, v.session_expires_at, v.created_at
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('+919876543201','priya.verma@demo.astrareach.local','demo_wamid_inbound_001','Yes, please send the overview deck.','demo_wamid_wa_001',NOW() + INTERVAL '12 hours',NOW() - INTERVAL '22 hours'),
  ('+819012345678','yuki.tanaka@demo.astrareach.local','demo_wamid_inbound_002','Can we schedule for Tuesday JST morning?','demo_wamid_wa_003',NOW() + INTERVAL '6 hours',NOW() - INTERVAL '22 hours' + INTERVAL '5 minutes')
) AS v(from_phone, email, wa_message_id, message_body, in_reply_to, session_expires_at, created_at)
INNER JOIN contacts c ON c.org_id = o.id AND c.email = v.email
WHERE o.slug = 'default'
ON CONFLICT (wa_message_id) DO NOTHING;

INSERT INTO wa_events (org_id, campaign_id, wacc_id, contact_id, phone_number, event_type, failure_code, button_payload, metadata, created_at)
SELECT o.id, wc.id, wacc.id, c.id, v.phone, v.event_type, v.failure_code, NULL::text, v.metadata::jsonb, v.created_at
FROM organisations o
CROSS JOIN LATERAL (VALUES
  ('Demo: WA — Product launch blast','priya.verma@demo.astrareach.local','+919876543201','sent',NULL,'{}',NOW() - INTERVAL '3 days'),
  ('Demo: WA — Product launch blast','priya.verma@demo.astrareach.local','+919876543201','delivered',NULL,'{}',NOW() - INTERVAL '3 days' + INTERVAL '8 seconds'),
  ('Demo: WA — Product launch blast','priya.verma@demo.astrareach.local','+919876543201','read',NULL,'{}',NOW() - INTERVAL '3 days' + INTERVAL '2 minutes'),
  ('Demo: WA — Product launch blast','yuki.tanaka@demo.astrareach.local','+819012345678','replied',NULL,'{"preview":"Tuesday JST"}',NOW() - INTERVAL '22 hours'),
  ('Demo: WA — Utility follow-ups (completed)','marcus.chen@demo.astrareach.local','+14155550104','sent',NULL,'{}',NOW() - INTERVAL '11 days'),
  ('Demo: WA — Utility follow-ups (completed)','ava.thompson@demo.astrareach.local','+12125550112','failed','131026','{"reason":"Template paused (demo)"}',NOW() - INTERVAL '10 days')
) AS v(campaign_name, email, phone, event_type, failure_code, metadata, created_at)
INNER JOIN wa_campaigns wc ON wc.org_id = o.id AND wc.name = v.campaign_name
INNER JOIN contacts c ON c.org_id = o.id AND c.email = v.email
INNER JOIN wa_campaign_contacts wacc ON wacc.campaign_id = wc.id AND wacc.contact_id = c.id
WHERE o.slug = 'default';

-- -----------------------------------------------------------------------------
-- 11b) WhatsApp analytics — 30-day daily volume (/analytics + /whatsapp/analytics)
--      Idempotent: skipped if rows with demo_seed = wa_analytics_30d already exist.
-- -----------------------------------------------------------------------------
INSERT INTO wa_events (org_id, campaign_id, wacc_id, contact_id, phone_number, event_type, failure_code, button_payload, metadata, created_at)
SELECT o.id, wc.id, wacc.id, c.id,
       COALESCE(NULLIF(trim(c.whatsapp_phone), ''), '+919876543201'),
       et.event_type, NULL::text, NULL::text,
       jsonb_build_object('demo_seed', 'wa_analytics_30d', 'day_offset', gs.n, 'step', et.step),
       date_trunc('day', NOW() - (gs.n || ' days')::interval) + (et.minute_offset || ' minutes')::interval
FROM organisations o
INNER JOIN wa_campaigns wc ON wc.org_id = o.id AND wc.name = 'Demo: WA — Product launch blast'
INNER JOIN contacts c ON c.org_id = o.id AND c.email = 'priya.verma@demo.astrareach.local'
INNER JOIN wa_campaign_contacts wacc ON wacc.campaign_id = wc.id AND wacc.contact_id = c.id
CROSS JOIN generate_series(0, 29) AS gs(n)
CROSS JOIN LATERAL (
  SELECT step, minute_offset, event_type FROM (VALUES
    (1, 15, 'sent'),
    (2, 35, 'delivered'),
    (3, 55, 'read')
  ) AS x(step, minute_offset, event_type)
  UNION ALL
  SELECT 4, 85, 'replied' WHERE gs.n % 4 = 0
) AS et
WHERE o.slug = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM wa_events w
    WHERE w.org_id = o.id AND w.metadata->>'demo_seed' = 'wa_analytics_30d'
    LIMIT 1
  );

-- Sparse opted-out events for “Opt-outs” + opt-out trend chart on WA Analytics
INSERT INTO wa_events (org_id, campaign_id, wacc_id, contact_id, phone_number, event_type, failure_code, button_payload, metadata, created_at)
SELECT o.id, wc.id, NULL::uuid, c.id, '+821012345678', 'opted_out', NULL::text, NULL::text,
       jsonb_build_object('demo_seed', 'wa_analytics_optout', 'day_offset', gs.n),
       date_trunc('day', NOW() - (gs.n || ' days')::interval) + interval '16 hours'
FROM organisations o
INNER JOIN wa_campaigns wc ON wc.org_id = o.id AND wc.name = 'Demo: WA — Product launch blast'
INNER JOIN contacts c ON c.org_id = o.id AND c.email = 'noah.kim@demo.astrareach.local'
CROSS JOIN generate_series(2, 26, 6) AS gs(n)
WHERE o.slug = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM wa_events w
    WHERE w.org_id = o.id AND w.metadata->>'demo_seed' = 'wa_analytics_optout'
    LIMIT 1
  );

-- -----------------------------------------------------------------------------
-- 12) Audit, activity, RBAC samples
-- -----------------------------------------------------------------------------
INSERT INTO audit_log (org_id, user_id, role, action, resource_type, resource_id, old_values, new_values, ip_address, created_at)
SELECT o.id, u.id, 'superadmin', 'campaign.start', 'campaign', camp.id, NULL, '{"status":"draft"}'::jsonb, '203.0.113.55', NOW() - INTERVAL '2 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN campaigns camp ON camp.org_id = o.id AND camp.name = 'Demo: Active pilot — India SaaS'
WHERE o.slug = 'default';

INSERT INTO audit_log (org_id, user_id, role, action, resource_type, resource_id, old_values, new_values, ip_address, created_at)
SELECT o.id, u.id, 'superadmin', 'contact.import', 'import_batch', ib.id, NULL, '{"rows":12}'::jsonb, '203.0.113.55', NOW() - INTERVAL '5 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN import_batches ib ON ib.org_id = o.id AND ib.filename = 'demo_import_batch.csv'
WHERE o.slug = 'default';

INSERT INTO audit_log (org_id, user_id, role, action, resource_type, resource_id, old_values, new_values, ip_address, created_at)
SELECT o.id, u.id, 'superadmin', 'wa.template.create', 'wa_template', wt.id, NULL, '{"name":"demo_q1_product_launch"}'::jsonb, '203.0.113.55', NOW() - INTERVAL '8 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN wa_templates wt ON wt.org_id = o.id AND wt.name = 'demo_q1_product_launch' AND wt.language = 'en'
WHERE o.slug = 'default';

INSERT INTO activity_log (entity_type, entity_id, action, details, performed_by, created_at)
SELECT 'contact', c.id, 'enrichment.completed', jsonb_build_object('contact_email', c.email), u.id, NOW() - INTERVAL '2 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN contacts c ON c.org_id = o.id AND c.email = 'priya.verma@demo.astrareach.local'
WHERE o.slug = 'default';

INSERT INTO activity_log (entity_type, entity_id, action, details, performed_by, created_at)
SELECT 'campaign', camp.id, 'completed', '{"emails_sent":10}'::jsonb, u.id, NOW() - INTERVAL '2 days'
FROM organisations o
INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
INNER JOIN campaigns camp ON camp.org_id = o.id AND camp.name = 'Demo: Q2 — Enterprise pulse (completed)'
WHERE o.slug = 'default';

INSERT INTO field_permissions (org_id, role, table_name, field_name, can_view, can_edit, created_by)
SELECT o.id, 'campaign_manager', 'contacts', 'ai_score', TRUE, FALSE, u.id
FROM organisations o INNER JOIN users u ON u.email = 'demo.seed@astrareach.local'
WHERE o.slug = 'default'
ON CONFLICT (org_id, role, table_name, field_name) DO NOTHING;

INSERT INTO permission_grants (user_id, resource, granted, granted_by)
SELECT u.id, 'export', TRUE, u.id FROM users u WHERE u.email = 'demo.seed@astrareach.local'
AND NOT EXISTS (SELECT 1 FROM permission_grants pg WHERE pg.user_id = u.id AND pg.resource = 'export');

INSERT INTO user_data_scopes (user_id, scope_type, segment_id, filter_json, created_by)
SELECT u.id, 'all', NULL, NULL, u.id FROM users u WHERE u.email = 'demo.seed@astrareach.local'
AND NOT EXISTS (SELECT 1 FROM user_data_scopes s WHERE s.user_id = u.id AND s.scope_type = 'all');

COMMIT;
