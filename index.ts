import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 64 * 1024;
const RECENT_IDS = 256;
type Receipt = { digest: string; status: "accepted" | "delivery_unknown" };
type Bridge = {
  server: Server; ready: Promise<void>; directory: string; path: string;
  session: string; instance: string; ctx: ExtensionContext;
  connections: Set<Socket>; receipts: Map<string, Receipt>;
  active?: { id: string; started: boolean };
};

/** Local transport only: no scheduler, model runtime, project CLI, or trading authority. */
export default function messageBridge(pi: ExtensionAPI): void {
  let current: Bridge | undefined;
  let promptOpen = false;

  function status(bridge: Bridge) {
    return {
      type: "status", socket: bridge.path, session_id: bridge.session,
      instance_id: bridge.instance, cwd: bridge.ctx.cwd,
      busy: !!bridge.active || promptOpen || !bridge.ctx.isIdle() || bridge.ctx.hasPendingMessages(),
      active_message_id: bridge.active?.id ?? null, dedup_window: RECENT_IDS,
    };
  }

  async function stop(): Promise<void> {
    const bridge = current;
    current = undefined;
    if (!bridge) return;
    await bridge.ready.catch(() => {});
    for (const socket of bridge.connections) socket.destroy();
    if (bridge.server.listening) await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    rmSync(bridge.directory, { recursive: true, force: true });
  }

  function receive(bridge: Bridge, raw: string): object {
    if (current !== bridge) return { ok: false, error: "bridge_stopped" };
    let input: any;
    try { input = JSON.parse(raw); } catch { return { ok: false, error: "invalid_json" }; }
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_message" };
    if (input.type === "ping") return { ok: true, ...status(bridge) };
    const allowed = ["type", "id", "session_id", "instance_id", "message", "expires_at"];
    if (input.type !== "prompt" || Object.keys(input).some((key) => !allowed.includes(key)) ||
        typeof input.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.id) ||
        typeof input.message !== "string" || !input.message.trim() ||
        (input.expires_at !== undefined && (typeof input.expires_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.expires_at) || !Number.isFinite(Date.parse(input.expires_at))))) {
      return { ok: false, error: "invalid_message" };
    }
    if (input.session_id !== bridge.session || input.instance_id !== bridge.instance ||
        bridge.ctx.sessionManager.getSessionId() !== bridge.session) return { ok: false, error: "target_mismatch" };
    const digest = createHash("sha256").update(JSON.stringify([input.message, input.expires_at ?? null])).digest("hex");
    const previous = bridge.receipts.get(input.id);
    if (previous) {
      if (previous.digest !== digest) return { ok: false, error: "id_conflict", id: input.id };
      return { ok: previous.status === "accepted", id: input.id, status: previous.status, duplicate: true };
    }
    if (input.expires_at !== undefined && Date.parse(input.expires_at) <= Date.now()) return { ok: false, error: "expired" };
    if (status(bridge).busy) return { ok: false, error: "busy" };

    // Reserve before calling Pi: isIdle() may not change until a later event-loop turn.
    const receipt: Receipt = { digest, status: "accepted" };
    bridge.receipts.set(input.id, receipt);
    if (bridge.receipts.size > RECENT_IDS) bridge.receipts.delete(bridge.receipts.keys().next().value!);
    bridge.active = { id: input.id, started: false };
    try {
      pi.sendUserMessage(input.message, { deliverAs: "followUp", expandPromptTemplates: false });
    } catch {
      // An injection failure may occur after partial delivery. Never automatically resend it.
      receipt.status = "delivery_unknown";
    }
    return { ok: receipt.status === "accepted", id: input.id, status: receipt.status, duplicate: false };
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    if (current) { ctx.ui.notify(JSON.stringify(status(current)), "info"); return; }
    if (process.platform === "win32") { ctx.ui.notify("message-bridge: this version requires Unix-domain sockets", "error"); return; }
    const directory = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "pi-bridge-"));
    chmodSync(directory, 0o700);
    const path = join(directory, "bridge.sock");
    if (Buffer.byteLength(path) > 100) {
      rmSync(directory, { recursive: true, force: true });
      ctx.ui.notify("message-bridge: runtime directory path is too long for a Unix socket", "error");
      return;
    }
    const server = createServer();
    const bridge: Bridge = {
      server, directory, path, ctx, session: ctx.sessionManager.getSessionId(), instance: randomUUID(),
      connections: new Set(), receipts: new Map(), ready: Promise.resolve(),
    };
    current = bridge;
    server.on("connection", (socket) => {
      if (current !== bridge || bridge.connections.size >= 8) { socket.destroy(); return; }
      bridge.connections.add(socket);
      socket.setEncoding("utf8");
      socket.setTimeout(10_000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("close", () => bridge.connections.delete(socket));
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BYTES) {
          socket.end(JSON.stringify({ ok: false, error: "message_too_large" }) + "\n");
          socket.pause();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let response: object;
          try { response = receive(bridge, line); }
          catch { response = { ok: false, error: "bridge_unavailable" }; }
          socket.write(JSON.stringify(response) + "\n");
          if (socket.writableLength > MAX_BYTES) { socket.destroy(); return; }
        }
      });
    });
    bridge.ready = new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(path);
    });
    server.on("error", () => { if (current === bridge) void stop(); });
    try {
      await bridge.ready;
      if (current !== bridge) return;
      chmodSync(path, 0o600);
      writeFileSync(join(directory, "endpoint.json"), JSON.stringify({
        socket: path, session_id: bridge.session, instance_id: bridge.instance, cwd: ctx.cwd, pid: process.pid,
      }) + "\n", { mode: 0o600 });
      ctx.ui.notify(JSON.stringify(status(bridge)), "info");
    } catch {
      if (current === bridge) await stop();
      ctx.ui.notify("message-bridge: could not open listener", "error");
    }
  }

  pi.registerCommand("message-bridge", {
    description: "Local Socket + JSONL bridge: on | off | status (default off)",
    handler: async (args, ctx) => {
      const operation = args.trim() || "status";
      if (operation === "on") await start(ctx);
      else if (operation === "off") { await stop(); ctx.ui.notify("message-bridge: off (already delivered messages are not cancelled)", "info"); }
      else if (operation === "status") ctx.ui.notify(current ? JSON.stringify(status(current)) : "message-bridge: off", "info");
      else ctx.ui.notify("Usage: /message-bridge on|off|status", "warning");
    },
  });
  pi.on("agent_start", () => { if (current?.active) current.active.started = true; });
  pi.on("agent_settled", () => { if (current?.active?.started) current.active = undefined; });
  pi.on("ui_prompt_start", () => { promptOpen = true; });
  pi.on("ui_prompt_end", () => { promptOpen = false; });
  pi.on("session_before_tree", stop);
  pi.on("session_shutdown", stop);
}
