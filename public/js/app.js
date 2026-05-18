// app.js — main controller

let appData = null; // local mirror of store state, refreshed on every change

// Configure tab state
let billSearch = '';
let billSort   = 'date'; // 'date' | 'amount' | 'name'

const BILL_CATEGORIES = ['Housing','Utilities','Subscriptions','Insurance','Transport','Food','Other'];
const MONTH_NAMES     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  initNavTabs();
  initBalanceListeners();
  initConfigureControls();
  ProjectionView.init();

  // Only the network fetch is wrapped — render errors must not be swallowed here.
  try {
    appData = await store.init();
  } catch (err) {
    console.error('Failed to load data:', err);
    showToast('Could not connect to server. Make sure it is running on port 3000.', 'toast-error', 6000);
    document.getElementById('app-loading')?.remove();
    return;
  }

  // Dismiss skeleton overlay
  const overlay = document.getElementById('app-loading');
  overlay?.classList.add('fade-out');
  setTimeout(() => overlay?.remove(), 320);

  store.onDataChange(() => {
    appData = store.getState();
    // Always refresh dashboard.
    // Configure cards are NOT re-rendered here (would steal focus while editing).
    // They re-render on: tab switch, add, delete.
    renderDashboardAndProjection();
    renderConfigureSummary();
    // If the projection tab is visible, keep it live too
    if (document.getElementById('tab-projection').classList.contains('active')) {
      ProjectionView.render(appData);
    }
  });

  renderAll();
  computeAnnualSkips(); // async, fires-and-forgets; re-renders via onDataChange if skips added
}

// Full render — called once on load, and whenever configure needs a full refresh.
function renderAll() {
  renderDashboardAndProjection();
  renderConfigure();
}

function renderDashboardAndProjection() {
  if (!appData) return;
  const projData  = Projection.generate(appData);
  // Use 1095-day projection for skippable calculation so the full 3-year
  // window is checked; slice to 365 for the chart which only shows 12 months.
  const fullProj  = Projection.generateDailyProjection(
    appData.current_balance, appData.bills, appData.income, 1095
  );
  renderDashboard(projData, fullProj.slice(0, 365));
}

// Full configure render — cards + balance + summary.
// Only called on tab switch, initial load, and after add/delete.
function renderConfigure() {
  renderBalance();
  renderIncomeCards();
  renderBillCards();
  renderConfigureSummary();
}

// ── Navigation ─────────────────────────────────────────────────────────────

function initNavTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelector('[data-tab="' + name + '"]').classList.add('active');
  // Re-render configure cards fresh whenever the user navigates to that tab
  if (name === 'configure')  renderConfigure();
  // Projection recalculates from scratch on every view (spec requirement)
  if (name === 'projection') ProjectionView.render(appData);
}

// ── Dashboard ──────────────────────────────────────────────────────────────

function renderDashboard(projData, dailyProj) {
  renderAlertBanner(dailyProj);
  renderOverviewCards();
  renderNextEventCards();
  renderUpcomingEvents(dailyProj);
  renderPaymentHolidays();
  Charts.render(projData);
  Charts.renderBreakdown(Projection.getCategoryBreakdown(appData.bills));
}

