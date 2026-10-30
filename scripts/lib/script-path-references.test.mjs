// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
//
// Every script that package.json, the workflows, Cloud Build and the
// Dockerfile run must exist (see script-path-references.mjs). Static: reads
// files, boots nothing, needs no build.
//
// The repository check at the bottom is only worth anything if the extractor
// finds the references in the first place, so the first half pins what it does
// and does not count, and the last test asserts the real repo yields enough
// references that a parser regression cannot pass as "nothing missing".

import { describe, expect, it } from "vitest";
import { ROOT } from "./boot-server.mjs";
import {
  cloudbuildRefs,
  collectRefs,
  commandPaths,
  dockerfileRefs,
  missingRefs,
  packageJsonRefs,
  workflowRefs,
} from "./script-path-references.mjs";

describe("commandPaths", () => {
  it("finds scripts run through an interpreter or by path", () => {
    expect(commandPaths("node scripts/a.mjs --flag").paths).toEqual(["scripts/a.mjs"]);
    expect(commandPaths("./scripts/b.sh --provenance").paths).toEqual(["./scripts/b.sh"]);
    expect(commandPaths("node --import tsx ./scripts/c.ts").paths).toEqual(["./scripts/c.ts"]);
    expect(commandPaths("../../scripts/d.mjs").paths).toEqual(["../../scripts/d.mjs"]);
    expect(commandPaths('node "scripts/quoted.mjs" "arg"').paths).toEqual(["scripts/quoted.mjs"]);
  });

  it("takes a bare file name only straight after an interpreter", () => {
    expect(commandPaths("node server.js").paths).toEqual(["server.js"]);
    expect(commandPaths("vitest --config vitest.config.scripts.ts").paths).toEqual([]);
    // Prose that merely ends in a script extension.
    expect(commandPaths('echo "Setting up Node.js"').paths).toEqual([]);
  });

  it("skips what a checkout cannot resolve", () => {
    const text = [
      "node $REPO_ROOT/scripts/a.mjs",
      'node "${{ github.workspace }}/scripts/b.mjs"',
      "node /workspace/scripts/c.mjs",
      "node dist/index.js",
      "node packages/x/node_modules/.bin/y.js",
      "node scripts/*.mjs",
    ].join("\n");
    expect(commandPaths(text).paths).toEqual([]);
  });

  it("ignores comments, whole-line and trailing", () => {
    const text = "# node scripts/commented.mjs\nnode scripts/real.mjs # not scripts/trailing.mjs";
    expect(commandPaths(text).paths).toEqual(["scripts/real.mjs"]);
  });

  it("records the directories a block changes into", () => {
    const { paths, cds } = commandPaths("cd terraform\nnode scripts/x.mjs");
    expect(cds).toEqual(["terraform"]);
    expect(paths).toEqual(["scripts/x.mjs"]);
  });
});

describe("extractors", () => {
  it("package.json: reads only the scripts, resolved from the package", () => {
    const refs = packageJsonRefs(
      "packages/shared/package.json",
      JSON.stringify({
        main: "./dist/index.js",
        bin: { x: "./dist/cli.js" },
        scripts: { prebuild: "node ../../scripts/sync.mjs", start: "node dist/index.js" },
      })
    );
    expect(refs).toEqual([
      {
        file: "packages/shared/package.json",
        context: "scripts.prebuild",
        token: "../../scripts/sync.mjs",
        bases: ["packages/shared"],
      },
    ]);
  });

  it("workflow: reads run steps (single line and block), and honours working-directory", () => {
    const yaml = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: One line",
      "        run: node scripts/one.mjs",
      "      - name: Block",
      "        run: |",
      "          echo hi",
      "          node scripts/two.mjs",
      "      - name: Not a command",
      "        uses: actions/setup-node@v4",
      "        with:",
      "          cache-dependency-path: scripts/not-run.mjs",
      "      - name: In a directory",
      "        working-directory: terraform",
      "        run: node ../scripts/three.mjs",
    ].join("\n");
    const refs = workflowRefs(".github/workflows/x.yml", yaml);
    expect(refs.map((r) => [r.context, r.token, r.bases])).toEqual([
      ['step "One line"', "scripts/one.mjs", ["."]],
      ['step "Block"', "scripts/two.mjs", ["."]],
      ['step "In a directory"', "../scripts/three.mjs", ["terraform"]],
    ]);
  });

  it("Cloud Build: reads step args and honours dir", () => {
    const yaml = [
      "steps:",
      "  - name: 'node:20-slim'",
      "    entrypoint: 'bash'",
      "    args:",
      "      - '-c'",
      "      - |",
      "        node scripts/fleet.mjs servers > /workspace/.fleet-services",
      "  - name: 'hashicorp/terraform'",
      "    dir: terraform",
      "    args: ['init']",
    ].join("\n");
    const refs = cloudbuildRefs("cloudbuild.yaml", yaml);
    expect(refs.map((r) => [r.token, r.bases])).toEqual([["scripts/fleet.mjs", ["."]]]);
  });

  it("Dockerfile: reads RUN, CMD and ENTRYPOINT, not COPY", () => {
    const text = [
      "COPY scripts/not-run.mjs ./",
      "RUN node scripts/build.mjs",
      'CMD ["node", "dist/index.js"]',
    ].join("\n");
    expect(dockerfileRefs("Dockerfile", text).map((r) => r.token)).toEqual(["scripts/build.mjs"]);
  });
});

describe("missingRefs", () => {
  it("reports a reference that does not resolve, with where it came from", () => {
    const refs = [
      {
        file: "package.json",
        context: "scripts.a",
        token: "scripts/lib/script-path-references.mjs",
        bases: ["."],
      },
      {
        file: "package.json",
        context: "scripts.b",
        token: "scripts/does-not-exist.mjs",
        bases: ["."],
      },
    ];
    const missing = missingRefs(ROOT, refs);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      file: "package.json",
      context: "scripts.b",
      token: "scripts/does-not-exist.mjs",
    });
    expect(missing[0].tried).toEqual(["scripts/does-not-exist.mjs"]);
  });

  it("accepts a path that resolves from a directory the block changed into", () => {
    const refs = [
      { file: "x", context: "y", token: "scripts/fleet.mjs", bases: ["terraform", "."] },
    ];
    expect(missingRefs(ROOT, refs)).toEqual([]);
  });
});

describe("repository", () => {
  const refs = collectRefs(ROOT);

  it("finds the references it is supposed to guard", () => {
    // Floors, not exact counts: they catch an extractor that stopped matching,
    // not the removal of one script call. If a floor fails because references
    // were genuinely removed, lower it in the same change.
    const inFile = (pattern) => refs.filter((r) => pattern.test(r.file)).length;
    expect(inFile(/^package\.json$/), "root package.json scripts").toBeGreaterThanOrEqual(15);
    expect(inFile(/^packages\/.+\/package\.json$/), "package-level scripts").toBeGreaterThanOrEqual(
      5
    );
    expect(inFile(/^\.github\/workflows\//), "workflow run steps").toBeGreaterThanOrEqual(5);
    expect(inFile(/^cloudbuild/), "Cloud Build steps").toBeGreaterThanOrEqual(1);
  });

  it("every script a config file runs exists", () => {
    const missing = missingRefs(ROOT, refs);
    // Fix the reference (or restore the script); do not loosen this test. A
    // release or scheduled workflow that names a missing script only fails
    // when it runs, which is after the change that broke it has merged.
    expect(
      missing.map((m) => `${m.file} (${m.context}): ${m.token} -> tried ${m.tried.join(", ")}`)
    ).toEqual([]);
  });
});
