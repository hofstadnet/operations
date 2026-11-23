// Felles logikk for «innstillinger som kode»: lese github.json, lese innstillingene fra GitHub og sammenligne dem.
// Brukes av scripts/apply-settings.mjs (plan og apply, med eierens token) og scripts/audit.mjs (bare lesing, med
// audit-appen). Sammenligningen (diff) er ren og testes uten nettverk i scripts/github-state.test.mjs.
import { execFileSync } from "node:child_process";

export const ACTIONS_INTEGRATION_ID = 15368; // GitHub Actions som kilde for påkrevde sjekker
export const REPO_ROLES = { maintain: 2, write: 4, admin: 5 }; // actor_id for RepositoryRole i regelsett

const REPO_SETTING_KEYS = [
  "description", "homepage", "is_template", "allow_merge_commit", "allow_squash_merge", "allow_rebase_merge",
  "allow_auto_merge", "delete_branch_on_merge", "allow_update_branch", "has_issues", "has_wiki", "has_projects",
  "has_discussions", "web_commit_signoff_required",
];
const SA_KEYS = ["secret_scanning", "secret_scanning_push_protection", "dependabot_security_updates"];
const SECURITY_KEYS = [...SA_KEYS, "vulnerability_alerts", "private_vulnerability_reporting", "code_security_configuration"];
const ORG_SETTING_KEYS = [
  "default_repository_permission", "members_can_create_repositories", "members_can_fork_private_repositories",
  "web_commit_signoff_required",
];
const ORG_CHECK_ONLY_KEYS = ["two_factor_requirement_enabled"];
// Feltene i et sikkerhetsoppsett (code security configuration) som sammenlignes. Alle har verdiene enabled,
// disabled eller not_set, bortsett fra enforcement (enforced eller unenforced).
const CODE_SECURITY_KEYS = [
  "advanced_security", "dependency_graph", "dependabot_alerts", "dependabot_security_updates",
  "code_scanning_default_setup", "secret_scanning", "secret_scanning_push_protection",
  "secret_scanning_non_provider_patterns", "secret_scanning_validity_checks", "private_vulnerability_reporting",
  "enforcement",
];

// ---------------------------------------------------------------------------------------------------------------
// Hjelpere

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Slår sammen objekter rekursivt. Lister og andre verdier i `over` erstatter verdien i `base`.
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return structuredClone(over === undefined ? base : over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

// Stabil JSON (nøkler sortert), for å sammenligne verdier.
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const same = (a, b) => stable(a) === stable(b);
const fmt = (v) => (v === undefined ? "`(mangler)`" : `\`${typeof v === "string" ? v : JSON.stringify(v)}\``);
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k) && !k.startsWith("_")));
const sortStrings = (a) => [...a].sort();

// ---------------------------------------------------------------------------------------------------------------
// Ønsket tilstand: github.json med standardverdier og maler slått sammen

// Effektiv ønsket tilstand for ett repo: defaults.all + defaults.<visibility> + repoet selv. Regelsett med
// «extends» bygger på en mal i «rulesets». Regler er et objekt med regeltypen som nøkkel; `false` fjerner en regel
// fra malen. Et regelsett eller miljø som er `false`, fjernes fra standardverdiene. Actions som er slått av
// (`"actions": { "enabled": false }`), sammenlignes bare på `enabled`.
export function expandRepo(config, name) {
  const own = config.repos[name];
  const d = config.defaults || {};
  const eff = deepMerge(deepMerge(d.all || {}, d[own.visibility] || {}), without(own, []));
  eff.rulesets = Object.fromEntries(
    Object.entries(eff.rulesets || {}).filter(([, rs]) => rs !== false).map(([rsName, rs]) => [rsName, expandRuleset(config, rs)]),
  );
  eff.environments = Object.fromEntries(
    Object.entries(eff.environments || {}).filter(([, env]) => env !== false).map(([envName, env]) => [envName, deepMerge(config.defaults?.environment || {}, env)]),
  );
  if (eff.actions?.enabled === false) eff.actions = { enabled: false };
  return eff;
}

export function expandRuleset(config, rs) {
  let out = rs;
  if (rs.extends) {
    const tpl = config.rulesets?.[rs.extends];
    if (!tpl) throw new Error(`regelsettmalen «${rs.extends}» finnes ikke`);
    out = deepMerge(tpl, without(rs, ["extends"]));
  }
  out = without(out, ["extends"]);
  out.rules = Object.fromEntries(Object.entries(out.rules || {}).filter(([, v]) => v !== false));
  return out;
}

