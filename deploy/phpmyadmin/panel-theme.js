/*
 * Koppeling met het panel (zie themes/bssg/README.md), geladen in de <head> van elke phpMyAdmin-pagina.
 * - Thema: precies de keuze van het panel (localStorage "panel_theme", zelfde origin): "light" of anders donker.
 *   Wisselt live mee zodra de gebruiker in het panel van thema wisselt (storage-event).
 * - Ingebed in het panel (iframe, zelfde origin): class panel-embed, zodat het thema dubbele onderdelen verbergt.
 */
(function () {
  var d = document.documentElement;
  function apply() {
    var t = null;
    try {
      t = localStorage.getItem("panel_theme");
    } catch (e) {}
    d.classList.toggle("panel-light", t === "light");
    d.classList.toggle("panel-dark", t !== "light");
  }
  apply();
  try {
    if (window.top !== window.self && window.top.location.origin === window.location.origin) d.classList.add("panel-embed");
  } catch (e) {}
  window.addEventListener("storage", function (e) {
    if (e.key === "panel_theme" || e.key === null) apply();
  });
})();