function renderAlertBanner(dailyProj) {
  const negDate = Projection.getFirstNegativeDate(dailyProj);
  const banner  = document.getElementById('alert-banner');
  if (negDate) {
    document.getElementById('negative-date').textContent = formatDate(negDate);
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function effectiveIncomeAmount(source) {
  if (source.amount_overrides) {
    const now = new Date();
    const key = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    if (key in source.amount_overrides) return source.amount_overrides[key];
  }
  return source.amount;
}

function renderOverviewCards() {
  const balance = appData.current_balance;

  const avgIncome    = appData.income.reduce((t, s) => t + effectiveIncomeAmount(s), 0);
  const avgOutgoings = Object.values(Projection.getCategoryBreakdown(appData.bills))
    .reduce((sum, v) => sum + v, 0);
  const net = avgIncome - avgOutgoings;

  animateCardValue(document.getElementById('dash-balance'),   balance,    fmtGBP);
  animateCardValue(document.getElementById('dash-income'),    avgIncome,  fmtGBP);
  animateCardValue(document.getElementById('dash-outgoings'), avgOutgoings, fmtGBP);

  // Zero balance hint
  const balCard = document.getElementById('card-balance');
  balCard.classList.remove('status-good', 'status-warn', 'status-bad');
  if (balance < 0)        balCard.classList.add('status-bad');
  else if (balance < 500) balCard.classList.add('status-warn');
  else                    balCard.classList.add('status-good');

  let hint = balCard.querySelector('.balance-zero-hint');
  if (balance === 0 && appData.income.length === 0 && appData.bills.length === 0) {
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'balance-zero-hint';
      hint.innerHTML = '<a class="hint-link">Set your balance and add bills in Configure →</a>';
      hint.querySelector('.hint-link').addEventListener('click', () => switchTab('configure'));
      balCard.appendChild(hint);
    }
  } else {
    hint?.remove();
  }

  const netEl = document.getElementById('dash-net');
  animateCardValue(netEl, net, fmtGBP);
  netEl.className = 'card-value ' + (net >= 0 ? 'positive' : 'negative');
}

function renderNextEventCards() {
  const nextBill = Projection.getNextBill(appData.bills);
  const nextPay  = Projection.getNextPayDay(appData.income);

  if (nextBill) {
    document.getElementById('next-bill-name').textContent   = nextBill.bill.name;
    document.getElementById('next-bill-amount').textContent = fmtGBP(nextBill.bill.amount);
    document.getElementById('next-bill-date').textContent   = formatDate(nextBill.date);
    document.getElementById('next-bill-days').textContent   = daysLabel(nextBill.daysUntil);
  }
  if (nextPay) {
    const nextPayDate = new Date(nextPay.date + 'T00:00:00');
    let nextPayAmount = nextPay.source.amount;
    if (nextPay.source.amount_overrides) {
      const key = nextPayDate.getFullYear() + '-' + String(nextPayDate.getMonth() + 1).padStart(2, '0');
      if (key in nextPay.source.amount_overrides) nextPayAmount = nextPay.source.amount_overrides[key];
    }
    document.getElementById('next-pay-name').textContent   = nextPay.source.name;
    document.getElementById('next-pay-amount').textContent = fmtGBP(nextPayAmount);
    document.getElementById('next-pay-date').textContent   = formatDate(nextPay.date);
    document.getElementById('next-pay-days').textContent   = daysLabel(nextPay.daysUntil);
  }
}

function renderUpcomingEvents(dailyProj) {
  const events = [];
  for (const day of dailyProj) {
    for (const inc of day.incomeReceived)
      events.push({ type: 'income', name: inc.name, amount: inc.amount, date: day.date });
    for (const ded of day.deductions)
      events.push({ type: 'bill', name: ded.billName, amount: ded.amount, date: day.date });
    if (events.length >= 10) break;
  }

  const list = document.getElementById('upcoming-events-list');
  list.innerHTML = '';
  events.slice(0, 10).forEach(ev => {
    const li = document.createElement('li');
    const isIncome = ev.type === 'income';
    li.innerHTML =
      `<span class="ev-name">${esc(ev.name)}</span>` +
      `<span class="ev-amount ${isIncome ? 'positive' : 'negative'}">` +
        `${isIncome ? '+' : '-'}${fmtGBP(Math.abs(ev.amount))}` +
      `</span>` +
      `<span class="ev-date">${formatDate(ev.date)}</span>`;
    list.appendChild(li);
  });
}


// ── Payment Holidays ───────────────────────────────────────────────────────

function renderPaymentHolidays() {
  const card = document.getElementById('skip-card');
  const list = document.getElementById('skip-list');

  // Collect every confirmed skipped date from every_4_weeks sources
  const holidays = [];
  for (const source of appData.income) {
    if (!source.skipped_dates || source.skipped_dates.length === 0) continue;
    for (const date of source.skipped_dates) {
      holidays.push({ date, sourceName: source.name, amount: source.amount });
    }
  }
  holidays.sort((a, b) => a.date.localeCompare(b.date));

  if (holidays.length === 0) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  document.getElementById('export-holidays-ics').onclick = () => exportHolidaysICS(holidays);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  list.innerHTML = '';
  // Group by year for readability
  let lastYear = null;
  holidays.forEach(h => {
    const d    = new Date(h.date + 'T00:00:00');
    const yr   = d.getFullYear();
    const days = Math.round((d - today) / 86400000);
    const dayLbl = days < 0 ? 'Passed' : days === 0 ? 'Today' : daysLabel(days);
    const isPast = days < 0;

    if (yr !== lastYear) {
      lastYear = yr;
      const sep = document.createElement('li');
      sep.className = 'skip-year-sep';
      sep.textContent = String(yr);
      list.appendChild(sep);
    }

    const li = document.createElement('li');
    li.className = 'skip-item' + (isPast ? ' skip-item-past' : '');
    li.innerHTML =
      `<span class="skip-holiday-icon">🏖</span>` +
      `<span class="ev-name">${esc(h.sourceName)}</span>` +
      `<span class="ev-date">${formatDate(h.date)}</span>` +
      `<span class="skip-saved-amount">${fmtGBP(h.amount)} not needed</span>` +
      `<span class="event-badge skip-day-badge ${isPast ? 'skip-past' : ''}">${dayLbl}</span>`;
    list.appendChild(li);
  });
}

// ── Auto-select 1 skip per calendar year ──────────────────────────────────

let _skipsComputed = false;

async function computeAnnualSkips() {
  if (_skipsComputed) return;
  _skipsComputed = true;

  const jessSource = appData.income.find(s => s.type === 'every_4_weeks');
  if (!jessSource) return;

  const today     = new Date();
  const startYear = today.getFullYear();
  const years     = [startYear, startYear + 1, startYear + 2];

  let currentSkips = [...(jessSource.skipped_dates || [])];
  let changed = false;

  for (const year of years) {
    // This year already has a skip — respect it
    if (currentSkips.some(d => d.startsWith(String(year)))) continue;

    // Build income with accumulated skips applied so far
    const incomeWithSkips = appData.income.map(s =>
      s.id === jessSource.id ? { ...s, skipped_dates: currentSkips } : s
    );

    // Full 3-year projection reflecting all current skips
    const proj = Projection.generateDailyProjection(
      appData.current_balance, appData.bills, incomeWithSkips, 1095
    );

    // Find safe candidates in this calendar year only
    const candidates = Projection.findSkippablePayments(proj, incomeWithSkips)
      .filter(p => p.isSkippable && p.date.startsWith(String(year)));

    if (candidates.length === 0) continue;

    // Pick the one with the most headroom (highest floor balance if skipped)
    candidates.sort((a, b) => b.balanceIfSkipped - a.balanceIfSkipped);
    currentSkips = [...currentSkips, candidates[0].date];
    changed = true;
  }

  if (changed) {
    await store.updateIncome(jessSource.id, { ...jessSource, skipped_dates: currentSkips });
    // appData refreshes via onDataChange → re-render picks up the new skips automatically
  }
}

// ── Configure: Balance ─────────────────────────────────────────────────────

function renderBalance() {
  const el = document.getElementById('current-balance');
  // Don't overwrite the field while the user is actively editing it
  if (document.activeElement !== el) {
    el.value = appData.current_balance.toFixed(2);
  }
}

function saveBalance() {
  const val = parseFloat(document.getElementById('current-balance').value);
  store.setBalance(val);
}

function initBalanceListeners() {
  const el = document.getElementById('current-balance');
  el.addEventListener('input', saveBalance);
  el.addEventListener('blur',  saveBalance);
  el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
}

// ── Configure: Income cards ────────────────────────────────────────────────

function renderIncomeCards() {
  const count = appData.income.length;
  document.getElementById('income-count').textContent =
    `${count} source${count !== 1 ? 's' : ''}`;

  const container = document.getElementById('income-cards');
  container.innerHTML = '';

  if (appData.income.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cfg-empty-state';
    empty.innerHTML =
      '<div class="cfg-empty-icon">💰</div>' +
      '<p class="cfg-empty-title">No income sources yet</p>' +
      '<p class="cfg-empty-sub">Add a salary or regular payment to track what comes in</p>';
    container.appendChild(empty);
    return;
  }

  appData.income.forEach(inc => container.appendChild(buildIncomeCard(inc)));
}

function buildIncomeCard(inc) {
  const card       = document.createElement('div');
  card.className   = 'cfg-card';
  card.dataset.id  = inc.id;
  const isMonthly  = inc.type !== 'every_4_weeks';

  card.innerHTML = `
    <div class="cfg-card-top">
      <input type="text" class="cfg-name-input" data-field="name"
             value="${esc(inc.name)}" placeholder="Income name">
      <button class="cfg-delete-btn" title="Delete">&#10005;</button>
    </div>
    <div class="cfg-card-fields">
      <div class="cfg-field-group">
        <span class="cfg-field-label">Amount</span>
        <div class="cfg-amount-wrap">
          <span class="cfg-currency">£</span>
          <input type="number" class="cfg-amount-input" data-field="amount"
                 value="${inc.amount}" step="0.01" min="0" placeholder="0.00">
        </div>
      </div>
    </div>
    <div class="cfg-type-row">
      <button class="type-toggle-btn ${isMonthly ? 'active' : ''}" data-type="monthly">Monthly</button>
      <button class="type-toggle-btn ${!isMonthly ? 'active' : ''}" data-type="every_4_weeks">Every 4 Weeks</button>
    </div>
    <div class="cfg-schedule-fields">
      <div class="cfg-monthly-fields" style="display:${isMonthly ? 'flex' : 'none'}">
        <div class="cfg-field-group">
          <span class="cfg-field-label">Pay Day (1–28)</span>
          <input type="number" class="cfg-day-input" data-field="pay_date"
                 value="${inc.pay_date ?? 1}" min="1" max="28">
        </div>
      </div>
      <div class="cfg-4w-fields" style="display:${!isMonthly ? 'flex' : 'none'}">
        <div class="cfg-field-group">
          <span class="cfg-field-label">First Pay Date</span>
          <input type="date" class="cfg-date-input" data-field="pay_date_start"
                 value="${inc.pay_date_start || ''}">
        </div>
      </div>
    </div>
  `;

  // Type toggle
  card.querySelectorAll('.type-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelectorAll('.type-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const t = btn.dataset.type;
      card.querySelector('.cfg-monthly-fields').style.display = t === 'monthly'       ? 'flex' : 'none';
      card.querySelector('.cfg-4w-fields').style.display      = t === 'every_4_weeks' ? 'flex' : 'none';
      saveIncomeCard(card);
    });
  });

  // Blur autosave + Escape-to-revert on text/number/date fields
  card.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('focus',   () => { el.dataset.original = el.value; });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { el.value = el.dataset.original ?? el.value; el.blur(); }
      if (e.key === 'Enter' && el.tagName !== 'SELECT') el.blur();
    });
    el.addEventListener('blur', () => saveIncomeCard(card));
  });

  card.querySelector('.cfg-delete-btn').addEventListener('click', () =>
    deleteIncomeCard(inc.id, inc.name)
  );

  return card;
}

