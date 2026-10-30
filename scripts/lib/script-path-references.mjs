// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
//
// Script path references: every script a config file RUNS must exist.
//
// `package.json` scripts, GitHub workflow `run:` steps, Cloud Build steps and
// the Dockerfile name scripts by path (`node scripts/check/check-platform-facts.mjs`).
// Nothing checked those paths. Moving or renaming a script left a dangling
// reference that only showed up when the thing ran, and the release workflow
// and the scheduled drift checks run on a tag or a timer, not on a pull
// request. This reads those files and resolves every executable path in them.
//
// "Executable path" is deliberate. Comments, prose and docs mention
// `scripts/...` all the time and none of that runs, so only command text
// counts: a token that ends in a script extension and has a directory part, or
// a bare file name that directly follows an interpreter (`node server.js`).
// Paths with a shell variable, absolute paths, globs and build output (`dist/`)
// are not resolvable from a checkout and are skipped.
//
// Used by script-path-references.test.mjs, which also pins the extractor so a
// parser change cannot turn the repo check into a silent pass.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, normalize, relative } from "node:path";

const SCRIPT_EXT = "(?:mjs|cjs|js|ts|sh)";
const PATH_TOKEN = new RegExp(`^(?:\\.{1,2}/)*(?:[\\w@.-]+/)*[\\w@.-]+\\.${SCRIPT_EXT}$`);
const BARE_TOKEN = new RegExp(`^[\\w@.-]+\\.${SCRIPT_EXT}$`);
const INTERPRETERS = new Set(["node", "bash", "sh", "zsh", "tsx", "python", "python3"]);
const SKIPPED_SEGMENTS = new Set(["dist", "node_modules"]);

/** Drops whole-line and trailing ` # ...` comments from command text. */
function stripComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) => line.replace(/\s#.*$/, ""))
    .join("\n");
}

/**
 * The script paths a block of command text runs, plus the directories it `cd`s
 * into. `cd` is tracked loosely: a path may resolve from the block's base
 * directory or from any directory the block changed into.
 *
 * @returns {{ paths: string[], cds: string[] }}
 */
