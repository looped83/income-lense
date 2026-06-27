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
  PROVIDERS: { fmp: 'Financial Modeling Prep', eodhd: 'EODHD' },
  _ls(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  _set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* ignore */
    }
  },
  _del(k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {
      /* ignore */
    }
  },
  /** Active provider: 'fmp' | 'eodhd'. */
  provider() {
    const p = this._ls('incomeLense.provider');
    if (p === 'fmp' || p === 'eodhd') return p;
    const cfg = window.INCOME_LENSE_CONFIG || {};
    return cfg.provider === 'eodhd' ? 'eodhd' : 'fmp';
  },
  setProvider(p) {
    if (p === 'fmp' || p === 'eodhd') this._set('incomeLense.provider', p);
  },
  /** API key for the active provider: in-app field (localStorage) or config.js. */
  apiKey() {
    const p = this.provider();
    const k = this._ls(`incomeLense.${p}Key`);
    if (k && k.trim()) return k.trim();
    const cfg = window.INCOME_LENSE_CONFIG || {};
    return ((p === 'eodhd' ? cfg.eodhdApiKey : cfg.fmpApiKey) || '').trim();
  },
  setApiKey(key) {
    this._set(`incomeLense.${this.provider()}Key`, (key || '').trim());
  },
  clearApiKey() {
    this._del(`incomeLense.${this.provider()}Key`);
  },
  providerName() {
    return this.PROVIDERS[this.provider()];
  },
  enabled() {
    return !!this.apiKey();
  },
};

