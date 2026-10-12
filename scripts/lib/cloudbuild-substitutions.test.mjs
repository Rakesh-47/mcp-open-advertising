// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
//
// Cloud Build reads every `$NAME` / `${NAME}` in a build config as one of its
// own substitutions, inside step scripts too, and rejects the whole build at
// submit when NAME is neither a user substitution (`_FOO`) nor a built-in:
//
//   INVALID_ARGUMENT: ... key in the template "SERVICES" is not a valid
//   built-in substitution
//
// A shell variable must be written `$$NAME`, which Cloud Build turns into a
// literal `$`. cloudbuild.yaml used plain shell variables from its first
// commit, so it was never accepted by Cloud Build. Nothing in CI submits a
// build, so this test is the only thing that would catch it.
//
// basis: https://cloud.google.com/build/docs/configuring-builds/substitute-variable-values

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./boot-server.mjs";

const BUILT_IN = new Set([
  "PROJECT_ID",
  "BUILD_ID",
  "PROJECT_NUMBER",
  "LOCATION",
  "TRIGGER_NAME",
  "COMMIT_SHA",
  "REVISION_ID",
  "SHORT_SHA",
  "REPO_NAME",
  "REPO_FULL_NAME",
  "BRANCH_NAME",
  "TAG_NAME",
  "REF_NAME",
  "TRIGGER_BUILD_CONFIG_PATH",
  "SERVICE_ACCOUNT_EMAIL",
  "SERVICE_ACCOUNT",
]);

/** Every `$` that Cloud Build would read as an invalid substitution, with its line. */
function invalidSubstitutions(text) {
  const found = [];
  const token = /\$(\$|\{([A-Za-z0-9_]*)\}|([A-Za-z0-9_]+))?/g;
  for (const m of text.matchAll(token)) {
    if (m[1] === "$") continue;
    const name = m[2] ?? m[3];
    if (name && (name.startsWith("_") || BUILT_IN.has(name))) continue;
    const line = text.slice(0, m.index).split("\n").length;
    found.push(`line ${line}: ${m[0]}`);
  }
  return found;
}

const configs = readdirSync(ROOT)
  .filter((f) => /^cloudbuild.*\.ya?ml$/.test(f))
  .sort();

describe("Cloud Build configs escape shell variables", () => {
  it("finds the configs", () => {
    expect(configs).toEqual(expect.arrayContaining(["cloudbuild.yaml", "cloudbuild-manual.yaml"]));
  });

  it("flags unescaped shell syntax and accepts substitutions", () => {
    const sample = [
      'for S in $SERVICES; do echo "${S}" "$@" $(date); done',
      'echo "$${S}" $$SERVICES "$$@" $$(date) ${_REGION} ${PROJECT_ID} $SHORT_SHA',
    ].join("\n");
    expect(invalidSubstitutions(sample)).toEqual([
      "line 1: $SERVICES",
      "line 1: ${S}",
      "line 1: $",
      "line 1: $",
    ]);
  });

  it.each(configs)("%s", (file) => {
    expect(invalidSubstitutions(readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
  });
});
