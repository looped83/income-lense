/* ============================================================================
 * app.js
 * ----------------------------------------------------------------------------
 * Main application controller for the Dividend Portfolio Analyzer.
 *
 * Responsibilities:
 *   - Parse the DivvyDiary CSV (semicolon-separated, comma decimals) via PapaParse
 *   - Compute portfolio-level KPIs (all derived from the CSV, nothing hardcoded)
 *   - Build allocation context for the scoring model
 *   - Render KPI cards, charts (Chart.js), the position table, detail cards,
 *     action ideas and the inactive section
 *
 * Loaded as a plain global script (no ES modules) so the app runs by simply
 * opening index.html — locally or on GitHub Pages.
 * ==========================================================================*/

// Global app state.
const STATE = {
  positions: [], // all parsed positions
  active: [], // value > 0
  inactive: [], // value === 0
  ctx: null, // portfolio context for scoring
  kpis: null,
  charts: {}, // Chart.js instances (so we can destroy/rebuild)
};

// CSV columns we read (kept for reference / documentation).
const NUMERIC_FIELDS = [
  'quantity', 'buyin', 'buyinTotal', 'price', 'value', 'gain', 'gainRel',
  'allocation', 'allocationOnBuyin', 'dividendYield', 'dividendYieldOnBuyin',
  'totalDividendRate', 'dividendRate', 'dividendCagr', 'gainPrev', 'gainPrevRel',
  'taxRate',
];

/* ----------------------------------------------------------------------------
 * Bootstrapping
 * --------------------------------------------------------------------------*/
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('csvFile');
  if (fileInput) fileInput.addEventListener('change', onFileSelected);

  // Wire up filter / sort controls (they no-op until data is loaded).
  ['searchInput', 'sectorFilter', 'countryFilter', 'actionFilter', 'sortSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderTable);
  });

  // Top-up plan recomputes when the budget changes.
  const budget = document.getElementById('topupBudget');
  if (budget) budget.addEventListener('input', renderTopUp);

  setupNav();
});

/* ----------------------------------------------------------------------------
 * Navigation: each nav item shows exactly one "page" (view) at a time.
 * --------------------------------------------------------------------------*/
function setupNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

/** Show a single view by id and mark the matching nav item active. */
function showView(viewId) {
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === viewId);
  });
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewId);
  });

  // Charts are created while their container may be hidden (zero size). When the
  // charts view becomes visible, resize them so they fill their cards correctly.
  if (viewId === 'view-charts') {
    Object.values(STATE.charts).forEach((c) => c && c.resize());
  }

  // Jump back to the top so each "page" starts at its heading.
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ----------------------------------------------------------------------------
 * CSV loading & parsing
 * --------------------------------------------------------------------------*/
function onFileSelected(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    delimiter: ';',
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    complete: (results) => {
      try {
        handleParsedData(results.data);
      } catch (err) {
        console.error(err);
        showError('Beim Verarbeiten der CSV ist ein Fehler aufgetreten: ' + err.message);
      }
    },
    error: (err) => {
      console.error(err);
      showError('CSV konnte nicht gelesen werden: ' + err.message);
    },
  });
}

/** Convert a raw CSV row into a typed position object. */
function buildPosition(row) {
  const pos = {
    symbol: (row.symbol || '').trim(),
    isin: (row.isin || '').trim(),
    wkn: (row.wkn || '').trim(),
    name: (row.name || '').trim(),
    currency: (row.currency || '').trim(),
    dividendFrequency: (row.dividendFrequency || '').trim(),
    dividendCagrPeriod: (row.dividendCagrPeriod || '').trim(),
    sector: (row.sector || '').trim() || 'Unbekannt',
    securityType: (row.securityType || '').trim(),
    country: (row.country || '').trim() || 'Unbekannt',
    originalDividendCurrency: (row.originalDividendCurrency || '').trim(),
    exDate: (row.exDate || '').trim(),
    payDate: (row.payDate || '').trim(),
    note: (row.note || '').trim(),
  };

  // Parse numeric fields (comma decimal handled by parseNum).
  NUMERIC_FIELDS.forEach((f) => {
    pos[f] = parseNum(row[f]);
  });

  // A position is "active" when it has a market value > 0.
  pos.isActive = hasNum(pos.value) && pos.value > 0;
  return pos;
}

