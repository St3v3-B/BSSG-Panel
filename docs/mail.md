# Mailserver (mailmodule)

Voor beheerders van de panel-machine. De mailmodule is een eigen mailserver naast het panel: Postfix (SMTP),
Dovecot (IMAP, ManageSieve), Rspamd (spamfilter, DKIM), ClamAV (virusscanner), Unbound (eigen DNS-resolver) en een
eigen Redis voor Rspamd. Alles draait als containers in dezelfde compose-stack als het panel, achter het
compose-profiel `mail`, en staat standaard **uit**. Domeinen, mailboxen en aliassen beheer je in het panel; Postfix en
Dovecot lezen ze direct uit de database van het panel, dus een nieuwe mailbox werkt meteen, zonder herstart.

Webmail, autoconfig, quarantaine en DMARC-rapporten zitten (nog) niet in deze versie.

## Hoe het in elkaar zit

```
internet ──25──▶ panel-postfix ──milter──▶ panel-rspamd ──▶ panel-clamav
                     │   ▲ 465/587 (SASL)        │ └──▶ panel-mail-redis
                     │   └──────────────┐        └──▶ panel-unbound (DNS, blacklists)
                     │ LMTP             │ auth
                     ▼                  │
              panel-dovecot ◀───────────┘  ◀──993/4190── mailprogramma's
                     │
   panel-postgres ◀──┘ (views mail.v_*, rol mail_reader, alleen lezen; ook Postfix)
```

| Container | Image | Poorten op de host | Data (volume) |
|---|---|---|---|
| `panel-postfix` | eigen (`deploy/mail/postfix/`, Debian + Postfix 3.7) | 25, 465, 587 | `panel-postfix-spool` (wachtrij) |
| `panel-dovecot` | eigen (`deploy/mail/dovecot/`, Debian + Dovecot 2.3) | 993, 4190 | `panel-vmail` (alle mail) |
| `panel-rspamd` | `rspamd/rspamd` + kleine aanvulling | geen | `panel-rspamd-data`, `panel-mail-dkim` (DKIM-sleutels) |
| `panel-clamav` | `clamav/clamav` | geen | `panel-clamav-db` (virusdefinities) |
| `panel-unbound` | eigen (`deploy/mail/unbound/`) | geen | geen |
| `panel-mail-redis` | `redis:7-alpine` | geen | `panel-mail-redis` |

Netwerken: `panel-mail-db` (intern, zonder internet: alleen Postgres, Postfix en Dovecot) en `panel-mail` (de
mailcontainers onderling, met internet voor uitgaande mail, DNS en updates van ClamAV). Postgres hangt altijd aan
`panel-mail-db`, ook als de module uit staat (Compose kan de netwerken van een dienst niet van een profiel laten
afhangen); zonder mailcontainers zit daar verder niets op.

Alle mailcontainers, -netwerken en -volumes hebben de labels `panel.managed=true`, `panel.instance=main` en
`panel.role=mail`. De daemon doet er alleen `docker exec` in (doveadm, postqueue, postfix reload, rspamc) en zet het
profiel aan of uit.

Configuratie staat in `deploy/mail/` en wordt read-only in de containers gemount. Wachtwoorden en de hostnaam staan
nooit in die bestanden: de entrypoints vullen ze bij de start in vanuit de omgeving.

## Vereisten

- **Een vast publiek IP** waarop poort 25 in én uit open is. Veel thuis- en cloudproviders blokkeren uitgaand
  verkeer op poort 25: vraag het openzetten aan of gebruik een andere provider. De systeemcheck in het panel test dit.
- **Reverse DNS (PTR)** van dat IP naar `MAIL_HOSTNAME`. Dit stel je in bij de provider van het IP, niet in je
  DNS-zone.
- **Poorten 25, 465, 587, 993 en 4190** vrij op de host en open in de firewall. 80 en 443 heeft Caddy al.
- **Geheugen**: reken op ongeveer 2 GB extra, waarvan ClamAV zo'n 1,5 GB.
- `HTTP_MODE=direct` (Caddy op de eigen 80/443). Achter Nginx Proxy Manager (`HTTP_MODE=npm`) haalt Caddy geen
  certificaten; daar werkt de mailmodule in deze versie niet.

## Instellingen in `/etc/panel/panel.env`

| Variabele | Betekenis |
|---|---|
| `MAIL_HOSTNAME` | Hostnaam van de mailserver, bv. `mail.voorbeeld.nl`. Moet anders zijn dan `PANEL_DOMAIN` en `NODE_DOMAIN`. Leeg = mailmodule uit. |
| `MAIL_DB_PASSWORD` | Wachtwoord van de databaserol `mail_reader`. `install.sh` genereert het; het panel maakt of wijzigt de rol bij elke start. |
| `MAIL_PUBLIC_IPV4`, `MAIL_PUBLIC_IPV6` | Publieke adressen voor de systeemcheck en de DNS-records. Leeg = automatisch bepalen. |
| `COMPOSE_PROFILES` | Bevat `mail` als de mailstack aan staat. Zet je niet zelf: `deploy/mail.sh` (en dus de knop in het panel) houdt het bij. |

