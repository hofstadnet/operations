# Sikkerhet

## Rapportere et sikkerhetsproblem

Ikke opprett en offentlig issue. Bruk **Report a vulnerability** under fanen **Security** i dette repoet, så bare
vedlikeholderne ser rapporten. Beskriv hva du fant, hvordan det kan gjenskapes, og hva det påvirker. Vi svarer så
fort vi kan, men dette er et personlig prosjekt.

Rapporten kan skrives på norsk eller engelsk.

## Dette er på plass

Repoet er offentlig med vilje (se `docs/decisions/0001-public-operations-repo.md`). Det inneholder navn og datoer,
aldri hemmelige verdier.

- Alle endringer på `main` går via pull request (regelsettet «Main protection»). Force push og sletting av `main` er
  blokkert.
- Påkrevde sjekker: `validate` (`github.json` og testene for skriptene), `dependency-review` og `workflow-security`
  (zizmor), pluss kodeskanning med CodeQL (high eller høyere stopper merge).
- Actions er låst til commit-SHA (påkrevd i organisasjonen) og oppdateres månedlig av Dependabot, med en ventetid på
  7 dager (30 for hovedversjoner). Patch- og minor-oppdateringer av Actions merges automatisk når alle påkrevde
  sjekker er grønne (`dependabot-automerge.yml`). Andre oppdateringer merges for hånd.
- Arbeidsflyter har bare lesetilgang som standard, og jobber ber om mer bare når de trenger det.
  `persist-credentials: false` på hver checkout.
- Revisjonen leser organisasjonen med en GitHub-app som bare har lesetilgang. Privatnøkkelen er en secret i miljøet
  `audit`, som bare tillater `main`, så pull requests ser den aldri.
- Ingen hemmeligheter i repoet. `.gitignore` blokkerer `.env` og nøkkelfiler.
- Secret scanning med push protection, Dependabot-varsler og sikkerhetsoppdateringer er slått på (organisasjonens
  oppsett for kodesikkerhet), og private sårbarhetsrapporter er slått på.
