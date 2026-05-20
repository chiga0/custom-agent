import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
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

const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".vite",
]);

/**
 * `list_files` — enumerate directory entries under cwd. Returns one
 * relative path per line, sorted within each directory. Skips a known
 * set of large build artefacts (`node_modules`, `.git`, `dist`, ...)
 * even when `recursive=true` so the model doesn't drown in noise.
 *
 * Gitignore parsing is intentionally OUT OF SCOPE for M3-02; the
 * skip list approximates the dominant cases (node_modules etc.). A
 * real .gitignore-respecting traversal lands with M3-02b alongside
 * the SessionEngine wiring (where we'll add an `ignore`-style dep).
 */
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
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (ctx.signal.aborted) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (ctx.signal.aborted) return;
        if (skipHidden && entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        const rel = relative(ctx.cwd, abs);
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
