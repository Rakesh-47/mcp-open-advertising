// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
//
// Fleet inventory completeness: every place that lists the servers by hand
// must list exactly the servers in registry.json.
//
// registry.json is what manifests, server.json, the runtime tool checks and the
// server card read. Those checks cannot see a server that is missing from some
// OTHER list. Before this check, leaving a new server out of `publish-all.sh`
// meant it was never released, leaving it out of `cloudbuild.yaml` meant it was
// never built or deployed, and leaving it out of the conformance script meant
// CI skipped it. All of that went silently, and two lists had already drifted
// (platform-mapping.md had no MS Ads row; the bug-report auth list named a
// `ttd-headers` mode that never shipped and lacked `gads-headers`).
//
// Each site below is a hand-maintained list. A site whose pattern matches
// nothing is itself a violation, so moving or reformatting a file cannot turn
// its check into a silent pass. The test also runs every site against a
// registry with an extra, fake server, so no site can be vacuous.
//
// Configured sites only prove that the lists they name are complete. CENSUS
// (below) covers the rest of each file where it can: in a file that should
// mention every server equally often, a server mentioned less often is missing
// from some list, configured or not. Files that cannot be censused say why.
//
// These lists should eventually be derived from registry.json instead of
// checked against it; until then, this is what keeps them honest.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SERVER_TOKEN = /\b[a-z0-9]+(?:-[a-z0-9]+)*-mcp\b/g;

/** Server-package tokens in a block of text, in order, deduplicated. */
export function serverTokens(text) {
  return [...new Set(text.match(SERVER_TOKEN) ?? [])];
}

/** Every capture group 1 of `regex` in `text`. */
function captures(text, regex) {
  return [...text.matchAll(regex)].map((m) => m[1]);
}

/** `amazon_dsp_mcp` → `amazon-dsp-mcp` (Terraform identifiers back to package names). */
function hyphenated(name) {
  return name.replaceAll("_", "-");
}

/** `amazon_dsp` (Terraform short service name) → `amazon-dsp-mcp`. */
function fromShort(name) {
  return `${name.replaceAll("_", "-")}-mcp`;
}

/** Entries of a YAML dropdown's `options:` list in the block with `id: <id>`. */
function dropdownOptions(text, id) {
  const start = text.search(new RegExp(`^\\s+id: ${id}\\s*$`, "m"));
  if (start < 0) return null;
  const opts = text.slice(start).match(/options:\n((?:\s+- .+\n)+)/);
  if (!opts) return null;
  return opts[1]
    .split("\n")
    .map((l) => l.replace(/^\s+- /, "").trim())
    .filter(Boolean);
}

/** `SERVERS=(` … `)` arrays written one entry per line. */
function bashServerArrays(text) {
  return captures(text, /^SERVERS=\(\n([\s\S]*?)^\)/gm).map((b) => ({
    where: "SERVERS",
    names: serverTokens(b),
  }));
}

/**
 * A site is a hand-maintained list. `lists(text)` returns one entry per
 * occurrence of the list in the file, `{ where, names, why? }`, and each occurrence
 * must contain exactly the expected names: the registry packages, or
 * `expected(servers)` when a site lists something else.
 */
