# Handover – Income Lense

Übergabedokument für die statische Dividenden-Depotanalyse **Income Lense**.
Stand: V2-UI (Audit-Überarbeitung), Cache-Version **`?v=27`**.

---

## 1. Was ist Income Lense?

Eine **rein statische, lokale Web-App** zur Analyse eines DivvyDiary-CSV-Exports.
Läuft durch Öffnen von `index.html` – ohne Build, ohne Backend, **ohne externe Abhängigkeiten**
(kein CDN, keine Webfonts). Die CSV verlässt das Gerät nicht.

- **Sprache:** Deutsch · **Design:** Dark Mode, Finanz-Dashboard, Statusfarben über `tone-*`
- **Stack:** HTML/CSS/Vanilla-JS, globale Skripte (`defer`), läuft per `file://` und GitHub Pages
- **Größe:** ~40 KB gzip gesamt, 7 Requests, 0 Fremd-Domains

---

## 2. Projektstruktur & Ladereihenfolge

```
formatting.js   # parseCsv, parseNum, Intl-Formatter-Cache, Labels, escapeHtml
scoring.js      # LIMITS, sevOf, isFund/isDiversified/bucketShare/incomeShareOf/yieldSignal,
                # Scoring (5 Blöcke), computeScores, scoreLevel (eine Skala)
insights.js     # ACTION_CATEGORIES, classifyAction, buildInsights, Aufstock-Modell
analysis.js     # buildPosition, computeContext, analyze() → KPIs, Risiko, Empfehlungen,
                # Einkommen, kommende Zahlungen; computeTarget, buildTopUpPlan
app.js          # UI: Speicherung, Routing, Event-Delegation, Komponenten, Views, Detail-Sheet
```

Reihenfolge in `index.html` (alle `defer`): formatting → scoring → insights → analysis → app.
`analysis.js` ist DOM-frei und lässt sich in Node per `vm` laden und testen.

**Cache-Busting:** Bei jeder Änderung an CSS/JS `?v=N` in `index.html` erhöhen
(`sed -i 's/?v=27/?v=28/g' index.html`).

---

## 3. Datenfluss

1. CSV per Upload-Button, Empty-State oder Drag & Drop → `readFile` → `loadCsv`.
2. `parseCsv` (eigener RFC-4180-Parser: Quotes, `""`, CRLF, BOM, Delimiter-Erkennung) →
   `buildPosition` (Komma-Dezimal via `parseNum`; aktiv = `value > 0`).
3. `analyze(positions)`:
   `computeContext` (setzt auch `allocation` aus dem Wert) → `computeScores` →
   `classifyAction` → `buildInsights` → Ranking → KPIs, Risiko, Einkommen, Termine,
   gewichteter CAGR → `buildRecommendations`.
4. Neue CSV wird mit Dateiname/Datum in `localStorage` (`incomeLense.csv`) gespeichert,
   Einstellungen in `incomeLense.settings` (Monatsziel, Sparrate, Budget, ausgeschlossene Werte).
   Beim Start wird beides wiederhergestellt. Papierkorb-Button löscht die CSV.

---

## 4. Navigation & UI-Architektur

**7 Tabs** als Links mit Hash-Routing; `route()` zeigt genau eine View:

| Tab | Hash | Renderer | Inhalt |
|---|---|---|---|
| Übersicht | `#uebersicht` | `renderOverview` | Hero (Depotwert, Dividenden), 6 Kennzahlen, Karten Handlungsbedarf / Nächste Zahlungen / Ziel |
| Empfehlungen | `#empfehlungen` | `renderRecs` | Filter-Chips nach Priorität, Empfehlungskarten mit „Details“ |
| Risiko | `#risiko` | `renderRisk` | Kennzahlen + Balken (Positionen, Dividenden, Sektoren mit Umschalter, Länder, Art, Währung) |
| Einkommen | `#einkommen` | `renderIncome` | Kennzahlen, Monatsbalken netto+Steuer, Hochrechnung, Termine nach Monat |
| Ziel 2033 | `#ziel` | `renderTarget` | Ziel-Chips + Eingabe, Sparrate, Fortschritts-Meter, Kennzahlen, Tabelle mit Schaltern |
| Aufstocken | `#aufstocken` | `renderTopUp` | Budget-Chips + Eingabe, Verteilung, Tranchen (aufklappbar) |
| Positionen | `#positionen` | `renderPositions` | Suche, Sektor/Land/Sortierung, Kategorie-Chips (ersetzt „Einordnung“ und „Inaktiv“) |