function saveIncomeCard(card) {
  const id        = card.dataset.id;
  const nameInput = card.querySelector('[data-field="name"]');
  const nameVal   = nameInput.value.trim();
  if (!nameVal) {
    showFieldError(nameInput, 'Name is required');
    return;
  }
  clearFieldError(nameInput);

  const activeBtn = card.querySelector('.type-toggle-btn.active');
  const type      = activeBtn ? activeBtn.dataset.type : 'monthly';

  const payload = {
    name:       nameVal,
    amount:     parseFloat(card.querySelector('[data-field="amount"]').value) || 0,
    type,
    recurrence: type
  };

  if (type === 'monthly') {
    payload.pay_date = Math.min(28, Math.max(1,
      parseInt(card.querySelector('[data-field="pay_date"]')?.value) || 1
    ));
  } else {
    payload.pay_date_start = card.querySelector('[data-field="pay_date_start"]')?.value || '';
  }

  store.updateIncome(id, payload);
}

async function deleteIncomeCard(id, name) {
  if (!confirm(`Delete income source "${name}"?`)) return;
  await store.deleteIncome(id);
  renderIncomeCards();
}

async function addIncomeCard() {
  const inc = await store.addIncome({
    name: 'New Income', amount: 0, type: 'monthly', recurrence: 'monthly', pay_date: 1
  });
  renderIncomeCards();
  const nameInput = document.querySelector(`[data-id="${inc.id}"] .cfg-name-input`);
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}

