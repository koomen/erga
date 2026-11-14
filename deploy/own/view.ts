// The Setup tab of the ops page (`bun erga`, deploy/cli/ops-view.ts): the setup in progress, drawn from
// .erga/setup.json alone (store.ts). Pure. The seven steps of the flow (flow.ts), each with its one actor; the step
// that is open now shows what it needs: the question that the agent asked (the answer goes to the agent, never here),
// the plan, the person's button or field, the build's parts, the admin's link. The ops page watches .erga/, so the tab
// follows each answer and each step at once. Its forms post to page.ts.

import { esc } from "../../shared/html";
import { PROXY_FREE_PATHS } from "../proxy-paths";
import { accountName, progress, type StepView, stepsOf } from "./flow";
import { namesOf, pagesOf, sso } from "./plan";
import type { Setup } from "./store";

const WHO: Record<StepView["who"], string> = { answer: "Answer your agent", you: "You", agent: "Agent" };

const opts = (list: [title: string, note: string, recommended?: boolean][]) =>
  `<ol class="s-opts">${list.map(([t, n, r]) => `<li><b>${esc(t)}</b>${r ? ' <span class="s-rec">Recommended</span>' : ""}<small>${esc(n)}</small></li>`).join("")}</ol>`;
const wait = (text: string) => `<p class="s-wait"><span class="s-spin"></span>${esc(text)}</p>`;
const dl = (rows: [string, string][]) => `<dl class="s-plan">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
const secs = (ms: number) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** What the open step needs, under its line. */
function now(s: Setup): string {
  const { answers: a, seen, state } = s.flow;
  const aws = a.where == "aws";
  const domain = a.host.split(".").slice(-2).join(".");
  const problem = s.problem ? `<p class="s-bad" role="alert">${esc(s.problem)}</p>` : "";
  switch (state.at) {
    case "where":
      return opts([
        ["Cloudflare", `The Workers Paid plan, $5 a month. Needs ${domain} on your Cloudflare account.`, true],
        ["AWS", `In your own AWS account. Needs ${domain} in Route 53.`],
      ]);
    case "connect":
      return state.need == "login"
        ? wait(`Waiting for ${aws ? "AWS" : "Cloudflare"}…`)
        : state.need == "choose"
          ? opts(seen.choices.map((c) => (aws ? [c.id, c.name ? `Account ${c.name}` : ""] : [c.name, c.id])))
          : "";
    case "who":
      return state.need == "signIn"
        ? opts([
            ["Only people you invite", "They sign in with GitHub. You invite each one.", true],
            ["Anyone in your company", "People of a GitHub organization or an email domain."],
            [
              "Your company's single sign-on",
              aws ? "Your company's sign-in guards the whole server." : "Cloudflare Access guards the whole server.",
            ],
          ])
        : wait("Waiting for your answer to your agent…");
    case "review": {
      const signIn = sso(a) ? "Your company's sign-in, in the next step" : "A GitHub App, in the next step";
      if (!aws) {
        const n = namesOf(a.host);
        return (
          `<p class="s-fl">Erga will make, in the Cloudflare account ${esc(accountName(s.flow))}</p>` +
          dl([
            ["Worker", `<code>${esc(n.worker)}</code>, at ${esc(a.host)}`],
            ["Database", `D1: <code>${esc(n.database)}</code>${a.stagingOf ? `, a copy of ${esc(a.stagingOf)}'s` : ""}`],
            ["Storage", `R2 bucket: <code>${esc(n.bucket)}</code>`],
            ["DNS", `${esc(a.host)}, with its certificate`],
            ["Sign-in", signIn],
            ["Cost", "The Workers Paid plan: $5 a month"],
          ])
        );
      }
      const res = seen.stack?.resources ?? [];
      return (
        `<p class="s-fl">Erga will make, in one CloudFormation stack (account ${esc(accountName(s.flow))}, ${esc(a.region)})</p>` +
        dl([
          [
            "Network",
            a.egress.includes("/")
              ? `Your own: ${esc(a.egress)}`
              : `A new VPC, with a ${a.egress == "nat-gateway" ? "NAT gateway" : "NAT machine"} for the way out`,
          ],
          ["Machine", "One EC2 machine (t4g.small), with no public address"],
          ["Storage", "An S3 bucket, with a KMS key"],
          [
            "HTTPS",
            sso(a)
              ? `A load balancer, and a certificate for ${esc(a.host)}`
              : `2 CloudFront distributions, and certificates for ${esc(a.host)}`,
          ],
          ["DNS", `${esc(a.host)} and *.${esc(pagesOf(a))}, in Route 53`],
          ["Sign-in", signIn],
          ["Cost", "AWS bills by use: the machine, the way out and the addresses"],
        ]) +
        (res.length
          ? `<details class="s-res"><summary>Each resource of the stack (${res.length})</summary><ul>${res.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details><p class="s-soft">The template is in <code>.erga/aws/</code>. The build's log shows AWS's change set.</p>`
          : "")
      );
    }
    case "app":
      if (state.kind == "github")
        return `<form method="get" action="/setup/github/new"><p class="s-acts"><button class="s-btn">Create the GitHub App on GitHub</button></p>
<label class="s-fl" for="s-org">Under an organization instead (optional)</label><p class="s-row"><input id="s-org" name="org" placeholder="Organization login" autocomplete="off"></p></form>${problem}
<p class="s-soft">The app's secret comes back to this page, and goes into <code>.erga/secrets.json</code>. It never goes to your agent.</p>`;
      if (state.kind == "access")
        return `<ol class="s-todo"><li>In Cloudflare Zero Trust, add a self-hosted application for ${esc(a.host)}, with a policy for who may pass.</li>
<li>Add a second application for the paths that need no sign-in, with a Bypass policy for everyone: <code>${PROXY_FREE_PATHS.map(esc).join("</code>, <code>")}</code>.</li>
<li>Copy the first application's Application Audience (AUD) tag.</li><li>Paste it here, then click Save.</li></ol>
<form method="post" action="/setup/aud"><label class="s-fl" for="s-aud">Audience tag</label><p class="s-row"><input id="s-aud" class="s-mono" name="aud" placeholder="64 letters and digits" autocomplete="off" required><button class="s-btn">Save</button></p></form>${problem}`;
      return `<ol class="s-todo"><li>At your company's sign-in, Erga's client (${esc(a.client)}) needs the callback <code>https://${esc(a.host)}/oauth2/idpresponse</code>.</li>
<li>Type the client's secret here, then click Save.</li></ol>
<form method="post" action="/setup/secret"><label class="s-fl" for="s-secret">Client secret</label><p class="s-row"><input id="s-secret" name="secret" type="password" autocomplete="off" required><button class="s-btn">Save</button></p></form>${problem}
<p class="s-soft">It goes to AWS Secrets Manager in your account, where the stack reads it. It never goes to your agent, or into a file.</p>`;
    case "build": {
      const parts = s.build.parts;
      const failed = s.build.failed;
      return (
        (parts.length
          ? `<ol class="s-parts">${parts
              .map((p, i) => {
                const stopped = p.ms == null && !!failed && i == parts.length - 1;
                return `<li class="${p.ms != null ? "ok" : stopped ? "bad" : "run"}">${esc(p.title)}<small>${p.ms != null ? secs(p.ms) : stopped ? "stopped" : "working"}</small></li>`;
              })
              .join("")}</ol>`
          : failed
            ? ""
            : wait("Your agent starts the build…")) +
        (failed
          ? `<p class="s-bad" role="alert">${esc(failed)}</p><p class="s-soft">Your agent fixes what it can, and runs the build again.</p>`
          : "")
      );
    }
    case "admin":
      return s.approve
        ? `<p class="s-acts"><a class="s-btn" href="/setup/claim" target="_blank" rel="noopener">Open ${esc(a.host)} and ${a.stagingOf ? "approve" : "sign in"}</a></p>
<p class="s-soft">${a.stagingOf ? "Approve it as an admin." : "This link works one time, for 30 minutes."} Only this page shows it.</p>`
        : wait("Your agent's command makes the link. If it stopped, tell your agent to go on.");
    case "done":
      return "";
  }
}

