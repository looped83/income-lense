# Handover – Income Lense

Übergabedokument für die statische Dividenden-Depotanalyse **Income Lense**.
Stand: V1, Branch `claude/divvydiary-portfolio-dashboard-72gomm`.

---

## 1. Was ist Income Lense?

Eine **rein statische, lokale Web-App** zur Analyse eines DivvyDiary-CSV-Exports.
Läuft durch Öffnen von `index.html` – ohne Build, ohne Backend, ohne Datenupload.
Alle Berechnungen passieren im Browser; die CSV verlässt das Gerät nicht.

- **Sprache:** Deutsch (UI)
- **Design:** Dark Mode, „premium" Finanz-Dashboard, grüne Income-Akzente, orange/rote Risiko-Indikatoren
- **Stack:** reines HTML/CSS/Vanilla-JS + Chart.js & PapaParse via CDN
- **Deployment-Ziel:** GitHub Pages (alle Dateien im Repo-Root)

---

## 2. Projektstruktur

```
index.html      # Seitengerüst: Header, sticky Tab-Nav, alle Tab-Sektionen, CDN- & App-Skripte
styles.css      # komplettes Dark-Mode-Design
config.js       # PUBLIC (kein Secret): Proxy-URL für V2-Anreicherung
formatting.js   # CSV-Parsing (Komma-Dezimal) + de-DE-Formatierung
scoring.js      # transparentes, regelbasiertes Scoring-Modell (0–100)
insights.js     # Insights, Einordnung (Action-Kategorien), Aufstock-Logik
enrichment.js   # V2: Fundamentaldaten via FMP-Proxy + Fundamental-Score
app.js          # Hauptlogik: Parsing, State, KPIs, Charts, alle Tabs/Renderer
proxy/          # Serverless-Proxy (Cloudflare Worker) + Deployment-Anleitung
README.md       # Nutzer-/Deployment-Doku
handover.md     # dieses Dokument
LICENSE
```

**Ladereihenfolge** (in `index.html`, am Ende von `<body>`):
PapaParse → Chart.js (CDN) → `config.js` → `formatting.js` → `scoring.js` →
`insights.js` → `enrichment.js` → `app.js`.
Alles als globale Skripte (keine ES-Module), damit es per `file://` und auf GitHub Pages läuft.

### Cache-Busting
Lokale Assets werden mit `?v=N` eingebunden (aktuell **`?v=14`**). **Wichtig:** Bei jeder
Änderung an `styles.css`/`*.js` die Versionsnummer in `index.html` erhöhen
(`sed -i 's/?v=14/?v=15/g' index.html`), sonst liefern Browser/GitHub Pages alte Dateien aus.

---

## 3. Datenfluss & Parsing

1. Upload (Header-Icon oder Button im Empty-State) → `onFileSelected` → **PapaParse**
   (`delimiter: ';'`, `header: true`).
2. `buildPosition(row)` typisiert jede Zeile; numerische Felder via `parseNum`
   (Komma-Dezimal, optionale Tausenderpunkte → JS-Number; leer = `NaN`).
3. **Aktiv vs. inaktiv:** `isActive = value > 0`. Aktive Positionen fließen in alle
   Berechnungen; inaktive landen im Tab „Inaktiv".
4. `buildContext(active)` aggregiert: `totalValue`, `totalAnnualDividend`,
   `sectorAllocation`, `countryAllocation` (Anteile als Brüche).
5. `computeKpis(active)` berechnet die Portfolio-Kennzahlen.
6. Pro Position: `computeScores` → `buildInsights` → `classifyAction`.
7. Render-Pipeline (`handleParsedData`): `renderKpis`, `renderCharts`,
   `renderRecommendations`, `renderRisk`, `renderCalendar`, `renderIncome`,
   `renderTable`, `renderDetailCards`, `renderActionIdeas`, `renderTopUp`,
   `renderInactive`, dann `showView('view-overview')`.

**Prozentwerte** liegen in der CSV als Brüche vor (z. B. `0,038554`) und werden mit
`fmtPercent` als `3,86 %` ausgegeben.

