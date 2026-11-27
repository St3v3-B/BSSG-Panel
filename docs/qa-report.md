# QA-rapport (agent qa)

Gedraaid tegen branch `agent/qa` (basis `main` ac62b67) met `tests/e2e/run.sh`: echt panel (next dev) +
echte daemon + Docker, Chromium via Playwright. Alle containers kregen `panel.test=true` en
`panel.instance=e2e-<pid>` (run.sh zet het instance-label; eigen S3-container idem). Er is geen
applicatiecode gewijzigd.

## Resultaat

Laatste volledige run (verse stack, `tests/e2e/run.sh`, 8,5 min): **41 geslaagd, 0 mislukt, 3 `test.fixme`** (bugs 1 en 2).
Bestaand: 20 tests (alle groen na selector-fixes); nieuw: 24 (21 groen, 3 fixme).

## Wat er is toegevoegd

| Bestand | Inhoud |
|---|---|
| `tests/e2e/05-features.spec.ts` | quotumgebruiker maakt/wijzigt/verwijdert eigen server, plugins-zoekopdracht (echte Modrinth), backups (lokale `rclone serve s3`) maken + terugzetten, schedules (aanmaken, nu uitvoeren, ongeldige cron), PHP-instellingen (opslaan, bestand op schijf, grenzen), Bedrock aan/uit (echte GeyserMC-download, wordt overgeslagen zonder internet), Network-tab op Velocity-nep, image-update-beleid, Discord-webhook-validatie, auto-restart-grenzen |
| `tests/e2e/06-ui.spec.ts` | 390 px: overflow op alle gebruikers- en adminpagina's, lade openen/sluiten/navigeren, servertabs; zijbalk met toetsenbord (Tab/Enter, aria-current, inklappen blijft na reload); lichte thema; taalwissel NL; console-websocket herverbindt na herstart van de daemon; geen `console.error` op alle hoofdpagina's |
| `tests/e2e/templates/game/{paper,velocity}.yaml` | alpine-neppen met de naam/slug `Paper`/`Velocity` zodat de tabs Plugins/Bedrock/Network verschijnen zonder Java (via een kleine regel in `tests/lib/env.sh`) |
| `tests/e2e/support.ts` | elke test faalt op `pageerror`; `browser-problems.txt` (mislukte requests, console-fouten) wordt aan elke test gehangen; gecachte admin-sessie; helpers voor S3, vrije poorten, daemon-herstart |

Aanpassingen aan bestaande tests (alleen selectors / testinfra, geen verzwakte asserts):
`04-admin` (merknaam staat nu in de zijbalk, `user-menu` bestaat twee keer, gebruikerstabel en quota-tabel
tonen dezelfde link, siteverwijzing na de rename in 03), `01-setup` (test-timeout 3 min was korter dan de
eigen 8-minuten-expect), `03-website` (typvertraging in Monaco), `global-setup` (extra routes warmdraaien),
`support.routeDaemon` (een onbereikbare daemon gaf de pagina nooit een `close`, de console bleef eeuwig op
"authenticating": harnasfout, geen appfout).
`TOO_MANY_ATTEMPTS` bij `adminLogin` in elke test: admin-sessie wordt nu eenmalig geverifieerd en hergebruikt.

## Gevonden bugs

### 1. Bevestigingsmelding verdwijnt na opslaan (image-updates, eigen limieten; waarschijnlijk ook slaapstand) — laag/middel

- Stappen: eigenaar opent `/servers/<uuid>/settings`, kiest bij "Image updates" > Policy "Notify only", klikt Save.
  Zelfde voor een quotumgebruiker die bij "Resources" het geheugen van 512 naar 384 zet.
- Verwacht: "Image update settings saved." resp. "Limits saved." (role=status) blijft zichtbaar.
- Werkelijk: de waarde wordt wel opgeslagen (na reload staat hij goed, Save wordt uitgeschakeld), maar de melding
  verschijnt niet of verdwijnt meteen.
- Oorzaak (vrijwel zeker): de kaarten hebben een `key` die de opgeslagen waarde bevat; na `servers.get`-invalidate
  verandert de key, de kaart wordt opnieuw gemount en de `useMutation`-status (`isSuccess`) is weg.
  `apps/web/app/(panel)/servers/[uuid]/settings/page.tsx:26` (`ImageUpdateCard key=i-…`),
  `:35` (`OwnLimitsCard key=l-…`) en `:28` (`SleepCard key=s-…`: zelfde patroon, op de nep niet te testen
  omdat `sleep.supported` daar false is). Dezelfde key staat in `(panel)/admin/servers/[uuid]/page.tsx:61`.
  Oplossing: de key weglaten en de lokale state synchroniseren, of de melding buiten de gekeyde kaart bewaren.
