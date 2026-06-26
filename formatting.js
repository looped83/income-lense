/* ============================================================================
 * formatting.js
 * ----------------------------------------------------------------------------
 * Parsing & formatting helpers for the Dividend Portfolio Analyzer.
 *
 * The DivvyDiary CSV uses:
 *   - semicolon (;) as the column separator   -> handled by PapaParse in app.js
 *   - comma (,) as the decimal separator       -> handled here
 *
 * Percentage-like values in the CSV are stored as fractions, e.g.
 *   0.038554  ->  "3,86 %"
 *
 * All display formatting uses the German ("de-DE") locale.
 * These functions are exposed as globals (no build step / no ES modules) so the
 * app runs by simply opening index.html.
 * ==========================================================================*/

/**
 * Parse a German-formatted numeric string into a JS Number.
 * Handles comma as decimal separator and optional "." thousands separators.
 * Returns NaN for empty / non-numeric input so callers can detect missing data.
 *
 * Examples:
 *   "489,7182"   -> 489.7182
 *   "13.826,51"  -> 13826.51
 *   ""           -> NaN
 */
function parseNum(value) {
  if (value === null || value === undefined) return NaN;
  let s = String(value).trim();
  if (s === '') return NaN;

  // If both "." and "," are present, "." is a thousands separator.
  if (s.indexOf('.') !== -1 && s.indexOf(',') !== -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Only a comma -> decimal separator.
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** True when a parsed number is usable (finite and not NaN). */
function hasNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Safe number -> 0 fallback (used for portfolio aggregation sums). */
function num0(n) {
  return hasNum(n) ? n : 0;
}

// --- Locale-aware display formatters -----------------------------------------

const NF_EUR = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NF_EUR0 = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Format a number as EUR currency, e.g. 4493.0903 -> "4.493,09 €". */
function fmtCurrency(n, decimals2 = true) {
  if (!hasNum(n)) return 'n/a';
  return (decimals2 ? NF_EUR : NF_EUR0).format(n);
}

/** Format a fraction as a percentage, e.g. 0.038554 -> "3,86 %". */
function fmtPercent(fraction, digits = 2) {
  if (!hasNum(fraction)) return 'n/a';
  return new Intl.NumberFormat('de-DE', {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction);
}

/** Format a plain number with German grouping, e.g. 1234.5 -> "1.234,5". */
function fmtNumber(n, digits = 2) {
  if (!hasNum(n)) return 'n/a';
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
}

/** Format a signed value with a leading + / - and currency. */
function fmtSignedCurrency(n) {
  if (!hasNum(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return sign + fmtCurrency(n);
}

/** Format a signed fraction as a percentage with leading + / -. */
function fmtSignedPercent(fraction, digits = 2) {
  if (!hasNum(fraction)) return 'n/a';
  const sign = fraction > 0 ? '+' : '';
  return sign + fmtPercent(fraction, digits);
}

/** Translate the English dividend frequency into German. */
function fmtFrequency(freq) {
  const map = {
    monthly: 'Monatlich',
    quarterly: 'Quartalsweise',
    biannually: 'Halbjährlich',
    annually: 'Jährlich',
    none: 'Keine',
  };
  if (!freq) return 'n/a';
  return map[freq.toLowerCase()] || freq;
}

/** Translate security type codes into readable German labels. */
function fmtSecurityType(type) {
  const map = {
    EQUITY: 'Aktie',
    ETF: 'ETF',
    FUND: 'Fonds',
    CRYPTO: 'Krypto',
  };
  if (!type) return 'n/a';
  return map[type.toUpperCase()] || type;
}

/** Map a country code to a readable German label (best effort). */
function fmtCountry(code) {
  const map = {
    DE: 'Deutschland',
    US: 'USA',
    GB: 'Großbritannien',
    CA: 'Kanada',
    NL: 'Niederlande',
    FR: 'Frankreich',
    mixed: 'Gemischt',
  };
  if (!code) return 'n/a';
  return map[code] || code;
}

/** Display "n/a" for empty / missing string fields. */
function fmtText(value) {
  if (value === null || value === undefined) return 'n/a';
  const s = String(value).trim();
  return s === '' ? 'n/a' : s;
}

/** Format an ISO date (YYYY-MM-DD) into German dd.mm.yyyy. */
function fmtDate(value) {
  if (!value) return 'n/a';
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || 'n/a';
  return `${m[3]}.${m[2]}.${m[1]}`;
}
