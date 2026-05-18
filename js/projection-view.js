// projection-view.js — 3-Year Daily Projection screen

const ProjectionView = (() => {

  let fullData   = [];       // 1095-day projection array
  let viewMode   = 'events'; // 'events' | 'all'
  let viewYear   = 0;
  let viewMonth0 = 0;        // 0-indexed month
  let tooltipEl  = null;

  const MONTH_FULL  = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];

  // ── Init (called once on page load) ─────────────────────────────────────

  function init() {
    // Mode toggle
    document.getElementById('proj-mode-toggle').addEventListener('click', e => {
      const btn = e.target.closest('.proj-toggle-btn');
      if (!btn) return;
      viewMode = btn.dataset.mode;
      document.querySelectorAll('.proj-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTable();
    });

    // Month navigation
    document.getElementById('proj-prev-month').addEventListener('click', shiftMonth.bind(null, -1));
    document.getElementById('proj-next-month').addEventListener('click', shiftMonth.bind(null,  1));
    document.getElementById('proj-month-select').addEventListener('change', e => {
      const [y, m] = e.target.value.split('-').map(Number);
      viewYear   = y;
      viewMonth0 = m;
      renderTable();
    });

    // Jump to risk
    document.getElementById('proj-jump-risk').addEventListener('click', jumpToFirstRisk);

    // Export CSV
    document.getElementById('proj-export-csv').addEventListener('click', exportCSV);

    // Tooltip
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'proj-tooltip';
    document.body.appendChild(tooltipEl);

    document.addEventListener('mousemove', e => {
      if (!tooltipEl.classList.contains('visible')) return;
      const x = e.clientX + 18;
      const y = e.clientY + 12;
      const tw = tooltipEl.offsetWidth;
      const th = tooltipEl.offsetHeight;
      tooltipEl.style.left = Math.min(x, window.innerWidth  - tw - 8) + 'px';
      tooltipEl.style.top  = Math.min(y, window.innerHeight - th - 8) + 'px';
    });
  }

  // ── Render (called on every tab switch to projection) ───────────────────

  function render(appData) {
    // Generate full 3-year projection (1095 days = default)
    fullData = Projection.generateDailyProjection(
      appData.current_balance,
      appData.bills,
      appData.income
      // default 1095 days
    );

    // Start at current month
    const today  = new Date();
    viewYear     = today.getFullYear();
    viewMonth0   = today.getMonth();

    renderStats();
    populateMonthSelect();
    renderTable();
  }

  // ── Stats bar ────────────────────────────────────────────────────────────

  function renderStats() {
    if (fullData.length === 0) return;

    const last    = fullData[fullData.length - 1];
    const firstNeg = fullData.find(d => d.isNegative);
    const totalIn  = fullData.reduce((t, d) => t + d.totalIncome,   0);
    const totalOut = fullData.reduce((t, d) => t + d.totalDeducted, 0);

    document.getElementById('proj-end-date').textContent =
      fmtDateShort(last.date);

    const riskEl = document.getElementById('proj-first-risk');
    if (firstNeg) {
      riskEl.textContent = fmtDateShort(firstNeg.date);
      riskEl.className   = 'proj-stat-val negative';
    } else {
      riskEl.textContent = 'All clear ✓';
      riskEl.className   = 'proj-stat-val positive';
    }

    document.getElementById('proj-total-income').textContent = fmtGBP(totalIn);
    document.getElementById('proj-total-bills').textContent  = fmtGBP(totalOut);

    // Show jump button only if there is a risk
    const hasRisk = fullData.some(d => d.isNegative || d.isWarning);
    document.getElementById('proj-jump-risk').classList.toggle('hidden', !hasRisk);
  }

  // ── Month select ─────────────────────────────────────────────────────────

  function populateMonthSelect() {
    const sel = document.getElementById('proj-month-select');
    sel.innerHTML = '';

    // Collect unique year-month keys in order
    const seen = new Set();
    const opts = [];
    for (const d of fullData) {
      const dt  = new Date(d.date + 'T00:00:00');
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      if (!seen.has(key)) {
        seen.add(key);
        opts.push({ year: dt.getFullYear(), month0: dt.getMonth(), key });
      }
    }

    for (const { year, month0, key } of opts) {
      const opt       = document.createElement('option');
      opt.value       = key;
      opt.textContent = `${MONTH_FULL[month0]} ${year}`;
      sel.appendChild(opt);
    }

    syncMonthSelect();
  }

  function syncMonthSelect() {
    const sel = document.getElementById('proj-month-select');
    sel.value = `${viewYear}-${viewMonth0}`;

    // Disable prev/next at the edges
    const opts  = Array.from(sel.options);
    const cur   = opts.findIndex(o => o.value === sel.value);
    document.getElementById('proj-prev-month').disabled = cur <= 0;
    document.getElementById('proj-next-month').disabled = cur >= opts.length - 1;
  }

  function shiftMonth(delta) {
    const sel  = document.getElementById('proj-month-select');
    const opts = Array.from(sel.options);
    const cur  = opts.findIndex(o => o.value === `${viewYear}-${viewMonth0}`);
    const next = cur + delta;
    if (next < 0 || next >= opts.length) return;
    const [y, m] = opts[next].value.split('-').map(Number);
    viewYear   = y;
    viewMonth0 = m;
    syncMonthSelect();
    renderTable();
  }

  // ── Table ────────────────────────────────────────────────────────────────

  function renderTable() {
    syncMonthSelect();

    // Filter to this month
    const monthData = fullData.filter(d => {
      const dt = new Date(d.date + 'T00:00:00');
      return dt.getFullYear() === viewYear && dt.getMonth() === viewMonth0;
    });

    // Which rows to show
    let rows;
    if (viewMode === 'all') {
      rows = monthData;
    } else {
      // Event days + holiday days + first/last day of month
      rows = monthData.filter((d, i) =>
        d.incomeReceived.length  > 0 ||
        d.deductions.length      > 0 ||
        d.skippedPayments?.length > 0 ||
        i === 0 ||
        i === monthData.length - 1
      );
    }

    const tbody = document.getElementById('proj-tbody');
    tbody.innerHTML = '';

    // Month header row
    const hdr   = document.createElement('tr');
    hdr.className = 'proj-month-hdr';
    hdr.innerHTML = `<td colspan="7">${MONTH_FULL[viewMonth0]} ${viewYear}</td>`;
    tbody.appendChild(hdr);

    if (rows.length === 0) {
      const empty = document.createElement('tr');
      empty.innerHTML = `<td colspan="7" class="proj-empty">No events this month</td>`;
      tbody.appendChild(empty);
      return;
    }

    for (const day of rows) {
      tbody.appendChild(buildRow(day));
    }
  }

  function buildRow(day) {
    const tr = document.createElement('tr');
    tr.className  = 'proj-row';
    tr.dataset.date = day.date;

    const hasIncome   = day.incomeReceived.length > 0;
    const hasBills    = day.deductions.length > 0;
    const hasHoliday  = (day.skippedPayments?.length ?? 0) > 0;

    if      (day.isNegative)          tr.classList.add('proj-row-negative');
    else if (day.isWarning)            tr.classList.add('proj-row-warning');
    else if (hasIncome && hasBills)    tr.classList.add('proj-row-both');
    else if (hasIncome)                tr.classList.add('proj-row-income');
    else if (hasBills)                 tr.classList.add('proj-row-bills');
    else if (hasHoliday)               tr.classList.add('proj-row-holiday');

    // Date — show year if not current year
    const dt        = new Date(day.date + 'T00:00:00');
    const isThisYr  = dt.getFullYear() === new Date().getFullYear();
    const dateStr   = dt.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short',
      ...(isThisYr ? {} : { year: 'numeric' })
    });

    const warnIcon = day.isNegative ? '<span class="proj-warn-icon">⚠</span> ' : '';

    const holidayHtml = hasHoliday
      ? day.skippedPayments.map(s =>
          `<span class="proj-holiday-item">🏖 ${esc(s.name)} <em>holiday — ${fmtGBP(s.amount)} not needed</em></span>`
        ).join('')
      : '';

    const incHtml = hasIncome
      ? day.incomeReceived.map(r =>
          `<span class="proj-inc-item">+${fmtGBP(r.amount)}<em>${esc(r.name)}</em></span>`
        ).join('') + holidayHtml
      : holidayHtml || '<span class="proj-dash">—</span>';

    // Bills cell
    const billHtml = hasBills
      ? day.deductions.map(d =>
          `<span class="proj-bill-item">${esc(d.billName)}<em>${fmtGBP(d.amount)}</em></span>`
        ).join('')
      : '<span class="proj-dash">—</span>';

    // Net change
    const net     = day.totalIncome - day.totalDeducted;
    const netStr  = net === 0
      ? '<span class="proj-dash">—</span>'
      : `<span class="${net > 0 ? 'positive' : 'negative'}">${net > 0 ? '+' : ''}${fmtGBP(net)}</span>`;

    // Ending balance
    const endCls = day.isNegative ? 'negative' : day.isWarning ? 'warning-color' : '';

    tr.innerHTML =
      `<td class="proj-date-cell">${warnIcon}${dateStr}</td>` +
      `<td class="proj-day-cell">${day.dayOfWeek.slice(0, 3)}</td>` +
      `<td class="proj-num">${fmtGBP(day.startingBalance)}</td>` +
      `<td class="proj-events-cell">${incHtml}</td>` +
      `<td class="proj-events-cell">${billHtml}</td>` +
      `<td class="proj-num">${netStr}</td>` +
      `<td class="proj-num ${endCls}">${fmtGBP(day.endingBalance)}</td>`;

    tr.addEventListener('mouseenter', e => showTooltip(e, day));
    tr.addEventListener('mouseleave', hideTooltip);

    return tr;
  }

  // ── Jump to first risk ───────────────────────────────────────────────────

  function jumpToFirstRisk() {
    const risk = fullData.find(d => d.isNegative) || fullData.find(d => d.isWarning);
    if (!risk) return;

    const dt   = new Date(risk.date + 'T00:00:00');
    viewYear   = dt.getFullYear();
    viewMonth0 = dt.getMonth();
    renderTable();

    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-date="${risk.date}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────

  function showTooltip(e, day) {
    const fullDate = new Date(day.date + 'T00:00:00')
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    let html = `<div class="tt-date">${fullDate}</div>`;
    html    += `<div class="tt-row tt-start">Opening balance: <strong>${fmtGBP(day.startingBalance)}</strong></div>`;

    if (day.incomeReceived.length > 0) {
      html += `<div class="tt-section-hdr tt-inc-hdr">Income</div>`;
      for (const r of day.incomeReceived)
        html += `<div class="tt-row tt-inc-row"><span>+${fmtGBP(r.amount)}</span><span>${esc(r.name)}</span></div>`;
    }

    if (day.skippedPayments?.length > 0) {
      html += `<div class="tt-section-hdr tt-holiday-hdr">Payment Holiday</div>`;
      for (const s of day.skippedPayments)
        html += `<div class="tt-row tt-holiday-row"><span>${fmtGBP(s.amount)} not needed</span><span>${esc(s.name)}</span></div>`;
    }

    if (day.deductions.length > 0) {
      html += `<div class="tt-section-hdr tt-bill-hdr">Bills</div>`;
      for (const d of day.deductions)
        html += `<div class="tt-row tt-bill-row"><span>−${fmtGBP(d.amount)}</span><span>${esc(d.billName)}</span></div>`;
    }

    const endClass = day.isNegative ? 'tt-row-negative' : '';
    html += `<div class="tt-row tt-end ${endClass}">Closing balance: <strong>${fmtGBP(day.endingBalance)}</strong></div>`;


    tooltipEl.innerHTML = html;
    tooltipEl.classList.add('visible');
    tooltipEl.style.left = (e.clientX + 18) + 'px';
    tooltipEl.style.top  = (e.clientY + 12) + 'px';
  }

  function hideTooltip() {
    tooltipEl.classList.remove('visible');
  }

  // ── CSV Export ───────────────────────────────────────────────────────────

  function exportCSV() {
    if (!fullData.length) return;

    const rows = [['Date','Day','Start Balance','Income','Bills','Net','End Balance']];

    for (const d of fullData) {
      const incStr  = d.incomeReceived.map(r => `${r.name}: +${r.amount.toFixed(2)}`).join('; ');
      const billStr = d.deductions.map(b => `${b.billName}: -${b.amount.toFixed(2)}`).join('; ');
      const net     = d.totalIncome - d.totalDeducted;
      rows.push([
        d.date,
        d.dayOfWeek,
        d.startingBalance.toFixed(2),
        incStr,
        billStr,
        net.toFixed(2),
        d.endingBalance.toFixed(2)
      ]);
    }

    const csv  = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `projection-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function fmtGBP(n) {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
  }

  function fmtDateShort(isoStr) {
    if (!isoStr) return '—';
    return new Date(isoStr + 'T00:00:00')
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init, render };

})();