- Tests: `05-features.spec.ts` → `test.fixme("image-update policy: shows 'Image update settings saved.' …")` en
  `test.fixme("quota user: 'Limits saved.' confirmation …")`. De persistentie zelf wordt wel groen getest.
- Bewijs: Playwright-snapshot van de mislukte run (kaart toont `Save` uitgeschakeld, geen status) — niet bewaard in
  git; reproduceerbaar met de twee fixme-tests (haal `.fixme` weg).

### 2. Spinner heeft hardgecodeerde Nederlandse toegankelijke naam "Laden…" — laag (i18n/a11y)

- Stappen: Engelstalige gebruiker laadt `/` (vertraag `auth.me` zodat de gate-spinner zichtbaar is).
- Verwacht: `role=status` met naam "Loading…". Werkelijk: `status "Laden…"` (te zien in de snapshots van elke
  test die tijdens het laden faalde).
- Oorzaak: `apps/web/app/_components/ui/spinner.tsx:4` (`label = "Laden…"`), en `auth-gate.tsx:40` geeft geen label mee.
- Test: `06-ui.spec.ts` → `test.fixme("loading spinner has an English accessible name …")`.
- Bewijs: `docs/qa/spinner-failed.png`, `docs/qa/spinner-error-context.md`.

### 3. Bedrock-tab hangt aan de weergavenaam van de template, niet aan de slug — laag

- Stappen: template `paper` een andere weergavenaam geven (bv. "Paper 1.21" of "Paper (EU)") of een eigen
  Paper-template met een andere naam gebruiken.
- Verwacht: Bedrock-tab zichtbaar (alle andere logica, `isBackendTemplate`/`isProxyTemplate`, gebruikt de slug).
- Werkelijk: tab ontbreekt; `bedrockPlatform("paper (eu)")` geeft `null`.
- Oorzaak: `apps/web/app/_components/server/server-tabs.tsx:50` roept `bedrockPlatform(server.templateName.toLowerCase())`
  aan; de functie verwacht een slug (`packages/api/network.ts`). Ontdekt doordat mijn eerste neptemplate
  "Paper (e2e fake)" heette. Geen test: de slug staat niet in `ServerDetail`; zodra dat veld er is volgt een test.

### Waarnemingen (geen bug bevestigd)

- Console-client (`app/_lib/console/connection.ts`) heeft geen time-out op `authenticating`: accepteert een tussenliggende
  proxy de socket maar komt er nooit `auth_success`, dan blijft de UI eeuwig in die staat (geen reconnect). Werd
  veroorzaakt door mijn testharnas, maar kan in productie gebeuren met een half-open Caddy-verbinding. Laag.
- Onder zware machinebelasting (load 30+) bleef `next dev` soms >30 s op "Laden…" hangen bij een eerste bezoek aan een
  route (compile). Geen appfout; `global-setup.ts` warmt nu alle hoofdroutes op.
- Geen enkele pagina logt `console.error` of gooit een `pageerror` (test "no console errors on any main page", plus de
  pageerror-controle in elke test).
- Taalwissel: NL-instellingen-, server- en navigatieteksten bevatten geen Engelse restanten (gecontroleerd op een
  aantal zinnen); volledige i18n-dekking is niet uitputtend getest.

## Niet getest / beperkt

- Externe downloads (Modrinth, GeyserMC) zijn niet gemockt: het panel doet die server-side vanuit `next dev`
  met een vaste `https`-allowlist, dus Playwright kan ze niet onderscheppen en `external-fake.ts` werkt alleen in
  vitest. De tests gebruiken het echte internet en slaan zichzelf over als het niet bereikbaar is.
  Plugin-installatie, modpack-import en WordPress-apps zijn dus alleen tot het installatiedialoog getest.
- Velocity is een nep (alpine met `velocity.toml`): de Network-flow (checkbox, naam, default, bevestigen,
  `velocity.toml`-inhoud, backend-melding) is echt, het proxygedrag zelf niet.
- Webhook "Send test message" stuurt naar Discord en is niet uitgevoerd.
- Sleep-modus: de nep-template ondersteunt het niet.
