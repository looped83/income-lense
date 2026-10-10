/* ============================================================================
 * app.js — UI controller
 * ----------------------------------------------------------------------------
 * Routing (#view, #view/SYMBOL opens the detail sheet), local persistence,
 * event delegation, reusable HTML components and the view renderers.
 * Views render lazily on first visit; every number comes from analysis.js.
 * ==========================================================================*/

const VIEWS = ['uebersicht', 'empfehlungen', 'risiko', 'einkommen', 'ziel', 'aufstocken', 'positionen'];
const STORE_CSV = 'incomeLense.csv';
const STORE_SETTINGS = 'incomeLense.settings';
const DEFAULTS = { target: 3500, savings: 0, budget: 3000 };
const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const DAY_MS = 864e5;

const STATE = {
  data: null, // result of analyze()
  meta: null, // { name, savedAt } of the loaded CSV
  settings: { ...DEFAULTS, excluded: new Set() },
  ui: { view: null, rec: 'all', action: 'active', sectorMetric: 'value' },
  rendered: new Set(), // views rendered for the current data
  topUp: null, // cached plan { count, plan }
  sheetSymbol: null,
  sheetFromNav: false, // sheet entry was pushed by in-app navigation
};

const $ = (id) => document.getElementById(id);

/* ----------------------------------------------------------------------------
 * Persistence (best effort: private mode / quota errors are ignored)
 * --------------------------------------------------------------------------*/
function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable – the app still works for this session */
  }
}

function restoreSettings() {
  const saved = readStore(STORE_SETTINGS) || {};
  const s = STATE.settings;
  for (const key in DEFAULTS) if (Number.isFinite(saved[key]) && saved[key] >= 0) s[key] = saved[key];
  s.excluded = new Set(Array.isArray(saved.excluded) ? saved.excluded : []);
}

function saveSettings() {
  const s = STATE.settings;
  writeStore(STORE_SETTINGS, { target: s.target, savings: s.savings, budget: s.budget, excluded: [...s.excluded] });
}

/* ----------------------------------------------------------------------------
 * Bootstrapping & data loading
 * --------------------------------------------------------------------------*/
function boot() {
  restoreSettings();
  bindEvents();
  const saved = readStore(STORE_CSV);
  if (saved && saved.text) loadCsv(saved.text, saved.meta, false);
  renderChrome();
  route(false);
}

/** Parse + analyse a CSV. isNew: persist it and reset per-file settings. */
function loadCsv(text, meta, isNew) {
  let data;
  try {
    const positions = parseCsv(text).filter((r) => r.symbol || r.isin).map(buildPosition);
    if (!positions.length) throw new Error('Keine Positionen gefunden.');
    data = analyze(positions);
  } catch (err) {
    console.error(err);
    showError(`Die CSV konnte nicht verarbeitet werden: ${err.message}`);
    return false;
  }
  if (isNew) {
    STATE.settings.excluded.clear();
    saveSettings();
    writeStore(STORE_CSV, { text, meta });
  }
  Object.assign(STATE, { data, meta, topUp: null });
  STATE.rendered.clear();
  STATE.ui.view = null;
  showError('');
  fillPositionFilters();
  return true;
}

function readFile(file) {
  file.text().then(
    (text) => {
      if (!loadCsv(text, { name: file.name, savedAt: Date.now() }, true)) return;
      history.replaceState(null, '', '#' + VIEWS[0]);
      renderChrome();
      route(false);
    },
    (err) => showError(`Die Datei konnte nicht gelesen werden: ${err.message}`)
  );
}

function clearData() {
  if (!confirm('Gespeicherte Depotdaten aus diesem Browser löschen?')) return;
  writeStore(STORE_CSV, null);
  Object.assign(STATE, { data: null, meta: null, topUp: null });
  STATE.rendered.clear();
  STATE.ui.view = null;
  history.replaceState(null, '', location.pathname + location.search);
  renderChrome();
  route(false);
}

function showError(msg) {
  const box = $('errorBox');
  box.textContent = msg;
  box.hidden = !msg;
}

/** Header, tabs and empty state depend only on whether data is loaded. */
function renderChrome() {
  const has = !!STATE.data;
  document.body.classList.toggle('has-data', has);
  $('emptyState').hidden = has;
  $('tabs').hidden = !has;
  $('clearData').hidden = !has;
  $('fileMeta').textContent =
    has && STATE.meta ? `${STATE.meta.name} · ${new Date(STATE.meta.savedAt).toLocaleDateString('de-DE')}` : '';
  if (!has) for (const v of VIEWS) $('view-' + v).hidden = true;
}

/* ----------------------------------------------------------------------------
 * Routing: #view or #view/SYMBOL
 * --------------------------------------------------------------------------*/
function parseHash() {
  const [view, symbol] = location.hash.slice(1).split('/');
  return { view, symbol: symbol ? decodeURIComponent(symbol) : null };
}

function route(fromNav) {
  const sheet = $('sheet');
  if (!STATE.data) {
    if (sheet.open) sheet.close();
    return;
  }
  const { view, symbol } = parseHash();
  showView(VIEWS.includes(view) ? view : VIEWS[0]);
  if (symbol) openSheet(symbol, fromNav);
  else if (sheet.open) sheet.close();
}

function showView(view) {
  if (STATE.ui.view === view) return;
  STATE.ui.view = view;
  for (const v of VIEWS) $('view-' + v).hidden = v !== view;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view !== view) {
      tab.removeAttribute('aria-current');
      continue;
    }
    tab.setAttribute('aria-current', 'page');
    const bar = tab.parentElement;
    bar.scrollLeft = tab.offsetLeft - bar.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2;
  }
  if (!STATE.rendered.has(view)) {
    RENDER[view]();
    STATE.rendered.add(view);
  }
  window.scrollTo(0, 0);
}

/** Link target that opens the detail sheet on top of the current view. */
function detailHref(symbol) {
  return `#${STATE.ui.view}/${encodeURIComponent(symbol)}`;
}

