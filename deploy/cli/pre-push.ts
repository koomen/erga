// The pre-push hook (deploy/cli/hooks/pre-push): a push to staging or main stops, unless `bun erga` makes it
// (ERGA_CLI_PUSH). git gives each ref of the push on stdin: <local ref> <local sha> <remote ref> <remote sha>.

import { pushRefusal } from "./flow";

const lines = (await new Response(Bun.stdin.stream()).text()).split("\n").filter(Boolean);
for (const line of lines) {
  const remoteRef = line.split(" ")[2] ?? "";
  const no = pushRefusal(remoteRef, process.env.ERGA_CLI_PUSH == "1");
  if (no) {
    console.error(`erga: ${no}`);
    process.exit(1);
  }
}
