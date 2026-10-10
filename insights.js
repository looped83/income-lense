/* ============================================================================
 * insights.js
 * ----------------------------------------------------------------------------
 * Action categories, per-position insights and the top-up model.
 *
 * Consistency rule: the category "Aufstocken" is exactly the candidate set of
 * the top-up plan (same gates, same target weight), and every "Beobachten"
 * signal blocks a top-up. Wording is deliberately non-advisory.
 * ==========================================================================*/

/* ----------------------------------------------------------------------------
 * Action categories
 * --------------------------------------------------------------------------*/
const ACTION_CATEGORIES = {
  add: { label: 'Aufstocken', tone: 'green', desc: 'Guter Score und Luft bis zum Zielgewicht – identisch mit den Kandidaten des Aufstockplans.' },
  hold: { label: 'Halten', tone: 'blue', desc: 'Solides Profil ohne akuten Handlungsbedarf.' },
  monitor: { label: 'Beobachten', tone: 'orange', desc: 'Auffällige Kennzahl (Rendite, Dividendenwachstum, Buchverlust oder Score) – vor weiterem Kauf prüfen.' },
  noadd: { label: 'Nicht aufstocken', tone: 'ochre', desc: 'Hoher Einzelanteil bei schwachen Signalen – weiteres Aufstocken erhöht das Klumpenrisiko.' },
  reduce: { label: 'Reduzieren prüfen', tone: 'red', desc: 'Sehr hoher Einzelanteil und schwache Signale – eine Teilreduzierung könnte geprüft werden.' },
  inactive: { label: 'Inaktiv', tone: 'faint', desc: 'Verkauft oder Watchlist – nicht in den Depotberechnungen enthalten.' },
};

/** Assign exactly one action category (needs pos.scores). */
function classifyAction(pos, ctx) {
  if (!pos.isActive) return 'inactive';

  const s = pos.scores;
  const alloc = pos.allocation || 0;
  const cagr = pos.dividendCagr;
  const gainRel = pos.gainRel;

  // Single-position concentration (broad ETFs are exempt).
  if (!isDiversified(pos)) {
    const weak = (hasNum(cagr) && cagr <= 0) || s.growth < 45 || (hasNum(gainRel) && gainRel < 0);
    const crowded = s.concentration < 45;
    if (alloc > LIMITS.position.high && (weak || crowded) && (s.total < 55 || incomeShareOf(pos, ctx) > LIMITS.income.high)) {
      return 'reduce';
    }
    if (alloc > LIMITS.position.mid && (weak || crowded || s.total < 55)) return 'noadd';
  }

  if (hasNum(gainRel) && gainRel <= LIMITS.drawdown) return 'monitor';
  // Non-payers (crypto, accumulating ETFs): the dividend score does not apply.
  if (!paysDividend(pos)) return 'hold';
  if (yieldSignal(pos) || (hasNum(cagr) && cagr < 0) || (!hasNum(cagr) && !hasNum(pos.dividendYield))) {
    return 'monitor';
  }
  if (topUpProfile(pos, ctx)) return 'add';
  return s.total >= LIMITS.minAddScore ? 'hold' : 'monitor';
}

/* ----------------------------------------------------------------------------
 * Insights: 3–6 German sentences per position, each tied to a CSV figure.
 * Needs pos.scores and pos.action.
 * --------------------------------------------------------------------------*/