// ── Configure: Bill cards ──────────────────────────────────────────────────

function renderBillCards() {
  let bills = [...appData.bills];

  if (billSearch) {
    const q = billSearch.toLowerCase();
    bills = bills.filter(b => b.name.toLowerCase().includes(q));
  }

  if (billSort === 'date')   bills.sort((a, b) => a.due_date - b.due_date);
  if (billSort === 'amount') bills.sort((a, b) => b.amount - a.amount);
  if (billSort === 'name')   bills.sort((a, b) => a.name.localeCompare(b.name));

  const total = appData.bills.length;
  document.getElementById('bills-count').textContent =
    billSearch
      ? `${bills.length} of ${total}`
      : `${total} bill${total !== 1 ? 's' : ''}`;

  const container = document.getElementById('bill-cards');
  container.innerHTML = '';

  if (appData.bills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cfg-empty-state';
    empty.innerHTML =
      '<div class="cfg-empty-icon">🧾</div>' +
      '<p class="cfg-empty-title">No bills yet</p>' +
      '<p class="cfg-empty-sub">Add your first recurring bill to start tracking your outgoings</p>';
    container.appendChild(empty);
    return;
  }

  bills.forEach(bill => container.appendChild(buildBillCard(bill)));
}

function buildBillCard(bill) {
  const card      = document.createElement('div');
  card.className  = 'cfg-card';
  card.dataset.id = bill.id;

  const isAllYear = bill.active_months === null;

  const catOptions = BILL_CATEGORIES.map(c =>
    `<option value="${c}" ${bill.category === c ? 'selected' : ''}>${c}</option>`
  ).join('');

  const monthsHtml = MONTH_NAMES.map((m, i) => {
    const val     = i + 1;
    const checked = !isAllYear && bill.active_months?.includes(val) ? 'checked' : '';
    return `<label class="month-pill">
      <input type="checkbox" data-field="month" value="${val}" ${checked}>
      <span>${m}</span>
    </label>`;
  }).join('');

  card.innerHTML = `
    <div class="cfg-card-top">
      <input type="text" class="cfg-name-input" data-field="name"
             value="${esc(bill.name)}" placeholder="Bill name">
      <button class="cfg-delete-btn" title="Delete">&#10005;</button>
    </div>
    <div class="cfg-card-fields">
      <div class="cfg-field-group">
        <span class="cfg-field-label">Amount</span>
        <div class="cfg-amount-wrap">
          <span class="cfg-currency">£</span>
          <input type="number" class="cfg-amount-input" data-field="amount"
                 value="${bill.amount}" step="0.01" min="0" placeholder="0.00">
        </div>
      </div>
      <div class="cfg-field-group">
        <span class="cfg-field-label">Due Day</span>
        <input type="number" class="cfg-day-input" data-field="due_date"
               value="${bill.due_date}" min="1" max="28">
      </div>
      <div class="cfg-field-group">
        <span class="cfg-field-label">Category</span>
        <select class="cfg-select" data-field="category">${catOptions}</select>
      </div>
    </div>
    <div class="cfg-card-schedule">
      <label class="cfg-all-year-label">
        <input type="checkbox" data-field="all_year" ${isAllYear ? 'checked' : ''}>
        <span>All Year</span>
      </label>
      <div class="cfg-months-grid" style="display:${isAllYear ? 'none' : 'flex'}">
        ${monthsHtml}
      </div>
    </div>
  `;

  // All Year toggle — show/hide month pills immediately then save
  card.querySelector('[data-field="all_year"]').addEventListener('change', e => {
    card.querySelector('.cfg-months-grid').style.display = e.target.checked ? 'none' : 'flex';
    saveBillCard(card);
  });

  // Month pill checkboxes
  card.querySelectorAll('[data-field="month"]').forEach(cb =>
    cb.addEventListener('change', () => saveBillCard(card))
  );

  // Category select
  card.querySelector('[data-field="category"]').addEventListener('change', () => saveBillCard(card));

  // Blur autosave + Escape-to-revert on text/number fields
  ['name','amount','due_date'].forEach(field => {
    const el = card.querySelector(`[data-field="${field}"]`);
    el.addEventListener('focus',   () => { el.dataset.original = el.value; });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { el.value = el.dataset.original ?? el.value; el.blur(); }
      if (e.key === 'Enter')  el.blur();
    });
    el.addEventListener('blur', () => saveBillCard(card));
  });

  card.querySelector('.cfg-delete-btn').addEventListener('click', () =>
    deleteBillCard(bill.id, bill.name)
  );

  return card;
}