/* ----------------------------------------------------------------------------
 * Events (delegated: one listener per event type)
 * --------------------------------------------------------------------------*/
const ACTIONS = {
  upload: () => $('csvFile').click(),
  clear: clearData,
  'sheet-prev': () => stepSheet(-1),
  'sheet-next': () => stepSheet(1),
  'sheet-close': () => $('sheet').close(),
};

const CHIP_GROUPS = {
  rec: (v) => {
    STATE.ui.rec = v;
    renderRecList();
  },
  action: (v) => {
    STATE.ui.action = v;
    renderPositionRows();
  },
  sectorMetric: (v) => {
    STATE.ui.sectorMetric = v;
    renderSectorBars();
  },
  target: (v) => setSetting('target', Number(v)),
  budget: (v) => setSetting('budget', Number(v)),
};

const INPUTS = {
  targetInput: debounce((el) => {
    const v = parseFloat(el.value);
    if (v > 0) setSetting('target', v);
  }),
  savingsInput: debounce((el) => setSetting('savings', Math.max(0, parseFloat(el.value) || 0))),
  budgetInput: debounce((el) => {
    const v = parseFloat(el.value);
    if (v >= TRANCHE_SIZE) setSetting('budget', v);
  }),
  posSearch: debounce(() => renderPositionRows(), 120),
  posSector: () => renderPositionRows(),
  posCountry: () => renderPositionRows(),
  posSort: () => renderPositionRows(),
};

function bindEvents() {
  window.addEventListener('hashchange', () => route(true));

  $('csvFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) readFile(file);
    e.target.value = ''; // allow re-selecting the same file
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    const action = t.closest('[data-action]');
    if (action) return ACTIONS[action.dataset.action]();
    const chip = t.closest('.chip');
    if (chip) {
      const group = chip.closest('[data-chips]');
      for (const c of group.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === chip));
      return CHIP_GROUPS[group.dataset.chips](chip.dataset.value);
    }
    const row = t.closest('tr[data-open]');
    if (row && !t.closest('a, button, input, label')) location.hash = detailHref(row.dataset.open);
  });

  document.addEventListener('input', (e) => INPUTS[e.target.id]?.(e.target));

  // "Besparen" switches in the target table.
  document.addEventListener('change', (e) => {
    const symbol = e.target.dataset.exclude;
    if (symbol === undefined) return;
    const excluded = STATE.settings.excluded;
    if (e.target.checked) excluded.delete(symbol);
    else excluded.add(symbol);
    saveSettings();
    renderTarget();
    STATE.rendered.delete('uebersicht');
    document.querySelector(`[data-exclude="${CSS.escape(symbol)}"]`)?.focus();
  });

  // Drag & drop a CSV anywhere on the page.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('is-dragging');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('is-dragging');
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  // Detail sheet: backdrop click closes, arrows browse, closing syncs the URL.
  const sheet = $('sheet');
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select')) return;
    if (e.key === 'ArrowLeft') stepSheet(-1);
    if (e.key === 'ArrowRight') stepSheet(1);
  });
  sheet.addEventListener('close', () => {
    const { view, symbol } = parseHash();
    if (!symbol) return;
    if (STATE.sheetFromNav) history.back();
    else history.replaceState(null, '', '#' + view);
  });
}

function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function setSetting(key, value) {
  STATE.settings[key] = value;
  saveSettings();
  if (key === 'budget') {
    renderTopUp();
  } else {
    renderTarget();
    STATE.rendered.delete('uebersicht'); // the overview shows the target progress
  }
}

/** Sync a preset-chips + free-input control with its value. */
function syncValueControl(name, value) {
  const input = $(name + 'Input');
  if (document.activeElement !== input) input.value = value || '';
  for (const chip of document.querySelectorAll(`[data-chips="${name}"] .chip`)) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.value) === value));
  }
}

/* ----------------------------------------------------------------------------
 * Components (HTML strings; callers escape user/CSV text)
 * --------------------------------------------------------------------------*/
function tag(text, tone) {
  return `<span class="tag tone-${tone}">${text}</span>`;
}

function scorePill(score) {
  const l = scoreLevel(score);
  return `<span class="tag tag-score tone-${l.tone}" title="Score ${score} – ${l.label}">${score}</span>`;
}

function actionTag(key) {
  const c = ACTION_CATEGORIES[key];
  return tag(c.label, c.tone);
}

function symLink(p) {
  return `<a class="sym" href="${detailHref(p.symbol)}">${escapeHtml(p.symbol)}</a>`;
}

/** Symbol link + faint name (bar labels, lists). */
function posLabel(p) {
  return `${symLink(p)}<span class="faint">${escapeHtml(p.name)}</span>`;
}

