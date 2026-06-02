const stats = document.getElementById('campaign-stats');
if (stats && stats.dataset.id) {
  setInterval(async () => {
    const r = await fetch(`/campaigns/${stats.dataset.id}/stats`);
    if (!r.ok) return;
    const d = await r.json();
    Object.entries(d).forEach(([k, v]) => {
      const el = document.querySelector(`[data-stat='${k}']`);
      if (el) el.textContent = v;
    });
  }, 10000);
}

document.querySelectorAll('[data-view-email]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const campaignId = stats?.dataset?.id;
    if (!campaignId) return;
    await window.openDrawer(`/campaigns/${campaignId}/contact/${btn.dataset.viewEmail}/email`);
  });
});
