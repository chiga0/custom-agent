import { spawn } from "node:child_process";
import type { Tool, ToolOutcome } from "../tool";

export type ApplyPatchArgs = {
  readonly patch: string;
  readonly dryRun?: boolean;
};

export const applyPatchTool: Tool<ApplyPatchArgs> = {
  name: "apply_patch",
  risk: "write",
  description: "Apply a unified diff patch to files in the working directory.",
  async execute(args, ctx) {
    if (!args.patch || args.patch.trim().length === 0) {
      return { status: "failed", errorCode: "unknown", message: "patch content is empty" };
    }

    const cmdArgs: string[] = ["apply"];
    if (args.dryRun) cmdArgs.push("--dry-run");
    cmdArgs.push("-");

    return new Promise<ToolOutcome>((resolve) => {
      const child = spawn("git", cmdArgs, { cwd: ctx.cwd, stdio: ["pipe", "pipe", "pipe"] });

      const onAbort = () => {
        child.kill("SIGTERM");
        resolve({ status: "failed", errorCode: "cancelled", message: "cancelled" });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        ctx.emit({ kind: "stdout", text: chunk.toString("utf8") });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        ctx.emit({ kind: "stderr", text: chunk.toString("utf8") });
      });

      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolve({ status: "ok" });
        } else {
          resolve({
            status: "failed",
            errorCode: "unknown",
            message: `git apply exited with code ${code}`,
          });
        }
      });

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ status: "failed", errorCode: "unknown", message: err.message });
      });

      child.stdin.write(args.patch);
      child.stdin.end();
    });
  },
};