function stat({ label, value, sub = '', tone = '', hero = false }) {
  return `<div class="stat${hero ? ' stat-hero' : ''}">
    <div class="stat-label">${label}</div>
    <div class="stat-value${tone ? ` tone-text tone-${tone}` : ''}">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

/**
 * Bar list. items: { label (HTML), value, tone?, current?, segments? }.
 * segments: [{ value, tone }] for a stacked bar (2 px surface gap between).
 */
function bars(items, { max, tone = 'blue', format = (v) => fmtPercent(v, 1), cls = '', empty = 'Keine Daten' } = {}) {
  if (!items.length) return `<p class="empty-note">${empty}</p>`;
  const top = max ?? Math.max(...items.map((i) => i.value), 1e-9);
  const rows = items.map((i) => {
    const width = Math.min(100, (i.value / top) * 100).toFixed(1);
    const segs = (i.segments || [{ value: i.value, tone: i.tone || tone }]).filter((s) => s.value > 0);
    const segSum = segs.reduce((s, x) => s + x.value, 0);
    return `<div class="bar-row${i.current ? ' is-current' : ''}">
      <span class="bar-label">${i.label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${width}%">${segs
        .map((s) => `<span class="bar-seg tone-${s.tone}" style="flex:${((s.value / segSum) * 100).toFixed(2)}"></span>`)
        .join('')}</span></span>
      <span class="bar-value">${format(i.value, i)}</span>
    </div>`;
  });
  return `<div class="bars ${cls}">${rows.join('')}</div>`;
}

/** Progress meter; segments [{ value, tone }] stack against max (capped at 100 %). */
function meter(segments, max, label) {
  let left = 100;
  const spans = segments.map((s) => {
    const w = Math.min(left, max > 0 ? (s.value / max) * 100 : 0);
    left -= w;
    return w > 0 ? `<span class="tone-${s.tone}" style="width:${w.toFixed(1)}%"></span>` : '';
  });
  return `<div class="meter" role="img" aria-label="${escapeHtml(label)}">${spans.join('')}</div>`;
}

/** Chip buttons; items: { value, label, count?, tone? }. */
function chips(items, active) {
  return items
    .map(
      (i) => `<button type="button" class="chip" data-value="${i.value}" aria-pressed="${i.value === active}">${
        i.tone ? `<span class="dot tone-${i.tone}"></span>` : ''
      }${i.label}${i.count !== undefined ? ` <span class="chip-count">${i.count}</span>` : ''}</button>`
    )
    .join('');
}

/** Legend; items: [label, tone]. */
function legend(items) {
  return `<span class="legend">${items.map(([label, t]) => `<span class="key tone-${t}">${label}</span>`).join('')}</span>`;
}

/** Legend for the orange / red warning limits of a {mid, high} threshold. */
function limitLegend(limit) {
  return legend([
    [`> ${fmtPercent(limit.mid, 0)}`, 'orange'],
    [`> ${fmtPercent(limit.high, 0)}`, 'red'],
  ]);
}

const sevTone = (sev) => (sev ? SEVERITY[sev].tone : 'blue');

function scoreRing(score) {
  const l = scoreLevel(score);
  const c = 2 * Math.PI * 52;
  return `<div class="ring tone-${l.tone}" role="img" aria-label="Score ${score} von 100, ${l.label}">
    <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" stroke-dasharray="${((score / 100) * c).toFixed(1)} ${c.toFixed(1)}"/></svg>
    <div class="ring-text"><span class="ring-num">${score}</span><span class="ring-lbl">${l.label}</span></div>
  </div>`;
}

function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}

/* ----------------------------------------------------------------------------
 * Übersicht
 * --------------------------------------------------------------------------*/
function renderOverview() {
  const d = STATE.data;
  const k = d.kpis;
  const inc = d.income;
  const r = d.risk;
  const gainTone = k.gain >= 0 ? 'green' : 'red';
  const div = scoreLevel(r.diversification);

  $('ovHero').innerHTML = [
    stat({
      hero: true,
      label: 'Depotwert',
      value: fmtCurrency(k.totalValue, 0),
      sub: `<span class="tone-text tone-${gainTone}">${fmtSignedCurrency(k.gain, 0)} (${fmtSignedPercent(k.gainRel, 1)})</span> · investiert ${fmtCurrency(k.invested, 0)}`,
    }),
    stat({
      hero: true,
      label: 'Dividenden p.a. brutto',
      value: fmtCurrency(inc.grossAnnual, 0),
      sub: `${fmtCurrency(inc.grossAnnual / 12, 0)} pro Monat · netto ${fmtCurrency(inc.netAnnual / 12, 0)}`,
    }),
  ].join('');

  $('ovStats').innerHTML = [
    stat({ label: 'Dividendenrendite', value: fmtPercent(k.weightedYield), sub: 'gewichtet' }),
    stat({ label: 'Yield on Cost', value: fmtPercent(k.weightedYoc), sub: 'auf den Einstand' }),
    stat({ label: 'Positionen', value: k.activeCount, sub: `${k.payerCount} Dividendenzahler` }),
    stat({ label: 'Diversifikation', value: `${r.diversification}<small> / 100</small>`, sub: tag(div.label, div.tone) }),
    stat({
      label: 'Größter Einzelwert',
      value: r.largestSingle ? symLink(r.largestSingle) : NA,
      sub: r.largestSingle ? `${fmtPercent(r.largestSingle.allocation, 1)} des Depots` : '',
    }),
    stat({
      label: 'Größter Zahler',
      value: k.largestPayer ? symLink(k.largestPayer) : NA,
      sub: k.largestPayer ? `${fmtCurrency(k.largestPayer.totalDividendRate, 0)} pro Jahr` : '',
    }),
  ].join('');

  // Quick look: urgent findings, next payments, target progress.
  const counts = countBy(d.recs, 'sev');
  const urgent = d.recs.filter((x) => x.sev === 'high' || x.sev === 'mid').slice(0, 4);
  const until = Date.now() + 30 * DAY_MS;
  const next30 = d.upcoming.filter((u) => u.date <= until);
  const t = computeTarget(d, STATE.settings);
  const goal = STATE.settings.target;
  const projM = t.projectedNet / 12;

  $('ovCards').innerHTML = `
    <article class="card">
      <div class="card-head">
        <h2 class="card-title">Handlungsbedarf</h2>
        <span class="legend">${['high', 'mid', 'low'].filter((s) => counts[s]).map((s) => tag(`${counts[s]} ${SEVERITY[s].plural}`, SEVERITY[s].tone)).join(' ')}</span>
      </div>
      <ul class="ov-list">${
        urgent.map((x) => `<li>${tag(SEVERITY[x.sev].label, SEVERITY[x.sev].tone)}<span class="ov-text">${escapeHtml(x.title)}</span></li>`).join('') ||
        '<li class="muted">Keine dringenden Punkte.</li>'
      }</ul>
      <a class="link card-foot" href="#empfehlungen">Alle ${d.recs.length} Empfehlungen →</a>
    </article>
    <article class="card">
      <div class="card-head">
        <h2 class="card-title">Nächste Zahlungen</h2>
        <span class="card-note">${fmtCurrency(next30.reduce((s, u) => s + u.amount, 0), 0)} in 30 Tagen</span>
      </div>
      <ul class="ov-list">${
        d.upcoming
          .slice(0, 4)
          .map((u) => `<li><span class="ov-date">${fmtDate(u.p.payDate, true)}</span><span class="ov-text">${posLabel(u.p)}</span><span class="ov-amount">${fmtCurrency(u.amount)}</span></li>`)
          .join('') || '<li class="muted">Keine Termine in der CSV.</li>'
      }</ul>
      <a class="link card-foot" href="#einkommen">Kalender &amp; Prognose →</a>
    </article>
    <article class="card">
      <div class="card-head">
        <h2 class="card-title">Ziel ${TARGET_YEAR}</h2>
        <span class="card-note">${fmtPercent(goal > 0 ? projM / goal : 0, 0)} erreicht</span>
      </div>
      ${meter([{ value: t.projectedNet, tone: 'green' }], t.targetAnnual, 'Fortschritt zum Monatsziel')}
      <p><strong>${fmtCurrency(projM, 0)}</strong> <span class="muted">von ${fmtCurrency(goal, 0)} netto pro Monat (organisch)</span></p>
      <p class="muted">${t.reached ? 'Ziel organisch erreicht.' : `Lücke: ${fmtCurrency(t.gap / 12, 0)} pro Monat`}</p>
      <a class="link card-foot" href="#ziel">Ziel ${TARGET_YEAR} →</a>
    </article>`;
}

/* ----------------------------------------------------------------------------
 * Empfehlungen
 * --------------------------------------------------------------------------*/
function renderRecs() {
  const recs = STATE.data.recs;
  const counts = countBy(recs, 'sev');
  const items = [{ value: 'all', label: 'Alle', count: recs.length }];
  for (const [sev, s] of Object.entries(SEVERITY)) {
    if (counts[sev]) items.push({ value: sev, label: s.plural, tone: s.tone, count: counts[sev] });
  }
  if (!items.some((i) => i.value === STATE.ui.rec)) STATE.ui.rec = 'all';
  $('recFilter').innerHTML = chips(items, STATE.ui.rec);

  const L = LIMITS;
  const range = (l) => `> ${fmtPercent(l.mid, 0)} / > ${fmtPercent(l.high, 0)}`;
  $('recMethod').innerHTML = `
    <p>Eine Liste für alle Hinweise: Konzentration, Risiko, Wachstum, Einkommen und Chancen aus dem Aufstockplan.</p>
    <p><strong>Schwellen (mittel / hoch)</strong>: Einzelwert ${range(L.position)}, Sektor ${range(L.sector)}, Land ${range(L.country)}, Anteil an den Dividenden ${range(L.income)}. Rendite über ${fmtPercent(L.highYield, 0)} ohne Dividendenwachstum ≥ ${fmtPercent(L.solidGrowth, 0)}; Buchverlust ab ${fmtPercent(L.drawdown, 0)}; weniger als ${L.minEffective} effektive Positionen.</p>
    <p>Breit streuende ETFs/Fonds verteilen ihr Gewicht auf viele Unternehmen und zählen nicht als Einzelwert- oder Einkommensklumpen.</p>`;
  renderRecList();
}

function renderRecList() {
  const f = STATE.ui.rec;
  const list = STATE.data.recs.filter((r) => f === 'all' || r.sev === f);
  $('recList').innerHTML = list.length
    ? list.map(recHtml).join('')
    : '<p class="notice tone-green">Aktuell keine Handlungsempfehlungen aus den CSV-Kennzahlen erkennbar.</p>';
}

function recHtml(r) {
  const s = SEVERITY[r.sev];
  return `<article class="rec tone-${s.tone}">
    <div class="rec-head">${tag(s.label, s.tone)}<span class="rec-cat">${r.cat}</span>${
      r.symbol ? `<a class="link" href="${detailHref(r.symbol)}">Details</a>` : ''
    }</div>
    <h2 class="rec-title">${escapeHtml(r.title)}</h2>
    <p class="rec-text">${escapeHtml(r.text)}</p>
  </article>`;
}

/* ----------------------------------------------------------------------------
 * Risiko
 * --------------------------------------------------------------------------*/
function renderRisk() {
  const d = STATE.data;
  const r = d.risk;
  const counts = countBy(d.recs, 'sev');
  const div = scoreLevel(r.diversification);
  const top = r.payers[0];

  $('riskStats').innerHTML = [
    stat({ label: 'Diversifikation', value: `${r.diversification}<small> / 100</small>`, sub: tag(div.label, div.tone) }),
    stat({ label: 'Effektive Positionen', value: fmtNumber(r.effN, 1), sub: `von ${d.active.length} Werten` }),
    stat({
      label: 'Größter Einzelwert',
      value: r.largestSingle ? symLink(r.largestSingle) : NA,
      sub: r.largestSingle ? fmtPercent(r.largestSingle.allocation, 1) : '',
    }),
    stat({ label: 'Top-10-Anteil', value: fmtPercent(r.top10, 1), sub: `Top 5: ${fmtPercent(r.top5, 1)}` }),
    stat({
      label: 'Größter Sektor',
      value: r.largestSector ? escapeHtml(r.largestSector[0]) : NA,
      sub: r.largestSector ? fmtPercent(r.largestSector[1], 1) : '',
    }),
    stat({
      label: 'Größtes Land',
      value: r.largestCountry ? escapeHtml(fmtCountry(r.largestCountry[0])) : NA,
      sub: r.largestCountry ? fmtPercent(r.largestCountry[1], 1) : '',
    }),
    stat({ label: 'Größter Zahler', value: top ? symLink(top.p) : NA, sub: top ? `${fmtPercent(top.s, 1)} der Dividenden` : '' }),
    stat({
      label: 'Handlungsbedarf',
      value: (counts.high || 0) + (counts.mid || 0),
      sub: `<a class="link" href="#empfehlungen">${counts.high || 0} hoch · ${counts.mid || 0} mittel →</a>`,
    }),
  ].join('');

  $('legendPosition').innerHTML = limitLegend(LIMITS.position);
  $('legendIncome').innerHTML = limitLegend(LIMITS.income);
  $('legendCountry').innerHTML = limitLegend(LIMITS.country);

  $('riskPositions').innerHTML = bars(
    r.byWeight.slice(0, 10).map((p) => ({
      label: posLabel(p),
      value: p.allocation,
      tone: isDiversified(p) ? 'blue' : sevTone(sevOf(p.allocation, LIMITS.position)),
    }))
  );
  $('riskPayers').innerHTML = bars(
    r.payers.slice(0, 10).map(({ p, s }) => ({
      label: posLabel(p),
      value: s,
      tone: isDiversified(p) ? 'blue' : sevTone(sevOf(s, LIMITS.income)),
    }))
  );
  $('riskCountries').innerHTML = bars(
    r.countryEntries.map(([k, v]) => ({
      label: escapeHtml(fmtCountry(k)),
      value: v,
      tone: isGenericBucket(k) ? 'blue' : sevTone(sevOf(v, LIMITS.country)),
    }))
  );
  $('riskTypes').innerHTML = bars(r.typeEntries.map(([k, v]) => ({ label: escapeHtml(fmtSecurityType(k)), value: v })));
  $('riskCurrencies').innerHTML = bars(r.currencyEntries.map(([k, v]) => ({ label: escapeHtml(k), value: v })));
  renderSectorBars();
}

/** Sectors by portfolio value (with limits) or by dividend contribution. */
function renderSectorBars() {
  const r = STATE.data.risk;
  const byValue = STATE.ui.sectorMetric === 'value';
  const entries = byValue ? r.sectorEntries : r.sectorIncomeEntries;
  $('riskSectors').innerHTML =
    (byValue ? limitLegend(LIMITS.sector) : '<span class="card-note">Anteil an den Dividenden</span>') +
    bars(
      entries.map(([k, v]) => ({
        label: escapeHtml(fmtSector(k)),
        value: v,
        tone: byValue && !isGenericBucket(k) ? sevTone(sevOf(v, LIMITS.sector)) : 'blue',
      })),
      { cls: 'section' }
    );
}

/* ----------------------------------------------------------------------------
 * Einkommen
 * --------------------------------------------------------------------------*/
function renderIncome() {
  const d = STATE.data;
  const inc = d.income;
  const k = d.kpis;
  const until = Date.now() + 30 * DAY_MS;
  const next30 = d.upcoming.filter((u) => u.date <= until);

  $('incStats').innerHTML = [
    stat({ label: 'Brutto p.a.', value: fmtCurrency(inc.grossAnnual, 0) }),
    stat({ label: 'Netto p.a.', value: fmtCurrency(inc.netAnnual, 0) }),
    stat({ label: 'Netto pro Monat', value: fmtCurrency(inc.netAnnual / 12, 0), sub: 'Durchschnitt' }),
    stat({
      label: 'Steuern p.a.',
      value: fmtCurrency(inc.taxAnnual, 0),
      sub: `effektiv ${fmtPercent(inc.grossAnnual > 0 ? inc.taxAnnual / inc.grossAnnual : 0, 1)}`,
    }),
    stat({ label: 'Netto-Rendite', value: fmtPercent(k.totalValue > 0 ? inc.netAnnual / k.totalValue : NaN) }),
    stat({ label: 'Netto Yield on Cost', value: fmtPercent(k.invested > 0 ? inc.netAnnual / k.invested : NaN) }),
    stat({ label: 'Dividenden-CAGR', value: fmtPercent(d.cagr, 1), sub: 'einkommensgewichtet' }),
    stat({
      label: 'Nächste 30 Tage',
      value: fmtCurrency(next30.reduce((s, u) => s + u.amount, 0), 0),
      sub: `${next30.length} Zahlungen, brutto`,
    }),
  ].join('');

  const month = new Date().getMonth();
  $('legendMonths').innerHTML = legend([['netto', 'green'], ['Steuer', 'faint']]);
  $('incMonths').innerHTML = bars(
    inc.gross.map((g, i) => ({
      label: MONTHS_DE[i],
      value: g,
      net: inc.net[i],
      current: i === month,
      segments: [
        { value: inc.net[i], tone: 'green' },
        { value: g - inc.net[i], tone: 'faint' },
      ],
    })),
    {
      cls: 'bars-short',
      format: (g, i) => `${fmtCurrency(i.net, 0)}<span class="faint hide-sm"> / ${fmtCurrency(g, 0)}</span>`,
    }
  );

  const year = new Date().getFullYear();
  $('incCagrNote').textContent = `${fmtPercent(d.cagr, 1)} Wachstum p.a.`;
  $('incProjection').innerHTML = bars(
    Array.from({ length: 6 }, (_, y) => ({
      label: String(year + y),
      value: inc.netAnnual * Math.pow(1 + d.cagr, y),
      current: y === 0,
    })),
    { cls: 'bars-short', tone: 'green', format: (v) => fmtCurrency(v, 0) }
  );

  // Upcoming payments grouped by month.
  const groups = new Map();
  for (const u of d.upcoming) {
    const key = u.date.getFullYear() * 12 + u.date.getMonth();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  $('incUpcoming').innerHTML =
    [...groups.values()]
      .map(
        (list) => `<div class="pay-month">
        <div class="pay-head"><span>${MONTHS_LONG[list[0].date.getMonth()]} ${list[0].date.getFullYear()}</span><span>${fmtCurrency(list.reduce((s, u) => s + u.amount, 0), 0)}</span></div>
        ${list
          .map(
            (u) => `<div class="pay-row">
          <span class="pay-date">${fmtDate(u.p.payDate, true)}</span>
          <span class="pay-main"><span class="pay-title">${posLabel(u.p)}</span><span class="pay-sub">Ex-Tag ${fmtDate(u.p.exDate, true)} · ${fmtFrequency(u.p.dividendFrequency)}</span></span>
          <span class="num">${fmtCurrency(u.amount)}</span>
        </div>`
          )
          .join('')}
      </div>`
      )
      .join('') || '<p class="empty-note">Keine zukünftigen Zahltermine in der CSV.</p>';
}

/* ----------------------------------------------------------------------------
 * Ziel 2033
 * --------------------------------------------------------------------------*/
function renderTarget() {
  const d = STATE.data;
  const s = STATE.settings;
  syncValueControl('target', s.target);
  if (document.activeElement !== $('savingsInput')) $('savingsInput').value = s.savings || '';

  const t = computeTarget(d, s);
  const projM = t.projectedNet / 12;
  const gapM = t.gap / 12;
  const withSavingsM = (t.projectedNet + t.savingsAnnual) / 12;

  let summary;
  if (t.reached) {
    summary = 'Ziel organisch erreicht – ohne weitere Käufe.';
  } else if (t.noneFunded) {
    summary = 'Alle Werte sind vom Besparen ausgeschlossen – aktiviere unten mindestens einen, um den Kapitalbedarf zu sehen.';
  } else {
    summary = `Noch ${t.years} Jahre bis ${TARGET_YEAR}; es fehlen ${fmtCurrency(gapM, 0)} pro Monat.`;
    if (s.target >= 3500 && t.lump > d.kpis.totalValue * 1.5) {
      summary += ' Das Ziel ist ambitioniert – mit 2.000 € siehst du eine realistischere Variante.';
    }
  }
  const scenario =
    s.savings > 0
      ? `<p>Mit <strong>${fmtCurrency(s.savings, 0)}</strong> Sparrate pro Monat erreichst du ca. <strong>${fmtCurrency(withSavingsM, 0)}</strong> netto pro Monat (${fmtPercent(withSavingsM / s.target, 0)} des Ziels)${withSavingsM >= s.target ? ' – Ziel erreicht' : ''}.</p>`
      : '';

  $('targetProgress').innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${fmtCurrency(projM, 0)} <span class="muted">von ${fmtCurrency(s.target, 0)} netto pro Monat</span></h2>
      ${s.savings > 0 ? legend([['organisch', 'green'], ['mit Sparrate', 'blue']]) : `<span class="card-note">${fmtPercent(projM / s.target, 0)} erreicht</span>`}
    </div>
    ${meter(
      [
        { value: t.projectedNet, tone: 'green' },
        { value: t.savingsAnnual, tone: 'blue' },
      ],
      t.targetAnnual,
      'Fortschritt zum Monatsziel'
    )}
    <p class="muted">${summary}</p>${scenario}`;

  $('targetStats').innerHTML = [
    stat({ label: 'Netto heute / Monat', value: fmtCurrency(t.currentNet / 12, 0), sub: `${fmtCurrency(t.currentNet, 0)} p.a.` }),
    stat({ label: `Projektion ${TARGET_YEAR} / Monat`, value: fmtCurrency(projM, 0), sub: 'organisch, ohne Käufe' }),
    stat({ label: 'Lücke / Monat', value: t.reached ? 'erreicht' : fmtCurrency(gapM, 0), tone: t.reached ? 'green' : 'red' }),
    stat({ label: 'Einmalbetrag', value: fmtCurrency(t.lump, 0), sub: `bei ${fmtPercent(t.yPort)} Netto-Rendite` }),
    stat({ label: 'Sparrate nötig / Monat', value: fmtCurrency(t.monthly, 0), sub: `${t.years} Jahre lang` }),
    stat({ label: 'Ø Dividendenwachstum', value: fmtPercent(t.gAvg, 1), sub: 'einkommensgewichtet' }),
  ].join('');

  $('targetNote').textContent = t.reached
    ? 'Ziel erreicht – kein zusätzlicher Kapitalbedarf. Die Schalter bleiben für Szenarien aktiv.'
    : `${fmtCurrency(t.gap, 0)} fehlende Netto-Dividende p.a., nach Score verteilt auf ${t.fundedCount} besparte Werte. Schalter aus = Wert wächst nur organisch weiter.`;
  $('targetBody').innerHTML = t.rows.map((r) => targetRowHtml(r, t.reached)).join('');
}

