// Tester for sammenligningen i github-state.mjs, uten nettverk: node --test scripts/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ACTIONS_INTEGRATION_ID, diff, expandRepo, manualSteps, resolvePlaceholders, rulesetBody, toTable, validateConfig,
} from "./github-state.mjs";

const IDS = { apps: { "pages-cms": 866529 }, teams: { maintainers: 7 }, repos: { web: 11, ops: 12 }, codeSecurityConfigs: {} };

function fixtureConfig() {
  return {
    org: {
      login: "acme",
      settings: { default_repository_permission: "read", members_can_create_repositories: false },
      check_only: { two_factor_requirement_enabled: true },
      actions: { enabled_repositories: "all", allowed_actions: "all", sha_pinning_required: true },
      workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
      teams: { maintainers: { description: "Vedlikeholdere", privacy: "closed", min_members: 1 } },
      variables: {},
      secrets: [],
      dependabot_secrets: [],
      rulesets: {},
      manual: ["Tofaktor slås på i nettleseren."],
    },
    defaults: {
      all: {
        settings: { allow_auto_merge: true, delete_branch_on_merge: true, homepage: null },
        actions: { enabled: true, allowed_actions: "all", sha_pinning_required: true },
        workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
        teams: { maintainers: "admin" },
        collaborators: {},
        variables: {},
        secrets: [],
        dependabot_secrets: [],
        environments: {},
        pages: null,
      },
      public: {
        security: { vulnerability_alerts: true, secret_scanning: true, private_vulnerability_reporting: true },
        rulesets: { "Main protection": { extends: "main" } },
      },
      private: {
        security: { vulnerability_alerts: true, secret_scanning: false },
        rulesets: { "Main protection": { extends: "main", rules: { code_scanning: false } } },
      },
      environment: { branches: ["main"], reviewers: [], can_admins_bypass: true, wait_timer: 0, variables: {}, secrets: [] },
    },
    rulesets: {
      main: {
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        bypass_actors: [{ role: "admin", mode: "pull_request" }],
        rules: {
          deletion: {},
          pull_request: { required_approving_review_count: 0, allowed_merge_methods: ["merge", "squash", "rebase"] },
          required_status_checks: { strict_required_status_checks_policy: false, required_status_checks: ["workflow-security"] },
          code_scanning: { code_scanning_tools: [{ tool: "CodeQL", security_alerts_threshold: "high_or_higher", alerts_threshold: "errors" }] },
        },
      },
    },
    repos: {
      web: {
        visibility: "public",
        settings: { description: "Nettstedet" },
        rulesets: {
          "Main protection": {
            extends: "main",
            bypass_actors: [{ role: "admin", mode: "pull_request" }, { app: "pages-cms", mode: "always" }],
            rules: { required_status_checks: { required_status_checks: ["workflow-security", "build"] } },
          },
        },
        environments: {
          production: { variables: { SITE_KEY: "abc" }, secrets: ["API_TOKEN"] },
          recovery: { reviewers: [{ team: "maintainers" }], prevent_self_review: false },
        },
        pages: { build_type: "workflow", cname: "www.example.org", https_enforced: true },
      },
      ops: {
        visibility: "private",
        settings: { description: "Drift", delete_branch_on_merge: false },
        variables: { ENABLED: "true" },
        secrets: ["READ_TOKEN"],
      },
    },
  };
}