/** The Setup tab's content for the setup in progress. */
export function setupHtml(s: Setup): string {
  const { answers: a, state } = s.flow;
  const steps = stepsOf(s.flow, s.github?.slug || s.github?.clientId || "");
  const app = s.github?.url ? ` <a href="${esc(s.github.url)}" target="_blank" rel="noopener">Open it on GitHub</a>` : "";
  const list = steps
    .map((x) => {
      const fix = x.state == "now" && state.at == "connect" && state.need == "fix";
      const inner = x.state == "now" ? now(s) : "";
      return `<li class="s-step ${x.state}${fix ? " fail" : ""}"><span class="s-dot"></span><span class="s-t">${esc(x.title)}</span><span class="s-who ${x.who == "agent" ? "" : "person"}">${WHO[x.who]}</span><span class="s-d">${esc(x.detail)}${x.id == "app" && x.state == "done" ? app : ""}</span>${inner ? `<div class="s-n">${inner}</div>` : ""}</li>`;
    })
    .join("");
  const done =
    state.at == "done"
      ? `<aside class="s-card s-made"><h3>${esc(a.host)} is live</h3><p>The secrets are in <code>.erga/secrets.json</code> in this folder. Keep a copy in a password manager.</p>
<p class="s-acts"><a class="s-btn" href="https://${esc(a.host)}/" target="_blank" rel="noopener">Open Erga</a><a class="s-btn quiet" href="https://${esc(a.host)}/admin/settings" target="_blank" rel="noopener">Settings</a></p>
<p class="s-fl">Add later, in Settings</p><ul class="s-later"><li>Google sign-in</li><li>A feedback repository</li><li>The homepage</li></ul>
<p class="s-soft">A staging instance: <code>bun erga setup &lt;its address&gt; --staging-of ${esc(a.stagingOf || a.host)}</code></p></aside>`
      : "";
  return `<div class="s-wrap${done ? "" : " s-one"}"><div class="s-main"><p class="s-sub">${esc(progress(steps))}</p><ol class="s-steps">${list}</ol></div>${done}</div>`;
}
