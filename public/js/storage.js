// storage.js — StorageManager: in-memory state + autosave + reactive listeners

class StorageManager {
  #state     = { current_balance: 0, bills: [], income: [] };
  #listeners = [];
  #saveTimer = null;
  #DEBOUNCE  = 300; // ms

  // ── HTTP ────────────────────────────────────────────────────────────────

  async #req(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
    if (res.status === 204) return null;
    return res.json();
  }

  // ── Initialisation ──────────────────────────────────────────────────────

  async init() {
    this.#state = await this.#req('GET', '/api/data');
    return this.getState();
  }

  // ── State access ────────────────────────────────────────────────────────

  // Returns a deep copy so callers can't accidentally mutate internal state.
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
  // Balance is the only field typed continuously, so we debounce both
  // the server write and the UI notification to avoid thrash on every keystroke.

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#flushBalance(), this.#DEBOUNCE);
  }

  async #flushBalance() {
    try {
      await this.#req('PUT', '/api/data', this.#state);
      this.#notify();
    } catch (err) {
      this.#toast(`Save failed: ${err.message}`);
    }
  }

  // ── Balance ─────────────────────────────────────────────────────────────

  setBalance(amount) {
    const parsed = parseFloat(amount);
    if (isNaN(parsed)) return;
    this.#state.current_balance = parsed;
    // Reset the as-of date so auto-advance doesn't re-apply past bills
    const d = new Date();
    this.#state.balance_as_of = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    this.#scheduleSave();
  }

  // ── Bills ───────────────────────────────────────────────────────────────

  async addBill(bill) {
    try {
      const created = await this.#req('POST', '/api/bills', bill);
      this.#state.bills.push(created);
      this.#notify();
      this.#toastSuccess('Bill added');
      return created;
    } catch (err) {
      this.#toast(`Could not add bill: ${err.message}`);
      throw err;
    }
  }

  async updateBill(id, updates) {
    try {
      const updated = await this.#req('PUT', `/api/bills/${id}`, updates);
      const idx = this.#state.bills.findIndex(b => b.id === id);
      if (idx !== -1) this.#state.bills[idx] = updated;
      this.#notify();
      return updated;
    } catch (err) {
      this.#toast(`Could not update bill: ${err.message}`);
      throw err;
    }
  }

  async deleteBill(id) {
    try {
      await this.#req('DELETE', `/api/bills/${id}`);
      this.#state.bills = this.#state.bills.filter(b => b.id !== id);
      this.#notify();
      this.#toastSuccess('Bill deleted');
    } catch (err) {
      this.#toast(`Could not delete bill: ${err.message}`);
      throw err;
    }
  }

  // ── Income ──────────────────────────────────────────────────────────────

  async addIncome(source) {
    try {
      const created = await this.#req('POST', '/api/income', source);
      this.#state.income.push(created);
      this.#notify();
      this.#toastSuccess('Income source added');
      return created;
    } catch (err) {
      this.#toast(`Could not add income: ${err.message}`);
      throw err;
    }
  }

  async updateIncome(id, updates) {
    try {
      const updated = await this.#req('PUT', `/api/income/${id}`, updates);
      const idx = this.#state.income.findIndex(s => s.id === id);
      if (idx !== -1) this.#state.income[idx] = updated;
      this.#notify();
      return updated;
    } catch (err) {
      this.#toast(`Could not update income: ${err.message}`);
      throw err;
    }
  }

  async deleteIncome(id) {
    try {
      await this.#req('DELETE', `/api/income/${id}`);
      this.#state.income = this.#state.income.filter(s => s.id !== id);
      this.#notify();
      this.#toastSuccess('Income source deleted');
    } catch (err) {
      this.#toast(`Could not delete income: ${err.message}`);
      throw err;
    }
  }

  // ── Toast ───────────────────────────────────────────────────────────────

  #toastSuccess(msg) {
    this.#showToast(msg, 'toast-success');
  }

  #toast(msg) {
    this.#showToast(msg, 'toast-error');
  }

  #showToast(msg, variant) {
    const el = document.createElement('div');
    el.className = `toast ${variant}`;
    el.textContent = msg;
    document.body.appendChild(el);
    // Two-frame delay gives the browser time to paint before animating in
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-visible')));
    const duration = variant === 'toast-success' ? 2200 : 4000;
    setTimeout(() => {
      el.classList.remove('toast-visible');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, duration);
  }
}

// Singleton — imported scripts reference `store` directly.
const store = new StorageManager();
