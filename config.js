/* ============================================================================
 * config.js  (PUBLIC – safe to commit, contains NO secrets)
 * ----------------------------------------------------------------------------
 * V2 fundamental-data enrichment is optional and routed through a serverless
 * proxy that injects the secret Financial Modeling Prep (FMP) API key
 * server-side. Set `fmpProxyUrl` to your deployed proxy endpoint, e.g.:
 *
 *   https://income-lense-proxy.<your-subdomain>.workers.dev
 *
 * Leave it empty to keep the app in pure CSV-only mode (V1 behaviour).
 * See /proxy/README.md for one-command deployment of the proxy.
 * ==========================================================================*/
window.INCOME_LENSE_CONFIG = {
  fmpProxyUrl: '',
};