// Lager «dagens tilstand» som stemmer nøyaktig med fila, slik readLive() ville lest den.
function liveFrom(config) {
  const live = {
    org: {
      settings: { ...config.org.settings },
      check_only: { ...config.org.check_only },
      actions: { ...config.org.actions },
      workflow: { ...config.org.workflow },
      teams: Object.fromEntries(Object.entries(config.org.teams).map(([s, t]) => [s, { description: t.description, privacy: t.privacy, _members: 1 }])),
      variables: {},
      secrets: [],
      dependabot_secrets: [],
      rulesets: {},
    },
    repos: {},
    ids: structuredClone(IDS),
    unmanagedRepos: [],
    notes: [],
  };
  let id = 100;
  for (const name of Object.keys(config.repos)) {
    const w = expandRepo(config, name);
    live.repos[name] = {
      visibility: w.visibility,
      settings: { ...w.settings, homepage: null, extra_field_not_managed: 1 },
      security: { ...w.security },
      actions: { ...w.actions },
      workflow: { ...w.workflow },
      teams: { ...w.teams },
      collaborators: {},
      rulesets: Object.fromEntries(Object.entries(w.rulesets).map(([n, rs]) => {
        const body = rulesetBody(n, rs);
        const rules = Object.fromEntries(body.rules.map((r) => [r.type, {
          ...r.parameters,
          ...(r.type === "pull_request" ? { required_reviewers: [], require_extra_approval_for_unattributed_changes: true } : {}),
          ...(r.type === "required_status_checks" ? { required_status_checks: [...r.parameters.required_status_checks].reverse() } : {}),
        }]));
        return [n, { _id: id++, target: rs.target, enforcement: rs.enforcement, conditions: rs.conditions, bypass_actors: rs.bypass_actors, rules }];
      })),
      environments: Object.fromEntries(Object.entries(w.environments).map(([n, e]) => [n, {
        ...e,
        ...(e.reviewers.length ? {} : { prevent_self_review: undefined }),
        _branch_policy_ids: { main: id++ },
      }])),
      variables: { ...w.variables },
      secrets: [...w.secrets],
      dependabot_secrets: [...w.dependabot_secrets],
      pages: w.pages && { ...w.pages },
    };
    for (const e of Object.values(live.repos[name].environments)) if (e.prevent_self_review === undefined) delete e.prevent_self_review;
  }
  return live;
}

const only = (changes, kind) => changes.filter((c) => c.kind === kind);

test("ingen endringer når dagens tilstand stemmer med fila", () => {
  const config = fixtureConfig();
  assert.deepEqual(diff(config, liveFrom(config)), []);
});

test("github.json i repoet er gyldig, og standardverdiene slås sammen riktig", () => {
  const config = JSON.parse(readFileSync(new URL("../github.json", import.meta.url), "utf8"));
  assert.deepEqual(validateConfig(config), []);
  const ops = expandRepo(config, "operations").rulesets["Main protection"];
  assert.ok(ops.rules.code_scanning);
  assert.deepEqual(ops.rules.required_status_checks.required_status_checks, ["validate", "dependency-review", "workflow-security"]);
  assert.deepEqual(expandRepo(config, "operations").environments.audit.branches, ["main"]);
  const web = expandRepo(config, "hofstadnet-web");
  assert.equal(web.rulesets["Main protection"].rules.required_status_checks.strict_required_status_checks_policy, true);
  assert.equal(web.rulesets["Main protection"].rules.pull_request.dismiss_stale_reviews_on_push, false);
  assert.deepEqual(web.environments.cloudflare.reviewers, [{ team: "maintainers" }]);
  assert.equal(web.security.private_vulnerability_reporting, true);
  assert.equal(web.security.code_security_configuration, "hofstadnet-org-config-1");
  const status = expandRepo(config, "status").rulesets["Main protection"];
  assert.deepEqual(Object.keys(status.rules), ["deletion", "non_fast_forward", "required_signatures", "pull_request", "required_status_checks", "code_scanning"]);
  assert.deepEqual(status.bypass_actors, [{ role: "admin", mode: "pull_request" }, { app: "hofstadnet-status", mode: "always" }]);
  assert.ok(web.environments.cloudflare.secrets.includes("CLOUDFLARE_API_TOKEN"));
  assert.ok(!web.environments["tofu-plan"].secrets.includes("CLOUDFLARE_API_TOKEN"));
  assert.deepEqual(web.environments["tofu-plan"].branches, ["main"]);
  assert.deepEqual(web.secrets, []);
  const dotgithub = expandRepo(config, ".github").rulesets["Main protection"];
  assert.deepEqual(dotgithub.rules.required_status_checks.required_status_checks, ["dependency-review", "workflow-security"]);
  assert.ok(dotgithub.rules.code_scanning);
});

test("sikkerhetsoppsettet i organisasjonen: avvik og ukjente oppsett er manuelle", () => {
  const config = fixtureConfig();
  config.org.code_security_configurations = { "org-config": { secret_scanning: "enabled", enforcement: "enforced", default_for_new_repos: "all" } };
  const live = liveFrom(config);
  live.org.code_security_configurations = {
    "org-config": { secret_scanning: "disabled", enforcement: "enforced", default_for_new_repos: "all" },
    annet: { secret_scanning: "enabled", enforcement: "unenforced", default_for_new_repos: "none" },
  };
  const changes = diff(config, live);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.kind === "manual" && !c.calls.length));
  assert.match(changes[0].what[0], /secret_scanning/);
  assert.match(changes[1].where, /annet/);
  config.org.code_security_configurations["org-config"].default_for_new_repos = "alle";
  assert.ok(validateConfig(config).some((e) => e.includes("default_for_new_repos")));
});

