import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ImportEdge = {
  from: string;
  to: string;
};

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const aliasToPath: Record<string, string> = {
  "@custom-agent/acp-daemon": "apps/acp-daemon",
  "@custom-agent/acp-server": "apps/acp-server",
  "@custom-agent/cli": "apps/cli",
  "@custom-agent/core": "packages/core",
  "@custom-agent/model-gateway": "packages/model-gateway",
  "@custom-agent/permissions": "packages/permissions",
  "@custom-agent/tools": "packages/tools",
  "@custom-agent/qa-fixtures": "packages/qa-fixtures",
  "@custom-agent/schema": "packages/schema",
  "@custom-agent/storage": "packages/storage",
  "@custom-agent/web-client": "apps/web-client",
};

const forbiddenEdges = [
  {
    from: "packages/core",
    to: "apps/",
    reason: "core must not depend on clients",
  },
  {
    from: "packages/core",
    to: "packages/mcp-client/transports/",
    reason: "core must not depend on MCP transport implementations",
  },
  {
    from: "apps/",
    to: "packages/storage/internal/",
    reason: "clients must not mutate session storage directly",
  },
  {
    from: "apps/acp-daemon",
    to: "packages/core",
    reason: "daemon is a pure transport adapter; must not import core directly",
  },
  {
    from: "apps/web-client",
    to: "packages/core",
    reason: "web client speaks only ACP wire; must not import core directly",
  },
  {
    from: "apps/web-client",
    to: "packages/storage",
    reason: "web client must not depend on storage adapters",
  },
  {
    from: "packages/core",
    to: "packages/qa-fixtures",
    reason: "runtime packages must not depend on QA infrastructure",
  },
  {
    from: "packages/schema",
    to: "packages/qa-fixtures",
    reason: "runtime packages must not depend on QA infrastructure",
  },
  {
    from: "packages/storage",
    to: "packages/qa-fixtures",
    reason: "runtime packages must not depend on QA infrastructure",
  },
  {
    from: "packages/permissions",
    to: "packages/qa-fixtures",
    reason: "runtime packages must not depend on QA infrastructure",
  },
  {
    from: "apps/",
    to: "packages/qa-fixtures",
    reason: "client apps must not depend on QA infrastructure",
  },
  {
    from: "packages/core",
    to: "packages/model-gateway",
    reason:
      "core defines the ModelProvider port; concrete adapters live in model-gateway and must depend on core, not the reverse",
  },
  {
    from: "packages/schema",
    to: "packages/model-gateway",
    reason: "schema is leaf; provider adapters depend on schema, not the reverse",
  },
  {
    from: "packages/storage",
    to: "packages/model-gateway",
    reason: "storage must not couple to provider adapters",
  },
  {
    from: "packages/permissions",
    to: "packages/model-gateway",
    reason: "permission engine must not couple to provider adapters",
  },
  {
    from: "packages/core",
    to: "packages/tools",
    reason: "core defines no tool concept; concrete tools depend on schema + permissions, not core",
  },
  {
    from: "packages/schema",
    to: "packages/tools",
    reason: "schema is leaf; tool implementations depend on schema, not the reverse",
  },
  {
    from: "packages/storage",
    to: "packages/tools",
    reason: "storage must not couple to tool implementations",
  },
  {
    from: "packages/permissions",
    to: "packages/tools",
    reason:
      "permission engine must not couple to tool implementations (engine is policy + lifecycle; tools call into engine, not the reverse)",
  },
  {
    from: "packages/model-gateway",
    to: "packages/tools",
    reason: "model gateway is provider-only; tool execution lives in @custom-agent/tools",
  },
];

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.name !== "node_modules" && entry.name !== "dist")
      .map(async (entry) => {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
          return collectTypeScriptFiles(path);
        }

        if (entry.isFile() && path.endsWith(".ts")) {
          return [path];
        }

        return [];
      }),
  );

  return files.flat();
}

function normalizeImportTarget(source: string): string | undefined {
  const alias = Object.keys(aliasToPath)
    .sort((left, right) => right.length - left.length)
    .find((key) => source === key || source.startsWith(`${key}/`));

  return alias ? aliasToPath[alias] : undefined;
}

async function collectImportEdges(): Promise<ImportEdge[]> {
  const files = await collectTypeScriptFiles(repoRoot);
  const importPattern = /import\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g;
  const edges: ImportEdge[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const from = relative(repoRoot, file);

    for (const match of content.matchAll(importPattern)) {
      const to = normalizeImportTarget(match[1]);

      if (to) {
        edges.push({ from, to });
      }
    }
  }

  return edges;
}

describe("architecture fitness", () => {
  it("does not cross forbidden package boundaries", async () => {
    const edges = await collectImportEdges();
    const violations = edges.flatMap((edge) =>
      forbiddenEdges
        .filter((rule) => edge.from.startsWith(rule.from) && edge.to.startsWith(rule.to))
        .map((rule) => ({ ...edge, reason: rule.reason })),
    );

    expect(violations).toEqual([]);
  });
});
