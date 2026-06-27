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
  fundamentals: {}, // symbol -> external fundamentals (V2)
  fundLoaded: false, // whether the batch load has run
  detailSelected: null, // currently selected symbol in the detail tab
  detailChart: null, // Chart.js instance for the detail fundamentals chart
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

  // V2 fundamentals controls are wired dynamically in renderFundBar().

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
  // Re-render the selected detail so its fundamentals chart sizes correctly.
  if (viewId === 'view-details' && STATE.detailSelected) {
    selectDetail(STATE.detailSelected);
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

  // Reset any V2 fundamentals from a previous CSV.
  STATE.fundamentals = {};
  STATE.fundLoaded = false;
  ENRICH.cache = {};

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
  renderRecommendations();
  renderRisk();
  renderCalendar();
  renderIncome();
  renderTable();
  renderDetailCards();
  renderFundBar();
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
  renderDetailList();

  // Keep the current selection if still present, else select the strongest.
  const keep = STATE.detailSelected && DETAIL_SORTED.some((p) => p.symbol === STATE.detailSelected);
  if (DETAIL_SORTED.length) selectDetail(keep ? STATE.detailSelected : DETAIL_SORTED[0].symbol);
}

/** (Re)build the left position list (e.g. after fundamentals load). */
function renderDetailList() {
  const list = document.getElementById('detailList');
  list.innerHTML = DETAIL_SORTED.map(detailListItemHtml).join('');
  list.querySelectorAll('.detail-list-item').forEach((el) => {
    el.addEventListener('click', () => selectDetail(el.dataset.symbol));
    if (STATE.detailSelected) el.classList.toggle('active', el.dataset.symbol === STATE.detailSelected);
  });
}

/** A single clickable row in the position list. */
function detailListItemHtml(p) {
  const interp = interpretScore(p.scores.total);
  const fund = STATE.fundamentals[p.symbol];
  const fundBadge =
    fund && fund.available ? `<span class="dli-fund" title="Fundamental-Score">F ${fund.score.composite}</span>` : '';
  return `
    <button type="button" class="detail-list-item" data-symbol="${escapeHtml(p.symbol)}">
      <span class="dli-main">
        <span class="dli-sym">${escapeHtml(p.symbol)}</span>
        <span class="dli-name">${escapeHtml(p.name)}</span>
      </span>
      <span class="dli-meta">
        <span class="dli-value">${fmtCurrency(p.value)}</span>
        <span class="score-pill ${interp.cls}">${p.scores.total}</span>
        ${fundBadge}
      </span>
    </button>`;
}

/** Render the detail panel for the selected symbol and highlight the list row. */
function selectDetail(symbol) {
  const p = DETAIL_SORTED.find((x) => x.symbol === symbol);
  if (!p) return;
  STATE.detailSelected = symbol;
  document.querySelectorAll('.detail-list-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.symbol === symbol);
  });
  // Tear down any previous fundamentals chart before re-rendering.
  if (STATE.detailChart) {
    STATE.detailChart.destroy();
    STATE.detailChart = null;
  }
  const fund = STATE.fundamentals[symbol];
  document.getElementById('detailPanel').innerHTML = detailCardHtml(p) + fundamentalsHtml(p, fund);
  if (fund && fund.available && fund.dpsByYear && fund.dpsByYear.length) buildDetailDpsChart(fund);
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
 * V2: external fundamentals — control bar, batch loader & enriched rendering
 * --------------------------------------------------------------------------*/
