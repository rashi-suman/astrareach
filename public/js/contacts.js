(function () {
  const selectAll = document.getElementById('select-all');
  const bulkBar = document.getElementById('bulk-bar');
  const columnToggleBtn = document.getElementById('column-toggle-btn');
  const columnToggleMenu = document.getElementById('column-toggle-menu');

  function checkedRows() {
    return Array.from(document.querySelectorAll('.row-check:checked'));
  }

  function refreshBulk() {
    const count = checkedRows().length;
    if (!bulkBar) return;
    bulkBar.classList.toggle('visible', count > 0);
    const label = bulkBar.querySelector('[data-count]');
    if (label) label.textContent = count;
  }

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('.row-check').forEach((cb) => { cb.checked = selectAll.checked; });
      refreshBulk();
    });
  }

  document.querySelectorAll('.row-check').forEach((cb) => cb.addEventListener('change', refreshBulk));

  document.querySelector('[data-bulk="delete"]')?.addEventListener('click', async () => {
    const ids = checkedRows().map((x) => x.value);
    if (!ids.length) return;
    if (!window.confirm('Delete selected contacts?')) return;
    const r = await fetch('/contacts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (r.ok) window.location.reload();
  });

  document.querySelector('[data-bulk="tag"]')?.addEventListener('click', async () => {
    const ids = checkedRows().map((x) => x.value);
    if (!ids.length) return;
    const tag = window.prompt('Enter tag to add');
    if (!tag) return;
    const r = await fetch('/contacts/bulk-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, tag }),
    });
    if (r.ok) window.location.reload();
  });

  // Column show/hide
  columnToggleBtn?.addEventListener('click', () => {
    columnToggleMenu?.classList.toggle('hidden');
  });

  document.querySelectorAll('[data-col-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const col = cb.getAttribute('data-col-toggle');
      const visible = cb.checked;
      document.querySelectorAll(`[data-col='${col}']`).forEach((el) => {
        el.classList.toggle('col-hidden', !visible);
      });
    });
  });

  // Row 3-dot action menus
  document.querySelectorAll('.row-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = btn.closest('.row-menu-wrap');
      const menu = wrap?.querySelector('.row-menu');
      document.querySelectorAll('.row-menu').forEach((m) => m.classList.add('hidden'));
      menu?.classList.toggle('hidden');
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-menu-wrap')) {
      document.querySelectorAll('.row-menu').forEach((m) => m.classList.add('hidden'));
    }
    if (!e.target.closest('.table-tools')) {
      columnToggleMenu?.classList.add('hidden');
    }
  });
})();
