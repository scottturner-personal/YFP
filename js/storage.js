// storage.js — StorageManager: localStorage-backed state with reactive listeners

const STORAGE_KEY = 'fvp.data.v2';

const SEED_DATA = {
  current_balance: 1829,
  balance_as_of: '2026-07-15',
  bills: [
    { id: 'bill-001', name: 'Mortgage',       amount: 1570.80, due_date: 1,  recurrence: 'monthly', category: 'Housing',       active_months: null },
    { id: 'bill-002', name: 'TV License',     amount: 14.95,   due_date: 8,  recurrence: 'monthly', category: 'Subscriptions', active_months: null },
    { id: 'bill-003', name: 'Water',          amount: 75,      due_date: 8,  recurrence: 'monthly', category: 'Utilities',     active_months: null },
    { id: 'bill-004', name: 'Gas & Electric', amount: 250,     due_date: 27, recurrence: 'monthly', category: 'Utilities',     active_months: null },
    { id: 'bill-005', name: 'O2 Sim',         amount: 5,       due_date: 5,  recurrence: 'monthly', category: 'Subscriptions', active_months: null },
    { id: 'bill-006', name: 'Virgin Media',   amount: 111,     due_date: 1,  recurrence: 'monthly', category: 'Utilities',     active_months: null },
    { id: 'bill-007', name: 'Pet Insurance',  amount: 104,     due_date: 16, recurrence: 'monthly', category: 'Insurance',     active_months: null },
    { id: 'bill-008', name: 'Home Insurance', amount: 23.2,    due_date: 28, recurrence: 'monthly', category: 'Insurance',     active_months: null },
    { id: 'bill-009', name: 'Council Tax',    amount: 321,     due_date: 15, recurrence: 'monthly', category: 'Housing',       active_months: [1,4,5,6,7,8,9,10,11,12] },
    { id: 'bill-010', name: 'Life Insurance', amount: 34.36,   due_date: 16, recurrence: 'monthly', category: 'Insurance',     active_months: null },
    { id: 'bill-012', name: 'Income Protection', amount: 40,   due_date: 1,  recurrence: 'monthly', category: 'Insurance',     active_months: null }
  ],
  income: [
    { id: 'income-001', name: 'Scott', amount: 1370, pay_date: 23,                  recurrence: 'monthly',       type: 'monthly',       amount_overrides: {} },
    { id: 'income-002', name: 'Jess',  amount: 900,  pay_date_start: '2026-03-27',  recurrence: 'every_4_weeks', type: 'every_4_weeks', skipped_dates: ['2026-12-04','2027-12-03','2028-11-03'] },
    { id: 'income-003', name: 'Kevin', amount: 200,  pay_date: 3,                   recurrence: 'monthly',       type: 'monthly',       amount_overrides: {} }
  ]
};

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function newId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class StorageManager {
  #state     = { current_balance: 0, bills: [], income: [] };
  #listeners = [];
  #saveTimer = null;
  #DEBOUNCE  = 300; // ms

  // ── Persistence ─────────────────────────────────────────────────────────

  #load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error('Could not parse stored data:', e);
    }
    return JSON.parse(JSON.stringify(SEED_DATA));
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#state));
    } catch (e) {
      this.#toast(`Save failed: ${e.message}`);
    }
  }

  // ── Initialisation ──────────────────────────────────────────────────────

  async init() {
    this.#state = this.#load();
    this.#maybeAdvanceBalance();
    return this.getState();
  }

  // If balance_as_of < today, simulate the missing days and advance the balance.
  #maybeAdvanceBalance() {
    if (typeof Projection === 'undefined') return;
    const today = todayDateStr();
    const asOf  = this.#state.balance_as_of;
    if (!asOf || asOf >= today) return;

    const fromDate = new Date(asOf + 'T00:00:00');
    fromDate.setDate(fromDate.getDate() + 1);
    const toDate = new Date(today + 'T00:00:00');
    const days   = Math.round((toDate - fromDate) / 86_400_000) + 1;
    if (days <= 0) return;

    const proj = Projection.generateDailyProjection(
      this.#state.current_balance, this.#state.bills, this.#state.income, days, fromDate
    );
    const netChange = proj.reduce((sum, d) => sum + d.totalIncome - d.totalDeducted, 0);
    this.#state.current_balance = Math.round((this.#state.current_balance + netChange) * 100) / 100;
    this.#state.balance_as_of   = today;
    this.#persist();
    console.log(`Balance auto-advanced from ${asOf} to ${today} (net change: £${netChange.toFixed(2)})`);
  }

  // ── State access ────────────────────────────────────────────────────────

  getState() {
    return JSON.parse(JSON.stringify(this.#state));
  }

  getBalance() { return this.#state.current_balance; }
  getBills()   { return JSON.parse(JSON.stringify(this.#state.bills)); }
  getIncome()  { return JSON.parse(JSON.stringify(this.#state.income)); }

  // ── Change listeners ────────────────────────────────────────────────────

  onDataChange(cb) {
    this.#listeners.push(cb);
  }

  #notify() {
    for (const cb of this.#listeners) cb();
  }

  // ── Debounced balance save ──────────────────────────────────────────────

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#persist();
      this.#notify();
    }, this.#DEBOUNCE);
  }

  // ── Balance ─────────────────────────────────────────────────────────────

  setBalance(amount) {
    const parsed = parseFloat(amount);
    if (isNaN(parsed)) return;
    this.#state.current_balance = parsed;
    this.#state.balance_as_of   = todayDateStr();
    this.#scheduleSave();
  }

  // ── Bills ───────────────────────────────────────────────────────────────

  async addBill(bill) {
    const created = {
      id:            newId('bill'),
      name:          bill.name,
      amount:        parseFloat(bill.amount),
      due_date:      parseInt(bill.due_date, 10),
      recurrence:    bill.recurrence    || 'monthly',
      category:      bill.category      || 'General',
      active_months: bill.active_months || null
    };
    this.#state.bills.push(created);
    this.#persist();
    this.#notify();
    this.#toastSuccess('Bill added');
    return created;
  }

  async updateBill(id, updates) {
    const idx = this.#state.bills.findIndex(b => b.id === id);
    if (idx === -1) { this.#toast('Bill not found'); throw new Error('Bill not found'); }

    const bill = this.#state.bills[idx];
    if (updates.name          !== undefined) bill.name          = updates.name;
    if (updates.amount        !== undefined) bill.amount        = parseFloat(updates.amount);
    if (updates.due_date      !== undefined) bill.due_date      = parseInt(updates.due_date, 10);
    if (updates.recurrence    !== undefined) bill.recurrence    = updates.recurrence;
    if (updates.category      !== undefined) bill.category      = updates.category;
    if (updates.active_months !== undefined) bill.active_months = updates.active_months;
    if (updates.end_date      !== undefined) bill.end_date      = updates.end_date;

    this.#persist();
    this.#notify();
    return bill;
  }

  async deleteBill(id) {
    const before = this.#state.bills.length;
    this.#state.bills = this.#state.bills.filter(b => b.id !== id);
    if (this.#state.bills.length === before) { this.#toast('Bill not found'); throw new Error('Bill not found'); }
    this.#persist();
    this.#notify();
    this.#toastSuccess('Bill deleted');
  }

  // ── Income ──────────────────────────────────────────────────────────────

  async addIncome(source) {
    const { name, amount, type, pay_date, pay_date_start, recurrence } = source;
    const created = {
      id:         newId('income'),
      name,
      amount:     parseFloat(amount),
      recurrence: recurrence || type,
      type
    };
    if (type === 'monthly')       created.pay_date       = parseInt(pay_date, 10);
    if (type === 'every_4_weeks') created.pay_date_start = pay_date_start;

    if (!this.#state.income) this.#state.income = [];
    this.#state.income.push(created);
    this.#persist();
    this.#notify();
    this.#toastSuccess('Income source added');
    return created;
  }

  async updateIncome(id, updates) {
    if (!this.#state.income) this.#state.income = [];
    const idx = this.#state.income.findIndex(s => s.id === id);
    if (idx === -1) { this.#toast('Income source not found'); throw new Error('Income source not found'); }

    const source = this.#state.income[idx];
    if (updates.name              !== undefined) source.name              = updates.name;
    if (updates.amount            !== undefined) source.amount            = parseFloat(updates.amount);
    if (updates.type              !== undefined) source.type              = updates.type;
    if (updates.recurrence        !== undefined) source.recurrence        = updates.recurrence;
    if (updates.pay_date          !== undefined) source.pay_date          = parseInt(updates.pay_date, 10);
    if (updates.pay_date_start    !== undefined) source.pay_date_start    = updates.pay_date_start;
    if (updates.skipped_dates     !== undefined) source.skipped_dates     = updates.skipped_dates;
    if (updates.amount_overrides  !== undefined) source.amount_overrides  = updates.amount_overrides;

    this.#persist();
    this.#notify();
    return source;
  }

  async deleteIncome(id) {
    if (!this.#state.income) this.#state.income = [];
    const before = this.#state.income.length;
    this.#state.income = this.#state.income.filter(s => s.id !== id);
    if (this.#state.income.length === before) { this.#toast('Income source not found'); throw new Error('Income source not found'); }
    this.#persist();
    this.#notify();
    this.#toastSuccess('Income source deleted');
  }

  // ── Toast ───────────────────────────────────────────────────────────────

  #toastSuccess(msg) { this.#showToast(msg, 'toast-success'); }
  #toast(msg)        { this.#showToast(msg, 'toast-error'); }

  #showToast(msg, variant) {
    const el = document.createElement('div');
    el.className = `toast ${variant}`;
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-visible')));
    const duration = variant === 'toast-success' ? 2200 : 4000;
    setTimeout(() => {
      el.classList.remove('toast-visible');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, duration);
  }
}

const store = new StorageManager();
