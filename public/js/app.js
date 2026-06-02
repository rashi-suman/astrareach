(function () {
  const body = document.body;

  window.showToast = function showToast(message, type = 'info') {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const d = document.createElement('div');
    d.className = `toast ${type}`;
    d.textContent = message;
    c.appendChild(d);
    setTimeout(() => d.remove(), 3000);
  };

  window.openDrawer = async function openDrawer(url) {
    const drawer = document.getElementById('drawer');
    if (!drawer) return;
    const r = await fetch(url);
    drawer.innerHTML = await r.text();
    drawer.classList.add('open');
    document.getElementById('modal-overlay')?.classList.remove('hidden');
  };

  window.closeDrawer = function closeDrawer() {
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('modal-overlay')?.classList.add('hidden');
  };

  window.confirmAction = function confirmAction(message) {
    return Promise.resolve(window.confirm(message));
  };

  document.querySelectorAll('[data-search-input]').forEach((input) => {
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const u = new URL(window.location.href);
        if (input.value) u.searchParams.set('search', input.value);
        else u.searchParams.delete('search');
        u.searchParams.set('page', '1');
        window.location.href = u.toString();
      }, 400);
    });
  });

  document.querySelectorAll('[data-filter]').forEach((select) => {
    select.addEventListener('change', () => {
      const u = new URL(window.location.href);
      if (select.value) u.searchParams.set(select.dataset.filter, select.value);
      else u.searchParams.delete(select.dataset.filter);
      u.searchParams.set('page', '1');
      window.location.href = u.toString();
    });
  });

  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-tab]')) {
      const tab = e.target.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((t) => t.classList.remove('active'));
      e.target.classList.add('active');
      document.querySelectorAll('[data-tab-panel]').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.tabPanel !== tab);
      });
    }
  });

  if (window.innerWidth < 1280) body.classList.add('sidebar-collapsed');
})();
