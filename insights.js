/* ============================================================================
 * insights.js
 * ----------------------------------------------------------------------------
 * Rule-based German insight generation and "Action Ideas" categorisation.
 *
 * Everything here is derived from the parsed CSV + computed scores. No external
 * data is used. Wording is deliberately non-advisory ("prüfen", "könnte
 * sinnvoll sein", "auffällig") — this is analysis, not financial advice.
 * ==========================================================================*/

/**
 * Generate 3–6 German insight strings for a single position.
 * Each insight references the data that drives it, so the score is explainable.
 */
function buildInsights(pos, scores, ctx) {
  const out = [];

  // Inactive positions get a single, clear note.
  if (!pos.isActive) {
    out.push('Keine aktive Position im Depot; in den inaktiven Bereich verschoben.');
    return out;
  }

  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  const gainRel = pos.gainRel;
  const allocation = pos.allocation || 0;
  const annual = pos.totalDividendRate || 0;
  const yoc = pos.dividendYieldOnBuyin;
  const incomeShare =
    ctx.totalAnnualDividend > 0 ? annual / ctx.totalAnnualDividend : 0;
  const isETF = (pos.securityType || '').toUpperCase() !== 'EQUITY';

  // --- Yield + growth combinations ---
  if (hasNum(dy) && dy > 0.08) {
    if (hasNum(cagr) && cagr >= 0.05) {
      out.push('Sehr hohe Dividendenrendite, jedoch durch solides Dividendenwachstum etwas abgefedert.');
    } else {
      out.push('Hohe Dividendenrendite, aber das Wachstum sollte kritisch beobachtet werden.');
    }
  } else if (hasNum(dy) && dy >= 0.02 && dy <= 0.06 && hasNum(cagr) && cagr > 0) {
    out.push('Attraktive Dividendenrendite mit positivem Dividendenwachstum.');
  } else if (hasNum(dy) && dy < 0.015 && annual > 0) {
    out.push('Niedrige laufende Rendite; der Beitrag liegt eher im Wachstum als im Einkommen.');
  }

  // --- Income contribution vs. allocation ---
  if (incomeShare >= 0.05 && allocation >= 0.05) {
    out.push('Starker Dividendenbeitrag, aber der Depotanteil ist bereits hoch.');
  } else if (incomeShare >= 0.05) {
    out.push('Großer Dividendenzahler, der die Einkommenskonzentration erhöht.');
  } else if (annual > 0 && incomeShare < 0.005) {
    out.push('Geringer Beitrag zum Gesamteinkommen des Depots.');
  }

  // --- Yield on cost ---
  if (hasNum(yoc) && yoc >= 0.06) {
    out.push('Hoher Yield on Cost; die Position liefert relativ zum Einstandskurs viel Einkommen.');
  }

  // --- Price performance ---
  if (hasNum(gainRel) && gainRel <= -0.10 && annual > 0) {
    out.push('Negative Kursentwicklung trotz Dividendenbeitrag; Investmentthese prüfen.');
  } else if (hasNum(gainRel) && gainRel >= 0.25) {
    out.push('Deutlich positive Kursentwicklung; die Position trägt klar zum Depotwert bei.');
  }

  // --- Concentration risk ---
  if (allocation > 0.08) {
    out.push('Sehr großer Depotanteil; ein Klumpenrisiko ist auffällig.');
  } else if (allocation > 0.05) {
    out.push('Überdurchschnittlicher Depotanteil; weiteres Aufstocken erhöht das Konzentrationsrisiko.');
  }

  const sectorShare = ctx.sectorAllocation[pos.sector] || 0;
  if (sectorShare > 0.20 && pos.sector && pos.sector !== 'mixed') {
    out.push(`Sektor "${pos.sector}" ist im Depot mit ${fmtPercent(sectorShare, 1)} stark gewichtet.`);
  }

  // --- Add-candidate signal (good score + room) ---
  if (scores.total >= 70 && allocation <= 0.03) {
    out.push('Kleine Position mit gutem Score; ein schrittweiser Ausbau könnte geprüft werden.');
  }

  // --- Diversification value of ETFs ---
  if (isETF && scores.fit >= 60) {
    out.push('Breit streuender ETF, der die Diversifikation des Depots unterstützt.');
  }

  // --- Data quality / safety flags ---
  if (hasNum(cagr) && cagr < 0) {
    out.push('Rückläufiges Dividendenwachstum (negativer CAGR); ein Warnsignal für die Dividendensicherheit.');
  }
  if (!hasNum(dy) && !hasNum(cagr)) {
    out.push('Für eine genauere Bewertung fehlen Dividenden- und Wachstumsdaten in der CSV.');
  }

  // Ensure a minimum of 3 insights with a neutral fallback.
  if (out.length < 3) {
    out.push('Solides Profil ohne ausgeprägte Auffälligkeiten in den CSV-Kennzahlen.');
  }
  if (out.length < 3) {
    out.push('Für eine genauere Entscheidung wären zusätzliche Fundamentaldaten nötig.');
  }

  // Cap at 6 insights to keep cards readable.
  return out.slice(0, 6);
}

