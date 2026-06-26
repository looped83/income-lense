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
