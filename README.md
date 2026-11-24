# operations

Drift og administrasjon av GitHub-organisasjonen hofstadnet: innstillingene i GitHub som kode, en ukentlig kontroll av
dem, kontroll av sertifikatene for hofstad.net og varsler før tokens, `security.txt` og domenet utløper. Koden og
dokumentasjonen for selve nettstedet ligger i [hofstadnet-web](https://github.com/hofstadnet/hofstadnet-web)
(`docs/operations.md` og `infra/`).

Repoet er offentlig med vilje: organisasjonen er på GitHub Free, og der får private repoer ikke regelsett eller miljøer
med hemmeligheter. Se [docs/decisions/0001-public-operations-repo.md](docs/decisions/0001-public-operations-repo.md).

**Aldri hemmeligheter her**: ingen passord, tokens, nøkler eller e-postadresser (de hører hjemme i GitHub-miljøene, i
Cloudflare eller i en passordbehandler), og ingen personopplysninger. Det som utløper eller er hemmelig, står bare med
navn.

## Innhold

| Fil | Hva |
|---|---|
| `github.json`, `scripts/apply-settings.mjs`, `scripts/github-state.mjs` | GitHub-innstillingene for organisasjonen og hvert repo som kode. Se [Innstillinger som kode](#innstillinger-som-kode) |
| `scripts/audit.mjs`, `.github/workflows/audit.yml` | «Audit»: hver mandag sjekker den organisasjonen og hvert repo mot `github.json`, og holder én sak «Avvik i grunnoppsettet» oppdatert til alt er i orden. Leser med GitHub-appen «HofstadNET Audit» (bare lesetilgang). Jobben `validate` kontrollerer fila og kjører testene på alle pull requests |
| `certificates.json`, `scripts/certificate-check.mjs`, `.github/workflows/certificate-check.yml` | «Certificate check»: hver dag leser den sertifikatene for hofstad.net i Certificate Transparency-loggene (Cert Spotter) og oppretter én sak for hvert sertifikat fra en utsteder eller for et navn som ikke står i `certificates.json`. Vanlige fornyelser gir ingen sak |
| `expiry.json`, `.github/workflows/expiry.yml` | «Utløper snart»: hver mandag oppretter den en sak når noe i `expiry.json` utløper innen 45 dager (90 for domenet), og lukker den når datoen er flyttet. Følg dette repoet (Issues) for å få e-posten |
| `.github/workflows/security.yml` | `dependency-review` og zizmor på arbeidsflytene (`workflow-security`) |
| `.github/workflows/code-scanning.yml` | CodeQL for skriptene og arbeidsflytene |
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard hver mandag |
| `.github/workflows/dependabot-automerge.yml` | Slår på auto-merge for patch- og minor-oppdateringer av Actions fra Dependabot |
| `docs/rebuild.md` | Rekkefølgen for å bygge opp hofstadnet, Cloudflare og tjenestene rundt på nytt, og hva som må gjøres for hånd |
| `docs/architecture.md` | Hvordan kontrollene og skriptene henger sammen, med diagrammer |
| `docs/decisions/` | Beslutningsnotater |

## Innstillinger som kode

`github.json` beskriver alle GitHub-innstillingene som API-et kan sette: organisasjonen (tilgang for medlemmer,
Actions, `GITHUB_TOKEN`), teamet `maintainers`, sikkerhetsoppsettet `hofstadnet-org-config-1`, appene og, for hvert
repo, innstillingene, sikkerhet, Actions, tilgangen for teamet, regelsettet for `main` med påkrevde sjekker og
unntak, miljøene med tillatte branches og godkjennere, variablene og Pages. Hemmeligheter står bare med navn. Den samme
fila brukes av `scripts/apply-settings.mjs`, som setter innstillingene, og av «Audit», som kontrollerer dem hver
mandag. Begge bruker lesingen og sammenligningen i `scripts/github-state.mjs`, så de er alltid enige om hva som er
avvik.

Skriptene er ikke bundet til hofstadnet: organisasjonen er `org.login` i fila, eller miljøvariabelen `ORG`.

Kjøres lokalt av en eier av organisasjonen, med innloggingen fra `gh` (eller et token i `GH_TOKEN`):

```bash
node scripts/apply-settings.mjs            # planen: hva som ville blitt endret, ingenting endres
node scripts/apply-settings.mjs --apply    # gjør endringene, ett API-kall per endring
node scripts/apply-settings.mjs --manual   # viser også det som må gjøres for hånd
```

Andre valg: `--repo <navn>` (bare ett repo, organisasjonen tas alltid med), `--check` (avslutter med kode 1 hvis noe
avviker), `--validate` (kontrollerer bare fila) og `--prune` (sammen med `--apply`: sletter regelsett, miljøer,
tillatte branches i miljøer og variabler som ikke står i fila; uten `--prune` slettes ingenting).

Planen merker hver endring:

- **endres**: settes med `--apply`.
- **manuelt**: kan ikke settes med API-et, eller skal ikke endres automatisk. Det gjelder hemmeligheter som mangler
  (planen viser `gh secret set`-kommandoen), tofaktor, synlighet, team eller personer med tilgang som ikke står i fila,
  medlemmer i teamet, appene og sikkerhetsoppsettet for organisasjonen.
- **slettes med --prune**: finnes i GitHub, men ikke i fila.

Kjør planen etter `--apply`: den skal være tom.

### Sikkerhetsoppsettet

Organisasjonen har sikkerhetsoppsettet (code security configuration) `hofstadnet-org-config-1`. Det er håndhevet
(enforced) og standard for alle nye repoer, og slår på dependency graph, Dependabot-varsler og -sikkerhetsoppdateringer,
secret scanning med push protection og mer. `org.code_security_configurations` beskriver det, og hvert repo har
`code_security_configuration` med navnet. Planen melder avvik i oppsettet som manuelle, fordi det gjelder alle repoene
og endres i nettleseren (Settings → Advanced Security → Configurations). Privat rapportering av sårbarheter er ikke
satt i oppsettet, og slås på i hvert repo (`private_vulnerability_reporting`).

### Dette kan ikke settes med API-et

`node scripts/apply-settings.mjs --manual` lister stegene fra `manual` i `github.json`:

| Hva | Hvorfor |
|---|---|
| Tofaktor påkrevd for organisasjonen | API-et kan bare lese innstillingen. Slås på under Settings → Authentication security. Planen melder hvis den er av |
| Medlemmene i `maintainers` | Personer forvaltes ikke i koden. Planen melder hvis teamet er tomt |
| GitHub-appene: installasjon, utvalg av repoer og rettigheter | API-et kan ikke installere apper eller endre utvalget av repoer. Planen sammenligner tilgangstype (alle eller utvalgte) og rettighetene med `org.apps` |
| Sikkerhetsoppsettet for organisasjonen | Gjelder alle repoene, og endres bare i nettleseren. Planen sammenligner feltene |
| Verdiene til hemmelighetene | Skal aldri ligge i repoet. Planen melder navnene som mangler |
| Verifiserte domener for Pages | Krever en DNS-post (TXT) og bekreftelse i nettleseren |
| Synlighet og nye repoer | Endres ikke automatisk. Et nytt repo lages fra `repo-template` av en eier |

### Når et repo legges til

1. Lag repoet fra `hofstadnet/repo-template`.
2. Legg det til under `repos` i `github.json` med synlighet, beskrivelse og påkrevde sjekker, i en pull request.
3. Når den er merget: `node scripts/apply-settings.mjs --repo <navn>`, og så `--apply`.

Et repo som ikke står i `github.json`, meldes av auditen.

### Når en innstilling skal endres

Endre `github.json` i en pull request, merge, og kjør `--apply`. En endring som er gjort i nettleseren, meldes av
auditen, og overskrives ved neste `--apply` hvis fila ikke er oppdatert.

## Audit-appen

Auditen leser innstillinger i hvert repo, noe `GITHUB_TOKEN` ikke kan. Den bruker GitHub-appen «HofstadNET Audit»:

1. hofstadnet → Settings → Developer settings → GitHub Apps → New GitHub App. Navn «HofstadNET Audit», hjemmeside
   `https://github.com/hofstadnet`, Webhook «Active» av, «Only on this account».
   Repository permissions, alle Read-only: Administration, Environments, Pages, Secrets og Variables (Metadata legges
   til). Organization permissions: Administration = Read-only, Members = Read-only. Ingenting annet. Secrets gir bare
   navnene, aldri verdiene.
2. På siden til appen: noter **Client ID**, og velg «Generate a private key».
3. «Install App» → hofstadnet → «All repositories», så nye repoer også sjekkes.
4. I dette repoet → Settings → Secrets and variables → Actions → Variables: `AUDIT_APP_CLIENT_ID` (Client ID). Legg
   den også inn under `repos.operations.variables` i `github.json`.
5. Settings → Environments → `audit` (bare `main`) → hemmeligheten `AUDIT_APP_PRIVATE_KEY` (hele `.pem`-filen). Slett
   deretter `.pem`-filen.
6. Actions → «Audit» → «Run workflow».

Jobben hoppes over så lenge `AUDIT_APP_CLIENT_ID` ikke er satt, så sjekkene er grønne uten appen.

Appen har bevisst ikke tilgang til hemmeligheter, variabler og Pages. Auditen hopper over dem og skriver det som
merknad i saken. De kontrolleres når en eier kjører `node scripts/apply-settings.mjs`.

## Når et token eller en dato fornyes

1. Forny tokenet, `security.txt` eller domenet der det ligger (fremgangsmåten står i saken og i `expiry.json`).
2. Sett den nye utløpsdatoen i `expiry.json` i en pull request. Når den er merget, lukkes den åpne saken av seg selv.

## Sjekker

Regelsettet «Main protection» på `main` krever pull request og signerte commits, stopper force-push og sletting, og
krever sjekkene `validate`, `dependency-review` og `workflow-security`, og at CodeQL ikke har funn på high eller høyere.
Det står i `github.json` og settes med `scripts/apply-settings.mjs`. Squash og vanlig merge signeres av GitHub, og det
gjør også commits fra Dependabot. «Rebase and merge» kan ikke brukes, fordi GitHub ikke signerer de nye commitene.

```bash
node --test scripts/*.test.mjs                 # testene for sammenligningen, uten nettverk
node scripts/apply-settings.mjs --validate     # kontrollerer github.json
node scripts/certificate-check.mjs --validate  # kontrollerer certificates.json
```

## Sikkerhet

Se [SECURITY.md](SECURITY.md).
