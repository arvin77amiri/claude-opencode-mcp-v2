// Stand-in for `opencode serve` (OpenCode 2.x): protected by HTTP Basic auth
// built from OPENCODE_SERVER_USERNAME/PASSWORD, like the real server. It writes
// the credentials it received to FAKE_OPENCODE_REPORT so tests can inspect them.
import fs from "node:fs";
import http from "node:http";

if (process.argv.includes("--version")) {
  console.log("fake-2.0.0");
  process.exit(0);
}

const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const expected = password
  ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  : null;
const hostname =
  (process.argv.find((a) => a.startsWith("--hostname=")) ?? "").slice(11) || "127.0.0.1";

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  // Without any configured password the real server invents one nobody knows.
  if (!expected || req.headers.authorization !== expected) {
    res.statusCode = 401;
    res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
    return;
  }
  if (req.url === "/api/info") {
    res.end(
      JSON.stringify({ data: { version: "2.0.0-fake", pid: process.pid, urls: [], paths: {} } }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ _tag: "NotFoundError", message: req.url }));
});

server.listen(0, hostname, () => {
  const { port } = server.address();
  if (process.env.FAKE_OPENCODE_REPORT) {
    fs.writeFileSync(
      process.env.FAKE_OPENCODE_REPORT,
      JSON.stringify({
        pid: process.pid,
        username: process.env.OPENCODE_SERVER_USERNAME ?? null,
        password: password ?? null,
      }),
    );
  }
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
process.on("SIGTERM", () => process.exit(0));
// Safety net: on Windows the .cmd shim can leave this process behind when the shell is killed.
setTimeout(() => process.exit(0), 60_000).unref();
