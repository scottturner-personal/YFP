const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Load projection engine (used for auto-advancing the balance each day)
let Projection = null;
try {
  const projCode = fs.readFileSync(path.join(__dirname, 'public/js/projection.js'), 'utf8');
  Projection = new Function(projCode + '; return Projection;')();
} catch (e) {
  console.error('Could not load projection engine:', e.message);
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// If balance_as_of < today, simulate the missing days and advance the balance.
// Modifies data in-place and saves if changed.
function maybeAdvanceBalance(data) {
  if (!Projection) return;
  const today = todayDateStr();
  const asOf  = data.balance_as_of;
  if (!asOf || asOf >= today) return;

  const fromDate = new Date(asOf + 'T00:00:00');
  fromDate.setDate(fromDate.getDate() + 1); // day after last-known date
  const toDate   = new Date(today + 'T00:00:00');
  const days     = Math.round((toDate - fromDate) / 86_400_000) + 1;
  if (days <= 0) return;

  const proj = Projection.generateDailyProjection(
    data.current_balance, data.bills, data.income, days, fromDate
  );
  const netChange = proj.reduce((sum, d) => sum + d.totalIncome - d.totalDeducted, 0);
  data.current_balance = Math.round((data.current_balance + netChange) * 100) / 100;
  data.balance_as_of   = today;
  writeData(data);
  console.log(`Balance auto-advanced from ${asOf} to ${today} (net change: £${netChange.toFixed(2)})`);
}

const app = express();
const PORT      = process.env.PORT      || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const DEFAULTS = {
  current_balance: 1471,
  balance_as_of: todayDateStr(),
  bills: [
    { id: 'bill-001', name: 'Mortgage',     amount: 1009.12, due_date: 1,  recurrence: 'monthly', category: 'Housing',       active_months: null },
    { id: 'bill-002', name: 'TV License',   amount: 14.95,   due_date: 8,  recurrence: 'monthly', category: 'Subscriptions', active_months: null },
    { id: 'bill-003', name: 'Water',        amount: 75,      due_date: 8,  recurrence: 'monthly', category: 'Utilities',     active_months: null },
    { id: 'bill-004', name: 'Gas & Electric', amount: 250,   due_date: 27, recurrence: 'monthly', category: 'Utilities',     active_months: null },
    { id: 'bill-005', name: 'O2 Sim',       amount: 5,       due_date: 5,  recurrence: 'monthly', category: 'Subscriptions', active_months: null },
    { id: 'bill-006', name: 'Virgin Media', amount: 97,      due_date: 1,  recurrence: 'monthly', category: 'Utilities',     active_months: null },
    { id: 'bill-007', name: 'Pet Insurance', amount: 104,    due_date: 16, recurrence: 'monthly', category: 'Insurance',     active_months: null },
    { id: 'bill-008', name: 'Home Insurance', amount: 30,    due_date: 28, recurrence: 'monthly', category: 'Insurance',     active_months: null },
    { id: 'bill-009', name: 'Council Tax',  amount: 321,     due_date: 15, recurrence: 'monthly', category: 'Housing',       active_months: [4,5,6,7,8,9,10,11,12,1] },
    { id: 'bill-010', name: 'Life Insurance', amount: 34.36, due_date: 16, recurrence: 'monthly', category: 'Insurance',     active_months: null },
    { id: 'bill-011', name: 'Selina Loan',  amount: 228.97,  due_date: 15, recurrence: 'monthly', category: 'Housing',       active_months: null }
  ],
  income: [
    { id: 'income-001', name: 'Scott', amount: 1270.00, pay_date: 23,                            recurrence: 'monthly',      type: 'monthly'      },
    { id: 'income-002', name: 'Jess',  amount: 900.00,  pay_date_start: '2026-03-27',            recurrence: 'every_4_weeks', type: 'every_4_weeks', skipped_dates: ['2026-03-27'] }
  ]
};

// Ensure data.json exists on startup
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULTS, null, 2));
  console.log('Created data.json with seed data.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---
function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Data ────────────────────────────────────────────────────────────────────

// GET /api/data
app.get('/api/data', (_req, res) => {
  const data = readData();
  maybeAdvanceBalance(data);
  res.json(data);
});

// PUT /api/data
app.put('/api/data', (req, res) => {
  const { current_balance, bills, income, balance_as_of } = req.body;
  if (current_balance === undefined) {
    return res.status(400).json({ error: 'current_balance is required' });
  }
  const data = readData();
  data.current_balance = parseFloat(current_balance);
  if (bills          !== undefined) data.bills          = bills;
  if (income         !== undefined) data.income         = income;
  if (balance_as_of  !== undefined) data.balance_as_of  = balance_as_of;
  writeData(data);
  res.json(data);
});

// ─── Bills ────────────────────────────────────────────────────────────────────

// POST /api/bills
app.post('/api/bills', (req, res) => {
  const { name, amount, due_date, recurrence, category, active_months } = req.body;
  if (!name || amount === undefined || !due_date) {
    return res.status(400).json({ error: 'name, amount, and due_date are required' });
  }
  const bill = {
    id:            uuidv4(),
    name,
    amount:        parseFloat(amount),
    due_date:      parseInt(due_date, 10),
    recurrence:    recurrence    || 'monthly',
    category:      category      || 'General',
    active_months: active_months || null
  };
  const data = readData();
  data.bills.push(bill);
  writeData(data);
  res.status(201).json(bill);
});

// PUT /api/bills/:id
app.put('/api/bills/:id', (req, res) => {
  const data = readData();
  const idx = data.bills.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bill not found' });

  const { name, amount, due_date, recurrence, category, active_months } = req.body;
  const bill = data.bills[idx];
  if (name          !== undefined) bill.name          = name;
  if (amount        !== undefined) bill.amount        = parseFloat(amount);
  if (due_date      !== undefined) bill.due_date      = parseInt(due_date, 10);
  if (recurrence    !== undefined) bill.recurrence    = recurrence;
  if (category      !== undefined) bill.category      = category;
  if (active_months !== undefined) bill.active_months = active_months;

  writeData(data);
  res.json(bill);
});

// DELETE /api/bills/:id
app.delete('/api/bills/:id', (req, res) => {
  const data = readData();
  const before = data.bills.length;
  data.bills = data.bills.filter(b => b.id !== req.params.id);
  if (data.bills.length === before) {
    return res.status(404).json({ error: 'Bill not found' });
  }
  writeData(data);
  res.json({ ok: true });
});

// ─── Income ───────────────────────────────────────────────────────────────────

// POST /api/income
app.post('/api/income', (req, res) => {
  const { name, amount, type, pay_date, pay_date_start, recurrence } = req.body;
  if (!name || amount === undefined || !type) {
    return res.status(400).json({ error: 'name, amount, and type are required' });
  }
  const source = {
    id:   uuidv4(),
    name,
    amount:     parseFloat(amount),
    recurrence: recurrence || type,
    type
  };
  if (type === 'monthly')       source.pay_date       = parseInt(pay_date, 10);
  if (type === 'every_4_weeks') source.pay_date_start = pay_date_start;

  const data = readData();
  if (!data.income) data.income = [];
  data.income.push(source);
  writeData(data);
  res.status(201).json(source);
});

// PUT /api/income/:id
app.put('/api/income/:id', (req, res) => {
  const data = readData();
  if (!data.income) data.income = [];
  const idx = data.income.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Income source not found' });

  const { name, amount, type, pay_date, pay_date_start, recurrence, skipped_dates } = req.body;
  const source = data.income[idx];
  if (name           !== undefined) source.name           = name;
  if (amount         !== undefined) source.amount         = parseFloat(amount);
  if (type           !== undefined) source.type           = type;
  if (recurrence     !== undefined) source.recurrence     = recurrence;
  if (pay_date       !== undefined) source.pay_date       = parseInt(pay_date, 10);
  if (pay_date_start !== undefined) source.pay_date_start = pay_date_start;
  if (skipped_dates  !== undefined) source.skipped_dates  = skipped_dates;

  writeData(data);
  res.json(source);
});

// DELETE /api/income/:id
app.delete('/api/income/:id', (req, res) => {
  const data = readData();
  if (!data.income) data.income = [];
  const before = data.income.length;
  data.income = data.income.filter(s => s.id !== req.params.id);
  if (data.income.length === before) {
    return res.status(404).json({ error: 'Income source not found' });
  }
  writeData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Financial Viability Planner running at http://localhost:${PORT}`);
});
