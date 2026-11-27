/*
 * Koppeling met het panel (zie themes/bssg/README.md), geladen in de <head> van elke phpMyAdmin-pagina.
 * - Thema: precies de keuze van het panel (localStorage "panel_theme", zelfde origin): "light" of anders donker.
 *   Wisselt live mee zodra de gebruiker in het panel van thema wisselt (storage-event).
 * - Accentkleur: de kleur uit de instellingen van het panel (localStorage "panel_accent", #rrggbb), anders paars.
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
    accent();
  }
  function accent() {
    var a = null;
    try {
      a = localStorage.getItem("panel_accent");
    } catch (e) {}
    var props = ["--pb-primary", "--pb-primary-hover", "--pb-primary-rgb", "--pb-on-primary"];
    if (!a || !/^#[0-9a-fA-F]{6}$/.test(a)) {
      props.forEach(function (p) {
        d.style.removeProperty(p);
      });
      return;
    }
    var n = parseInt(a.slice(1), 16);
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    var lum = rgb
      .map(function (c) {
        var s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      })
      .reduce(function (sum, c, i) {
        return sum + c * [0.2126, 0.7152, 0.0722][i];
      }, 0);
    d.style.setProperty("--pb-primary", a);
    d.style.setProperty("--pb-primary-hover", "color-mix(in oklab, " + a + " 82%, " + (d.classList.contains("panel-light") ? "black" : "white") + ")");
    d.style.setProperty("--pb-primary-rgb", rgb.join(", "));
    d.style.setProperty("--pb-on-primary", lum > 0.35 ? "#0b0c14" : "#fafafa");
  }
  apply();
  try {
    if (window.top !== window.self && window.top.location.origin === window.location.origin) d.classList.add("panel-embed");
  } catch (e) {}
  window.addEventListener("storage", function (e) {
    if (e.key === "panel_theme" || e.key === "panel_accent" || e.key === null) apply();
  });
})();
