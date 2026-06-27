/* ============================================================================
 * config.js  (clientseitig)
 * ----------------------------------------------------------------------------
 * V2-Fundamentaldaten (Detailanalyse) sind optional und brauchen einen
 * Financial-Modeling-Prep-API-Key.
 *
 * Am einfachsten: den Key direkt IN DER APP eingeben – im Tab „Detailanalyse"
 * erscheint dafür ein Eingabefeld. Der Key wird nur lokal im Browser
 * gespeichert (localStorage) und muss nicht hier eingetragen werden.
 *
 * Alternativ kann der Key hier fest hinterlegt werden (fmpApiKey). Dann gilt:
 *   ⚠️  Diese Datei läuft im Browser. Wird die Seite deployed (z. B. GitHub
 *       Pages) oder config.js in ein öffentliches Repo committet, ist der Key
 *       ÖFFENTLICH sichtbar. Dann nur einen Key mit engen Limits verwenden.
 *
 * Das In-App-Feld hat Vorrang vor diesem Wert.
 * ==========================================================================*/
window.INCOME_LENSE_CONFIG = {
  fmpApiKey: '',
};
