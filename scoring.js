/* ============================================================================
 * scoring.js
 * ----------------------------------------------------------------------------
 * Shared limits + transparent, rule-based scoring model (0..100).
 *
 *   Total = 30% Safety + 25% Income + 20% Growth + 15% Portfolio fit
 *         + 10% Concentration (high score = well spread, low risk)
 *
 * LIMITS is the single source for every threshold that the risk view, the
 * recommendations, the action categories and the top-up plan share, so all
 * views always tell the same story.
 * ==========================================================================*/

const LIMITS = {
  position: { mid: 0.05, high: 0.08 }, // single-name weight in the portfolio
  sector: { mid: 0.2, high: 0.25 }, // named sector weight
  country: { mid: 0.45, high: 0.6 }, // named country weight
  income: { mid: 0.06, high: 0.1 }, // share of total annual dividends
  highYield: 0.08, // yield above this -> sustainability check
  solidGrowth: 0.05, // dividend CAGR that mitigates a high yield
  drawdown: -0.15, // unrealised loss that warrants a thesis check
  minEffective: 12, // effective number of holdings (1 / HHI)
  minAddScore: 62, // minimum total score for top-ups
};

/** Severity of a share against a {mid, high} limit: 'high' | 'mid' | null. */
function sevOf(value, limit) {
  if (value > limit.high) return 'high';
  if (value > limit.mid) return 'mid';
  return null;
}

const SCORE_WEIGHTS = {
  safety: 0.3,
  income: 0.25,
  growth: 0.2,
  fit: 0.15,
  concentration: 0.1,
};

