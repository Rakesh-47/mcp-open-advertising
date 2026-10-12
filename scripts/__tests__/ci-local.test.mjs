// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
//
// `pnpm ci:local` reads its steps from ci.yml at run time. These tests pin that
// the parser still understands the real workflow (so a CI edit cannot leave the
// local run silently short), and that it refuses what it cannot represent.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowJobs, planJob } from "../ci-local.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("ci-local against the real ci.yml", () => {
  const jobs = parseWorkflowJobs(ci);

  it("finds every job, and every step of each job", () => {
    const jobsBlock = ci.slice(ci.search(/^jobs:/m));
    const jobKeys = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
    expect(jobs.map((j) => j.name)).toEqual(jobKeys);
    for (const job of jobs) {
      const block = ci.slice(ci.indexOf(`\n  ${job.name}:`) + 1).split(/\n {2}\S/)[0];
      const stepCount = (block.match(/^ {6}- /gm) ?? []).length;
      expect(job.steps.length, job.name).toBe(stepCount);
    }
  });

  it("maps every action to a local equivalent (planning never throws)", () => {
    expect(() => jobs.map(planJob)).not.toThrow();
  });

  it("runs build-and-test's commands in CI's order", () => {
    const runs = [
      ...ci
        .slice(ci.indexOf("\n  build-and-test:"), ci.indexOf("\n  conformance:"))
        .matchAll(/^ {8}run: (.+)$/gm),
    ].map((m) => m[1]);
    const plan = planJob(jobs.find((j) => j.name === "build-and-test"));
    expect(plan.commands.map((c) => c.run)).toEqual(runs);
    expect(runs[0]).toBe("pnpm install --frozen-lockfile");
    expect(runs).toContain("pnpm run test:scripts");
  });

  it("keeps needs: and working-directory:", () => {
    expect(jobs.find((j) => j.name === "conformance").needs).toEqual(["build-and-test"]);
    const tf = planJob(jobs.find((j) => j.name === "terraform-validate"));
    expect(tf.requires).toEqual(["terraform"]);
    expect(tf.commands.every((c) => c.cwd === "terraform")).toBe(true);
  });
});

describe("parseWorkflowJobs refuses what it cannot represent", () => {
  it("rejects a multi-line run:", () => {
    const text = "jobs:\n  a:\n    steps:\n      - run: |\n          echo hi\n";
    expect(() => parseWorkflowJobs(text)).toThrow(/multi-line run/);
  });

  it("rejects an unknown action at planning time", () => {
    const [job] = parseWorkflowJobs("jobs:\n  a:\n    steps:\n      - uses: acme/deploy@v1\n");
    expect(() => planJob(job)).toThrow(/does not know how to run acme\/deploy@v1/);
  });
});