## Aanzetten

1. Maak de DNS-records voor de mailserver zelf (zie hieronder: A/AAAA en PTR).
2. Zet `MAIL_HOSTNAME` in `/etc/panel/panel.env` en draai de installatie opnieuw, zodat Caddy het certificaat haalt
   en panel en daemon de nieuwe waarde zien:

   ```
   sudo sed -i 's/^MAIL_HOSTNAME=.*/MAIL_HOSTNAME=mail.voorbeeld.nl/' /etc/panel/panel.env
   sudo deploy/install.sh --non-interactive
   ```

   (Of in één keer: `sudo MAIL_HOSTNAME=mail.voorbeeld.nl deploy/install.sh --non-interactive`.)
3. Open in het panel **Admin > Mail** en draai de systeemcheck. Als alle verplichte checks groen zijn, zet je de
   mailserver aan. Het panel laat de daemon dan `deploy/mail.sh enable` uitvoeren.

Met de hand kan het ook (zonder systeemcheck):

```
sudo deploy/mail.sh enable     # COMPOSE_PROFILES=…,mail in panel.env, images bouwen, containers starten
sudo deploy/mail.sh status     # docker compose ps van de mailcontainers
sudo deploy/mail.sh disable    # containers stoppen; alle mail blijft in de volumes
```

`enable` bouwt en start alleen de mailcontainers (`--no-deps`) en maakt Caddy opnieuw aan als zijn mailsite
veranderd is; de rest van de stack blijft ongemoeid. Na `disable` blijven de containers gestopt, ook na een reboot
of een panel-update: `install.sh` en `upgrade.sh` starten het profiel `mail` alleen als het in `COMPOSE_PROFILES`
staat **en** `MAIL_HOSTNAME` gezet is.

## DNS

Voor de mailserver zelf (eenmalig; voorbeeld `mail.voorbeeld.nl` op `203.0.113.10`):

| Record | Naam | Waarde |
|---|---|---|
| A | `mail.voorbeeld.nl` | `203.0.113.10` |
| AAAA | `mail.voorbeeld.nl` | je IPv6-adres (alleen als je IPv6 hebt, en dan ook PTR voor IPv6) |
| PTR | `10.113.0.203.in-addr.arpa` | `mail.voorbeeld.nl` (bij de provider van het IP) |

Per maildomein (het panel toont ze met een kopieerknop en controleert ze live):

| Record | Naam | Waarde |
|---|---|---|
| MX | `voorbeeld.nl` | `10 mail.voorbeeld.nl` |
| TXT (SPF) | `voorbeeld.nl` | `v=spf1 mx -all` |
| TXT (DKIM) | `dkim._domainkey.voorbeeld.nl` | `v=DKIM1; k=rsa; p=…` (het panel maakt de sleutel) |
| TXT (DMARC) | `_dmarc.voorbeeld.nl` | `v=DMARC1; p=none; rua=mailto:dmarc@voorbeeld.nl` |

Begin DMARC met `p=none` en ga naar `p=quarantine` als alles een tijdje goed gaat.

## Poorten

| Poort | Dienst | Waarvoor |
|---|---|---|
| 25 | Postfix (SMTP) | Mail van andere mailservers. Geen inloggen; geen relay. |
| 465 | Postfix (submissions) | Versturen vanuit mailprogramma's, TLS vanaf het begin, inloggen verplicht. |
| 587 | Postfix (submission) | Versturen vanuit mailprogramma's, STARTTLS verplicht, inloggen verplicht. |
| 993 | Dovecot (IMAPS) | Mail lezen. |
| 4190 | Dovecot (ManageSieve) | Filterregels beheren (STARTTLS verplicht). |

Instellingen voor een mailprogramma: server `MAIL_HOSTNAME`, gebruikersnaam = het volledige mailadres, IMAP 993
(SSL/TLS), SMTP 465 (SSL/TLS) of 587 (STARTTLS), wachtwoord = het mailboxwachtwoord.

Beveiliging, kort: alleen TLS 1.2 en hoger; inloggen nooit zonder TLS; relayen alleen na inloggen
(`mynetworks` is alleen loopback); je kunt alleen versturen als je eigen adres of een alias die naar jouw mailbox
gaat (`smtpd_sender_login_maps` op `mail.v_senders`); wachtwoorden als Argon2id-hash.

## Certificaat

Caddy haalt het certificaat voor `MAIL_HOSTNAME`, net als voor het panel. Daarvoor heeft de Caddyfile de regel
`import /etc/caddy/mail/{$MAIL_CADDY}-site*.caddy`: compose zet `MAIL_CADDY=on` zodra `MAIL_HOSTNAME` gezet is, en
dan wordt `deploy/caddy/mail/on-site.caddy` (een site voor `MAIL_HOSTNAME` met een eenvoudige pagina) geladen.
Zonder `MAIL_HOSTNAME` matcht het patroon niets en verandert er aan Caddy niets. De A-record van `MAIL_HOSTNAME` moet
naar deze machine wijzen en poort 80/443 moet bereikbaar zijn.

