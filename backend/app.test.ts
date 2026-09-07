import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./app.js";

test("GET /health returns a successful health response", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("unknown routes return not found", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");

    const response = await fetch(`http://127.0.0.1:${address.port}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
