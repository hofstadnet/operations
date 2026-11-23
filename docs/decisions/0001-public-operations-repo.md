# 0001 Driftsrepoet er offentlig

## Kontekst

Retningslinjene (`operations.md` i hofstadnet/guidelines) anbefaler et privat driftsrepo, fordi navn på tokens,
utløpsdatoer og oppsettet ikke trenger å være offentlige. Organisasjonen hofstadnet er på GitHub Free. Der har private
repoer ikke:

- regelsett eller branch-beskyttelse, så `main` kan ikke beskyttes og påkrevde sjekker kan ikke kreves
- miljøer med hemmeligheter og branch-regler, så nøkkelen til audit-appen kan ikke begrenses til `main`
- CodeQL, `dependency-review` og secret scanning

## Beslutning

`operations` er offentlig. Det har regelsettet «Main protection» med påkrevde sjekker, miljøet `audit` (bare `main`)
for nøkkelen til audit-appen, og de samme sikkerhetssjekkene som de andre repoene.

Innholdet skrives som om alle kan lese det: bare navn og datoer, aldri verdier, e-postadresser eller personopplysninger.
Det som står her, står allerede i de offentlige repoene (navnene på tokens og hemmeligheter i hofstadnet-web, CAA og
DNS i `infra/`), eller er offentlig fra før (utløpsdatoen for domenet i RDAP, sertifikatene i Certificate
Transparency-loggene).

## Alternativer

- **Privat repo på GitHub Free.** Ingen beskyttelse av `main` og ingen miljøer med hemmeligheter. Nøkkelen til
  audit-appen måtte ligget som repohemmelighet, tilgjengelig for alle arbeidsflyter på alle brancher.
- **GitHub Team.** Gir det et privat repo trenger, men koster per bruker for noe som ikke er hemmelig.
- **Ingen egen driftsrepo**, med innstillingene i hofstadnet-web. Blander nettstedet med organisasjonen, og
  nettstedsrepoet ville trengt å lese alle de andre repoene.

## Konsekvenser

- Hvem som helst kan se hvilke tokens og apper som finnes, hvilke repoer som har hvilke sjekker, og når noe utløper.
  Ingen av delene gir tilgang til noe.
- Saker fra kontrollene («Avvik i grunnoppsettet», «Uventet sertifikat», «Utløper snart») er offentlige. De skal derfor
  ikke inneholde mer enn det som allerede står i fila eller i offentlige logger.
- Går organisasjonen over til en betalt plan, kan repoet gjøres privat. Da skrives et nytt notat som erstatter dette.