- **Detail-Sheet:** `#<tab>/<SYMBOL>` öffnet ein natives `<dialog>` (Mobile: Bottom-Sheet,
  Desktop: Seitenpanel). ‹ › / Pfeiltasten blättern nach Score (`location.replace`), Esc/Backdrop
  schließen; Zurück-Taste schließt ebenfalls (`sheetFromNav`).
- **Lazy Rendering:** Eine View wird erst beim ersten Öffnen gerendert (`STATE.rendered`);
  Einstellungen invalidieren gezielt (z. B. Ziel → Übersicht).
- **Event-Delegation:** je ein Listener für click / input / change / drag; Registries
  `ACTIONS`, `CHIP_GROUPS`, `INPUTS`.

### Wiederverwendbare Komponenten (`app.js` + `styles.css`)
`stat` (Kennzahl-Kachel, `hero`-Variante) · `bars` (Balkenliste, auch gestapelt) · `meter`
(Fortschritt) · `chips` (Filter/Vorauswahl, `aria-pressed`) · `tag` / `scorePill` / `actionTag` ·
`legend` / `limitLegend` · `scoreRing` · `.rtable` (Tabelle am Desktop, zweizeilige Liste
≤ 720 px via `c-main` / `c-score` / `c-key` / `c-br` / `data-label`) · `.card` · `.method`
(`<details>` für Methodik) · `.switch`.

**Farbregel:** Farbe nur mit Bedeutung. `tone-green|blue|orange|ochre|red|faint` setzen `--tone`;
Score-Skala: ≥ 70 grün, ≥ 55 blau, ≥ 40 orange, < 40 rot. Schwere: hoch rot, mittel orange,
Chance grün, Hinweis blau. Zahlen bleiben in Textfarbe (Ausnahme: G/V mit Vorzeichen).

**Zahlenformat:** Kennzahlen, Balken, Projektionen in ganzen Euro; Tabellen und Detailkarte
mit Cent. Fehlende Werte → `–`.

---

## 5. Zentrale Schwellen (`LIMITS` in `scoring.js`)

| Schwelle | mittel | hoch |
|---|---|---|
| Einzelwert-Gewicht | > 5 % | > 8 % |
| Sektor (benannt) | > 20 % | > 25 % |
| Land (benannt) | > 45 % | > 60 % |
| Anteil an den Dividenden | > 6 % | > 10 % |

Dazu: hohe Rendite > 8 % (entschärft ab CAGR ≥ 5 %), Buchverlust ≤ −15 %,
< 12 effektive Positionen, Mindest-Score für Aufstocken 62.
Diese Werte gelten **identisch** in Scoring, Risiko-Balken, Empfehlungen, Einordnung, Insights
und Aufstockplan.

**Breite ETFs/Fonds** (`isDiversified`: ETF/Fonds mit Sektor oder Land „mixed“/unbekannt)
zählen nicht als Einzelwert- oder Einkommensklumpen. Generische Buckets (`mixed`, `Unbekannt`)
fließen nie als Sektor-/Länderrisiko ein (`bucketShare`).

---

## 6. Scoring (`scoring.js`)

Gewichte `SCORE_WEIGHTS`: Sicherheit 30 %, Einkommen 25 %, Wachstum 20 %, Depot-Fit 15 %,
Streuung 10 % (hoch = geringes Konzentrationsrisiko). `scoreLevel(score)` liefert Label + Ton
für Pill, Ring, Balken und Diversifikations-Score.

---

## 7. Einordnung (`classifyAction`) – konsistent mit dem Aufstockplan

Reihenfolge: inaktiv → **Reduzieren prüfen** (Einzelwert > 8 % + schwache Signale) →
**Nicht aufstocken** (Einzelwert > 5 % + schwache Signale/Score < 55) → **Beobachten** bei
Buchverlust ≤ −15 % → Nicht-Zahler → **Halten** → **Beobachten** bei Renditefalle/-warnung,
negativem CAGR oder fehlenden Daten → **Aufstocken** wenn `topUpProfile` existiert →
Halten (Score ≥ 62) bzw. Beobachten.

**Regel:** Kategorie „Aufstocken“ = exakt die Kandidaten des Aufstockplans; jedes
Beobachten-Signal sperrt Aufstockungen. Die „Chance“-Empfehlungen sind die attraktivsten
dieser Kandidaten.

