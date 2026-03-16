// charts.js — Chart.js rendering (dark theme)

const Charts = (() => {
  let balanceChart   = null;
  let breakdownChart = null;

  const GREEN      = '#00D68F';
  const RED        = '#FF4D4D';
  const GRID_COLOR = 'rgba(255,255,255,0.06)';
  const TICK_COLOR = 'rgba(232,237,245,0.45)';
  const ZERO_COLOR = 'rgba(255,255,255,0.22)';

  const CATEGORY_COLORS = {
    Housing:       '#4C8DFF',
    Utilities:     '#FFB800',
    Subscriptions: '#A855F7',
    Insurance:     '#00D68F',
    Other:         '#64748B'
  };

  function fmtDate(isoStr) {
    return new Date(isoStr + 'T00:00:00')
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtGBP(n) {
    return '£' + Math.abs(n).toLocaleString('en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // ── Balance Forecast Chart ────────────────────────────────────────────

  /**
   * render(projectionData)
   *
   * projectionData is the array from Projection.generate():
   *   [{ date: Date, balance: number, events: [...] }]
   *
   * Uses every daily data point (no sampling) so income steps are visible.
   */
  function render(projectionData) {
    const ctx = document.getElementById('balance-chart').getContext('2d');

    const labels = projectionData.map(p => p.date.toISOString().split('T')[0]);
    const values = projectionData.map(p => p.balance);

    // Zero-line dataset
    const zeros = values.map(() => 0);

    const datasets = [
      // 0: zero reference line
      {
        label:           '_zero',
        data:            zeros,
        borderColor:     ZERO_COLOR,
        borderWidth:     1,
        borderDash:      [6, 5],
        pointRadius:     0,
        fill:            false,
        tension:         0,
        order:           2
      },
      // 1: balance line
      {
        label: 'Balance',
        data:  values,
        segment: {
          borderColor: ctx => ctx.p1.parsed.y < 0 ? RED : GREEN
        },
        fill: {
          target:  0,       // fill relative to dataset[0] (zero line)
          above:   'rgba(0,214,143,0.12)',
          below:   'rgba(255,77,77,0.12)'
        },
        borderColor:              GREEN,
        backgroundColor:          'transparent',
        borderWidth:              2,
        tension:                  0,
        pointRadius:              0,
        pointHoverRadius:         5,
        pointHoverBackgroundColor: GREEN,
        order: 1
      }
    ];

    const options = {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 600 },
      interaction:         { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,22,41,0.95)',
          borderColor:     'rgba(255,255,255,0.1)',
          borderWidth:     1,
          titleColor:      '#e8edf5',
          bodyColor:       'rgba(232,237,245,0.7)',
          padding:         12,
          callbacks: {
            title(items) {
              return fmtDate(items[0].label);
            },
            label(item) {
              if (item.datasetIndex === 0) return null;
              const bal = item.parsed.y;
              return `Balance: ${bal < 0 ? '-' : ''}${fmtGBP(bal)}`;
            },
            afterBody(items) {
              const iso   = items[0].label;
              const point = projectionData.find(
                p => p.date.toISOString().split('T')[0] === iso
              );
              if (!point || !point.events.length) return [];
              return point.events.map(e => {
                const sign = e.amount > 0 ? '+' : '-';
                return `  ${e.name}: ${sign}${fmtGBP(e.amount)}`;
              });
            }
          },
          filter(item) {
            return item.datasetIndex !== 0;
          }
        }
      },
      scales: {
        x: {
          grid:  { color: GRID_COLOR },
          ticks: {
            maxTicksLimit: 14,
            font:          { size: 11 },
            color:         TICK_COLOR,
            callback(val) {
              const label = this.getLabelForValue(val);
              if (label && label.endsWith('-01')) {
                const d = new Date(label + 'T00:00:00');
                return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
              }
              return '';
            }
          }
        },
        y: {
          grid:  { color: GRID_COLOR },
          ticks: {
            font:     { size: 11 },
            color:    TICK_COLOR,
            callback: val => '£' + val.toLocaleString('en-GB')
          }
        }
      }
    };

    if (balanceChart) {
      balanceChart.data.labels           = labels;
      balanceChart.data.datasets[0].data = zeros;
      balanceChart.data.datasets[1].data = values;
      balanceChart.options.plugins.tooltip.callbacks.afterBody =
        options.plugins.tooltip.callbacks.afterBody;
      balanceChart.update();
      return;
    }

    balanceChart = new Chart(ctx, { type: 'line', data: { labels, datasets }, options });
  }

  // ── Category Breakdown Doughnut ───────────────────────────────────────

  /**
   * renderBreakdown(categoryBreakdown)
   *
   * categoryBreakdown: { Housing: 1505, Utilities: 422, ... }
   * from Projection.getCategoryBreakdown()
   */
  function renderBreakdown(categoryBreakdown) {
    const ctx = document.getElementById('breakdown-chart').getContext('2d');

    const entries = Object.entries(categoryBreakdown).filter(([, v]) => v > 0);
    const labels  = entries.map(([k]) => k);
    const values  = entries.map(([, v]) => Math.round(v * 100) / 100);
    const colors  = labels.map(l => CATEGORY_COLORS[l] || CATEGORY_COLORS.Other);

    const data = {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.map(c => c + '33'),  // 20% opacity fill
        borderColor:     colors,
        borderWidth:     2,
        hoverBackgroundColor: colors.map(c => c + '55'),
        hoverBorderWidth: 3
      }]
    };

    data.datasets[0].data = values;

    const options = {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 600 },
      cutout:              '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color:     'rgba(232,237,245,0.7)',
            font:      { size: 12 },
            padding:   14,
            usePointStyle: true,
            pointStyleWidth: 10,
            generateLabels(chart) {
              const { data } = chart;
              return data.labels.map((label, i) => ({
                text:        `${label}  £${data.datasets[0].data[i].toFixed(0)}/mo`,
                fillStyle:   data.datasets[0].borderColor[i],
                strokeStyle: data.datasets[0].borderColor[i],
                pointStyle:  'circle',
                index:       i
              }));
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(13,22,41,0.95)',
          borderColor:     'rgba(255,255,255,0.1)',
          borderWidth:     1,
          titleColor:      '#e8edf5',
          bodyColor:       'rgba(232,237,245,0.7)',
          padding:         12,
          callbacks: {
            label(item) {
              const total = item.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = ((item.parsed / total) * 100).toFixed(1);
              return ` £${item.parsed.toFixed(2)}/mo  (${pct}%)`;
            }
          }
        }
      }
    };

    if (breakdownChart) {
      breakdownChart.data.labels              = labels;
      breakdownChart.data.datasets[0].data    = values;
      breakdownChart.data.datasets[0].backgroundColor  = colors.map(c => c + '33');
      breakdownChart.data.datasets[0].borderColor      = colors;
      breakdownChart.data.datasets[0].hoverBackgroundColor = colors.map(c => c + '55');
      breakdownChart.update();
      return;
    }

    breakdownChart = new Chart(ctx, { type: 'doughnut', data, options });
  }

  return { render, renderBreakdown };
})();
