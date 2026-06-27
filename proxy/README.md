# Income Lense – FMP Proxy

V2 reichert den **Detailanalyse**-Tab mit Fundamentaldaten von
[Financial Modeling Prep](https://financialmodelingprep.com/) an. Da die App
statisch ist (GitHub Pages), würde ein API-Key im Browser sichtbar. Dieser
**Serverless-Proxy** hält den Key geheim: Die App ruft den Proxy, der Proxy
hängt den Key serverseitig an und leitet an FMP weiter.

Es ist nur eine **Allow-List** dividendenrelevanter Endpunkte erlaubt
(Historie, Ratios-TTM, Cashflow, Profil, Key-Metrics).

---

## Variante A – Cloudflare Worker (empfohlen, kostenlos)

Voraussetzung: kostenloses Cloudflare-Konto + [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
npm i -g wrangler
wrangler login

# Im Ordner /proxy:
wrangler init income-lense-proxy --no-git   # oder eigenes Projekt
# cloudflare-worker.js als Worker-Einstiegspunkt verwenden (src/index.js ersetzen)

# Secret setzen (FMP-API-Key, NICHT committen):
wrangler secret put FMP_API_KEY

wrangler deploy
```

Du erhältst eine URL wie
`https://income-lense-proxy.<subdomain>.workers.dev`.

Trage sie in `config.js` (Repo-Root) ein:

```js
window.INCOME_LENSE_CONFIG = {
  fmpProxyUrl: "https://income-lense-proxy.<subdomain>.workers.dev",
};
```

Minimaler `wrangler.toml`:

```toml
name = "income-lense-proxy"
main = "cloudflare-worker.js"
compatibility_date = "2024-01-01"
```

---

## Variante B – Vercel / Netlify Function

Lege eine Function an (z. B. `api/fmp.js` bei Vercel), die dieselbe Logik nutzt:
`path`-Query gegen die Allow-List prüfen, `process.env.FMP_API_KEY` anhängen,
an `https://financialmodelingprep.com/api/<path>` weiterleiten, CORS-Header
setzen. Den Key als Environment Variable (`FMP_API_KEY`) hinterlegen. Anschließend
die Function-URL in `config.js` eintragen.

---

## Sicherheit & Limits

- Der FMP-Key liegt **nur** im Proxy (Secret/Env), **nie** im committeten Code.
- Optional: in `Access-Control-Allow-Origin` deine GitHub-Pages-Domain
  hart eintragen, statt die Origin zu spiegeln.
- FMP Free-Tier hat ein Tageslimit (~250 Calls). „Alle Positionen laden" ruft
  pro Einzelaktie bis zu 4 Endpunkte ab; ETFs/Fonds/Krypto werden übersprungen.
  Antworten werden client- und proxyseitig (1 h) gecacht.
