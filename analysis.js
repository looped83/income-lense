/* ============================================================================
 * analysis.js
 * ----------------------------------------------------------------------------
 * Pure portfolio analysis (no DOM): positions, context, KPIs, risk,
 * recommendations, income distribution, target 2033 and the top-up plan.
 * Everything is derived from the CSV; nothing is invented.
 * ==========================================================================*/

const TARGET_YEAR = 2033;

const NUMERIC_FIELDS = [
  'quantity', 'buyin', 'buyinTotal', 'price', 'value', 'gain', 'gainRel',
  'allocation', 'dividendYield', 'dividendYieldOnBuyin', 'totalDividendRate',
  'dividendRate', 'dividendCagr', 'taxRate',
];
const TEXT_FIELDS = [
  'symbol', 'isin', 'name', 'dividendFrequency', 'dividendCagrPeriod',
  'securityType', 'originalDividendCurrency', 'exDate', 'payDate',
];

/** Severity metadata shared by recommendations and the overview. */
const SEVERITY = {
  high: { label: 'Hoch', plural: 'Hoch', tone: 'red', rank: 0 },
  mid: { label: 'Mittel', plural: 'Mittel', tone: 'orange', rank: 1 },
  low: { label: 'Chance', plural: 'Chancen', tone: 'green', rank: 2 },
  info: { label: 'Hinweis', plural: 'Hinweise', tone: 'blue', rank: 3 },
};

const byScore = (a, b) => b.scores.total - a.scores.total;
const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);

/* ----------------------------------------------------------------------------
 * Positions & context
 * --------------------------------------------------------------------------*/

/** Raw CSV row -> typed position. Active = market value > 0. */
function buildPosition(row) {
  const pos = {};
  for (const f of TEXT_FIELDS) pos[f] = (row[f] || '').trim();
  for (const f of NUMERIC_FIELDS) pos[f] = parseNum(row[f]);
  pos.sector = (row.sector || '').trim() || 'Unbekannt';
  pos.country = (row.country || '').trim() || 'Unbekannt';
  pos.isActive = hasNum(pos.value) && pos.value > 0;
  return pos;
}

/**
 * Portfolio aggregates for scoring. Also refreshes each position's allocation
 * from its value, so the real portfolio and the top-up simulation share one
 * definition.
 */
function computeContext(list) {
  const totalValue = sum(list, (p) => num0(p.value));
  const share = (v) => (totalValue > 0 ? v / totalValue : 0);
  const sectorAllocation = {};
  const countryAllocation = {};
  for (const p of list) {
    p.allocation = share(num0(p.value));
    sectorAllocation[p.sector] = (sectorAllocation[p.sector] || 0) + p.allocation;
    countryAllocation[p.country] = (countryAllocation[p.country] || 0) + p.allocation;
  }
  return {
    totalValue,
    totalAnnualDividend: sum(list, (p) => num0(p.totalDividendRate)),
    sectorAllocation,
    countryAllocation,
  };
}

/** Net share after the CSV's withholding/flat tax rate. */
function netFactor(p) {
  return 1 - (hasNum(p.taxRate) ? p.taxRate : 0);
}

/** Income-weighted dividend CAGR across all payers with a growth figure. */
function weightedCagr(active) {
  let wSum = 0;
  let weight = 0;
  for (const p of active) {
    const t = num0(p.totalDividendRate);
    if (t > 0 && hasNum(p.dividendCagr)) {
      wSum += t * p.dividendCagr;
      weight += t;
    }
  }
  return weight > 0 ? wSum / weight : 0;
}

/** Largest item by a numeric getter (or null). */
function maxBy(list, fn) {
  let best = null;
  for (const x of list) if (!best || fn(x) > fn(best)) best = x;
  return best;
}

/** Sorted [key, share] entries of value aggregated by a key getter. */
function sharesBy(list, keyFn, valueFn) {
  const map = {};
  let total = 0;
  for (const p of list) {
    const v = num0(valueFn(p));
    const k = keyFn(p) || 'Unbekannt';
    map[k] = (map[k] || 0) + v;
    total += v;
  }
  return Object.entries(map)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => [k, v / total])
    .sort((a, b) => b[1] - a[1]);
}

