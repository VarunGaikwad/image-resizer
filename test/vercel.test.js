const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");

test("Vercel configuration serves static output and routes the API and protected cron to one function", async () => {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "vercel.json"), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, "public");
  assert.equal(config.buildCommand, "npm run build");
  assert.equal(config.functions["api/index.js"].maxDuration, 60);
  assert.deepEqual(config.rewrites.map((route) => route.source).sort(), ["/health", "/config", "/resize", "/resized/:name", "/download-zip", "/api/cleanup"].sort());
  assert.ok(config.rewrites.every((route) => route.destination === "/api/index"));
  assert.deepEqual(config.crons, [{ path: "/api/cleanup", schedule: "0 0 * * *" }]);
});

test("the Vercel entry exports a working Express handler with a 4 MiB cap", async (t) => {
  const app = require("../api/index");
  assert.equal(typeof app, "function");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.closeStorage();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });
  assert.deepEqual(await (await fetch(`${base}/config`)).json(), { uploadBytes: 4 * 1024 * 1024 });
  assert.equal((await fetch(`${base}/api/cleanup`)).status, 401);
});
