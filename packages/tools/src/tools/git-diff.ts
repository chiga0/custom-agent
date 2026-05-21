import { spawn } from "node:child_process";
import type { Tool, ToolOutcome } from "../tool";

export type GitDiffArgs = {
  readonly staged?: boolean;
  readonly ref?: string;
  readonly paths?: readonly string[];
};

export const gitDiffTool: Tool<GitDiffArgs> = {
  name: "git_diff",
  risk: "read",
  description: "Show git diff output for the working directory.",
  async execute(args, ctx) {
    const cmdArgs: string[] = ["diff"];
    if (args.staged) cmdArgs.push("--staged");
    if (args.ref) cmdArgs.push(args.ref);
    if (args.paths && args.paths.length > 0) {
      cmdArgs.push("--");
      cmdArgs.push(...args.paths);
    }

    return new Promise<ToolOutcome>((resolve) => {
      const child = spawn("git", cmdArgs, { cwd: ctx.cwd });

      const onAbort = () => {
        child.kill("SIGTERM");
        resolve({ status: "failed", errorCode: "cancelled", message: "cancelled" });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        ctx.emit({ kind: "result", text: chunk.toString("utf8") });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        ctx.emit({ kind: "stderr", text: chunk.toString("utf8") });
      });

      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (code === 0 || code === 1) {
          resolve({ status: "ok" });
        } else {
          resolve({
            status: "failed",
            errorCode: "unknown",
            message: `git diff exited with code ${code}`,
          });
        }
      });

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ status: "failed", errorCode: "unknown", message: err.message });
      });
    });
  },
};
