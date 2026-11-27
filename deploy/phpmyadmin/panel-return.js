/*
 * SignonURL/LogoutURL van phpMyAdmin (config.user.inc.php). Sessie verlopen of uitgelogd:
 * - ingebed in het panel: het panel vragen om opnieuw in te loggen (nieuw token) of naar het overzicht te gaan;
 * - los tabblad: naar de phpMyAdmin-pagina van het panel, die zelf opnieuw inlogt.
 */
(function () {
  var logout = /[?&]logout=1(&|$)/.test(window.location.search);
  var framed = false;
  try {
    framed = window.top !== window.self && window.top.location.origin === window.location.origin;
  } catch (e) {}
  if (framed) window.parent.postMessage({ source: "panel-pma", action: logout ? "logout" : "reauth" }, window.location.origin);
  else window.location.replace(logout ? "/" : "/databases");
})();