/* ----------------------------------------------------------------------------
 * Entry point
 * --------------------------------------------------------------------------*/
function analyze(positions) {
  const active = positions.filter((p) => p.isActive);
  const inactive = positions.filter((p) => !p.isActive);
  const ctx = computeContext(active);

  // Order matters: categories need scores, insights reference the category.
  for (const p of positions) p.scores = computeScores(p, ctx);
  for (const p of positions) p.action = classifyAction(p, ctx);
  for (const p of positions) p.insights = buildInsights(p, ctx);

  const ranked = [...active].sort(byScore);
  ranked.forEach((p, i) => (p.rank = i + 1));

  const data = {
    positions,
    active,
    inactive,
    ranked,
    ctx,
    kpis: computeKpis(active, ctx),
    risk: computeRisk(active, ctx),
    income: computeIncomeDistribution(active),
    upcoming: upcomingPayments(active),
    cagr: weightedCagr(active),
  };
  data.recs = buildRecommendations(data);
  return data;
}

/* ----------------------------------------------------------------------------
 * KPIs
 * --------------------------------------------------------------------------*/
function computeKpis(active, ctx) {
  const invested = sum(active, (p) => num0(p.buyinTotal));
  const gain = sum(active, (p) => num0(p.gain));
  const annual = ctx.totalAnnualDividend;
  return {
    totalValue: ctx.totalValue,
    invested,
    gain,
    gainRel: invested > 0 ? gain / invested : NaN,
    annualDividend: annual,
    weightedYield: ctx.totalValue > 0 ? annual / ctx.totalValue : NaN,
    weightedYoc: invested > 0 ? annual / invested : NaN,
    activeCount: active.length,
    payerCount: active.filter(paysDividend).length,
    largestPayer: maxBy(active.filter(paysDividend), (p) => num0(p.totalDividendRate)),
  };
}

/* ----------------------------------------------------------------------------
 * Risk & allocation
 * --------------------------------------------------------------------------*/

/** Effective number of items = 1 / HHI (sum of squared shares). */
function effectiveCount(shares) {
  const hhi = shares.reduce((s, w) => s + w * w, 0);
  return hhi > 0 ? 1 / hhi : 0;
}

function computeRisk(active, ctx) {
  const byWeight = [...active].sort((a, b) => b.allocation - a.allocation);
  const weights = byWeight.map((p) => p.allocation);
  const payers = active
    .filter(paysDividend)
    .map((p) => ({ p, s: incomeShareOf(p, ctx) }))
    .sort((a, b) => b.s - a.s);

  const sectorEntries = Object.entries(ctx.sectorAllocation).sort((a, b) => b[1] - a[1]);
  const countryEntries = Object.entries(ctx.countryAllocation).sort((a, b) => b[1] - a[1]);
  const largestSector = sectorEntries.find(([k]) => !isGenericBucket(k)) || null;
  const largestCountry = countryEntries.find(([k]) => !isGenericBucket(k)) || null;

  const effN = effectiveCount(weights);
  const effNIncome = effectiveCount(payers.map((x) => x.s));

  // Diversification score (0..100, transparent):
  // 30+ effective holdings -> 100; largest sector 10 % -> 100 … 35 % -> 0;
  // largest country 30 % -> 100 … 70 % -> 0; 25+ effective payers -> 100.
  const posDiv = clamp((effN / 30) * 100);
  const sectorDiv = clamp(100 - (Math.max(0, (largestSector ? largestSector[1] : 0) - 0.1) / 0.25) * 100);
  const countryDiv = clamp(100 - (Math.max(0, (largestCountry ? largestCountry[1] : 0) - 0.3) / 0.4) * 100);
  const incomeDiv = clamp((effNIncome / 25) * 100);

  return {
    byWeight,
    payers,
    effN,
    effNIncome,
    top5: weights.slice(0, 5).reduce((s, w) => s + w, 0),
    top10: weights.slice(0, 10).reduce((s, w) => s + w, 0),
    largestSingle: byWeight.find((p) => !isDiversified(p)) || null,
    sectorEntries,
    countryEntries,
    largestSector,
    largestCountry,
    sectorIncomeEntries: sharesBy(active, (p) => p.sector, (p) => p.totalDividendRate),
    typeEntries: sharesBy(active, (p) => p.securityType, (p) => p.value),
    currencyEntries: sharesBy(active, (p) => p.originalDividendCurrency, (p) => p.value),
    diversification: Math.round(0.35 * posDiv + 0.25 * sectorDiv + 0.2 * countryDiv + 0.2 * incomeDiv),
  };
}

