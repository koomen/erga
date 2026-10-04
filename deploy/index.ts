// The deploy pipeline's door for the source repo (source/repo.ts): after a
// push or a merge moves staging or main, the repository calls
// deployHook(branch, commit) in the Worker, and the pipeline deploys that
// branch's target (staging: staging.erga.dev, main: erga.dev).
//
// Until the pipeline lands (task #40), this is a stand-in that only logs.
// The pipeline replaces this file; the call and its arguments stay.

export async function deployHook(branch: string, commit: string, ctx?: { env: unknown }): Promise<void> {
  void ctx;
  console.log(`deploy hook: ${branch} is now ${commit.slice(0, 7)} (no deploy pipeline yet)`);
}
