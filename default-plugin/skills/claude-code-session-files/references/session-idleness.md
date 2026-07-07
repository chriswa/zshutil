# Determining whether a Claude Code session is genuinely idle

How to decide, from the outside, that a Claude Code session has truly finished:
its turn has ended AND all of its backgrounded work (Bash tasks, async agents,
monitors, workflows) has completed. Written for agents building transcript
watchers, notifiers, or schedulers.

Everything marked **verified** was established by live experiment or direct
transcript inspection on 2026-07-06 against Claude Code 2.1.132–2.1.202
(incident: the voiceop TranscriptWatcher permanent-mute bug; extended the
same day with the lib-agent SDK-0.3 settle experiments). Reference
implementations: `voiceop/Sources/VoiceOperator/ClaudeWatcher/TranscriptParser.swift`
and `TranscriptWatcher.swift` (+ their tests), and — for the SDK-stream side —
`~/research/forgeworks/lib-agent/src/providers/claude/live-session.ts`.

## The core lesson (read this even if you skip the rest)

**The transcript is not a reliable ledger of background-work completion.**
A background task that is killed, or that finishes while the session sits idle
at the prompt, leaves NO completion event in the transcript — ever (verified:
three sessions in one day each had a launch ack as the *only* trace of a task).
Any "outstanding = launches − completions" accounting poisons itself permanently
on the first lost notification. You must combine transcript accounting with an
OS-level ground-truth probe (below).

## Layer 1 — Turn state

A session's turn has ended when the last `assistant` event has
`message.stop_reason == "end_turn"` (mid-turn events have `"tool_use"`).
Corroboration: `system` events with `subtype: "stop_hook_summary"` then
`"turn_duration"` are appended immediately after a turn completes.

Not idle, regardless of stop_reason:

- A trailing `user` event with **string** content and no assistant response yet
  (a human message the model hasn't answered — the turn is about to start).
  Exclude harness-injected strings: task notifications (contain
  `<task-notification>`), command output (`<local-command-stdout>`).
- A `queue-operation` `enqueue` without a matching `remove` (queued input).
- An incomplete trailing line (no final `\n`) — the writer is mid-append.
  Always parse only up to the last newline.

Truncation trap (verified): a hard kill of the CLI (SIGTERM — e.g. the SDK's
`close()`) right after a turn completed can leave the transcript missing the
turn's final assistant frames — the file then reads as permanently mid-turn
(`stop_reason: "tool_use"`). Safe direction, but pair a stale "mid-turn"
verdict with owning-CLI liveness before trusting it for a dead session. Only
a graceful exit (stdin EOF → the CLI wraps up on its own) reliably flushes.

## Layer 2 — The background-work ledger

Four kinds of background work, each acked in a **tool_result** (never trust
assistant text — see Echo hazard). All completions arrive as
`<task-notification>` blocks on non-assistant lines (`user` string messages,
`queue-operation`, and `attachment` events — often duplicated across 2 of them).

| Kind | Launch ack (in tool_result content) | Completion |
|---|---|---|
| Bash `run_in_background` | `Command running in background with ID: <id>. Output is being written to: <path>.output. You will be notified…` | `<task-id><id></task-id>` + `<status>completed</status>` |
| Async agent (Agent tool) | `Async agent launched successfully` … `agentId: <id>` | same `<task-id>`/`<status>` form |
| Async agent RESUMED (SendMessage tool) | tool_result JSON: `{"success":true,"message":"Agent \"<id>\" was stopped (completed); resumed it in the background with your message. …"}` | same `<task-id>`/`<status>` form (a SECOND notification for the same id) |
| Monitor tool | `Monitor started (task <id>, timeout <N>ms). You will be notified on each event.` | events AND completion — see trap below |
| Workflow tool | `Workflow launched in background. Task ID: <id>` | `<task-notification>` with that id |

Rules that matter:

- **Match by id, per launch.** Never count raw phrase occurrences; never emit a
  completion for an id you didn't see launch (stray notification text can't
  then drive counts negative).