// Kontrollerer fila uten nettverk. Gir en liste med feil (tom når fila er gyldig).
export function validateConfig(c) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(c.org)) err("«org» mangler");
  if (typeof c.org?.login !== "string") err("«org.login» mangler");
  if (!isObj(c.repos) || !Object.keys(c.repos).length) err("«repos» mangler eller er tom");
  const teams = Object.keys(c.org?.teams || {});
  for (const [slug, t] of Object.entries(c.org?.teams || {})) {
    if (!["closed", "secret"].includes(t.privacy)) err(`team ${slug}: «privacy» må være closed eller secret`);
  }
  const checkVars = (where, vars) => {
    if (vars === undefined) return;
    if (!isObj(vars)) return err(`${where}: «variables» må være et objekt med navn og verdi`);
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) err(`${where}: variabelnavnet ${k} er ugyldig`);
      if (typeof v !== "string") err(`${where}: verdien til ${k} må være tekst`);
    }
  };
  const checkSecrets = (where, list) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) return err(`${where}: må være en liste med navn`);
    for (const s of list) if (typeof s !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(s)) err(`${where}: hemmelighetsnavnet ${s} er ugyldig`);
    if (new Set(list).size !== list.length) err(`${where}: samme navn står flere ganger`);
  };
  const checkRuleset = (where, rs) => {
    if (!["branch", "tag", "push"].includes(rs.target)) err(`${where}: «target» må være branch, tag eller push`);
    if (!["active", "evaluate", "disabled"].includes(rs.enforcement)) err(`${where}: «enforcement» er ugyldig`);
    if (!isObj(rs.rules) || !Object.keys(rs.rules).length) err(`${where}: «rules» mangler`);
    for (const a of rs.bypass_actors || []) {
      const kinds = ["role", "app", "team", "org_admin", "deploy_key"].filter((k) => k in a);
      if (kinds.length !== 1) err(`${where}: hvert unntak trenger nøyaktig én av role, app, team, org_admin, deploy_key`);
      if ("role" in a && !(a.role in REPO_ROLES)) err(`${where}: ukjent rolle ${a.role} (${Object.keys(REPO_ROLES).join(", ")})`);
      if ("team" in a && !teams.includes(a.team)) err(`${where}: teamet ${a.team} står ikke i org.teams`);
      if (!["always", "pull_request"].includes(a.mode)) err(`${where}: «mode» må være always eller pull_request`);
    }
    const rsc = rs.rules?.required_status_checks;
    if (rsc) {
      const checks = rsc.required_status_checks;
      if (!Array.isArray(checks) || !checks.length) err(`${where}: required_status_checks trenger minst én sjekk`);
      const names = (checks || []).map((x) => (typeof x === "string" ? x : x?.context));
      if (names.some((n) => typeof n !== "string" || !n)) err(`${where}: hver sjekk er et navn eller {context, integration_id}`);
      if (new Set(names).size !== names.length) err(`${where}: samme sjekk står flere ganger`);
      if (typeof rsc.strict_required_status_checks_policy !== "boolean") err(`${where}: strict_required_status_checks_policy mangler`);
    }
  };
  for (const [name, rs] of Object.entries(c.org?.rulesets || {})) {
    try { checkRuleset(`org-regelsettet ${name}`, expandRuleset(c, rs)); } catch (e) { err(`org-regelsettet ${name}: ${e.message}`); }
  }
  const csNames = Object.keys(c.org?.code_security_configurations || {});
  for (const [csName, cs] of Object.entries(c.org?.code_security_configurations || {})) {
    for (const k of Object.keys(cs)) {
      if (k !== "default_for_new_repos" && !CODE_SECURITY_KEYS.includes(k) && !k.startsWith("_")) err(`sikkerhetsoppsettet ${csName}: ukjent felt ${k}`);
    }
    if (cs.default_for_new_repos !== undefined && !["all", "none", "private_and_internal", "public"].includes(cs.default_for_new_repos)) {
      err(`sikkerhetsoppsettet ${csName}: «default_for_new_repos» må være all, none, private_and_internal eller public`);
    }
  }
  checkVars("org", c.org?.variables);
  checkSecrets("org.secrets", c.org?.secrets);
  checkSecrets("org.dependabot_secrets", c.org?.dependabot_secrets);
  for (const name of Object.keys(c.repos || {})) {
    const own = c.repos[name];
    if (!["public", "private"].includes(own.visibility)) { err(`${name}: «visibility» må være public eller private`); continue; }
    let r;
    try { r = expandRepo(c, name); } catch (e) { err(`${name}: ${e.message}`); continue; }
    for (const k of Object.keys(r.settings || {})) if (!REPO_SETTING_KEYS.includes(k)) err(`${name}: ukjent innstilling ${k}`);
    for (const k of Object.keys(r.security || {})) if (!SECURITY_KEYS.includes(k)) err(`${name}: ukjent sikkerhetsinnstilling ${k}`);
    const csw = r.security?.code_security_configuration;
    if (typeof csw === "string" && csNames.length && !csNames.includes(csw)) err(`${name}: sikkerhetsoppsettet ${csw} står ikke i org.code_security_configurations`);
    if (r.visibility === "private" && r.security?.private_vulnerability_reporting !== undefined) {
      err(`${name}: privat rapportering av sårbarheter finnes ikke for private repoer`);
    }
    for (const [t, p] of Object.entries(r.teams || {})) {
      if (!teams.includes(t)) err(`${name}: teamet ${t} står ikke i org.teams`);
      if (!["pull", "triage", "push", "maintain", "admin"].includes(p)) err(`${name}: ugyldig tilgang ${p} for ${t}`);
    }
    if (!r.issues_only && !Object.keys(r.rulesets).length) err(`${name}: har ingen regelsett (sett «issues_only» hvis repoet ikke har kode)`);
    for (const [rsName, rs] of Object.entries(r.rulesets)) checkRuleset(`${name}, regelsettet ${rsName}`, rs);
    checkVars(name, r.variables);
    checkSecrets(`${name}.secrets`, r.secrets);
    checkSecrets(`${name}.dependabot_secrets`, r.dependabot_secrets);
    for (const [envName, env] of Object.entries(r.environments)) {
      const w = `${name}, miljøet ${envName}`;
      if (!(env.branches === null || env.branches === "protected" || Array.isArray(env.branches))) {
        err(`${w}: «branches» må være en liste, "protected" eller null`);
      }
      if (env.reviewers?.length && r.visibility !== "public") {
        err(`${w}: påkrevd godkjenning i miljøer krever et offentlig repo i planen organisasjonen har`);
      }
      for (const rv of env.reviewers || []) if (!teams.includes(rv.team)) err(`${w}: godkjenneren må være et team i org.teams`);
      checkVars(w, env.variables);
      checkSecrets(`${w}.secrets`, env.secrets);
    }
    if (r.pages && !["workflow", "legacy"].includes(r.pages.build_type)) err(`${name}: pages.build_type må være workflow eller legacy`);
    if (r.manual !== undefined && !Array.isArray(r.manual)) err(`${name}: «manual» må være en liste`);
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub-API-et

export function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path}: HTTP ${status}${body?.message ? ` (${body.message})` : ""}`);
    this.status = status;
  }
}

export function createApi(token, { userAgent = "operations-settings" } = {}) {
  async function request(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }
  async function get(path, { allow = [] } = {}) {
    const { status, data } = await request("GET", path);
    if (status >= 200 && status < 300) return status === 204 ? true : data;
    if (allow.includes(status)) return { $status: status };
    throw new HttpError("GET", path, status, data);
  }
  async function getAll(path, key) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await get(`${path}${sep}per_page=100&page=${page}`);
      const items = key ? data[key] : data;
      out.push(...items);
      if (items.length < 100) return out;
    }
  }
  return { request, get, getAll };
}

// ---------------------------------------------------------------------------------------------------------------
// Lesing av dagens tilstand. Resultatet har samme form som den ønskede tilstanden, så diff() kan sammenligne
// direkte. En del som ikke kunne leses (mangler tilgang, eller står i `skip`), er `undefined`, og diff() hopper
// over den. Grunnen står i live.notes.

export const SKIP_LABELS = {
  secrets: "navnene på hemmelighetene (krever Secrets: read)",
  variables: "variablene, også i miljøene (krever Variables: read og Environments: read)",
  pages: "Pages (krever Pages: read)",
  environments: "miljøene (krever Actions: read)",
  apps: "installerte apper",
  code_security: "sikkerhetsoppsettet (code security configuration)",
  members: "medlemmene i teamene",
  collaborators: "enkeltpersoner med tilgang til repoene",
  rulesets: "regelsettene",
  repo_settings: "innstillingene for merge og branch (krever skrivetilgang)",
};

export async function readLive(api, config, { skip = [], repos: only } = {}) {
  const org = config.org.login;
  const skipped = new Set(skip);
  const noted = new Set();
  const note = (cat) => noted.add(cat);
  const want = (cat) => !skipped.has(cat);
  // Leser en valgfri del. Manglende tilgang (403, eller 404 der `missingIs404`) gir `undefined` og en merknad.
  async function optional(cat, path, { allow404 = false, missingIs404 = false } = {}) {
    if (!want(cat)) return undefined;
    const r = await api.get(path, { allow: [403, 404] });
    if (r?.$status === 403 || (r?.$status === 404 && missingIs404)) { note(cat); return undefined; }
    if (r?.$status === 404) { if (allow404) return null; throw new HttpError("GET", path, 404); }
    return r;
  }
  const live = { org: {}, repos: {}, ids: { apps: {}, teams: {}, repos: {} }, unmanagedRepos: [], notes: [], only };

  // Organisasjonen
  const o = await api.get(`/orgs/${org}`);
  live.org.settings = Object.fromEntries(ORG_SETTING_KEYS.map((k) => [k, o[k]]));
  live.org.check_only = Object.fromEntries(ORG_CHECK_ONLY_KEYS.map((k) => [k, o[k]]));
  live.org.actions = await api.get(`/orgs/${org}/actions/permissions`);
  live.org.workflow = await api.get(`/orgs/${org}/actions/permissions/workflow`);
  live.org.teams = {};
  for (const t of await api.getAll(`/orgs/${org}/teams`)) {
    live.ids.teams[t.slug] = t.id;
    const members = want("members")
      ? await api.get(`/orgs/${org}/teams/${t.slug}/members?per_page=100`, { allow: [403] })
      : { $status: "skip" };
    if (members?.$status) note("members");
    live.org.teams[t.slug] = { description: t.description, privacy: t.privacy, _members: members?.$status ? undefined : members.length };
  }
  const inst = await optional("apps", `/orgs/${org}/installations?per_page=100`);
  if (inst) {
    live.org.apps = {};
    for (const i of inst.installations) {
      live.ids.apps[i.app_slug] = i.app_id;
      live.org.apps[i.app_slug] = { repository_selection: i.repository_selection, permissions: i.permissions };
    }
  }
  // Apper som brukes i regelsett, men som ikke er installert (eller ikke kunne listes): id-en er offentlig.
  const appSlugs = new Set();
  const collectApps = (rs) => (rs.bypass_actors || []).forEach((a) => a.app && appSlugs.add(a.app));
  Object.values(config.org.rulesets || {}).forEach((rs) => collectApps(expandRuleset(config, rs)));
  for (const name of Object.keys(config.repos)) Object.values(expandRepo(config, name).rulesets).forEach(collectApps);
  for (const slug of appSlugs) {
    if (live.ids.apps[slug]) continue;
    const a = await api.get(`/apps/${slug}`, { allow: [404] });
    if (!a.$status) live.ids.apps[slug] = a.id;
  }
  live.org.variables = want("variables") ? await readVariables(api, `/orgs/${org}/actions/variables`, note) : undefined;
  live.org.secrets = await readSecretNames(optional, `/orgs/${org}/actions/secrets`);
  live.org.dependabot_secrets = await readSecretNames(optional, `/orgs/${org}/dependabot/secrets`);
  // Regelsett for hele organisasjonen leses bare når fila har «org.rulesets»: på GitHub Free finnes de ikke (403).
  const orgRulesets = "rulesets" in config.org ? await optional("rulesets", `/orgs/${org}/rulesets?per_page=100`) : undefined;
  live.org.rulesets = orgRulesets ? await readRulesets(api, `/orgs/${org}/rulesets`, orgRulesets, live.ids) : undefined;
  if (want("code_security")) {
    const cfgs = await optional("code_security", `/orgs/${org}/code-security/configurations?per_page=100`);
    if (cfgs) {
      live.ids.codeSecurityConfigs = Object.fromEntries(cfgs.map((c) => [c.name, c.id]));
      const defaults = await optional("code_security", `/orgs/${org}/code-security/configurations/defaults`);
      live.org.code_security_configurations = Object.fromEntries(cfgs.filter((c) => c.target_type === "organization").map((c) => [c.name, {
        ...Object.fromEntries(CODE_SECURITY_KEYS.map((k) => [k, c[k]])),
        default_for_new_repos: defaults ? (defaults.find((d) => d.configuration?.id === c.id)?.default_for_new_repos ?? "none") : undefined,
      }]));
    }
  }

  // Repoene
  const all = await api.getAll(`/orgs/${org}/repos?type=all`);
  for (const repo of all) {
    if (repo.archived) continue;
    live.ids.repos[repo.name] = repo.id;
    if (!config.repos[repo.name]) { live.unmanagedRepos.push({ name: repo.name, visibility: repo.visibility }); continue; }
    if (only && !only.includes(repo.name)) continue;
    live.repos[repo.name] = await readRepo(api, org, repo.name, { optional, want, note, ids: live.ids });
  }
  live.notes = [...noted].map((cat) => `Ikke kontrollert: ${SKIP_LABELS[cat] || cat}.`);
  return live;
}

async function readVariables(api, path, note) {
  const r = await api.get(`${path}?per_page=30`, { allow: [403, 404] });
  if (r?.$status === 403) { note("variables"); return undefined; }
  if (r?.$status === 404) return {};
  const vars = [...r.variables];
  for (let page = 2; vars.length < r.total_count; page++) {
    const more = await api.get(`${path}?per_page=30&page=${page}`);
    if (!more.variables.length) break;
    vars.push(...more.variables);
  }
  return Object.fromEntries(vars.map((v) => [v.name, v.value]));
}

async function readSecretNames(optional, path) {
  const r = await optional("secrets", `${path}?per_page=100`);
  return r ? sortStrings(r.secrets.map((s) => s.name)) : undefined;
}

async function readRulesets(api, base, list, ids) {
  const out = {};
  for (const item of list) {
    if (item.source_type && item.source_type !== "Repository" && base.startsWith("/repos/")) continue; // arvet fra org
    const rs = await api.get(`${base}/${item.id}`);
    out[rs.name] = normalizeLiveRuleset(rs, ids);
  }
  return out;
}

export function normalizeLiveRuleset(rs, ids) {
  const out = {
    _id: rs.id,
    target: rs.target,
    enforcement: rs.enforcement,
    conditions: rs.conditions,
    rules: Object.fromEntries(rs.rules.map((r) => [r.type, r.parameters ?? {}])),
  };
  if (Array.isArray(rs.bypass_actors)) out.bypass_actors = rs.bypass_actors.map((a) => liveBypass(a, ids));
  return out;
}

function liveBypass(a, ids) {
  const mode = a.bypass_mode;
  const rev = (map, id) => Object.entries(map || {}).find(([, v]) => v === id)?.[0];
  switch (a.actor_type) {
    case "RepositoryRole": return { role: rev(REPO_ROLES, a.actor_id) ?? `id:${a.actor_id}`, mode };
    case "Integration": return { app: rev(ids.apps, a.actor_id) ?? `id:${a.actor_id}`, mode };
    case "Team": return { team: rev(ids.teams, a.actor_id) ?? `id:${a.actor_id}`, mode };
    case "OrganizationAdmin": return { org_admin: true, mode };
    case "DeployKey": return { deploy_key: true, mode };
    default: return { [a.actor_type]: a.actor_id, mode };
  }
}

async function readRepo(api, org, name, { optional, want, note, ids }) {
  const p = `/repos/${org}/${name}`;
  const full = await api.get(p);
  const r = { visibility: full.visibility, _default_branch: full.default_branch };
  // Innstillingene for merge og lignende er bare med i svaret når tokenet har skrivetilgang; det som mangler, kontrolleres ikke.
  r.settings = Object.fromEntries(REPO_SETTING_KEYS.filter((k) => k in full).map((k) => [k, full[k]]));
  if (REPO_SETTING_KEYS.some((k) => !(k in full))) note("repo_settings");
  const sa = full.security_and_analysis;
  r.security = {};
  if (sa) for (const k of SA_KEYS) r.security[k] = sa[k]?.status === "enabled";
  const va = await api.get(`${p}/vulnerability-alerts`, { allow: [404] });
  r.security.vulnerability_alerts = va === true;
  if (full.visibility === "public") {
    const pvr = await api.get(`${p}/private-vulnerability-reporting`, { allow: [404] });
    r.security.private_vulnerability_reporting = pvr?.enabled === true;
  }
  if (want("code_security")) {
    const cs = await api.get(`${p}/code-security-configuration`, { allow: [403, 404] });
    if (cs?.$status === 403) note("code_security");
    else r.security.code_security_configuration = cs === true || cs?.$status === 404 ? null : cs.configuration?.name ?? null;
  }
  const act = await api.get(`${p}/actions/permissions`);
  r.actions = without(act, ["selected_actions_url"]);
  r.workflow = await api.get(`${p}/actions/permissions/workflow`);
  r.teams = Object.fromEntries((await api.getAll(`${p}/teams`)).map((t) => [t.slug, t.permission]));
  const collab = await optional("collaborators", `${p}/collaborators?affiliation=direct&per_page=100`);
  if (collab) r.collaborators = Object.fromEntries(collab.map((c) => [c.login, c.role_name]));
  const rsList = await optional("rulesets", `${p}/rulesets?includes_parents=false&per_page=100`);
  r.rulesets = rsList ? await readRulesets(api, `${p}/rulesets`, rsList, ids) : undefined;
  if (!r.rulesets && want("rulesets")) {
    // Uten tilgang til regelsettene: reglene som gjelder for standardbranchen (bare metadata), så typene og de påkrevde
    // sjekkene likevel kontrolleres.
    const eff = await api.get(`${p}/rules/branches/${encodeURIComponent(full.default_branch)}`, { allow: [403, 404] });
    if (Array.isArray(eff)) {
      r._effectiveRules = {
        types: [...new Set(eff.map((x) => x.type))],
        checks: eff.filter((x) => x.type === "required_status_checks").flatMap((x) => x.parameters?.required_status_checks || []).map((c) => c.context),
      };
    }
  }

  const envs = await optional("environments", `${p}/environments?per_page=100`, { missingIs404: true });
  if (envs) {
    r.environments = {};
    for (const e of envs.environments) r.environments[e.name] = await readEnvironment(api, p, e, { optional, want, note });
  }
  r.variables = want("variables") ? await readVariables(api, `${p}/actions/variables`, note) : undefined;
  r.secrets = await readSecretNames(optional, `${p}/actions/secrets`);
  r.dependabot_secrets = await readSecretNames(optional, `${p}/dependabot/secrets`);
  const pages = await optional("pages", `${p}/pages`, { allow404: true });
  if (pages !== undefined) {
    r.pages = pages && {
      build_type: pages.build_type,
      cname: pages.cname,
      https_enforced: pages.https_enforced,
      ...(pages.build_type === "legacy" ? { source: pages.source } : {}),
    };
  }
  return r;
}

async function readEnvironment(api, p, e, { optional, want, note }) {
  const rules = e.protection_rules || [];
  const rv = rules.find((x) => x.type === "required_reviewers");
  const wt = rules.find((x) => x.type === "wait_timer");
  const env = {
    can_admins_bypass: e.can_admins_bypass,
    wait_timer: wt?.wait_timer ?? 0,
    reviewers: (rv?.reviewers || []).map((x) => (x.type === "Team" ? { team: x.reviewer.slug } : { user: x.reviewer.login })),
  };
  if (rv) env.prevent_self_review = rv.prevent_self_review;
  const dbp = e.deployment_branch_policy;
  if (!dbp) env.branches = null;
  else if (dbp.protected_branches) env.branches = "protected";
  else {
    const bp = await optional("environments", `${p}/environments/${encodeURIComponent(e.name)}/deployment-branch-policies?per_page=100`);
    if (bp) {
      env.branches = sortStrings(bp.branch_policies.map((b) => (b.type === "tag" ? `tag:${b.name}` : b.name)));
      env._branch_policy_ids = Object.fromEntries(bp.branch_policies.map((b) => [b.type === "tag" ? `tag:${b.name}` : b.name, b.id]));
    }
  }
  env.variables = want("variables") ? await readVariables(api, `${p}/environments/${encodeURIComponent(e.name)}/variables`, note) : undefined;
  env.secrets = await readSecretNames(optional, `${p}/environments/${encodeURIComponent(e.name)}/secrets`);
  return env;
}

// ---------------------------------------------------------------------------------------------------------------
// Sammenligning. Gir en liste med endringer:
//   { where, what: [tekst, ...], kind, calls: [{ method, path, body }] }
// kind: "change" (apply retter det), "manual" (må gjøres for hånd), "prune" (finnes, men ikke i fila; slettes bare
// med --prune). Verdier som "${team:maintainers}" i calls slås opp når de kjøres (se resolvePlaceholders).

export function diff(config, live) {
  const org = config.org.login;
  const out = [];
  const add = (where, what, kind, calls = []) => out.push({ where, what: [].concat(what), kind, calls });
  const O = "organisasjonen";

  // Organisasjonen
  const ws = config.org.settings || {};
  const changed = Object.keys(ws).filter((k) => !same(ws[k], live.org.settings?.[k]));
  if (changed.length) {
    add(O, changed.map((k) => `\`${k}\` er ${fmt(live.org.settings?.[k])}, skal være ${fmt(ws[k])}`), "change",
      [{ method: "PATCH", path: `/orgs/${org}`, body: Object.fromEntries(changed.map((k) => [k, ws[k]])) }]);
  }
  for (const [k, v] of Object.entries(config.org.check_only || {})) {
    if (!same(v, live.org.check_only?.[k])) add(O, `\`${k}\` er ${fmt(live.org.check_only?.[k])}, skal være ${fmt(v)} (kan ikke settes med API-et)`, "manual");
  }
  for (const [key, path] of [["actions", `/orgs/${org}/actions/permissions`], ["workflow", `/orgs/${org}/actions/permissions/workflow`]]) {
    const w = config.org[key];
    if (!w) continue;
    const ks = Object.keys(w).filter((k) => !same(w[k], live.org[key]?.[k]));
    if (ks.length) add(O, ks.map((k) => `\`${k}\` er ${fmt(live.org[key]?.[k])}, skal være ${fmt(w[k])}`), "change", [{ method: "PUT", path, body: w }]);
  }
  for (const [slug, t] of Object.entries(config.org.teams || {})) {
    const l = live.org.teams?.[slug];
    const where = `team ${slug}`;
    if (!l) {
      add(where, "teamet finnes ikke", "change", [{ method: "POST", path: `/orgs/${org}/teams`, body: { name: slug, description: t.description, privacy: t.privacy } }]);
      if (t.min_members) add(where, `legg til minst ${t.min_members} medlem(mer)`, "manual");
      continue;
    }
    const ks = ["description", "privacy"].filter((k) => k in t && !same(t[k], l[k]));
    if (ks.length) add(where, ks.map((k) => `\`${k}\` er ${fmt(l[k])}, skal være ${fmt(t[k])}`), "change",
      [{ method: "PATCH", path: `/orgs/${org}/teams/${slug}`, body: Object.fromEntries(ks.map((k) => [k, t[k]])) }]);
    if (t.min_members && l._members !== undefined && l._members < t.min_members) {
      add(where, `har ${l._members} medlem(mer), skal ha minst ${t.min_members}`, "manual");
    }
  }
  for (const slug of Object.keys(live.org.teams || {})) {
    if (!config.org.teams?.[slug]) add(`team ${slug}`, "teamet står ikke i fila", "manual");
  }
  if (config.org.apps && live.org.apps) {
    for (const [slug, a] of Object.entries(config.org.apps)) {
      const l = live.org.apps[slug];
      if (!l) { add(`appen ${slug}`, "er ikke installert", "manual"); continue; }
      const what = [];
      if (a.repository_selection && a.repository_selection !== l.repository_selection) {
        what.push(`har tilgang til ${l.repository_selection === "all" ? "alle repoer" : "utvalgte repoer"}, skal ha ${a.repository_selection === "all" ? "alle" : "utvalgte"}`);
      }
      if (a.permissions && !same(a.permissions, l.permissions)) what.push(`rettighetene er ${fmt(l.permissions)}, skal være ${fmt(a.permissions)}`);
      if (what.length) add(`appen ${slug}`, what, "manual");
    }
    for (const slug of Object.keys(live.org.apps)) if (!config.org.apps[slug]) add(`appen ${slug}`, "er installert, men står ikke i fila", "manual");
  }
  diffVariables(add, O, config.org.variables, live.org.variables, `/orgs/${org}/actions/variables`, { visibility: "all" });
  diffSecretNames(add, O, config.org.secrets, live.org.secrets, `gh secret set NAVN --org ${org}`);
  diffSecretNames(add, O, config.org.dependabot_secrets, live.org.dependabot_secrets, `gh secret set NAVN --org ${org} --app dependabot`, "Dependabot-");
  diffCodeSecurity(add, config.org.code_security_configurations, live.org.code_security_configurations);
  if (config.org.rulesets && live.org.rulesets) diffRulesets(add, O, expandAll(config, config.org.rulesets), live.org.rulesets, `/orgs/${org}/rulesets`);

  // Repoene
  for (const r of live.unmanagedRepos || []) add(r.name, `nytt repo som ikke står i github.json (${r.visibility})`, "manual");
  for (const name of Object.keys(config.repos)) {
    if (live.only && !live.only.includes(name)) continue;
    const want = expandRepo(config, name);
    const l = live.repos[name];
    if (!l) { add(name, "står i github.json, men finnes ikke i organisasjonen (lag repoet, og kjør på nytt)", "manual"); continue; }
    diffRepo(add, org, name, want, l, live.ids);
  }
  return out;
}

