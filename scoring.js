/* ============================================================================
 * scoring.js
 * ----------------------------------------------------------------------------
 * Transparent, rule-based scoring model for the Dividend Portfolio Analyzer.
 *
 * Design goals:
 *   - No black box. Every sub-score is computed from explicit rules.
 *   - Each rule is commented so the user understands *why* a score is given.
 *   - Weights live in SCORE_WEIGHTS and are trivial to adjust.
 *
 * All sub-scores are normalised to the 0..100 range.
 *
 * Total Score =
 *   30% Dividend Quality / Safety
 *   25% Income Strength
 *   20% Growth
 *   15% Portfolio Fit
 *   10% Concentration Risk    (high score = low risk)
 *
 * Each scoring function receives:
 *   - pos:   the parsed position object (numbers already parsed)
 *   - ctx:   portfolio context with aggregates (sector totals, etc.)
 * ==========================================================================*/

/** Top-level weights for the total score. Easy to tweak. */
const SCORE_WEIGHTS = {
  safety: 0.30, // Dividend quality / safety
  income: 0.25, // Income strength
  growth: 0.20, // Growth
  fit: 0.15, // Portfolio fit
  concentration: 0.10, // Concentration risk (high = safe)
};

/** Clamp a number into the [min, max] range. */
function clamp(n, min = 0, max = 100) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/* ----------------------------------------------------------------------------
 * 1) DIVIDEND SAFETY / QUALITY SCORE  (0..100)
 * --------------------------------------------------------------------------*/
function scoreSafety(pos) {
  let score = 50; // neutral baseline

  const dy = pos.dividendYield; // fraction, e.g. 0.0386
  const cagr = pos.dividendCagr; // fraction, e.g. 0.1962
  const freq = (pos.dividendFrequency || '').toLowerCase();
  const hasDividend = (pos.totalDividendRate || 0) > 0 || (pos.dividendRate || 0) > 0;

  // Reward a healthy "sweet spot" yield between 2% and 6%.
  if (hasNum(dy)) {
    if (dy >= 0.02 && dy <= 0.06) {
      score += 22; // ideal sustainable yield band
    } else if (dy > 0.06 && dy <= 0.08) {
      score += 8; // elevated but often still ok
    } else if (dy > 0.08) {
      // Very high yield = risk, unless dividend growth is convincing.
      score -= hasNum(cagr) && cagr >= 0.05 ? 5 : 18;
    } else if (dy >= 0.01 && dy < 0.02) {
      score += 4; // low but acceptable
    } else if (dy >= 0 && dy < 0.01) {
      // Slightly penalise sub-1% yield for an income-oriented holding.
      score -= 6;
    }
  }

  // Reward positive dividend growth (CAGR); penalise shrinking dividends.
  if (hasNum(cagr)) {
    if (cagr >= 0.10) score += 14;
    else if (cagr >= 0.05) score += 9;
    else if (cagr > 0) score += 4;
    else if (cagr === 0) score -= 2;
    else score -= 12; // negative dividend CAGR is a clear red flag
  }

  // Reward a regular, frequent payout cadence (more predictable income).
  if (freq === 'monthly') score += 8;
  else if (freq === 'quarterly') score += 6;
  else if (freq === 'biannually') score += 3;
  else if (freq === 'annually') score += 2;

  // Penalise positions that pay no dividend at all.
  if (!hasDividend) score -= 25;

  // Penalise missing dividend data (cannot assess safety).
  if (!hasNum(dy) && !hasNum(cagr)) score -= 10;

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 2) INCOME STRENGTH SCORE  (0..100)
 * --------------------------------------------------------------------------*/
function scoreIncome(pos, ctx) {
  let score = 40; // baseline

  const annual = pos.totalDividendRate || 0;
  const yoc = pos.dividendYieldOnBuyin; // yield on cost (fraction)
  const freq = (pos.dividendFrequency || '').toLowerCase();
  const allocation = pos.allocation || 0;

  // Share of the whole portfolio's annual dividend income this position covers.
  const incomeShare =
    ctx.totalAnnualDividend > 0 ? annual / ctx.totalAnnualDividend : 0;

  // Reward meaningful contribution to total income.
  if (incomeShare >= 0.06) score += 30;
  else if (incomeShare >= 0.03) score += 22;
  else if (incomeShare >= 0.015) score += 14;
  else if (incomeShare >= 0.005) score += 7;
  else if (annual > 0) score += 2;

  // Reward high yield on cost (income relative to invested capital).
  if (hasNum(yoc)) {
    if (yoc >= 0.06) score += 18;
    else if (yoc >= 0.04) score += 12;
    else if (yoc >= 0.025) score += 7;
    else if (yoc > 0) score += 2;
  }

  // Slightly reward monthly / quarterly payers (smoother cash flow).
  if (freq === 'monthly') score += 6;
  else if (freq === 'quarterly') score += 3;

  // Penalise positions that take up a lot of room but deliver little income.
  if (allocation >= 0.03 && incomeShare < allocation * 0.5) {
    score -= 12; // large footprint, weak income pull
  }

  // No income at all -> floor the score.
  if (annual <= 0) score = Math.min(score, 10);

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 3) GROWTH SCORE  (0..100)
 * --------------------------------------------------------------------------*/