function renderFundBar() {
  const bar = document.getElementById('fundBar');
  if (!bar) return;

  // No key yet -> show provider choice + inline key input (stored locally).
  if (!ENRICH.enabled()) {
    const prov = ENRICH.provider();
    const docLink = prov === 'eodhd' ? 'https://eodhd.com/' : 'https://site.financialmodelingprep.com/developer/docs';
    bar.innerHTML = `
      <div class="fund-keyform">
        <label class="fund-key-label">Datenanbieter wählen und API-Key eingeben, um Fundamentaldaten zu laden (Payout Ratio, FCF-Deckung, Dividenden-Streak &amp; -Historie):</label>
        <div class="fund-key-row">
          <select id="fundProvider" class="ctrl">
            <option value="fmp"${prov === 'fmp' ? ' selected' : ''}>Financial Modeling Prep</option>
            <option value="eodhd"${prov === 'eodhd' ? ' selected' : ''}>EODHD (bessere EU/ISIN-Abdeckung)</option>
          </select>
          <input type="password" id="fundKeyInput" class="ctrl" placeholder="API-Key einfügen" autocomplete="off" spellcheck="false" />
          <button type="button" class="fund-btn" id="fundKeySave">Speichern &amp; laden</button>
        </div>
        <div class="fund-key-hint">Wird nur lokal in deinem Browser gespeichert (localStorage), nicht hochgeladen. <a id="fundKeyDoc" href="${docLink}" target="_blank" rel="noopener">Key erhalten →</a></div>
      </div>`;
    // Switch provider -> remember choice and refresh the form (updates doc link).
    bar.querySelector('#fundProvider').addEventListener('change', (e) => {
      ENRICH.setProvider(e.target.value);
      renderFundBar();
    });
    const save = () => {
      ENRICH.setProvider(bar.querySelector('#fundProvider').value);
      const v = bar.querySelector('#fundKeyInput').value;
      if (v && v.trim()) {
        ENRICH.setApiKey(v);
        renderFundBar();
        loadAllFundamentals();
      }
    };
    bar.querySelector('#fundKeySave').addEventListener('click', save);
    bar.querySelector('#fundKeyInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    return;
  }

  // Key present -> status + load/refresh + change-key.
  const loaded = STATE.fundLoaded;
  const vals = Object.values(STATE.fundamentals);
  const ok = vals.filter((f) => f && f.available).length;

  const providerName = ENRICH.providerName();
  let statusHtml;
  if (!loaded) {
    statusHtml = `API-Key erkannt (${escapeHtml(providerName)}). Jetzt Fundamentaldaten laden (nur Einzelaktien; ETFs/Fonds/Krypto werden übersprungen).`;
  } else if (ok > 0) {
    statusHtml = `Fundamentaldaten geladen: <strong>${ok}</strong> Werte angereichert · Quelle: ${escapeHtml(providerName)}.`;
  } else {
    // Nothing enriched -> show the most common failure reason to aid debugging.
    const reasons = vals.filter((f) => f && !f.available && f.reason).map((f) => f.reason);
    const counts = {};
    reasons.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const sample = top ? top[0] : 'unbekannter Grund';
    const corsHint =
      ENRICH.provider() === 'eodhd'
        ? '„Load failed"/„Failed to fetch" → EODHD blockiert direkte Browser-Aufrufe (CORS); dafür ist ein Proxy nötig oder nutze FMP.'
        : '„Failed to fetch" → CORS/Netzwerk.';
    statusHtml =
      `<strong>0 Werte angereichert.</strong> Häufigster Grund: „${escapeHtml(sample)}". ` +
      `Hinweis: <code>HTTP 401</code> → Key ungültig/deaktiviert · <code>HTTP 403</code> → Endpoint nicht im Plan · ${corsHint} ` +
      'Mehr Details: Browser-Konsole (F12).';
  }

  bar.innerHTML = `
    <div class="fund-status" id="fundStatus">${statusHtml}</div>
    <div class="fund-actions">
      <button type="button" class="fund-btn" id="fundLoadBtn">${loaded ? 'Aktualisieren' : 'Fundamentaldaten laden (alle Positionen)'}</button>
      <button type="button" class="fund-link" id="fundKeyChange">API-Key ändern</button>
    </div>`;
  bar.querySelector('#fundLoadBtn').addEventListener('click', loadAllFundamentals);
  bar.querySelector('#fundKeyChange').addEventListener('click', () => {
    ENRICH.clearApiKey();
    STATE.fundLoaded = false;
    STATE.fundamentals = {};
    ENRICH.cache = {};
    renderFundBar();
    renderDetailList();
    if (STATE.detailSelected) selectDetail(STATE.detailSelected);
  });
}

/** Fetch fundamentals for all active positions (concurrency-limited). */
async function loadAllFundamentals() {
  if (!ENRICH.enabled()) return;
  const btn = document.getElementById('fundLoadBtn');
  const status = document.getElementById('fundStatus');
  if (btn) btn.disabled = true;

  const targets = STATE.active;
  let done = 0;
  let idx = 0;
  const concurrency = Math.min(5, targets.length);

  async function worker() {
    while (idx < targets.length) {
      const p = targets[idx++];
      STATE.fundamentals[p.symbol] = await fetchFundamentals(p);
      done++;
      if (status) status.textContent = `Lade Fundamentaldaten … ${done}/${targets.length}`;
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    STATE.fundLoaded = true;
    // Console summary to make failures easy to read (F12).
    const vals = Object.values(STATE.fundamentals);
    const ok = vals.filter((f) => f && f.available).length;
    const reasons = {};
    vals.filter((f) => f && !f.available).forEach((f) => (reasons[f.reason] = (reasons[f.reason] || 0) + 1));
    console.log(`[Income Lense] Fundamentaldaten: ${ok}/${vals.length} angereichert.`, reasons);
    renderFundBar();
    renderDetailList();
    if (STATE.detailSelected) selectDetail(STATE.detailSelected);
  }
}

/** HTML for the enriched fundamentals section under a detail card. */
function fundamentalsHtml(p, fund) {
  if (!fund) return ''; // not loaded yet -> fund bar explains
  if (!fund.available) {
    return `<div class="fund-na">Fundamentaldaten: ${escapeHtml(fund.reason || 'nicht verfügbar')}</div>`;
  }

  const f = fund;
  const sc = f.score;
  const interp = interpretScore(sc.composite);

  const subBar = (label, valueText, pct) => `
    <div class="fund-sub">
      <div class="fund-sub-top"><span>${label}</span><span class="fund-sub-val">${valueText}</span></div>
      <div class="score-bar"><div class="score-bar-fill" style="width:${hasNum(pct) ? pct : 0}%;background:${scoreColor(hasNum(pct) ? pct : 50)}"></div></div>
    </div>`;

  const block = (label, score, subs) => `
    <div class="fund-block">
      <div class="fund-block-head">
        <span class="fund-block-score" style="color:${scoreColor(score)}">${score}</span>
        <span class="fund-block-label">${label}</span>
      </div>
      ${subs}
    </div>`;

  const kpi = (l, v) => `<div class="fund-kpi"><div class="fund-kpi-l">${l}</div><div class="fund-kpi-v">${v}</div></div>`;

  const fcfCovText = hasNum(f.fcfCoverage) ? `${fmtNumber(f.fcfCoverage, 1)}x` : 'n/a';
  const streakText = hasNum(f.streak) ? `${f.streak}+ J.` : 'n/a';

  return `
  <div class="fund-section">
    <div class="fund-header">
      <div class="fund-shield ${interp.cls}">
        <div class="fund-shield-num">${sc.composite}</div>
        <div class="fund-shield-lbl">Dividend</div>
      </div>
      <div class="fund-head-text">
        <div class="fund-head-title">Fundamental-Score: ${interp.label}</div>
        <div class="fund-head-sum">${escapeHtml(f.summary)}</div>
        <div class="fund-source">Quelle: ${escapeHtml(f.source)} · Symbol „${escapeHtml(f.providerSymbol || f.fmpSymbol || '')}"</div>
      </div>
    </div>

    <div class="fund-blocks">
      ${block('Sicherheit', sc.safety,
        subBar('Payout Ratio', fmtPercent(f.payoutRatio, 1), mPayout(f.payoutRatio)) +
        subBar('FCF-Deckung', fcfCovText, mFcfCoverage(f.fcfCoverage)))}
      ${block('Wachstum', sc.growth,
        subBar('Dividenden-Streak', streakText, mStreak(f.streak)) +
        subBar('5J-CAGR', fmtPercent(f.cagr5, 1), mCagr(f.cagr5)))}
      ${block('Einkommen', sc.income,
        subBar('Aktuelle Rendite', fmtPercent(f.dividendYield, 2), mYield(f.dividendYield)))}
    </div>

    <div class="fund-kpis">
      ${kpi('Dividendenrendite', fmtPercent(f.dividendYield, 2))}
      ${kpi('Div./Anteil (TTM)', hasNum(f.dpsTTM) ? fmtNumber(f.dpsTTM, 2) : 'n/a')}
      ${kpi('Payout Ratio', fmtPercent(f.payoutRatio, 1))}
      ${kpi('5J-CAGR', fmtPercent(f.cagr5, 1))}
    </div>

    <div class="fund-chart-title">Dividende je Anteil – Historie</div>
    <div class="fund-chart-wrap"><canvas id="fundDpsChart"></canvas></div>
  </div>`;
}

/** Build the DPS-history bar chart in the detail panel. */
function buildDetailDpsChart(f) {
  const el = document.getElementById('fundDpsChart');
  if (!el) return;
  const data = f.dpsByYear.slice(-12);
  STATE.detailChart = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: data.map((d) => d.year),
      datasets: [{ data: data.map((d) => d.dps), backgroundColor: '#2ecc71', borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ' ' + fmtNumber(c.parsed.y, 2) } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: (v) => fmtNumber(v, 2) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
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
 * Handlungsempfehlungen (individual, prioritised recommendations)
 * ----------------------------------------------------------------------------
 * Synthesises the whole analysis (scores, allocation, concentration, growth,
 * income, top-up quality) into concrete, individual recommendations for THIS
 * portfolio. Rule-based and non-advisory ("prüfen", "könnte sinnvoll sein").
 * Each rec: { sev:'high'|'mid'|'low', cat, title, text }.
 * --------------------------------------------------------------------------*/
function buildRecommendations() {
  const ctx = STATE.ctx;
  const active = STATE.active;
  const totalDiv = ctx.totalAnnualDividend;
  const recs = [];

  // --- Portfolio: country concentration ---
  Object.entries(ctx.countryAllocation)
    .filter(([k]) => !isGeneric(k))
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      if (v > 0.6)
        recs.push({ sev: 'high', cat: 'Diversifizieren', title: `Länderklumpen ${fmtCountry(k)} (${fmtPercent(v, 1)})`, text: `Über die Hälfte des Depots entfällt auf ${fmtCountry(k)}. Eine breitere internationale Streuung (z. B. Europa, Emerging Markets) könnte das Klumpenrisiko senken; weitere ${fmtCountry(k)}-Käufe eher zurückstellen.` });
      else if (v > 0.45)
        recs.push({ sev: 'mid', cat: 'Diversifizieren', title: `Hohe ${fmtCountry(k)}-Gewichtung (${fmtPercent(v, 1)})`, text: `${fmtCountry(k)} ist überdurchschnittlich gewichtet. Bei Neukäufen stärker auf andere Regionen achten könnte sinnvoll sein.` });
    });

  // --- Portfolio: sector concentration ---
  Object.entries(ctx.sectorAllocation)
    .filter(([k]) => !isGeneric(k))
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      if (v > 0.25)
        recs.push({ sev: 'high', cat: 'Diversifizieren', title: `Sektor ${k} stark gewichtet (${fmtPercent(v, 1)})`, text: `Der Sektor ${k} macht ${fmtPercent(v, 1)} des Depots aus. Weitere Käufe in diesem Sektor erhöhen das Konzentrationsrisiko; ergänzende Sektoren prüfen.` });
      else if (v > 0.2)
        recs.push({ sev: 'mid', cat: 'Diversifizieren', title: `Sektor ${k} beobachten (${fmtPercent(v, 1)})`, text: `${k} nähert sich einer hohen Gewichtung (${fmtPercent(v, 1)}). Weitere Aufstockungen hier eher zurückhaltend.` });
    });

  // --- Portfolio: income concentration ---
  active
    .map((p) => ({ p, s: totalDiv > 0 ? num0(p.totalDividendRate) / totalDiv : 0 }))
    .filter((x) => x.s > 0.08)
    .sort((a, b) => b.s - a.s)
    .forEach(({ p, s }) => {
      recs.push({ sev: s > 0.1 ? 'high' : 'mid', cat: 'Einkommen', title: `Einkommensklumpen: ${p.symbol} (${fmtPercent(s, 1)} der Dividenden)`, text: `${p.symbol} liefert ${fmtPercent(s, 1)} deiner gesamten Dividenden. Eine Kürzung träfe dein Einkommen spürbar – weitere Aufstockung erhöht die Abhängigkeit.` });
    });

  // --- Position-level ---
  active.forEach((p) => {
    const s = p.scores;
    const alloc = p.allocation || 0;
    const dy = p.dividendYield;
    const cagr = p.dividendCagr;
    const gainRel = p.gainRel;
    // Dividendless assets (crypto, accumulating ETFs) are out of scope for the
    // dividend-focused score -> handled as a separate info hint below, not as a
    // "critical score" risk.
    const nonDividend = num0(p.totalDividendRate) <= 0;

    if (alloc > 0.08)
      recs.push({ sev: 'high', cat: 'Reduzieren', title: `${p.symbol} übergewichtet (${fmtPercent(alloc, 1)})`, text: `${p.symbol} (${p.name}) liegt über 8 % Depotanteil. Eine Teilreduzierung – mindestens aber ein Aufstockungsstopp – könnte das Klumpenrisiko begrenzen.` });
    else if (alloc > 0.05 && (s.total < 55 || (hasNum(cagr) && cagr < 0)))
      recs.push({ sev: 'mid', cat: 'Reduzieren', title: `${p.symbol} groß bei schwachen Signalen (${fmtPercent(alloc, 1)})`, text: `${p.symbol} ist überdurchschnittlich groß und zeigt schwächere Kennzahlen (Score ${s.total}${hasNum(cagr) && cagr < 0 ? `, negativer Dividenden-CAGR ${fmtPercent(cagr, 1)}` : ''}). Reduzierung prüfen und nicht weiter aufstocken.` });

    if (s.total < 40 && !nonDividend)
      recs.push({ sev: 'high', cat: 'Risiko', title: `${p.symbol}: kritischer Score (${s.total})`, text: `${p.symbol} erreicht nur einen Score von ${s.total}. Position kritisch prüfen – nicht aufstocken; ggf. Trennung erwägen.` });

    if (hasNum(dy) && dy > 0.08) {
      if (hasNum(cagr) && cagr < 0)
        recs.push({ sev: 'high', cat: 'Risiko', title: `${p.symbol}: mögliche Renditefalle (${fmtPercent(dy)})`, text: `Sehr hohe Rendite (${fmtPercent(dy)}) bei negativem Dividendenwachstum (${fmtPercent(cagr, 1)}). Dividendensicherheit kritisch prüfen, bevor aufgestockt wird.` });
      else
        recs.push({ sev: 'mid', cat: 'Beobachten', title: `${p.symbol}: hohe Rendite prüfen (${fmtPercent(dy)})`, text: `Auffällig hohe Rendite (${fmtPercent(dy)}). Nachhaltigkeit der Dividende beobachten; nur mit Bedacht aufstocken.` });
    } else if (hasNum(cagr) && cagr < 0 && alloc <= 0.05) {
      recs.push({ sev: 'mid', cat: 'Beobachten', title: `${p.symbol}: rückläufige Dividende`, text: `Negativer Dividenden-CAGR (${fmtPercent(cagr, 1)}). Investmentthese und Dividendensicherheit prüfen.` });
    }

    if (hasNum(gainRel) && gainRel <= -0.15 && num0(p.totalDividendRate) > 0)
      recs.push({ sev: 'mid', cat: 'Beobachten', title: `${p.symbol}: deutlicher Buchverlust (${fmtSignedPercent(gainRel)})`, text: `Trotz laufender Dividende ein klarer Kursverlust. Prüfen, ob die ursprüngliche Investmentthese noch trägt.` });
  });

  // --- Opportunities: strong, underweight add candidates (from top-up model) ---
  const addCands = [];
  active.forEach((p) => {
    const m = topUpMetrics(p, ctx);
    if (!topUpEligible(p, ctx, m)) return;
    const q = topUpQuality(p, m);
    const softCap = topUpSoftCap(q);
    if ((p.allocation || 0) < softCap * 0.6) addCands.push({ p, q, m });
  });
  addCands
    .sort((a, b) => b.q - a.q)
    .slice(0, 4)
    .forEach(({ p, m }) => {
      const sectorHint = !m.genericSector && m.sectorShare < 0.1 ? `, untergewichteter Sektor ${p.sector}` : '';
      recs.push({ sev: 'low', cat: 'Aufstocken', title: `${p.symbol}: Aufstockung könnte sinnvoll sein`, text: `Starker, noch untergewichteter Wert (Score ${p.scores.total}, Anteil ${fmtPercent(p.allocation, 1)}${sectorHint}). Ein schrittweiser Ausbau könnte das Profil verbessern – Details im Aufstock-Plan.` });
    });

  // Dividendless assets (crypto, accumulating ETFs): one informational hint
  // instead of flagging each as a "critical score".
  const nonDivSyms = active.filter((p) => num0(p.totalDividendRate) <= 0).map((p) => p.symbol);
  if (nonDivSyms.length)
    recs.push({ sev: 'info', cat: 'Hinweis', title: `Werte ohne Dividende (${nonDivSyms.length})`, text: `${nonDivSyms.join(', ')} schütten keine Dividende aus (z. B. Krypto oder thesaurierende ETFs). Der dividendenbasierte Score ist für diese Werte nur eingeschränkt aussagekräftig – sie nach eigener Strategie (z. B. Wachstum oder Beimischung) bewerten.` });

  // Dedupe by title, then sort by severity (high -> mid -> low -> info).
  const seen = new Set();
  const order = { high: 0, mid: 1, low: 2, info: 3 };
  return recs
    .filter((r) => (seen.has(r.title) ? false : (seen.add(r.title), true)))
    .sort((a, b) => order[a.sev] - order[b.sev]);
}