test("en endret innstilling gir én PATCH med bare det som avviker", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.web.settings.allow_auto_merge = false;
  live.repos.web.settings.delete_branch_on_merge = false;
  const [c, ...rest] = diff(config, live);
  assert.equal(rest.length, 0);
  assert.equal(c.kind, "change");
  assert.equal(c.where, "web");
  assert.equal(c.what.length, 2);
  assert.deepEqual(c.calls, [{ method: "PATCH", path: "/repos/acme/web", body: { allow_auto_merge: true, delete_branch_on_merge: true } }]);
});

test("tom og manglende homepage regnes som like", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.web.settings.homepage = "";
  assert.deepEqual(diff(config, live), []);
});

test("en manglende påkrevd sjekk oppdaterer hele regelsettet, med Actions som kilde og appen som plassholder", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  const rs = live.repos.web.rulesets["Main protection"];
  rs.rules.required_status_checks.required_status_checks = [{ context: "workflow-security", integration_id: ACTIONS_INTEGRATION_ID }];
  const changes = diff(config, live);
  assert.equal(changes.length, 1);
  assert.match(changes[0].what[0], /`build` er ikke påkrevd sjekk/);
  const call = changes[0].calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.path, `/repos/acme/web/rulesets/${rs._id}`);
  const checks = call.body.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks;
  assert.deepEqual(checks, [{ context: "workflow-security", integration_id: 15368 }, { context: "build", integration_id: 15368 }]);
  assert.deepEqual(call.body.bypass_actors, [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
    { actor_id: "${app:pages-cms}", actor_type: "Integration", bypass_mode: "always" },
  ]);
});