/* ----------------------------------------------------------------------------
 * Recommendations — the single list of findings (risk flags included).
 * Each rec: { sev: high|mid|low|info, cat, title, text, symbol? }.
 * --------------------------------------------------------------------------*/
function buildRecommendations({ active, ctx, risk }) {
  const recs = [];
  const add = (sev, cat, title, text, symbol) => recs.push({ sev, cat, title, text, symbol });
  const pct = (v) => fmtPercent(v, 1);

  // --- Portfolio: country & sector clusters (named buckets only) ---
  for (const [k, v] of risk.countryEntries) {
    const sev = isGenericBucket(k) ? null : sevOf(v, LIMITS.country);
    const name = fmtCountry(k);
    if (sev === 'high') {
      add(sev, 'Diversifizieren', `Länderklumpen ${name} (${pct(v)})`, `${pct(v)} des Depots entfallen auf ${name}. Eine breitere internationale Streuung könnte das Klumpenrisiko senken; weitere ${name}-Käufe eher zurückstellen.`);
    } else if (sev === 'mid') {
      add(sev, 'Diversifizieren', `Hohe ${name}-Gewichtung (${pct(v)})`, `${name} ist überdurchschnittlich gewichtet. Bei Neukäufen stärker auf andere Regionen achten könnte sinnvoll sein.`);
    }
  }
  for (const [k, v] of risk.sectorEntries) {
    const sev = isGenericBucket(k) ? null : sevOf(v, LIMITS.sector);
    if (sev === 'high') {
      add(sev, 'Diversifizieren', `Sektor ${k} stark gewichtet (${pct(v)})`, `Der Sektor ${k} macht ${pct(v)} des Depots aus. Weitere Käufe hier erhöhen das Konzentrationsrisiko; ergänzende Sektoren prüfen.`);
    } else if (sev === 'mid') {
      add(sev, 'Diversifizieren', `Sektor ${k} beobachten (${pct(v)})`, `${k} nähert sich einer hohen Gewichtung. Weitere Aufstockungen hier eher zurückhaltend.`);
    }
  }
  if (risk.effN < LIMITS.minEffective) {
    add('mid', 'Diversifizieren', `Geringe effektive Streuung (${fmtNumber(risk.effN, 1)})`, `Nach Gewichten wirkt das Depot wie nur ${fmtNumber(risk.effN, 1)} gleich große Positionen – trotz ${active.length} Werten.`);
  }

  // --- Position level ---
  for (const p of active) {
    const s = p.scores;
    const alloc = p.allocation;
    const cagr = p.dividendCagr;
    const single = !isDiversified(p);
    const bigSingle = single && alloc > LIMITS.position.mid;

    if (single) {
      const share = incomeShareOf(p, ctx);
      const incomeSev = sevOf(share, LIMITS.income);
      if (incomeSev) {
        add(incomeSev, 'Einkommen', `Einkommensklumpen ${p.symbol} (${pct(share)} der Dividenden)`, `${p.symbol} liefert ${pct(share)} deiner Dividenden. Eine Kürzung träfe dein Einkommen spürbar – weitere Aufstockung erhöht die Abhängigkeit.`, p.symbol);
      }
      const weightSev = sevOf(alloc, LIMITS.position);
      const weak = s.total < 55 || (hasNum(cagr) && cagr < 0);
      if (weightSev === 'high') {
        add('high', 'Reduzieren', `${p.symbol} übergewichtet (${pct(alloc)})`, `${p.name} liegt über ${fmtPercent(LIMITS.position.high, 0)} Depotanteil. Eine Teilreduzierung – mindestens aber ein Aufstockungsstopp – könnte das Klumpenrisiko begrenzen.`, p.symbol);
      } else if (weightSev === 'mid' && weak) {
        add('mid', 'Reduzieren', `${p.symbol} groß bei schwachen Signalen (${pct(alloc)})`, `Überdurchschnittlich groß bei schwächeren Kennzahlen (Score ${s.total}${hasNum(cagr) && cagr < 0 ? `, Dividenden-CAGR ${pct(cagr)}` : ''}). Reduzierung prüfen und nicht weiter aufstocken.`, p.symbol);
      } else if (weightSev === 'mid') {
        add('mid', 'Konzentration', `${p.symbol} überdurchschnittlich groß (${pct(alloc)})`, `Über ${fmtPercent(LIMITS.position.mid, 0)} Depotanteil. Halten ist unkritisch, weiteres Aufstocken erhöht aber das Klumpenrisiko.`, p.symbol);
      }
    }

    if (paysDividend(p) && s.total < 40) {
      add('high', 'Risiko', `${p.symbol}: kritischer Score (${s.total})`, `Nur ${s.total} von 100 Punkten. Position kritisch prüfen – nicht aufstocken; ggf. Trennung erwägen.`, p.symbol);
    }
    const ys = yieldSignal(p);
    if (ys === 'trap') {
      add('high', 'Risiko', `${p.symbol}: mögliche Renditefalle (${fmtPercent(p.dividendYield)})`, `Sehr hohe Rendite bei negativem Dividendenwachstum (${pct(cagr)}). Dividendensicherheit kritisch prüfen, bevor aufgestockt wird.`, p.symbol);
    } else if (ys === 'watch') {
      add('mid', 'Beobachten', `${p.symbol}: hohe Rendite prüfen (${fmtPercent(p.dividendYield)})`, 'Auffällig hohe Rendite ohne solides Dividendenwachstum. Nachhaltigkeit beobachten; nur mit Bedacht aufstocken.', p.symbol);
    }
    if (hasNum(cagr) && cagr < 0 && ys !== 'trap' && !bigSingle) {
      add('mid', 'Beobachten', `${p.symbol}: rückläufige Dividende`, `Negativer Dividenden-CAGR (${pct(cagr)}). Investmentthese und Dividendensicherheit prüfen.`, p.symbol);
    }
    if (hasNum(p.gainRel) && p.gainRel <= LIMITS.drawdown) {
      add('mid', 'Beobachten', `${p.symbol}: deutlicher Buchverlust (${fmtSignedPercent(p.gainRel, 1)})`, 'Prüfen, ob die ursprüngliche Investmentthese noch trägt – bis dahin nicht aufstocken.', p.symbol);
    }
  }

  // --- Opportunities: the strongest candidates of the top-up plan ---
  active
    .filter((p) => p.action === 'add')
    .map((p) => ({ p, prof: topUpProfile(p, ctx) }))
    .sort((a, b) => b.prof.attractiveness - a.prof.attractiveness)
    .slice(0, 4)
    .forEach(({ p, prof }) => {
      add('low', 'Aufstocken', `${p.symbol}: Aufstockung könnte sinnvoll sein`, `Score ${p.scores.total}, Anteil ${pct(p.allocation)} bei Zielgewicht ~${pct(prof.target)}. Ein schrittweiser Ausbau könnte das Profil verbessern – Details im Aufstockplan.`, p.symbol);
    });

  // --- Dividendless assets: one hint instead of "critical score" flags ---
  const nonPayers = active.filter((p) => !paysDividend(p)).map((p) => p.symbol);
  if (nonPayers.length) {
    add('info', 'Hinweis', `Werte ohne Dividende (${nonPayers.length})`, `${nonPayers.join(', ')} schütten keine Dividende aus (z. B. Krypto oder thesaurierende ETFs). Der dividendenbasierte Score ist hier nur eingeschränkt aussagekräftig.`);
  }

  // Dedupe by title, then sort by severity (stable).
  const seen = new Set();
  return recs
    .filter((r) => !seen.has(r.title) && seen.add(r.title))
    .sort((a, b) => SEVERITY[a.sev].rank - SEVERITY[b.sev].rank);
}

