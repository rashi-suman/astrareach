'use strict';

module.exports = {
  async up(queryInterface) {
    const q = sql => queryInterface.sequelize.query(sql);

    await q(`
      CREATE TABLE IF NOT EXISTS \`session\` (
        sid    VARCHAR(255) NOT NULL PRIMARY KEY,
        sess   JSON NOT NULL,
        expire DATETIME(6) NOT NULL,
        INDEX idx_session_expire (expire)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS organisations (
        id         CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        name       VARCHAR(255) NOT NULL,
        slug       VARCHAR(255) UNIQUE NOT NULL,
        plan       VARCHAR(50) DEFAULT 'enterprise',
        settings   JSON,
        created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB
    `);

    await q(`
      INSERT IGNORE INTO organisations (id, name, slug, plan)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organisation', 'default', 'enterprise')
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS users (
        id              CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        name            VARCHAR(255) NOT NULL,
        email           VARCHAR(320) UNIQUE NOT NULL,
        password_hash   VARCHAR(255) NOT NULL,
        role            VARCHAR(50) DEFAULT 'admin',
        avatar_initials VARCHAR(10),
        org_id          CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        is_active       BOOLEAN DEFAULT TRUE,
        last_login_at   DATETIME(6),
        created_by      CHAR(36),
        created_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_users_org     FOREIGN KEY (org_id)     REFERENCES organisations(id),
        CONSTRAINT fk_users_creator FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS contacts (
        id                      CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        email                   VARCHAR(320) UNIQUE NOT NULL,
        first_name              VARCHAR(255),
        last_name               VARCHAR(255),
        company                 VARCHAR(255),
        job_title               VARCHAR(255),
        phone                   VARCHAR(50),
        website                 VARCHAR(2048),
        industry                VARCHAR(255),
        city                    VARCHAR(255),
        country                 VARCHAR(255),
        linkedin_url            VARCHAR(2048),
        revenue_range           VARCHAR(100),
        employee_count          VARCHAR(100),
        tags                    JSON,
        custom_fields           JSON,
        research_summary        TEXT,
        research_done           BOOLEAN DEFAULT FALSE,
        enriched_at             DATETIME(6),
        status                  VARCHAR(50) DEFAULT 'active',
        source                  VARCHAR(255),
        import_batch_id         CHAR(36),
        org_id                  CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        ai_score                DECIMAL(5,2),
        ai_score_reason         TEXT,
        ai_scored_at            DATETIME(6),
        intent_signals          JSON,
        whatsapp_phone          VARCHAR(50),
        whatsapp_opted_in       BOOLEAN DEFAULT FALSE,
        whatsapp_opted_in_at    DATETIME(6),
        whatsapp_session_active BOOLEAN DEFAULT FALSE,
        whatsapp_last_reply_at  DATETIME(6),
        created_at              DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        updated_at              DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_contacts_org FOREIGN KEY (org_id) REFERENCES organisations(id),
        INDEX idx_contacts_company  (company),
        INDEX idx_contacts_industry (industry),
        INDEX idx_contacts_status   (status),
        INDEX idx_contacts_created  (created_at DESC),
        INDEX idx_contacts_ai_score (org_id, ai_score DESC),
        FULLTEXT INDEX idx_contacts_fts (first_name, last_name, email, company, job_title)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS import_batches (
        id              CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        filename        VARCHAR(1024),
        total_rows      INT,
        imported_rows   INT DEFAULT 0,
        duplicate_rows  INT DEFAULT 0,
        error_rows      INT DEFAULT 0,
        skipped_rows    INT DEFAULT 0,
        column_mapping  JSON,
        status          VARCHAR(50) DEFAULT 'processing',
        uploaded_by     CHAR(36),
        org_id          CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        file_size_bytes BIGINT,
        error_log       JSON,
        progress_pct    DECIMAL(5,2) DEFAULT 0,
        imported_by     CHAR(36),
        started_at      DATETIME(6),
        created_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        completed_at    DATETIME(6),
        CONSTRAINT fk_ib_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id),
        CONSTRAINT fk_ib_importer FOREIGN KEY (imported_by) REFERENCES users(id),
        CONSTRAINT fk_ib_org      FOREIGN KEY (org_id)      REFERENCES organisations(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS segments (
        id            CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        name          VARCHAR(255) NOT NULL,
        description   TEXT,
        filters       JSON NOT NULL,
        contact_count INT DEFAULT 0,
        created_by    CHAR(36),
        org_id        CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        filter_logic  VARCHAR(10) DEFAULT 'AND',
        last_count_at DATETIME(6),
        is_dynamic    BOOLEAN DEFAULT TRUE,
        ai_generated  BOOLEAN DEFAULT FALSE,
        ai_rationale  TEXT,
        created_at    DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        updated_at    DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_segments_creator FOREIGN KEY (created_by) REFERENCES users(id),
        CONSTRAINT fk_segments_org     FOREIGN KEY (org_id)     REFERENCES organisations(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS templates (
        id                  CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        name                VARCHAR(255) NOT NULL,
        subject             TEXT NOT NULL,
        body_html           MEDIUMTEXT NOT NULL,
        variables           JSON,
        preview_text        TEXT,
        created_by          CHAR(36),
        org_id              CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        ai_generated        BOOLEAN DEFAULT FALSE,
        ai_score            DECIMAL(5,2),
        version             INT DEFAULT 1,
        parent_id           CHAR(36),
        variant_label       VARCHAR(50),
        booking_url         VARCHAR(2048),
        include_unsubscribe BOOLEAN NOT NULL DEFAULT FALSE,
        created_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        updated_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_templates_creator FOREIGN KEY (created_by) REFERENCES users(id),
        CONSTRAINT fk_templates_org     FOREIGN KEY (org_id)     REFERENCES organisations(id),
        CONSTRAINT fk_templates_parent  FOREIGN KEY (parent_id)  REFERENCES templates(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id                  CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        name                VARCHAR(255) NOT NULL,
        description         TEXT,
        status              VARCHAR(50) DEFAULT 'draft',
        template_id         CHAR(36),
        segment_id          CHAR(36),
        daily_limit         INT DEFAULT 50,
        send_time           TIME DEFAULT '09:00',
        timezone            VARCHAR(64) DEFAULT 'Asia/Kolkata',
        total_contacts      INT DEFAULT 0,
        emails_sent         INT DEFAULT 0,
        emails_sent_today   INT DEFAULT 0,
        last_reset_date     DATE,
        ai_research_enabled BOOLEAN DEFAULT TRUE,
        booking_url         VARCHAR(2048) DEFAULT 'https://astrabytesolutions.com/book-call',
        org_id              CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        ab_test_enabled     BOOLEAN DEFAULT FALSE,
        ab_split_pct        INT DEFAULT 50,
        ab_winner_metric    VARCHAR(20) DEFAULT 'open',
        provider            VARCHAR(50) DEFAULT 'auto',
        scheduled_start_at  DATETIME(6),
        started_at          DATETIME(6),
        completed_at        DATETIME(6),
        created_by          CHAR(36),
        created_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        updated_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_campaigns_template FOREIGN KEY (template_id) REFERENCES templates(id),
        CONSTRAINT fk_campaigns_segment  FOREIGN KEY (segment_id)  REFERENCES segments(id),
        CONSTRAINT fk_campaigns_creator  FOREIGN KEY (created_by)  REFERENCES users(id),
        CONSTRAINT fk_campaigns_org      FOREIGN KEY (org_id)      REFERENCES organisations(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS campaign_contacts (
        id                     CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        campaign_id            CHAR(36),
        contact_id             CHAR(36),
        status                 VARCHAR(50) DEFAULT 'pending',
        personalized_subject   TEXT,
        personalized_body_html MEDIUMTEXT,
        sent_at                DATETIME(6),
        last_event_at          DATETIME(6),
        retry_count            INT DEFAULT 0,
        error_message          TEXT,
        org_id                 CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        template_variant       VARCHAR(10) DEFAULT 'A',
        send_score             DECIMAL(5,2),
        scheduled_at           DATETIME(6),
        last_event_type        VARCHAR(50),
        provider_used          VARCHAR(50),
        provider_message_id    VARCHAR(255),
        created_at             DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_cc (campaign_id, contact_id),
        CONSTRAINT fk_cc_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
        CONSTRAINT fk_cc_contact  FOREIGN KEY (contact_id)  REFERENCES contacts(id)  ON DELETE CASCADE,
        INDEX idx_cc_campaign  (campaign_id, status),
        INDEX idx_cc_contact   (contact_id),
        INDEX idx_cc_status    (status),
        INDEX idx_cc_scheduled (status, scheduled_at)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS email_events (
        id                  CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        campaign_contact_id CHAR(36),
        campaign_id         CHAR(36),
        contact_id          CHAR(36),
        event_type          VARCHAR(50) NOT NULL,
        metadata            JSON,
        ip_address          VARCHAR(64),
        user_agent          TEXT,
        org_id              CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000001',
        url                 VARCHAR(2048),
        country             VARCHAR(100),
        device_type         VARCHAR(50),
        email_client        VARCHAR(100),
        created_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_ee_cc       FOREIGN KEY (campaign_contact_id) REFERENCES campaign_contacts(id),
        CONSTRAINT fk_ee_campaign FOREIGN KEY (campaign_id)         REFERENCES campaigns(id),
        CONSTRAINT fk_ee_contact  FOREIGN KEY (contact_id)          REFERENCES contacts(id),
        INDEX idx_events_cc           (campaign_contact_id),
        INDEX idx_events_campaign     (campaign_id),
        INDEX idx_events_type         (event_type, created_at DESC),
        INDEX idx_events_org_campaign (org_id, campaign_id, created_at DESC)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS email_tracking (
        campaign_contact_id CHAR(36) PRIMARY KEY,
        campaign_id         CHAR(36) NOT NULL,
        contact_id          CHAR(36) NOT NULL,
        org_id              CHAR(36) NOT NULL,
        delivered_at        DATETIME(6),
        first_opened_at     DATETIME(6),
        last_opened_at      DATETIME(6),
        open_count          INT DEFAULT 0,
        first_clicked_at    DATETIME(6),
        click_count         INT DEFAULT 0,
        booked_at           DATETIME(6),
        bounced_at          DATETIME(6),
        bounce_type         VARCHAR(50),
        unsubscribed_at     DATETIME(6),
        spam_at             DATETIME(6)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id           BIGINT AUTO_INCREMENT PRIMARY KEY,
        entity_type  VARCHAR(100),
        entity_id    CHAR(36),
        action       VARCHAR(100),
        details      JSON,
        performed_by CHAR(36),
        created_at   DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_al_user FOREIGN KEY (performed_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS field_permissions (
        id         CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id     CHAR(36) NOT NULL,
        role       VARCHAR(50) NOT NULL,
        table_name VARCHAR(64) NOT NULL,
        field_name VARCHAR(64) NOT NULL,
        can_view   BOOLEAN DEFAULT TRUE,
        can_edit   BOOLEAN DEFAULT FALSE,
        created_by CHAR(36),
        updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_field_perm (org_id, role, table_name, field_name),
        CONSTRAINT fk_fp_org     FOREIGN KEY (org_id)     REFERENCES organisations(id),
        CONSTRAINT fk_fp_creator FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS user_data_scopes (
        id          CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        user_id     CHAR(36) NOT NULL,
        scope_type  VARCHAR(50) NOT NULL DEFAULT 'all',
        segment_id  CHAR(36),
        filter_json JSON,
        created_by  CHAR(36),
        created_at  DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_uds_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_uds_creator FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id         CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        user_id    CHAR(36) NOT NULL,
        resource   VARCHAR(255) NOT NULL,
        granted    BOOLEAN DEFAULT TRUE,
        granted_by CHAR(36),
        expires_at DATETIME(6),
        created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_pg_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_pg_granter FOREIGN KEY (granted_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        org_id        CHAR(36) NOT NULL,
        user_id       CHAR(36),
        role          VARCHAR(50),
        action        VARCHAR(100) NOT NULL,
        resource_type VARCHAR(100),
        resource_id   CHAR(36),
        old_values    JSON,
        new_values    JSON,
        ip_address    VARCHAR(64),
        user_agent    TEXT,
        created_at    DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_audit_org_created (org_id, created_at DESC),
        INDEX idx_audit_user        (user_id, created_at DESC)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_phone_numbers (
        id                  CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id              CHAR(36) NOT NULL,
        display_name        VARCHAR(255) NOT NULL,
        phone_number        VARCHAR(50) NOT NULL,
        phone_number_id     VARCHAR(128) NOT NULL UNIQUE,
        waba_id             VARCHAR(128) NOT NULL,
        bsp                 VARCHAR(20) NOT NULL,
        bsp_api_key         TEXT,
        access_token        TEXT,
        tier                INT DEFAULT 1,
        daily_limit         INT DEFAULT 1000,
        quality_score       VARCHAR(10) DEFAULT 'GREEN',
        quality_updated_at  DATETIME(6),
        is_active           BOOLEAN DEFAULT TRUE,
        is_paused           BOOLEAN DEFAULT FALSE,
        pause_reason        TEXT,
        messages_sent_today INT DEFAULT 0,
        last_reset_date     DATE,
        created_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_wapn_org FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_templates (
        id               CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id           CHAR(36) NOT NULL,
        phone_number_id  VARCHAR(128) NOT NULL,
        name             VARCHAR(255) NOT NULL,
        meta_template_id VARCHAR(128),
        category         VARCHAR(20) NOT NULL,
        language         VARCHAR(16) DEFAULT 'en',
        status           VARCHAR(20) DEFAULT 'PENDING',
        header_type      VARCHAR(20),
        header_content   TEXT,
        body_text        TEXT NOT NULL,
        footer_text      TEXT,
        buttons          JSON,
        variables        JSON,
        rejected_reason  TEXT,
        created_by       CHAR(36),
        created_at       DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_wa_templates (org_id, phone_number_id, name, language),
        CONSTRAINT fk_wat_org     FOREIGN KEY (org_id)     REFERENCES organisations(id) ON DELETE CASCADE,
        CONSTRAINT fk_wat_creator FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_campaigns (
        id                  CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id              CHAR(36) NOT NULL,
        name                VARCHAR(255) NOT NULL,
        description         TEXT,
        status              VARCHAR(20) DEFAULT 'draft',
        phone_number_id     CHAR(36),
        template_id         CHAR(36),
        segment_id          CHAR(36),
        daily_limit         INT DEFAULT 1000,
        messages_per_second DECIMAL(4,1) DEFAULT 1.0,
        send_time           TIME DEFAULT '10:00',
        timezone            VARCHAR(64) DEFAULT 'Asia/Kolkata',
        total_contacts      INT DEFAULT 0,
        messages_sent       INT DEFAULT 0,
        messages_sent_today INT DEFAULT 0,
        last_reset_date     DATE,
        variable_mapping    JSON,
        booking_url         VARCHAR(2048),
        audience_source     VARCHAR(50) DEFAULT 'contacts_opted_in',
        scheduled_at        DATETIME(6),
        started_at          DATETIME(6),
        completed_at        DATETIME(6),
        created_by          CHAR(36),
        created_at          DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_wac_org      FOREIGN KEY (org_id)          REFERENCES organisations(id) ON DELETE CASCADE,
        CONSTRAINT fk_wac_phone    FOREIGN KEY (phone_number_id) REFERENCES wa_phone_numbers(id),
        CONSTRAINT fk_wac_template FOREIGN KEY (template_id)     REFERENCES wa_templates(id),
        CONSTRAINT fk_wac_segment  FOREIGN KEY (segment_id)      REFERENCES segments(id),
        CONSTRAINT fk_wac_creator  FOREIGN KEY (created_by)      REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_campaign_contacts (
        id                CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id            CHAR(36) NOT NULL,
        campaign_id       CHAR(36) NOT NULL,
        contact_id        CHAR(36) NOT NULL,
        phone_number      VARCHAR(50) NOT NULL,
        status            VARCHAR(20) DEFAULT 'pending',
        personalized_vars JSON,
        wa_message_id     VARCHAR(128),
        sent_at           DATETIME(6),
        delivered_at      DATETIME(6),
        read_at           DATETIME(6),
        replied_at        DATETIME(6),
        failed_at         DATETIME(6),
        failure_code      VARCHAR(50),
        failure_reason    TEXT,
        retry_count       INT DEFAULT 0,
        created_at        DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_wacc (campaign_id, contact_id),
        CONSTRAINT fk_wacc_campaign FOREIGN KEY (campaign_id) REFERENCES wa_campaigns(id) ON DELETE CASCADE,
        CONSTRAINT fk_wacc_contact  FOREIGN KEY (contact_id)  REFERENCES contacts(id),
        INDEX idx_wacc_campaign_status (campaign_id, status),
        INDEX idx_wacc_wa_message_id   (wa_message_id),
        INDEX idx_wacc_phone           (phone_number)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_opt_ins (
        id               CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id           CHAR(36) NOT NULL,
        contact_id       CHAR(36),
        phone_number     VARCHAR(50) NOT NULL,
        status           VARCHAR(20) DEFAULT 'opted_in',
        source           VARCHAR(255),
        opted_in_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        opted_out_at     DATETIME(6),
        opted_out_reason TEXT,
        UNIQUE KEY uq_optins (org_id, phone_number),
        CONSTRAINT fk_waoi_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
        INDEX idx_optins_phone (org_id, phone_number, status)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_inbound_messages (
        id                 CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id             CHAR(36) NOT NULL,
        phone_number_id    VARCHAR(128) NOT NULL,
        from_phone         VARCHAR(50) NOT NULL,
        contact_id         CHAR(36),
        wa_message_id      VARCHAR(128) UNIQUE,
        message_type       VARCHAR(50),
        message_body       TEXT,
        button_payload     TEXT,
        media_url          VARCHAR(2048),
        in_reply_to_wamid  VARCHAR(128),
        session_expires_at DATETIME(6),
        created_at         DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_waim_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
        INDEX idx_wa_inbound_from    (from_phone, created_at DESC),
        INDEX idx_wa_inbound_contact (contact_id, created_at DESC)
      ) ENGINE=InnoDB
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS wa_events (
        id             CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        org_id         CHAR(36),
        campaign_id    CHAR(36),
        wacc_id        CHAR(36),
        contact_id     CHAR(36),
        phone_number   VARCHAR(50),
        event_type     VARCHAR(50),
        failure_code   VARCHAR(50),
        button_payload TEXT,
        metadata       JSON,
        created_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_wa_events_campaign (campaign_id, created_at DESC),
        INDEX idx_wa_events_org      (org_id, created_at DESC),
        INDEX idx_wa_events_type     (event_type, created_at DESC)
      ) ENGINE=InnoDB
    `);
  },

  async down(queryInterface) {
    const q = sql => queryInterface.sequelize.query(sql);
    await q('SET FOREIGN_KEY_CHECKS = 0');
    const tables = [
      'wa_events', 'wa_inbound_messages', 'wa_opt_ins', 'wa_campaign_contacts',
      'wa_campaigns', 'wa_templates', 'wa_phone_numbers',
      'audit_log', 'permission_grants', 'user_data_scopes', 'field_permissions',
      'activity_log', 'email_tracking', 'email_events', 'campaign_contacts',
      'campaigns', 'templates', 'segments', 'import_batches',
      'contacts', 'users', 'organisations', 'session',
    ];
    for (const t of tables) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
  },
};
