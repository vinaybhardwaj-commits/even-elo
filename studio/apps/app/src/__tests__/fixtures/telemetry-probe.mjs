// Loads the CopilotKit runtime/shared telemetry with NO kill-switch env and
// records every outbound connection attempt. Prints a JSON array of hosts.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";

const attempts = [];
const local = (h) => !h || ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(String(h));
const note = (kind, host) => { if (!local(host)) attempts.push(`${kind}:${host}`); };

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  note("net", typeof o === "object" && o ? o.host : args[1]);
  return origConnect.apply(this, args);
};
const origTls = tls.connect;
tls.connect = function (...args) {
  const o = args[0];
  note("tls", typeof o === "object" && o ? o.host ?? o.servername : args[1]);
  return origTls.apply(this, args);
};
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (...args) {
    const o = args[0];
    note("http", typeof o === "string" ? new URL(o).hostname : o?.hostname ?? o?.host);
    return orig.apply(this, args);
  };
}
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) { note("dns", host); return origLookup.call(this, host, ...rest); };
const origFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  try { note("fetch", new URL(url).hostname); } catch { note("fetch", url); }
  return Promise.reject(new Error("blocked by probe"));
};
void origFetch;

const mode = process.argv[2];
if (mode === "control") {
  await fetch("https://example.invalid/x").catch(() => {});
} else {
  const { createRequire } = await import("node:module");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  // @copilotkit/shared is a transitive dependency: resolve it from the runtime's location.
  const runtimeEntry = fileURLToPath(import.meta.resolve("@copilotkit/runtime"));
  const sharedEntry = createRequire(runtimeEntry).resolve("@copilotkit/shared");
  const shared = await import(pathToFileURL(sharedEntry).href);
  const client = new shared.TelemetryClient({ packageName: "probe", packageVersion: "0" });
  await client.capture("probe.event", { a: 1 });
  const runtime = await import("@copilotkit/runtime");
  new runtime.CopilotRuntime({ agents: {} });
  await new Promise((r) => setTimeout(r, 1500));
}
process.stdout.write(JSON.stringify(attempts));
process.exit(0);