function scoreGrowth(pos) {
  let score = 45; // baseline

  const cagr = pos.dividendCagr; // dividend growth
  const gainRel = pos.gainRel; // unrealised price performance (fraction)
  const isETF = (pos.securityType || '').toUpperCase() !== 'EQUITY';

  // Reward strong dividend CAGR; penalise negative growth.
  if (hasNum(cagr)) {
    if (cagr >= 0.12) score += 28;
    else if (cagr >= 0.08) score += 20;
    else if (cagr >= 0.04) score += 12;
    else if (cagr > 0) score += 5;
    else if (cagr === 0) score -= 4;
    else score -= 16; // shrinking dividends
  } else {
    // Missing growth data: don't punish ETFs as harshly (often n/a by design).
    score -= isETF ? 4 : 10;
  }

  // Reward positive price performance; mildly penalise drawdowns.
  if (hasNum(gainRel)) {
    if (gainRel >= 0.25) score += 16;
    else if (gainRel >= 0.10) score += 10;
    else if (gainRel > 0) score += 5;
    else if (gainRel > -0.10) score -= 4;
    else score -= 10; // meaningful loss
  }

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 4) PORTFOLIO FIT SCORE  (0..100)
 * --------------------------------------------------------------------------*/
function scoreFit(pos, ctx) {
  let score = 55; // baseline

  const allocation = pos.allocation || 0;
  const isETF = (pos.securityType || '').toUpperCase() !== 'EQUITY';

  // Reward low / moderate allocation (room to grow without overweighting).
  if (allocation <= 0.02) score += 18;
  else if (allocation <= 0.04) score += 10;
  else if (allocation <= 0.06) score += 2;
  else if (allocation <= 0.08) score -= 10;
  else score -= 22; // already a very large position

  // Penalise sector overconcentration (this position's sector > 20% of depot).
  const sectorShare = ctx.sectorAllocation[pos.sector] || 0;
  if (sectorShare > 0.25) score -= 12;
  else if (sectorShare > 0.20) score -= 7;

  // Penalise country overconcentration (this position's country > 60% of depot).
  const countryShare = ctx.countryAllocation[pos.country] || 0;
  if (countryShare > 0.60) score -= 10;
  else if (countryShare > 0.45) score -= 5;

  // Diversifying ETFs get a small fit bonus (broad exposure helps balance).
  if (isETF) score += 6;

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * 5) CONCENTRATION RISK SCORE  (0..100)  -- high score == LOW risk
 * --------------------------------------------------------------------------*/
function scoreConcentration(pos, ctx) {
  let score = 100; // start safe, subtract for risk

  const allocation = pos.allocation || 0;

  // Penalise large single-position weight.
  if (allocation > 0.08) score -= 45; // strongly penalise > 8%
  else if (allocation > 0.05) score -= 25; // penalise > 5%
  else if (allocation > 0.035) score -= 10;

  // Penalise sector overconcentration (> 20% of the whole depot).
  const sectorShare = ctx.sectorAllocation[pos.sector] || 0;
  if (sectorShare > 0.30) score -= 18;
  else if (sectorShare > 0.20) score -= 10;

  // Penalise country overconcentration (> 60% of the whole depot).
  const countryShare = ctx.countryAllocation[pos.country] || 0;
  if (countryShare > 0.60) score -= 15;
  else if (countryShare > 0.45) score -= 7;

  // Penalise positions that dominate total dividend income.
  const annual = pos.totalDividendRate || 0;
  const incomeShare =
    ctx.totalAnnualDividend > 0 ? annual / ctx.totalAnnualDividend : 0;
  if (incomeShare > 0.10) score -= 18;
  else if (incomeShare > 0.06) score -= 9;

  return clamp(score);
}

/* ----------------------------------------------------------------------------
 * TOTAL SCORE + interpretation
 * --------------------------------------------------------------------------*/
function computeScores(pos, ctx) {
  const safety = scoreSafety(pos);
  const income = scoreIncome(pos, ctx);
  const growth = scoreGrowth(pos);
  const fit = scoreFit(pos, ctx);
  const concentration = scoreConcentration(pos, ctx);

  const total =
    safety * SCORE_WEIGHTS.safety +
    income * SCORE_WEIGHTS.income +
    growth * SCORE_WEIGHTS.growth +
    fit * SCORE_WEIGHTS.fit +
    concentration * SCORE_WEIGHTS.concentration;

  return {
    safety: Math.round(safety),
    income: Math.round(income),
    growth: Math.round(growth),
    fit: Math.round(fit),
    concentration: Math.round(concentration),
    total: Math.round(total),
  };
}

/** Map a total score to a German interpretation label + severity class. */
function interpretScore(total) {
  if (total >= 85) return { label: 'Sehr stark', cls: 'score-excellent' };
  if (total >= 70) return { label: 'Stark', cls: 'score-good' };
  if (total >= 55) return { label: 'Solide / beobachten', cls: 'score-ok' };
  if (total >= 40) return { label: 'Schwachstellen prüfen', cls: 'score-weak' };
  return { label: 'Kritisch / nicht aufstocken', cls: 'score-critical' };
}

/** Pick a color for a 0..100 score (used for circles / bars). */
function scoreColor(score) {
  if (score >= 70) return '#2ecc71'; // green  -> strong
  if (score >= 55) return '#27ae8f'; // teal   -> solid
  if (score >= 40) return '#f39c12'; // orange -> watch
  return '#e74c3c'; // red -> critical
}