Postfix en Dovecot mounten het volume `panel-caddy-data` read-only en lezen
`/data/caddy/certificates/<uitgever>/<MAIL_HOSTNAME>/<MAIL_HOSTNAME>.{crt,key}`. Is er nog geen certificaat (de eerste
minuten), dan starten ze met een zelfondertekend noodcertificaat. Na een vernieuwing (en na de eerste uitgifte) laadt
het panel dagelijks het certificaat opnieuw via de daemon; met de hand:

```
sudo deploy/mail.sh reload    # = docker exec panel-postfix mail-reload; idem panel-dovecot, panel-rspamd
```

## DKIM

Het panel maakt per domein een RSA-2048-sleutel (selector `dkim`) en geeft hem aan de daemon, die hem in het volume
`panel-mail-dkim` zet (`/var/lib/rspamd/dkim/<domein>.<selector>.key`, plus een regel `<domein> <selector>` in
`selectors.map`) en Rspamd herlaadt. Rspamd ondertekent alle mail van ingelogde gebruikers voor domeinen met een
sleutel (`use_domain = header`: het domein uit de From-regel).

## Back-up

Belangrijk zijn de volumes `panel-vmail` (alle mail), `panel-mail-dkim` (DKIM-sleutels; zonder deze kloppen de
DNS-records niet meer) en de Postgres-database van het panel (domeinen, mailboxen, wachtwoorden).
`panel-rspamd-data`, `panel-mail-redis` en `panel-clamav-db` zijn te herbouwen. Let op:
`deploy/uninstall.sh --purge` verwijdert ook de mailvolumes.

## Probleemoplossing

Logs: `docker logs panel-postfix` (en `panel-dovecot`, `panel-rspamd`, `panel-clamav`, `panel-unbound`).

| Probleem | Controleren |
|---|---|
| Container start niet: `MAIL_HOSTNAME is empty or invalid` | `MAIL_HOSTNAME` in panel.env (kleine letters), daarna `deploy/mail.sh enable`. |
| `password authentication failed for user "mail_reader"` | Het panel zet de rol bij zijn start: herstart het panel (`docker restart panel-web`) na een gewijzigd `MAIL_DB_PASSWORD`, daarna de mailcontainers. |
| Mailprogramma waarschuwt voor het certificaat | `docker logs panel-postfix` toont `using a self-signed one`: Caddy heeft nog geen certificaat. Kijk in `docker logs panel-caddy` (A-record, poort 80), daarna `deploy/mail.sh reload`. |
| Inkomende mail komt niet aan | MX-record; poort 25 van buitenaf open (`telnet mail.voorbeeld.nl 25` vanaf een andere machine); `docker logs panel-postfix`. |
| Uitgaande mail blijft in de wachtrij | `docker exec panel-postfix postqueue -p`; vaak blokkeert de provider uitgaand 25 of ontbreekt PTR/SPF. Opnieuw proberen: `docker exec panel-postfix postqueue -f`. |
| Mail van ons komt bij anderen in spam | PTR = `MAIL_HOSTNAME`, SPF, DKIM en DMARC in het panel groen; IP niet op een blacklist (systeemcheck). |
| `Relay access denied` bij versturen | Het mailprogramma logt niet in of gebruikt poort 25: gebruik 465 of 587 met inloggen. |
| `Sender address rejected: not owned by user` | Je verstuurt als een adres dat niet van jouw mailbox is. Maak een alias naar je mailbox. |
| Mailbox vol | Quota in het panel verhogen; `docker exec panel-dovecot doveadm quota get -u adres@domein`. |
| Rspamd zonder blacklists | `docker logs panel-rspamd` moet beginnen met `rspamd: DNS resolver unbound (…)`. Draait `panel-unbound`? |
| Virusscanner traag bij de start | ClamAV laadt eerst zijn definities (enkele minuten, ~1,5 GB RAM). Tot dan levert Rspamd mail af met een melding in de log. |

Handige commando's:

```
docker exec panel-postfix postqueue -p                 # wachtrij
docker exec panel-postfix postsuper -d <queue-id>      # bericht uit de wachtrij halen
docker exec panel-dovecot doveadm who                  # wie is er ingelogd
docker exec panel-dovecot doveadm user '*'             # alle mailboxen zoals Dovecot ze ziet
docker exec panel-rspamd rspamc stat                   # statistieken van het spamfilter
```

## Testen

`deploy/test/mail-stack.sh` bouwt de images en start een minimale stack met een eigen Postgres (labels
`panel.test=true` + `panel.instance=mailstack-<pid>`, willekeurige poorten op 127.0.0.1, ClamAV uit). Het test
aflevering via SMTP, IMAPS met een Argon2id-wachtwoord, geen open relay, submission met inloggen (587 en 465), de
controle op het afzenderadres, catch-all, DKIM-ondertekening, quota uit SQL en `mail-reload`, en ruimt daarna alles
op. `deploy/test.sh` controleert de compose-configuratie van het profiel, de Caddy-import en `deploy/mail.sh`.