/** Parse a possibly-string number; returns null when not finite. */
function toNum(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
/** Normalise a yield/ratio that may be given as a percent (e.g. 2.99 -> 0.0299). */
function normFraction(x, pctThreshold) {
  const n = toNum(x);
  if (n === null) return null;
  return n > pctThreshold ? n / 100 : n;
}

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

/** Map a CSV position to an EODHD ticker (TICKER.EXCHANGE). */
function eodhdSymbol(pos) {
  const sym = (pos.symbol || '').trim();
  const ex = { US: 'US', DE: 'XETRA', GB: 'LSE', CA: 'TO', NL: 'AS', FR: 'PA' }[pos.country] || 'US';
  return `${sym}.${ex}`;
}

/** Only individual equities carry the fundamentals we model. */
function isEnrichable(pos) {
  return (pos.securityType || '').toUpperCase() === 'EQUITY';
}

/** GET an FMP path directly using the stored API key. `path` is everything
 *  after the domain, e.g. "stable/dividends?symbol=KO". */
async function fmpGet(path) {
  const key = ENRICH.apiKey();
  if (!key) throw new Error('kein API-Key hinterlegt');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://financialmodelingprep.com/${path}${sep}apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** GET an EODHD path directly using the stored API key. */
async function eodhdGet(path) {
  const key = ENRICH.apiKey();
  if (!key) throw new Error('kein API-Key hinterlegt');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://eodhd.com/api/${path}${sep}api_token=${encodeURIComponent(key)}&fmt=json`;
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
 * Shared helpers
 * --------------------------------------------------------------------------*/
/** Build dpsByYear/dpsTTM/streak/cagr5 from a [{date, amount}] dividend history. */
function dividendSeries(hist) {
  const byYear = {};
  hist.forEach((d) => {
    const y = parseInt(String(d.date).slice(0, 4), 10);
    const v = num0(d.amount);
    if (Number.isFinite(y) && v > 0) byYear[y] = (byYear[y] || 0) + v;
  });
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const dpsByYear = years.map((y) => ({ year: y, dps: byYear[y] }));

  const now = Date.now();
  const ttm = hist
    .filter((d) => now - new Date(d.date).getTime() <= 366 * 864e5)
    .reduce((s, d) => s + num0(d.amount), 0);

  const curYear = new Date().getFullYear();
  const full = dpsByYear.filter((d) => d.year < curYear);
  let streak = 0;
  for (let i = full.length - 1; i > 0; i--) {
    if (full[i].dps >= full[i - 1].dps - 1e-9) streak++;
    else break;
  }
  let cagr5 = null;
  if (full.length) {
    const latest = full[full.length - 1];
    const base = full.find((d) => d.year === latest.year - 5);
    cagr5 = base && base.dps > 0 ? Math.pow(latest.dps / base.dps, 1 / 5) - 1 : null;
  }
  return { dpsByYear, dpsTTM: ttm > 0 ? ttm : null, streak: full.length >= 2 ? streak : null, cagr5 };
}

/** First finite value among the given keys of an object, else null. */
function pickNum(o, keys) {
  if (!o) return null;
  for (const k of keys) if (hasNum(o[k])) return o[k];
  return null;
}

/** Attach the composite score + summary. */
function finalizeFundamentals(out) {
  out.score = scoreFundamentals(out);
  out.summary = fundamentalsSummary(out);
  return out;
}

/* ----------------------------------------------------------------------------
 * Provider: Financial Modeling Prep (stable API)
 * --------------------------------------------------------------------------*/
function computeFmp(pos, sym, raw) {
  const out = { symbol: pos.symbol, providerSymbol: sym, available: true, source: ENRICH.PROVIDERS.fmp };
  const hist = (Array.isArray(raw.divs) ? raw.divs : (raw.divs && raw.divs.historical) || []).map((d) => ({
    date: d.date,
    amount: d.adjDividend != null ? d.adjDividend : d.dividend,
  }));
  Object.assign(out, dividendSeries(hist));

  const rt = Array.isArray(raw.ratios) && raw.ratios[0] ? raw.ratios[0] : null;
  out.payoutRatio = pickNum(rt, ['payoutRatioTTM', 'dividendPayoutRatioTTM']);
  out.dividendYield = pickNum(rt, ['dividendYieldTTM', 'dividendYielTTM']);

  const cf = Array.isArray(raw.cf) && raw.cf[0] ? raw.cf[0] : null;
  const fcf = pickNum(cf, ['freeCashFlow']);
  const divPaidRaw = pickNum(cf, ['dividendsPaid', 'netDividendsPaid', 'commonDividendsPaid']);
  if (hasNum(fcf) && hasNum(divPaidRaw) && fcf !== 0) {
    const dp = Math.abs(divPaidRaw);
    out.fcfPayout = dp / fcf;
    out.fcfCoverage = dp > 0 ? fcf / dp : null;
  } else {
    out.fcfPayout = null;
    out.fcfCoverage = null;
  }

  // Free-tier fallbacks from quote (EPS + price).
  const qt = Array.isArray(raw.quote) && raw.quote[0] ? raw.quote[0] : null;
  const pf = Array.isArray(raw.profile) && raw.profile[0] ? raw.profile[0] : null;
  const eps = pickNum(qt, ['eps']);
  const price = pickNum(qt, ['price']) ?? pickNum(pf, ['price']);
  const lastDiv = pickNum(pf, ['lastDividend', 'lastDiv']);
  if (out.payoutRatio == null && hasNum(out.dpsTTM) && hasNum(eps) && eps > 0) out.payoutRatio = out.dpsTTM / eps;
  if (out.dividendYield == null && hasNum(out.dpsTTM) && hasNum(price) && price > 0) out.dividendYield = out.dpsTTM / price;
  if (out.dividendYield == null && hasNum(lastDiv) && hasNum(price) && price > 0) out.dividendYield = lastDiv / price;
  if (out.dividendYield == null && hasNum(pos.dividendYield)) out.dividendYield = pos.dividendYield;

  return finalizeFundamentals(out);
}

async function fetchFmp(pos) {
  const sym = fmpSymbol(pos);
  const s = encodeURIComponent(sym);
  const settled = await Promise.allSettled([
    fmpGet(`stable/dividends?symbol=${s}`),
    fmpGet(`stable/ratios-ttm?symbol=${s}`),
    fmpGet(`stable/cash-flow-statement?symbol=${s}&limit=1`),
    fmpGet(`stable/profile?symbol=${s}`),
    fmpGet(`stable/quote?symbol=${s}`),
  ]);
  const [divs, ratios, cf, profile, quote] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const errs = settled.filter((r) => r.status === 'rejected').map((r) => (r.reason && r.reason.message) || 'Fehler');
  const errMsg = (x) => (x && !Array.isArray(x) && x['Error Message']) || null;
  const apiErr = errMsg(divs) || errMsg(profile) || errMsg(ratios) || errMsg(cf);
  const histLen = (Array.isArray(divs) && divs.length) || (divs && divs.historical && divs.historical.length) || 0;
  const hasAny = histLen || (Array.isArray(ratios) && ratios.length) || (Array.isArray(profile) && profile.length);

  if (!hasAny) {
    let reason;
    if (apiErr) reason = `Anbieter-Fehler: ${apiErr}`;
    else if (errs.length) reason = `Abruf nicht möglich (${errs[0]}).`;
    else reason = `Keine Fundamentaldaten für „${sym}" gefunden.`;
    return { symbol: pos.symbol, providerSymbol: sym, available: false, reason };
  }
  return computeFmp(pos, sym, { divs, ratios, cf, profile, quote });
}

/* ----------------------------------------------------------------------------
 * Provider: EODHD (better international / ISIN coverage)
 * --------------------------------------------------------------------------*/
function computeEodhd(pos, sym, raw) {
  const out = { symbol: pos.symbol, providerSymbol: sym, available: true, source: ENRICH.PROVIDERS.eodhd };
  const hist = (Array.isArray(raw.divs) ? raw.divs : []).map((d) => ({
    date: d.date,
    amount: d.value != null ? d.value : d.unadjustedValue,
  }));
  Object.assign(out, dividendSeries(hist));

  const fund = raw.fund || {};
  const hl = fund.Highlights || {};
  const sd = fund.SplitsDividends || {};

  out.dividendYield = normFraction(hl.DividendYield, 1); // fraction or percent -> fraction
  out.payoutRatio = normFraction(hl.PayoutRatio != null ? hl.PayoutRatio : sd.PayoutRatio, 2);
  const eps = toNum(hl.EarningsShare);
  if (out.payoutRatio == null && hasNum(out.dpsTTM) && hasNum(eps) && eps > 0) out.payoutRatio = out.dpsTTM / eps;

  // FCF coverage from the latest yearly cash-flow statement (EODHD includes it).
  out.fcfPayout = null;
  out.fcfCoverage = null;
  const cfy = fund.Financials && fund.Financials.Cash_Flow && fund.Financials.Cash_Flow.yearly;
  if (cfy) {
    const latest = Object.values(cfy).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const fcf = latest && toNum(latest.freeCashFlow);
    const dp = latest && toNum(latest.dividendsPaid);
    if (hasNum(fcf) && hasNum(dp) && fcf !== 0) {
      const a = Math.abs(dp);
      out.fcfPayout = a / fcf;
      out.fcfCoverage = a > 0 ? fcf / a : null;
    }
  }

  // TTM dividend fallback from forward annual rate.
  if (out.dpsTTM == null) {
    const fwd = toNum(sd.ForwardAnnualDividendRate);
    if (hasNum(fwd)) out.dpsTTM = fwd;
  }
  if (out.dividendYield == null && hasNum(pos.dividendYield)) out.dividendYield = pos.dividendYield;

  return finalizeFundamentals(out);
}

async function fetchEodhd(pos) {
  const sym = eodhdSymbol(pos);
  const s = encodeURIComponent(sym);
  const settled = await Promise.allSettled([
    eodhdGet(`fundamentals/${s}`),
    eodhdGet(`div/${s}?from=2010-01-01`),
  ]);
  const [fund, divs] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const errs = settled.filter((r) => r.status === 'rejected').map((r) => (r.reason && r.reason.message) || 'Fehler');

  // EODHD signals "not found" as a string body or an empty object.
  const fundOk = fund && typeof fund === 'object' && (fund.Highlights || fund.SplitsDividends);
  const histLen = Array.isArray(divs) ? divs.length : 0;
  if (!fundOk && !histLen) {
    let reason;
    if (typeof fund === 'string') reason = `Anbieter-Fehler: ${fund}`;
    else if (errs.length) reason = `Abruf nicht möglich (${errs[0]}).`;
    else reason = `Keine Fundamentaldaten für „${sym}" gefunden.`;
    return { symbol: pos.symbol, providerSymbol: sym, available: false, reason };
  }
  return computeEodhd(pos, sym, { fund, divs });
}

/* ----------------------------------------------------------------------------
 * Fetch & compute fundamentals for one position (cached; provider dispatch).
 * --------------------------------------------------------------------------*/
async function fetchFundamentals(pos) {
  if (ENRICH.cache[pos.symbol]) return ENRICH.cache[pos.symbol];
  if (!isEnrichable(pos)) {
    const na = { symbol: pos.symbol, available: false, reason: 'Kein Einzelwert (ETF/Fonds/Krypto) – keine Fundamentaldaten.' };
    ENRICH.cache[pos.symbol] = na;
    return na;
  }
  let result;
  try {
    result = ENRICH.provider() === 'eodhd' ? await fetchEodhd(pos) : await fetchFmp(pos);
  } catch (e) {
    result = { symbol: pos.symbol, available: false, reason: 'Abruf fehlgeschlagen (' + e.message + ').' };
  }
  ENRICH.cache[pos.symbol] = result;
  return result;
}
