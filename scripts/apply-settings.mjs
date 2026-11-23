// Setter innstillingene i GitHub-organisasjonen og repoene slik github.json beskriver dem. Uten valg vises bare
// planen. Kjøres lokalt av en eier av organisasjonen, med tokenet fra GH_TOKEN eller `gh auth token`.
//
//   node scripts/apply-settings.mjs              planen: hva som ville blitt endret
//   node scripts/apply-settings.mjs --apply      gjør endringene, ett API-kall per endring
//   node scripts/apply-settings.mjs --check      som planen, men avslutter med kode 1 hvis noe avviker
//   node scripts/apply-settings.mjs --prune      med --apply: sletter også regelsett, miljøer, tillatte branches i
//                                                miljøer og variabler som ikke står i fila
//   node scripts/apply-settings.mjs --repo navn  bare dette repoet (kan gjentas); organisasjonen tas alltid med
//   node scripts/apply-settings.mjs --manual     viser også stegene API-et ikke kan gjøre
//   node scripts/apply-settings.mjs --validate   kontrollerer bare fila, uten nettverk
//   [fil]                                        en annen fil enn github.json
//
// Organisasjonen er org.login i fila, eller miljøvariabelen ORG hvis den er satt. Hemmeligheter settes aldri: skriptet
// melder bare navnene som mangler. Kode 2 ved feil, 1 når --check finner avvik, ellers 0.
import { readFileSync } from "node:fs";
import {
  createApi, diff, getToken, makeLookup, manualSteps, readLive, resolvePlaceholders, validateConfig,
} from "./github-state.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const repoFilter = args.flatMap((a, i) => (a === "--repo" ? [args[i + 1]] : []));
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--repo") || "github.json";
const KIND = { change: "endres", manual: "manuelt", prune: "slettes med --prune" };

async function main() {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const errors = validateConfig(config);
  if (errors.length) {
    console.error(`${file} er ugyldig:\n- ${errors.join("\n- ")}`);
    return 2;
  }
  if (flag("--validate")) {
    console.log(`${file} er gyldig.`);
    return 0;
  }
  for (const r of repoFilter) if (!config.repos[r]) { console.error(`${r} står ikke i ${file}.`); return 2; }
  const token = getToken();
  if (!token) {
    console.error("Fant ikke noe token: sett GH_TOKEN eller logg inn med `gh auth login`.");
    return 2;
  }
  if (process.env.ORG) config.org.login = process.env.ORG;
  const api = createApi(token);
  const org = config.org.login;
  const live = await readLive(api, config, { repos: repoFilter.length ? repoFilter : undefined });
  const changes = diff(config, live);

  for (const n of live.notes) console.log(n);
  if (!changes.length) console.log(`Ingen endringer i ${org}.`);
  else {
    console.log(`Plan for ${org}:\n`);
    for (const c of changes) {
      console.log(`${c.where} [${KIND[c.kind]}]`);
      for (const w of c.what) console.log(`  - ${w}`);
    }
    const count = (k) => changes.filter((c) => c.kind === k).length;
    console.log(`\n${count("change")} kan endres, ${count("manual")} må gjøres manuelt, ${count("prune")} slettes bare med --prune.`);
  }
  if (flag("--manual")) {
    console.log("\nKan ikke settes med API-et (gjøres for hånd):");
    for (const m of manualSteps(config)) console.log(`- ${m.where}: ${m.what}`);
  }

  if (flag("--apply")) {
    const todo = changes.filter((c) => c.kind === "change" || (c.kind === "prune" && flag("--prune")));
    if (!todo.length) { console.log("\nIngenting å endre."); return 0; }
    console.log(`\nEndrer ${todo.length} ting:`);
    const lookup = makeLookup(api, org, live.ids);
    let failed = 0;
    for (const c of todo) {
      for (const call of c.calls) {
        try {
          const path = await resolvePlaceholders(call.path, lookup);
          const body = call.body === undefined ? undefined : await resolvePlaceholders(call.body, lookup);
          const res = await api.request(call.method, path, body);
          if (res.status >= 300) throw new Error(`${call.method} ${path}: HTTP ${res.status} ${res.data?.message || ""}`.trim());
          console.log(`  ✓ ${c.where}: ${call.method} ${path}`);
        } catch (e) {
          failed++;
          console.log(`  ✗ ${c.where}: ${e.message}`);
          break; // de neste kallene for samme endring bygger på dette
        }
      }
    }
    if (failed) { console.error(`\n${failed} endring(er) feilet.`); return 2; }
    console.log("\nFerdig. Kjør uten --apply for å se at planen er tom.");
    return 0;
  }
  if (flag("--check") && changes.length) return 1;
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e.message);
  process.exit(2);
});