function renderRecommendations() {
  if (!STATE.active.length) return;
  const recs = buildRecommendations();
  const sumEl = document.getElementById('recSummary');
  const listEl = document.getElementById('recList');

  if (!recs.length) {
    sumEl.innerHTML = '';
    listEl.innerHTML = '<div class="risk-ok">Aktuell keine dringenden Handlungsempfehlungen aus den CSV-Kennzahlen erkennbar.</div>';
    return;
  }

  const count = (sev) => recs.filter((r) => r.sev === sev).length;
  const parts = [
    ['high', 'hoch'], ['mid', 'mittel'], ['low', 'Chancen'], ['info', 'Hinweise'],
  ]
    .filter(([sev]) => count(sev) > 0)
    .map(([sev, label]) => `<span>${count(sev)} ${label}</span>`)
    .join('');
  sumEl.innerHTML = `<span><strong>${recs.length}</strong> Empfehlungen</span>${parts}`;

  const sevLabel = { high: 'Hoch', mid: 'Mittel', low: 'Chance', info: 'Hinweis' };
  listEl.innerHTML = recs
    .map(
      (r) => `
      <div class="rec-card rec-${r.sev}">
        <div class="rec-head">
          <span class="risk-badge rec-badge-${r.sev}">${sevLabel[r.sev]}</span>
          <span class="rec-cat">${r.cat}</span>
          <span class="rec-title">${escapeHtml(r.title)}</span>
        </div>
        <div class="rec-text">${escapeHtml(r.text)}</div>
      </div>`
    )
    .join('');
}

