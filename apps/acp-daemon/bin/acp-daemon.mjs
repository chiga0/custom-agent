#!/usr/bin/env node
// Spawnable binary entry for the ACP HTTP+SSE daemon.
//
// Tiny ESM wrapper that uses tsx's programmatic loader to import the
// TypeScript source directly, so the binary stays runnable straight out
// of `npm install` without a build step. tsx is declared as a runtime
// dependency in package.json.
//
// Per [[adr-0004]] §3-§5 this daemon is the HTTP+SSE gateway in front of
// per-session `apps/acp-server` child processes.

import { tsImport } from "tsx/esm/api";

await tsImport("../src/main.ts", import.meta.url);