function handleParsedData(rows) {
  const positions = rows
    .filter((r) => r && (r.symbol || r.isin))
    .map(buildPosition);

  if (positions.length === 0) {
    showError('Keine Positionen in der CSV gefunden.');
    return;
  }

  STATE.positions = positions;
  STATE.active = positions.filter((p) => p.isActive);
  STATE.inactive = positions.filter((p) => !p.isActive);

  // Build portfolio context + KPIs from the ACTIVE positions only.
  STATE.ctx = buildContext(STATE.active);
  STATE.kpis = computeKpis(STATE.active);

  // Compute scores, insights and action category per position.
  positions.forEach((p) => {
    p.scores = computeScores(p, STATE.ctx);
    p.insights = buildInsights(p, p.scores, STATE.ctx);
    p.action = classifyAction(p, p.scores, STATE.ctx);
  });

  // Reveal the dashboard + navigation and render everything.
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('mainNav').classList.remove('hidden');

  populateFilters();
  renderKpis();
  renderCharts();
  renderTable();
  renderDetailCards();
  renderActionIdeas();
  renderTopUp();
  renderInactive();

  // Always start on the overview "page".
  showView('view-overview');
}

/* ----------------------------------------------------------------------------
 * Portfolio context (aggregates for the scoring model)
 * --------------------------------------------------------------------------*/
function buildContext(active) {
  const totalValue = active.reduce((s, p) => s + num0(p.value), 0);
  const totalAnnualDividend = active.reduce((s, p) => s + num0(p.totalDividendRate), 0);

  // Sector & country allocation as fractions of total portfolio value.
  const sectorValue = {};
  const countryValue = {};
  active.forEach((p) => {
    sectorValue[p.sector] = (sectorValue[p.sector] || 0) + num0(p.value);
    countryValue[p.country] = (countryValue[p.country] || 0) + num0(p.value);
  });

  const sectorAllocation = {};
  Object.keys(sectorValue).forEach((k) => {
    sectorAllocation[k] = totalValue > 0 ? sectorValue[k] / totalValue : 0;
  });
  const countryAllocation = {};
  Object.keys(countryValue).forEach((k) => {
    countryAllocation[k] = totalValue > 0 ? countryValue[k] / totalValue : 0;
  });

  return {
    totalValue,
    totalAnnualDividend,
    sectorAllocation,
    countryAllocation,
  };
}

/* ----------------------------------------------------------------------------
 * KPI computation (everything derived from the CSV)
 * --------------------------------------------------------------------------*/
function computeKpis(active) {
  const totalValue = active.reduce((s, p) => s + num0(p.value), 0);
  const totalInvested = active.reduce((s, p) => s + num0(p.buyinTotal), 0);
  const totalGain = active.reduce((s, p) => s + num0(p.gain), 0);
  const annualDividend = active.reduce((s, p) => s + num0(p.totalDividendRate), 0);

  const gainRel = totalInvested > 0 ? totalGain / totalInvested : NaN;
  const monthlyDividend = annualDividend / 12;
  const weightedYield = totalValue > 0 ? annualDividend / totalValue : NaN;
  const weightedYoc = totalInvested > 0 ? annualDividend / totalInvested : NaN;

  const dividendPayers = active.filter((p) => num0(p.totalDividendRate) > 0);

  // Largest position by value.
  let largest = null;
  active.forEach((p) => {
    if (!largest || num0(p.value) > num0(largest.value)) largest = p;
  });
  // Largest dividend payer by annual dividend.
  let largestPayer = null;
  active.forEach((p) => {
    if (!largestPayer || num0(p.totalDividendRate) > num0(largestPayer.totalDividendRate)) {
      largestPayer = p;
    }
  });

  return {
    totalValue,
    totalInvested,
    totalGain,
    gainRel,
    annualDividend,
    monthlyDividend,
    weightedYield,
    weightedYoc,
    activeCount: active.length,
    payerCount: dividendPayers.length,
    largest,
    largestPayer,
  };
}

/* ----------------------------------------------------------------------------
 * KPI rendering
 * --------------------------------------------------------------------------*/
