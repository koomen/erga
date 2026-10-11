// Cookies named for the port in local development (worker/cookies.ts): two dev servers on localhost never read or
// write each other's; a real hostname's names stay as they are.
import { describe, expect, test } from "bun:test";
import { cookieName, cookies } from "../cloudflare/cookies";

const req = (url: string, cookie = "") => new Request(url, { headers: cookie ? { cookie } : {} });

describe("cookies", () => {
  test("locally, each port's names are its own", () => {
    expect(cookieName(req("http://localhost:4400/"), "erga_session")).toBe("erga_session_4400");
    expect(cookieName(req("http://127.0.0.1:4512/docs"), "erga_session")).toBe("erga_session_4512");
    expect(cookieName(req("http://erga.localhost:4512/"), "erga_session")).toBe("erga_session_4512");
    const jar = "erga_session_4400=a; erga_session_4512=b; erga_signed_out=1; other=x";
    expect([...cookies(req("http://localhost:4400/", jar))]).toEqual([["erga_session", "a"]]);
    expect([...cookies(req("http://localhost:4512/", jar))]).toEqual([["erga_session", "b"]]);
    expect(cookies(req("http://localhost:4600/", jar)).size).toBe(0);
  });

  test("on a real hostname, the names are as they are", () => {
    expect(cookieName(req("https://erga.dev/"), "erga_session")).toBe("erga_session");
    expect(cookieName(req("https://staging.erga.dev:8443/"), "erga_session")).toBe("erga_session");
    expect(cookies(req("https://erga.dev/", "erga_session=a; b=c=d")).get("b")).toBe("c=d");
    expect(cookies(req("https://erga.dev/", "erga_session=a")).get("erga_session")).toBe("a");
  });
});