export const INVENTORY_SITES = [
  {
    file: "scripts/publish-all.sh",
    why: "release never publishes the package to npm or the MCP Registry",
    lists: bashServerArrays,
  },
  {
    file: "scripts/conformance-test.sh",
    why: "CI's conformance job skips the server",
    lists: (t) => [
      ...captures(t, /^\s+SERVERS=\(("[a-z0-9-]+-mcp"[^)]*)\)/gm).map((b) => ({
        where: "default SERVERS",
        names: serverTokens(b),
      })),
      ...captures(t, /get_port\(\) \{\n([\s\S]*?)\n\}/g).map((b) => ({
        where: "get_port case arms",
        names: captures(b, /^\s+([a-z0-9-]+-mcp)\)/gm),
      })),
    ],
  },
  {
    file: "scripts/deploy.sh",
    why: "the manual deploy script never builds or deploys the server",
    lists: bashServerArrays,
  },
  {
    file: "scripts/smoke-test.sh",
    why: "post-deploy smoke tests never probe the server",
    lists: bashServerArrays,
  },
  {
    file: "scripts/dev-server.sh",
    why: "the usage text does not offer the server",
    lists: (t) =>
      captures(t, /Available servers: ([^"]+)"/g).map((b) => ({
        where: "usage text",
        names: serverTokens(b),
      })),
  },
  ...["cloudbuild.yaml", "cloudbuild-manual.yaml"].map((file) => ({
    file,
    why: "Cloud Build never builds, scans, pushes or deploys an image for the server",
    lists: (t) => {
      const images = t.slice(Math.max(0, t.search(/^images:/m)));
      return [
        ...captures(t, /(?<![A-Z_])SERVICES="([^"]+)"/g).map((b, i) => ({
          where: `SERVICES= list #${i + 1}`,
          names: serverTokens(b),
        })),
        ...captures(t, /for SERVICE in ([a-z0-9 -]+); do/g).map((b, i) => ({
          where: `literal for-loop #${i + 1}`,
          names: serverTokens(b),
        })),
        {
          where: "images: ':${SHORT_SHA}' entries",
          names: captures(images, /\/([a-z0-9-]+-mcp):\$\{SHORT_SHA\}'/g),
        },
        {
          where: "images: ':${_ENVIRONMENT}-latest' entries",
          names: captures(images, /\/([a-z0-9-]+-mcp):\$\{_ENVIRONMENT\}-latest'/g),
        },
      ];
    },
  })),
  {
    file: "Dockerfile",
    why: "the image's frozen install cannot resolve the workspace graph",
    lists: (t) => [
      {
        where: "COPY packages/<server>/package.json lines",
        names: captures(t, /^COPY packages\/([a-z0-9-]+-mcp)\/package\.json/gm),
      },
    ],
  },
  {
    file: "terraform/main.tf",
    why: "Terraform never creates, monitors or routes the Cloud Run service",
    lists: (t) => [
      {
        where: 'module "<server>" blocks',
        names: captures(t, /^module "([a-z0-9_]+_mcp)" \{/gm).map(hyphenated),
      },
      ...captures(t, /^\s+services = \[\n([\s\S]*?)^\s+\]/gm).map((b) => ({
        where: "monitoring services list",
        names: captures(b, /name = "([a-z0-9-]+-mcp)"/g),
      })),
      ...captures(t, /fleet_service_names = \[\n([\s\S]*?)^\s+\]/gm).map((b) => ({
        where: "fleet_service_names",
        names: serverTokens(b),
      })),
      ...captures(t, /module "fleet_lb" \{[\s\S]*?depends_on = \[\n([\s\S]*?)^\s+\]/gm).map(
        (b) => ({
          where: "fleet_lb depends_on",
          names: captures(b, /module\.([a-z0-9_]+_mcp),/g).map(hyphenated),
        })
      ),
      {
        where: "<server>_secret_names locals",
        names: captures(t, /^\s+([a-z0-9_]+)_secret_names\s+= distinct/gm).map(fromShort),
      },
      {
        where: "<server>_resources locals (with a matching override key)",
        names: [
          ...t.matchAll(
            /^\s+([a-z0-9_]+)_resources\s+= merge\(.*lookup\(var\.service_resource_overrides, "([a-z0-9-]+-mcp)"/gm
          ),
        ]
          .filter((m) => fromShort(m[1]) === m[2])
          .map((m) => m[2]),
      },
      ...captures(t, /service_auth_defaults = \{\n([\s\S]*?)^\s+\}/gm).map((b) => ({
        where: "service_auth_defaults keys",
        names: captures(b, /^\s+"([a-z0-9-]+-mcp)"\s+=/gm),
      })),
      {
        where: "<server>_auth_mode locals (with a matching key)",
        names: [
          ...t.matchAll(
            /^\s+([a-z0-9_]+)_auth_mode\s+= lookup\(var\.service_auth_mode_overrides, "([a-z0-9-]+-mcp)"/gm
          ),
        ]
          .filter((m) => fromShort(m[1]) === m[2])
          .map((m) => m[2]),
      },
    ],
  },
  {
    file: "terraform/variables.tf",
    why: "Cloud Build's -var=<server>_image has no variable to bind to",
    lists: (t) => [
      {
        where: 'variable "<server>_image"',
        names: captures(t, /^variable "([a-z0-9_]+_mcp)_image" \{/gm).map(hyphenated),
      },
      {
        where: 'variable "<server>_secret_env_vars"',
        why: "the service's secrets have no variable, so main.tf's <server>_secret_names cannot resolve",
        names: captures(t, /^variable "([a-z0-9_]+)_secret_env_vars" \{/gm).map(fromShort),
      },
    ],
  },
  ...["dev", "prod"].map((env) => ({
    file: `terraform/${env}.tfvars.example`,
    why: "the example tfvars a deployer copies has no image for the server",
    lists: (t) => [
      {
        where: "<server>_mcp_image entries",
        names: captures(t, /^([a-z0-9_]+_mcp)_image\s+=/gm).map(hyphenated),
      },
    ],
  })),
  {
    file: "terraform/outputs.tf",
    why: "the service URL is never exported",
    lists: (t) => [
      {
        where: 'output "<server>_service_url"',
        names: captures(t, /^output "([a-z0-9_]+_mcp)_service_url" \{/gm).map(hyphenated),
      },
    ],
  },
  ...["bug_report.yml", "feature_request.yml", "new_tool_proposal.yml"].map((name) => ({
    file: `.github/ISSUE_TEMPLATE/${name}`,
    why: "reporters cannot pick the server",
    lists: (t) => {
      const options = dropdownOptions(t, "server");
      return options
        ? [{ where: "server dropdown", names: options.flatMap((o) => serverTokens(o)) }]
        : [];
    },
  })),
  {
    file: ".github/ISSUE_TEMPLATE/bug_report.yml",
    why: "reporters cannot pick the auth mode they are using",
    expected: (servers) => [...new Set(servers.flatMap((s) => s.auth?.modes ?? []))],
    lists: (t) => {
      const options = dropdownOptions(t, "auth-mode");
      return options ? [{ where: "auth-mode dropdown (registry auth.modes)", names: options }] : [];
    },
  },
  {
    file: "docs/CROSS_SERVER_CONTRACT.md",
    why: "the server inventory a contributor checks prefixes against is incomplete",
    lists: (t) => [
      {
        where: "Server Inventory table",
        names: captures(t, /^\| ([a-z0-9-]+-mcp) +\|/gm),
      },
    ],
  },
  {
    file: "docs/guides/platform-mapping.md",
    why: "the platform-to-package table is incomplete",
    lists: (t) => [
      {
        where: "Current Platforms table",
        names: captures(
          t.slice(t.indexOf("## Current Platforms"), t.indexOf("## Planned")),
          /^\|[^|\n]+\| `packages\/([a-z0-9-]+-mcp)`/gm
        ),
      },
    ],
  },
];

/**
 * List-agnostic completeness for files where every server should appear
 * equally often: no server may be mentioned on fewer lines than the most
 * common count. A server missing from ANY list in the file, including one no
 * site above is configured for, drops below it. Extra mentions (a usage example
 * naming one server) only raise a count, so they are harmless.
 *
 * Every file in INVENTORY_SITES must appear here: `true` to census it, or the
 * reason it cannot be censused. Those files rely on their configured sites
 * alone, so a list added there needs a site.
 */
export const CENSUS = {
  "scripts/publish-all.sh": true,
  "scripts/conformance-test.sh":
    "its *_MCP_PORT env block deliberately names only some servers (get_port, which is checked, sets the port anyway)",
  "scripts/deploy.sh": true,
  "scripts/smoke-test.sh": true,
  "scripts/dev-server.sh": true,
  "cloudbuild.yaml": true,
  "cloudbuild-manual.yaml": true,
  Dockerfile: true,
  "terraform/main.tf": true,
  "terraform/variables.tf":
    "each server declares a different number of secrets, so per-server line counts legitimately differ",
  "terraform/outputs.tf": true,
  "terraform/dev.tfvars.example": true,
  "terraform/prod.tfvars.example": true,
  ".github/ISSUE_TEMPLATE/bug_report.yml":
    "the auth-mode dropdown lists modes, and the Google servers share google-headers",
  ".github/ISSUE_TEMPLATE/feature_request.yml": true,
  ".github/ISSUE_TEMPLATE/new_tool_proposal.yml": true,
  "docs/CROSS_SERVER_CONTRACT.md": "prose mentions each platform a different number of times",
  "docs/guides/platform-mapping.md": true,
};

/** Lines of `text` that mention the server, as `amazon-dsp`, `amazon_dsp` or within `amazon-dsp-mcp`. */
export function mentionCount(text, pkg) {
  const short = pkg.replace(/-mcp$/, "").replaceAll("-", "[-_]");
  const re = new RegExp(`(?<![a-z0-9])${short}(?![a-z0-9])`, "i");
  return text.split("\n").filter((line) => re.test(line)).length;
}

/** Servers mentioned on fewer lines than the most common count in `text`. */
export function censusShortfalls(text, packages) {
  const counts = new Map(packages.map((p) => [p, mentionCount(text, p)]));
  const freq = new Map();
  for (const c of counts.values()) freq.set(c, (freq.get(c) ?? 0) + 1);
  const mode = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  return [...counts].filter(([, c]) => c < mode).map(([pkg, c]) => ({ pkg, count: c, mode }));
}

/** Workspace server packages: `packages/*-mcp`. */
export function workspaceServers(root) {
  return readdirSync(join(root, "packages"))
    .filter((p) => p.endsWith("-mcp"))
    .sort();
}

export function readRegistry(root) {
  return JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
}

function diff(expected, actual) {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: [...want].filter((n) => !have.has(n)).sort(),
    extra: [...have].filter((n) => !want.has(n)).sort(),
  };
}

/** Each server's default port, read from its `port: z.number()…default(N)`. */
function defaultPorts(root, packages, violations) {
  const ports = new Map();
  for (const pkg of packages) {
    const configPath = join(root, "packages", pkg, "src/config/index.ts");
    if (!existsSync(configPath)) continue;
    const m = readFileSync(configPath, "utf8").match(
      /^\s+port: z\.number\(\)[^\n]*\.default\((\d+)\)/m
    );
    if (m) ports.set(pkg, Number(m[1]));
    else violations.push(`packages/${pkg}/src/config/index.ts: no \`port: z.number()…default(N)\``);
  }
  return ports;
}

/**
 * Every violation as a human-readable line. `registry` defaults to the real
 * registry.json; the test passes a modified copy to prove no site is vacuous.
 */
export function checkFleetInventory(root, registry = readRegistry(root)) {
  const violations = [];
  const servers = registry.servers;
  const packages = servers.map((s) => s.package);

  // Two-way: a package missing from the registry is invisible to every
  // registry-driven check (manifests, server.json, runtime tool lists).
  const ws = diff(packages, workspaceServers(root));
  for (const p of ws.extra) {
    violations.push(`registry.json: no entry for workspace package packages/${p}`);
  }
  for (const p of ws.missing) {
    violations.push(`registry.json: lists ${p}, but packages/${p} does not exist`);
  }

  for (const site of INVENTORY_SITES) {
    const path = join(root, site.file);
    if (!existsSync(path)) {
      violations.push(`${site.file}: file not found (moved? update INVENTORY_SITES)`);
      continue;
    }
    const expected = site.expected ? site.expected(servers) : packages;
    const occurrences = site.lists(readFileSync(path, "utf8"));
    if (occurrences.length === 0) {
      violations.push(`${site.file}: no list found (reformatted? update INVENTORY_SITES)`);
      continue;
    }
    for (const { where, names, why = site.why } of occurrences) {
      if (names.length === 0) {
        violations.push(`${site.file} [${where}]: matched but empty (update INVENTORY_SITES)`);
        continue;
      }
      const { missing, extra } = diff(expected, names);
      if (missing.length) {
        violations.push(`${site.file} [${where}]: missing ${missing.join(", ")} — ${why}`);
      }
      if (extra.length) {
        violations.push(`${site.file} [${where}]: lists ${extra.join(", ")}, not in registry.json`);
      }
    }
  }

  // Census: catches a server missing from a list no site is configured for.
  for (const file of new Set(INVENTORY_SITES.map((s) => s.file))) {
    const decision = CENSUS[file];
    if (decision === undefined) {
      violations.push(`${file}: no CENSUS entry (census it, or record why it cannot be)`);
      continue;
    }
    if (decision !== true || !existsSync(join(root, file))) continue;
    for (const { pkg, count, mode } of censusShortfalls(
      readFileSync(join(root, file), "utf8"),
      packages
    )) {
      violations.push(
        `${file}: mentions ${pkg} on ${count} line(s), but most servers on ${mode} — it is missing from a list in this file`
      );
    }
  }
  for (const file of Object.keys(CENSUS)) {
    if (!INVENTORY_SITES.some((s) => s.file === file)) {
      violations.push(`CENSUS lists ${file}, which has no inventory site`);
    }
  }

  // Terraform's default auth mode for each service must be one the server supports.
  const mainTf = readFileSync(join(root, "terraform/main.tf"), "utf8");
  const authBlock = mainTf.match(/service_auth_defaults = \{\n([\s\S]*?)^\s+\}/m)?.[1] ?? "";
  for (const [, pkg, mode] of authBlock.matchAll(/^\s+"([a-z0-9-]+-mcp)"\s+= "([^"]+)"/gm)) {
    const modes = servers.find((s) => s.package === pkg)?.auth?.modes;
    if (modes && !modes.includes(mode)) {
      violations.push(
        `terraform/main.tf service_auth_defaults: ${pkg} defaults to "${mode}", not in its registry auth.modes`
      );
    }
  }

  // Ports: the conformance script must start each server on the port it binds
  // by default, and no two servers may default to the same port.
  const conformance = readFileSync(join(root, "scripts/conformance-test.sh"), "utf8");
  const scriptPorts = new Map(
    [...conformance.matchAll(/^\s+([a-z0-9-]+-mcp)\)\s+echo (\d+) ;;/gm)].map((m) => [
      m[1],
      Number(m[2]),
    ])
  );
  const owner = new Map();
  for (const [pkg, port] of defaultPorts(root, packages, violations)) {
    if (owner.has(port)) {
      violations.push(`port ${port}: default for both ${owner.get(port)} and ${pkg}`);
    }
    owner.set(port, pkg);
    if (scriptPorts.has(pkg) && scriptPorts.get(pkg) !== port) {
      violations.push(
        `scripts/conformance-test.sh: get_port ${pkg} is ${scriptPorts.get(pkg)}, but the server defaults to ${port}`
      );
    }
  }

  return violations;
}