test("strict, unntak og regler som mangler eller er i tillegg, meldes", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  const rs = live.repos.web.rulesets["Main protection"];
  rs.rules.required_status_checks.strict_required_status_checks_policy = true;
  rs.bypass_actors = [{ role: "admin", mode: "pull_request" }];
  delete rs.rules.code_scanning;
  rs.rules.creation = {};
  const what = diff(config, live)[0].what.join("\n");
  assert.match(what, /strict_required_status_checks_policy` er `true`, skal være `false`/);
  assert.match(what, /unntakene er `role:admin\/pull_request`, skal være `app:pages-cms\/always, role:admin\/pull_request`/);
  assert.match(what, /mangler regelen `code_scanning`/);
  assert.match(what, /har regelen `creation`/);
});

test("unntak som ikke kunne leses, sammenlignes ikke", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  delete live.repos.web.rulesets["Main protection"].bypass_actors;
  assert.deepEqual(diff(config, live), []);
});

test("et manglende regelsett opprettes, og et ekstra slettes bare med --prune", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.ops.rulesets = { Gammelt: { _id: 9, target: "branch", enforcement: "active", conditions: {}, rules: {} } };
  const changes = diff(config, live);
  const create = only(changes, "change")[0];
  assert.equal(create.calls[0].method, "POST");
  assert.equal(create.calls[0].body.name, "Main protection");
  assert.equal(create.calls[0].body.rules.some((r) => r.type === "code_scanning"), false);
  assert.deepEqual(only(changes, "prune")[0].calls, [{ method: "DELETE", path: "/repos/acme/ops/rulesets/9" }]);
});

test("hemmeligheter meldes bare som manuelle steg, uten API-kall", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.ops.secrets = ["OLD_TOKEN"];
  live.repos.web.environments.production.secrets = [];
  const changes = diff(config, live);
  assert.equal(changes.length, 3);
  for (const c of changes) {
    assert.equal(c.kind, "manual");
    assert.deepEqual(c.calls, []);
  }
  assert.match(changes.map((c) => c.what[0]).join("\n"), /gh secret set API_TOKEN --repo acme\/web --env production/);
});

test("et manglende miljø opprettes med branch-regel, godkjennere og variabler", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  delete live.repos.web.environments.recovery;
  delete live.repos.web.environments.production;
  const changes = only(diff(config, live), "change");
  const rec = changes.find((c) => c.where === "web, miljøet recovery");
  assert.deepEqual(rec.calls[0], {
    method: "PUT",
    path: "/repos/acme/web/environments/recovery",
    body: {
      wait_timer: 0,
      can_admins_bypass: true,
      reviewers: [{ type: "Team", id: "${team:maintainers}" }],
      prevent_self_review: false,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
  });
  assert.deepEqual(rec.calls[1], { method: "POST", path: "/repos/acme/web/environments/recovery/deployment-branch-policies", body: { name: "main", type: "branch" } });
  const prod = changes.find((c) => c.where === "web, miljøet production");
  assert.deepEqual(prod.calls.at(-1), { method: "POST", path: "/repos/acme/web/environments/production/variables", body: { name: "SITE_KEY", value: "abc" } });
});

test("endrede godkjennere og en ekstra branch i et miljø", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.web.environments.recovery.reviewers = [];
  live.repos.web.environments.production.branches = ["dev", "main"];
  live.repos.web.environments.production._branch_policy_ids.dev = 55;
  const changes = diff(config, live);
  const rec = changes.find((c) => c.where === "web, miljøet recovery");
  assert.equal(rec.kind, "change");
  assert.match(rec.what[0], /godkjennerne er `ingen`, skal være `team:maintainers`/);
  const extra = changes.find((c) => c.kind === "prune");
  assert.deepEqual(extra.calls, [{ method: "DELETE", path: "/repos/acme/web/environments/production/deployment-branch-policies/55" }]);
});

test("variabler: ny, endret og ekstra", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.ops.variables = { ENABLED: "false", OTHER: "x" };
  live.repos.web.environments.production.variables = {};
  const changes = diff(config, live);
  const calls = changes.flatMap((c) => c.calls.map((x) => `${c.kind} ${x.method} ${x.path}`));
  assert.deepEqual(calls.sort(), [
    "change PATCH /repos/acme/ops/actions/variables/ENABLED",
    "change POST /repos/acme/web/environments/production/variables",
    "prune DELETE /repos/acme/ops/actions/variables/OTHER",
  ]);
});

test("synlighet, nye repoer og repoer som mangler, er manuelle", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.ops.visibility = "public";
  live.unmanagedRepos.push({ name: "nytt", visibility: "private" });
  delete live.repos.web;
  const changes = diff(config, live);
  assert.deepEqual(changes.map((c) => c.kind), ["manual", "manual", "manual"]);
  assert.match(toTable(changes), /\| nytt \| nytt repo som ikke står i github.json \(private\) \|/);
  assert.match(toTable(changes), /\| web \| står i github.json, men finnes ikke/);
  assert.match(toTable(changes), /synlighet er `public`, skal være `private`/);
});

test("organisasjonen: innstillinger, tofaktor, team uten medlemmer og et team som mangler", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.org.settings.members_can_create_repositories = true;
  live.org.check_only.two_factor_requirement_enabled = false;
  live.org.workflow.default_workflow_permissions = "write";
  live.org.teams.maintainers._members = 0;
  const changes = diff(config, live);
  assert.deepEqual(changes.map((c) => [c.kind, c.calls.map((x) => `${x.method} ${x.path}`)]), [
    ["change", ["PATCH /orgs/acme"]],
    ["manual", []],
    ["change", ["PUT /orgs/acme/actions/permissions/workflow"]],
    ["manual", []],
  ]);
  assert.deepEqual(changes[2].calls[0].body, config.org.workflow);

  delete live.org.teams.maintainers;
  const missing = diff(config, live).find((c) => c.where === "team maintainers" && c.kind === "change");
  assert.deepEqual(missing.calls[0].body, { name: "maintainers", description: "Vedlikeholdere", privacy: "closed" });
});

test("sikkerhet: av/på gir riktige kall", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.web.security.secret_scanning = false;
  live.repos.web.security.vulnerability_alerts = false;
  const calls = diff(config, live).flatMap((c) => c.calls);
  assert.deepEqual(calls, [
    { method: "PATCH", path: "/repos/acme/web", body: { security_and_analysis: { secret_scanning: { status: "enabled" } } } },
    { method: "PUT", path: "/repos/acme/web/vulnerability-alerts" },
  ]);
});

test("team-tilgang og enkeltpersoner", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.web.teams.maintainers = "push";
  live.repos.web.collaborators = { someone: "write" };
  const changes = diff(config, live);
  assert.deepEqual(changes[0].calls, [{ method: "PUT", path: "/orgs/acme/teams/maintainers/repos/acme/web", body: { permission: "admin" } }]);
  assert.equal(changes[1].kind, "manual");
});

test("Pages: endret domene og Pages som mangler", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  live.repos.web.pages.cname = null;
  assert.deepEqual(diff(config, live)[0].calls, [{
    method: "PUT", path: "/repos/acme/web/pages", body: { build_type: "workflow", cname: "www.example.org", https_enforced: true },
  }]);
  live.repos.web.pages = null;
  assert.deepEqual(diff(config, live)[0].calls.map((c) => c.method), ["POST", "PUT"]);
});

test("deler som ikke kunne leses (undefined), hoppes over", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  for (const r of Object.values(live.repos)) {
    r.secrets = undefined;
    r.variables = undefined;
    r.pages = undefined;
    r.environments = undefined;
    r.rulesets = undefined;
  }
  live.repos.ops.secrets = undefined;
  assert.deepEqual(diff(config, live), []);
});

test("validering finner feil i fila", () => {
  const config = fixtureConfig();
  config.repos.ops.environments = { prod: { reviewers: [{ team: "maintainers" }] } };
  config.repos.ops.security = { private_vulnerability_reporting: true };
  config.repos.web.rulesets["Main protection"].bypass_actors = [{ role: "owner", mode: "always" }];
  config.repos.web.variables = { "lower-case": 1 };
  config.repos.web.environments.production.secrets = ["A", "A"];
  config.repos.bad = { visibility: "internal" };
  const errors = validateConfig(config).join("\n");
  assert.match(errors, /ops, miljøet prod: påkrevd godkjenning i miljøer krever et offentlig repo/);
  assert.match(errors, /privat rapportering av sårbarheter finnes ikke for private repoer/);
  assert.match(errors, /ukjent rolle owner/);
  assert.match(errors, /variabelnavnet lower-case er ugyldig/);
  assert.match(errors, /verdien til lower-case må være tekst/);
  assert.match(errors, /samme navn står flere ganger/);
  assert.match(errors, /bad: «visibility» må være public eller private/);
  assert.deepEqual(validateConfig(fixtureConfig()), []);
});

test("plassholdere slås opp til id-er", async () => {
  const lookup = async (kind, key) => ({ app: { "pages-cms": 866529 }, codeSecurityConfig: { "GitHub recommended": 17 } })[kind][key];
  assert.equal(await resolvePlaceholders("/orgs/acme/code-security/configurations/${codeSecurityConfig:GitHub recommended}/attach", lookup),
    "/orgs/acme/code-security/configurations/17/attach");
  assert.deepEqual(await resolvePlaceholders({ bypass_actors: [{ actor_id: "${app:pages-cms}" }], n: 1 }, lookup),
    { bypass_actors: [{ actor_id: 866529 }], n: 1 });
});

test("manuelle steg samles fra organisasjonen og repoene", () => {
  const config = fixtureConfig();
  config.repos.web.manual = ["Appen må ha tilgang."];
  assert.deepEqual(manualSteps(config), [
    { where: "organisasjonen", what: "Tofaktor slås på i nettleseren." },
    { where: "web", what: "Appen må ha tilgang." },
  ]);
});

test("innstillinger som mangler i svaret (lesetilgang), kontrolleres ikke", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  for (const r of Object.values(live.repos)) r.settings = { homepage: null };
  assert.deepEqual(diff(config, live), []);
});

test("uten regelsettene kontrolleres reglene for standardbranchen", () => {
  const config = fixtureConfig();
  const live = liveFrom(config);
  for (const [name, r] of Object.entries(live.repos)) {
    const w = expandRepo(config, name);
    const rules = Object.values(w.rulesets).filter((rs) => rs.enforcement === "active").flatMap((rs) => Object.entries(rs.rules).filter(([, v]) => v !== false));
    r._effectiveRules = {
      types: rules.map(([t]) => t),
      checks: rules.filter(([t]) => t === "required_status_checks").flatMap(([, p]) => p.required_status_checks.map((c) => c.context ?? c)),
    };
    r.rulesets = undefined;
  }
  assert.deepEqual(diff(config, live), []);
  const name = Object.keys(live.repos).find((n) => live.repos[n]._effectiveRules.checks.length);
  live.repos[name]._effectiveRules.checks.pop();
  const found = diff(config, live).filter((c) => c.where === name);
  assert.equal(found.length, 1);
  assert.match(found[0].what[0], /er ikke påkrevd sjekk/);
  assert.deepEqual(found[0].calls, []);
});