/* ----------------------------------------------------------------------------
 * ACTION IDEAS
 * ----------------------------------------------------------------------------
 * Assign each position to exactly one action category. Wording is non-advisory.
 * Category keys are stable; labels/descriptions are German.
 * --------------------------------------------------------------------------*/

const ACTION_CATEGORIES = {
  add: {
    label: 'Potenzielle Aufstockungskandidaten',
    desc: 'Guter Score, moderater Anteil – ein schrittweiser Ausbau könnte sinnvoll sein.',
    cls: 'cat-add',
  },
  hold: {
    label: 'Halten / Dividenden kassieren',
    desc: 'Solides Profil ohne akuten Handlungsbedarf.',
    cls: 'cat-hold',
  },
  monitor: {
    label: 'Beobachten',
    desc: 'Gemischtes Bild – auffällige Kennzahlen im Blick behalten.',
    cls: 'cat-monitor',
  },
  noadd: {
    label: 'Nicht weiter aufstocken',
    desc: 'Hoher Anteil oder schwache Signale sprechen eher gegen weiteres Aufstocken.',
    cls: 'cat-noadd',
  },
  reduce: {
    label: 'Reduzierung prüfen',
    desc: 'Sehr hoher Anteil und schwache Signale – eine Reduzierung könnte geprüft werden.',
    cls: 'cat-reduce',
  },
  inactive: {
    label: 'Inaktiv / verkauft / Watchlist',
    desc: 'Keine aktive Position im Depot.',
    cls: 'cat-inactive',
  },
};

/**
 * Decide the action category for a position based on score, allocation,
 * growth, yield and concentration signals.
 * Returns one of the ACTION_CATEGORIES keys.
 */
function classifyAction(pos, scores, ctx) {
  if (!pos.isActive) return 'inactive';

  const allocation = pos.allocation || 0;
  const total = scores.total;
  const growth = scores.growth;
  const cagr = pos.dividendCagr;
  const gainRel = pos.gainRel;
  const dy = pos.dividendYield;
  const annual = pos.totalDividendRate || 0;
  const incomeShare =
    ctx.totalAnnualDividend > 0 ? annual / ctx.totalAnnualDividend : 0;

  const weakGrowth =
    (hasNum(cagr) && cagr <= 0) || growth < 45 || (hasNum(gainRel) && gainRel < 0);
  const highYieldRisk = hasNum(dy) && dy > 0.08;
  const highConcentration = scores.concentration < 45;

  // Reduction candidates: very high allocation + weak signals + low score.
  if (
    allocation > 0.06 &&
    (weakGrowth || highConcentration) &&
    (total < 55 || incomeShare > 0.10)
  ) {
    return 'reduce';
  }

  // Do not add more: high allocation, weak growth, high concentration, low score.
  if (allocation > 0.05 && (weakGrowth || highConcentration || total < 55)) {
    return 'noadd';
  }

  // Monitor: mixed score, weak growth, high yield, negative gainRel, missing data.
  if (
    (total >= 45 && total < 62) ||
    highYieldRisk ||
    (hasNum(gainRel) && gainRel <= -0.10) ||
    (!hasNum(cagr) && !hasNum(dy))
  ) {
    return 'monitor';
  }

  // Add candidates: good score, low/moderate allocation, no extreme yield risk.
  if (
    total >= 68 &&
    allocation <= 0.04 &&
    !highYieldRisk &&
    !(hasNum(cagr) && cagr < 0)
  ) {
    return 'add';
  }

  // Hold: good/solid score, medium/high allocation, no urgent flag.
  if (total >= 55) {
    return 'hold';
  }

  // Anything else with a weak score but not extreme -> monitor.
  return 'monitor';
}

