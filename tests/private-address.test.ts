// The addresses the server's own browser refuses (shared/private-address.ts): the machine, private networks, a
// cloud's metadata service; and Erga's own two addresses, which it always reaches.

import { expect, test } from "bun:test";
import { privateHost, reachable } from "../shared/private-address";

const OWN = ["http://127.0.0.1:4712", "http://abc-ada.localhost:4712"];

test("the machine itself, private networks and the metadata service are refused, in every way a URL writes them", () => {
  for (const url of [
    "http://127.0.0.1:9222/json",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://0.0.0.0:8787/",
    "http://localhost:3000/",
    "http://db.localhost/",
    "http://LOCALHOST./",
    "http://10.0.0.5/admin",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://100.64.0.1/",
    "http://[::1]:9222/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://intranet/",
    "http://ip-10-0-0-7.ec2.internal/",
    "http://printer.local/",
    "ws://127.0.0.1:9222/devtools/browser/x",
    "https://192.168.0.10/",
    "file:///etc/passwd",
    "not a url",
  ])
    expect([url, reachable(url, OWN)]).toEqual([url, false]);
});

test("public addresses, addresses of no network, and Erga's own two addresses are reached", () => {
  for (const url of [
    "https://example.com/",
    "http://93.184.216.34/",
    "https://fonts.googleapis.com/css2?family=Inter",
    "https://172.15.0.1/",
    "https://172.32.0.1/",
    "https://[2606:4700::1111]/",
    "wss://example.com/socket",
    "data:text/html,hi",
    "blob:http://abc-ada.localhost:4712/1234",
    "about:blank",
    // Erga's app and the document's pages: private addresses in local development, and its own.
    "http://127.0.0.1:4712/d/abc",
    "http://abc-ada.localhost:4712/t/token/index.html",
    "ws://127.0.0.1:4712/d/abc/api/room",
  ])
    expect([url, reachable(url, OWN)]).toEqual([url, true]);
  // Another port of the same machine is not Erga's own.
  expect(reachable("http://127.0.0.1:4713/", OWN)).toBe(false);
  expect(reachable("http://other-bo.localhost:4712/", OWN)).toBe(false);
  expect(privateHost("erga.dev")).toBe(false);
});
