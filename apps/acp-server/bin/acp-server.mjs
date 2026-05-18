#!/usr/bin/env node
// Spawnable binary entry for ACP-compatible editors (Zed et al).
//
// This is intentionally a tiny ESM wrapper: it uses tsx's programmatic
// loader to import the TypeScript source directly, so the binary stays
// runnable straight out of `npm install` without a build step. tsx is a
// runtime dependency declared in package.json.
//
// Per [[adr-0004]] §3 the canonical stdio wire form is this binary;
// daemon (M1-ACP-HTTP) will spawn one child process per session.

import { tsImport } from "tsx/esm/api";

await tsImport("../src/main.ts", import.meta.url);