/* ----------------------------------------------------------------------------
 * Income distribution & upcoming payments
 * ----------------------------------------------------------------------------
 * Only the next payDate per position is in the CSV, so the other payments are
 * spread over the year from that month according to the frequency.
 * --------------------------------------------------------------------------*/
const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const PAYMENTS_PER_YEAR = { monthly: 12, quarterly: 4, biannually: 2, annually: 1 };

function paymentsPerYear(freq) {
  return PAYMENTS_PER_YEAR[(freq || '').toLowerCase()] || 0;
}

/** Parse an ISO date (YYYY-MM-DD) into a local Date, or null. */
function parseISODate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function computeIncomeDistribution(active) {
  const gross = new Array(12).fill(0);
  const net = new Array(12).fill(0);
  for (const p of active) {
    const ppy = paymentsPerYear(p.dividendFrequency);
    if (!paysDividend(p) || !ppy) continue;
    const per = p.totalDividendRate / ppy;
    const anchor = parseISODate(p.payDate)?.getMonth() ?? 0;
    for (let k = 0; k < ppy; k++) {
      const m = (anchor + k * (12 / ppy)) % 12;
      gross[m] += per;
      net[m] += per * netFactor(p);
    }
  }
  // Annual totals include payers without a known schedule, so every view
  // reports the same annual figures.
  const payers = active.filter(paysDividend);
  const grossAnnual = sum(payers, (p) => p.totalDividendRate);
  const netAnnual = sum(payers, (p) => p.totalDividendRate * netFactor(p));
  return { gross, net, grossAnnual, netAnnual, taxAnnual: grossAnnual - netAnnual };
}