// Sikkerhetsoppsettene i organisasjonen. De endres bare i nettleseren (Settings → Advanced Security →
// Configurations), fordi de gjelder alle repoene, og meldes derfor som manuelle. Et oppsett som finnes, men ikke står
// i fila, meldes også.
function diffCodeSecurity(add, want, live) {
  if (!want || !live) return;
  for (const [name, cs] of Object.entries(want)) {
    const where = `sikkerhetsoppsettet ${name}`;
    const l = live[name];
    if (!l) { add(where, "finnes ikke i organisasjonen", "manual"); continue; }
    const ks = Object.keys(cs).filter((k) => !k.startsWith("_") && l[k] !== undefined && !same(cs[k], l[k]));
    if (ks.length) add(where, ks.map((k) => `\`${k}\` er ${fmt(l[k])}, skal være ${fmt(cs[k])}`), "manual");
  }
  for (const name of Object.keys(live)) if (!want[name]) add(`sikkerhetsoppsettet ${name}`, "finnes, men står ikke i fila", "manual");
}

const expandAll = (config, map) => Object.fromEntries(Object.entries(map).map(([n, rs]) => [n, expandRuleset(config, rs)]));

function diffRepo(add, org, name, want, l, ids) {
  const p = `/repos/${org}/${name}`;
  if (want.visibility !== l.visibility) {
    add(name, `synlighet er \`${l.visibility}\`, skal være \`${want.visibility}\` (endres ikke automatisk)`, "manual");
  }
  const s = want.settings || {};
  const sk = Object.keys(s).filter((k) => k in l.settings && !same(norm(s[k]), norm(l.settings[k])));
  if (sk.length) add(name, sk.map((k) => `\`${k}\` er ${fmt(l.settings[k])}, skal være ${fmt(s[k])}`), "change",
    [{ method: "PATCH", path: p, body: Object.fromEntries(sk.map((k) => [k, s[k]])) }]);

  const sec = want.security || {};
  const saChanged = SA_KEYS.filter((k) => k in sec && k in l.security && sec[k] !== l.security[k]);
  if (saChanged.length) {
    add(name, saChanged.map((k) => `${label(k)} er ${onOff(l.security[k])}, skal være ${onOff(sec[k])}`), "change",
      [{ method: "PATCH", path: p, body: { security_and_analysis: Object.fromEntries(saChanged.map((k) => [k, { status: sec[k] ? "enabled" : "disabled" }])) } }]);
  }
  for (const [k, ep] of [["vulnerability_alerts", "vulnerability-alerts"], ["private_vulnerability_reporting", "private-vulnerability-reporting"]]) {
    if (k in sec && k in l.security && sec[k] !== l.security[k]) {
      add(name, `${label(k)} er ${onOff(l.security[k])}, skal være ${onOff(sec[k])}`, "change", [{ method: sec[k] ? "PUT" : "DELETE", path: `${p}/${ep}` }]);
    }
  }
  if ("code_security_configuration" in sec && "code_security_configuration" in l.security
      && sec.code_security_configuration !== l.security.code_security_configuration) {
    const w = sec.code_security_configuration;
    add(name, `sikkerhetsoppsettet er ${fmt(l.security.code_security_configuration ?? "ingen")}, skal være ${fmt(w ?? "ingen")}`, "change", [w
      ? { method: "POST", path: `/orgs/${org}/code-security/configurations/\${codeSecurityConfig:${w}}/attach`, body: { scope: "selected", selected_repository_ids: [`\${repoId:${name}}`] } }
      : { method: "DELETE", path: `/orgs/${org}/code-security/configurations/detach`, body: { selected_repository_ids: [`\${repoId:${name}}`] } }]);
  }

  for (const [key, path, what] of [["actions", `${p}/actions/permissions`, "Actions"], ["workflow", `${p}/actions/permissions/workflow`, "GITHUB_TOKEN"]]) {
    const w = want[key];
    if (!w) continue;
    const ks = Object.keys(w).filter((k) => !same(w[k], l[key]?.[k]));
    if (ks.length) add(name, ks.map((k) => `${what}: \`${k}\` er ${fmt(l[key]?.[k])}, skal være ${fmt(w[k])}`), "change", [{ method: "PUT", path, body: w }]);
  }

  for (const [t, perm] of Object.entries(want.teams || {})) {
    if (l.teams[t] !== perm) {
      add(name, l.teams[t] ? `teamet \`${t}\` har \`${l.teams[t]}\`, skal ha \`${perm}\`` : `teamet \`${t}\` har ikke tilgang (skal ha \`${perm}\`)`, "change",
        [{ method: "PUT", path: `/orgs/${org}/teams/${t}/repos/${org}/${name}`, body: { permission: perm } }]);
    }
  }
  for (const t of Object.keys(l.teams)) if (!want.teams?.[t]) add(name, `teamet \`${t}\` har \`${l.teams[t]}\`, men står ikke i fila`, "manual");
  if (want.collaborators && l.collaborators) {
    for (const [u, role] of Object.entries(l.collaborators || {})) {
      if (want.collaborators[u] !== role) add(name, `\`${u}\` har \`${role}\` som enkeltperson; tilgang gis til et team`, "manual");
    }
    for (const [u, role] of Object.entries(want.collaborators)) {
      if (!l.collaborators?.[u]) add(name, `\`${u}\` skal ha \`${role}\`, men har ikke tilgang`, "manual");
    }
  }

  if (l.rulesets) diffRulesets(add, name, want.rulesets, l.rulesets, `${p}/rulesets`);
  else if (l._effectiveRules) {
    // Bare de reglene som gjelder for standardbranchen kan sees: sjekk at typene og de påkrevde sjekkene finnes.
    for (const [rsName, rs] of Object.entries(want.rulesets || {})) {
      if (rs.enforcement !== "active") continue;
      const what = [];
      for (const [type, params] of Object.entries(rs.rules || {})) {
        if (params === false) continue;
        if (!l._effectiveRules.types.includes(type)) what.push(`mangler regelen \`${type}\``);
        if (type === "required_status_checks") {
          for (const c of checkList(params.required_status_checks).map((x) => x.context ?? x)) {
            if (!l._effectiveRules.checks.includes(c)) what.push(`\`${c}\` er ikke påkrevd sjekk`);
          }
        }
      }
      if (what.length) add(name, what.map((w) => `regelsettet «${rsName}»: ${w}`), "change");
    }
  }
  if (l.environments) diffEnvironments(add, name, p, want.environments, l.environments);
  diffVariables(add, name, want.variables, l.variables, `${p}/actions/variables`);
  diffSecretNames(add, name, want.secrets, l.secrets, `gh secret set NAVN --repo ${org}/${name}`);
  diffSecretNames(add, name, want.dependabot_secrets, l.dependabot_secrets, `gh secret set NAVN --repo ${org}/${name} --app dependabot`, "Dependabot-");
  if ("pages" in want && l.pages !== undefined) diffPages(add, name, p, want.pages, l.pages);
}