/** Clamp into [min, max]; non-finite -> min. */
function clamp(n, min = 0, max = 100) {
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

/* ----------------------------------------------------------------------------
 * Position helpers shared by scoring, insights and analysis
 * --------------------------------------------------------------------------*/

/** ETF or fund (crypto is neither). */
function isFund(pos) {
  const t = (pos.securityType || '').toUpperCase();
  return t === 'ETF' || t === 'FUND';
}

/**
 * Broad ETF/fund (sector or country "mixed"/unknown). Its weight is spread over
 * many companies, so it is never flagged as a single-position or income
 * concentration risk.
 */
function isDiversified(pos) {
  return isFund(pos) && (isGenericBucket(pos.sector) || isGenericBucket(pos.country));
}

/** Share of a named bucket (sector / country); generic buckets count as 0. */
function bucketShare(map, key) {
  return isGenericBucket(key) ? 0 : map[key] || 0;
}

/** Share of the portfolio's annual dividend income this position delivers. */
function incomeShareOf(pos, ctx) {
  return ctx.totalAnnualDividend > 0 ? num0(pos.totalDividendRate) / ctx.totalAnnualDividend : 0;
}

/** True when the position pays a dividend. */
function paysDividend(pos) {
  return num0(pos.totalDividendRate) > 0;
}

/**
 * High-yield check: 'trap' (yield > 8 % with shrinking dividend), 'watch'
 * (yield > 8 % without solid growth) or null (normal / mitigated by growth).
 */
function yieldSignal(pos) {
  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  if (!hasNum(dy) || dy <= LIMITS.highYield) return null;
  if (hasNum(cagr) && cagr < 0) return 'trap';
  return hasNum(cagr) && cagr >= LIMITS.solidGrowth ? null : 'watch';
}

/* ----------------------------------------------------------------------------
 * 1) Dividend safety / quality
 * --------------------------------------------------------------------------*/
function scoreSafety(pos) {
  let score = 50;
  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  const freq = (pos.dividendFrequency || '').toLowerCase();

  // Reward the sustainable 2–6 % yield band; very high yields are a risk unless
  // backed by convincing dividend growth.
  if (hasNum(dy)) {
    if (dy >= 0.02 && dy <= 0.06) score += 22;
    else if (dy > 0.06 && dy <= LIMITS.highYield) score += 8;
    else if (dy > LIMITS.highYield) score -= hasNum(cagr) && cagr >= LIMITS.solidGrowth ? 5 : 18;
    else if (dy >= 0.01) score += 4;
    else if (dy >= 0) score -= 6;
  }

  // Dividend growth; a shrinking dividend is a clear red flag.
  if (hasNum(cagr)) {
    if (cagr >= 0.1) score += 14;
    else if (cagr >= LIMITS.solidGrowth) score += 9;
    else if (cagr > 0) score += 4;
    else if (cagr === 0) score -= 2;
    else score -= 12;
  }

  // Regular, frequent payouts are more predictable.
  score += { monthly: 8, quarterly: 6, biannually: 3, annually: 2 }[freq] || 0;

  const hasDividend = paysDividend(pos) || num0(pos.dividendRate) > 0;
  if (!hasDividend) score -= 25;
  if (!hasNum(dy) && !hasNum(cagr)) score -= 10; // cannot assess safety

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 2) Income strength
 * --------------------------------------------------------------------------*/
function scoreIncome(pos, ctx) {
  let score = 40;
  const annual = num0(pos.totalDividendRate);
  const yoc = pos.dividendYieldOnBuyin;
  const freq = (pos.dividendFrequency || '').toLowerCase();
  const allocation = pos.allocation || 0;
  const incomeShare = incomeShareOf(pos, ctx);

  // Contribution to the total dividend income.
  if (incomeShare >= 0.06) score += 30;
  else if (incomeShare >= 0.03) score += 22;
  else if (incomeShare >= 0.015) score += 14;
  else if (incomeShare >= 0.005) score += 7;
  else if (annual > 0) score += 2;

  // Yield on cost (income relative to invested capital).
  if (hasNum(yoc)) {
    if (yoc >= 0.06) score += 18;
    else if (yoc >= 0.04) score += 12;
    else if (yoc >= 0.025) score += 7;
    else if (yoc > 0) score += 2;
  }

  score += { monthly: 6, quarterly: 3 }[freq] || 0;

  // Large footprint, weak income pull.
  if (allocation >= 0.03 && incomeShare < allocation * 0.5) score -= 12;
  if (annual <= 0) score = Math.min(score, 10);

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 3) Growth
 * --------------------------------------------------------------------------*/
function scoreGrowth(pos) {
  let score = 45;
  const cagr = pos.dividendCagr;
  const gainRel = pos.gainRel;

  if (hasNum(cagr)) {
    if (cagr >= 0.12) score += 28;
    else if (cagr >= 0.08) score += 20;
    else if (cagr >= 0.04) score += 12;
    else if (cagr > 0) score += 5;
    else if (cagr === 0) score -= 4;
    else score -= 16;
  } else {
    // Funds often have no growth figure by design -> milder penalty.
    score -= isFund(pos) ? 4 : 10;
  }

  if (hasNum(gainRel)) {
    if (gainRel >= 0.25) score += 16;
    else if (gainRel >= 0.1) score += 10;
    else if (gainRel > 0) score += 5;
    else if (gainRel > -0.1) score -= 4;
    else score -= 10;
  }

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 4) Portfolio fit
 * --------------------------------------------------------------------------*/
function scoreFit(pos, ctx) {
  let score = 55;
  const allocation = pos.allocation || 0;

  // Room to grow without overweighting (single names only).
  if (!isDiversified(pos)) {
    if (allocation <= 0.02) score += 18;
    else if (allocation <= 0.04) score += 10;
    else if (allocation <= 0.06) score += 2;
    else if (allocation <= LIMITS.position.high) score -= 10;
    else score -= 22;
  }

  const sectorSev = sevOf(bucketShare(ctx.sectorAllocation, pos.sector), LIMITS.sector);
  if (sectorSev === 'high') score -= 12;
  else if (sectorSev === 'mid') score -= 7;

  const countrySev = sevOf(bucketShare(ctx.countryAllocation, pos.country), LIMITS.country);
  if (countrySev === 'high') score -= 10;
  else if (countrySev === 'mid') score -= 5;

  if (isFund(pos)) score += 6; // broad exposure helps balance

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 5) Concentration (high score == low risk)
 * --------------------------------------------------------------------------*/
function scoreConcentration(pos, ctx) {
  let score = 100;
  const single = !isDiversified(pos);
  const allocation = pos.allocation || 0;

  if (single) {
    if (allocation > LIMITS.position.high) score -= 45;
    else if (allocation > LIMITS.position.mid) score -= 25;
    else if (allocation > 0.035) score -= 10;
  }

  const sectorSev = sevOf(bucketShare(ctx.sectorAllocation, pos.sector), LIMITS.sector);
  if (sectorSev === 'high') score -= 18;
  else if (sectorSev === 'mid') score -= 10;

  const countrySev = sevOf(bucketShare(ctx.countryAllocation, pos.country), LIMITS.country);
  if (countrySev === 'high') score -= 15;
  else if (countrySev === 'mid') score -= 7;

  if (single) {
    const incomeSev = sevOf(incomeShareOf(pos, ctx), LIMITS.income);
    if (incomeSev === 'high') score -= 18;
    else if (incomeSev === 'mid') score -= 9;
  }

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * Total + interpretation
 * --------------------------------------------------------------------------*/
function computeScores(pos, ctx) {
  const parts = {
    safety: scoreSafety(pos),
    income: scoreIncome(pos, ctx),
    growth: scoreGrowth(pos),
    fit: scoreFit(pos, ctx),
    concentration: scoreConcentration(pos, ctx),
  };
  let total = 0;
  for (const k in parts) {
    total += parts[k] * SCORE_WEIGHTS[k];
    parts[k] = Math.round(parts[k]);
  }
  parts.total = Math.round(total);
  return parts;
}

/**
 * One score scale for the whole app (pills, ring, bars, diversification):
 * label + tone (CSS class tone-<name>, shared with all other status colors).
 */
const SCORE_LEVELS = [
  { min: 85, label: 'Sehr stark', tone: 'green' },
  { min: 70, label: 'Stark', tone: 'green' },
  { min: 55, label: 'Solide', tone: 'blue' },
  { min: 40, label: 'Schwach', tone: 'orange' },
  { min: -Infinity, label: 'Kritisch', tone: 'red' },
];

function scoreLevel(score) {
  return SCORE_LEVELS.find((l) => score >= l.min);
}