function renderKpis() {
  const k = STATE.kpis;
  const grid = document.getElementById('kpiGrid');

  const cards = [
    { label: 'Depotwert', value: fmtCurrency(k.totalValue), accent: 'neutral' },
    { label: 'Investiertes Kapital', value: fmtCurrency(k.totalInvested), accent: 'neutral' },
    {
      label: 'Unrealisiertes Plus/Minus',
      value: fmtSignedCurrency(k.totalGain),
      accent: k.totalGain >= 0 ? 'pos' : 'neg',
    },
    {
      label: 'Unrealisiertes Plus/Minus %',
      value: fmtSignedPercent(k.gainRel),
      accent: k.gainRel >= 0 ? 'pos' : 'neg',
    },
    { label: 'Jährliche Bruttodividende', value: fmtCurrency(k.annualDividend), accent: 'income' },
    { label: 'Monatliche Bruttodividende', value: fmtCurrency(k.monthlyDividend), accent: 'income' },
    { label: 'Gewichtete Dividendenrendite', value: fmtPercent(k.weightedYield), accent: 'income' },
    { label: 'Gewichteter Yield on Cost', value: fmtPercent(k.weightedYoc), accent: 'income' },
    { label: 'Anzahl aktiver Positionen', value: fmtNumber(k.activeCount, 0), accent: 'neutral' },
    { label: 'Anzahl Dividendenzahler', value: fmtNumber(k.payerCount, 0), accent: 'neutral' },
    {
      label: 'Größte Position',
      value: k.largest ? k.largest.symbol : 'n/a',
      sub: k.largest ? `${fmtCurrency(k.largest.value)} · ${fmtPercent(k.largest.allocation)}` : '',
      accent: 'neutral',
    },
    {
      label: 'Größter Dividendenzahler',
      value: k.largestPayer ? k.largestPayer.symbol : 'n/a',
      sub: k.largestPayer ? `${fmtCurrency(k.largestPayer.totalDividendRate)} / Jahr` : '',
      accent: 'income',
    },
  ];

  grid.innerHTML = cards
    .map(
      (c) => `
      <div class="kpi-card kpi-${c.accent}">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
        ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
      </div>`
    )
    .join('');
}

/* ----------------------------------------------------------------------------
 * Charts (Chart.js)
 * --------------------------------------------------------------------------*/
const CHART_PALETTE = [
  '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#f1c40f',
  '#e74c3c', '#16a085', '#2980b9', '#8e44ad', '#d35400', '#27ae60',
  '#c0392b', '#7f8c8d', '#f39c12', '#34495e',
];

function destroyCharts() {
  Object.values(STATE.charts).forEach((c) => c && c.destroy());
  STATE.charts = {};
}

/** Aggregate active positions' value by a key (e.g. sector / country / type). */
function aggregateBy(field, valueField = 'value') {
  const map = {};
  STATE.active.forEach((p) => {
    const key = p[field] || 'Unbekannt';
    map[key] = (map[key] || 0) + num0(p[valueField]);
  });
  return map;
}

/** Convert a {key:value} map into sorted {labels, data} for charts. */
function toSorted(map, limit) {
  let entries = Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (limit) entries = entries.slice(0, limit);
  return { labels: entries.map((e) => e[0]), data: entries.map((e) => e[1]) };
}

function renderCharts() {
  destroyCharts();
  Chart.defaults.color = '#9aa4b2';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

  const doughnutOpts = (currency = true) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { boxWidth: 12, padding: 10 } },
      tooltip: {
        callbacks: {
          label: (c) => {
            const total = c.dataset.data.reduce((s, v) => s + v, 0);
            const pct = total > 0 ? c.parsed / total : 0;
            return ` ${c.label}: ${currency ? fmtCurrency(c.parsed) : fmtNumber(c.parsed)} (${fmtPercent(pct, 1)})`;
          },
        },
      },
    },
  });

  const barOpts = (currency = true) => ({
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c) => ` ${currency ? fmtCurrency(c.parsed.x) : fmtNumber(c.parsed.x)}`,
        },
      },
    },
    scales: {
      x: { ticks: { callback: (v) => fmtNumber(v, 0) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { grid: { display: false } },
    },
  });

  // 1) Allocation by sector
  const sector = toSorted(aggregateBy('sector'));
  STATE.charts.sector = new Chart(ctxOf('chartSector'), {
    type: 'doughnut',
    data: pieData(sector),
    options: doughnutOpts(),
  });

  // 2) Allocation by country
  const country = toSorted(aggregateBy('country'));
  STATE.charts.country = new Chart(ctxOf('chartCountry'), {
    type: 'doughnut',
    data: pieData(country),
    options: doughnutOpts(),
  });

  // 3) Allocation by security type
  const type = toSorted(aggregateBy('securityType'));
  type.labels = type.labels.map(fmtSecurityType);
  STATE.charts.type = new Chart(ctxOf('chartType'), {
    type: 'doughnut',
    data: pieData(type),
    options: doughnutOpts(),
  });

  // 4) Allocation by currency (underlying / original dividend currency exposure)
  const currency = toSorted(aggregateBy('originalDividendCurrency'));
  STATE.charts.currency = new Chart(ctxOf('chartCurrency'), {
    type: 'doughnut',
    data: pieData(currency),
    options: doughnutOpts(),
  });

  // 5) Top 10 positions by market value
  const topValue = topPositions('value', 10);
  STATE.charts.topValue = new Chart(ctxOf('chartTopValue'), {
    type: 'bar',
    data: barData(topValue, '#3498db'),
    options: barOpts(),
  });

  // 5) Top 10 positions by annual dividend
  const topDiv = topPositions('totalDividendRate', 10);
  STATE.charts.topDiv = new Chart(ctxOf('chartTopDiv'), {
    type: 'bar',
    data: barData(topDiv, '#2ecc71'),
    options: barOpts(),
  });

  // 6) Dividend contribution by sector
  const divSector = toSorted(aggregateBy('sector', 'totalDividendRate'));
  STATE.charts.divSector = new Chart(ctxOf('chartDivSector'), {
    type: 'doughnut',
    data: pieData(divSector),
    options: doughnutOpts(),
  });
}

