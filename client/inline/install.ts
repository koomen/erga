// The install page's script (/deploy, control/install/page.ts, deployPage): connect Cloudflare, choose where the new
// Erga goes (and buy a domain), the agent, then the install and its progress. It asks /deploy/api/* and redraws.

import { esc as escText } from "../../shared/html";

/** What the page's server gives the script. */
export interface InstallConfig {
  login: string;
  mock: boolean;
  tokenUrl: string;
  tokenUrlRegistrar: string;
  controlWorker: string;
  release: { version: string; built: string; from: string } | null;
}

/** Any value as HTML text. */
const esc = (s: unknown) => escText(String(s));

export default function install(C: InstallConfig): void {
  const $ = (id: string): any => document.getElementById(id);
  const S: any = {
    info: null,
    accounts: [],
    account: null,
    sub: null,
    createSub: false,
    zones: [],
    plan: null,
    step: "connect",
    polling: false,
  };
  const order = ["connect", "where", "agent", "deploy"];

  async function api(path: string, body?: unknown): Promise<any> {
    const r = await fetch(
      "/deploy/api/" + path,
      body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    ).catch(() => null);
    const answer = r ? await r.json().catch(() => null) : null;
    if (!r) throw new Error("Couldn't reach Erga: check your connection and try again.");
    if (!answer || answer.ok === false) throw new Error((answer && answer.error) || "Something went wrong (" + r.status + "). Try again.");
    return answer;
  }
  const say = (id: string, text?: string) => {
    $(id).textContent = text || "";
  };
  const busy = (button: any, on: boolean, text?: string) => {
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = text;
    } else if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = on;
  };

  function go(step: string) {
    S.step = step;
    const at = order.indexOf(step);
    for (const s of order) {
      const li = $("s-" + s),
        i = order.indexOf(s);
      li.classList.toggle("current", i == at);
      li.classList.toggle("done", i < at);
      li.classList.toggle("later", i > at);
      li.querySelector(".change") &&
        (li.querySelector(".change").hidden = !(i < at) || !!(S.info && S.info.run && S.info.run.status != "failed"));
    }
  }
  document.addEventListener("click", (e: any) => {
    const a = e.target.closest("[data-goto]");
    if (a) {
      e.preventDefault();
      if (a.dataset.goto == "connect") {
        api("forget", {}).catch(() => {});
        S.info = { connected: false };
      }
      go(a.dataset.goto);
    }
    const c = e.target.closest("[data-copy]");
    if (c) {
      navigator.clipboard.writeText($(c.dataset.copy).textContent).then(() => {
        c.textContent = "Copied";
        setTimeout(() => (c.textContent = "Copy"), 1200);
      });
    }
  });

  $("with-registrar") &&
    $("with-registrar").addEventListener("change", (e: any) => {
      $("token-link").href = e.target.checked ? C.tokenUrlRegistrar : C.tokenUrl;
    });
  $("connect").addEventListener("click", async () => {
    say("connect-error");
    busy($("connect"), true, "Checking…");
    try {
      const r = await api("connect", { token: $("token").value });
      $("token").value = "";
      await loaded({ connected: true, via: "token", accounts: r.accounts, run: null });
    } catch (e: any) {
      say("connect-error", e.message);
    }
    busy($("connect"), false);
  });
  $("token").addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key == "Enter") $("connect").click();
  });

  /** After connecting: the accounts, then the chosen one's subdomain and domains. */
  async function loaded(info: any) {
    S.info = info;
    S.accounts = info.accounts || [];
    $("sum-connect").textContent =
      "Connected " +
      (info.via == "oauth" ? "with Cloudflare's authorization" : "with an API token") +
      ": " +
      S.accounts.map((a: any) => a.name).join(", ");
    $("account").innerHTML = S.accounts.map((a: any) => '<option value="' + a.id + '">' + esc(a.name) + "</option>").join("");
    $("account-field").hidden = S.accounts.length < 2;
    await chooseAccount(S.accounts[0] && S.accounts[0].id);
    if (info.run) return showRun(info.run);
    // Where it goes, chosen before (a reload): kept in this tab.
    let kept = null;
    try {
      kept = JSON.parse(sessionStorage.getItem("erga-install-where") || "null");
    } catch {}
    if (kept && kept.accountId == S.account) {
      S.where = kept;
      whereChosen(kept);
      go("agent");
      return;
    }
    go("where");
  }
  $("account").addEventListener("change", (e: any) => chooseAccount(e.target.value));
  async function chooseAccount(id: string) {
    if (!id) return;
    S.account = id;
    say("where-error");
    try {
      const r = await api("account", { accountId: id });
      S.sub = r.subdomain;
      S.zones = r.zones.filter((z: any) => z.status == "active" || z.status == "pending");
    } catch (e: any) {
      say("where-error", e.message);
      S.sub = null;
      S.zones = [];
    }
    $("sub-new").hidden = !!S.sub;
    const zones = S.zones.map((z: any) => '<option value="' + z.id + '">' + esc(z.name) + "</option>").join("");
    const none = '<option value="">No domains in this account yet</option>';
    $("app-zone").innerHTML = zones || none;
    $("pages-zone").innerHTML = zones || none;
    if (S.zones[1]) $("pages-zone").value = S.zones[1].id;
    for (const id of ["app-domain-choice", "pages-zone-choice"]) $(id).querySelector("input").disabled = !S.zones.length;
    zoneChanged();
    names();
  }
  function sub() {
    return S.sub || $("subdomain").value.trim().toLowerCase() || "your-subdomain";
  }
  function names() {
    $("app-wd").textContent = "erga." + sub() + ".workers.dev";
    $("pages-wd").textContent = "erga-pages." + sub() + ".workers.dev";
  }
  $("subdomain").addEventListener("input", names);
  function zoneChanged() {
    const z = S.zones.find((z: any) => z.id == $("app-zone").value);
    if (z && (!$("app-host").value || !$("app-host").dataset.touched)) $("app-host").value = z.name;
  }
  $("app-zone").addEventListener("change", () => {
    $("app-host").dataset.touched = "";
    zoneChanged();
    (document.querySelector("input[name=app][value=domain]") as HTMLInputElement).checked = true;
  });
  $("app-host").addEventListener("input", () => {
    $("app-host").dataset.touched = "1";
    (document.querySelector("input[name=app][value=domain]") as HTMLInputElement).checked = true;
  });
  $("pages-zone").addEventListener("change", () => {
    (document.querySelector("input[name=pages][value=zone]") as HTMLInputElement).checked = true;
  });

  function where() {
    const appKind = (document.querySelector("input[name=app]:checked") as HTMLInputElement).value;
    const pagesKind = (document.querySelector("input[name=pages]:checked") as HTMLInputElement).value;
    const zone = (id: string) => S.zones.find((z: any) => z.id == id);
    const app =
      appKind == "domain"
        ? {
            kind: "domain",
            zoneId: $("app-zone").value,
            zoneName: (zone($("app-zone").value) || {}).name || "",
            hostname: $("app-host").value.trim().toLowerCase(),
          }
        : { kind: "workers.dev" };
    const pages =
      pagesKind == "zone"
        ? { kind: "zone", zoneId: $("pages-zone").value, zoneName: (zone($("pages-zone").value) || {}).name || "" }
        : { kind: "shared" };
    return { accountId: S.account, workerName: "erga", subdomain: sub(), createSubdomain: !S.sub, app, pages };
  }
  const appUrl = (w: any) => "https://" + (w.app.kind == "domain" ? w.app.hostname : w.workerName + "." + w.subdomain + ".workers.dev");
  const pagesAt = (w: any) =>
    w.pages.kind == "zone" ? "<document>." + w.pages.zoneName : w.workerName + "-pages." + w.subdomain + ".workers.dev";
  $("where-next").addEventListener("click", () => {
    say("where-error");
    const w = where();
    if (!S.sub && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test($("subdomain").value.trim().toLowerCase()))
      return say("where-error", "Choose a workers.dev subdomain: lowercase letters, digits and dashes.");
    if (w.app.kind == "domain" && !(w.app.hostname == w.app.zoneName || w.app.hostname.endsWith("." + w.app.zoneName)))
      return say("where-error", "The app's address must be " + w.app.zoneName + " or a name under it.");
    if (w.app.kind == "domain" && w.pages.kind == "zone" && w.app.zoneId == w.pages.zoneId)
      return say("where-error", "Documents' pages need a different domain from the app's: pick another, or the shared pages address.");
    S.where = w;
    try {
      sessionStorage.setItem("erga-install-where", JSON.stringify(w));
    } catch {}
    whereChosen(w);
    go("agent");
  });
  /** The control Worker's address beside the app's (control/install/install.ts, controlHostOf): shown before the install. */
  function controlHost(w: any) {
    if (w.app.kind == "workers.dev") return C.controlWorker + "." + w.subdomain + ".workers.dev";
    const host = w.app.hostname,
      zone = w.app.zoneName;
    if (host == zone) return "ops." + zone;
    const parts = host.split(".");
    return parts[0] + "-ops." + parts.slice(1).join(".");
  }
  /** Staging's address beside the app's (control/install/install.ts, stagingHostOf): the control Worker deploys it after the install. */
  function stagingHost(w: any) {
    if (w.app.kind == "workers.dev") return w.workerName + "-staging." + w.subdomain + ".workers.dev";
    const host = w.app.hostname,
      zone = w.app.zoneName;
    if (host == zone) return "staging." + zone;
    const parts = host.split(".");
    return parts[0] + "-staging." + parts.slice(1).join(".");
  }
  function whereChosen(w: any) {
    $("sum-where").textContent =
      appUrl(w) + " · pages on " + pagesAt(w) + " · control at " + controlHost(w) + " · staging at " + stagingHost(w);
  }

  // Buying a domain: search, see the price, confirm it, buy.
  $("search").addEventListener("click", async () => {
    say("buy-error");
    $("offers").innerHTML = "";
    busy($("search"), true, "Searching…");
    try {
      const r = await api("domains/search", { accountId: S.account, q: $("q").value });
      $("offers").innerHTML = r.offers.length
        ? r.offers
            .map(
              (o: any, i: number) =>
                '<li><span class="name">' +
                esc(o.name) +
                "</span>" +
                (o.registrable
                  ? '<span class="price">' +
                    esc(o.price + " " + o.currency) +
                    '</span><span class="why">/ year</span><button class="pill small" data-buy="' +
                    i +
                    '">Buy…</button>'
                  : '<span class="why">' + esc(o.reason || "not available") + "</span>") +
                "</li>"
            )
            .join("")
        : '<li class="why">Nothing found: try another name.</li>';
      S.offers = r.offers;
    } catch (e: any) {
      say("buy-error", e.message);
    }
    busy($("search"), false);
  });
  $("q").addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key == "Enter") $("search").click();
  });
  $("offers").addEventListener("click", (e: any) => {
    const b = e.target.closest("[data-buy]");
    if (!b) return;
    const o = S.offers[+b.dataset.buy];
    S.buying = o;
    $("buy-name").textContent = o.name;
    $("buy-price").textContent = o.price + " " + o.currency;
    $("buy-renewal").textContent =
      "for the first year; it renews at " + o.renewal + " " + o.currency + " a year (auto-renew starts off: turn it on in your dashboard).";
    $("buy-ok").checked = false;
    $("buy-go").disabled = true;
    $("buy-go").textContent = "Buy for " + o.price + " " + o.currency;
    say("confirm-error");
    $("confirm-buy").showModal();
  });
  $("buy-ok").addEventListener("change", (e: any) => {
    $("buy-go").disabled = !e.target.checked;
  });
  $("buy-cancel").addEventListener("click", () => $("confirm-buy").close());
  $("buy-go").addEventListener("click", async () => {
    const o = S.buying;
    if (!$("buy-ok").checked) return;
    busy($("buy-go"), true, "Buying…");
    $("buy-cancel").disabled = true;
    try {
      const r = await api("domains/register", { accountId: S.account, name: o.name, price: o.price, currency: o.currency });
      $("confirm-buy").close();
      await chooseAccount(S.account);
      const z = S.zones.find((z: any) => z.name == o.name);
      if (z) {
        $("app-zone").value = z.id;
        $("app-host").dataset.touched = "";
        zoneChanged();
        (document.querySelector("input[name=app][value=domain]") as HTMLInputElement).checked = true;
      }
      $("offers").innerHTML =
        '<li><span class="name">' +
        esc(o.name) +
        '</span><span class="why">' +
        (r.completed
          ? "Registered: it's yours, and chosen as the app's address."
          : "Registration in progress: it shows up in your domains when it's done.") +
        "</span></li>";
      $("buy").open = true;
    } catch (e: any) {
      say("confirm-error", e.message);
    }
    busy($("buy-go"), false);
    $("buy-cancel").disabled = false;
  });

  $("agent-next").addEventListener("click", () => {
    say("agent-error");
    const key = $("anthropic").value.trim();
    if (key && !key.startsWith("sk-"))
      return say("agent-error", "An Anthropic API key starts with sk-; leave it empty to go without the agent.");
    const signIn = "GitHub, through Erga's GitHub App";
    $("sum-agent").textContent = "Sign-in with " + signIn + (key ? ", with the agent" : ", without the agent");
    const w = S.where;
    $("review").innerHTML = [
      ["Account", (S.accounts.find((a: any) => a.id == w.accountId) || {}).name],
      ["Address", appUrl(w)],
      ["Documents' pages", pagesAt(w) + (w.pages.kind == "shared" ? " (shared)" : " (one origin each)")],
      ["Control Worker", "https://" + controlHost(w) + " (keeps it up to date)"],
      [
        "Release",
        C.release ? C.release.version + (C.release.from == "stable" ? ", the latest on stable" : ", from " + C.release.from) : "none",
      ],
      ["Worker", w.workerName + (w.createSubdomain ? ", on a new workers.dev subdomain " + w.subdomain : "")],
      ["Database", "D1, “erga”"],
      ["Admin", C.login + " (you)"],
      ["Sign-in", signIn],
      ["Agent", key ? "on (your Anthropic key)" : "off"],
    ]
      .map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v || "") + "</dd>")
      .join("");
    go("deploy");
  });

  $("go").addEventListener("click", async () => {
    say("deploy-error");
    const plan = {
      ...S.where,
      admin: C.login,
      anthropicKey: $("anthropic").value.trim() || undefined,
      ...(new URLSearchParams(location.search).get("version") ? { version: new URLSearchParams(location.search).get("version") } : {}),
    };
    S.plan = plan;
    busy($("go"), true, "Starting…");
    try {
      const r = await api("start", { plan });
      showRun(r.run);
    } catch (e: any) {
      say("deploy-error", e.message);
    }
    busy($("go"), false);
  });
  $("retry").addEventListener("click", async () => {
    say("run-error");
    $("run-actions").hidden = true;
    try {
      const r = await api("start", { plan: S.plan });
      showRun(r.run);
    } catch (e: any) {
      say("run-error", e.message);
      $("run-actions").hidden = false;
    }
  });
  $("restart").addEventListener("click", () => {
    $("run-box").hidden = true;
    $("review-box").hidden = false;
    S.info.run = null;
    go("where");
  });

  const ICONS: Record<string, string> = { done: "✓", skipped: "–", failed: "!", running: "", pending: "" };
  function showRun(run: any) {
    S.info = { ...(S.info || {}), run };
    go("deploy");
    for (const s of ["connect", "where", "agent"])
      if (!$("sum-" + s).textContent)
        $("sum-" + s).textContent = s == "where" ? run.summary.app + " · pages on " + run.summary.pages : "Done";
    $("review-box").hidden = true;
    $("run-box").hidden = false;
    $("progress").innerHTML = run.steps
      .map(
        (s: any) =>
          '<li class="' +
          s.status +
          '" data-id="' +
          s.id +
          '"><span class="icon">' +
          ICONS[s.status] +
          "</span><span>" +
          esc(s.title) +
          "</span>" +
          (s.detail ? '<span class="detail">' + esc(s.detail) + "</span>" : "") +
          "</li>"
      )
      .join("");
    say("run-error", run.status == "failed" ? run.error : "");
    $("run-actions").hidden = run.status != "failed";
    $("sum-deploy").textContent = run.status == "running" ? "Installing…" : run.status == "done" ? "Installed" : "Stopped";
    if (run.status == "done") {
      const tokenWay = S.info.via != "oauth";
      try {
        sessionStorage.removeItem("erga-install-where");
      } catch {}
      $("live").hidden = false;
      $("live").innerHTML =
        "<h3>Your Erga is live</h3><p><a class='new' id='open-new' href='" +
        esc(run.result.url) +
        "' target='_blank' rel='noopener'>Open " +
        esc(run.result.url.replace("https://", "")) +
        " ↗</a></p>" +
        "<p>Sign in there with GitHub as <b>" +
        esc(C.login) +
        "</b>: you're its admin, and add everyone else on its Admin page. Its homepage is made the first time it's opened, yours to edit.</p>" +
        "<p><b>One more step, so it keeps itself up to date:</b> open <a href='" +
        esc(run.result.control + "/install") +
        "' target='_blank' rel='noopener'>" +
        esc(run.result.control.replace("https://", "")) +
        "/install ↗</a>, sign in with GitHub, and connect Cloudflare there (a consent, like the one here). Its control Worker then upgrades it from Erga's releases by itself, and rolls back by itself when an upgrade fails its health check.</p>" +
        "<p class='muted'>" +
        (tokenWay
          ? "Erga has forgotten your Cloudflare token. You can delete it now: <a href='https://dash.cloudflare.com/profile/api-tokens' target='_blank' rel='noopener'>API Tokens on Cloudflare ↗</a> (it's called “Erga deploy”)."
          : "Erga has forgotten its access to your account and given it back to Cloudflare. <a href='https://dash.cloudflare.com/?to=/profile/access-management/authorization' target='_blank' rel='noopener'>Your OAuth authorizations ↗</a>.") +
        "</p>";
    }
    if (run.status == "running" && !S.polling) poll();
  }
  async function poll() {
    S.polling = true;
    while (true) {
      await new Promise((r) => setTimeout(r, 700));
      const info = await api("session").catch(() => null);
      if (!info || !info.run) continue;
      S.info = { ...S.info, ...info };
      showRun(info.run);
      if (info.run.status != "running") break;
    }
    S.polling = false;
  }

  go("connect");
  api("session")
    .then((info) => {
      if (info.connected || info.run) return loaded(info);
    })
    .catch(() => {});
}
