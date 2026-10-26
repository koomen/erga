// The username page's script (server/identity/accounts.ts, usernamePage): as the person types, whether the name is free
// (GET /auth/username?check=).

export default function username(): void {
  const input = document.getElementById("username") as HTMLInputElement,
    hint = document.getElementById("username-hint")!;
  let timer: ReturnType<typeof setTimeout> | undefined,
    asked = "";
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const name = input.value.trim().toLowerCase();
      if (!name || name == asked) return;
      asked = name;
      try {
        const r = await (await fetch("/auth/username?check=" + encodeURIComponent(name))).json();
        if (asked != name) return;
        hint.textContent = r.ok ? '"' + name + '" is free.' : r.problem;
        hint.classList.toggle("error", !r.ok);
      } catch {}
    }, 250);
  });
}
