// @custom-agent/tools
//
// M3-02: read-only tool implementations + ToolRouter that funnels every
// execution through PermissionEngine. The router is session-agnostic;
// M3-02b will adapt its event sink to commit AgentEvents through the
// SessionEngine's EventStore.

export type {
  Tool,
  ToolChunk,
  ToolContext,
  ToolEmit,
  ToolFailure,
  ToolOutcome,
  ToolSuccess,
} from "./tool";

export {
  ToolRouter,
  type ToolDispatchResult,
  type ToolEventInput,
  type ToolEventSink,
  type ToolInvocation,
  type ToolRouterOptions,
} from "./router";

export { BudgetAccumulator, DEFAULT_OUTPUT_BUDGET_BYTES } from "./budget";
export { resolveInsideCwd } from "./path-safety";

export { readFileTool, type ReadFileArgs } from "./tools/read-file";
export { listFilesTool, type ListFilesArgs } from "./tools/list-files";
export { searchTextTool, type SearchTextArgs } from "./tools/search-text";

/** Convenience: the canonical M3-02 trio for default ToolRouter wiring. */
import { readFileTool } from "./tools/read-file";
import { listFilesTool } from "./tools/list-files";
import { searchTextTool } from "./tools/search-text";
import type { Tool as ToolPort } from "./tool";

export const DEFAULT_READONLY_TOOLS: readonly ToolPort<unknown>[] = [
  readFileTool as ToolPort<unknown>,
  listFilesTool as ToolPort<unknown>,
  searchTextTool as ToolPort<unknown>,
];
