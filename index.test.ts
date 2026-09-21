import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { test } from "bun:test";
import bridgeExtension from "./index.ts";

function harness() {
  const events = new Map<string, Function>();
  const notices: string[] = [];
  const messages: any[] = [];
  let command: any;
  let idle = true, pending = false, fail = false, session = "session-A";
  const ctx: any = {
    cwd: "/example/project", sessionManager: { getSessionId: () => session },
    isIdle: () => idle, hasPendingMessages: () => pending,
    ui: { notify: (text: string) => notices.push(text) },
  };
  bridgeExtension({
    registerCommand: (_name: string, value: any) => { command = value; },
    on: (name: string, handler: Function) => events.set(name, handler),
    sendUserMessage: (message: string, options: any) => {
      assert.equal(options.expandPromptTemplates, false);
      assert.equal(options.deliverAs, "followUp");
      messages.push(message);
      if (fail) throw new Error("injection failed after partial delivery");
    },
  } as any);
  return {
    messages, notices,
    command: (args: string) => command.handler(args, ctx),
    event: (name: string) => events.get(name)?.({}, ctx),
    busy: (value: boolean) => { idle = !value; },
    pending: (value: boolean) => { pending = value; },
    fail: () => { fail = true; },
    session: (value: string) => { session = value; },
    endpoint: () => JSON.parse(notices.at(-1)!),
  };
}

async function connect(path: string) {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.setEncoding("utf8");
  let buffer = "";
  const lines: any[] = [];
  const waiting: ((value: any) => void)[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const result = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(result); else lines.push(result);
    }
  });
  return {
    socket,
    next: () => lines.length ? Promise.resolve(lines.shift()) : new Promise<any>((resolve) => waiting.push(resolve)),
    write: (value: object) => socket.write(JSON.stringify(value) + "\n"),
  };
}

function prompt(endpoint: any, id = "review-1", message = "复盘 /not-a-command") {
  return { type: "prompt", id, message, session_id: endpoint.session_id, instance_id: endpoint.instance_id };
}

// Real Unix sockets and framing; Pi alone is mocked. No model, broker, configuration, or database access.
test("private endpoint, fragmented UTF-8, admission, duplicate and lifecycle boundaries", async () => {
  const h = harness();
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let endpoint: any;
  try {
    await h.command("status");
    assert.equal(h.notices.at(-1), "message-bridge: off");
    await h.command("on");
    endpoint = h.endpoint();
    assert.equal(statSync(dirname(endpoint.socket)).mode & 0o777, 0o700);
    assert.equal(statSync(endpoint.socket).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(endpoint.socket) + "/endpoint.json").mode & 0o777, 0o600);
    client = await connect(endpoint.socket);
    client.write({ type: "ping" });
    assert.equal((await client.next()).session_id, "session-A");
    const request = prompt(endpoint);
    client.write({ ...request, instance_id: "different-instance" });
    assert.equal((await client.next()).error, "target_mismatch");
    client.write({ ...request, arbitrary_command: "execute" });
    assert.equal((await client.next()).error, "invalid_message");
    client.socket.write("null\nnot-json\n");
    assert.equal((await client.next()).error, "invalid_message");
    assert.equal((await client.next()).error, "invalid_json");
    client.write({ ...request, expires_at: "2020-01-01T00:00:00Z" });
    assert.equal((await client.next()).error, "expired");
    client.write({ ...request, expires_at: "2026-09-21" });
    assert.equal((await client.next()).error, "invalid_message");
    h.busy(true);
    const busyRequest = prompt(endpoint, "busy-1", "while running");
    client.write({ type: "ping" });
    assert.equal((await client.next()).busy, true);
    client.write(busyRequest);
    assert.equal((await client.next()).status, "accepted");
    client.write(busyRequest);
    assert.equal((await client.next()).duplicate, true);
    h.busy(false);
    h.pending(true);
    client.write(prompt(endpoint, "pending-1", "while queued"));
    assert.equal((await client.next()).status, "accepted");
    h.pending(false);
    await h.event("ui_prompt_start");
    client.write(prompt(endpoint, "ui-1", "while prompting"));
    assert.equal((await client.next()).status, "accepted");
    await h.event("ui_prompt_end");
    assert.deepEqual(h.messages, ["while running", "while queued", "while prompting"]);

    const bytes = Buffer.from(JSON.stringify(request) + "\n");
    const split = bytes.indexOf(Buffer.from("复")) + 1;
    client.socket.write(bytes.subarray(0, split));
    client.socket.write(bytes.subarray(split));
    assert.equal((await client.next()).status, "accepted");
    assert.equal(h.messages.length, 4);
    assert.equal(h.messages.at(-1), request.message);
    client.write(request);
    assert.equal((await client.next()).duplicate, true);
    client.write({ ...request, message: "changed" });
    assert.equal((await client.next()).error, "id_conflict");
    // Another message is handed to Pi without waiting for the earlier turn to settle.
    client.write(prompt(endpoint, "review-2"));
    assert.equal((await client.next()).status, "accepted");

    await h.command("off");
    assert.equal(existsSync(dirname(endpoint.socket)), false);
    await h.command("on");
    const replacement = h.endpoint();
    assert.notEqual(replacement.instance_id, endpoint.instance_id);
    assert.notEqual(replacement.socket, endpoint.socket);
    client.socket.destroy();
    client = await connect(replacement.socket);
    client.write(request);
    assert.equal((await client.next()).error, "target_mismatch");
    h.session("session-B");
    client.write(prompt(replacement));
    assert.equal((await client.next()).error, "target_mismatch");
    await h.event("session_before_tree");
    assert.equal(existsSync(dirname(replacement.socket)), false);
    assert.equal(h.messages.length, 5);
  } finally {
    client?.socket.destroy();
    await h.event("session_shutdown");
  }
}, 10_000);

test("oversized input, uncertain injection, and shutdown with connected clients", async () => {
  const h = harness();
  const sockets: Socket[] = [];
  try {
    await h.command("on");
    const endpoint = h.endpoint();
    const large = await connect(endpoint.socket);
    sockets.push(large.socket);
    large.socket.write("x".repeat(64 * 1024 + 1));
    assert.equal((await large.next()).error, "message_too_large");
    assert.equal(h.messages.length, 0);
    const client = await connect(endpoint.socket);
    sockets.push(client.socket);
    h.fail();
    const request = prompt(endpoint);
    client.write(request);
    assert.equal((await client.next()).status, "delivery_unknown");
    client.write(request);
    assert.deepEqual(await client.next(), { ok: false, id: request.id, status: "delivery_unknown", duplicate: true });
    assert.equal(h.messages.length, 1); // Uncertain retries never re-inject.
    client.write(prompt(endpoint, "other"));
    assert.equal((await client.next()).status, "delivery_unknown");
    assert.equal(h.messages.length, 2);
    await h.event("session_shutdown");
    assert.equal(existsSync(dirname(endpoint.socket)), false);
    await h.event("session_shutdown");
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await h.command("off");
  }
}, 10_000);