function saveBillCard(card) {
  const id        = card.dataset.id;
  const nameInput = card.querySelector('[data-field="name"]');
  const nameVal   = nameInput.value.trim();
  if (!nameVal) {
    showFieldError(nameInput, 'Name is required');
    return;
  }
  clearFieldError(nameInput);

  const amountInput = card.querySelector('[data-field="amount"]');
  const amountVal   = parseFloat(amountInput.value);
  if (isNaN(amountVal) || amountVal < 0) {
    showFieldError(amountInput.closest('.cfg-amount-wrap') ?? amountInput, 'Invalid amount');
    return;
  }
  clearFieldError(amountInput.closest('.cfg-amount-wrap') ?? amountInput);

  const allYear = card.querySelector('[data-field="all_year"]').checked;
  let activeMonths = null;
  if (!allYear) {
    const checked = [...card.querySelectorAll('[data-field="month"]:checked')]
      .map(cb => parseInt(cb.value));
    activeMonths = (checked.length === 0 || checked.length === 12) ? null : checked;
  }

  store.updateBill(id, {
    name:          nameVal,
    amount:        amountVal,
    due_date:      Math.min(28, Math.max(1, parseInt(card.querySelector('[data-field="due_date"]').value) || 1)),
    recurrence:    'monthly',
    category:      card.querySelector('[data-field="category"]').value,
    active_months: activeMonths
  });
}

