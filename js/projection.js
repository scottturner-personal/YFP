// projection.js — financial projection engine

const Projection = (() => {

  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // UK bank holidays (England & Wales) 2025–2028
  const UK_BANK_HOLIDAYS = new Set([
    '2025-01-01','2025-04-18','2025-04-21','2025-05-05','2025-05-26',
    '2025-08-25','2025-12-25','2025-12-26',
    '2026-01-01','2026-04-03','2026-04-06','2026-05-04','2026-05-25',
    '2026-08-31','2026-12-25','2026-12-28',
    '2027-01-01','2027-03-26','2027-03-29','2027-05-03','2027-05-31',
    '2027-08-30','2027-12-27','2027-12-28',
    '2028-01-03','2028-04-14','2028-04-17','2028-05-06','2028-05-27',
    '2028-08-26','2028-12-25','2028-12-26'
  ]);

  // ── Working day helpers ────────────────────────────────────────────────────

  function isWorkingDay(date) {
    const day = date.getDay();
    if (day === 0 || day === 6) return false;
    return !UK_BANK_HOLIDAYS.has(toDateStr(date));
  }

  // Returns the given date if it's a working day, otherwise advances to the next one.
  function nextWorkingDay(date) {
    const d = new Date(date.getTime());
    while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
    return d;
  }

  // ── Internal date helpers ──────────────────────────────────────────────────

  // Return a Date set to midnight local time today
  function todayMidnight() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Zero-padded YYYY-MM-DD string from a Date
  function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Number of days in a month. year: full year, month0: 0-indexed month.
  function daysInMonth(year, month0) {
    return new Date(year, month0 + 1, 0).getDate();
  }

  // Clamp a bill/pay due-day to the actual last day of the month.
  // e.g. due_date=31 in April (30 days) → 30.
  function effectiveDay(dueDay, year, month0) {
    return Math.min(dueDay, daysInMonth(year, month0));
  }

  // ── Bill helpers ───────────────────────────────────────────────────────────

  // True when the bill should be charged in the given 1-indexed month number.
  function isBillActiveInMonth(bill, monthNum1) {
    return bill.active_months === null || bill.active_months.includes(monthNum1);
  }

  // Returns the next Date (>= fromDate) when a bill fires, or null.
  // Walks forward month by month, skipping months excluded by active_months.
  function nextBillFireDate(bill, fromDate) {
    for (let m = 0; m <= 13; m++) {
      // Advance m calendar months from the start of fromDate's month
      const base   = new Date(fromDate.getFullYear(), fromDate.getMonth() + m, 1);
      const yr     = base.getFullYear();
      const mo0    = base.getMonth();
      const moNum  = mo0 + 1;

      if (!isBillActiveInMonth(bill, moNum)) continue;

      const fireDay  = effectiveDay(bill.due_date, yr, mo0);
      const fireDate = nextWorkingDay(new Date(yr, mo0, fireDay));

      if (fireDate >= fromDate) return fireDate;
    }
    return null;
  }

  // ── Income helpers ─────────────────────────────────────────────────────────

  // Returns the effective income amount for a source on a given date.
  // Checks source.amount_overrides (keyed by "YYYY-MM") for one-off adjustments.
  function getEffectiveAmount(source, date) {
    if (source.amount_overrides) {
      const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
      if (key in source.amount_overrides) return source.amount_overrides[key];
    }
    return source.amount;
  }

  // Returns the next Date (>= fromDate) when an income source pays, or null.
  function nextIncomePayDate(source, fromDate) {
    if (source.type === 'monthly') {
      // Try this month then next; pick the first that lands >= fromDate
      for (let m = 0; m <= 1; m++) {
        const base   = new Date(fromDate.getFullYear(), fromDate.getMonth() + m, 1);
        const yr     = base.getFullYear();
        const mo0    = base.getMonth();
        const payDay = effectiveDay(source.pay_date, yr, mo0);
        const pd     = new Date(yr, mo0, payDay);
        if (pd >= fromDate) return pd;
      }
    } else if (source.type === 'every_4_weeks') {
      // Advance in 28-day steps from the anchor date until we reach fromDate
      let d = new Date(source.pay_date_start + 'T00:00:00');
      while (d < fromDate) d.setDate(d.getDate() + 28);
      return new Date(d);
    }
    return null;
  }

  // ── Main projection ────────────────────────────────────────────────────────

  /**
   * generateDailyProjection(currentBalance, bills, income, daysToProject = 1095)
   *
   * Walks day-by-day from today for `daysToProject` days.
   * On each day:
   *   1. Credits all income due that day (monthly pay_date match; or exact 28-day
   *      multiple from every_4_weeks pay_date_start).
   *   2. Deducts all bills due that day (respects active_months + month-end clamping).
   *
   * Returns one entry per day:
   *   {
   *     date:            "YYYY-MM-DD",
   *     dayOfWeek:       "Monday",
   *     startingBalance: number,
   *     incomeReceived:  [{ name, amount, incomeId }],
   *     deductions:      [{ billName, amount, billId }],
   *     endingBalance:   number,
   *     isNegative:      boolean,
   *     isWarning:       boolean,   // balance >= 0 but < 500
   *     totalIncome:     number,
   *     totalDeducted:   number
   *   }
   */
  function generateDailyProjection(currentBalance, bills, income, daysToProject = 1095, startDate = null) {
    const start  = startDate ?? todayMidnight();
    const result = [];
    let balance  = currentBalance;

    // Precompute working-day-adjusted bill fire dates for the entire window.
    // Map: "YYYY-MM-DD" → [bill, ...]. Handles weekend/bank-holiday roll-forward,
    // including rolls that cross a month boundary (e.g. Dec 31 Sun → Jan 2 Mon).
    const billFireMap = new Map();
    {
      const endDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + daysToProject + 3);
      let yr = start.getFullYear(), mo0 = start.getMonth();
      while (new Date(yr, mo0, 1) <= endDate) {
        const moNum = mo0 + 1;
        for (const bill of bills) {
          if (!isBillActiveInMonth(bill, moNum)) continue;
          const nomDay   = effectiveDay(bill.due_date, yr, mo0);
          const fireDate = nextWorkingDay(new Date(yr, mo0, nomDay));
          const key      = toDateStr(fireDate);
          if (!billFireMap.has(key)) billFireMap.set(key, []);
          billFireMap.get(key).push(bill);
        }
        if (++mo0 > 11) { mo0 = 0; yr++; }
      }
    }

    for (let i = 0; i < daysToProject; i++) {
      // Build each date from the start rather than incrementing in-place to
      // avoid any accumulated floating-point error with setDate.
      const date  = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const yr    = date.getFullYear();
      const mo0   = date.getMonth();
      const dom   = date.getDate();

      const startingBalance = balance;

      // ── 1. Income ────────────────────────────────────────────────────────
      const incomeReceived  = [];
      const skippedPayments = []; // scheduled but in source.skipped_dates

      for (const source of income) {
        let isPaid = false;

        if (source.type === 'monthly') {
          isPaid = dom === effectiveDay(source.pay_date, yr, mo0);

        } else if (source.type === 'every_4_weeks') {
          const origin   = new Date(source.pay_date_start + 'T00:00:00');
          // Use Math.round to absorb the ±1 h caused by DST transitions
          const diffDays = Math.round((date.getTime() - origin.getTime()) / 86_400_000);
          isPaid = diffDays >= 0 && diffDays % 28 === 0;
        }

        // Respect manually-skipped dates
        if (isPaid && source.skipped_dates && source.skipped_dates.includes(toDateStr(date))) {
          skippedPayments.push({ name: source.name, amount: source.amount, incomeId: source.id });
          isPaid = false;
        }

        if (isPaid) {
          const amt = getEffectiveAmount(source, date);
          balance += amt;
          incomeReceived.push({ name: source.name, amount: amt, incomeId: source.id });
        }
      }

      // ── 2. Bills ──────────────────────────────────────────────────────────
      const deductions = [];
      const billsToday = billFireMap.get(toDateStr(date)) ?? [];

      for (const bill of billsToday) {
        balance -= bill.amount;
        deductions.push({ billName: bill.name, amount: bill.amount, billId: bill.id });
      }

      // Round to pence to prevent floating-point drift
      const endingBalance = Math.round(balance * 100) / 100;
      balance = endingBalance;

      result.push({
        date:            toDateStr(date),
        dayOfWeek:       DAY_NAMES[date.getDay()],
        startingBalance: Math.round(startingBalance * 100) / 100,
        incomeReceived,
        skippedPayments,
        deductions,
        endingBalance,
        isNegative:      endingBalance < 0,
        isWarning:       endingBalance >= 0 && endingBalance < 500,
        totalIncome:     Math.round(incomeReceived.reduce((s, r) => s + r.amount, 0) * 100) / 100,
        totalDeducted:   Math.round(deductions.reduce((s, d) => s + d.amount, 0) * 100) / 100
      });
    }

    return result;
  }

  // ── Exported helpers ───────────────────────────────────────────────────────

  /**
   * getNextBill(bills)
   *
   * Returns the soonest upcoming bill from today, respecting active_months.
   * Result: { bill, date: "YYYY-MM-DD", daysUntil: number } or null.
   */
  function getNextBill(bills) {
    if (!bills || bills.length === 0) return null;
    const from = todayMidnight();

    let nearest = null;
    let nearestDate = null;

    for (const bill of bills) {
      const fd = nextBillFireDate(bill, from);
      if (!fd) continue;
      if (!nearestDate || fd < nearestDate) { nearestDate = fd; nearest = bill; }
    }

    if (!nearest) return null;
    return {
      bill:      nearest,
      date:      toDateStr(nearestDate),
      daysUntil: Math.round((nearestDate - from) / 86_400_000)
    };
  }

  /**
   * getDaysUntilNextBill(bills)
   *
   * Returns the number of days until the next bill fires, or null.
   */
  function getDaysUntilNextBill(bills) {
    const next = getNextBill(bills);
    return next ? next.daysUntil : null;
  }

  /**
   * getNextPayDay(income)
   *
   * Returns the soonest upcoming pay event across all income sources.
   * Result: { source, date: "YYYY-MM-DD", daysUntil: number } or null.
   */
  function getNextPayDay(income) {
    if (!income || income.length === 0) return null;
    const from = todayMidnight();

    let nearest = null;
    let nearestDate = null;

    for (const source of income) {
      const pd = nextIncomePayDate(source, from);
      if (!pd) continue;
      if (!nearestDate || pd < nearestDate) { nearestDate = pd; nearest = source; }
    }

    if (!nearest) return null;
    return {
      source:    nearest,
      date:      toDateStr(nearestDate),
      daysUntil: Math.round((nearestDate - from) / 86_400_000)
    };
  }

  /**
   * getFirstNegativeDate(projection)
   *
   * Scans a projection array and returns the "YYYY-MM-DD" of the first day
   * where endingBalance < 0, or null if the balance never goes negative.
   */
  function getFirstNegativeDate(projection) {
    const entry = projection.find(e => e.isNegative);
    return entry ? entry.date : null;
  }

  /**
   * getCategoryBreakdown(bills)
   *
   * Returns { category: averageMonthlyAmount } across all bills.
   * Seasonal bills are pro-rated by their number of active months / 12,
   * e.g. Council Tax (10 active months) contributes amount × 10/12.
   */
  function getCategoryBreakdown(bills) {
    return bills.reduce((acc, bill) => {
      const cat    = bill.category || 'Other';
      const factor = bill.active_months === null ? 1 : bill.active_months.length / 12;
      acc[cat] = (acc[cat] || 0) + bill.amount * factor;
      return acc;
    }, {});
  }

  /**
   * getMonthlyIncome(income)
   *
   * Returns the total average monthly income across all sources.
   * - "monthly" sources count once per month.
   * - "every_4_weeks" sources pay 13 times per year → × 13/12 for monthly average.
   */
  function getMonthlyIncome(income) {
    return income.reduce((total, source) => {
      if (source.type === 'monthly')       return total + source.amount;
      if (source.type === 'every_4_weeks') return total + source.amount * 13 / 12;
      return total;
    }, 0);
  }

  // ── Backward-compat wrappers (used by charts.js and app.js) ───────────────

  /**
   * generate(data, months = 12)
   *
   * Thin wrapper around generateDailyProjection that returns the shape
   * expected by Charts.render() and the summary cards:
   *   [{ date: Date, balance: number, events: [...] }]
   */
  function generate(data, months = 12) {
    const today   = todayMidnight();
    const endDate = new Date(today.getFullYear(), today.getMonth() + months, today.getDate());
    const days    = Math.round((endDate - today) / 86_400_000) + 1;

    return generateDailyProjection(data.current_balance, data.bills, data.income, days)
      .map(entry => ({
        date:    new Date(entry.date + 'T00:00:00'),
        balance: entry.endingBalance,
        events: [
          ...entry.incomeReceived.map(r => ({ type: 'income',  name: r.name,     amount:  r.amount })),
          ...entry.deductions.map(d      => ({ type: 'expense', name: d.billName, amount: -d.amount }))
        ]
      }));
  }

  /**
   * monthlyStats(data)
   *
   * Returns { income, expenses, net } for the current calendar month.
   * Used by the summary stat cards in app.js.
   */
  function monthlyStats(data) {
    const now   = new Date();
    const yr    = now.getFullYear();
    const mo0   = now.getMonth();
    const moNum = mo0 + 1;

    const expenses = data.bills.reduce(
      (sum, bill) => sum + (isBillActiveInMonth(bill, moNum) ? bill.amount : 0),
      0
    );

    const monthDate = new Date(yr, mo0, 1);
    const income = data.income.reduce((sum, source) => {
      if (source.type === 'monthly') return sum + getEffectiveAmount(source, monthDate);
      if (source.type === 'every_4_weeks') {
        const mStart = new Date(yr, mo0, 1);
        const mEnd   = new Date(yr, mo0 + 1, 0);
        let d = new Date(source.pay_date_start + 'T00:00:00');
        while (d < mStart) d.setDate(d.getDate() + 28);
        let count = 0;
        while (d <= mEnd) { count++; d = new Date(d); d.setDate(d.getDate() + 28); }
        return sum + source.amount * count;
      }
      return sum;
    }, 0);

    return { income, expenses, net: income - expenses };
  }

  /**
   * findSkippablePayments(dailyProjection, income)
   *
   * For each every_4_weeks payment in the projection, determines whether
   * skipping it would ever cause the balance to go negative.
   *
   * Logic: if you skip a payment on day D, every balance from D onwards
   * drops by the payment amount. So the skipped minimum is:
   *   min(endingBalance[D..end]) - amount
   * The payment is safe to skip when that value is >= 0.
   *
   * Returns an array of:
   *   { date, sourceId, sourceName, amount, isSkippable, balanceIfSkipped }
   * sorted by date.
   */
  function findSkippablePayments(dailyProjection, income) {
    const flexSources = income.filter(s => s.type === 'every_4_weeks');
    if (flexSources.length === 0 || dailyProjection.length === 0) return [];

    // Build suffix-minimum array once — O(n) instead of O(n²)
    const n = dailyProjection.length;
    const suffixMin = new Array(n);
    suffixMin[n - 1] = dailyProjection[n - 1].endingBalance;
    for (let i = n - 2; i >= 0; i--) {
      suffixMin[i] = Math.min(dailyProjection[i].endingBalance, suffixMin[i + 1]);
    }

    const result = [];

    for (const source of flexSources) {
      for (let i = 0; i < n; i++) {
        const day = dailyProjection[i];
        if (!day.incomeReceived.some(r => r.incomeId === source.id)) continue;

        const payDate = new Date(day.date + 'T00:00:00');
        const amt = getEffectiveAmount(source, payDate);
        const minFutureBalance = suffixMin[i];
        const balanceIfSkipped = Math.round((minFutureBalance - amt) * 100) / 100;
        result.push({
          date:            day.date,
          sourceId:        source.id,
          sourceName:      source.name,
          amount:          amt,
          isSkippable:     balanceIfSkipped >= 0,
          balanceIfSkipped
        });
      }
    }

    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    generateDailyProjection,
    findSkippablePayments,
    getNextBill,
    getDaysUntilNextBill,
    getNextPayDay,
    getFirstNegativeDate,
    getCategoryBreakdown,
    getMonthlyIncome,
    nextWorkingDay,
    // compat
    generate,
    monthlyStats
  };

})();
