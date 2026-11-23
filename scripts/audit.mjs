// Kontrollerer organisasjonen og repoene mot github.json, og skriver avvikene som Markdown til stdout. Bruker samme
// lesing og sammenligning som scripts/apply-settings.mjs (scripts/github-state.mjs), men endrer aldri noe.
// Avslutter med kode 1 når det finnes avvik, 2 når kontrollen selv feiler.
//
//   GH_TOKEN=... node scripts/audit.mjs [github.json]
//   node scripts/audit.mjs --validate [github.json]   kontrollerer bare fila, uten nettverk
//
// Audit-appen har bare Administration, Organization administration og Members (lesing). Det appen ikke kan lese,
// hoppes over (AUDIT_SKIP, og alt som gir 403), og det står en merknad under tabellen. Det kontrolleres i stedet
// når en eier kjører scripts/apply-settings.mjs.
import { readFileSync } from "node:fs";
import { createApi, diff, readLive, SKIP_LABELS, toTable, validateConfig } from "./github-state.mjs";

const AUDIT_SKIP = ["secrets", "variables", "pages"];

const args = process.argv.slice(2);
const validateOnly = args.includes("--validate");
const file = args.find((a) => !a.startsWith("--")) || "github.json";
const config = JSON.parse(readFileSync(file, "utf8"));

const configErrors = validateConfig(config);
if (configErrors.length) {
  console.error(`${file} er ugyldig:\n- ${configErrors.join("\n- ")}`);
  process.exit(2);
}
if (validateOnly) {
  console.log(`${file} er gyldig.`);
  process.exit(0);
}

const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN mangler.");
  process.exit(2);
}
if (process.env.ORG) config.org.login = process.env.ORG;
const org = config.org.login;

try {
  const live = await readLive(createApi(token, { userAgent: "operations-audit" }), config, { skip: AUDIT_SKIP });
  const findings = diff(config, live);
  const notes = [...new Set([...AUDIT_SKIP.map((cat) => `Ikke kontrollert: ${SKIP_LABELS[cat]}.`), ...live.notes])];
  const footer = `\n\n${notes.map((n) => `- ${n}`).join("\n")}`;
  const count = Object.keys(live.repos).length + live.unmanagedRepos.length;
  if (!findings.length) {
    console.log(`Ingen avvik i ${org}: ${count} repoer kontrollert.${footer}`);
    process.exit(0);
  }
  console.log(`${toTable(findings)}${footer}`);
  process.exit(1);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
