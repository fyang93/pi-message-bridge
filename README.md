# pi-message-bridge

A standalone local Socket + JSONL extension for an **existing Pi session**,
inspired by [pi-nvim](https://github.com/carderne/pi-nvim). No TCP port, broker,
database, project imports, scheduler, or second agent. Requires Pi 0.86+ on Linux
or macOS. Windows Named Pipes are not implemented.

## Enable

Install from GitHub (private repositories require Git access):

```sh
pi install -l git:github.com/fyang93/pi-message-bridge
```

Or install a local checkout with `pi install -l /absolute/path/to/pi-message-bridge`.
Then `/reload`. AlphaForge already discovers its bundled copy; do not load both
copies into the same session.

```text
/message-bridge on
/message-bridge status
/message-bridge off
```

Loading/reloading does not start a listener. `on` prints the socket path, session ID
and instance ID. Each activation has a new private directory under
`$XDG_RUNTIME_DIR` (or the OS temporary directory), with an `endpoint.json`
discovery file. That file contains connection metadata, not live status. Use `ping`
for current status; select an endpoint explicitly, never guess the newest session.

The directory has mode `0700`; socket and manifest have mode `0600`. Only trusted
processes running as the same OS user should connect. This is not an OS sandbox
or trading authorization. Do not expose or proxy it to untrusted callers.

## Protocol

UTF-8, one JSON object per line, with one JSON response per request:

```json
{"type":"ping"}
{"type":"prompt","id":"review-001","session_id":"FROM_PING","instance_id":"FROM_PING","message":"Please review the project."}
```

`prompt` requires both target IDs. Optional `expires_at` is a timezone-qualified
ISO timestamp checked at admission. IDs use 1–128 ASCII letters, digits, dots,
underscores, colons or hyphens. The input buffer limit is 64 KiB; at most eight
connections are allowed, with a ten-second inactivity timeout.

- An idle session receives a visible `external-message` and starts a turn. The
  message retains external provenance; it is not dispatched as a slash command
  or proof of human approval. There is no direct tool-execution API.
- Busy sessions, pending messages and blocking UI prompts return `busy`. Nothing
  is queued by this bridge. The caller decides whether to coalesce, discard or
  retry while still relevant. `expires_at` is **not** an execution deadline.
- `accepted` means handed to Pi, not completed or successful. Check business
  records for business outcomes. The bridge reserves admission through
  `agent_settled`; other extensions' later asynchronous work is not tracked.
- The last 256 accepted/uncertain IDs are remembered per activation. Reusing an ID
  with different content returns `id_conflict`. Identical retries return the
  original receipt without re-injection. `delivery_unknown` must not be blindly
  retried under a new ID. No persistence or exactly-once guarantee is claimed;
  side-effecting business operations still require their own durable idempotency.
- `off`, shutdown, reload, session replacement or tree navigation close the
  listener and remove its directory. Already delivered messages are not cancelled.
  Re-enable explicitly. A process killed without cleanup can leave a stale
  directory, but subsequent activations never reuse or take over that endpoint.

## Python client (standard library only)

Pass the exact socket path printed by `/message-bridge on`:

```python
import json
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(5)
    connection.connect(sys.argv[1])
    with connection.makefile("rwb") as stream:
        def request(body):
            stream.write((json.dumps(body) + "\n").encode())
            stream.flush()
            return json.loads(stream.readline(65536))

        target = request({"type": "ping"})
        print(request({
            "type": "prompt", "id": "review-001",
            "session_id": target["session_id"], "instance_id": target["instance_id"],
            "message": "请根据项目复盘 Skill 检查持仓与计划。",
        }))
```

Run transport/lifecycle tests with `bun test ./index.test.ts` in this folder.
Tests use real Unix sockets and mocked Pi events, not model or broker calls.
