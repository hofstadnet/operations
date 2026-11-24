# Bygge opp alt på nytt

Rekkefølgen for å sette opp hofstadnet, Cloudflare og tjenestene rundt fra bunnen, for eksempel etter at en konto er
tapt. Det meste er kode og settes av arbeidsflyter og skript. Det som må gjøres for hånd, er merket **manuelt**, med
grunnen.

| Del | Kode | Settes med |
|---|---|---|
| GitHub: organisasjon, team, repoer, regelsett, miljøer, variabler | `github.json` | `node scripts/apply-settings.mjs --apply` |
| Cloudflare: DNS, CAA, DNSSEC, soneinnstillinger, WAF, rate limiting, videresending fra www, roboter, varsler | `infra/hofstad.net/` i hofstadnet-web | «Infrastructure» (`infra.yml`) i hofstadnet-web, apply etter merge og godkjenning |
| Workeren `hofstadnet-web` og domenene hofstad.net og www.hofstad.net | `wrangler.jsonc` i hofstadnet-web | Workers Builds, ved hver endring i `main` |
| Sikkerhetshoder, CSP og videresendinger på siden | `public/_headers` og `public/_redirects` i hofstadnet-web | Workers Builds |
| Statussiden status.hofstad.net | `.upptimerc.yml` i status | Upptime og GitHub Pages i status |
| Utløpsdatoer for tokens, `security.txt` og domenet | `expiry.json` | «Utløper snart» varsler |
| Kontroll av alt over | `github.json`, `certificates.json`, `infra/` | «Audit», «Certificate check», avvikssjekken i `infra.yml` |

## 1. Kontoer (manuelt)

Kontoene kan ikke lages med kode. Alle har passnøkkel eller sikkerhetsnøkkel som tofaktor, med gjenopprettingskoder
lagret utenfor tjenestene, og innloggingen i passordbehandleren.

| Konto | Brukes til |
|---|---|
| GitHub-organisasjonen `hofstadnet` (Free) | Repoene, arbeidsflytene, Pages for statussiden |
| Cloudflare-kontoen | Sonen `hofstad.net`, Workeren, Workers Builds, R2 (state for OpenTofu), Email Routing, Web Analytics, varsler |
| Dynadot (registrar for `hofstad.net`) | Navnetjenerne fra Cloudflare og DS-posten for DNSSEC |
| Passordbehandleren | Tokens, passfrasen for state, gjenopprettingskoder |

## 2. GitHub

1. **Repoene:** push klonene til nye repoer med samme navn i `hofstadnet`. **Manuelt**: repoer lages ikke
   automatisk. Nye repoer lages fra `repo-template`.
2. **Innstillingene:** `node scripts/apply-settings.mjs`, se over planen, og `--apply`. Kjør planen igjen: den skal være
   tom, bortsett fra det som er manuelt.