### Wichtige CSV-Felder
`symbol, isin, name, quantity, buyin, buyinTotal, price, value, gain, gainRel,
allocation, dividendYield, dividendYieldOnBuyin, totalDividendRate, dividendRate,
dividendFrequency, dividendCagr, sector, securityType, country,
originalDividendCurrency, exDate, payDate, taxRate`

---

## 4. Tabs (Navigation)

Sticky Tab-Leiste; es ist immer **genau eine** Ansicht sichtbar
(`showView(id)` toggelt `.view.active`). Reihenfolge logisch gruppiert:
Überblick/Empfehlung → Analyse → Aktions-Tools → Daten.

| # | Tab | View-ID | Renderer | Inhalt |
|---|-----|---------|----------|--------|
| 1 | Übersicht | `view-overview` | `renderKpis` | 12 KPI-Karten (Depotwert, investiert, G/V abs. & %, Brutto-Div. p.a./Monat, gew. Rendite, gew. YoC, #aktiv, #Zahler, größte Position, größter Zahler) |
| 2 | Handlungsempfehlungen | `view-recommendations` | `renderRecommendations` | priorisierte, individuelle Empfehlungen (s. §7) |
| 3 | Allokation | `view-charts` | `renderCharts` | 7 Chart.js-Diagramme (Sektor/Land/Art/Währung, Top-10 Wert, Top-10 Dividende, Div.-Beitrag/Sektor) |
| 4 | Risiko | `view-risk` | `renderRisk` | Konzentrationskennzahlen + Warnungen (s. §6) |
| 5 | Einkommensprognose | `view-income` | `renderIncome` | Brutto/Netto, Steuer, Netto-Rendite/YoC, Monatsbalken, 5-Jahres-Hochrechnung |
| 6 | Dividendenkalender | `view-calendar` | `renderCalendar` | Monatsverteilung + kommende Termine |
| 7 | Aufstockplan | `view-topup` | `renderTopUp` | 1.000-€-Tranchen-Plan (s. §8) |
| 8 | Einordnung | `view-actions` | `renderActionIdeas` | Gruppierung aller Werte in Aktionskategorien |
| 9 | Positionen | `view-table` | `renderTable` | sortier-/filterbare Tabelle |
| 10 | Detailanalyse | `view-details` | `renderDetailCards` | Master-Detail: Liste links, Detailkarte rechts |
| 11 | Inaktiv | `view-inactive` | `renderInactive` | nur sichtbar, wenn inaktive Werte vorhanden (Nav-Button `#navInactive`) |

**Charts-Hinweis:** Diagramme werden bei verstecktem Container erstellt; beim
Wechsel auf „Allokation" ruft `showView` `chart.resize()` auf (sonst Größe 0).

---

## 5. Scoring-Modell (`scoring.js`)

Transparent & regelbasiert, jede Regel kommentiert. Gewichte in `SCORE_WEIGHTS`
(leicht anpassbar):

| Block | Gewicht | Funktion |
|---|---|---|
| Sicherheit / Dividendenqualität | 30 % | `scoreSafety` |
| Einkommensstärke | 25 % | `scoreIncome` |
| Wachstum | 20 % | `scoreGrowth` |
| Depot-Fit | 15 % | `scoreFit` |
| Konzentrationsrisiko (hoch = sicher) | 10 % | `scoreConcentration` |

`computeScores(pos, ctx)` → `{safety, income, growth, fit, concentration, total}`.
`interpretScore(total)` → Label + CSS-Klasse (85+ Sehr stark … <40 Kritisch).
`scoreColor(score)` → Grün/Teal/Orange/Rot.

---

## 6. Risiko & Konzentration (`renderRisk` / `computeRisk` in `app.js`)

- **Kennzahlen:** Diversifikations-Score (0–100), effektive Positionsanzahl (1/HHI),
  Top-5/Top-10-Anteil, größte Position/Sektor/Land, größter Dividendenzahler.
- **HHI/Effektivanzahl** via `hhi()` / `effectiveCount()`.
- **Warnungen** (`flags`, Schwere Hoch/Mittel): Einzelposition >5 %/>8 %,
  Sektor >20 %/>30 %, Land >45 %/>60 %, Einkommens­konzentration >6 %/>10 %,
  Renditefallen (dy>8 % + schwacher/negativer CAGR), geringe effektive Streuung.
- **`isGeneric()`**: `mixed`/`Unbekannt` (breite ETFs) gelten als diversifiziert und
  werden **nicht** als Einzelrisiko gewertet.
- Darstellung: CSS-Balken (`concBars`), **kein Chart.js** (vermeidet Hidden-Canvas-Probleme).

---

## 7. Handlungsempfehlungen (`buildRecommendations` / `renderRecommendations`)

Synthese der gesamten Analyse zu **individuellen, priorisierten** Empfehlungen.
Objektform: `{ sev, cat, title, text }`.

- **Schweregrade:** `high` (Hoch), `mid` (Mittel), `low` (Chance), `info` (Hinweis).
- **Kategorien:** Diversifizieren, Reduzieren, Risiko, Beobachten, Einkommen,
  Aufstocken, Hinweis.
- **Regeln:** Länder-/Sektor-/Einkommensklumpen; Übergewichtungen; kritische Scores
  (<40, **außer** dividendenlose Werte); Renditefallen; rückläufige Dividenden;
  deutliche Buchverluste (gainRel ≤ −15 % bei Dividendenwert); Top-Aufstock-Chancen
  (aus dem Aufstock-Qualitätsmodell).
- **Dividendenlose Werte** (Krypto, thesaurierende ETFs, `totalDividendRate ≤ 0`)
  werden **gebündelt als ein blauer „Hinweis"** ausgegeben statt als „kritischer Score".
- Dedupliziert nach Titel, sortiert nach Schwere. Wortwahl bewusst nicht-beratend.

---

## 8. Aufstockplan (`buildTopUpPlan` / `renderTopUp`)

Ziel-Gewichtungs-Modell (Water-Filling), nicht greedy-pauschal:

1. **Qualität (0–1)** je Wert aus Ranking + Diversifikation + Wachstum + Rendite
   (`topUpQuality`, Gewichte in `TOPUP_WEIGHTS`).
2. **Zielgewicht (Soft-Cap):** `TOPUP_SOFT_MIN`(2 %)…`TOPUP_SOFT_MAX`(6 %) je nach
   Qualität; harte Grenze `TOPUP_HARD_CAP` (8 %).
3. **Eligibility-Gates** (`topUpEligible`): Score ≥ 55, kein 8 %-Bruch, keine
   Renditefalle, Sektor ≤ 25 %, kein negativer CAGR, Einkommensanteil ≤ 10 %.
4. **Verteilung:** Budget proportional zu *Attraktivität* = Qualität × Untergewichtung,
   iterativ, gedeckelt; gedeckelte Werte geben Rest ab.
5. **Tranchen:** €-Ziele werden als **1.000-€-Tranchen** ausgegeben (jeweils der Wert
   mit dem größten Abstand zu seinem €-Ziel). Pro Tranche werden Allokation & Ranking
   neu berechnet → Begründung („Wieso?") inkl. Rang im Depot.
- **Preset-Budget:** 3.000 €. Skaliert automatisch: kleine Budgets → Top-Kandidaten,
  große Budgets → breite, proportionale Streuung mit Mehrfach-Tranchen.

---

## 9. Einordnung & Insights (`insights.js`)

- `ACTION_CATEGORIES`: add / hold / monitor / noadd / reduce / inactive
  (Labels, Beschreibungen, CSS-Klassen).
- `classifyAction(pos, scores, ctx)` ordnet jede Position genau einer Kategorie zu.
- `buildInsights(pos, scores, ctx)` erzeugt 3–6 deutsche Insight-Sätze pro Position
  (in der Detailanalyse sichtbar).

---

## 10. Dividendenkalender & Einkommensprognose (`app.js`)

Geteilte Helfer: `paymentsPerYear`, `payMonths`, `monthIndexOf`, `parseISODate`,
`computeIncomeDistribution` (Monatsverteilung brutto/netto), `upcomingPayments`.

- **Kalender:** erwartete Bruttoausschüttung je Kalendermonat (Anker = Monat aus
  `payDate`, verteilt nach Frequenz), stärkster Monat, nächster Zahltag, Summe der
  nächsten 30 Tage, Tabelle kommender Termine.
- **Prognose:** Netto = brutto × (1 − `taxRate`); effektiver Steuersatz, Netto-Rendite,
  Netto-YoC; Monats-Balken (Netto grün / Steuer blass); 5-Jahres-Hochrechnung mit
  einkommensgewichtetem Dividenden-CAGR.

---

## 10b. V2 – Fundamentaldaten in der Detailanalyse (`enrichment.js`, `config.js`, `proxy/`)

Optionale Anreicherung des Detailanalyse-Tabs mit echten Fundamentaldaten von
**Financial Modeling Prep (FMP)**.

- **Sicherheit/Architektur:** Statische App → **Serverless-Proxy** (Cloudflare Worker in
  `proxy/cloudflare-worker.js`) hält den FMP-Key als Secret. `config.js` enthält nur die
  **Proxy-URL** (`fmpProxyUrl`), keinen Key. Ohne URL bleibt alles CSV-only (V1).
- **`enrichment.js`:** `fetchFundamentals(pos)` ruft über den Proxy
  Dividenden-Historie, `ratios-ttm`, `cash-flow-statement`, `profile` ab und berechnet
  Payout Ratio, FCF-Payout/-Coverage, Dividenden-Streak, DPS-Historie/-TTM, 5J-CAGR,
  Rendite. `scoreFundamentals()` bildet daraus einen transparenten Score
  (Sicherheit/Wachstum/Einkommen, Gewichte `ENRICH_WEIGHTS` 0,5/0,3/0,2).
  Ticker-Mapping via `fmpSymbol()` (US direkt, EU mit Suffix `.DE`/`.L`/`.TO`/`.AS`/`.PA`).
  Nur `securityType === 'EQUITY'` wird angereichert; Ergebnisse werden in `ENRICH.cache`
  und `STATE.fundamentals` gecacht.
- **`app.js`:** `renderFundBar()` (Button/Status), `loadAllFundamentals()` (Batch über
  alle aktiven Positionen, Concurrency 5, Fortschritt), `fundamentalsHtml()` +
  `buildDetailDpsChart()` (angereicherte Ansicht: Score-Shield, Blöcke, KPIs,
  DPS-Historien-Chart). `selectDetail()` hängt die Fundamentaldaten unter die V1-Karte;
  die Positionsliste bekommt ein „F <score>"-Badge.
- **Limits:** FMP Free-Tier ~250 Calls/Tag; pro Einzelaktie bis zu 4 Calls. Antworten
  werden proxyseitig 1 h gecacht. Bei fehlenden Daten → „nicht verfügbar" (nichts erfunden).
- **Einrichtung:** `proxy/README.md` (Deploy + `wrangler secret put FMP_API_KEY`),
  dann `fmpProxyUrl` in `config.js` setzen.

---

## 11. Formatierung (`formatting.js`)

- `parseNum` – Komma-Dezimal-Parsing (Kernstück des CSV-Imports).
- `hasNum`/`num0` – Validitäts-/Fallback-Helfer.
- `fmtCurrency`, `fmtPercent`, `fmtNumber`, `fmtSignedCurrency`, `fmtSignedPercent` (de-DE).
- `fmtFrequency`, `fmtSecurityType`, `fmtCountry`, `fmtText`, `fmtDate`.
- Fehlende Werte → `n/a` (es werden **keine** Werte erfunden).

---

## 12. Deployment (GitHub Pages)

1. Alle Dateien liegen im Repo-Root (insb. `index.html`).
2. **Settings → Pages → Deploy from a branch**, Branch wählen, Ordner `/ (root)`.
3. Generierte URL öffnen. Nach Updates ggf. Hard-Refresh (Cache-Busting `?v=N` hilft).

---

## 13. Tests / lokale Vorschau

- **Logik-Test (Node):** `formatting.js`/`scoring.js`/`insights.js` lassen sich per
  `eval` in Node laden (keine DOM-Abhängigkeit auf Top-Level).
- **Browser-Test:** mit Playwright/Chromium headless. **Achtung:** In der Sandbox sind
  die CDN-Hosts (jsdelivr, Google Fonts) gesperrt. Zum Testen wurden lokale npm-Kopien
  von `papaparse`/`chart.js` verwendet und im Test-`index.html` die CDN-URLs ersetzt.
  Produktiv/auf GitHub Pages funktioniert das CDN normal (Fonts fallen sonst auf
  System-Fonts zurück – kein Funktionsfehler).
- `app.js` referenziert `document` nur innerhalb von Event-Handlern/Render-Funktionen,
  daher kein Top-Level-DOM-Zugriff beim Laden.

---

## 14. Designentscheidungen / Konventionen

- **Keine Anlageberatung:** durchgehend abwägende Wortwahl; Hinweise auf allen
  „Aktions"-Tabs.
- **CSV-only (V1):** keine externen Fundamentaldaten (Payout Ratio, FCF, Debt/EBITDA,
  Dividenden-Streak, Ratings). Fehlt etwas → `n/a`.
- **Risiko-/Empfehlungs-Tabs** nutzen bewusst CSS-Balken statt Chart.js (Robustheit).
- **Globale Funktionen** (kein Bundler) – Reihenfolge der `<script>`-Tags ist relevant.

---

## 15. Mögliche nächste Schritte (V2-Ideen)

- **Rebalancing/Reduzieren-Tab** (Gegenstück zum Aufstockplan – noch offen).
- **Performance-Tab** (Gewinner/Verlierer, gainPrev/Tagesveränderung).
- **API-Anreicherung** (Financial Modeling Prep / Alpha Vantage / EODHD) für echte
  Fundamentaldaten → bessere Sicherheits-/Qualitäts-Scores.
- **Persistenz der gewählten Ansicht** (z. B. URL-Hash `#risiko`).
- **Konfigurierbare Parameter in der UI** (Score-/Aufstock-Gewichte, Zielband).
- **CSV-Reset/Mehrfach-Vergleich**, Export der Empfehlungen (PDF/CSV).

---

## 16. Änderungshistorie (Kurzfassung)

1. V1-Grundgerüst: Parsing, KPIs, Charts, Tabelle, Detailkarten, Scoring, Insights,
   Einordnung, Inaktiv-Bereich, README.
2. Sticky Tab-Navigation (Single-View-Umschaltung).
3. Rebrand „Income Lense"; Score-Kreis-Hintergrund entfernt; CSV-Hinweis aus Übersicht;
   Cache-Busting eingeführt.
4. Währungs-Chart; Detailanalyse als Master-Detail.
5. Aufstockplan (Tranchen) – zunächst greedy, dann Preset 3.000 € + Ziel-Gewichtungs-
   Modell (Water-Filling, granular).
6. Risiko-Tab.
7. Dividendenkalender & Einkommensprognose.
8. Handlungsempfehlungen-Tab.
9. Header: Untertitel entfernt, Upload als Icon.
10. Einheitliche deutsche Tab-Namen + logische Reihenfolge; „Info & Grenzen" entfernt;
    dividendenlose Werte als Hinweis.
11. Vereinfachter Empty-State.
12. **V2:** Detailanalyse mit optionalen Fundamentaldaten (FMP via Serverless-Proxy),
    `config.js` + `enrichment.js` + `proxy/`, Fundamental-Score & DPS-Historie,
    „Alle Positionen laden", Listen-Badges. Footer auf V2.

> Hinweis: Die Modell-ID des verwendeten Assistenten ist bewusst **nicht** in
> Code/Artefakten hinterlegt.