function targetRowHtml(r, reached) {
  const p = r.p;
  const sym = escapeHtml(p.symbol);
  const dash = r.excluded || reached;
  return `<tr class="${r.excluded ? 'row-off' : ''}" data-open="${sym}">
    <td class="c-lead"><label class="switch" title="Beim Besparen berücksichtigen">
      <input type="checkbox" data-exclude="${sym}"${r.excluded ? '' : ' checked'} /><span class="switch-ui"></span><span class="sr-only">${sym} besparen</span>
    </label></td>
    <td class="c-main">${symLink(p)}<span class="sub">${escapeHtml(p.name)}</span></td>
    <td class="c-key num">${dash ? NA : fmtCurrency(r.addCapital, 0)}</td>
    <td class="c-br"></td>
    <td class="num" data-label="heute">${fmtCurrency(r.netNow, 0)}</td>
    <td class="num" data-label="${TARGET_YEAR}">${fmtCurrency(r.netProj, 0)}</td>
    <td class="num" data-label="Zusatz-Div.">${dash ? NA : fmtCurrency(r.share, 0)}</td>
    <td class="num c-score">${scorePill(p.scores.total)}</td>
  </tr>`;
}

/* ----------------------------------------------------------------------------
 * Aufstocken
 * --------------------------------------------------------------------------*/