async function deleteBillCard(id, name) {
  if (!confirm(`Delete bill "${name}"?`)) return;
  await store.deleteBill(id);
  renderBillCards();
}

async function addBillCard() {
  const bill = await store.addBill({
    name: 'New Bill', amount: 10, due_date: 1,
    recurrence: 'monthly', category: 'Other', active_months: null
  });
  // Clear search so the new card is visible
  billSearch = '';
  document.getElementById('bills-search').value = '';
  renderBillCards();
  const nameInput = document.querySelector(`[data-id="${bill.id}"] .cfg-name-input`);
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}

// ── Configure: Summary footer ──────────────────────────────────────────────

function renderConfigureSummary() {
  if (!appData) return;
  const totalIn  = appData.income.reduce((t, s) => t + effectiveIncomeAmount(s), 0);
  const totalOut = Object.values(Projection.getCategoryBreakdown(appData.bills))
    .reduce((t, v) => t + v, 0);
  const net = totalIn - totalOut;

  document.getElementById('cfg-total-in').textContent  = fmtGBP(totalIn);
  document.getElementById('cfg-total-out').textContent = fmtGBP(totalOut);

  const netEl = document.getElementById('cfg-net');
  netEl.textContent = fmtGBP(net);
  netEl.className   = 'cfg-footer-val ' + (net >= 0 ? 'positive' : 'negative');
}