/* ----------------------------------------------------------------------------
 * Risk & concentration
 * ----------------------------------------------------------------------------
 * Transparent concentration analytics derived from the CSV: HHI / effective
 * number of holdings, top-N share, single-position / sector / country / income
 * concentration, yield-trap flags and an overall diversification score.
 * "mixed" / "Unbekannt" buckets are broad ETFs/funds and are treated as
 * diversified (not flagged as a single-name risk).
 * --------------------------------------------------------------------------*/
const GENERIC_BUCKETS = ['mixed', 'Unbekannt', ''];

function isGeneric(key) {
  return GENERIC_BUCKETS.includes(key);
}

/** Herfindahl-Hirschman Index (sum of squared shares) for a list of fractions. */
function hhi(shares) {
  return shares.reduce((s, w) => s + w * w, 0);
}

/** Effective number of items = 1 / HHI (1 = fully concentrated). */
function effectiveCount(shares) {
  const h = hhi(shares);
  return h > 0 ? 1 / h : 0;
}

function computeRisk() {
  const active = STATE.active;
  const ctx = STATE.ctx;
  const totalValue = ctx.totalValue;
  const totalDiv = ctx.totalAnnualDividend;

  // Position weights (desc).
  const positions = active
    .map((p) => ({ p, w: totalValue > 0 ? num0(p.value) / totalValue : 0 }))
    .sort((a, b) => b.w - a.w);
  const posShares = positions.map((x) => x.w);
  const effN = effectiveCount(posShares);
  const top5 = posShares.slice(0, 5).reduce((s, w) => s + w, 0);
  const top10 = posShares.slice(0, 10).reduce((s, w) => s + w, 0);
  const largest = positions[0] || null;

  // Sector / country shares (entries desc).
  const sectorEntries = Object.entries(ctx.sectorAllocation).sort((a, b) => b[1] - a[1]);
  const countryEntries = Object.entries(ctx.countryAllocation).sort((a, b) => b[1] - a[1]);
  const namedSector = sectorEntries.filter(([k]) => !isGeneric(k));
  const namedCountry = countryEntries.filter(([k]) => !isGeneric(k));
  const largestSector = namedSector[0] || null;
  const largestCountry = namedCountry[0] || null;

  // Income concentration (dividend payers).
  const payers = active
    .map((p) => ({ p, s: totalDiv > 0 ? num0(p.totalDividendRate) / totalDiv : 0 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const incomeShares = payers.map((x) => x.s);
  const effNIncome = effectiveCount(incomeShares);
  const topPayer = payers[0] || null;

  // --- Diversification score (0..100, transparent) ---
  const posDiv = clamp100((effN / 30) * 100); // 30+ effective holdings -> 100
  const sectorDiv = clamp100(100 - (Math.max(0, (largestSector ? largestSector[1] : 0) - 0.1) / 0.25) * 100); // 10%->100, 35%->0
  const countryDiv = clamp100(100 - (Math.max(0, (largestCountry ? largestCountry[1] : 0) - 0.3) / 0.4) * 100); // 30%->100, 70%->0
  const incomeDiv = clamp100((effNIncome / 25) * 100);
  const diversification = Math.round(0.35 * posDiv + 0.25 * sectorDiv + 0.2 * countryDiv + 0.2 * incomeDiv);

  // --- Warnings ---
  const flags = [];
  positions.forEach(({ p, w }) => {
    if (w > 0.08) flags.push({ sev: 'high', text: `Klumpenrisiko: ${p.symbol} macht ${fmtPercent(w, 1)} des Depots aus (> 8 %).` });
    else if (w > 0.05) flags.push({ sev: 'mid', text: `${p.symbol} ist mit ${fmtPercent(w, 1)} überdurchschnittlich groß (> 5 %).` });
  });
  namedSector.forEach(([k, v]) => {
    if (v > 0.3) flags.push({ sev: 'high', text: `Sektor ${k} ist mit ${fmtPercent(v, 1)} sehr hoch gewichtet (> 30 %).` });
    else if (v > 0.2) flags.push({ sev: 'mid', text: `Sektor ${k} ist mit ${fmtPercent(v, 1)} hoch gewichtet (> 20 %).` });
  });
  namedCountry.forEach(([k, v]) => {
    if (v > 0.6) flags.push({ sev: 'high', text: `Land ${fmtCountry(k)} ist mit ${fmtPercent(v, 1)} sehr hoch gewichtet (> 60 %).` });
    else if (v > 0.45) flags.push({ sev: 'mid', text: `Land ${fmtCountry(k)} ist mit ${fmtPercent(v, 1)} hoch gewichtet (> 45 %).` });
  });
  payers.forEach(({ p, s }) => {
    if (s > 0.1) flags.push({ sev: 'high', text: `${p.symbol} liefert ${fmtPercent(s, 1)} der gesamten Dividenden – hohe Einkommenskonzentration.` });
    else if (s > 0.06) flags.push({ sev: 'mid', text: `${p.symbol} liefert ${fmtPercent(s, 1)} der gesamten Dividenden.` });
  });
  active.forEach((p) => {
    const dy = p.dividendYield;
    const cagr = p.dividendCagr;
    if (hasNum(dy) && dy > 0.08) {
      if (hasNum(cagr) && cagr < 0)
        flags.push({ sev: 'high', text: `${p.symbol}: sehr hohe Rendite (${fmtPercent(dy)}) bei negativem Dividendenwachstum – mögliche Renditefalle.` });
      else if (!hasNum(cagr) || cagr < 0.05)
        flags.push({ sev: 'mid', text: `${p.symbol}: sehr hohe Rendite (${fmtPercent(dy)}) bei schwachem Wachstum – kritisch beobachten.` });
    }
  });
  if (effN < 12)
    flags.push({ sev: 'mid', text: `Geringe effektive Streuung: nur ${fmtNumber(effN, 1)} effektive Positionen trotz ${active.length} Werten.` });

  // High severity first.
  flags.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'high' ? -1 : 1));

  return {
    positions, effN, top5, top10, largest,
    sectorEntries, countryEntries, largestSector, largestCountry,
    payers, effNIncome, topPayer,
    diversification, flags,
  };
}

/** Render a list of concentration bars. items: [{label, value, sev, sub}]. */
function concBars(items) {
  if (!items.length) return '<div class="conc-empty">Keine Daten</div>';
  const max = Math.max(...items.map((i) => i.value), 0.0001);
  return items
    .map(
      (i) => `
      <div class="conc-row">
        <span class="conc-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span>
        <span class="conc-track"><span class="conc-fill ${i.sev ? 'conc-' + i.sev : ''}" style="width:${((i.value / max) * 100).toFixed(1)}%"></span></span>
        <span class="conc-val">${fmtPercent(i.value, 1)}</span>
      </div>`
    )
    .join('');
}

function renderRisk() {
  if (!STATE.active.length) return;
  const r = computeRisk();

  // KPI cards.
  const dColor = scoreColor(r.diversification);
  const cards = [
    { label: 'Diversifikations-Score', value: `<span style="color:${dColor}">${r.diversification}</span>`, sub: '0–100 · höher = breiter gestreut' },
    { label: 'Effektive Positionen', value: fmtNumber(r.effN, 1), sub: `von ${r.positions.length} aktiven` },
    { label: 'Größte Position', value: r.largest ? r.largest.p.symbol : 'n/a', sub: r.largest ? fmtPercent(r.largest.w, 1) : '' },
    { label: 'Top-10-Anteil', value: fmtPercent(r.top10, 1), sub: `Top 5: ${fmtPercent(r.top5, 1)}` },
    { label: 'Größter Sektor', value: r.largestSector ? r.largestSector[0] : 'n/a', sub: r.largestSector ? fmtPercent(r.largestSector[1], 1) : '' },
    { label: 'Größtes Land', value: r.largestCountry ? fmtCountry(r.largestCountry[0]) : 'n/a', sub: r.largestCountry ? fmtPercent(r.largestCountry[1], 1) : '' },
    { label: 'Größter Dividendenzahler', value: r.topPayer ? r.topPayer.p.symbol : 'n/a', sub: r.topPayer ? `${fmtPercent(r.topPayer.s, 1)} des Einkommens` : '' },
    { label: 'Risiko-Hinweise', value: fmtNumber(r.flags.length, 0), sub: `${r.flags.filter((f) => f.sev === 'high').length} hoch` },
  ];
  document.getElementById('riskKpis').innerHTML = cards
    .map(
      (c) => `
      <div class="kpi-card">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
        ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
      </div>`
    )
    .join('');

  // Flags.
  const flagsEl = document.getElementById('riskFlags');
  if (!r.flags.length) {
    flagsEl.innerHTML = '<div class="risk-ok">Keine kritischen Klumpenrisiken in den CSV-Kennzahlen erkennbar.</div>';
  } else {
    flagsEl.innerHTML = r.flags
      .map(
        (f) => `<div class="risk-flag risk-${f.sev}"><span class="risk-badge">${f.sev === 'high' ? 'Hoch' : 'Mittel'}</span><span>${escapeHtml(f.text)}</span></div>`
      )
      .join('');
  }

  // Detail bars.
  document.getElementById('riskTopPositions').innerHTML = concBars(
    r.positions.slice(0, 10).map(({ p, w }) => ({
      label: `${p.symbol} · ${p.name}`,
      value: w,
      sev: w > 0.08 ? 'high' : w > 0.05 ? 'mid' : null,
    }))
  );
  document.getElementById('riskIncome').innerHTML = concBars(
    r.payers.slice(0, 10).map(({ p, s }) => ({
      label: `${p.symbol} · ${p.name}`,
      value: s,
      sev: s > 0.1 ? 'high' : s > 0.06 ? 'mid' : null,
    }))
  );
  document.getElementById('riskSectors').innerHTML = concBars(
    r.sectorEntries.map(([k, v]) => ({
      label: isGeneric(k) ? `${k === 'mixed' ? 'Gemischt (ETFs)' : 'Unbekannt'}` : k,
      value: v,
      sev: isGeneric(k) ? null : v > 0.3 ? 'high' : v > 0.2 ? 'mid' : null,
    }))
  );
  document.getElementById('riskCountries').innerHTML = concBars(
    r.countryEntries.map(([k, v]) => ({
      label: isGeneric(k) ? (k === 'mixed' ? 'Gemischt (ETFs)' : 'Unbekannt') : fmtCountry(k),
      value: v,
      sev: isGeneric(k) ? null : v > 0.6 ? 'high' : v > 0.45 ? 'mid' : null,
    }))
  );
}

/* ----------------------------------------------------------------------------
 * Dividend calendar & income projection — shared helpers
 * ----------------------------------------------------------------------------
 * Only the next payDate per position is in the CSV, so the remaining payments
 * are spread over the year from the payDate's month according to the frequency.
 * Everything is derived from the CSV (totalDividendRate, frequency, payDate,
 * taxRate, dividendCagr).
 * --------------------------------------------------------------------------*/
const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Number of payouts per year for a frequency (0 = none). */
function paymentsPerYear(freq) {
  switch ((freq || '').toLowerCase()) {
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'biannually': return 2;
    case 'annually': return 1;
    default: return 0;
  }
}

/** Calendar months (0=Jan) a position pays in, anchored on its payDate month. */
function payMonths(freq, anchorMonth) {
  const ppy = paymentsPerYear(freq);
  if (ppy === 0) return [];
  if (ppy === 12) return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const step = 12 / ppy;
  const anchor = anchorMonth >= 0 ? anchorMonth : 0;
  const out = [];
  for (let k = 0; k < ppy; k++) out.push((anchor + k * step) % 12);
  return out;
}

/** Month index (0..11) from an ISO date, or -1. */
function monthIndexOf(dateStr) {
  const m = String(dateStr || '').match(/^\d{4}-(\d{2})-\d{2}$/);
  return m ? parseInt(m[1], 10) - 1 : -1;
}

/** Parse an ISO date (YYYY-MM-DD) into a Date at local midnight, or null. */
function parseISODate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

/** Per-month gross & net dividend distribution across the calendar year. */
function computeIncomeDistribution() {
  const gross = new Array(12).fill(0);
  const net = new Array(12).fill(0);
  STATE.active.forEach((p) => {
    const total = num0(p.totalDividendRate);
    const ppy = paymentsPerYear(p.dividendFrequency);
    if (total <= 0 || ppy === 0) return;
    const months = payMonths(p.dividendFrequency, monthIndexOf(p.payDate));
    if (!months.length) return;
    const per = total / ppy;
    const taxRate = hasNum(p.taxRate) ? p.taxRate : 0;
    months.forEach((mi) => {
      gross[mi] += per;
      net[mi] += per * (1 - taxRate);
    });
  });
  const grossAnnual = gross.reduce((s, v) => s + v, 0);
  const netAnnual = net.reduce((s, v) => s + v, 0);
  return { gross, net, grossAnnual, netAnnual, taxAnnual: grossAnnual - netAnnual };
}

/** Upcoming dividend payments (next payDate per position), future first. */
function upcomingPayments() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const list = [];
  STATE.active.forEach((p) => {
    const total = num0(p.totalDividendRate);
    const ppy = paymentsPerYear(p.dividendFrequency);
    if (total <= 0 || ppy === 0) return;
    const d = parseISODate(p.payDate);
    if (!d || d < today) return;
    list.push({
      date: d,
      payDate: p.payDate,
      exDate: p.exDate,
      symbol: p.symbol,
      name: p.name,
      freq: p.dividendFrequency,
      per: total / ppy,
    });
  });
  return list.sort((a, b) => a.date - b.date);
}

