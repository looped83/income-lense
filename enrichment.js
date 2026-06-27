/* ============================================================================
 * enrichment.js  (V2 – external fundamental data via FMP through a proxy)
 * ----------------------------------------------------------------------------
 * Fetches fundamental dividend data (payout ratio, FCF coverage, dividend
 * streak, dividend-per-share history, 5Y CAGR, yield) for a position via a
 * serverless proxy (which holds the secret FMP API key), derives a transparent
 * fundamental dividend score, and exposes everything as globals for app.js.
 *
 * No secrets here. If no proxy is configured, the app stays in CSV-only mode.
 * Depends on formatting.js helpers (num0, hasNum).
 * ==========================================================================*/

const ENRICH = {
  cache: {}, // symbol -> result
  KEY_STORE: 'incomeLense.fmpKey',
  /** API key from the in-app field (localStorage) or, as fallback, config.js. */
  apiKey() {
    try {
      const k = localStorage.getItem(this.KEY_STORE);
      if (k && k.trim()) return k.trim();
    } catch (e) {
      /* localStorage unavailable */
    }
    const cfg = window.INCOME_LENSE_CONFIG || {};
    return (cfg.fmpApiKey || '').trim();
  },
  setApiKey(k) {
    try {
      localStorage.setItem(this.KEY_STORE, (k || '').trim());
    } catch (e) {
      /* ignore */
    }
  },
  clearApiKey() {
    try {
      localStorage.removeItem(this.KEY_STORE);
    } catch (e) {
      /* ignore */
    }
  },
  enabled() {
    return !!this.apiKey();
  },
};

/** Weights of the fundamental composite score (easy to tune). */
const ENRICH_WEIGHTS = { safety: 0.5, growth: 0.3, income: 0.2 };

/** Map a CSV position to an FMP ticker (best effort; EU exchanges get a suffix). */
function fmpSymbol(pos) {
  const sym = (pos.symbol || '').trim();
  const country = pos.country;
  const suffix = { DE: '.DE', GB: '.L', CA: '.TO', NL: '.AS', FR: '.PA' }[country];
  // US equities and most US-listed names resolve by plain ticker.
  if (country && country !== 'US' && suffix) return `${sym}${suffix}`;
  return sym;
}

/** Only individual equities carry the fundamentals we model. */
function isEnrichable(pos) {
  return (pos.securityType || '').toUpperCase() === 'EQUITY';
}