function renderTopUp() {
  const s = STATE.settings;
  syncValueControl('budget', s.budget);
  $('topupMethod').innerHTML = `
    <p><strong>Kandidaten</strong> = Kategorie „Aufstocken“: Score ≥ ${LIMITS.minAddScore}, Dividendenzahler, keine Beobachten-Signale und Luft bis zum Zielgewicht.</p>
    <p><strong>Zielgewicht</strong> je Wert ${fmtPercent(TOPUP_SOFT_MIN, 0)}–${fmtPercent(TOPUP_SOFT_MAX, 0)} nach Qualität (Score, Diversifikation, Wachstum, Rendite); harte Grenze ${fmtPercent(TOPUP_HARD_CAP, 0)}.</p>
    <p><strong>Verteilung</strong> proportional zu Qualität × Untergewichtung, ausgegeben in Tranchen à ${fmtCurrency(TRANCHE_SIZE, 0)}. Nach jeder Tranche werden Anteile und Ranking neu berechnet.</p>`;

  const count = Math.max(1, Math.floor(s.budget / TRANCHE_SIZE));
  if (!STATE.topUp || STATE.topUp.count !== count) {
    STATE.topUp = { count, plan: buildTopUpPlan(STATE.data.active, count) };
  }
  const { tranches, perPosition, candidateCount } = STATE.topUp.plan;

  if (!tranches.length) {
    $('topupSummary').innerHTML =
      '<p class="empty-note">Derzeit keine Aufstockungskandidaten – alle Werte sind am Zielgewicht oder haben Beobachten-Signale.</p>';
    $('topupTranches').innerHTML = '';
    return;
  }
  const planned = tranches.length * TRANCHE_SIZE;
  const rest = count * TRANCHE_SIZE - planned;
  $('topupSummary').innerHTML = `
    <div class="card-head">
      <h2 class="card-title">Verteilung</h2>
      <span class="card-note">${tranches.length} Tranchen · ${fmtCurrency(planned, 0)} · ${candidateCount} Kandidaten</span>
    </div>
    ${bars(
      perPosition.map((x) => ({ label: posLabel(x.p), value: x.amount, count: x.count })),
      { max: planned, tone: 'green', format: (v, i) => `${fmtCurrency(v, 0)} <span class="faint">${i.count}×</span>` }
    )}
    ${rest > 0 ? `<p class="card-note">${fmtCurrency(rest, 0)} nicht verplant – alle Kandidaten erreichen ihr Zielgewicht.</p>` : ''}`;
  $('topupTranches').innerHTML = tranches.map((t) => trancheHtml(t, tranches.length <= 3)).join('');
}

