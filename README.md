# Dividend Portfolio Analyzer

Eine **statische, rein lokale Web-App** zur Analyse eines [DivvyDiary](https://divvydiary.com)-Portfolio-Exports (CSV). Sie liefert eine detaillierte, dark-mode Dividenden-Depotanalyse mit Kennzahlen, Charts, transparenten Scores, automatischen Insights und Action-Ideas – **vollständig im Browser**, ohne Backend, ohne Build-Step, ohne Datenupload.

> ⚠️ **Keine Anlageberatung.** Alle Auswertungen dienen der Orientierung und basieren ausschließlich auf deiner CSV.

---

## Was die App macht

- **Portfolio-Kennzahlen (KPIs):** Depotwert, investiertes Kapital, unrealisiertes Plus/Minus (absolut & %), jährliche/monatliche Bruttodividende, gewichtete Dividendenrendite, gewichteter Yield on Cost, Anzahl aktiver Positionen & Dividendenzahler, größte Position, größter Dividendenzahler.
- **Handlungsempfehlungen:** Individuelle, priorisierte Empfehlungen für das Depot (Hoch/Mittel/Chance), abgeleitet aus Scores, Konzentration, Wachstum und Einkommen – z. B. Länder-/Sektor-/Einkommensklumpen, Übergewichtungen, Renditefallen, kritische Scores und untergewichtete Qualitätswerte. Bewusst abwägende, nicht-beratende Wortwahl.
- **Charts (Chart.js):** Allokation nach Sektor, Land und Wertpapierart; Top 10 nach Marktwert; Top 10 nach jährlicher Dividende; Dividendenbeitrag nach Sektor.
- **Positionsübersicht:** sortier- und filterbare Tabelle (Suche, Sektor, Land, Aktionskategorie; Sortierung nach Wert, Dividende, Anteil, Rendite, CAGR, Score).
- **Detaillierte Positionskarten:** je aktiver Position ein großer Score-Kreis (0–100), fünf Teil-Scores (Sicherheit, Einkommen, Wachstum, Depot-Fit, Konzentrationsrisiko), alle relevanten Kennzahlen und 3–6 automatische Insights.
- **Action Ideas:** Gruppierung in Aufstockungskandidaten, Halten, Beobachten, Nicht weiter aufstocken, Reduzierung prüfen, Inaktiv/Watchlist.
- **Dividendenkalender:** Erwartete Bruttoausschüttung je Monat (aus payDate + Frequenz auf das Jahr verteilt), stärkster Monat, nächster Zahltag, Summe der nächsten 30 Tage sowie eine Tabelle der kommenden Termine.
- **Einkommens-Prognose:** Jahres-/Monatsdividende brutto und netto (nach Steuer via taxRate), effektiver Steuersatz, Netto-Rendite & Netto-Yield-on-Cost, monatliche Netto-vs-Brutto-Balken und eine 5-Jahres-Hochrechnung mit dem einkommensgewichteten Dividenden-CAGR.
- **Zieldepot 2033:** Projiziert die **Netto**-Dividende bis 2033 (organisches Dividendenwachstum je Wert), vergleicht sie mit deinem Monatsziel (3.500 € bzw. 2.000 €, oder eigenes), zeigt die Differenz und – um die Lücke zu schließen – den nötigen **Einmalbetrag** und die **monatliche Sparrate**. „Was pro Wert fehlt" wird nach Qualitäts-Score verteilt (zusätzliche Dividende + Kapital je Position).
- **Risiko & Konzentration:** Eigener Risiko-Tab mit Diversifikations-Score, effektiver Positionsanzahl (HHI), Top-N-Anteil, größter Position/Sektor/Land, Einkommenskonzentration sowie regelbasierten Klumpenrisiko- und Renditefallen-Warnungen (Hoch/Mittel) und Konzentrations-Balken. „Gemischt" (breite ETFs) wird nicht als Einzelrisiko gewertet.
- **Aufstock-Plan (1.000-€-Tranchen):** Für ein eingegebenes Budget wird ein greedy Plan erstellt, welche Werte du als Nächstes aufstocken könntest. Nach jeder Tranche wird die Allokation neu berechnet, sodass sich die Empfehlungen automatisch streuen. Jede Tranche enthält eine nachvollziehbare Begründung („Wieso?").
- **Inaktiv-Bereich:** Positionen mit Marktwert = 0 werden aus den aktiven Berechnungen ausgeschlossen und separat gelistet.

Alle Werte werden **aus der hochgeladenen CSV berechnet** – nichts ist hartkodiert.

### Navigation

Statt einer langen Seite ist das Dashboard in einzelne Bereiche („Seiten“) unterteilt, die über eine sticky Navigationsleiste umgeschaltet werden: **Übersicht**, **Handlungsempfehlungen**, **Allokation**, **Risiko**, **Einkommensprognose**, **Zieldepot 2033**, **Dividendenkalender**, **Aufstockplan**, **Einordnung**, **Positionen**, **Detailanalyse** und **Inaktiv** (nur falls vorhanden). Es ist immer nur ein Bereich sichtbar.

---

## Lokale Nutzung

1. Repository herunterladen oder klonen.
2. **`index.html` im Browser öffnen** (Doppelklick genügt).
3. Oben rechts auf **„DivvyDiary-CSV laden“** klicken und deine Export-Datei wählen.

Es ist **kein** `npm`, keine Installation und kein Build-Step nötig. Chart.js und PapaParse werden per CDN geladen (eine Internetverbindung ist dafür beim ersten Laden erforderlich).

---

## Deployment auf GitHub Pages

1. Alle Dateien liegen im **Repository-Root** (insbesondere `index.html`).
2. In GitHub: **Settings → Pages**.
3. Unter **Build and deployment → Source** „Deploy from a branch“ wählen.
4. Branch auf `main` (oder den gewünschten Branch) und Ordner `/ (root)` setzen, speichern.
5. Nach kurzer Zeit die generierte **GitHub-Pages-URL** öffnen (z. B. `https://<user>.github.io/<repo>/`).

---

## Erwartetes CSV-Format

- **Trennzeichen:** Semikolon (`;`)
- **Dezimaltrennzeichen:** Komma (`,`) – z. B. `489,7182`
- **Prozentwerte** sind Dezimalbrüche – z. B. `0,038554` wird als `3,86 %` angezeigt
- **Erste Zeile:** Spaltenüberschriften

Erwartete Spalten (DivvyDiary-Export):

```
symbol; isin; wkn; name; quantity; buyin; buyinTotal; price; value; gain; gainRel;
currency; allocation; allocationOnBuyin; dividendYield; dividendYieldOnBuyin;
totalDividendRate; dividendRate; dividendFrequency; dividendCagr; dividendCagrPeriod;
sector; securityType; country; originalDividendCurrency; transactions; exDate; payDate;
gainPrev; gainPrevRel; prevPricePeriod; note; taxRate
```

Positionen mit `value = 0` gelten als **inaktiv** (verkauft / Watchlist) und fließen nicht in die aktiven Portfolio-Berechnungen ein.

---

## Scoring-Modell (transparent & regelbasiert)

Der Gesamt-Score (0–100) setzt sich gewichtet zusammen (siehe `scoring.js`, `SCORE_WEIGHTS`):

| Block | Gewicht |
|---|---|
| Dividenden-Qualität / Sicherheit | 30 % |
| Einkommensstärke | 25 % |
| Wachstum | 20 % |
| Depot-Fit | 15 % |
| Konzentrationsrisiko (hoher Score = geringes Risiko) | 10 % |

Interpretation des Gesamt-Scores:

- **85–100:** Sehr stark
- **70–84:** Stark
- **55–69:** Solide / beobachten
- **40–54:** Schwachstellen prüfen
- **0–39:** Kritisch / nicht aufstocken

Jede Regel ist in `scoring.js` kommentiert; die Gewichte lassen sich leicht anpassen.

---

## Datenquellen & Grenzen

Die App nutzt **ausschließlich die DivvyDiary-CSV** (CSV-only). Fundamentaldaten wie
Payout Ratio, FCF-Coverage, Verschuldung (Debt/EBITDA), Dividenden-Streak oder
Analystenratings sind **nicht** enthalten und werden **nicht erfunden**; fehlende Werte
erscheinen als `n/a`. Alle Berechnungen laufen lokal im Browser; es werden keine
externen APIs aufgerufen.

---

## Projektstruktur

```
index.html        # Seitenstruktur, lädt CDN- und App-Skripte
styles.css        # Dark-mode Premium-Design
formatting.js     # CSV-Parsing (Komma-Dezimal) & Formatierung (de-DE)
scoring.js        # Transparentes, regelbasiertes Scoring-Modell
insights.js       # Regelbasierte Insights & Action-Kategorisierung
app.js            # Hauptlogik: Parsing, KPIs, Charts, Tabelle, Karten
README.md         # Diese Datei
```

---

## Datenschutz

Die CSV wird **niemals hochgeladen**. Das gesamte Parsing und alle Berechnungen finden lokal in deinem Browser statt.
