# Income Lense

Eine **statische, rein lokale Web-App** zur Analyse eines [DivvyDiary](https://divvydiary.com)-Depot-Exports (CSV): Kennzahlen, transparente Scores, Risiko, Einkommen, Ziel 2033 und Aufstockplan – **vollständig im Browser**, ohne Backend, ohne Build-Step, ohne externe Abhängigkeiten.

> ⚠️ **Keine Anlage-, Steuer- oder Rechtsberatung.** Alle Auswertungen dienen der Orientierung und basieren ausschließlich auf deiner CSV.

---

## Bereiche

| Tab | Inhalt |
|---|---|
| **Übersicht** | Depotwert & G/V, Dividenden brutto/netto, Kernkennzahlen, Schnellblick auf Handlungsbedarf, nächste Zahlungen und Ziel-Fortschritt |
| **Empfehlungen** | Eine priorisierte Liste aller Hinweise (Hoch / Mittel / Chancen / Hinweise, filterbar) – inklusive Risiko-Warnungen |
| **Risiko** | Diversifikations-Score, effektive Positionen (HHI), Gewichte nach Position, Dividenden, Sektor (Wert/Dividende umschaltbar), Land, Art, Währung – mit Warnschwellen |
| **Einkommen** | Brutto/Netto, Steuern, Monatsverteilung (netto + Steuer), 5-Jahres-Hochrechnung, kommende Zahlungen nach Monat |
| **Ziel 2033** | Netto-Projektion vs. Monatsziel, Einmalbetrag & Sparrate, Sparraten-Szenario, „Besparen“-Schalter je Wert |
| **Aufstocken** | Budget in 1.000-€-Tranchen mit Begründung („Wieso?“) und Verteilung pro Wert |
| **Positionen** | Such-, filter- und sortierbare Liste inkl. Einordnung (Kategorie-Chips) und inaktiver Werte |

Ein Tipp auf ein Symbol öffnet überall die **Detailanalyse** (Score-Ring, Teil-Scores, Kennzahlen, Insights) – auf dem Handy als Bottom-Sheet, am Desktop als Seitenpanel. Mit ‹ › bzw. den Pfeiltasten blätterst du nach Score.

Tabs und Detailansicht stehen in der URL (`#risiko`, `#positionen/AAPL`) – Zurück-Taste, Neuladen und Lesezeichen funktionieren.

---

## Nutzung

1. **`index.html` im Browser öffnen** (lokal per Doppelklick oder über GitHub Pages).
2. CSV per **Upload-Button** wählen oder **auf die Seite ziehen**.
3. Die CSV und deine Einstellungen (Monatsziel, Sparrate, Budget, Schalter) werden **nur lokal im Browser** gespeichert und beim nächsten Öffnen wiederhergestellt. Der Papierkorb-Button löscht die gespeicherten Daten.

Keine Installation, kein `npm`, keine CDN- oder Font-Requests – die App funktioniert auch offline.

---

## Deployment auf GitHub Pages

1. Alle Dateien liegen im **Repository-Root**.
2. **Settings → Pages → Deploy from a branch**, Branch wählen, Ordner `/ (root)`.
3. Nach Änderungen an CSS/JS die Versionsnummer `?v=N` in `index.html` erhöhen (Cache-Busting).

---

## Erwartetes CSV-Format

- **Trennzeichen:** Semikolon (`;`), **Dezimaltrennzeichen:** Komma (`489,7182`)
- **Prozentwerte** als Dezimalbrüche (`0,038554` → `3,86 %`)
- **Erste Zeile:** Spaltenüberschriften

Genutzte Spalten:

```
symbol; isin; name; quantity; buyin; buyinTotal; price; value; gain; gainRel;
allocation; dividendYield; dividendYieldOnBuyin; totalDividendRate; dividendRate;
dividendFrequency; dividendCagr; dividendCagrPeriod; sector; securityType; country;
originalDividendCurrency; exDate; payDate; taxRate
```

Positionen mit `value = 0` gelten als **inaktiv** (verkauft / Watchlist) und fließen nicht in die Depotberechnungen ein.

---

## Scoring-Modell (transparent & regelbasiert)

| Block | Gewicht |
|---|---|
| Dividenden-Qualität / Sicherheit | 30 % |
| Einkommensstärke | 25 % |
| Wachstum | 20 % |
| Depot-Fit | 15 % |
| Streuung (hoher Score = geringes Konzentrationsrisiko) | 10 % |

Skala: **85+** Sehr stark · **70+** Stark · **55+** Solide · **40+** Schwach · **< 40** Kritisch.

Alle Warnschwellen (Einzelwert, Sektor, Land, Dividendenanteil, Rendite, Buchverlust) stehen zentral in `LIMITS` (`scoring.js`) und gelten identisch für Scores, Risiko-Tab, Empfehlungen, Einordnung und Aufstockplan. Breit streuende ETFs/Fonds zählen nicht als Einzelwert- oder Einkommensklumpen.

---

## Datenquellen & Grenzen

Ausschließlich die DivvyDiary-CSV. Fundamentaldaten (Payout Ratio, FCF, Verschuldung, Dividenden-Streak, Ratings) sind nicht enthalten und werden nicht erfunden; fehlende Werte erscheinen als `–`.

---

## Projektstruktur

```
index.html      # Seitengerüst: Header, Tabs, Views, Detail-Dialog
styles.css      # Design-Tokens + wiederverwendbare Komponenten
formatting.js   # CSV-Parser, Zahlen-Parsing, de-DE-Formatierung
scoring.js      # LIMITS, Positions-Helfer, Scoring-Modell, Score-Skala
insights.js     # Einordnung, Insights, Aufstock-Modell
analysis.js     # Reine Depot-Analyse (KPIs, Risiko, Empfehlungen, Einkommen, Ziel, Plan)
app.js          # UI: Routing, Speicherung, Events, Komponenten, Views
handover.md     # Technische Übergabe-Doku
```

---

## Datenschutz

Die CSV wird **nie hochgeladen** und es werden **keine externen Ressourcen** geladen. Parsing, Berechnung und Speicherung passieren ausschließlich lokal in deinem Browser.