/* ----------------------------------------------------------------------------
 * TOP-UP PLAN — target-weight model
 * ----------------------------------------------------------------------------
 * Smarter & more granular than a flat greedy: every eligible position gets a
 * quality-scaled TARGET weight (derived from the score ranking + CSV metrics +
 * diversification). The planner in app.js then distributes the budget
 * proportionally to each position's quality AND how far it sits below its
 * target ("water-filling"), capped by concentration limits. Result: the budget
 * spreads finely across many individual values instead of hammering one name.
 *
 * Everything stays transparent (no black box) — the reasons drive the "Wieso?".
 * TRANCHE_SIZE must match the planner in app.js.
 * --------------------------------------------------------------------------*/
const TRANCHE_SIZE = 1000;

/**
 * Weighting that turns a position's ranking + CSV metrics into a 0..1 quality.
 * Higher quality -> higher target weight -> more of the budget. Easy to tune.
 */
const TOPUP_WEIGHTS = {
  ranking: 1.0, // overall score (the ranking; itself the SCORE_WEIGHTS blend)
  diversification: 0.5, // underweight sector / country
  growth: 0.4, // dividend growth (CAGR)
  income: 0.4, // yield attractiveness
};

// Quality-scaled target weight band + hard single-position cap.
const TOPUP_SOFT_MIN = 0.02; // a borderline candidate (quality ~0) targets ~2%
const TOPUP_SOFT_MAX = 0.06; // a top candidate (quality ~1) targets ~6%
const TOPUP_HARD_CAP = 0.08; // never push a single position beyond 8%

/** Clamp a value into 0..100. */
function clamp100(n) {
  return Math.max(0, Math.min(100, n));
}

/**
 * Compute the transparent 0..100 sub-metrics for a position from the CSV +
 * current (simulated) context. Shared by eligibility, quality and reasons so
 * everything stays consistent.
 */
function topUpMetrics(pos, ctx) {
  const alloc = pos.allocation || 0;
  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  const sectorShare = ctx.sectorAllocation[pos.sector] || 0;
  const countryShare = ctx.countryAllocation[pos.country] || 0;
  const isFund = (pos.securityType || '').toUpperCase() !== 'EQUITY';
  const genericSector = pos.sector === 'mixed' || pos.sector === 'Unbekannt';
  const incomeShare =
    ctx.totalAnnualDividend > 0 ? num0(pos.totalDividendRate) / ctx.totalAnnualDividend : 0;

  // Diversification: underweight sector & country score higher.
  const sectorComp = genericSector ? 60 : clamp100(100 - (sectorShare / 0.25) * 100);
  const countryComp = clamp100(100 - (countryShare / 0.7) * 100);
  const diversification = (sectorComp + countryComp) / 2;
  // Dividend growth: 12%+ CAGR -> 100 (funds/ETFs get a neutral default if n/a).
  const growthScore = hasNum(cagr) ? clamp100((cagr / 0.12) * 100) : isFund ? 50 : 40;
  // Yield attractiveness: sweet spot 2–6% is best.
  let incomeScore;
  if (!hasNum(dy)) incomeScore = 40;
  else if (dy >= 0.02 && dy <= 0.06) incomeScore = 100;
  else if ((dy >= 0.01 && dy < 0.02) || (dy > 0.06 && dy <= 0.08)) incomeScore = 60;
  else if (dy < 0.01) incomeScore = 30;
  else incomeScore = 20;

  return {
    alloc, dy, cagr, sectorShare, countryShare, isFund, genericSector,
    incomeShare, diversification, growthScore, incomeScore,
  };
}