// ── Configure: Controls (search + sort + add buttons) ─────────────────────

function initConfigureControls() {
  document.getElementById('bills-search').addEventListener('input', e => {
    billSearch = e.target.value;
    renderBillCards();
  });

  document.getElementById('bills-sort-btns').addEventListener('click', e => {
    const btn = e.target.closest('.sort-btn');
    if (!btn) return;
    document.querySelectorAll('#bills-sort-btns .sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    billSort = btn.dataset.sort;
    renderBillCards();
  });

  document.getElementById('add-bill-btn').addEventListener('click', addBillCard);
  document.getElementById('add-income-btn').addEventListener('click', addIncomeCard);
}

// ── Modal helpers (kept for potential future use) ──────────────────────────

function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML    = bodyHtml;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  }, { once: true });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ── Utilities ──────────────────────────────────────────────────────────────

function fmtGBP(n) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

function formatDate(isoStr) {
  return new Date(isoStr + 'T00:00:00')
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysLabel(days) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `in ${days} days`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  return ['th','st','nd','rd'][n % 4] || 'th';
}

// ── Count-up animation ─────────────────────────────────────────────────────

const _prevCardValues = new Map();

function animateCardValue(el, to, formatter) {
  const from = _prevCardValues.has(el) ? _prevCardValues.get(el) : to;
  _prevCardValues.set(el, to);

  if (from === to) { el.textContent = formatter(to); return; }

  const duration = 420;
  const start    = performance.now();

  (function step(now) {
    const t      = Math.min((now - start) / duration, 1);
    const eased  = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
    el.textContent = formatter(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  })(start);
}

// ── Field error helpers ────────────────────────────────────────────────────

function showFieldError(el, msg) {
  clearFieldError(el);
  el.classList.add('field-error');
  const err = document.createElement('span');
  err.className   = 'field-error-msg';
  err.textContent = msg;
  // Insert after the field's nearest meaningful parent group
  const parent = el.closest('.cfg-card-top, .cfg-field-group') ?? el.parentNode;
  parent.after(err);
}

function clearFieldError(el) {
  el.classList.remove('field-error');
  const parent = el.closest('.cfg-card-top, .cfg-field-group') ?? el.parentNode;
  parent.nextElementSibling?.classList.contains('field-error-msg') &&
    parent.nextElementSibling.remove();
}

// ── App-level toast (for errors outside StorageManager) ────────────────────

function showToast(msg, variant = 'toast-error', duration = 4000) {
  const el = document.createElement('div');
  el.className   = `toast ${variant}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-visible')));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}

// ── ICS Calendar Export ────────────────────────────────────────────────────

function exportHolidaysICS(holidays) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Financial Viability Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ];

  for (const h of holidays) {
    // ICS all-day dates use YYYYMMDD format; DTEND is the day after
    const start  = h.date.replace(/-/g, '');
    const d      = new Date(h.date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    const end    = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const uid    = `holiday-${h.date}-${h.sourceName.toLowerCase().replace(/\s+/g,'-')}@fvp`;
    const stamp  = new Date().toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:\uD83C\uDFD6 ${h.sourceName} Payment Holiday`,
      `DESCRIPTION:${fmtGBP(h.amount)} not needed today`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'payment-holidays.ics';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Live date in top bar ───────────────────────────────────────────────────

function renderTopBarDate() {
  const el = document.getElementById('top-bar-date');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  // Schedule the next update at the next midnight
  const now  = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => { renderTopBarDate(); }, msUntilMidnight);
}

renderTopBarDate();

// ── Start ──────────────────────────────────────────────────────────────────
init();
