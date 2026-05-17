export type PermissionDecision = "allow" | "ask" | "deny";

export type ToolRisk = "read" | "write" | "execute" | "network";

export type PermissionRequest = {
  readonly toolName: string;
  readonly risk: ToolRisk;
  readonly reason: string;
};

export function classifyPermission(request: PermissionRequest): PermissionDecision {
  if (request.risk === "read") {
    return "allow";
  }

  return "ask";
}