/** Next pay date per position (today or later), soonest first. */
function upcomingPayments(active) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const list = [];
  for (const p of active) {
    const ppy = paymentsPerYear(p.dividendFrequency);
    const date = parseISODate(p.payDate);
    if (!paysDividend(p) || !ppy || !date || date < today) continue;
    list.push({ date, p, amount: p.totalDividendRate / ppy });
  }
  return list.sort((a, b) => a.date - b.date);
}

/* ----------------------------------------------------------------------------
 * Target 2033 — net dividend goal vs. organic projection
 * ----------------------------------------------------------------------------
 * Projects each position's NET dividend to TARGET_YEAR with its own (capped,
 * non-negative) CAGR, compares the sum with the monthly goal and splits the
 * gap across the payers still being invested into, weighted by score.
 * settings: { target (€/month net), savings (€/month), excluded (Set) }.
 * --------------------------------------------------------------------------*/
function computeTarget(data, settings) {
  const years = Math.max(1, TARGET_YEAR - new Date().getFullYear());
  const totalValue = data.ctx.totalValue;
  const growthOf = (g) => (hasNum(g) ? Math.max(0, Math.min(g, 0.15)) : 0);

  const rows = data.active.filter(paysDividend).map((p) => {
    const netNow = p.totalDividendRate * netFactor(p);
    const g = growthOf(p.dividendCagr);
    return {
      p,
      g,
      netNow,
      netProj: netNow * Math.pow(1 + g, years),
      yNet: hasNum(p.dividendYield) && p.dividendYield > 0 ? p.dividendYield * netFactor(p) : 0,
      excluded: settings.excluded.has(p.symbol),
      share: 0,
      addCapital: 0,
    };
  });
  const currentNet = sum(rows, (r) => r.netNow);
  const projectedNet = sum(rows, (r) => r.netProj);
  const gAvg = Math.max(0, Math.min(data.cagr, 0.12));
  const yPort = totalValue > 0 ? currentNet / totalValue : 0;
  const targetAnnual = settings.target * 12;
  const gap = Math.max(0, targetAnnual - projectedNet);

  // Split the missing net dividend by score; capital per position uses its own
  // net yield & growth, so the rows add up to the headline lump sum.
  const funded = rows.filter((r) => !r.excluded);
  const scoreSum = sum(funded, (r) => r.p.scores.total);
  let lump = 0;
  if (gap > 0 && scoreSum > 0) {
    for (const r of funded) {
      r.share = gap * (r.p.scores.total / scoreSum);
      const y = r.yNet > 0 ? r.yNet : yPort;
      r.addCapital = y > 0 ? r.share / (y * Math.pow(1 + r.g, years)) : 0;
      lump += r.addCapital;
    }
  }

  // Monthly savings whose future value (grown at gAvg) equals the lump grown at gAvg.
  const i = gAvg / 12;
  const n = years * 12;
  const annuity = i > 1e-9 ? (Math.pow(1 + i, n) - 1) / i : n;
  const monthly = lump > 0 ? (lump * Math.pow(1 + gAvg, years)) / annuity : 0;
  // Savings-rate scenario: invested at the portfolio net yield, capital grows at gAvg.
  const savingsAnnual = yPort * settings.savings * annuity;

  return {
    years,
    rows: rows.sort((a, b) => byScore(a.p, b.p)),
    fundedCount: funded.length,
    currentNet,
    projectedNet,
    savingsAnnual,
    gAvg,
    yPort,
    targetAnnual,
    gap,
    lump,
    monthly,
    reached: gap <= 0,
    noneFunded: gap > 0 && scoreSum <= 0,
  };
}

