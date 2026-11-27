# bssg: phpMyAdmin-thema van het panel

Bovenop het ingebouwde Bootstrap-thema van phpMyAdmin 5.2. `deploy/phpmyadmin/Dockerfile` kopieert dat thema
naar `themes/bssg` en plakt `css/overrides.css` achter `theme.css` en `theme.rtl.css`; `img/` en `theme.json`
komen eroverheen. Zo hoeft er geen 400 kB gecompileerde css in de repo en volgt het thema de pinning van de image.

- Kleuren: de tokens uit `apps/web/app/globals.css` (paars accent, donker standaard).
  `@media (prefers-color-scheme: light)` zet de lichte variant. phpMyAdmin kent de themakeuze van het panel niet,
  dus het volgt de voorkeur van het systeem.
- Logo: `img/logo_left.png` (navigatiepaneel) en `img/logo_right.png` (inlogscherm) zijn het merkteken uit
  `apps/web/public/brand/logo-mark.svg`; de woordmerktekst "phpMyAdmin" komt uit css.
- Pictogrammen van phpMyAdmin zijn donkere PNG's; in het donkere thema worden ze met een filter omgekeerd.
- Aanpassen: `docker compose build phpmyadmin`, of voor snel itereren de css in een draaiende container kopieren.