function trancheHtml(t, open) {
  const p = t.p;
  return `<details class="card tranche"${open ? ' open' : ''}>
    <summary>
      <span class="tranche-n">${t.n}</span>
      <span class="tranche-id">${posLabel(p)}</span>
      ${scorePill(t.score)}
      <span class="tranche-amount">${fmtCurrency(TRANCHE_SIZE, 0)}</span>
    </summary>
    <div class="tranche-body">
      <div class="alloc-line">
        <span>Anteil ${fmtPercent(t.oldAlloc, 1)} → <strong>${fmtPercent(t.newAlloc, 1)}</strong></span>
        <span class="faint">Ziel ~${fmtPercent(t.target, 1)}</span>
      </div>
      ${meter(
        [
          { value: t.oldAlloc, tone: 'blue' },
          { value: t.newAlloc - t.oldAlloc, tone: 'green' },
        ],
        Math.max(t.target, t.newAlloc),
        'Anteil vor und nach der Tranche im Verhältnis zum Zielgewicht'
      )}
      <p class="faint">${escapeHtml(fmtSector(p.sector))} · ${escapeHtml(fmtCountry(p.country))} · ${fmtSecurityType(p.securityType)}</p>
      <h3 class="inset-title">Wieso?</h3>
      <ul class="bullets">${t.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    </div>
  </details>`;
}