/* ----------------------------------------------------------------------------
 * Dividend calendar rendering
 * --------------------------------------------------------------------------*/
function renderCalendar() {
  if (!STATE.active.length) return;
  const dist = computeIncomeDistribution();
  const maxMonth = Math.max(...dist.gross, 0.0001);
  const currentMonth = new Date().getMonth();

  // Strongest month + averages.
  let maxIdx = 0;
  dist.gross.forEach((v, i) => {
    if (v > dist.gross[maxIdx]) maxIdx = i;
  });
  const upcoming = upcomingPayments();
  const today = new Date();
  const in30 = new Date();
  in30.setDate(in30.getDate() + 30);
  const next30 = upcoming.filter((u) => u.date <= in30);
  const next30Sum = next30.reduce((s, u) => s + u.per, 0);
  const monthlyPayers = STATE.active.filter((p) => paymentsPerYear(p.dividendFrequency) === 12 && num0(p.totalDividendRate) > 0).length;

  const cards = [
    { label: 'Jährliche Bruttodividende', value: fmtCurrency(dist.grossAnnual) },
    { label: 'Ø Ausschüttung / Monat', value: fmtCurrency(dist.grossAnnual / 12) },
    { label: 'Stärkster Monat', value: MONTHS_DE[maxIdx], sub: fmtCurrency(dist.gross[maxIdx]) },
    {
      label: 'Nächster Zahltag',
      value: upcoming.length ? fmtDate(upcoming[0].payDate) : 'n/a',
      sub: upcoming.length ? upcoming[0].symbol : '',
    },
    { label: 'Nächste 30 Tage', value: fmtCurrency(next30Sum), sub: `${next30.length} Zahlungen` },
    { label: 'Monatliche Zahler', value: fmtNumber(monthlyPayers, 0), sub: 'Positionen' },
  ];
  document.getElementById('calendarKpis').innerHTML = cards
    .map(
      (c) => `<div class="kpi-card kpi-income"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div>${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}</div>`
    )
    .join('');

  // Monthly bars.
  document.getElementById('calMonths').innerHTML = dist.gross
    .map(
      (v, i) => `
      <div class="cal-row ${i === currentMonth ? 'cal-current' : ''}">
        <span class="cal-mlabel">${MONTHS_DE[i]}</span>
        <span class="cal-barwrap"><span class="cal-fill" style="width:${((v / maxMonth) * 100).toFixed(1)}%"></span></span>
        <span class="cal-val">${fmtCurrency(v)}</span>
      </div>`
    )
    .join('');

  // Upcoming table.
  const tbody = document.getElementById('calUpcoming');
  if (!upcoming.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="conc-empty">Keine zukünftigen Zahltermine in der CSV.</td></tr>';
  } else {
    tbody.innerHTML = upcoming
      .slice(0, 24)
      .map(
        (u) => `
        <tr>
          <td>${fmtDate(u.exDate)}</td>
          <td>${fmtDate(u.payDate)}</td>
          <td class="t-sym">${escapeHtml(u.symbol)}</td>
          <td class="t-name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</td>
          <td>${fmtFrequency(u.freq)}</td>
          <td class="t-num">${fmtCurrency(u.per)}</td>
        </tr>`
      )
      .join('');
  }
}