---

## 8. Empfehlungen (`buildRecommendations`)

Eine Liste für alle Hinweise (die früheren separaten Risiko-Warnungen sind hier aufgegangen).
Objekt `{ sev, cat, title, text, symbol? }`, Schweregrade `SEVERITY` (hoch/mittel/Chance/Hinweis).
Kategorien: Diversifizieren, Konzentration, Reduzieren, Risiko, Beobachten, Einkommen,
Aufstocken, Hinweis. Dedupliziert nach Titel, stabil nach Schwere sortiert.

---

## 9. Aufstockplan (`buildTopUpPlan`)

1. Kandidaten über `topUpProfile` (Gates + Qualität 0–1 + Zielgewicht 2–6 %, harte Grenze 8 %).
2. Water-Filling: Budget proportional zu Qualität × Untergewichtung, gedeckelt.
3. 1.000-€-Tranchen an den Wert mit dem größten Abstand zum €-Ziel; nach jeder Tranche
   werden Anteile, Scores und Rang neu berechnet („Wieso?“).
Ergebnis `{ tranches, perPosition, candidateCount }`; in `STATE.topUp` je Tranchenzahl gecacht.

---

## 10. Einkommen & Ziel 2033

- **Verteilung:** nächster `payDate` als Anker, weitere Zahlungen nach Frequenz. Jahressummen
  (brutto/netto) zählen alle Zahler – überall identisch.
- **Netto** = brutto × (1 − `taxRate`). Hochrechnung mit einkommensgewichtetem CAGR.
- **Ziel 2033** (`computeTarget`): organische Projektion je Wert (CAGR 0–15 %), Lücke nach Score
  auf besparte Werte verteilt, Einmalbetrag aus Netto-Rendite/Wachstum je Wert, Sparrate als
  Annuität (Ø-Wachstum ≤ 12 %), Sparraten-Szenario zur Depot-Netto-Rendite.

---

## 11. Tests / lokale Vorschau

- **Logik (Node):** `formatting.js`, `scoring.js`, `insights.js`, `analysis.js` per `vm` in einen
  Kontext laden, `parseCsv` + `analyze` mit einer Test-CSV ausführen.
- **Browser:** Playwright/Chromium headless. Keine CDN-Abhängigkeiten mehr nötig.
- **Lint:** alle Skripte zu einem Bundle verketten und mit ESLint (`no-undef`, `no-unused-vars`)
  als Script prüfen.

---

## 12. Konventionen

- Keine Anlageberatung: abwägende Wortwahl; Disclaimer im Footer, Details in „Methodik“.
- CSV-only: fehlende Werte → `–`, nichts wird erfunden.
- Mobile first: 16-px-Eingaben (kein iOS-Zoom), Ziele ≥ 34 px, keine horizontale Seitenscroll.
- Barrierefreiheit: sichtbarer Fokus, `aria-current`/`aria-pressed`, Dialog mit Fokus-Management,
  `prefers-reduced-motion`, Kontraste ≥ 4,5:1 für Text.

---

## 13. Änderungshistorie (Kurzfassung)

1. V1-Grundgerüst: Parsing, KPIs, Charts, Tabelle, Detailkarten, Scoring, Insights, Einordnung.
2. Tabs, Rebrand „Income Lense“, Master-Detail, Aufstockplan (Water-Filling), Risiko-Tab,
   Kalender & Prognose, Handlungsempfehlungen, Zieldepot 2033.
3. V2-Experiment externe Fundamentaldaten – wieder entfernt (CSV-only).
4. **Audit-Überarbeitung:** 12 → 7 Tabs; Detail als Sheet von überall; responsive Tabellen;
   Chart.js, PapaParse und Google Fonts entfernt (eigener CSV-Parser, CSS-Balken, Systemschrift);
   zentrale `LIMITS`; breite ETFs nicht mehr als Klumpen; Einordnung = Aufstockplan-Kandidaten;
   Hash-Routing, lokale Speicherung, Drag & Drop, Lazy Rendering; Fixes: verdeckte Tab-Leiste,
   mobiler Overflow, iOS-Zoom, Tastaturzugang, Score-Farben, Texte.

> Hinweis: Die Modell-ID des verwendeten Assistenten ist bewusst **nicht** in Code/Artefakten
> hinterlegt.