const norm = (v) => (v === "" ? null : v);
const onOff = (v) => (v ? "på" : "av");
const LABELS = {
  secret_scanning: "secret scanning",
  secret_scanning_push_protection: "push protection",
  dependabot_security_updates: "Dependabot-sikkerhetsoppdateringer",
  vulnerability_alerts: "Dependabot-varsler",
  private_vulnerability_reporting: "privat rapportering av sårbarheter",
};
const label = (k) => LABELS[k] || k;

// Regelsett i API-formatet. Unntak og sjekker får id-er fra plassholdere som slås opp når kallet kjøres.
export function rulesetBody(name, rs) {
  return {
    name,
    target: rs.target,
    enforcement: rs.enforcement,
    conditions: rs.conditions,
    bypass_actors: (rs.bypass_actors || []).map(bypassBody),
    rules: Object.entries(rs.rules).map(([type, params]) => {
      if (type === "required_status_checks") params = { ...params, required_status_checks: checkList(params.required_status_checks) };
      return isObj(params) && Object.keys(params).length ? { type, parameters: params } : { type };
    }),
  };
}

function bypassBody(a) {
  const mode = a.mode;
  if ("role" in a) return { actor_id: REPO_ROLES[a.role], actor_type: "RepositoryRole", bypass_mode: mode };
  if ("app" in a) return { actor_id: `\${app:${a.app}}`, actor_type: "Integration", bypass_mode: mode };
  if ("team" in a) return { actor_id: `\${team:${a.team}}`, actor_type: "Team", bypass_mode: mode };
  if ("org_admin" in a) return { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: mode };
  return { actor_id: null, actor_type: "DeployKey", bypass_mode: mode };
}

