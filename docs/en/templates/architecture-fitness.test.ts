import { describe, expect, it } from "vitest";

type ImportEdge = {
  from: string;
  to: string;
};

const forbiddenEdges = [
  {
    from: "packages/core",
    to: "apps/",
    reason: "core must not depend on clients",
  },
  {
    from: "packages/core",
    to: "packages/model-gateway/providers/",
    reason: "core must not depend on provider SDK adapters",
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
];

async function collectImportEdges(): Promise<ImportEdge[]> {
  // Replace this stub with dependency-cruiser, madge, or a TypeScript AST scan.
  // Keep the output normalized to package-relative paths.
  return [];
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