- **A SendMessage resumption RE-OPENS a resolved launch (verified live —
  this was a real false-idle bug in a stream-side implementation).** Sending
  a message to a COMPLETED background agent re-activates it with NO new
  task_started / launch ack — the CLI even reports idle while it works. A
  ledger that resolves the launch at its first completion and never revisits
  it reports idle during the whole resumed run. The re-launch signal is the
  SendMessage tool_result above: `success: true` → re-open the quoted agent
  id (resolved again by that id's NEXT `<status>`-bearing notification).
  `success: false` re-opens nothing. The CLI resolves name-addressed sends
  itself and always echoes the canonical id — never parse the tool_use
  input's `to:` (it may be a name). **Prefer the structured `resumedAgentId`
  field** in the same payload (verified live on 2.1.201:
  `…,"resumedAgentId":"af10cb0b0335ef809","pin":{…}}`) over the message
  prose — the `Agent "<id>"` phrase varies by resume path (`was stopped
  (completed); resumed it in the background…` vs `had no active task;
  resumed from transcript in the background…`) and is a load-bearing
  Anthropic-owned string; use it only as a fallback, keep regression
  fixtures for both variants, and treat unparseable-but-successful results
  as log-loudly, don't register a phantom. The payload's `Output:` path is the
  agent-transcript symlink — do NOT feed it to the file-handle probe (same
  hazard as the launch ack's `output_file:`). A send to a still-RUNNING
  agent also returns success; re-opening is idempotent when keyed by id.
- **Monitor trap (verified):** persistent monitors emit *event* notifications —
  `<task-notification>` with `<task-id>` and `<event>…</event>` but **no
  `<status>`**. Only the completion notification carries `<status>`. If you
  resolve on `<task-id>` alone, a persistent monitor "completes" on its first
  event. Require `<status>` on the same line.
- **Positional semantics:** when scanning historical bytes, a launch is
  outstanding *at offset P* if its completion sits at an offset ≥ P — a turn
  that ended mid-task was a mid-task turn even if the task has since finished.
- **Completion markers only from non-assistant lines** — the model's own words
  can legitimately contain `<task-id>` text (e.g. writing this document).
- **Agent acks also carry an `output_file:` path** (newer CLIs). Do NOT feed it
  to the file-handle probe: it's a symlink to the subagent transcript, written
  by the CLI itself, and is never held open — it would always read "finished".

## Layer 3 — Ground truth: per-kind liveness probes (all verified live)

Each kind of background work needs a different probe. All four were verified
by controlled experiment on 2026-07-06, including against a deliberately
manufactured orphan (a headless session's CLI exiting with a task running).

Path-derivation trap for every probe that locates files under
`~/.claude/projects/` (verified): the CLI CANONICALIZES the cwd (realpath)
before encoding it into the project-dir name — a session with
`cwd=/tmp/foo` on macOS writes to `-private-tmp-foo`, not `-tmp-foo`.
Deriving paths from the literal cwd silently misses symlinked cwds; realpath
first, fall back to the literal path only if realpath fails.

### Bash tasks — the file-handle probe

While a Bash background task runs, **its own process tree holds the harness's
`tasks/<id>.output` file open for writing** (the spawned zsh and the command
itself, fds 1w/2w — the CLI redirects the child's stdout/stderr straight into
the file). The moment the task exits — completed, killed, orphaned — nothing
holds it.

```bash
lsof -t -- "/private/tmp/claude-<uid>/<project-dir>/<session-id>/tasks/<id>.output"
# exit 0 → task still running;  exit 1 → task is finished (or file gone)
```

The path comes from the launch ack itself. The `.output` file **persisting on
disk means nothing** — only the open handle is the signal. File missing →
finished/reaped. Verdicts are permanent (a dead task can't come back).

### Async agents — the transcript-tail probe

Agents run *inside* the CLI process — no fd, no child process. But their
subagent transcript (`<project-dir>/<sid>/subagents/agent-<id>.jsonl`, also
symlinked at `tasks/<agentId>.output`) carries the state: **while the agent
works, its last assistant event has `stop_reason: "tool_use"`; when it
finishes, the tail flips to `"end_turn"`** (verified live, mid-run vs after).
Read the last few KB, scan lines in reverse for the last `assistant` event.
Two caveats: agents are **resumable** (the completion notification itself
warns the same task-id may notify more than once) — never cache this verdict;
and `agent-<id>.meta.json` is static metadata (agentType/description), NOT a
status file.

### Monitors — the session-shell scan

A monitor's `.output` file is **NOT held open by anything** (verified while
one ran): its stdout is piped back to the CLI, which writes the file itself.
The file-handle probe is invalid for monitors. Instead: **every shell the CLI
spawns — foreground command, background task, or monitor — carries
`export CLAUDE_SESSION_ID=<sid>` in its argv** (verified for all three).

```bash
pgrep -f "CLAUDE_SESSION_ID=<session-id>"
# exit 1 → no shell work of any kind is running for this session
```

This is session-level, not per-task: while *any* shell of the session runs, a
dead monitor is indistinguishable — stay conservative. Per-task refinement:
the monitor's zsh argv also contains the eval'd monitor command text, so
`pgrep -f` on a distinctive fragment of the command (from the Monitor
tool_use input in the transcript) narrows it.

### Workflows — the state-file probe

Workflows are in-process (no fd, no child process — verified by diffing the
CLI's open files against a baseline while one ran: only API sockets appear).
But the harness registers each run on disk at the moment it ends:

```
<project-dir>/<sid>/workflows/<runId>.json
# absent while the run is live; written at completion with
# {"runId": …, "taskId": …, "status": "completed", "result": …, timings, …}
```

**Existence of that file = the run is finished** (verified live: absent during
a flag-gated run, appeared within seconds of release, matching the
notification). The launch ack carries both ids — `Task ID: <w-id>` (what
notifications key on) and `Run ID: wf_…` (what the state file is named after)
— so require both when registering, which also hardens against echoed
fragments. Corroborating signal: the run's `tasks/<taskId>.output` is 0 bytes
while live and gets the full result JSON at completion. The per-agent journal
(`subagents/workflows/wf_*/journal.jsonl`) has `started`/`result` lines per
agent but no run-level terminal marker — use the state file, not the journal.
Caveat: a workflow that dies with its CLI never writes the state file, so the
probe reports "running" — combine with owning-CLI liveness for that case.

### If you OWN the CLI process, use the stream instead

A host that spawns the CLI itself (SDK `query()` / `claude -p` with piped
stdout) gets first-party settle signals that transcript watchers never see:
`session_state_changed` events (`idle` | `running` | `requires_action`,
gated behind `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` — the flag is honored
inside the native CLI binary) and structured `task_started` /
`task_notification` events for exact task-registry accounting — no ack-text
scraping, no echo hazard. See `~/research/forgeworks/lib-agent` (README:
"Settle-aware prompts") for a production implementation; its verdict is the
same conjunction as Layer 4, plus a short debounce for the notification →
re-invocation gap (which a transcript watcher gets for free from
byte-positional accounting). Two of its findings independently corroborate
this document: `idle` alone is NOT settled (the CLI reports idle with
background tasks still running), and one logical prompt can span several
end-of-turns because completions re-invoke the agent.

**Verified 2026-07-06: these events are NOT persisted to the transcript**,
even with the env var set (tested with a live headless session + background
task: zero state events in the `.jsonl`). They exist only on the SDK stream.
A transcript watcher cannot use them; the probes above are the fallback.

Stream-side choreography facts (all verified live, CLI 2.1.202 / SDK 0.3.202):

- End-of-turn order with background work outstanding: `result` →
  `session_state_changed: idle` (task still running!) → [task finishes] →
  `task_updated: completed` + `task_notification` → **~100ms** →
  `session_state_changed: running` + `init` → follow-up turn → `result` →
  `idle`. That ~100ms notification→re-invocation gap is the race a
  stream-side settle needs its debounce for.
- `init` is emitted at the start of EVERY turn (re-invocations, queued
  turns), not just at session creation.
- With input queued CLI-side (`SDKUserMessage.priority: 'later'`), no idle
  fires between the turns — idle genuinely means "nothing queued". Priority
  semantics: default/absent = absorbed into the RUNNING turn at the next
  inference boundary (after the current tool batch; one shared result);
  `'later'` = deferred to a fresh turn after the current one completes.
- Foreground Bash commands ALSO emit `task_started` + a same-instant
  terminal `task_notification` (just before their tool_result) — stream
  registries must tolerate foreground entries; they self-resolve in-turn.
- A resumed agent (SendMessage — see the ledger rule above, which applies
  verbatim to stream registries) later emits `task_progress` for the old id
  (~1s+ after re-activation) and eventually a second `task_notification`.
  Treat any `task_progress` / non-terminal `task_updated` (running |
  pending | paused) for an unregistered id as proof of life and re-register
  it — belt-and-braces behind the tool_result rule, which is the only
  race-free signal.
- One-shot (string-prompt) mode: after the `result` the CLI lingers ~5s,
  then KILLS still-running background tasks — and, unlike the transcript,
  the stream DOES carry the evidence (`task_updated {status:"killed"}` +
  `task_notification status:"stopped"`) before the generator completes. Only
  a held-open streaming input keeps background work alive to completion.
- `interrupt()` ends the in-flight turn with a `result` subtype
  `error_during_execution` (+ a synthetic "[Request interrupted]" user
  frame); the session stays alive and promptable. Hazard: that terminal
  result arrives ASYNC after the interrupt call — a consumer that stops
  reading at abort time leaks it into the next turn's stream, where it reads
  as a terminal failure. Drain until it arrives (bounded — an interrupt
  against an idle session may emit nothing).
- Subagent activity interleaves on the PARENT stream (assistant frames and
  inner task events tagged with `parent_tool_use_id`) — turn/anchor logic
  must filter to `parent_tool_use_id === null`.
- `result.total_cost_usd` is CUMULATIVE per CLI process across turns;
  per-turn cost is a delta, and a respawned process restarts at 0.

### What does NOT work (verified dead ends)

- **No PID anywhere.** The launch event's `toolUseResult` carries only
  `backgroundTaskId`; the tmp dir has no metadata files.
- **`lsof` on the session's `.jsonl` transcript.** The owning CLI does *not*
  hold its transcript open (open/append/close per write) — and unrelated
  watcher processes may hold read fds on it, so you get false positives, not
  ownership.
- **`lsof` on a monitor's or agent's `.output`.** See above — bash tasks only.
- **`agent-<id>.meta.json`** — static, never updated on completion.
- **`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` from the outside.** The state
  and task events it enables go to the SDK stream only; nothing extra lands
  in the transcript (verified with a live test session).
- **Waiting for a cancellation event.** There is none. Killed tasks and
  idle-time completions write nothing.

### Orphan lifecycle facts (verified by reproduction)

- **CLI exit reaps its spawned processes.** When the CLI exits (naturally or
  killed), the session's background shells die with it — orphaned *processes*
  don't linger, only orphaned *launch records* in the transcript do.
- **Headless `claude -p` does NOT wait for background Bash tasks** (verified
  via the SDK stream): ~5s after the result it kills them and exits — the
  transcript then ends with a launch ack, no completion, no cancellation: a
  natural orphan, identical to the interactive idle-loss case. (The kill IS
  visible on the SDK stream — `task_updated: killed` + `task_notification:
  stopped` — just never in the transcript.) It did wait for an agent
  notification before exiting; whether it always waits for agents is
  unconfirmed.
- Fail safe in the muting direction everywhere: if a probe itself errors,
  assume the work is still running (degrades to over-muting / "not idle",
  never a false "idle").

## Layer 4 — The verdict algorithm

```
genuinely_idle(session):
  1. Layer 1 says the turn ended cleanly and no input is pending/queued.
  2. Build the ledger (Layer 2, all four launch kinds, matched by id;
     completions require <status>; a successful SendMessage tool_result
     RE-OPENS its quoted agent id — a resolved launch is not final).
  3. For each unresolved launch, probe by kind:
       bash     → file-handle probe; held → NOT idle; unheld → resolved (cache).
       agent    → subagent transcript tail; tool_use → NOT idle;
                  end_turn / file gone → resolved (do NOT cache — resumable).
       monitor  → session-shell scan; any session shell alive → NOT idle
                  (conservative); none → resolved (cache).
       workflow → workflows/<runId>.json exists → resolved (cache);
                  absent → NOT idle (or dead-with-CLI — see caveat).
  4. All launches resolved → genuinely idle.
```

Caveat on "idle" vs "finished": a session can be genuinely idle *now* and still
scheduled to resume (`ScheduleWakeup`, cron routines, a persistent Monitor's
future events, an agent the user re-messages). Idle is a present-tense fact,
not a promise.

## Echo hazard (this bit deserves its own heading)

Any agent that *investigates transcripts using shell tools* writes launch-ack
text into its **own** transcript as tool_results (grep/jq/Read output). A
naive parser then registers phantom launches in the investigating session —
this happened during the original incident investigation, to the investigator.
Defenses, in order of strength:

1. Only scan tool_result content for launch acks (never assistant text).
2. Require the full ack sentence pair (id + output path / corroborating
   phrase) in one match — bare phrase echoes then don't register.
3. Accept that a full-line transcript dump defeats (1) and (2), and rely on
   the file-handle probe to self-heal: a phantom's output path is never held
   open, so it resolves as dead on first probe.

## Remaining gaps (honest list, updated 2026-07-06 after the probe experiments)

The original gaps around agents, monitors, and workflows were closed by the
per-kind probes above (and are implemented in the reference implementation).
What remains:

1. **A workflow that dies with its CLI is unresolvable by the state-file
   probe** (the file is only written on a live completion). If the session is
   later resumed, the old run's launch looks live forever. Only owning-CLI
   liveness (heuristic) or journal-staleness can break the tie.
2. **A dead monitor hides behind other live shells.** The session-shell scan
   is session-granular; per-task command-fragment matching helps but isn't
   airtight (short/generic commands).
3. **Agent-tail edge cases.** If a subagent transcript ends in a non-assistant
   event beyond the read window, or the format changes, the probe reports
   "running" (safe direction). Resumed agents correctly flip back to running,
   but only once the resumed transcript grows.
4. **Persistent-monitor ack format was extrapolated.** The `(task <id>,
   timeout Nms)` form is verified; the `persistent: true` ack is assumed to
   share the `Monitor started (task <id>` prefix — unverified.
5. **Version drift.** All formats verified on 2.1.132–2.1.202. The ack
   phrases and notification tags — now including the SendMessage
   tool_result's `Agent "<id>"` phrase — are load-bearing strings owned by
   Anthropic; re-verify on major CLI updates (keep a regression fixture from
   a real transcript).
6. **Compaction/truncation:** a transcript can shrink or be rewritten;
   byte-offset state must reset when `size < last_seen` (the reference
   implementation does this). Separately, a SIGTERM'd CLI can truncate the
   FINAL frames of a completed turn (see the Layer 1 truncation trap).
7. **SendMessage resumption chains beyond depth 1 are unverified.** The
   re-open rule was verified for a main-chain SendMessage to a depth-1
   background agent; an agent resuming ANOTHER agent (depth 2+) emits its
   SendMessage exchange on the subagent transcript, not the main one — a
   main-transcript ledger would miss it. The agent-tail probe on the
   still-open parent should cover it, but this is reasoned, not verified.
