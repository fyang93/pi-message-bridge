# pi-message-bridge

A standalone local Socket + JSONL extension for an **existing Pi session**,
inspired by [pi-nvim](https://github.com/carderne/pi-nvim). No TCP port, broker,
database, project imports, scheduler, or second agent. Requires Pi 0.86+ on Linux
or macOS. Windows Named Pipes are not implemented.

## Start and status

Install from GitHub (private repositories require Git access):

```sh
pi install -l git:github.com/fyang93/pi-message-bridge
```

Or install a local checkout with `pi install -l /absolute/path/to/pi-message-bridge`,
then `/reload`. Install only one copy into each Pi session. The listener starts
when a Pi session starts or resumes, restarts after session-tree navigation, and
stops on shutdown or reload. No start/stop command is exposed.

The Pi status bar shows `Bridge: on` while listening. `/message-bridge status`
shows the socket path, session ID and instance ID. Each session activation has a
new private directory under `$XDG_RUNTIME_DIR` (or the OS temporary directory),
with an `endpoint.json` discovery file. That file contains connection metadata,
not live status; use `ping` for current status and select an endpoint explicitly.

The directory has mode `0700`; socket and manifest have mode `0600`. Only trusted
processes running as the same OS user should connect: accepted text becomes a real
Pi user message. This is not an OS sandbox and does not bypass project/tool approval
requirements. Do not expose or proxy it to untrusted callers.

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

- An idle session receives the exact `message` text through `pi.sendUserMessage()`
  and starts a turn. No prefix, wrapper prompt or custom message is added. Slash
  command dispatch and skill/template expansion remain disabled: text is forwarded
  literally. There is no direct tool-execution API.
- Every valid message is handed to Pi with `deliverAs: "followUp"`. An idle Pi
  starts immediately; a busy Pi queues it through its native follow-up mechanism
  without interrupting the current run. The bridge has no separate queue and never
  rejects a message just because the session is busy. `ping.busy` is informational.
- `expires_at` is checked only at admission, **not** when Pi consumes the queue;
  queued messages may run after that timestamp. Callers should avoid flooding the
  native queue and business operations must recheck time-sensitive inputs.
- `accepted` means handed to Pi (possibly queued), not completed or successful.
  Check business records for business outcomes; this bridge does not track run
  completion or other extensions' asynchronous work.
- The last 256 accepted/uncertain IDs are remembered per activation. Reusing an ID
  with different content returns `id_conflict`. Identical retries return the
  original receipt without re-injection. `delivery_unknown` must not be blindly
  retried under a new ID. No persistence or exactly-once guarantee is claimed;
  side-effecting business operations still require their own durable idempotency.
- Shutdown, reload, session replacement or tree navigation close the listener and
  remove its directory; a new session or completed tree navigation starts a fresh
  endpoint. The bridge does not cancel messages already handed to Pi, including
  queued follow-ups; their lifecycle belongs to Pi. A process killed without cleanup
  can leave a stale directory, but subsequent activations never reuse that endpoint.

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