function buildInsights(pos, ctx) {
  if (!pos.isActive) return ['Keine aktive Position im Depot; nicht in den Depotberechnungen enthalten.'];

  const out = [];
  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  const gainRel = pos.gainRel;
  const alloc = pos.allocation || 0;
  const payer = paysDividend(pos);
  const single = !isDiversified(pos);
  const incomeShare = incomeShareOf(pos, ctx);

  if (!payer) out.push('Schüttet keine Dividende aus; der dividendenbasierte Score ist nur eingeschränkt aussagekräftig.');

  // Yield + growth.
  if (hasNum(dy) && dy > LIMITS.highYield) {
    out.push(
      yieldSignal(pos)
        ? 'Sehr hohe Dividendenrendite ohne solides Wachstum; Nachhaltigkeit der Dividende prüfen.'
        : 'Sehr hohe Dividendenrendite, durch solides Dividendenwachstum abgefedert.'
    );
  } else if (hasNum(dy) && dy >= 0.02 && dy <= 0.06 && hasNum(cagr) && cagr > 0) {
    out.push('Attraktive Dividendenrendite mit positivem Dividendenwachstum.');
  } else if (hasNum(dy) && dy < 0.015 && payer) {
    out.push('Niedrige laufende Rendite; der Beitrag liegt eher im Wachstum als im Einkommen.');
  }

  // Income contribution vs. weight.
  if (single && incomeShare > LIMITS.income.mid) {
    out.push(
      alloc > LIMITS.position.mid
        ? 'Starker Dividendenbeitrag, aber der Depotanteil ist bereits hoch.'
        : 'Großer Dividendenzahler, der die Einkommenskonzentration erhöht.'
    );
  } else if (payer && incomeShare < 0.005) {
    out.push('Geringer Beitrag zum Gesamteinkommen des Depots.');
  }

  if (hasNum(pos.dividendYieldOnBuyin) && pos.dividendYieldOnBuyin >= 0.06) {
    out.push('Hoher Yield on Cost; die Position liefert relativ zum Einstand viel Einkommen.');
  }

  // Price performance.
  if (hasNum(gainRel) && gainRel <= LIMITS.drawdown) {
    out.push(`Deutlicher Buchverlust (${fmtSignedPercent(gainRel, 1)}); Investmentthese prüfen.`);
  } else if (hasNum(gainRel) && gainRel >= 0.25) {
    out.push('Deutlich positive Kursentwicklung; die Position trägt klar zum Depotwert bei.');
  }

  // Concentration.
  if (!single) {
    out.push('Breit streuender Fonds: Das Gewicht verteilt sich auf viele Unternehmen – kein Einzelwert-Klumpenrisiko.');
  } else {
    const sev = sevOf(alloc, LIMITS.position);
    if (sev === 'high') out.push('Sehr großer Depotanteil; ein Klumpenrisiko ist auffällig.');
    else if (sev === 'mid') out.push('Überdurchschnittlicher Depotanteil; weiteres Aufstocken erhöht das Konzentrationsrisiko.');
  }
  const sectorShare = bucketShare(ctx.sectorAllocation, pos.sector);
  if (sectorShare > LIMITS.sector.mid) {
    out.push(`Sektor ${pos.sector} ist im Depot mit ${fmtPercent(sectorShare, 1)} stark gewichtet.`);
  }

  if (pos.action === 'add') out.push('Luft bis zum Zielgewicht bei gutem Score; Kandidat im Aufstockplan.');
  if (hasNum(cagr) && cagr < 0) out.push('Rückläufige Dividende (negativer CAGR); ein Warnsignal für die Dividendensicherheit.');
  if (payer && !hasNum(dy) && !hasNum(cagr)) out.push('Für eine genauere Bewertung fehlen Dividenden- und Wachstumsdaten in der CSV.');

  if (out.length < 3) out.push('Solides Profil ohne ausgeprägte Auffälligkeiten in den CSV-Kennzahlen.');
  if (out.length < 3) out.push('Für eine genauere Entscheidung wären zusätzliche Fundamentaldaten nötig.');
  return out.slice(0, 6);
}

/* ----------------------------------------------------------------------------
 * Top-up model (target weights)
 * ----------------------------------------------------------------------------
 * Every eligible position gets a quality-scaled TARGET weight; the planner in
 * analysis.js distributes the budget proportional to quality × underweight
 * ("water-filling"), capped by the target and a hard single-position cap.
 * --------------------------------------------------------------------------*/
const TRANCHE_SIZE = 1000;

/** Weights that turn ranking + CSV metrics into a 0..1 quality. */
const TOPUP_WEIGHTS = { ranking: 1.0, diversification: 0.5, growth: 0.4, income: 0.4 };

const TOPUP_SOFT_MIN = 0.02; // a borderline candidate targets ~2 %
const TOPUP_SOFT_MAX = 0.06; // a top candidate targets ~6 %
const TOPUP_HARD_CAP = 0.08; // never push a single position beyond 8 %

/** Transparent 0..100 sub-metrics shared by gates, quality and reasons. */
function topUpMetrics(pos, ctx) {
  const dy = pos.dividendYield;
  const cagr = pos.dividendCagr;
  const sectorShare = bucketShare(ctx.sectorAllocation, pos.sector);
  const countryShare = bucketShare(ctx.countryAllocation, pos.country);

  // Diversification: underweight sector & country score higher; generic = neutral.
  const sectorComp = isGenericBucket(pos.sector) ? 60 : clamp(100 - (sectorShare / LIMITS.sector.high) * 100);
  const countryComp = isGenericBucket(pos.country) ? 60 : clamp(100 - (countryShare / 0.7) * 100);
  // Dividend growth: 12 %+ CAGR -> 100 (funds get a neutral default if missing).
  const growthScore = hasNum(cagr) ? clamp((cagr / 0.12) * 100) : isFund(pos) ? 50 : 40;
  // Yield attractiveness: the 2–6 % band is best.
  let incomeScore = 20;
  if (!hasNum(dy)) incomeScore = 40;
  else if (dy >= 0.02 && dy <= 0.06) incomeScore = 100;
  else if ((dy >= 0.01 && dy < 0.02) || (dy > 0.06 && dy <= LIMITS.highYield)) incomeScore = 60;
  else if (dy < 0.01) incomeScore = 30;

  return {
    alloc: pos.allocation || 0,
    dy,
    cagr,
    sectorShare,
    incomeShare: incomeShareOf(pos, ctx),
    diversification: (sectorComp + countryComp) / 2,
    growthScore,
    incomeScore,
  };
}