function ctxOf(id) {
  return document.getElementById(id).getContext('2d');
}

function pieData(agg) {
  return {
    labels: agg.labels,
    datasets: [
      {
        data: agg.data,
        backgroundColor: agg.labels.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]),
        borderColor: '#161b22',
        borderWidth: 2,
      },
    ],
  };
}

/** Build top-N positions {labels, data} for a numeric field. */
function topPositions(field, n) {
  const sorted = [...STATE.active]
    .filter((p) => num0(p[field]) > 0)
    .sort((a, b) => num0(b[field]) - num0(a[field]))
    .slice(0, n);
  return { labels: sorted.map((p) => p.symbol), data: sorted.map((p) => num0(p[field])) };
}

function barData(agg, color) {
  return {
    labels: agg.labels,
    datasets: [{ data: agg.data, backgroundColor: color, borderRadius: 4 }],
  };
}

/* ----------------------------------------------------------------------------
 * Filters
 * --------------------------------------------------------------------------*/
function populateFilters() {
  const sectors = [...new Set(STATE.active.map((p) => p.sector))].sort();
  const countries = [...new Set(STATE.active.map((p) => p.country))].sort();

  fillSelect('sectorFilter', sectors, 'Alle Sektoren');
  fillSelect('countryFilter', countries, 'Alle Länder', fmtCountry);

  const actionSelect = document.getElementById('actionFilter');
  actionSelect.innerHTML =
    '<option value="">Alle Aktionen</option>' +
    Object.entries(ACTION_CATEGORIES)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');
}

function fillSelect(id, values, allLabel, labeller) {
  const sel = document.getElementById(id);
  sel.innerHTML =
    `<option value="">${allLabel}</option>` +
    values
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(labeller ? labeller(v) : v)}</option>`)
      .join('');
}

/* ----------------------------------------------------------------------------
 * Position table (sortable / filterable)
 * --------------------------------------------------------------------------*/
function renderTable() {
  if (!STATE.active.length) return;
  const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  const sectorF = document.getElementById('sectorFilter').value;
  const countryF = document.getElementById('countryFilter').value;
  const actionF = document.getElementById('actionFilter').value;
  const sortBy = document.getElementById('sortSelect').value;

  let rows = STATE.active.filter((p) => {
    if (sectorF && p.sector !== sectorF) return false;
    if (countryF && p.country !== countryF) return false;
    if (actionF && p.action !== actionF) return false;
    if (search) {
      const hay = `${p.symbol} ${p.name} ${p.isin}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const sorters = {
    value: (a, b) => num0(b.value) - num0(a.value),
    dividend: (a, b) => num0(b.totalDividendRate) - num0(a.totalDividendRate),
    allocation: (a, b) => num0(b.allocation) - num0(a.allocation),
    yield: (a, b) => num0(b.dividendYield) - num0(a.dividendYield),
    cagr: (a, b) => num0(b.dividendCagr) - num0(a.dividendCagr),
    score: (a, b) => b.scores.total - a.scores.total,
  };
  rows.sort(sorters[sortBy] || sorters.value);

  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = rows
    .map((p) => {
      const interp = interpretScore(p.scores.total);
      const gainCls = num0(p.gainRel) >= 0 ? 'pos' : 'neg';
      const catLabel = ACTION_CATEGORIES[p.action].label;
      return `
      <tr>
        <td class="t-sym">${escapeHtml(p.symbol)}</td>
        <td class="t-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
        <td class="t-num">${fmtCurrency(p.value)}</td>
        <td class="t-num">${fmtPercent(p.allocation, 1)}</td>
        <td class="t-num ${gainCls}">${fmtSignedPercent(p.gainRel)}</td>
        <td class="t-num">${fmtPercent(p.dividendYield)}</td>
        <td class="t-num">${fmtPercent(p.dividendYieldOnBuyin)}</td>
        <td class="t-num">${fmtCurrency(p.totalDividendRate)}</td>
        <td class="t-num">${fmtPercent(p.dividendCagr, 1)}</td>
        <td class="t-num"><span class="score-pill ${interp.cls}">${p.scores.total}</span></td>
        <td class="t-action"><span class="action-tag ${ACTION_CATEGORIES[p.action].cls}">${catLabel}</span></td>
      </tr>`;
    })
    .join('');

  document.getElementById('tableCount').textContent =
    `${rows.length} von ${STATE.active.length} aktiven Positionen`;
}

