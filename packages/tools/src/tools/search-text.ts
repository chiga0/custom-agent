import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createIgnoreFilter } from "../gitignore";
import { resolveInsideCwd } from "../path-safety";
import type { Tool, ToolContext, ToolOutcome } from "../tool";

export type SearchTextArgs = {
  /** Substring to search for (literal, case-sensitive by default). */
  readonly query: string;
  /** Subdirectory under cwd to search. Defaults to cwd itself. */
  readonly path?: string;
  /** Case-insensitive match. Default false. */
  readonly caseInsensitive?: boolean;
  /** Stop after N matches. Default 200. */
  readonly maxMatches?: number;
};

const TEXT_FILE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
  ".txt",
  ".env",
]);

function looksTextual(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return true; // no extension — treat as text
  return TEXT_FILE_EXTS.has(filename.slice(dot).toLowerCase());
}

/**
 * `search_text` — literal substring search across text files under
 * cwd. Returns one match per line in `<relpath>:<lineNo>:<lineText>`
 * format (ripgrep-style). Skips the same build directories as
 * `list_files`. Binary / unknown-extension files are skipped to keep
 * latency + budget reasonable.
 *
 * NOT a regex engine — query is a literal substring. Future work
 * (M3-03 or later) may add a regex variant + ripgrep-on-PATH fallback.
 */
export const searchTextTool: Tool<SearchTextArgs> = {
  name: "search_text",
  risk: "read",
  description: "Search for a literal substring across text files under cwd.",
  async execute(args, ctx: ToolContext): Promise<ToolOutcome> {
    if (!args.query) {
      return { status: "failed", errorCode: "io_error", message: "query is empty" };
    }
    const root = resolveInsideCwd(ctx.cwd, args.path ?? ".");
    if (!root) {
      return {
        status: "failed",
        errorCode: "path_unsafe",
        message: `path resolves outside cwd: ${args.path ?? "."}`,
      };
    }
    try {
      const st = await stat(root);
      if (!st.isDirectory() && !st.isFile()) {
        return {
          status: "failed",
          errorCode: "io_error",
          message: "target is not a file or directory",
        };
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        status: "failed",
        errorCode: e.code === "ENOENT" ? "not_found" : "io_error",
        message: e.message,
      };
    }

    const haystackQuery = args.caseInsensitive ? args.query.toLowerCase() : args.query;
    const max = args.maxMatches ?? 200;
    let matches = 0;
    const hits: string[] = [];
    const isIgnored = await createIgnoreFilter(ctx.cwd);

    const search = async (filePath: string): Promise<boolean> => {
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        // Best-effort: skip files we can't read (binary, permissions, etc.).
        return true;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const haystack = args.caseInsensitive ? lines[i].toLowerCase() : lines[i];
        if (haystack.includes(haystackQuery)) {
          hits.push(`${relative(ctx.cwd, filePath)}:${i + 1}:${lines[i]}`);
          matches += 1;
          if (matches >= max) return false; // stop walk
        }
      }
      return true;
    };

    const walk = async (dir: string, depth: number): Promise<boolean> => {
      if (ctx.signal.aborted) return false;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (ctx.signal.aborted) return false;
        if (entry.name.startsWith(".")) continue;
        const abs = join(dir, entry.name);
        const rel = relative(ctx.cwd, abs);
        if (entry.isDirectory()) {
          if (isIgnored(`${rel}/`)) continue;
          if (depth >= 32) continue;
          if (!(await walk(abs, depth + 1))) return false;
        } else if (entry.isFile()) {
          if (isIgnored(rel)) continue;
          if (!looksTextual(entry.name)) continue;
          if (!(await search(abs))) return false;
        }
      }
      return true;
    };

    try {
      const rootStat = await stat(root);
      if (rootStat.isFile()) {
        await search(root);
      } else {
        await walk(root, 0);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { status: "failed", errorCode: "io_error", message: e.message ?? String(err) };
    }

    if (ctx.signal.aborted) {
      return { status: "failed", errorCode: "cancelled", message: "aborted" };
    }

    ctx.emit({ kind: "result", text: hits.join("\n") + (hits.length > 0 ? "\n" : "") });
    return { status: "ok" };
  },
};