3. **Manuelt**, listet av `node scripts/apply-settings.mjs --manual`:
   - Tofaktor påkrevd for organisasjonen, og medlemmene i `maintainers`.
   - Sikkerhetsoppsettet `hofstadnet-org-config-1` (Settings → Advanced Security → Configurations) med verdiene i
     `org.code_security_configurations`, håndhevet og standard for alle nye repoer.
   - GitHub-appene, med rettighetene i `org.apps` i `github.json`:

     | App | Rettigheter | Repoer |
     |---|---|---|
     | HofstadNET Audit (egen app) | Administration, Environments, Pages, Secrets, Variables, Organization administration og Members (lese) | alle |
     | HofstadNET Status (egen app) | Contents og Issues (skrive). Upptime skriver til `main` med den, og den er unntatt fra regelsettet | status |
     | Cloudflare Workers and Pages | Installeres fra Cloudflare når Workers Builds kobles til (steg 4) | hofstadnet-web |
     | Claude, ChatGPT Codex Connector | Installeres fra tjenestene | alle (til gjennomgang) |
     | Cursor | Installeres fra tjenesten | alle (til gjennomgang) |

     HofstadNET Audit lages etter [README](../README.md#audit-appen).
   - Verifisert domene for Pages (`hofstad.net`): Settings → Pages → Verified domains. TXT-posten står i `infra/` i
     hofstadnet-web.
   - Hemmelighetene, se tabellen under. Planen viser `gh secret set`-kommandoen for hvert navn som mangler.

## 3. Cloudflare

1. **Sonen `hofstad.net`** legges til i kontoen, og navnetjenerne settes hos Dynadot. **Manuelt**: sonen og
   registraren er utenfor OpenTofu.
2. **Nøkler for OpenTofu**, etter «Oppsett for en ny sone eller konto» i `infra/README.md` i hofstadnet-web: R2-bøtta
   `hofstadnet-tofu` (privat), R2-tokenet `hofstadnet-tofu-state` (Object Read & Write på bare den bøtta),
   Cloudflare-tokenet `hofstadnet-tofu` og passfrasen. **Manuelt**: koden skal ikke kunne lage sine egne nøkler. Sett
   de nye utløpsdatoene i `expiry.json`.
3. **Hemmelighetene og `TOFU_ENABLED=true`** i hofstadnet-web (tabellen under), og «Run workflow» på
   «Infrastructure». Apply lager DNS-postene, CAA, DNSSEC, soneinnstillingene, WAF-regelen, rate limiting,
   videresendingen fra www og varslene. Finnes ressursene allerede, importeres de først med en midlertidig
   `importer.tf` (se `infra/README.md`).
4. **DS-posten** fra `tofu output dnssec_ds` settes hos Dynadot (Domain → DNSSEC). **Manuelt**: registraren har ikke
   API i koden.
5. **Workers Builds:** Workers & Pages → Create → Import a repository → hofstadnet/hofstadnet-web. Byggkommando
   `npm run build`, publisering `npx wrangler deploy`, forhåndsvisninger på pull requests. Dette installerer appen
   Cloudflare Workers and Pages på hofstadnet-web og lager byggetokenet `hofstadnet-web-builds`. **Manuelt**:
   koblingen mellom Cloudflare og GitHub kan bare lages i dashbordet.
6. **Resten av kontoen** (ikke i OpenTofu). **Manuelt**:
   - Email Routing for `hofstad.net`: videresendingen til den private adressen. Adressen skal ikke stå i et offentlig
     repo. MX, SPF og DMARC står i `infra/`.
   - Web Analytics for `hofstad.net`.
   - Worker-varselet «hofstadnet-web: ny feil i Workeren», til provideren støtter varseltypen (se `infra/README.md`).

## 4. Workerne

Workers Builds lager Workeren `hofstadnet-web` og domenene hofstad.net og www.hofstad.net (custom domains) ved første
publisering fra `main`. Workeren har ingen hemmeligheter: den bruker bare `ASSETS` og offentlige data fra LiveTrack24.
Logger og varsler er slått på i `wrangler.jsonc`.

Statussiden publiseres av Upptime i repoet status med GitHub Pages (grenen `gh-pages`, domenet status.hofstad.net). Den
trenger CNAME-posten i `infra/` og det verifiserte domenet.

## 5. Hemmeligheter i GitHub

Alle lages av eieren og lagres også i passordbehandleren. Navnene står i `github.json`.

| Repo | Hvor | Navn | Kilde |
|---|---|---|---|
| hofstadnet-web | repoet | `CLOUDFLARE_API_TOKEN_READ` | Cloudflare, kontotokenet `hofstadnet-tofu-read` (bare lesing, for plan og drift) |
| hofstadnet-web | repoet | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2, tokenet `hofstadnet-tofu-state` |
| hofstadnet-web | repoet | `TOFU_STATE_PASSPHRASE` | Passordbehandleren (krypterer state) |
| hofstadnet-web | repoet | `ALERT_EMAIL` | Adressen for varsler fra Cloudflare, fra passordbehandleren |
| hofstadnet-web | repoet (variabel) | `TOFU_ENABLED` = `true` | Slår på plan og apply |
| hofstadnet-web | miljøet `cloudflare` | `CLOUDFLARE_API_TOKEN` | Cloudflare, kontotokenet `hofstadnet-tofu`. Bare apply, etter godkjenning fra teamet `maintainers`, bare `main` |
| status | miljøet `github-pages` | (ingen) | Bare grenen `gh-pages` |
| status | miljøet `status` (variabel) | `STATUS_APP_ID` | HofstadNET Status, App ID |
| status | miljøet `status` | `STATUS_APP_PRIVATE_KEY` | HofstadNET Status, privat nøkkel (`.pem`), bare `main` |
| operations | repoet (variabel) | `AUDIT_APP_CLIENT_ID` | HofstadNET Audit, App ID eller Client ID |
| operations | miljøet `audit` | `AUDIT_APP_PRIVATE_KEY` | HofstadNET Audit, privat nøkkel (`.pem`) |

Byggetokenet `hofstadnet-web-builds` ligger i Cloudflare, ikke i GitHub.

## 6. Kontroll

1. `node scripts/apply-settings.mjs --check` gir ingen endringer utover det som er manuelt.
2. «Audit», «Certificate check» og «Utløper snart» her, og «Infrastructure» og «Build» i hofstadnet-web, kjøres med
   «Run workflow» og går grønt. Planen i «Infrastructure» viser «No changes».
3. https://hofstad.net, https://www.hofstad.net (videresendes) og https://status.hofstad.net svarer, og DNSSEC
   valideres (`delegationSigned` i https://rdap.org/domain/hofstad.net).
4. Nye utløpsdatoer for alle tokenene står i `expiry.json`.