/* ----------------------------------------------------------------------------
 * Detailed position analysis (master-detail)
 * Left: a selectable list of positions. Right: details of the selected one.
 * Keeps the page short instead of stacking one big card per position.
 * --------------------------------------------------------------------------*/
let DETAIL_SORTED = []; // positions in the order shown in the list

function renderDetailCards() {
  // Sort by total score (strongest first).
  DETAIL_SORTED = [...STATE.active].sort((a, b) => b.scores.total - a.scores.total);

  const list = document.getElementById('detailList');
  list.innerHTML = DETAIL_SORTED.map(detailListItemHtml).join('');
  list.querySelectorAll('.detail-list-item').forEach((el) => {
    el.addEventListener('click', () => selectDetail(el.dataset.symbol));
  });

  // Select the first (highest-scoring) position by default.
  if (DETAIL_SORTED.length) selectDetail(DETAIL_SORTED[0].symbol);
}

/** A single clickable row in the position list. */
function detailListItemHtml(p) {
  const interp = interpretScore(p.scores.total);
  return `
    <button type="button" class="detail-list-item" data-symbol="${escapeHtml(p.symbol)}">
      <span class="dli-main">
        <span class="dli-sym">${escapeHtml(p.symbol)}</span>
        <span class="dli-name">${escapeHtml(p.name)}</span>
      </span>
      <span class="dli-meta">
        <span class="dli-value">${fmtCurrency(p.value)}</span>
        <span class="score-pill ${interp.cls}">${p.scores.total}</span>
      </span>
    </button>`;
}

/** Render the detail panel for the selected symbol and highlight the list row. */
function selectDetail(symbol) {
  const p = DETAIL_SORTED.find((x) => x.symbol === symbol);
  if (!p) return;
  document.querySelectorAll('.detail-list-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.symbol === symbol);
  });
  document.getElementById('detailPanel').innerHTML = detailCardHtml(p);
}

