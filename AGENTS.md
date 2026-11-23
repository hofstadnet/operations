# AGENTS.md

Instruksjoner for kodeagenter og andre som jobber i repoet. Beskrivelsen av prosjektet står i [README.md](README.md).

## Prosjektet

Offentlig repo for drift av GitHub-organisasjonen hofstadnet: innstillingene som kode (`github.json`), den ukentlige
kontrollen av dem, kontrollen av sertifikatene for hofstad.net og varslene før noe utløper. Skriptene er Node uten
pakker. Cloudflare-oppsettet ligger i `infra/` i hofstadnet-web, ikke her.

## Kommandoer

Repoet har ikke noe bygg og ingen pakker.

| Kommando | Når |
|---|---|
| `node --test scripts/*.test.mjs` | Etter endringer i `scripts/`: testene for sammenligningen, uten nettverk |
| `node scripts/apply-settings.mjs --validate` | Etter endringer i `github.json` |
| `node scripts/certificate-check.mjs --validate` | Etter endringer i `certificates.json` |
| `node scripts/apply-settings.mjs` | Planen mot GitHub (bare lesing) |

`node scripts/apply-settings.mjs --apply` endrer innstillingene i organisasjonen. Det kjøres bare av en eier, aldri av
en agent uten at eieren har bedt om det.

## Regler

- Følg de felles retningslinjene i https://github.com/hofstadnet/guidelines, særlig `operations.md` og
  `github-security.md`.
- Alle endringer går via pull request med grønne sjekker. Ikke push til `main`.
- Oppdater dokumentasjonen i samme pull request som endringen (README, `docs/rebuild.md`, `docs/architecture.md`).
- Repoet er offentlig. Ingen hemmeligheter, tokens, nøkler, e-postadresser eller personopplysninger. `expiry.json` og
  `github.json` har bare navn og datoer.
- Actions er låst til full commit-SHA med versjonen som kommentar.
- Ingenting som trenger en nøkkel, skal gjøre CI rødt når nøkkelen mangler: slike jobber hoppes over med en
  repovariabel.
