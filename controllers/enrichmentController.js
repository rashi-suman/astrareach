'use strict';

const db = require('../config/db');
const { connection: redis } = require('../config/redis');
const { enrichmentQueue } = require('../workers/enrichmentWorker');

const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID || '00000000-0000-0000-0000-000000000001';
const MAX_BULK_SIZE  = parseInt(process.env.ENRICHMENT_MAX_BULK_SIZE || '10000', 10);

function getOrgId(req) {
  return req.user?.org_id || DEFAULT_ORG_ID;
}

// ── Enrich a single contact ────────────────────────────────────────────────────
async function enrichSingle(req, res) {
  try {
    const { id } = req.params;
    const orgId  = getOrgId(req);
    const force  = req.body?.force === true || req.body?.force === 'true';

    const contact = (await db.query('SELECT id FROM contacts WHERE id=$1', [id])).rows[0];
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Check existing enrichment
    const existing = (await db.query(
      "SELECT enrichment_status FROM contact_enrichments WHERE contact_id=$1", [id]
    )).rows[0];

    if (existing?.enrichment_status === 'running') {
      return res.json({ message: 'Enrichment already in progress', status: 'running' });
    }
    if (existing?.enrichment_status === 'completed' && !force) {
      return res.json({ message: 'Already enriched. Use force=true to re-enrich.', status: 'completed' });
    }

    // Create enrichment job row
    const job = (await db.query(
      `INSERT INTO enrichment_jobs (org_id, job_type, contact_ids, total, status, triggered_by)
       VALUES ($1,'single',ARRAY[$2::uuid],1,'queued',$3) RETURNING id`,
      [orgId, id, req.user?.id || null]
    )).rows[0];

    // Upsert enrichment record as pending
    await db.query(`
      INSERT INTO contact_enrichments (contact_id, org_id, enrichment_status)
      VALUES ($1,$2,'pending')
      ON CONFLICT (contact_id) DO UPDATE SET enrichment_status='pending', updated_at=NOW()
    `, [id, orgId]);

    // Seed Redis progress hash
    await redis.hset(`enrichjob:${job.id}`, 'total', '1', 'completed', '0', 'failed', '0', 'status', 'queued');
    await redis.expire(`enrichjob:${job.id}`, 86400);

    // Queue the BullMQ job with high priority
    await enrichmentQueue.add('enrich', { contactId: id, orgId, enrichmentJobId: job.id }, { priority: 10 });
    await db.query("UPDATE enrichment_jobs SET status='queued' WHERE id=$1", [job.id]);

    return res.json({ jobId: job.id, message: 'Enrichment started', status: 'queued' });
  } catch (e) {
    console.error('[enrichController] enrichSingle', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── Bulk enrich ────────────────────────────────────────────────────────────────
async function enrichBulk(req, res) {
  try {
    const orgId       = getOrgId(req);
    const { contact_ids = [], force = false } = req.body;

    if (!contact_ids.length) return res.status(400).json({ error: 'No contact IDs provided' });
    if (contact_ids.length > MAX_BULK_SIZE) {
      return res.status(400).json({ error: `Max ${MAX_BULK_SIZE} contacts per bulk request` });
    }

    // Validate ownership
    const owned = (await db.query(
      'SELECT id FROM contacts WHERE id = ANY($1::uuid[]) AND org_id=$2',
      [contact_ids, orgId]
    )).rows.map(r => r.id);

    if (!owned.length) return res.status(400).json({ error: 'No valid contacts found' });

    // Skip already-enriched unless force
    let targets = owned;
    if (!force) {
      const done = (await db.query(
        "SELECT contact_id FROM contact_enrichments WHERE contact_id=ANY($1::uuid[]) AND enrichment_status='completed'",
        [owned]
      )).rows.map(r => r.contact_id);
      targets = owned.filter(id => !done.includes(id));
    }
    if (!targets.length) return res.json({ message: 'All selected contacts already enriched', total: 0 });

    // Create enrichment_jobs row
    const job = (await db.query(
      `INSERT INTO enrichment_jobs (org_id, job_type, contact_ids, total, status, triggered_by)
       VALUES ($1,'bulk',$2::uuid[],$3,'queued',$4) RETURNING id`,
      [orgId, targets, targets.length, req.user?.id || null]
    )).rows[0];

    // Seed Redis
    await redis.hset(`enrichjob:${job.id}`, 'total', String(targets.length), 'completed', '0', 'failed', '0', 'status', 'queued');
    await redis.expire(`enrichjob:${job.id}`, 86400);

    // Upsert all enrichment rows as pending
    const valueRows = targets.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, 'pending')`).join(',');
    const flatVals  = targets.flatMap(id => [id, orgId]);
    await db.query(`
      INSERT INTO contact_enrichments (contact_id, org_id, enrichment_status)
      VALUES ${valueRows}
      ON CONFLICT (contact_id) DO UPDATE SET enrichment_status='pending', updated_at=NOW()
    `, flatVals);

    // Batch-add BullMQ jobs (chunks of 100)
    const BATCH = 100;
    for (let i = 0; i < targets.length; i += BATCH) {
      const chunk = targets.slice(i, i + BATCH);
      const priority = targets.length > 1000 ? 3 : targets.length > 100 ? 5 : 8;
      await Promise.all(chunk.map(contactId =>
        enrichmentQueue.add('enrich', { contactId, orgId, enrichmentJobId: job.id }, { priority })
      ));
    }

    await db.query("UPDATE enrichment_jobs SET status='queued' WHERE id=$1", [job.id]);

    return res.json({ jobId: job.id, total: targets.length, message: `Enrichment queued for ${targets.length} contacts` });
  } catch (e) {
    console.error('[enrichController] enrichBulk', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── SSE progress stream ────────────────────────────────────────────────────────
async function jobProgress(req, res) {
  const { jobId } = req.params;

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const poll = async () => {
    try {
      // Try Redis first
      let hash = await redis.hgetall(`enrichjob:${jobId}`);
      if (!hash || !hash.total) {
        // Fallback to DB
        const row = (await db.query('SELECT * FROM enrichment_jobs WHERE id=$1', [jobId])).rows[0];
        if (row) {
          hash = { total: String(row.total), completed: String(row.completed), failed: String(row.failed), status: row.status };
        }
      }

      if (!hash) { send({ error: 'Job not found' }); return res.end(); }

      const total     = parseInt(hash.total     || 0, 10);
      const completed = parseInt(hash.completed || 0, 10);
      const failed    = parseInt(hash.failed    || 0, 10);
      const pct       = total > 0 ? Math.round((completed + failed) / total * 100) : 0;
      const status    = hash.status || 'running';

      send({ total, completed, failed, pct, status, currentContact: hash.current_contact || null });

      if (status === 'completed' || status === 'failed' || pct >= 100) {
        return res.end();
      }
    } catch (e) {
      send({ error: e.message });
      return res.end();
    }
  };

  await poll();
  const interval = setInterval(poll, 2500);
  req.on('close', () => clearInterval(interval));
}

// ── Get enrichment data for a contact ─────────────────────────────────────────
async function getEnrichment(req, res) {
  try {
    const { id } = req.params;
    const enrichment = (await db.query(
      'SELECT * FROM contact_enrichments WHERE contact_id=$1', [id]
    )).rows[0];
    const contact = (await db.query('SELECT * FROM contacts WHERE id=$1', [id])).rows[0];

    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const fieldMeta = {};
    if (enrichment?.field_confidence) {
      for (const [field, conf] of Object.entries(enrichment.field_confidence)) {
        fieldMeta[field] = {
          confidence: conf.score,
          verifiedAt: conf.verified_at,
          sourceUrl: enrichment.field_sources?.[field]?.url || null,
          snippet:   enrichment.field_sources?.[field]?.snippet || null,
        };
      }
    }

    return res.json({ contact, enrichment: enrichment || null, fieldMeta });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Delete enrichment ─────────────────────────────────────────────────────────
async function deleteEnrichment(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM contact_enrichments WHERE contact_id=$1', [id]);
    await db.query("UPDATE contacts SET research_done=false, enriched_at=NULL WHERE id=$1", [id]);
    req.flash('success', 'Enrichment data cleared');
    return res.redirect(`/contacts/${id}`);
  } catch (e) {
    req.flash('error', e.message);
    return res.redirect(`/contacts/${id}`);
  }
}

// ── Progress page (HTML) ───────────────────────────────────────────────────────
async function progressPage(req, res) {
  try {
    const { jobId } = req.params;
    const job = (await db.query('SELECT * FROM enrichment_jobs WHERE id=$1', [jobId])).rows[0];
    if (!job) return res.status(404).send('Job not found');
    res.render('enrichment/progress', {
      title: 'Enrichment Progress',
      page: 'contacts',
      breadcrumbs: ['Contacts', 'Enrichment'],
      job,
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
}

// ── Stats summary ──────────────────────────────────────────────────────────────
async function stats(req, res) {
  try {
    const orgId = getOrgId(req);
    const [totRow, statusRow, fieldRow] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enrichment_status='completed')::int AS enriched, COUNT(*) FILTER (WHERE enrichment_status='running')::int AS running, COUNT(*) FILTER (WHERE enrichment_status='failed')::int AS failed, COUNT(*) FILTER (WHERE enrichment_status='pending')::int AS pending FROM contact_enrichments WHERE org_id=$1", [orgId]),
      db.query("SELECT COUNT(*)::int AS total_contacts FROM contacts WHERE org_id=$1", [orgId]),
      db.query("SELECT AVG(jsonb_object_agg(k, v->>'score')::text::numeric)::numeric(5,1) FROM contact_enrichments, jsonb_each(field_confidence) AS t(k,v) WHERE org_id=$1", [orgId]),
    ]);
    const totalContacts = statusRow.rows[0].total_contacts;
    const enriched      = totRow.rows[0].enriched;
    return res.json({
      ...totRow.rows[0],
      total_contacts:   totalContacts,
      enrichment_rate:  totalContacts > 0 ? Math.round(enriched / totalContacts * 100) : 0,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { enrichSingle, enrichBulk, jobProgress, getEnrichment, deleteEnrichment, progressPage, stats };
