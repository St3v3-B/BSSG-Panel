# Template-formaat

Een template is één YAML-bestand: `templates/game/<slug>.yaml` of `templates/web/<slug>.yaml`.
Het zod-schema staat in `packages/api/template-schema.ts` (eigenaar: orchestrator); de test in
`packages/api/contract.test.ts` valideert elk bestand in `templates/game/` en `templates/web/`.

Het panel laadt bij elke start alle templates uit deze mappen (`TEMPLATES_DIR`, in de image
`/app/templates`) en werkt een template in de database bij als `version` hoger is dan de
opgeslagen versie. Admins kunnen daarnaast templates importeren of bewerken in /admin.

## Velden

| Veld | Verplicht | Betekenis |
|---|---|---|
| `schema` | ja | altijd `1` |
| `slug` | ja | unieke sleutel, `a-z0-9-` (geen punt; de bestandsnaam mag afwijken, bv. `php-8.3.yaml` met slug `php-8-3`) |
| `name`, `description` | name ja | weergavenaam en uitleg |
| `type` | ja | `game` of `web` |
| `version` | ja | geheel getal; verhogen bij elke wijziging |
| `image` | ja | runtime-image, moet als niet-root (uid 1000) kunnen draaien |
| `startup` | ja | startcommando, uitgevoerd met `/bin/sh -c` in `/home/container` |
| `stop` | ja | `{type: command, value: stop}` of `{type: signal, value: SIGTERM}` |
| `ready_pattern` | ja | RE2-regex op stdout; eerste match → status *online* |
| `http_port` | alleen web | poort in de container waarop Caddy het verkeer aflevert |
| `variables` | nee | lijst van `{key, name, description?, default, user_editable, pattern?}` |
| `install` | ja | `{image, script}`; het script draait met `/bin/sh` en dezelfde `/home/container` |
| `config_files` | nee | bestanden die de daemon vóór elke start bijwerkt |

## Variabelen

- `{{KEY}}` in `startup` en in `config_files[].set` wordt vervangen door de waarde.
- Alle variabelen staan ook als omgevingsvariabele in de container en in het install-script.
- Ingebouwd (niet zelf definiëren): `SERVER_UUID`, `SERVER_MEMORY` (MB, = RAM-limiet),
  `SERVER_IP`, `SERVER_PORT` (primaire allocation), `TZ` (`Europe/Amsterdam`).
- `pattern` is een regex die de hele waarde moet matchen; het panel controleert hem bij opslaan.
- `user_editable: false` betekent dat alleen een admin de waarde kan zetten.

## Containerregels (afgedwongen door de daemon, niet door de template)

Niet-root, geen privileged, alle capabilities eruit, `no-new-privileges`, PID-limiet, label
`panel.managed=true`. De data van de server is `/home/container`; installeer alles daar.
Het install-script draait als root in een tijdelijke container (met netwerk), daarna zet de
daemon de eigenaar van `/home/container` op uid 1000.

## Voorbeeld

```yaml
schema: 1
slug: java-generic
name: Generiek Java
description: Start een eigen JAR met de gekozen Java-versie.
type: game
version: 1
image: eclipse-temurin:21-jre
startup: java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{JAR_FILE}}
stop:
  type: command
  value: stop
ready_pattern: "Done \\("
variables:
  - key: JAR_FILE
    name: JAR-bestand
    description: Naam van de JAR in de hoofdmap
    default: server.jar
    user_editable: true
    pattern: "^[A-Za-z0-9._-]+\\.jar$"
install:
  image: alpine:3.20
  script: |
    #!/bin/sh
    set -e
    cd /home/container
    echo "Plaats $JAR_FILE via SFTP of de filemanager." > README.txt
config_files: []
```
