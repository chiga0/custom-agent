import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createIgnoreFilter } from "../gitignore";
import { resolveInsideCwd } from "../path-safety";
import type { Tool, ToolContext, ToolOutcome } from "../tool";

export type ListFilesArgs = {
  /** Directory to list. Defaults to cwd. Absolute paths must live under cwd. */
  readonly path?: string;
  /** Recurse into subdirectories. Default false. */
  readonly recursive?: boolean;
  /** Skip hidden dotfiles. Default true. */
  readonly skipHidden?: boolean;
};
export const listFilesTool: Tool<ListFilesArgs> = {
  name: "list_files",
  risk: "read",
  description: "List files in a directory under the session working directory.",
  async execute(args, ctx: ToolContext): Promise<ToolOutcome> {
    const requested = args.path ?? ".";
    const safe = resolveInsideCwd(ctx.cwd, requested);
    if (!safe) {
      return {
        status: "failed",
        errorCode: "path_unsafe",
        message: `path resolves outside cwd: ${requested}`,
      };
    }
    try {
      const st = await stat(safe);
      if (!st.isDirectory()) {
        return {
          status: "failed",
          errorCode: "io_error",
          message: `not a directory: ${requested}`,
        };
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return {
          status: "failed",
          errorCode: "not_found",
          message: `no such directory: ${requested}`,
        };
      }
      return { status: "failed", errorCode: "io_error", message: e.message };
    }

    const lines: string[] = [];
    const skipHidden = args.skipHidden ?? true;
    const isIgnored = await createIgnoreFilter(ctx.cwd);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (ctx.signal.aborted) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (ctx.signal.aborted) return;
        if (skipHidden && entry.name.startsWith(".")) continue;
        const abs = join(dir, entry.name);
        const rel = relative(ctx.cwd, abs);
        if (isIgnored(entry.isDirectory() ? `${rel}/` : rel)) continue;
        lines.push(entry.isDirectory() ? `${rel}/` : rel);
        if (args.recursive && entry.isDirectory() && depth < 16) {
          await walk(abs, depth + 1);
        }
      }
    };

    try {
      await walk(safe, 0);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { status: "failed", errorCode: "io_error", message: e.message ?? String(err) };
    }

    if (ctx.signal.aborted) {
      return { status: "failed", errorCode: "cancelled", message: "aborted" };
    }

    ctx.emit({ kind: "result", text: lines.join("\n") + (lines.length > 0 ? "\n" : "") });
    return { status: "ok" };
  },
};
