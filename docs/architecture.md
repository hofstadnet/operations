# Arkitektur

Hvordan kontrollene og skriptene i operations henger sammen. Bruken står i [README](../README.md), og gjenoppbyggingen
i [rebuild.md](rebuild.md).

## Oversikt

| Område | Valg | Hvorfor |
|---|---|---|
| Innstillinger | Én fil, `github.json`, med standardverdier og avvik per repo | Hele oppsettet kan leses og endres i en pull request |
| Lesing og sammenligning | `scripts/github-state.mjs`, brukt av både `apply-settings` og `audit` | Planen og kontrollen er alltid enige om hva som er avvik |
| Endringer i GitHub | `apply-settings.mjs`, kjørt lokalt av en eier | Ingen arbeidsflyt har skrivetilgang til organisasjonen |
| Ukentlig kontroll | GitHub-appen «HofstadNET Audit» med bare lesetilgang | `GITHUB_TOKEN` kan ikke lese andre repoer, og et personlig token skal ikke ligge i et repo |
| Sertifikater | Cert Spotter (Certificate Transparency) | Offentlig API, ingen nøkkel. Fanger sertifikater fra alle utstedere, også utenfor Cloudflare |
| Utløpsdatoer | `expiry.json` og `jq` i arbeidsflyten | Ingen kode fra repoet kjøres med skrivetilgang til saker utover å lese fila |
| Avhengigheter | Node uten pakker | Ingenting å oppdatere eller angripe utenom Actions |
| Synlighet | Offentlig repo | Se [0001](decisions/0001-public-operations-repo.md) |

## Innstillinger: plan og apply

```mermaid
flowchart LR
  pr["Pull request<br/>endrer github.json"] --> validate["validate<br/>fila og testene, uten nettverk"]
  validate -->|"merge"| main["github.json på main"]
  main --> owner["Eier kjører<br/>apply-settings.mjs"]
  owner -->|"leser med gh auth token"| api["GitHub API<br/>organisasjonen og repoene"]
  api --> diff["github-state.mjs<br/>readLive + diff"]
  main --> diff
  diff --> plan["Planen<br/>endres, manuelt, slettes med --prune"]
  plan -->|"--apply"| calls["Ett API-kall per endring"]
  calls --> api
  plan -->|"manuelt"| hand["Gjøres i nettleseren<br/>apper, tofaktor, hemmeligheter, sikkerhetsoppsettet"]
```

`apply-settings.mjs` leser hele organisasjonen, sammenligner med `github.json` og viser planen. Med `--apply` gjøres
bare endringene merket «endres». Plassholdere som `${team:maintainers}` slås opp til id-er når kallet kjøres.

## Revisjon

```mermaid
flowchart LR
  cron["Mandager, eller Run workflow"] --> job["audit-jobben<br/>bare når AUDIT_APP_CLIENT_ID er satt"]
  env["Miljøet audit<br/>bare main<br/>AUDIT_APP_PRIVATE_KEY"] --> token
  job --> token["create-github-app-token<br/>Administration, Environments, Pages, Secrets (navn), Variables,<br/>Organization administration, Members: lese"]
  token --> audit["audit.mjs<br/>readLive + diff, uten hemmeligheter, variabler og Pages"]
  audit -->|"avvik"| issue["Saken «Avvik i grunnoppsettet»<br/>opprettes eller oppdateres med GITHUB_TOKEN"]
  audit -->|"ingen avvik"| close["Saken lukkes"]
```

Tokenet fra appen varer én time og trekkes tilbake når jobben er ferdig. Saken skrives med `GITHUB_TOKEN` i dette
repoet, så appen trenger ingen skrivetilgang.

## Sertifikatkontroll

```mermaid
flowchart LR
  cron["Hver dag, eller Run workflow"] --> check["certificate-check.mjs"]
  check -->|"HTTPS, uten nøkkel"| cs["Cert Spotter<br/>gjeldende sertifikater for hofstad.net"]
  cs --> compare["Sammenligner utsteder (O=) og navn<br/>med certificates.json"]
  compare -->|"uventet"| issue["Én sak per sertifikat<br/>«Uventet sertifikat sha256-prefiks»"]
  compare -->|"oppslaget feiler"| fail["Saken «Sertifikatkontrollen feilet»<br/>lukkes når kontrollen går igjen"]
```

## Utløpsdatoer

```mermaid
flowchart LR
  cron["Mandager, push av expiry.json, eller Run workflow"] --> read["expiry.yml leser expiry.json<br/>sparse checkout av bare fila"]
  read --> days["Dager igjen per element"]
  days -->|"innen notify_days"| open["Saken «Utløper snart: navn»<br/>én per element"]
  days -->|"datoen er flyttet"| close["Saken lukkes"]
  pr["Pull request som endrer fila"] --> valid["Bare kontroll av fila"]
```

## Komponenter

| Del | Ansvar | Tilganger |
|---|---|---|
| `scripts/github-state.mjs` | Lese GitHub, utvide `github.json` med standardverdier og maler, sammenligne | Bare det tokenet den får |
| `scripts/apply-settings.mjs` | Plan, `--apply`, `--prune`, `--check`, `--manual`, `--validate` | Eierens token, lokalt |
| `scripts/audit.mjs` | Avvikene som Markdown-tabell | Token fra HofstadNET Audit (lese) |
| `scripts/certificate-check.mjs` | Uventede sertifikater som JSON-linjer | Ingen |
| `.github/workflows/audit.yml` | `validate` på pull requests, `audit` hver mandag | `contents: read`, `issues: write` |
| `.github/workflows/certificate-check.yml` | Kontroll hver dag | `contents: read`, `issues: write` |
| `.github/workflows/expiry.yml` | Varsler hver mandag | `contents: read`, `issues: write` |

## Beslutninger

- **Planen før endringer.** `apply-settings.mjs` endrer ingenting uten `--apply`, og sletter ingenting uten `--prune`.
  Alternativet, en arbeidsflyt som setter innstillingene etter merge, ville krevd et token med skrivetilgang til hele
  organisasjonen i GitHub Actions.
- **Apper og sikkerhetsoppsettet meldes, men endres ikke.** API-et kan ikke endre utvalget av repoer for en app, og
  sikkerhetsoppsettet gjelder alle repoene, så en feil der rammer alt.
- **Offentlig repo.** Se [0001](decisions/0001-public-operations-repo.md).