/** Hard gates: may this position receive a tranche at all? */
function topUpEligible(pos, ctx, m) {
  const s = pos.scores;
  if (s.total < 55) return false; // too weak overall
  const projAlloc = (num0(pos.value) + TRANCHE_SIZE) / (ctx.totalValue + TRANCHE_SIZE);
  if (projAlloc > TOPUP_HARD_CAP) return false; // would breach single-position cap
  if (hasNum(m.dy) && m.dy > 0.08 && !(hasNum(m.cagr) && m.cagr >= 0.05)) return false; // yield trap
  if (m.sectorShare > 0.25 && !m.genericSector) return false; // sector too heavy
  if (hasNum(m.cagr) && m.cagr < 0) return false; // shrinking dividend
  if (m.incomeShare > 0.1) return false; // already dominates portfolio income
  return true;
}

/** Quality 0..1: weighted blend of ranking + diversification + growth + income. */
function topUpQuality(pos, m) {
  const W = TOPUP_WEIGHTS;
  const wsum = W.ranking + W.diversification + W.growth + W.income;
  const q =
    (W.ranking * (pos.scores.total / 100) +
      W.diversification * (m.diversification / 100) +
      W.growth * (m.growthScore / 100) +
      W.income * (m.incomeScore / 100)) /
    wsum;
  return Math.max(0, Math.min(1, q));
}

/** Quality-scaled target weight (soft cap) for a position. */
function topUpSoftCap(quality) {
  return TOPUP_SOFT_MIN + (TOPUP_SOFT_MAX - TOPUP_SOFT_MIN) * quality;
}

/** German reasons ("Wieso?") for a chosen tranche; opts: { rank, targetWeight }. */
function topUpReasons(pos, m, opts = {}) {
  const s = pos.scores;
  const reasons = [];
  reasons.push(
    opts.rank ? `hoher Gesamt-Score (${s.total}) – Rang ${opts.rank} im Depot` : `guter Gesamt-Score (${s.total})`
  );
  if (m.alloc < 0.02) reasons.push(`geringer Depotanteil (${fmtPercent(m.alloc, 1)}) – deutlich unter Zielgewicht`);
  else if (m.alloc < 0.04) reasons.push(`moderater Depotanteil (${fmtPercent(m.alloc, 1)})`);
  else reasons.push(`Depotanteil ${fmtPercent(m.alloc, 1)} – nähert sich dem Zielgewicht`);
  if (!m.genericSector && m.sectorShare < 0.1)
    reasons.push(`untergewichteter Sektor ${pos.sector} (${fmtPercent(m.sectorShare, 1)})`);
  else if (!m.genericSector && m.sectorShare > 0.2)
    reasons.push(`Sektor ${pos.sector} bereits hoch gewichtet (${fmtPercent(m.sectorShare, 1)})`);
  if (hasNum(m.cagr) && m.cagr >= 0.1) reasons.push(`starkes Dividendenwachstum (CAGR ${fmtPercent(m.cagr, 1)})`);
  else if (hasNum(m.cagr) && m.cagr >= 0.05) reasons.push(`solides Dividendenwachstum (CAGR ${fmtPercent(m.cagr, 1)})`);
  if (hasNum(m.dy) && m.dy >= 0.02 && m.dy <= 0.06) reasons.push(`attraktive Dividendenrendite (${fmtPercent(m.dy)})`);
  else if (hasNum(m.dy) && m.dy > 0.06 && m.dy <= 0.08) reasons.push(`hohe Dividendenrendite (${fmtPercent(m.dy)})`);
  if (m.isFund) reasons.push(`breit streuender ${fmtSecurityType(pos.securityType)} verbessert die Diversifikation`);
  return reasons.slice(0, 5);
}
