// Henter gjeldende sertifikater for domenet fra Certificate Transparency-loggene (Cert Spotter) og skriver dem som
// ikke er ventet etter certificates.json, som JSON-linjer til stdout. Avslutter med kode 2 hvis oppslaget feiler.
//
//   node scripts/certificate-check.mjs [certificates.json]
//   node scripts/certificate-check.mjs --validate [certificates.json]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) || "certificates.json";
const config = JSON.parse(readFileSync(file, "utf8"));

const errors = [];
if (typeof config.domain !== "string" || !config.domain) errors.push("«domain» mangler");
if (!Array.isArray(config.issuers) || !config.issuers.length) errors.push("«issuers» mangler");
if (!Array.isArray(config.names) || !config.names.length) errors.push("«names» mangler");
if (errors.length) {
  console.error(`${file} er ugyldig:\n- ${errors.join("\n- ")}`);
  process.exit(2);
}
if (args.includes("--validate")) {
  console.error(`${file} er gyldig.`);
  process.exit(0);
}

const url = new URL("https://api.certspotter.com/v1/issuances");
url.search = new URLSearchParams([
  ["domain", config.domain],
  ["include_subdomains", "true"],
  ["expand", "dns_names"],
  ["expand", "issuer"],
]).toString();

let issuances;
for (let attempt = 1; attempt <= 3 && !issuances; attempt++) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "operations-certificate-check" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    issuances = await res.json();
  } catch (e) {
    console.error(`Forsøk ${attempt}: ${e.message}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 10000 * attempt));
  }
}
if (!issuances) process.exit(2);

const organisation = (name) => (/(?:^|, )O=([^,]+)/.exec(name || "") || [])[1] || name || "";
const known = new Set(config.names);
let unexpected = 0;
for (const c of issuances) {
  const org = organisation(c.issuer?.name);
  const badIssuer = !config.issuers.some((i) => org.includes(i));
  const badNames = c.dns_names.filter((n) => !known.has(n));
  if (!badIssuer && !badNames.length) continue;
  unexpected++;
  console.log(JSON.stringify({
    sha256: c.cert_sha256,
    issuer: c.issuer?.name,
    names: c.dns_names,
    unknownIssuer: badIssuer,
    unknownNames: badNames,
    notBefore: c.not_before,
    notAfter: c.not_after,
  }));
}
console.error(`${issuances.length} gjeldende sertifikater for ${config.domain}, ${unexpected} uventede.`);