const checkList = (checks) => (checks || []).map((c) => (typeof c === "string" ? { context: c, integration_id: ACTIONS_INTEGRATION_ID } : c));
const checkKey = (c) => `${c.context}${c.integration_id === ACTIONS_INTEGRATION_ID ? "" : ` (${c.integration_id ?? "alle"})`}`;
const bypassKey = (a) => {
  const k = Object.keys(a).find((x) => x !== "mode");
  return `${k}:${a[k] === true ? "" : a[k]}/${a.mode}`.replace(":/", "/");
};

export function compareRuleset(want, l) {
  const what = [];
  for (const k of ["target", "enforcement"]) if (want[k] !== l[k]) what.push(`\`${k}\` er ${fmt(l[k])}, skal være ${fmt(want[k])}`);
  if (!same(want.conditions, l.conditions)) what.push(`betingelsene er ${fmt(l.conditions)}, skal være ${fmt(want.conditions)}`);
  if (l.bypass_actors) {
    const w = sortStrings((want.bypass_actors || []).map(bypassKey));
    const h = sortStrings(l.bypass_actors.map(bypassKey));
    if (!same(w, h)) what.push(`unntakene er ${fmt(h.join(", ") || "ingen")}, skal være ${fmt(w.join(", ") || "ingen")}`);
  }
  for (const [type, params] of Object.entries(want.rules)) {
    if (!(type in l.rules)) { what.push(`mangler regelen \`${type}\``); continue; }
    const lp = l.rules[type] || {};
    for (const [k, v] of Object.entries(isObj(params) ? params : {})) {
      if (type === "required_status_checks" && k === "required_status_checks") {
        const w = new Set(checkList(v).map(checkKey));
        const h = new Set(checkList(lp[k]).map(checkKey));
        for (const c of w) if (!h.has(c)) what.push(`\`${c}\` er ikke påkrevd sjekk`);
        for (const c of h) if (!w.has(c)) what.push(`\`${c}\` er påkrevd sjekk, men står ikke i fila`);
      } else if (k === "allowed_merge_methods" ? !same(sortStrings(v), sortStrings(lp[k] || [])) : !same(v, lp[k])) {
        what.push(`\`${type}.${k}\` er ${fmt(lp[k])}, skal være ${fmt(v)}`);
      }
    }
  }
  for (const type of Object.keys(l.rules)) if (!(type in want.rules)) what.push(`har regelen \`${type}\`, som ikke står i fila`);
  return what;
}

