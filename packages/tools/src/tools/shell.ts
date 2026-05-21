import { spawn } from "node:child_process";
import { classifyShellCommand } from "../risk-classifier";
import type { Tool, ToolOutcome } from "../tool";

export type ShellArgs = {
  readonly command: string;
  readonly timeout?: number;
};

export const shellTool: Tool<ShellArgs> = {
  name: "shell",
  risk: "execute",
  description: "Execute a shell command in the session working directory.",
  async execute(args, ctx) {
    const classification = classifyShellCommand(args.command);
    if (classification === "deny") {
      return {
        status: "failed",
        errorCode: "permission_denied",
        message: `command matches shell denylist: ${args.command}`,
      };
    }

    const timeout = args.timeout ?? 30_000;
    return new Promise<ToolOutcome>((resolve) => {
      const child = spawn("sh", ["-c", args.command], {
        cwd: ctx.cwd,
        env: process.env,
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({
          status: "failed",
          errorCode: "cancelled",
          message: `command timed out after ${timeout}ms`,
        });
      }, timeout);

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
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolve({ status: "ok" });
        } else {
          resolve({
            status: "failed",
            errorCode: "unknown",
            message: `command exited with code ${code}`,
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ status: "failed", errorCode: "unknown", message: err.message });
      });
    });
  },
};
