// Bad input on the room's socket and on the document's API does no harm: a path that tries to leave the document
// reads and writes nothing outside it, random bytes and a storm of sockets leave the room up and its text as it
// was, and a megabyte pasted at once reaches everyone and storage. These four have no page: the clients are hostile
// or clumsy programs. After each, the server still answers, and an edit still goes from one newcomer to another.
// The last test has a page: markup that breaks a paragraph locks it, and the page offers a fix by the agent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { FIX_REPORTED } from "../../shared/page-report";
import { openEditor } from "../helpers/editor";
import { expect, servers, test, until } from "../helpers/fixtures";
import { converged, crowd, random, roomOf, SEED, type Room } from "./room";

const s = await servers.main();

/** A copy of the page fixture as a new document: its room and its folder on disk. */
async function newDoc() {
  const { dir, address } = await s.fixture("page");
  return { dir, room: roomOf(address) };
}

/** The room is up: the server answers, and an edit goes from one newcomer to another. With `text`: the room still holds it. */
async function stillHealthy(people: ReturnType<typeof crowd>, room: Room, text?: string) {
  expect((await fetch(`${room.base}/api/doc`)).status).toBe(200);
  const [x, y] = [await people.join(room, "Xavier"), await people.join(room, "Yan")];
  if (text != null) expect(x.str()).toBe(text);
  x.insertAfter("<h1>", "ALIVE ");
  await until(() => y.str().includes("<h1>ALIVE "), 3000, "an edit still goes from one person to another");
}

/** A request with its path as written: fetch takes "../" out of a path before it sends it, a hostile client does not. */
const raw = (address: string, path: string, method = "GET", body = "") =>
  new Promise<{ status: number; body: string }>((done, fail) => {
    const u = new URL(address);
    const r = request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${path}`, method, headers: { "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: text }));
      }
    );
    r.on("error", fail);
    r.end(body);
  });

/** Opens a socket to the room, sends `messages`, and closes it. The room handles a socket's frames in order, so when its close comes back, it has handled them all. */
function socket(room: Room, messages: Uint8Array<ArrayBuffer>[], when: "open" | "first message" = "open"): Promise<void> {
  return new Promise((done) => {
    const ws = new WebSocket(room.socket);
    ws.binaryType = "arraybuffer";
    const go = () => {
      if (ws.readyState != WebSocket.OPEN) return;
      for (const m of messages) ws.send(m);
      ws.close();
    };
    if (when == "open") ws.onopen = go;
    else ws.onmessage = go;
    ws.onclose = () => done();
    ws.onerror = () => done();
  });
}

test("a path that tries to leave the document reads and writes nothing outside it", async () => {
  const people = crowd();
  try {
    const { dir, room } = await newDoc();
    // A file beside the document's folder, and a file far outside it.
    const secret = join(dirname(dir), `secret-${SEED}.txt`);
    writeFileSync(secret, "the secret of another document");
    const up = `../secret-${SEED}.txt`;
    const paths = [
      up,
      up.replace("../", "..%2f"),
      up.replace("../", "%2e%2e/"),
      up.replace("../", "%2e%2e%2f"),
      up.replace("../", "....//"),
      "../../../../../../../../etc/passwd",
      "..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd",
      "/etc/passwd",
      ".git/config",
    ];
    const passwd = readFileSync("/etc/passwd", "utf8").slice(0, 200);
    // Each path two ways: as a hostile program writes it, and as a page's script sends it (fetch).
    const senders = [
      (path: string, method?: string, body?: string) => raw(room.base, path, method, body),
      async (path: string, method = "GET", body?: string) => {
        const r = await fetch(`${room.base}${path}`, { method, body, redirect: "manual" });
        return { status: r.status, body: await r.text() };
      },
    ];
    await Promise.all(
      paths.flatMap((p) =>
        senders.map(async (send) => {
          const [read, served, write] = await Promise.all([
            send(`/api/stored/${p}`),
            send(`/doc/${p}`),
            send(`/api/stored/${p}`, "PUT", "pwned"),
          ]);
          expect(read.status, `GET stored ${p}`).toBeGreaterThanOrEqual(400);
          expect(read.status, `GET stored ${p}`).toBeLessThan(500);
          expect(served.status, `GET doc ${p}`).toBeLessThan(500);
          for (const answer of [read, served]) {
            expect(answer.body, `the answer for ${p}`).not.toContain("the secret of another document");
            expect(answer.body, `the answer for ${p}`).not.toContain(passwd);
          }
          expect(write.status, `PUT stored ${p}`).toBeGreaterThanOrEqual(400);
          expect(write.status, `PUT stored ${p}`).toBeLessThan(500);
        })
      )
    );
    expect(readFileSync(secret, "utf8")).toBe("the secret of another document");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    // A file of its own still reads.
    expect((await room.stored())?.text).toContain("<h1>Launch notes</h1>");
    await stillHealthy(people, room);
  } finally {
    people.leave();
  }
});

test("a megabyte pasted at once reaches everyone and storage", async () => {
  const people = crowd();
  try {
    const { room } = await newDoc();
    const [a, b] = [await people.join(room, "Ada"), await people.join(room, "Bo")];
    a.insertAfter("</h1>", `<p>${"lorem ipsum dolor sit amet ".repeat(40_000)}</p>`);
    expect(a.str().length).toBeGreaterThan(1_000_000);
    expect(await converged([a, b], 10_000)).toBe(a.str());
    await until(async () => (await room.stored())?.text == a.str(), 10_000, "storage has the paste");
  } finally {
    people.leave();
  }
});

test("a storm of sockets that open and drop leaves the room up, and nobody stays behind", async () => {
  const people = crowd(),
    ghosts = crowd();
  try {
    const { room } = await newDoc();
    const a = await people.join(room, "Ada");
    // The start of a sync, which the room answers; half of the sockets send it, half send nothing. Some close when
    // they open, some when the room's first message comes.
    const step1 = new Uint8Array([0, 0, 1, 0]);
    await Promise.all(Array.from({ length: 80 }, (_, i) => socket(room, i % 2 ? [step1] : [], i % 4 < 2 ? "open" : "first message")));
    // And people who join and go at once.
    await Promise.all(Array.from({ length: 10 }, (_, i) => ghosts.join(room, `Ghost${i}`)));
    await until(
      () => a.others().length == 10,
      5000,
      "Ada sees the ten",
      () => a.others()
    );
    ghosts.leave();
    await until(
      () => a.others().length == 0,
      10_000,
      "the ten are gone for Ada",
      () => a.others()
    );
    await stillHealthy(people, room);
  } finally {
    ghosts.leave();
    people.leave();
  }
});

test("random bytes on the socket change nothing", async () => {
  const people = crowd();
  const rng = random(SEED);
  try {
    const { room } = await newDoc();
    const a = await people.join(room, "Ada");
    const text = a.str();
    await Promise.all(Array.from({ length: 20 }, () => socket(room, [new Uint8Array(1 + rng.int(200)).map(() => rng.int(256))])));
    expect(a.str(), `Ada's text is as it was (ERGA_SEED=${SEED})`).toBe(text);
    await stillHealthy(people, room, text);
    // Ada is still in the room: she gets the newcomer's edit, and nothing else.
    await a.has("<h1>ALIVE ");
    expect(a.str().replace("<h1>ALIVE ", "<h1>"), `ERGA_SEED=${SEED}`).toBe(text);
  } finally {
    people.leave();
  }
});