/** GET a path on FMP directly using the stored API key. */
async function fmpGet(path) {
  const key = ENRICH.apiKey();
  if (!key) throw new Error('kein API-Key hinterlegt');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://financialmodelingprep.com/api/${path}${sep}apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ----------------------------------------------------------------------------
 * Metric -> 0..100 sub-scores (shared by scoring and the breakdown UI).
 * Return null when the underlying data is missing (never invented).
 * --------------------------------------------------------------------------*/
function mPayout(p) {
  if (!hasNum(p)) return null;
  if (p < 0) return 30; // negative earnings -> payout meaningless, treat cautiously
  if (p <= 0.4) return 100;
  if (p <= 0.6) return 85;
  if (p <= 0.75) return 65;
  if (p <= 0.9) return 45;
  return 20;
}
function mFcfCoverage(x) {
  if (!hasNum(x)) return null;
  if (x >= 3) return 100;
  if (x >= 2) return 88;
  if (x >= 1.5) return 72;
  if (x >= 1) return 52;
  return 25;
}
function mStreak(y) {
  if (!hasNum(y)) return null;
  if (y >= 25) return 100;
  if (y >= 15) return 90;
  if (y >= 10) return 75;
  if (y >= 5) return 55;
  if (y >= 1) return 35;
  return 15;
}
function mCagr(g) {
  if (!hasNum(g)) return null;
  if (g >= 0.1) return 100;
  if (g >= 0.07) return 85;
  if (g >= 0.04) return 65;
  if (g >= 0.01) return 45;
  return 20;
}
function mYield(y) {
  if (!hasNum(y)) return null;
  if (y >= 0.02 && y <= 0.06) return 100;
  if ((y >= 0.01 && y < 0.02) || (y > 0.06 && y <= 0.08)) return 60;
  if (y < 0.01) return 30;
  return 25; // very high yield -> verify safety
}

function avgDefined(arr) {
  const v = arr.filter((x) => hasNum(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Build the transparent fundamental score from the derived metrics. */
function scoreFundamentals(f) {
  const safetyParts = [mPayout(f.payoutRatio), mFcfCoverage(f.fcfCoverage)];
  let safety = avgDefined(safetyParts);
  if (safety === null) safety = mStreak(f.streak) ?? 50; // fall back to track record
  let growth = avgDefined([mStreak(f.streak), mCagr(f.cagr5)]);
  if (growth === null) growth = 50;
  const income = mYield(f.dividendYield) ?? 50;

  const composite = Math.round(
    ENRICH_WEIGHTS.safety * safety + ENRICH_WEIGHTS.growth * growth + ENRICH_WEIGHTS.income * income
  );
  return { safety: Math.round(safety), growth: Math.round(growth), income: Math.round(income), composite };
}

/** Short German assessment, screenshot-style. */
function fundamentalsSummary(f) {
  const bits = [];
  if (hasNum(f.payoutRatio) && hasNum(f.fcfCoverage))
    bits.push('Dividende durch Gewinne und Free Cashflow gedeckt');
  else if (hasNum(f.payoutRatio)) bits.push('Ausschüttungsquote im Blick behalten');
  if (hasNum(f.streak) && f.streak >= 5) bits.push(`${f.streak}-jährige Wachstums-Historie`);
  if (hasNum(f.cagr5) && f.cagr5 >= 0.04) bits.push(`solides Wachstum (${fmtPercent(f.cagr5, 1)} CAGR)`);
  if (hasNum(f.dividendYield) && f.dividendYield > 0.06) bits.push('hohe Rendite – Sicherheit prüfen');
  return bits.length ? bits.join(', ') + '.' : 'Eingeschränkte Fundamentaldaten verfügbar.';
}

/* ----------------------------------------------------------------------------
 * Derive metrics from raw FMP payloads.
 * --------------------------------------------------------------------------*/
function computeFundamentals(pos, sym, raw) {
  const out = { symbol: pos.symbol, fmpSymbol: sym, available: true, source: 'Financial Modeling Prep' };

  // Dividend history -> annual DPS.
  const hist = (raw.divs && raw.divs.historical) || [];
  const byYear = {};
  hist.forEach((d) => {
    const y = parseInt(String(d.date).slice(0, 4), 10);
    const v = num0(d.adjDividend != null ? d.adjDividend : d.dividend);
    if (Number.isFinite(y) && v > 0) byYear[y] = (byYear[y] || 0) + v;
  });
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  out.dpsByYear = years.map((y) => ({ year: y, dps: byYear[y] }));

  // TTM dividend per share (sum of last ~12 months).
  const now = Date.now();
  const ttm = hist
    .filter((d) => now - new Date(d.date).getTime() <= 366 * 864e5)
    .reduce((s, d) => s + num0(d.adjDividend != null ? d.adjDividend : d.dividend), 0);
  out.dpsTTM = ttm > 0 ? ttm : null;

  // Growth streak: consecutive year-over-year non-decreases among complete years.
  const curYear = new Date().getFullYear();
  const full = out.dpsByYear.filter((d) => d.year < curYear);
  let streak = 0;
  for (let i = full.length - 1; i > 0; i--) {
    if (full[i].dps >= full[i - 1].dps - 1e-9) streak++;
    else break;
  }
  out.streak = full.length >= 2 ? streak : null;

  // 5Y CAGR from complete years.
  if (full.length) {
    const latest = full[full.length - 1];
    const base = full.find((d) => d.year === latest.year - 5);
    out.cagr5 = base && base.dps > 0 ? Math.pow(latest.dps / base.dps, 1 / 5) - 1 : null;
  } else {
    out.cagr5 = null;
  }

  // Ratios (TTM).
  const rt = raw.ratios && raw.ratios[0] ? raw.ratios[0] : null;
  out.payoutRatio = rt && hasNum(rt.payoutRatioTTM) ? rt.payoutRatioTTM : null;
  out.dividendYield = rt && hasNum(rt.dividendYielTTM) ? rt.dividendYielTTM : null;

  // Cash flow -> FCF payout / coverage.
  const cf = raw.cf && raw.cf[0] ? raw.cf[0] : null;
  if (cf && hasNum(cf.freeCashFlow) && hasNum(cf.dividendsPaid) && cf.freeCashFlow !== 0) {
    const divPaid = Math.abs(cf.dividendsPaid);
    out.fcfPayout = divPaid / cf.freeCashFlow;
    out.fcfCoverage = divPaid > 0 ? cf.freeCashFlow / divPaid : null;
  } else {
    out.fcfPayout = null;
    out.fcfCoverage = null;
  }

  // Yield fallback from profile (lastDiv / price).
  const pf = raw.profile && raw.profile[0] ? raw.profile[0] : null;
  if (out.dividendYield == null && pf && hasNum(pf.lastDiv) && hasNum(pf.price) && pf.price > 0) {
    out.dividendYield = pf.lastDiv / pf.price;
  }
  // Fall back to the CSV yield if FMP has none.
  if (out.dividendYield == null && hasNum(pos.dividendYield)) out.dividendYield = pos.dividendYield;

  out.score = scoreFundamentals(out);
  out.summary = fundamentalsSummary(out);
  return out;
}

/** Fetch & compute fundamentals for one position (cached). */
async function fetchFundamentals(pos) {
  if (ENRICH.cache[pos.symbol]) return ENRICH.cache[pos.symbol];
  if (!isEnrichable(pos)) {
    const na = { symbol: pos.symbol, available: false, reason: 'Kein Einzelwert (ETF/Fonds/Krypto) – keine Fundamentaldaten.' };
    ENRICH.cache[pos.symbol] = na;
    return na;
  }
  const sym = fmpSymbol(pos);
  // Use allSettled so we can surface the real failure reason (HTTP 401/403 vs.
  // network/CORS) instead of silently swallowing it.
  const settled = await Promise.allSettled([
    fmpGet(`v3/historical-price-full/stock_dividend/${sym}`),
    fmpGet(`v3/ratios-ttm/${sym}`),
    fmpGet(`v3/cash-flow-statement/${sym}?period=annual&limit=1`),
    fmpGet(`v3/profile/${sym}`),
  ]);
  const [divs, ratios, cf, profile] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const errs = settled.filter((r) => r.status === 'rejected').map((r) => (r.reason && r.reason.message) || 'Fehler');

  // FMP error payloads come back as 200 with an { "Error Message": ... } object.
  const apiErr =
    (divs && divs['Error Message']) || (profile && profile['Error Message']) || (ratios && ratios['Error Message']);

  const hasAny =
    (divs && divs.historical && divs.historical.length) || (ratios && ratios.length) || (profile && profile.length);

  if (!hasAny) {
    let reason;
    if (apiErr) reason = `Anbieter-Fehler: ${apiErr}`;
    else if (errs.length) reason = `Abruf nicht möglich (${errs[0]}).`;
    else reason = `Keine Fundamentaldaten für „${sym}" gefunden.`;
    const na = { symbol: pos.symbol, fmpSymbol: sym, available: false, reason };
    ENRICH.cache[pos.symbol] = na;
    return na;
  }

  const result = computeFundamentals(pos, sym, { divs, ratios, cf, profile });
  ENRICH.cache[pos.symbol] = result;
  return result;
}