/* ----------------------------------------------------------------------------
 * Top-up plan (1.000 € tranches)
 * ----------------------------------------------------------------------------
 *   1) Candidates = category "Aufstocken" (topUpProfile): quality-scaled target
 *      weight + attractiveness = quality × underweight.
 *   2) Water-filling: the budget is split proportional to attractiveness,
 *      capped by the target and the hard cap; capped ones spill over.
 *   3) The € targets become tranches: each one funds the position furthest
 *      below its € target; weights + ranks are recomputed per tranche so the
 *      "Wieso?" stays accurate.
 * --------------------------------------------------------------------------*/
function buildTopUpPlan(active, trancheCount) {
  const sim = active.map((p) => ({ ...p })); // never mutate the real portfolio
  let ctx = computeContext(sim);

  const candidates = [];
  for (const p of sim) {
    const prof = topUpProfile(p, ctx);
    if (!prof) continue;
    candidates.push({
      p,
      ...prof,
      capEuro: Math.min((prof.target - p.allocation) * ctx.totalValue, TOPUP_HARD_CAP * ctx.totalValue - num0(p.value)),
      targetEuro: 0,
      assigned: 0,
    });
  }

  // Water-filling.
  let remaining = trancheCount * TRANCHE_SIZE;
  for (let iter = 0; iter < 8 && remaining >= 1; iter++) {
    const open = candidates.filter((c) => c.targetEuro < c.capEuro - 1e-6);
    const attr = sum(open, (c) => c.attractiveness);
    if (attr <= 0) break;
    let placed = 0;
    for (const c of open) {
      const add = Math.min(remaining * (c.attractiveness / attr), c.capEuro - c.targetEuro);
      c.targetEuro += add;
      placed += add;
    }
    remaining -= placed;
    if (placed < 1e-6) break;
  }

  // Tranches.
  const tranches = [];
  for (let i = 0; i < trancheCount; i++) {
    let best = null;
    for (const c of candidates) {
      if (c.assigned + TRANCHE_SIZE > c.capEuro + TRANCHE_SIZE * 0.5) continue; // respect cap
      if (c.targetEuro - c.assigned > (best ? best.targetEuro - best.assigned : 1e-6)) best = c;
    }
    if (!best) break; // all € targets met

    const rank = [...sim].sort(byScore).indexOf(best.p) + 1;
    const p = best.p;
    const entry = {
      n: i + 1,
      p,
      score: p.scores.total,
      oldAlloc: p.allocation,
      target: best.target,
      reasons: topUpReasons(p, topUpMetrics(p, ctx), { rank }),
    };
    best.assigned += TRANCHE_SIZE;
    p.value = num0(p.value) + TRANCHE_SIZE;
    ctx = computeContext(sim);
    for (const x of sim) x.scores = computeScores(x, ctx);
    entry.newAlloc = p.allocation;
    tranches.push(entry);
  }

  const perPosition = candidates
    .filter((c) => c.assigned > 0)
    .map((c) => ({ p: c.p, amount: c.assigned, count: c.assigned / TRANCHE_SIZE }))
    .sort((a, b) => b.amount - a.amount);
  return { tranches, perPosition, candidateCount: candidates.length };
}
