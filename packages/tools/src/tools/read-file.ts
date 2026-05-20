import { readFile } from "node:fs/promises";
import { resolveInsideCwd } from "../path-safety";
import type { Tool, ToolContext, ToolOutcome } from "../tool";

export type ReadFileArgs = {
  /** Path to read. Absolute paths must live under the session cwd. */
  readonly path: string;
  /** Optional max bytes; falls back to ToolContext budget if unset. */
  readonly maxBytes?: number;
};

/**
 * `read_file` — read a UTF-8 text file living under the session cwd
 * and stream its content out as a single `result` chunk. Path traversal
 * (`../escape`) is refused with `path_unsafe`. Output is gated by the
 * ToolRouter's BudgetAccumulator.
 *
 * M3-02 deliberately does NOT do binary-file sniffing or per-line
 * streaming — the canonical use case is the model reading a source
 * file before edits. M3-03 may add a `read_binary` variant.
 */
export const readFileTool: Tool<ReadFileArgs> = {
  name: "read_file",
  risk: "read",
  description: "Read a UTF-8 text file under the session working directory.",
  async execute(args, ctx: ToolContext): Promise<ToolOutcome> {
    const safePath = resolveInsideCwd(ctx.cwd, args.path);
    if (!safePath) {
      return {
        status: "failed",
        errorCode: "path_unsafe",
        message: `path resolves outside cwd: ${args.path}`,
      };
    }
    try {
      const content = await readFile(safePath, "utf8");
      ctx.emit({ kind: "result", text: content });
      return { status: "ok" };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return { status: "failed", errorCode: "not_found", message: `no such file: ${args.path}` };
      }
      if (e.code === "EISDIR") {
        return { status: "failed", errorCode: "io_error", message: `is a directory: ${args.path}` };
      }
      if (e.code === "EACCES" || e.code === "EPERM") {
        return {
          status: "failed",
          errorCode: "io_error",
          message: `permission denied: ${args.path}`,
        };
      }
      return { status: "failed", errorCode: "io_error", message: e.message };
    }
  },
};
