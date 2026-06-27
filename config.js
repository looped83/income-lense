/* ============================================================================
 * config.js  (clientseitig – wird im Browser geladen)
 * ----------------------------------------------------------------------------
 * V2-Fundamentaldaten (Detailanalyse) sind optional. Es gibt zwei Wege:
 *
 *  OPTION A (empfohlen) – Serverless-Proxy:
 *    Der Proxy hält den geheimen FMP-Key serverseitig. Hier nur die Proxy-URL:
 *      fmpProxyUrl: "https://income-lense-proxy.<subdomain>.workers.dev"
 *    Siehe /proxy/README.md.
 *
 *  OPTION B – FMP-API-Key direkt hinterlegen (Direktaufrufe an FMP):
 *      fmpApiKey: "DEIN_FMP_KEY"
 *
 *    ⚠️  SICHERHEITSWARNUNG: Diese Datei läuft im Browser. Wird die Seite
 *        deployed (z. B. GitHub Pages) ODER config.js in ein öffentliches Repo
 *        committet, ist der Key ÖFFENTLICH einsehbar (View-Source / Network-Tab)
 *        und kann missbraucht werden. Empfehlungen, falls du den Key dennoch
 *        direkt nutzt:
 *          - nur einen FMP-Key mit engen Limits / Free-Tier verwenden,
 *          - config.js per .gitignore aus dem Repo halten,
 *          - oder doch Option A (Proxy) nutzen.
 *
 * Ist beides gesetzt, hat der Proxy Vorrang. Sind beide leer, bleibt die App
 * rein CSV-basiert (V1-Verhalten).
 * ==========================================================================*/
window.INCOME_LENSE_CONFIG = {
  fmpProxyUrl: '',
  fmpApiKey: 'd11cfjRhaaFsbM08lb8LBiDmCDu6IuB6',
};