function diffRulesets(add, where, want, live, base) {
  for (const [name, rs] of Object.entries(want || {})) {
    const l = live[name];
    if (!l) { add(where, `regelsettet «${name}» finnes ikke`, "change", [{ method: "POST", path: base, body: rulesetBody(name, rs) }]); continue; }
    const what = compareRuleset(rs, l).map((w) => `regelsettet «${name}»: ${w}`);
    if (what.length) add(where, what, "change", [{ method: "PUT", path: `${base}/${l._id}`, body: rulesetBody(name, rs) }]);
  }
  for (const [name, l] of Object.entries(live)) {
    if (!want?.[name]) add(where, `regelsettet «${name}» står ikke i fila`, "prune", [{ method: "DELETE", path: `${base}/${l._id}` }]);
  }
}

function envBody(env) {
  const b = { wait_timer: env.wait_timer ?? 0, can_admins_bypass: env.can_admins_bypass ?? true };
  if (env.reviewers?.length) {
    b.reviewers = env.reviewers.map((r) => (r.team ? { type: "Team", id: `\${team:${r.team}}` } : { type: "User", id: `\${user:${r.user}}` }));
    b.prevent_self_review = env.prevent_self_review ?? false;
  } else if (env._hadReviewers) b.reviewers = [];
  b.deployment_branch_policy = env.branches === null
    ? null
    : env.branches === "protected"
      ? { protected_branches: true, custom_branch_policies: false }
      : { protected_branches: false, custom_branch_policies: true };
  return b;
}

