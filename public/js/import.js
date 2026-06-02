const p = document.getElementById('import-progress');
if (p && p.dataset.batch) {
  const batchId = p.dataset.batch;
  const es = new EventSource(`/contacts/import/${p.dataset.batch}/progress`);
  let contactsTimer = null;
  let progressTimer = null;

  function renderProgress(d) {
    const pct = d.total ? Math.round((d.imported / d.total) * 100) : 0;
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = `${pct}%`;

    const txt = document.getElementById('progress-text');
    if (txt) txt.textContent = `${d.imported || 0}/${d.total || 0}`;

    const meta = document.getElementById('progress-meta');
    if (meta) {
      meta.textContent = `Duplicates: ${d.duplicates || 0} • Invalid email skipped: ${d.skipped_invalid_email || 0} • Errors: ${d.errors || 0} • Status: ${d.status || 'processing'}`;
    }

    const errEl = document.getElementById('progress-error');
    if (errEl) {
      if (d.last_error) {
        errEl.style.display = 'block';
        errEl.textContent = d.last_error;
      } else {
        errEl.style.display = 'none';
        errEl.textContent = '';
      }
    }
  }

  function renderContacts(rows) {
    const tbody = document.getElementById('live-contacts-body');
    if (!tbody) return;
    if (!rows || !rows.length) {
      tbody.innerHTML = "<tr><td colspan='4' class='text-secondary'>No contacts imported yet...</td></tr>";
      return;
    }
    tbody.innerHTML = rows.map((c) => {
      const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '-';
      const date = c.created_at ? new Date(c.created_at).toLocaleString() : '-';
      return `<tr><td>${name}</td><td>${c.email || '-'}</td><td>${c.company || '-'}</td><td>${date}</td></tr>`;
    }).join('');
  }

  async function loadContactsStatus() {
    try {
      const resp = await fetch(`/contacts/import/${batchId}/status`, { headers: { Accept: 'application/json' } });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data?.progress) renderProgress(data.progress);
      if (data?.contacts) renderContacts(data.contacts);
      if (data?.progress?.status === 'done' || data?.progress?.status === 'failed') {
        if (progressTimer) clearInterval(progressTimer);
        if (contactsTimer) clearInterval(contactsTimer);
        es.close();
      }
    } catch (_) {
      // keep polling; transient network/auth refresh issues can happen
    }
  }

  contactsTimer = setInterval(loadContactsStatus, 1500);
  progressTimer = setInterval(loadContactsStatus, 1000);
  loadContactsStatus();

  es.onmessage = (e) => {
    const d = JSON.parse(e.data || '{}');
    renderProgress(d);

    if (d.status === 'done' || d.status === 'failed') {
      es.close();
      if (progressTimer) clearInterval(progressTimer);
      if (contactsTimer) clearInterval(contactsTimer);
      loadContactsStatus();
    }
  };
}