function detailCardHtml(p) {
  const s = p.scores;
  const interp = interpretScore(s.total);
  const gainCls = num0(p.gain) >= 0 ? 'pos' : 'neg';

  const dataRow = (label, value) => `
    <div class="d-row"><span class="d-k">${label}</span><span class="d-v">${value}</span></div>`;

  const scoreBlock = (label, val) => `
    <div class="score-block">
      <div class="score-bar-label"><span>${label}</span><span>${val}</span></div>
      <div class="score-bar"><div class="score-bar-fill" style="width:${val}%;background:${scoreColor(val)}"></div></div>
    </div>`;

  const insightsHtml = p.insights.map((i) => `<li>${escapeHtml(i)}</li>`).join('');

  return `
  <div class="detail-card">
    <div class="dc-header">
      <div class="dc-id">
        <div class="dc-sym">${escapeHtml(p.symbol)}
          <span class="action-tag ${ACTION_CATEGORIES[p.action].cls}">${ACTION_CATEGORIES[p.action].label}</span>
        </div>
        <div class="dc-name">${escapeHtml(p.name)}</div>
        <div class="dc-meta">${escapeHtml(p.isin)} · ${escapeHtml(p.sector)} · ${fmtCountry(p.country)} · ${fmtSecurityType(p.securityType)}</div>
      </div>
      <div class="score-circle" style="--clr:${scoreColor(s.total)}">
        <svg viewBox="0 0 120 120">
          <!-- No background track ring: only the colored progress arc is drawn. -->
          <circle class="sc-prog" cx="60" cy="60" r="52"
            stroke-dasharray="${(s.total / 100) * 326.7} 326.7"></circle>
        </svg>
        <div class="sc-text"><span class="sc-num">${s.total}</span><span class="sc-lbl">${interp.label}</span></div>
      </div>
    </div>

    <div class="dc-scores">
      ${scoreBlock('Sicherheit', s.safety)}
      ${scoreBlock('Einkommen', s.income)}
      ${scoreBlock('Wachstum', s.growth)}
      ${scoreBlock('Depot-Fit', s.fit)}
      ${scoreBlock('Konzentrationsrisiko', s.concentration)}
    </div>

    <div class="dc-grid">
      ${dataRow('Aktueller Wert', fmtCurrency(p.value))}
      ${dataRow('Depotanteil', fmtPercent(p.allocation))}
      ${dataRow('Investiert (Buy-in)', fmtCurrency(p.buyinTotal))}
      ${dataRow('Unreal. Plus/Minus', `<span class="${gainCls}">${fmtSignedCurrency(p.gain)}</span>`)}
      ${dataRow('Unreal. Plus/Minus %', `<span class="${gainCls}">${fmtSignedPercent(p.gainRel)}</span>`)}
      ${dataRow('Dividendenrendite', fmtPercent(p.dividendYield))}
      ${dataRow('Yield on Cost', fmtPercent(p.dividendYieldOnBuyin))}
      ${dataRow('Jährliche Dividende', fmtCurrency(p.totalDividendRate))}
      ${dataRow('Dividende je Anteil', fmtCurrency(p.dividendRate))}
      ${dataRow('Frequenz', fmtFrequency(p.dividendFrequency))}
      ${dataRow('Dividenden-CAGR', `${fmtPercent(p.dividendCagr, 1)} (${fmtText(p.dividendCagrPeriod)})`)}
      ${dataRow('Ex-Tag', fmtDate(p.exDate))}
      ${dataRow('Zahltag', fmtDate(p.payDate))}
    </div>

    <div class="dc-insights">
      <div class="dc-insights-title">Automatische Insights</div>
      <ul>${insightsHtml}</ul>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------------------
 * Action ideas
 * --------------------------------------------------------------------------*/
function renderActionIdeas() {
  const container = document.getElementById('actionIdeas');
  const order = ['add', 'hold', 'monitor', 'noadd', 'reduce', 'inactive'];

  container.innerHTML = order
    .map((key) => {
      const cat = ACTION_CATEGORIES[key];
      const members = STATE.positions
        .filter((p) => p.action === key)
        .sort((a, b) => b.scores.total - a.scores.total);
      if (members.length === 0) return '';

      const chips = members
        .map(
          (p) =>
            `<span class="ai-chip"><strong>${escapeHtml(p.symbol)}</strong> <span class="ai-score">${p.scores.total}</span></span>`
        )
        .join('');

      return `
      <div class="action-col ${cat.cls}">
        <div class="ai-head">
          <span class="ai-title">${cat.label}</span>
          <span class="ai-count">${members.length}</span>
        </div>
        <div class="ai-desc">${cat.desc}</div>
        <div class="ai-chips">${chips}</div>
      </div>`;
    })
    .join('');
}

/* ----------------------------------------------------------------------------
 * Top-up plan (1.000 € tranches) — target-weight planner + rendering
 * ----------------------------------------------------------------------------
 * Smarter & more granular than a flat greedy:
 *   1) Every eligible position gets a quality-scaled TARGET weight (soft cap)
 *      from its ranking + CSV metrics + diversification (see insights.js).
 *   2) The budget is split across candidates proportionally to an
 *      "attractiveness" = quality × how far the position is below its target,
 *      via iterative water-filling, capped by the soft target and the 8% hard
 *      cap. Capped positions hand their leftover to the others.
 *   3) Those € targets are rendered as 1.000 € tranches by repeatedly funding
 *      whichever position sits furthest below its € target. Allocations + ranks
 *      are recomputed per tranche so the "Wieso?" stays accurate.
 * --------------------------------------------------------------------------*/
function buildTopUpPlan(trancheCount) {
  // Work on clones so the real portfolio state is never mutated.
  const sim = STATE.active.map((p) => ({ ...p }));

  // Recompute allocations, context and scores from the simulated values.
  const recompute = () => {
    const totalValue = sim.reduce((s, p) => s + num0(p.value), 0);
    const totalAnnualDividend = sim.reduce((s, p) => s + num0(p.totalDividendRate), 0);
    const sectorValue = {};
    const countryValue = {};
    sim.forEach((p) => {
      sectorValue[p.sector] = (sectorValue[p.sector] || 0) + num0(p.value);
      countryValue[p.country] = (countryValue[p.country] || 0) + num0(p.value);
    });
    const sectorAllocation = {};
    const countryAllocation = {};
    Object.keys(sectorValue).forEach((k) => (sectorAllocation[k] = totalValue > 0 ? sectorValue[k] / totalValue : 0));
    Object.keys(countryValue).forEach((k) => (countryAllocation[k] = totalValue > 0 ? countryValue[k] / totalValue : 0));
    sim.forEach((p) => (p.allocation = totalValue > 0 ? num0(p.value) / totalValue : 0));
    const ctx = { totalValue, totalAnnualDividend, sectorAllocation, countryAllocation };
    sim.forEach((p) => (p.scores = computeScores(p, ctx)));
    return ctx;
  };

  let ctx = recompute();
  const budget = trancheCount * TRANCHE_SIZE;

  // --- 1) Build candidate profiles (quality, soft cap, room) from base state.
  const candidates = [];
  sim.forEach((p) => {
    const m = topUpMetrics(p, ctx);
    if (!topUpEligible(p, ctx, m)) return;
    const quality = topUpQuality(p, m);
    const softCap = topUpSoftCap(quality);
    // Underweight degree relative to the soft target (0 if already at/above it).
    const under = Math.max(0, softCap - p.allocation);
    if (under <= 0) return; // already at its quality target -> nothing to add
    const attractiveness = quality * Math.min(1, under / softCap);
    // € room: to the soft target and to the hard cap (whichever is smaller).
    const roomSoft = Math.max(0, (softCap - p.allocation) * ctx.totalValue);
    const roomHard = Math.max(0, TOPUP_HARD_CAP * ctx.totalValue - num0(p.value));
    candidates.push({ p, attractiveness, capEuro: Math.min(roomSoft, roomHard), targetEuro: 0 });
  });
  if (!candidates.length) return [];

  // --- 2) Water-filling: split the budget proportionally to attractiveness,
  //        respecting each candidate's € cap; capped ones spill over.
  let remaining = budget;
  for (let iter = 0; iter < 8 && remaining >= 1; iter++) {
    const open = candidates.filter((c) => c.targetEuro < c.capEuro - 1e-6 && c.attractiveness > 0);
    const sumAttr = open.reduce((s, c) => s + c.attractiveness, 0);
    if (sumAttr <= 0) break;
    let placed = 0;
    open.forEach((c) => {
      const want = remaining * (c.attractiveness / sumAttr);
      const add = Math.min(want, c.capEuro - c.targetEuro);
      if (add > 0) {
        c.targetEuro += add;
        placed += add;
      }
    });
    remaining -= placed;
    if (placed < 1e-6) break;
  }

  // --- 3) Render € targets as 1.000 € tranches: each tranche funds the
  //        position furthest below its € target (granular, proportional spread).
  const assigned = {};
  candidates.forEach((c) => (assigned[c.p.symbol] = 0));
  const bySymbol = {};
  candidates.forEach((c) => (bySymbol[c.p.symbol] = c));
  const plan = [];

  for (let i = 0; i < trancheCount; i++) {
    // Live ranking for the reasoning.
    const ranked = [...sim].sort((a, b) => b.scores.total - a.scores.total);
    const rankOf = {};
    ranked.forEach((p, idx) => (rankOf[p.symbol] = idx + 1));

    let best = null;
    let bestGap = 0;
    candidates.forEach((c) => {
      if (assigned[c.p.symbol] + TRANCHE_SIZE > c.capEuro + TRANCHE_SIZE * 0.5) return; // respect cap
      const gap = c.targetEuro - assigned[c.p.symbol];
      if (gap > bestGap) {
        bestGap = gap;
        best = c;
      }
    });
    if (!best || bestGap <= 1e-6) break; // all € targets met (budget exceeds sensible capacity)

    assigned[best.p.symbol] += TRANCHE_SIZE;
    const m = topUpMetrics(best.p, ctx);
    const oldAlloc = best.p.allocation;
    const decisionScore = best.p.scores.total;
    const reasons = topUpReasons(best.p, m, { rank: rankOf[best.p.symbol] });

    best.p.value = num0(best.p.value) + TRANCHE_SIZE;
    ctx = recompute();

    plan.push({
      n: i + 1,
      symbol: best.p.symbol,
      name: best.p.name,
      sector: best.p.sector,
      country: best.p.country,
      securityType: best.p.securityType,
      score: decisionScore,
      reasons,
      oldAlloc,
      newAlloc: best.p.allocation,
      targetWeight: topUpSoftCap(topUpQuality(best.p, m)),
    });
  }
  return plan;
}

function renderTopUp() {
  if (!STATE.active.length) return;
  const input = document.getElementById('topupBudget');
  let budget = parseInt(input.value, 10);
  if (!Number.isFinite(budget) || budget < TRANCHE_SIZE) budget = TRANCHE_SIZE;
  const trancheCount = Math.floor(budget / TRANCHE_SIZE);

  const plan = buildTopUpPlan(trancheCount);

  const summary = document.getElementById('topupSummary');
  const planEl = document.getElementById('topupPlan');
  const aggEl = document.getElementById('topupAgg');

  if (!plan.length) {
    summary.innerHTML = '';
    planEl.innerHTML =
      '<div class="info-box">Auf Basis der aktuellen Analyse gibt es derzeit keine eindeutigen Aufstockungskandidaten ' +
      '(z. B. wegen hoher Konzentration oder schwacher Signale). Für eine genauere Entscheidung wären zusätzliche Fundamentaldaten nötig.</div>';
    aggEl.innerHTML = '';
    return;
  }

  const invested = plan.length * TRANCHE_SIZE;
  summary.innerHTML = `
    <span><strong>${plan.length}</strong> Tranchen</span>
    <span><strong>${fmtCurrency(invested)}</strong> verplant</span>`;

  // Per-tranche cards with the reasoning ("Wieso?").
  planEl.innerHTML = plan
    .map((t) => {
      const interp = interpretScore(t.score);
      const reasons = t.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
      return `
      <div class="topup-card">
        <div class="topup-head">
          <span class="topup-n">Tranche ${t.n}</span>
          <span class="topup-amount">${fmtCurrency(TRANCHE_SIZE)}</span>
        </div>
        <div class="topup-target">
          <span class="topup-sym">${escapeHtml(t.symbol)}</span>
          <span class="score-pill ${interp.cls}">${t.score}</span>
        </div>
        <div class="topup-name">${escapeHtml(t.name)}</div>
        <div class="topup-meta">${escapeHtml(t.sector)} · ${fmtCountry(t.country)} · ${fmtSecurityType(t.securityType)}</div>
        <div class="topup-alloc">Anteil: ${fmtPercent(t.oldAlloc, 1)} → <strong>${fmtPercent(t.newAlloc, 1)}</strong> <span class="topup-target-w">(Ziel ~${fmtPercent(t.targetWeight, 1)})</span></div>
        <div class="topup-why">
          <div class="topup-why-title">Wieso?</div>
          <ul>${reasons}</ul>
        </div>
      </div>`;
    })
    .join('');

  // Aggregate the budget per position (how much total goes where).
  const agg = {};
  plan.forEach((t) => {
    if (!agg[t.symbol]) agg[t.symbol] = { symbol: t.symbol, name: t.name, count: 0 };
    agg[t.symbol].count += 1;
  });
  const aggList = Object.values(agg).sort((a, b) => b.count - a.count);
  aggEl.innerHTML = `
    <h3 class="topup-agg-title">Zusammenfassung pro Wert</h3>
    <div class="topup-agg-grid">
      ${aggList
        .map(
          (a) => `
        <div class="topup-agg-item">
          <span class="topup-agg-sym">${escapeHtml(a.symbol)}</span>
          <span class="topup-agg-name">${escapeHtml(a.name)}</span>
          <span class="topup-agg-amount">${fmtCurrency(a.count * TRANCHE_SIZE)} <span class="topup-agg-count">(${a.count}×)</span></span>
        </div>`
        )
        .join('')}
    </div>`;
}

/* ----------------------------------------------------------------------------
 * Inactive / sold / watchlist section
 * --------------------------------------------------------------------------*/
function renderInactive() {
  const navBtn = document.getElementById('navInactive');
  const tbody = document.getElementById('inactiveBody');
  // No inactive positions -> hide the nav entry for this page entirely.
  if (!STATE.inactive.length) {
    navBtn.classList.add('hidden');
    return;
  }
  navBtn.classList.remove('hidden');
  document.getElementById('inactiveCount').textContent = STATE.inactive.length;

  tbody.innerHTML = STATE.inactive
    .map(
      (p) => `
      <tr>
        <td class="t-sym">${escapeHtml(p.symbol)}</td>
        <td class="t-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.isin)}</td>
        <td>${escapeHtml(p.sector)}</td>
        <td>${fmtCountry(p.country)}</td>
        <td>${fmtSecurityType(p.securityType)}</td>
        <td class="t-num">${fmtPercent(p.dividendYield)}</td>
        <td>${fmtFrequency(p.dividendFrequency)}</td>
      </tr>`
    )
    .join('');
}

/* ----------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------*/
function showError(msg) {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
