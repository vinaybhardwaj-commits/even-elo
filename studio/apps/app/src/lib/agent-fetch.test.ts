// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchAgent, isStaleSocket, isTimeout } from "./agent-fetch";

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A real server; `drop(n)` decides whether request n (1-based) has its socket closed instead of an answer. */
async function serve(drop: (n: number) => boolean, delayMs = 0) {
  let n = 0;
  const seen: number[] = [];
  server = http.createServer((req, res) => {
    const i = ++n;
    req.resume();
    req.on("end", () => {
      if (drop(i)) return req.socket.destroy();
      seen.push(i);
      setTimeout(() => res.end(JSON.stringify({ i })), delayMs);
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/tools/x`, seen, count: () => n };
}

const post = { method: "POST", body: "{}", redirect: "error" as const };

describe("fetchAgent", () => {
  it("a connection closed under the request (stale kept-alive socket) is sent once more and answers", async () => {
    // Live: the first screen read after an idle spell failed with "agent unreachable" and Retry fixed it.
    const s = await serve((n) => n === 2);
    await (await fetchAgent(s.url, post, 2000)).text(); // warms a kept-alive socket
    const res = await fetchAgent(s.url, post, 2000); // request 2 is dropped, request 3 answers
    expect(await res.json()).toEqual({ i: 3 });
    expect(s.seen).toEqual([1, 3]);
  });

  it("without the retry the same request fails as a stale socket", async () => {
    const s = await serve((n) => n === 2);
    await (await fetch(s.url, post)).text();
    const err = await fetch(s.url, post).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isStaleSocket(err)).toBe(true);
  });

  it("is sent at most twice: a second dropped connection is reported", async () => {
    const s = await serve((n) => n >= 2);
    await (await fetchAgent(s.url, post, 2000)).text();
    await expect(fetchAgent(s.url, post, 2000)).rejects.toSatisfy(isStaleSocket);
    expect(s.count()).toBe(3);
  });

  it("a slow agent is a timeout, not retried", async () => {
    const s = await serve(() => false, 500);
    await expect(fetchAgent(s.url, post, 100)).rejects.toSatisfy(isTimeout);
    expect(s.count()).toBe(1);
  });

  it("a refused connection and a redirect are not retried", async () => {
    const refused = await fetchAgent("http://127.0.0.1:9/", post, 2000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isStaleSocket(refused)).toBe(false);
    let hits = 0;
    server = http.createServer((_q, r) => {
      hits++;
      r.writeHead(302, { location: "http://evil.invalid/" }).end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const redirect = await fetchAgent(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, post, 2000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(redirect).toBeInstanceOf(TypeError);
    expect(isStaleSocket(redirect)).toBe(false);
    expect(hits).toBe(1);
  });
});