/** Hard gates: may this position receive new money at all? */
function topUpEligible(pos, ctx, m) {
  if (!paysDividend(pos) || pos.scores.total < LIMITS.minAddScore) return false;
  if ((num0(pos.value) + TRANCHE_SIZE) / (ctx.totalValue + TRANCHE_SIZE) > TOPUP_HARD_CAP) return false;
  if (yieldSignal(pos)) return false;
  if (hasNum(m.cagr) && m.cagr < 0) return false;
  if (hasNum(pos.gainRel) && pos.gainRel <= LIMITS.drawdown) return false;
  if (m.sectorShare > LIMITS.sector.high) return false;
  if (!isDiversified(pos) && m.incomeShare > LIMITS.income.high) return false;
  return true;
}

/** Quality 0..1: weighted blend of ranking + diversification + growth + income. */
function topUpQuality(pos, m) {
  const W = TOPUP_WEIGHTS;
  const q =
    (W.ranking * pos.scores.total +
      W.diversification * m.diversification +
      W.growth * m.growthScore +
      W.income * m.incomeScore) /
    (100 * (W.ranking + W.diversification + W.growth + W.income));
  return clamp(q, 0, 1);
}

/** Quality-scaled target weight. */
function topUpSoftCap(quality) {
  return TOPUP_SOFT_MIN + (TOPUP_SOFT_MAX - TOPUP_SOFT_MIN) * quality;
}

/**
 * Candidate profile (or null): eligible AND below its target weight.
 * attractiveness = quality × how far below target -> drives the budget split.
 */
function topUpProfile(pos, ctx) {
  const m = topUpMetrics(pos, ctx);
  if (!topUpEligible(pos, ctx, m)) return null;
  const quality = topUpQuality(pos, m);
  const target = topUpSoftCap(quality);
  if (m.alloc >= target) return null;
  return { m, quality, target, attractiveness: quality * Math.min(1, (target - m.alloc) / target) };
}

/** German reasons ("Wieso?") for a tranche; opts: { rank }. */
function topUpReasons(pos, m, opts = {}) {
  const reasons = [`Gesamt-Score ${pos.scores.total}${opts.rank ? ` – Rang ${opts.rank} im Depot` : ''}`];
  if (m.alloc < 0.02) reasons.push(`geringer Depotanteil (${fmtPercent(m.alloc, 1)}) – deutlich unter Zielgewicht`);
  else if (m.alloc < 0.04) reasons.push(`moderater Depotanteil (${fmtPercent(m.alloc, 1)})`);
  else reasons.push(`Depotanteil ${fmtPercent(m.alloc, 1)} – nähert sich dem Zielgewicht`);
  if (!isGenericBucket(pos.sector) && m.sectorShare < 0.1) {
    reasons.push(`untergewichteter Sektor ${pos.sector} (${fmtPercent(m.sectorShare, 1)})`);
  } else if (m.sectorShare > LIMITS.sector.mid) {
    reasons.push(`Sektor ${pos.sector} bereits hoch gewichtet (${fmtPercent(m.sectorShare, 1)})`);
  }
  if (hasNum(m.cagr) && m.cagr >= 0.1) reasons.push(`starkes Dividendenwachstum (CAGR ${fmtPercent(m.cagr, 1)})`);
  else if (hasNum(m.cagr) && m.cagr >= LIMITS.solidGrowth) reasons.push(`solides Dividendenwachstum (CAGR ${fmtPercent(m.cagr, 1)})`);
  if (hasNum(m.dy) && m.dy >= 0.02 && m.dy <= 0.06) reasons.push(`attraktive Dividendenrendite (${fmtPercent(m.dy)})`);
  else if (hasNum(m.dy) && m.dy > 0.06) reasons.push(`hohe Dividendenrendite (${fmtPercent(m.dy)})`);
  if (isDiversified(pos)) reasons.push(`breit streuender ${fmtSecurityType(pos.securityType)} verbessert die Diversifikation`);
  return reasons.slice(0, 5);
}