const branchPolicyBody = (b) => (b.startsWith("tag:") ? { name: b.slice(4), type: "tag" } : { name: b, type: "branch" });

function diffEnvironments(add, name, p, want, live) {
  for (const [envName, env] of Object.entries(want || {})) {
    const ep = `${p}/environments/${encodeURIComponent(envName)}`;
    const l = live[envName];
    const where = `${name}, miljøet ${envName}`;
    if (!l) {
      const calls = [{ method: "PUT", path: ep, body: envBody(env) }];
      if (Array.isArray(env.branches)) for (const b of env.branches) calls.push({ method: "POST", path: `${ep}/deployment-branch-policies`, body: branchPolicyBody(b) });
      for (const [k, v] of Object.entries(env.variables || {})) calls.push({ method: "POST", path: `${ep}/variables`, body: { name: k, value: v } });
      add(where, "miljøet finnes ikke", "change", calls);
      diffSecretNames(add, where, env.secrets, [], `gh secret set NAVN --repo ${p.slice(7)} --env ${envName}`);
      continue;
    }
    const what = [];
    for (const k of ["can_admins_bypass", "wait_timer"]) if (k in env && !same(env[k], l[k])) what.push(`\`${k}\` er ${fmt(l[k])}, skal være ${fmt(env[k])}`);
    const wr = sortStrings((env.reviewers || []).map((r) => (r.team ? `team:${r.team}` : `user:${r.user}`)));
    const lr = sortStrings((l.reviewers || []).map((r) => (r.team ? `team:${r.team}` : `user:${r.user}`)));
    if (!same(wr, lr)) what.push(`godkjennerne er ${fmt(lr.join(", ") || "ingen")}, skal være ${fmt(wr.join(", ") || "ingen")}`);
    if (wr.length && "prevent_self_review" in env && env.prevent_self_review !== l.prevent_self_review) {
      what.push(`\`prevent_self_review\` er ${fmt(l.prevent_self_review)}, skal være ${fmt(env.prevent_self_review)}`);
    }
    const wantKind = env.branches === null ? "alle" : env.branches === "protected" ? "protected" : "custom";
    const liveKind = l.branches === null ? "alle" : l.branches === "protected" ? "protected" : l.branches === undefined ? undefined : "custom";
    if (liveKind !== undefined && wantKind !== liveKind) what.push(`branch-regelen er ${fmt(liveKind)}, skal være ${fmt(wantKind)}`);
    if (what.length) add(where, what, "change", [{ method: "PUT", path: ep, body: envBody({ ...env, _hadReviewers: lr.length > 0 }) }]);
    if (Array.isArray(env.branches) && (Array.isArray(l.branches) || liveKind !== "custom")) {
      const have = Array.isArray(l.branches) && liveKind === wantKind ? l.branches : [];
      const missing = env.branches.filter((b) => !have.includes(b));
      if (missing.length) add(where, missing.map((b) => `branchen \`${b}\` er ikke tillatt`), "change",
        missing.map((b) => ({ method: "POST", path: `${ep}/deployment-branch-policies`, body: branchPolicyBody(b) })));
      for (const b of have.filter((x) => !env.branches.includes(x))) {
        add(where, `branchen \`${b}\` er tillatt, men står ikke i fila`, "prune",
          [{ method: "DELETE", path: `${ep}/deployment-branch-policies/${l._branch_policy_ids?.[b]}` }]);
      }
    }
    diffVariables(add, where, env.variables, l.variables, `${ep}/variables`);
    diffSecretNames(add, where, env.secrets, l.secrets, `gh secret set NAVN --repo ${p.slice(7)} --env ${envName}`);
  }
  for (const envName of Object.keys(live)) {
    if (!want?.[envName]) add(`${name}, miljøet ${envName}`, "miljøet står ikke i fila", "prune",
      [{ method: "DELETE", path: `${p}/environments/${encodeURIComponent(envName)}` }]);
  }
}

