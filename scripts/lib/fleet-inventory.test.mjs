// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
//
// Fleet inventory completeness (see fleet-inventory.mjs). Static: reads files,
// boots nothing, needs no build, so it fails in seconds on a missed list.

import { describe, expect, it } from "vitest";
import { ROOT } from "./boot-server.mjs";
import {
  CENSUS,
  INVENTORY_SITES,
  censusShortfalls,
  checkFleetInventory,
  mentionCount,
  readRegistry,
  serverTokens,
} from "./fleet-inventory.mjs";

describe("fleet inventory", () => {
  it("every hand-maintained server list matches registry.json", () => {
    // A failure names the file, the list inside it, and what breaks if the
    // server stays out of it. Add the server there; do not edit this test.
    expect(checkFleetInventory(ROOT)).toEqual([]);
  });

  it("no site is vacuous: an extra registry server is reported missing from every list", () => {
    const registry = readRegistry(ROOT);
    const template = registry.servers[0];
    const fake = { ...template, package: "zzfake-mcp", auth: { modes: ["zzfake-bearer"] } };
    const violations = checkFleetInventory(ROOT, {
      ...registry,
      servers: [...registry.servers, fake],
    });

    expect(violations).toContain(
      "registry.json: lists zzfake-mcp, but packages/zzfake-mcp does not exist"
    );
    for (const site of INVENTORY_SITES) {
      const token = site.expected ? "zzfake-bearer" : "zzfake-mcp";
      const hits = violations.filter((v) => v.startsWith(`${site.file} [`) && v.includes(token));
      expect(hits.length, `${site.file} never reported ${token}`).toBeGreaterThan(0);
    }
    // The census flags it too, in every censused file.
    for (const [file, decision] of Object.entries(CENSUS)) {
      if (decision !== true) continue;
      expect(
        violations.some((v) => v.startsWith(`${file}: mentions zzfake-mcp on 0 line(s)`)),
        `${file} census never reported zzfake-mcp`
      ).toBe(true);
    }
  });

  it("every inventory file either is censused or records why it cannot be", () => {
    for (const file of new Set(INVENTORY_SITES.map((s) => s.file))) {
      const decision = CENSUS[file];
      expect(decision, file).toBeDefined();
      if (decision !== true) expect(String(decision).length, file).toBeGreaterThan(30);
    }
  });
});

describe("census", () => {
  const packages = ["dbm-mcp", "ttd-mcp", "amazon-dsp-mcp", "meta-mcp"];

  it("counts lines in every spelling, without matching inside other words", () => {
    const text = [
      'module "amazon_dsp_mcp" {',
      "  secret_names = local.amazon_dsp_secret_names",
      "COPY packages/amazon-dsp-mcp/package.json",
      "metadata = {}",
    ].join("\n");
    expect(mentionCount(text, "amazon-dsp-mcp")).toBe(3);
    expect(mentionCount(text, "meta-mcp")).toBe(0);
  });

  it("flags a server missing from a list no site names; extras are harmless", () => {
    const text = [
      "list_a = [dbm-mcp, ttd-mcp, amazon-dsp-mcp, meta-mcp]".replaceAll(", ", "\n"),
      "list_b = [dbm_x, ttd_x, meta_x]".replaceAll(", ", "\n"), // amazon_dsp missing
      "# example: ./dev.sh dbm-mcp", // extra mention
    ].join("\n");
    expect(censusShortfalls(text, packages)).toEqual([
      { pkg: "amazon-dsp-mcp", count: 1, mode: 2 },
    ]);
  });
});

describe("serverTokens", () => {
  it("finds hyphenated package names and ignores non-server words", () => {
    expect(serverTokens('SERVERS=("dbm-mcp" "amazon-dsp-mcp") shared mcp')).toEqual([
      "dbm-mcp",
      "amazon-dsp-mcp",
    ]);
  });
});

describe("site extractors", () => {
  const site = (file) => INVENTORY_SITES.find((s) => s.file === file);

  it('conformance: ignores the single-server SERVERS=("$TARGET_SERVER") branch', () => {
    const text = [
      'get_port() {\n  case "$1" in\n    dbm-mcp)   echo 3001 ;;\n  esac\n}',
      '  SERVERS=("$TARGET_SERVER")',
      '  SERVERS=("dbm-mcp" "ttd-mcp")',
    ].join("\n");
    expect(site("scripts/conformance-test.sh").lists(text)).toEqual([
      { where: "default SERVERS", names: ["dbm-mcp", "ttd-mcp"] },
      { where: "get_port case arms", names: ["dbm-mcp"] },
    ]);
  });

  it("cloudbuild: FAILED_SERVICES is not a server list", () => {
    const text = [
      'FAILED_SERVICES=""',
      'SERVICES="dbm-mcp ttd-mcp"',
      'FAILED_SERVICES="$FAILED_SERVICES $SERVICE"',
      "images:",
      "  - 'r/dbm-mcp:${SHORT_SHA}'",
      "  - 'r/dbm-mcp:${_ENVIRONMENT}-latest'",
    ].join("\n");
    const lists = site("cloudbuild.yaml").lists(text);
    expect(lists.filter((l) => l.where.startsWith("SERVICES="))).toEqual([
      { where: "SERVICES= list #1", names: ["dbm-mcp", "ttd-mcp"] },
    ]);
  });

  it("platform-mapping: planned rows do not count as current", () => {
    const text = [
      "## Current Platforms",
      "| Meta | `packages/meta-mcp` | x | Active |",
      "## Planned/Target Platforms",
      "| Reddit | `packages/reddit-mcp` | x |",
    ].join("\n");
    expect(site("docs/guides/platform-mapping.md").lists(text)[0].names).toEqual(["meta-mcp"]);
  });
});
