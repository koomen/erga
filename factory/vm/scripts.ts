// The VM's job scripts (this folder's *.ts but the agent and the build), as
// text, bundled into the Worker: FactoryVm (factory/cloudflare.ts) sends them
// with each job, and the image's agent runs them (factory/vm/agent.ts). So a
// change to a script ships with the Worker's version, and the image changes
// only with its Dockerfile and agent (factory/vm/build.ts, imageTag; deploy/targets.json, factory.image).
//
// Vite's ?raw imports: the Worker's build and the dev server only (Bun runs
// the scripts from the files themselves).

import common from "./common.ts?raw";
import fakeClaude from "./fake-claude.ts?raw";
import merge from "./merge.ts?raw";
import run from "./run.ts?raw";
import task from "./task.ts?raw";

export const VM_SCRIPTS: Record<string, string> = { "common.ts": common, "fake-claude.ts": fakeClaude, "merge.ts": merge, "run.ts": run, "task.ts": task };