export function commandPaths(text) {
  const tokens = stripComments(text)
    .split(/[\s;&|()<>`'"=,]+/)
    .filter(Boolean);
  const paths = [];
  const cds = [];
  let prev = "";
  for (const token of tokens) {
    if (prev === "cd" && !token.includes("$") && !token.startsWith("/") && !token.startsWith("-")) {
      cds.push(token);
    }
    const resolvable =
      !token.includes("$") &&
      !token.includes("*") &&
      !token.includes("{") &&
      !token.startsWith("/") &&
      !token.startsWith("-") &&
      !token.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment));
    if (resolvable) {
      if (PATH_TOKEN.test(token) && (token.includes("/") || INTERPRETERS.has(prev))) {
        paths.push(token);
      } else if (BARE_TOKEN.test(token) && INTERPRETERS.has(prev)) {
        paths.push(token);
      }
    }
    prev = token;
  }
  return { paths, cds };
}

/**
 * Splits a YAML file's list under `key:` into steps by indentation, without a
 * YAML parser (the repo has none at the root). Each step is the text from its
 * `- ` line to the line before the next sibling `- `.
 */
function stepsUnder(text, key) {
  const lines = text.split("\n");
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(new RegExp(`^(\\s*)${key}:\\s*$`));
    if (!header) continue;
    const keyIndent = header[1].length;
    let stepIndent = null;
    let current = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        current?.push(line);
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= keyIndent && !line.trim().startsWith("- ")) break;
      if (indent < keyIndent) break;
      const item = line.match(/^(\s*)- /);
      if (
        item &&
        (stepIndent === null || item[1].length === stepIndent) &&
        item[1].length >= keyIndent
      ) {
        stepIndent = item[1].length;
        current = [line];
        steps.push(current);
      } else {
        current?.push(line);
      }
    }
  }
  return steps.map((step) => step.join("\n"));
}

/** `run:` text of one workflow step: a single line, or a `|` / `>` block. */
function workflowRunText(step) {
  const lines = step.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (/^[|>][+-]?$/.test(m[2].trim())) {
      const baseIndent = m[1].length + (lines[i].includes("- run:") ? 2 : 0);
      for (let j = i + 1; j < lines.length; j++) {
        const indent = lines[j].match(/^\s*/)[0].length;
        if (lines[j].trim() !== "" && indent <= baseIndent) break;
        out.push(lines[j]);
      }
    } else {
      out.push(m[2]);
    }
  }
  return out.join("\n");
}

function stepField(step, field) {
  const m = step.match(
    new RegExp(`^\\s*(?:- )?${field}:\\s*['"]?([^'"\\n#]+?)['"]?\\s*(?:#.*)?$`, "m")
  );
  return m ? m[1].trim() : null;
}

/**
 * Every script path the file's commands run.
 *
 * @typedef {{ file: string, context: string, token: string, bases: string[] }} Ref
 *   `bases` are repo-relative directories the token may resolve from.
 */

/** @returns {Ref[]} */
export function packageJsonRefs(file, jsonText) {
  const pkg = JSON.parse(jsonText);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  const refs = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    const { paths, cds } = commandPaths(String(command));
    for (const token of paths) {
      refs.push({
        file,
        context: `scripts.${name}`,
        token,
        bases: [dir, ...cds.map((cd) => normalize(join(dir, cd)))],
      });
    }
  }
  return refs;
}

/** @returns {Ref[]} */
export function workflowRefs(file, text) {
  const refs = [];
  for (const step of stepsUnder(text, "steps")) {
    const run = workflowRunText(step);
    if (!run) continue;
    const workingDirectory = stepField(step, "working-directory");
    const base = workingDirectory && !workingDirectory.includes("$") ? workingDirectory : ".";
    const label = stepField(step, "name") ?? "(unnamed step)";
    const { paths, cds } = commandPaths(run);
    for (const token of paths) {
      refs.push({
        file,
        context: `step "${label}"`,
        token,
        bases: [base, ...cds.map((cd) => normalize(join(base, cd)))],
      });
    }
  }
  return refs;
}

/** @returns {Ref[]} */
export function cloudbuildRefs(file, text) {
  const refs = [];
  for (const step of stepsUnder(text, "steps")) {
    const dir = stepField(step, "dir");
    const base = dir && !dir.includes("$") ? dir : ".";
    const label = stepField(step, "id") ?? stepField(step, "name") ?? "(unnamed step)";
    const { paths, cds } = commandPaths(step);
    for (const token of paths) {
      refs.push({
        file,
        context: `step "${label}"`,
        token,
        bases: [base, ...cds.map((cd) => normalize(join(base, cd)))],
      });
    }
  }
  return refs;
}

/** @returns {Ref[]} */
export function dockerfileRefs(file, text) {
  const refs = [];
  text.split("\n").forEach((line, index) => {
    if (!/^\s*(RUN|CMD|ENTRYPOINT)\b/i.test(line)) return;
    const { paths, cds } = commandPaths(line);
    for (const token of paths) {
      refs.push({ file, context: `line ${index + 1}`, token, bases: [".", ...cds] });
    }
  });
  return refs;
}

/** Every reference in the repo's config files. */
export function collectRefs(root) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const refs = [];

  refs.push(...packageJsonRefs("package.json", read("package.json")));
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    const rel = `packages/${entry.name}/package.json`;
    if (entry.isDirectory() && existsSync(join(root, rel))) {
      refs.push(...packageJsonRefs(rel, read(rel)));
    }
  }

  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)
      .filter((n) => /\.ya?ml$/.test(n))
      .sort()) {
      const rel = `.github/workflows/${name}`;
      refs.push(...workflowRefs(rel, read(rel)));
    }
  }

  for (const name of readdirSync(root)
    .filter((n) => /^cloudbuild.*\.ya?ml$/.test(n))
    .sort()) {
    refs.push(...cloudbuildRefs(name, read(name)));
  }

  if (existsSync(join(root, "Dockerfile"))) {
    refs.push(...dockerfileRefs("Dockerfile", read("Dockerfile")));
  }
  return refs;
}

/** The references that do not resolve from any of their base directories. */
export function missingRefs(root, refs) {
  return refs
    .filter((ref) => !ref.bases.some((base) => existsSync(join(root, base, ref.token))))
    .map((ref) => ({
      ...ref,
      tried: ref.bases.map(
        (base) => relative(root, normalize(join(root, base, ref.token))) || ref.token
      ),
    }));
}