function diffVariables(add, where, want, live, base, extra = {}) {
  if (want === undefined || live === undefined) return;
  for (const [k, v] of Object.entries(want)) {
    if (!(k in live)) add(where, `variabelen \`${k}\` mangler`, "change", [{ method: "POST", path: base, body: { name: k, value: v, ...extra } }]);
    else if (live[k] !== v) add(where, `variabelen \`${k}\` er ${fmt(live[k])}, skal være ${fmt(v)}`, "change", [{ method: "PATCH", path: `${base}/${k}`, body: { name: k, value: v, ...extra } }]);
  }
  for (const k of Object.keys(live)) if (!(k in want)) add(where, `variabelen \`${k}\` står ikke i fila`, "prune", [{ method: "DELETE", path: `${base}/${k}` }]);
}

function diffSecretNames(add, where, want, live, cmd, prefix = "") {
  if (want === undefined || live === undefined) return;
  for (const s of want) if (!live.includes(s)) add(where, `${prefix}hemmeligheten \`${s}\` mangler (\`${cmd.replace("NAVN", s)}\`)`, "manual");
  for (const s of live) if (!want.includes(s)) add(where, `${prefix}hemmeligheten \`${s}\` står ikke i fila`, "manual");
}

function diffPages(add, name, p, want, l) {
  if (!want) {
    if (l) add(name, "Pages er slått på, men står ikke i fila", "manual");
    return;
  }
  const body = { build_type: want.build_type, ...(want.source ? { source: want.source } : {}) };
  if (!l) {
    add(name, "Pages er ikke slått på", "change", [
      { method: "POST", path: `${p}/pages`, body },
      { method: "PUT", path: `${p}/pages`, body: { ...body, cname: want.cname ?? null, https_enforced: want.https_enforced } },
    ]);
    return;
  }
  const ks = Object.keys(want).filter((k) => !same(want[k], l[k]));
  if (ks.length) add(name, ks.map((k) => `Pages: \`${k}\` er ${fmt(l[k])}, skal være ${fmt(want[k])}`), "change",
    [{ method: "PUT", path: `${p}/pages`, body: { ...body, cname: want.cname ?? null, https_enforced: want.https_enforced } }]);
}

// ---------------------------------------------------------------------------------------------------------------
// Utføring

// Bytter ut "${team:slug}", "${app:slug}", "${user:login}", "${repoId:navn}" og "${codeSecurityConfig:navn}" med id-er.
// En verdi som bare er en plassholder blir et tall; i stier settes id-en inn i teksten.
export async function resolvePlaceholders(value, lookup) {
  if (typeof value === "string") {
    const whole = value.match(/^\$\{(\w+):([^}]+)\}$/);
    if (whole) return lookup(whole[1], whole[2]);
    let out = value;
    for (const m of value.matchAll(/\$\{(\w+):([^}]+)\}/g)) out = out.replace(m[0], String(await lookup(m[1], m[2])));
    return out;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolvePlaceholders(v, lookup)));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolvePlaceholders(v, lookup);
    return out;
  }
  return value;
}

export function makeLookup(api, org, ids) {
  const cache = { app: { ...ids.apps }, team: { ...ids.teams }, repoId: { ...ids.repos }, codeSecurityConfig: { ...ids.codeSecurityConfigs }, user: {} };
  return async (kind, key) => {
    if (cache[kind]?.[key] !== undefined) return cache[kind][key];
    let id;
    if (kind === "app") id = (await api.get(`/apps/${key}`)).id;
    else if (kind === "team") id = (await api.get(`/orgs/${org}/teams/${key}`)).id;
    else if (kind === "user") id = (await api.get(`/users/${key}`)).id;
    else if (kind === "repoId") id = (await api.get(`/repos/${org}/${key}`)).id;
    else if (kind === "codeSecurityConfig") {
      const list = await api.get(`/orgs/${org}/code-security/configurations?per_page=100`);
      id = list.find((c) => c.name === key)?.id;
    }
    if (id === undefined) throw new Error(`fant ikke ${kind} «${key}»`);
    (cache[kind] ||= {})[key] = id;
    return id;
  };
}

// Statiske manuelle steg fra fila: org.manual og manual i hvert repo.
export function manualSteps(config) {
  const out = (config.org.manual || []).map((m) => ({ where: "organisasjonen", what: m }));
  for (const name of Object.keys(config.repos)) for (const m of expandRepo(config, name).manual || []) out.push({ where: name, what: m });
  return out;
}

// Skriver endringene som Markdown-tabell (for auditen).
export function toTable(changes) {
  const esc = (s) => s.replace(/\|/g, "\\|");
  const rows = changes.flatMap((c) => c.what.map((w) => `| ${esc(c.where)} | ${esc(w)} |`));
  return `| Hvor | Avvik |\n|---|---|\n${rows.join("\n")}`;
}
