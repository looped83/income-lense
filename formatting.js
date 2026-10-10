/* ============================================================================
 * formatting.js
 * ----------------------------------------------------------------------------
 * CSV parsing, number parsing and de-DE display formatting.
 *
 * The DivvyDiary CSV uses:
 *   - semicolon (;) as the column separator   -> parseCsv
 *   - comma (,) as the decimal separator       -> parseNum
 * Percentage-like values are stored as fractions (0.038554 -> "3,86 %").
 *
 * Plain globals (no build step / no ES modules) so index.html runs from
 * file:// and GitHub Pages alike.
 * ==========================================================================*/

/** Placeholder for missing values. Nothing is ever invented. */
const NA = '–';

/* ----------------------------------------------------------------------------
 * CSV
 * --------------------------------------------------------------------------*/

/**
 * Minimal RFC-4180 parser: quoted fields, "" escapes, delimiters / newlines
 * inside quotes, CRLF and a leading BOM. The delimiter is auto-detected from
 * the header line (";" for DivvyDiary, "," as fallback).
 * Returns an array of row objects keyed by the trimmed header names.
 */
function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const headerEnd = src.search(/\r?\n/);
  const delim = src.slice(0, headerEnd < 0 ? undefined : headerEnd).includes(';') ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') {
        field += c;
      } else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const head = (rows.shift() || []).map((h) => h.trim());
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])));
}

/* ----------------------------------------------------------------------------
 * Numbers
 * --------------------------------------------------------------------------*/

/**
 * Parse a German-formatted numeric string ("13.826,51", "489,7182").
 * Returns NaN for empty / non-numeric input so callers can detect missing data.
 */
function parseNum(value) {
  if (value === null || value === undefined) return NaN;
  let s = String(value).trim();
  if (s === '') return NaN;
  // "." is a thousands separator only when a "," decimal is present too.
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '');
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** True when a parsed number is usable. */
function hasNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Number -> 0 fallback (for sums). */
function num0(n) {
  return hasNum(n) ? n : 0;
}

/* ----------------------------------------------------------------------------
 * Display formatters (de-DE). Intl formatters are cached: creating one is far
 * more expensive than using it, and a render formats thousands of values.
 * --------------------------------------------------------------------------*/
const NF_CACHE = new Map();

function numberFormat(style, digits) {
  const key = style + digits;
  let nf = NF_CACHE.get(key);
  if (!nf) {
    const opts = { minimumFractionDigits: style === 'number' ? 0 : digits, maximumFractionDigits: digits };
    if (style === 'currency') Object.assign(opts, { style, currency: 'EUR' });
    if (style === 'percent') opts.style = style;
    nf = new Intl.NumberFormat('de-DE', opts);
    NF_CACHE.set(key, nf);
  }
  return nf;
}

/** EUR amount; digits 2 for tables/details, 0 for summary figures and bars. */
function fmtCurrency(n, digits = 2) {
  return hasNum(n) ? numberFormat('currency', digits).format(n) : NA;
}

/** Fraction as percentage, e.g. 0.038554 -> "3,86 %". */
function fmtPercent(fraction, digits = 2) {
  return hasNum(fraction) ? numberFormat('percent', digits).format(fraction) : NA;
}

/** Plain number with German grouping, e.g. 1234.5 -> "1.234,5". */
function fmtNumber(n, digits = 2) {
  return hasNum(n) ? numberFormat('number', digits).format(n) : NA;
}

/** Signed EUR amount ("+1.234,00 €"). */
function fmtSignedCurrency(n, digits = 2) {
  return hasNum(n) ? (n > 0 ? '+' : '') + fmtCurrency(n, digits) : NA;
}

/** Signed percentage ("+12,50 %"). */
function fmtSignedPercent(fraction, digits = 2) {
  return hasNum(fraction) ? (fraction > 0 ? '+' : '') + fmtPercent(fraction, digits) : NA;
}

/* ----------------------------------------------------------------------------
 * Labels
 * --------------------------------------------------------------------------*/

/**
 * "mixed" / "Unbekannt" / "" buckets stand for broad ETFs/funds or missing
 * data; they are never treated as a single sector / country risk.
 */
const GENERIC_BUCKETS = new Set(['mixed', 'Unbekannt', '']);

function isGenericBucket(key) {
  return GENERIC_BUCKETS.has(key);
}

/** Readable label for a generic bucket, or null for a named one. */
function genericLabel(key) {
  if (key === 'mixed') return 'Gemischt (ETFs)';
  return isGenericBucket(key) ? 'Unbekannt' : null;
}

const FREQUENCY_LABELS = {
  monthly: 'Monatlich',
  quarterly: 'Quartalsweise',
  biannually: 'Halbjährlich',
  annually: 'Jährlich',
  none: 'Keine',
};
const SECURITY_TYPE_LABELS = { EQUITY: 'Aktie', ETF: 'ETF', FUND: 'Fonds', CRYPTO: 'Krypto' };
const COUNTRY_LABELS = {
  DE: 'Deutschland',
  US: 'USA',
  GB: 'Großbritannien',
  CA: 'Kanada',
  NL: 'Niederlande',
  FR: 'Frankreich',
  CH: 'Schweiz',
  DK: 'Dänemark',
  IE: 'Irland',
  ES: 'Spanien',
  IT: 'Italien',
  SE: 'Schweden',
  NO: 'Norwegen',
  FI: 'Finnland',
  AU: 'Australien',
  JP: 'Japan',
};

function fmtFrequency(freq) {
  return freq ? FREQUENCY_LABELS[freq.toLowerCase()] || freq : NA;
}

function fmtSecurityType(type) {
  return type ? SECURITY_TYPE_LABELS[type.toUpperCase()] || type : NA;
}

function fmtCountry(code) {
  return genericLabel(code) || COUNTRY_LABELS[code] || code;
}

function fmtSector(sector) {
  return genericLabel(sector) || sector;
}

/** ISO date (YYYY-MM-DD) -> "15.10.2026"; short = "15.10.". */
function fmtDate(value, short = false) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value ? String(value) : NA;
  return short ? `${m[3]}.${m[2]}.` : `${m[3]}.${m[2]}.${m[1]}`;
}

/** Escape text for safe interpolation into HTML (content and attributes). */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
