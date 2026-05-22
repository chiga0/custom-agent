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
export { shellTool, type ShellArgs } from "./tools/shell";
export { gitDiffTool, type GitDiffArgs } from "./tools/git-diff";
export { applyPatchTool, type ApplyPatchArgs } from "./tools/apply-patch";
export { classifyShellCommand, SHELL_DENYLIST } from "./risk-classifier";

import { readFileTool } from "./tools/read-file";
import { listFilesTool } from "./tools/list-files";
import { searchTextTool } from "./tools/search-text";
import { shellTool } from "./tools/shell";
import { gitDiffTool } from "./tools/git-diff";
import { applyPatchTool } from "./tools/apply-patch";
import type { Tool as ToolPort } from "./tool";

/** Convenience: the canonical M3-02 trio for default ToolRouter wiring. */
export const DEFAULT_READONLY_TOOLS: readonly ToolPort<unknown>[] = [
  readFileTool as ToolPort<unknown>,
  listFilesTool as ToolPort<unknown>,
  searchTextTool as ToolPort<unknown>,
];

/** All tools including write/execute tools. */
export const ALL_TOOLS: readonly ToolPort<unknown>[] = [
  readFileTool as ToolPort<unknown>,
  listFilesTool as ToolPort<unknown>,
  searchTextTool as ToolPort<unknown>,
  shellTool as ToolPort<unknown>,
  gitDiffTool as ToolPort<unknown>,
  applyPatchTool as ToolPort<unknown>,
];