/* ----------------------------------------------------------------------------
 * Positionen (incl. categories and inactive positions)
 * --------------------------------------------------------------------------*/
const SORTERS = {
  value: (a, b) => num0(b.value) - num0(a.value),
  score: (a, b) => b.scores.total - a.scores.total,
  dividend: (a, b) => num0(b.totalDividendRate) - num0(a.totalDividendRate),
  yield: (a, b) => num0(b.dividendYield) - num0(a.dividendYield),
  cagr: (a, b) => num0(b.dividendCagr) - num0(a.dividendCagr),
  gain: (a, b) => num0(b.gainRel) - num0(a.gainRel),
};

function fillPositionFilters() {
  const ps = STATE.data.positions;
  const options = (values, allLabel, fmt) =>
    `<option value="">${allLabel}</option>` +
    [...new Set(values)]
      .sort()
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(fmt(v))}</option>`)
      .join('');
  $('posSector').innerHTML = options(ps.map((p) => p.sector), 'Alle Sektoren', fmtSector);
  $('posCountry').innerHTML = options(ps.map((p) => p.country), 'Alle Länder', fmtCountry);
  $('posSearch').value = '';
}

function renderPositions() {
  const d = STATE.data;
  const counts = countBy(d.positions, 'action');
  const items = [{ value: 'active', label: 'Alle aktiven', count: d.active.length }];
  for (const [key, c] of Object.entries(ACTION_CATEGORIES)) {
    if (counts[key]) items.push({ value: key, label: c.label, tone: c.tone, count: counts[key] });
  }
  if (!items.some((i) => i.value === STATE.ui.action)) STATE.ui.action = 'active';
  $('posChips').innerHTML = chips(items, STATE.ui.action);
  renderPositionRows();
}

function renderPositionRows() {
  const d = STATE.data;
  const f = STATE.ui.action;
  const q = $('posSearch').value.trim().toLowerCase();
  const sector = $('posSector').value;
  const country = $('posCountry').value;
  const base = f === 'active' ? d.active : d.positions.filter((p) => p.action === f);
  const rows = base
    .filter(
      (p) =>
        (!sector || p.sector === sector) &&
        (!country || p.country === country) &&
        (!q || `${p.symbol} ${p.name} ${p.isin}`.toLowerCase().includes(q))
    )
    .sort(SORTERS[$('posSort').value] || SORTERS.value);

  $('posNote').textContent =
    `${rows.length} von ${base.length} Werten` + (f === 'active' ? '' : ` · ${ACTION_CATEGORIES[f].desc}`);
  $('posBody').innerHTML = rows.length
    ? rows.map(positionRowHtml).join('')
    : '<tr><td colspan="10" class="empty-note">Keine Treffer.</td></tr>';
}

function positionRowHtml(p) {
  const active = p.isActive;
  const ifActive = (fn) => (active ? fn() : NA);
  const gainTone = num0(p.gainRel) >= 0 ? 'green' : 'red';
  return `<tr class="edge tone-${ACTION_CATEGORIES[p.action].tone}" data-open="${escapeHtml(p.symbol)}">
    <td class="c-main">${symLink(p)}<span class="sub">${escapeHtml(p.name)}</span></td>
    <td class="c-key num">${ifActive(() => fmtCurrency(p.value))}</td>
    <td class="c-br"></td>
    <td class="num" data-label="Anteil">${ifActive(() => fmtPercent(p.allocation, 1))}</td>
    <td class="num hide-sm">${ifActive(() => `<span class="tone-text tone-${gainTone}">${fmtSignedPercent(p.gainRel, 1)}</span>`)}</td>
    <td class="num" data-label="Rendite">${fmtPercent(p.dividendYield)}</td>
    <td class="num hide-sm">${fmtPercent(p.dividendYieldOnBuyin)}</td>
    <td class="num" data-label="Div.">${active && paysDividend(p) ? fmtCurrency(p.totalDividendRate) : NA}</td>
    <td class="num hide-sm">${fmtPercent(p.dividendCagr, 1)}</td>
    <td class="num c-score">${scorePill(p.scores.total)}</td>
    <td class="hide-sm">${actionTag(p.action)}</td>
  </tr>`;
}

/* ----------------------------------------------------------------------------
 * Detail sheet
 * --------------------------------------------------------------------------*/
function openSheet(symbol, fromNav) {
  const d = STATE.data;
  const sheet = $('sheet');
  const p = d.positions.find((x) => x.symbol === symbol);
  if (!p) {
    history.replaceState(null, '', '#' + STATE.ui.view);
    if (sheet.open) sheet.close();
    return;
  }
  if (!sheet.open) STATE.sheetFromNav = fromNav;
  STATE.sheetSymbol = symbol;

  const i = d.ranked.indexOf(p);
  $('sheetPos').textContent = p.isActive ? `Rang ${p.rank} von ${d.ranked.length} nach Score` : 'Inaktiv';
  sheet.querySelector('[data-action="sheet-prev"]').disabled = i <= 0;
  sheet.querySelector('[data-action="sheet-next"]').disabled = i < 0 || i >= d.ranked.length - 1;
  $('sheetBody').innerHTML = detailHtml(p);
  $('sheetBody').scrollTop = 0;
  if (!sheet.open) sheet.showModal();
}

/** Browse by score rank; replaces the history entry instead of stacking. */
function stepSheet(dir) {
  const ranked = STATE.data.ranked;
  const next = ranked[ranked.findIndex((p) => p.symbol === STATE.sheetSymbol) + dir];
  if (next && $('sheet').open) location.replace(detailHref(next.symbol));
}

function detailHtml(p) {
  const s = p.scores;
  const gainTone = num0(p.gain) >= 0 ? 'green' : 'red';
  const signed = (text) => `<span class="tone-text tone-${gainTone}">${text}</span>`;
  const facts = [
    ['Marktwert', fmtCurrency(p.value)],
    ['Depotanteil', fmtPercent(p.allocation)],
    ['Investiert', fmtCurrency(p.buyinTotal)],
    ['Plus/Minus', signed(fmtSignedCurrency(p.gain))],
    ['Plus/Minus %', signed(fmtSignedPercent(p.gainRel))],
    ['Dividendenrendite', fmtPercent(p.dividendYield)],
    ['Yield on Cost', fmtPercent(p.dividendYieldOnBuyin)],
    ['Dividende p.a.', fmtCurrency(p.totalDividendRate)],
    ['Dividende je Anteil', fmtCurrency(p.dividendRate)],
    ['Frequenz', fmtFrequency(p.dividendFrequency)],
    ['Dividenden-CAGR', fmtPercent(p.dividendCagr, 1) + (p.dividendCagrPeriod ? ` (${escapeHtml(p.dividendCagrPeriod)})` : '')],
    ['Ex-Tag', fmtDate(p.exDate)],
    ['Zahltag', fmtDate(p.payDate)],
  ];
  const parts = [
    ['Sicherheit', s.safety],
    ['Einkommen', s.income],
    ['Wachstum', s.growth],
    ['Depot-Fit', s.fit],
    ['Streuung', s.concentration],
  ];
  const meta = [p.isin, fmtSector(p.sector), fmtCountry(p.country), fmtSecurityType(p.securityType)].filter(Boolean);

  return `
    <header class="detail-head">
      <div class="detail-id">
        <h2 class="detail-sym" id="sheetTitle">${escapeHtml(p.symbol)}</h2>
        <p class="detail-name">${escapeHtml(p.name)}</p>
        <p class="detail-meta">${meta.map(escapeHtml).join(' · ')}</p>
        ${actionTag(p.action)}
      </div>
      ${scoreRing(s.total)}
    </header>
    <section class="inset">
      ${bars(
        parts.map(([label, v]) => ({ label, value: v, tone: scoreLevel(v).tone })),
        { max: 100, cls: 'bars-score', format: (v) => v }
      )}
    </section>
    <dl class="kv">${facts.map(([k, v]) => `<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <section class="inset">
      <h3 class="inset-title">Insights</h3>
      <ul class="bullets">${p.insights.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
    </section>`;
}

const RENDER = {
  uebersicht: renderOverview,
  empfehlungen: renderRecs,
  risiko: renderRisk,
  einkommen: renderIncome,
  ziel: renderTarget,
  aufstocken: renderTopUp,
  positionen: renderPositions,
};

boot(); // scripts are deferred, so the DOM is ready
