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
 * TOP-UP PLAN — per-candidate evaluation
 * ----------------------------------------------------------------------------
 * Given a position and the (simulated) portfolio context, decide whether it is
 * eligible to receive the next 1.000 € tranche, compute a priority value and a
 * list of German reasons explaining WHY. The greedy planner in app.js calls
 * this for every position before each tranche and picks the highest priority.
 *
 * Rule-based and transparent — no black box. The reasons drive the "Wieso?".
 * TRANCHE_SIZE must match the planner in app.js.
 * --------------------------------------------------------------------------*/
const TRANCHE_SIZE = 1000;

/**
 * Weighting of the top-up priority. The recommendation is driven dynamically by
 *   - the score RANKING (pos.scores.total, itself the SCORE_WEIGHTS blend),
 *   - CSV-derived metrics (allocation, sector/country, CAGR, yield),
 *   - and diversification of the individual portfolio.
 * All weights are easy to adjust here.
 */
const TOPUP_WEIGHTS = {
  ranking: 1.0, // overall score (the ranking)
  headroom: 0.6, // allocation room to grow
  diversification: 0.5, // underweight sector / country
  growth: 0.4, // dividend growth (CAGR)
  income: 0.4, // yield attractiveness
  repeatPenalty: 20, // per tranche already given to this value -> spreads the budget
};

/** Clamp a value into 0..100. */
function clamp100(n) {
  return Math.max(0, Math.min(100, n));
}

/**
 * Evaluate a position as a candidate for the next 1.000 € tranche.
 * Returns { eligible, priority, reasons }. opts: { timesChosen, rank }.
 */
function topUpCandidate(pos, ctx, opts = {}) {
  const timesChosen = opts.timesChosen || 0;
  const rank = opts.rank;
  const s = pos.scores;
  const alloc = pos.allocation || 0;
  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  const sectorShare = ctx.sectorAllocation[pos.sector] || 0;
  const countryShare = ctx.countryAllocation[pos.country] || 0;
  const isFund = (pos.securityType || '').toUpperCase() !== 'EQUITY';
  const genericSector = pos.sector === 'mixed' || pos.sector === 'Unbekannt';
  const incomeShare =
    ctx.totalAnnualDividend > 0 ? num0(pos.totalDividendRate) / ctx.totalAnnualDividend : 0;

  // --- Hard eligibility gates (a tranche must not create obvious problems) ---
  if (s.total < 55) return { eligible: false }; // too weak overall
  const projAlloc = (num0(pos.value) + TRANCHE_SIZE) / (ctx.totalValue + TRANCHE_SIZE);
  if (projAlloc > 0.08) return { eligible: false }; // would breach 8% single-position cap
  if (hasNum(dy) && dy > 0.08 && !(hasNum(cagr) && cagr >= 0.05)) return { eligible: false }; // yield trap
  if (sectorShare > 0.25 && !genericSector) return { eligible: false }; // sector too heavy
  if (hasNum(cagr) && cagr < 0) return { eligible: false }; // shrinking dividend

  // --- Transparent 0..100 sub-metrics derived from the CSV ---
  // Allocation headroom: ~0% allocation -> 100, 6%+ -> 0.
  const headroom = clamp100(100 - (alloc / 0.06) * 100);
  // Diversification: underweight sector & country score higher.
  const sectorComp = genericSector ? 60 : clamp100(100 - (sectorShare / 0.25) * 100);
  const countryComp = clamp100(100 - (countryShare / 0.7) * 100);
  const diversification = (sectorComp + countryComp) / 2;
  // Dividend growth: 12%+ CAGR -> 100 (ETFs/funds get a neutral default if n/a).
  const growthScore = hasNum(cagr) ? clamp100((cagr / 0.12) * 100) : isFund ? 50 : 40;
  // Yield attractiveness: sweet spot 2–6% is best.
  let incomeScore;
  if (!hasNum(dy)) incomeScore = 40;
  else if (dy >= 0.02 && dy <= 0.06) incomeScore = 100;
  else if ((dy >= 0.01 && dy < 0.02) || (dy > 0.06 && dy <= 0.08)) incomeScore = 60;
  else if (dy < 0.01) incomeScore = 30;
  else incomeScore = 20;

  // --- Weighted priority (the "Gewichtung") ---
  const W = TOPUP_WEIGHTS;
  let priority =
    W.ranking * s.total +
    W.headroom * headroom +
    W.diversification * diversification +
    W.growth * growthScore +
    W.income * incomeScore -
    W.repeatPenalty * timesChosen;

  // Guard against one payer dominating total income.
  if (incomeShare > 0.08) priority -= 30;

  // --- Reasons (the "Wieso?"), derived from the same components ---
  const reasons = [];
  reasons.push(
    rank ? `hoher Gesamt-Score (${s.total}) – Rang ${rank} im Depot` : `guter Gesamt-Score (${s.total})`
  );
  if (alloc < 0.02) reasons.push(`geringer Depotanteil (${fmtPercent(alloc, 1)}) – viel Spielraum`);
  else if (alloc < 0.04) reasons.push(`moderater Depotanteil (${fmtPercent(alloc, 1)})`);
  else if (alloc >= 0.05) reasons.push(`Anteil bereits erhöht (${fmtPercent(alloc, 1)})`);
  if (!genericSector && sectorShare < 0.10)
    reasons.push(`untergewichteter Sektor ${pos.sector} (${fmtPercent(sectorShare, 1)})`);
  else if (!genericSector && sectorShare > 0.20)
    reasons.push(`Sektor ${pos.sector} bereits hoch gewichtet (${fmtPercent(sectorShare, 1)})`);
  if (hasNum(cagr) && cagr >= 0.10)
    reasons.push(`starkes Dividendenwachstum (CAGR ${fmtPercent(cagr, 1)})`);
  else if (hasNum(cagr) && cagr >= 0.05)
    reasons.push(`solides Dividendenwachstum (CAGR ${fmtPercent(cagr, 1)})`);
  if (hasNum(dy) && dy >= 0.02 && dy <= 0.06)
    reasons.push(`attraktive Dividendenrendite (${fmtPercent(dy)})`);
  else if (hasNum(dy) && dy > 0.06 && dy <= 0.08)
    reasons.push(`hohe Dividendenrendite (${fmtPercent(dy)})`);
  if (incomeShare > 0.08) reasons.push('trägt bereits viel zum Gesamteinkommen bei');
  if (isFund) reasons.push(`breit streuender ${fmtSecurityType(pos.securityType)} verbessert die Diversifikation`);

  return { eligible: true, priority, reasons: reasons.slice(0, 5) };
}