/* ----------------------------------------------------------------------------
 * Income projection rendering
 * --------------------------------------------------------------------------*/
function renderIncome() {
  if (!STATE.active.length) return;
  const dist = computeIncomeDistribution();
  const k = STATE.kpis;

  // Income-weighted dividend CAGR.
  let wSum = 0;
  let wWeight = 0;
  STATE.active.forEach((p) => {
    const t = num0(p.totalDividendRate);
    if (t > 0 && hasNum(p.dividendCagr)) {
      wSum += t * p.dividendCagr;
      wWeight += t;
    }
  });
  const g = wWeight > 0 ? wSum / wWeight : 0;

  const effTaxRate = dist.grossAnnual > 0 ? dist.taxAnnual / dist.grossAnnual : 0;
  const netYield = k.totalValue > 0 ? dist.netAnnual / k.totalValue : NaN;
  const netYoc = k.totalInvested > 0 ? dist.netAnnual / k.totalInvested : NaN;

  const cards = [
    { label: 'Jährliche Bruttodividende', value: fmtCurrency(dist.grossAnnual) },
    { label: 'Jährliche Nettodividende', value: fmtCurrency(dist.netAnnual) },
    { label: 'Ø Netto / Monat', value: fmtCurrency(dist.netAnnual / 12) },
    { label: 'Steuerlast p.a.', value: fmtCurrency(dist.taxAnnual), sub: `effektiv ${fmtPercent(effTaxRate, 1)}` },
    { label: 'Netto-Dividendenrendite', value: fmtPercent(netYield) },
    { label: 'Netto Yield on Cost', value: fmtPercent(netYoc) },
    { label: 'Gewichteter Dividenden-CAGR', value: fmtPercent(g, 1) },
    { label: 'Netto in 5 Jahren (p.a.)', value: fmtCurrency(dist.netAnnual * Math.pow(1 + g, 5)) },
  ];
  document.getElementById('incomeKpis').innerHTML = cards
    .map(
      (c) => `<div class="kpi-card kpi-income"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div>${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}</div>`
    )
    .join('');

  // Monthly net vs gross bars (net = green segment, remainder = tax).
  const maxMonth = Math.max(...dist.gross, 0.0001);
  document.getElementById('incomeMonths').innerHTML = dist.gross
    .map((gv, i) => {
      const nv = dist.net[i];
      const wGross = (gv / maxMonth) * 100;
      const wNet = gv > 0 ? (nv / gv) * 100 : 0;
      return `
      <div class="cal-row">
        <span class="cal-mlabel">${MONTHS_DE[i]}</span>
        <span class="cal-barwrap"><span class="inc-track" style="width:${wGross.toFixed(1)}%"><span class="inc-net" style="width:${wNet.toFixed(1)}%"></span></span></span>
        <span class="cal-val">${fmtCurrency(nv)} <span class="inc-gross">/ ${fmtCurrency(gv)}</span></span>
      </div>`;
    })
    .join('');

  // Projection (current year + 5).
  document.getElementById('incomeCagr').textContent = `(${fmtPercent(g, 1)} p.a.)`;
  const baseYear = new Date().getFullYear();
  const years = [];
  for (let y = 0; y <= 5; y++) years.push({ year: baseYear + y, value: dist.netAnnual * Math.pow(1 + g, y) });
  const maxYear = Math.max(...years.map((y) => y.value), 0.0001);
  document.getElementById('incomeProjection').innerHTML = years
    .map(
      (y, i) => `
      <div class="cal-row ${i === 0 ? 'cal-current' : ''}">
        <span class="cal-mlabel">${y.year}</span>
        <span class="cal-barwrap"><span class="cal-fill" style="width:${((y.value / maxYear) * 100).toFixed(1)}%"></span></span>
        <span class="cal-val">${fmtCurrency(y.value)}</span>
      </div>`
    )
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
