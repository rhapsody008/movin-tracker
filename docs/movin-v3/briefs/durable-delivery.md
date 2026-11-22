# T4: durable intake, delivery, watchdog, commands

Read-only study of pi-durable 1.5.2 as it sits in `app/node_modules/@earendil-works/pi-durable/`
(`D/` = that package's `dist/`, cited 1-based), together with `app/src/durable/adapter.ts` and
`docs/movin-v3/briefs/durable-api.md`, `telegram-spec.md` and `plan.md:74-79,123-129`.
Nothing here was run; every claim is a citation.

## 0. The answers in one screen

1. **A host-owned durable task API exists, but not from a run's completion.** `defineTask`
   (`D/tasks.d.ts:3`) + `Extension.tasks` (`D/harness/types.d.ts:352,360`) register a kind;
   `tx.createTask(task, input, options)` (`D/types.d.ts:926`) creates one inside *any* commit
   (`harness.commit`, `conversation.commit`, `runtime.commit`); `harness.getTask` `:850`,
   `harness.waitForTask` `:863`, `harness.abortTask` `:861`, `harness.inspect` `:852`,
   `tx.scanTasks` `:909`, `harness.watchTaskGraph` `:870`. A task is resumed by
   `harness.resume()` (`:835`): open turns every `running` record back to `pending` and bumps
   `restarts` (`D/harness/scheduler.js:236-247`), then the scheduler re-invokes `phases[checkpoint.phase]`.
   There is **no** `sleepUntil`/`createTask`/`api.taskId` outside a task or tool, no "effects", no
   "outbox", no generic KV, and **no declarative replay policy**: a task always resumes at its
   checkpoint, so exactly-once is what its own `commit()`s make atomic (see §3).
2. **The closest durable hook to "the run answered" is `afterRun`** (`D/harness/types.d.ts:940`)
   returning `runEndTask(task, input)` (`D/harness/define.d.ts:15`). The tasks are created in a
   **second commit**, the one that moves the generation to `drain` (`D/harness/generation.js:228-255`),
   not in the answer's commit (`:671-698`). That is still safe: the `finish` checkpoint is committed
   with the answer, so a crash in between re-enters `finish` and asks the hook again — "a crash before
   they exist asks the hooks again, never twice once they do" (`README.md:711`).
   A watch on the conversation (`pi.live`, `D/harness/live.d.ts:171`) or a settled-submission read is
   *not* durable across a restart and cannot replace it.
3. **Recovery needs no search for replies.** The delivery task *is* the durable record: `resume()`
   runs it. What cannot be covered by `afterRun` — a run that ended **without** an answer — needs one
   host sweep over the Telegram ledger; §5 gives it (`Tx.submission`, no `scanSubmissions` in `Tx`).
4. **Yes: a session-doc write rides in the submit's commit.** `commitSubmitted`
   (`adapter.ts:904-917`) already does exactly this: `harness.commit(tx => { const id = await
   conversation.submit(tx, draft); ...tx.doc(PromptStateDoc, ...) })`. The rule is only ordering —
   the admission comes before the commit's first table write (`D/harness/types.d.ts:786`, see
   `D/harness/types.d.ts:786`). So the offset can ride *with* the submit, which is stronger than the
   plan's "before the offset moves".
5. **Watchdog: a durable deadline in the intake commit, fired by the host, not by a task.** A task
   cannot abort a sibling (§6).
6. **Commands: no library marker exists; use a session doc, intent-before-act** (§7).

## 1. What the library actually offers (§Question 1 in detail)

| Need | API | Citation |
|---|---|---|
| Declare a kind | `defineTask({name, version, initial, phases, abort, migrate?, hooks?})` | `D/tasks.d.ts:3`, `D/types.d.ts:318-336` |
| Register it | `Extension.tasks` on a `defineExtension`, installed in the registry | `D/harness/types.d.ts:352,360`, `:376` |
| Create | `tx.createTask(task, input, options)` in any commit | `D/types.d.ts:926-928` |
| Create from inside a task | `runtime.commit(tx => tx.createTask(…))` | `D/types.d.ts:255` |
| Create from a tool | `api.createTask` | `D/harness/types.d.ts:235` |
| Create from a run end | `afterRun` → `runEndTask` | `D/harness/types.d.ts:940`, `D/harness/define.d.ts:15` |
| Resume / wait | `harness.waitForTask`, `getTask`, `runtime.waitForTask`, `runtime.outcomes` | `:863`, `:850`, `D/types.d.ts:264,270` |
| Cancel | `harness.abortTask(id)` (any), `runtime.abortOwned(id)` (own children only), `conversation.abort()` | `:861`, `D/types.d.ts:268`, `:813` |
| Time | `runtime.sleepUntil(until, checkpoint, ctx)`, or `{status:"sleeping", until, checkpoint}` from `commit()` | `D/types.d.ts:310-315`, `:616-621` |
| Progress | the checkpoint itself; `runtime.memo(name, candidate)` is durable but **dropped when terminal** | `D/types.d.ts:255`, `:669-681`, `D/harness/scheduler.js:2879` |
| Inspect | `harness.inspect()` → live tasks + unsettled submissions (`HarnessInspection`) | `D/harness/types.d.ts:743-750`, `:852` |
| Sleep/wake | `harness.wake()` → `{active, at}`; without `onWake` a timer resumes sleeps | `D/harness/types.d.ts:703-706`, `:842` |

Two constraints that shape everything:

* **A phase that returns without changing its checkpoint faults** ("returned without durable
  progress", `D/harness/scheduler.js:2169-2174`, rule at `:2177-2182`). Looping one phase is
  therefore legal and idiomatic: `commit()` a *changed* checkpoint with the same `phase` name, and the
  same handler runs again (`D/harness/scheduler.js:2078-2094`). This is the per-chunk loop.
* **A child task cannot be `background`** (`D/session/transaction.js:206-208`), and
  `TaskOptions.conversationId` is required for a task created by a commit not bound to a conversation
  (`D/session/transaction.js:226-227`).

## 2. Recommended design

### (a) Intake — one commit, submit + offset

```ts
// T4.2, app/src/telegram/intake.ts (adapter gains the offset doc + a no-wait submit)
await harness.commit(async (tx) => {
  const id = await conversation.submit(tx, draft);      // FIRST: admission before table writes
  const turns = await tx.doc(TgTurns);                  // session doc, §5 ledger
  turns.open.push({ id, key, chat, message, group, at: now(), deadline: now() + TURN_TIMEOUT_MS });
  const off = await tx.doc(TgOffset);
  off.value = Math.max(off.value, updateId + 1);        // rides WITH the submit
  return id;
}, background);
```

* The draft is the existing one (`adapter.ts:352-365` shape) with `requestId: "tg:<update_id>"`; keep
  the addressing the reply needs (`chat`, `message_id`, `group`) in the entry `data`, so it is stored
  by the same commit and is readable later from a settled submission's `entry`.
* Exactly-once holds **either way**: same commit → a crash stores both or neither; a crash before
  stores neither, the offset did not move, Telegram redelivers, and the update is submitted again.
  Keeping `tg:<update_id>` is still required, for the restore path, which drops the offset on purpose
  (`plan.md:47`: "known request IDs are ignored") while submissions survive in the restored database:
  a known `requestId` "returns its existing submission without writing" (`D/harness/submissions.d.ts:41-42`).
* The commit must not throw for the ordinary case. Default `whenBusy` queues (`D/harness/types.d.ts:36-44`),
  so no `ConversationBusy`; a `SessionFailed` must leave the offset where it is (nothing written) and be
  retried by the poll loop — never advance the offset on a failed commit.
* The bot must not await the run: its turn is started fire-and-forget (§4). The poll loop's only
  ordering (per chat) is the adapter's `serial(key)` chain (`adapter.ts:1180-1196`) plus `pi.inbox`.

### (b) Delivery — one durable task per reply, created by `afterRun`

`movin.tg.delivery`, registered in the existing `movin.agent` extension (`adapter.ts:483-490`):

```ts
type Input = { chat: number; messageId: number; group: boolean;
               chunks: string[]; keyboard: unknown | null };
type Ckpt  = { phase: "send"; next: number } | { phase: "giveup"; next: number; error: string };

const Delivery = defineTask<Input, Ckpt, { sent: number }, {}>({
  name: "movin.tg.delivery", version: 1,
  initial: () => ({ phase: "send", next: 0 }),
  phases: {
    send: async (task, runtime, context) => {
      const { chunks, next } = { chunks: task.input.chunks, next: task.state.checkpoint.next };
      if (next >= chunks.length) {
        return runtime.commit(() => ({ status: "terminal",
          outcome: { status: "completed", result: { sent: chunks.length } } }), context);
      }
      try {
        await bot.sendMessage({ chatId: task.input.chat, text: chunks[next],
          replyTo: next === 0 && task.input.group ? task.input.messageId : undefined,
          markup: next === chunks.length - 1 ? task.input.keyboard : undefined });
      } catch (err) {
        // Real code: an `attempts` field in the checkpoint, a durable backoff via a sleeping commit,
        // then a terminal `failed`. Kept short here.
        return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed",
          error: { message: errorMessage(err) } } }), context);
      }
      return runtime.commit(() => ({ status: "running",
        checkpoint: { phase: "send", next: next + 1 } }), context);   // per-chunk progress
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "restore" } }), context),
});
```

The hook that creates it (registered next to `agentHooks()`):

```ts
hook(GenerationTask, {
  afterRun: async (run, api, context) => {
    const input = await api.entry(UserEntry, run.first, context);   // HookApi entry read, committed
    const tg = telegramOf(input?.data);                              // undefined ⇒ web chat: no task
    if (tg === undefined) return undefined;
    const text = replyText(await runAnswer(run, api, context), tg.group);  // the same reply.ts rule
    if (text === undefined) return undefined;                        // NO_REPLY in a group: nothing to send
    const { chunks } = split(text, MAX_MESSAGE);
    return { tasks: [runEndTask(Delivery, { ...tg, chunks, keyboard: undoKeyboard(changes) })] };
  },
}),
```

Why this satisfies T4.3's verify list:

* **Crash before the send** → the task is pending/running in storage; open reconciles it and
  `resume()` (`D/harness/scheduler.js:236-247,265-269`) re-enters `send` at `checkpoint.next`; the chunk
  goes out.
* **Crash mid-send** → the send is not covered by the commit, so the same `next` runs again: **exactly
  one duplicate chunk**, which is the accepted cost, and never a repeated *earlier* chunk (the index
  only moves on a committed send).
* **No answer** → `afterRun` never fires ("never after a failure or an abort",
  `D/harness/types.d.ts:934-940`, `README.md:706`) → the failure line comes from the sweep in §5.
* **Silence** → the hook returns no task; nothing is sent, not even an empty message.
* **Keyboard on the last chunk, threading on the first** — decided once, stored in the task input.

Costs to own: one task record per reply (terminal task records are never deleted — a `Storage` write
type has no delete, `D/types.d.ts:820-870`), and `settings.restartLimit` (default 5,
`D/harness/agent.d.ts:11`) bounds a crash loop — a delivery cut off that often ends `failed` instead of
running again.

### (c) Watchdog — deadline in the intake commit, fired by the host

Do **not** build it as a task. A conversation-owned task can only reach `runtime.abortOwned` (its own
children, `D/types.d.ts:268`) or `ConversationHandle.abort()` (`:813`), which withdraws *every* queued
input of the chat as well — the run's siblings die with it. The precise lever is host-side:
`harness.abortTask(live.run.taskId)` (`D/harness/types.d.ts:861`, `D/harness/scheduler.js:389-422`
commits the mark, joins the invocation, schedules the abort handler).

* The deadline is already durable — `turns.open[i].deadline` in the intake commit (§2a), written
  atomically with the submission.
* A host loop (the poll loop's own tick, ~30 s, plus one pass at startup) reads `movin.tg.turns`,
  takes each overdue entry, resolves the chat's conversation, reads
  `harness.snapshot(LiveDoc, id)` (`D/harness/live.d.ts:112-131`: `run.taskId`, `run.inputs`), and if
  `run.inputs` still contains the submission id calls `harness.abortTask(run.taskId)`. If `run` is gone
  or `run.inputs` is empty the run already answered (it is in `afterRun`/`drain`) — do nothing, or the
  reply in flight would be aborted ("Stop aborts them", `README.md:708`).
* Survives a restart because the deadline is data, not memory: the startup pass fires it at once.
  A host loop is enough here — a pod that runs the poller is never asleep.
* The abort settles the submission `unanswered` reason `aborted` in the same commit as the run's
  terminal outcome (`D/harness/generation.js:283`), which is what the failure sweep already handles.

### (d) Commands and callbacks — at-most-once

No library marker exists (§7), so use a session doc and reserve **before** acting:

```
movin.tg.commands = { handled: { id: number; at: number; text?: string }[] }   // bounded, ~64 entries
```

One commit does three things: record the intent `{id: update_id}` **and** move the offset
(`off.value = update_id + 1`) — a crash after that commit loses the command (at-most-once, which is
what at-most-once means) rather than repeating it. A second commit records `text` (the answer to
re-send on a duplicate, `telegram-spec.md:814-815`). A redelivered `update_id` present in `handled`
answers from `text` and performs no third-party write — in particular `/undo` never removes a second,
earlier change (`plan.md:129`).

## 3. Atomicity, stated plainly

| Writes | Atomic with | Not atomic with |
|---|---|---|
| submission + offset + ledger entry (§2a) | each other (one `harness.commit`) | the Telegram poll (irrelevant: offset is the confirmation) |
| answer entry + input settled `done` + `finish` checkpoint | each other (`D/harness/generation.js:671-698,706-723`) | the delivery task's creation |
| delivery task creation + run → `drain` | each other (`:233-255`) | the answer commit (one commit later; safe because `finish` is durable) |
| one chunk sent | — | `checkpoint.next` (a crash here duplicates that one chunk) |
| `checkpoint.next` | — | the send it follows |
| failure line task + ledger close + `tx.submission(id)` read | each other (§5) | the run's settlement commit |

## 4. Who awaits a Telegram turn

`afterRun` delivers the reply, but the *host* still has post-run work in `submit()`:
`recordActivity` (`adapter.ts:868-876`) and `settlePrompt` (`:928-946`), both best-effort by design
(`adapter.ts:176-184` already accepts that a recovered run has no caller). So T4.2 keeps calling a
fire-and-forget `submit()`-equivalent per update (not awaited by the poll loop; `serial(key)` orders
it), and stops sending the reply itself. The run result is still needed for the usage line, which is
already emitted from `afterResponse` (`adapter.ts:676-690`) and needs no caller.

## 5. The failure line, and recovery (Question 3)

An answered run is covered by the durable task; a failed one is covered by one sweep over the ledger
`movin.tg.turns` — a session doc written by the intake commit (§2a), pruned to ~24 h:

```
for (const entry of ledger.open) {                     // one commit for the whole pass
  const sub = await tx.submission(entry.id);           // Tx.submission, D/types.d.ts:911
  if (sub === undefined) { drop(entry); continue; }    // pruned by retention
  if (sub.status === "queued" || sub.status === "placed") { /* live: watchdog's business (§2c) */ continue; }
  if (sub.status === "done") { drop(entry); continue; }// the delivery task owns it
  if (entry.deadline > now()) continue;                // too new to conclude anything
  if (sub.entry === undefined) { drop(entry); continue; } // withdrawn before placement: Go sent nothing either
  await tx.createTask(Failure, { ...addressingFrom(await tx.entry(sub.entry)), reason: sub.reason }, …);
  drop(entry);
}
```

* Run at startup and on the same tick as the watchdog. `entry` has the chat/message/group; the
  refusal special case of `adapter.ts:1104-1114` ("a refusal is an answer", P1) moves here: if the
  last assistant message is a refusal, send its text instead of the fixed line.
* Ordering per chat: the failure task should `await (await runtime.conversation(id, ctx))?.waitForIdle(ctx)`
  (`D/harness/types.d.ts:120`) before sending, so a failure line never interleaves with the next
  reply's chunks.

**Runs still in progress after `resume()`** need nothing: their `finish`/`drain` phases are durable and
will ask `afterRun` in the new process. For the admin page and tests: `harness.inspect()` gives live
tasks and unsettled submissions (`D/harness/types.d.ts:743-750`); `tx.scanTasks({kind:"movin.tg.delivery",
status:"pending"})` (`D/types.d.ts:761-769,909`) finds undelivered replies; `tx.scanSubmissions`
does **not** exist — only `Storage.scanSubmissions(query, limit, cursor, ctx)` (`D/types.d.ts:1172`),
which the adapter *could* call on the handle it opened (`adapter.ts:493`) but should not: the Session
wraps that object and a raw call bypasses its failure guard. Everything above stays inside `Tx`.

## 6. What I could not determine / needs a decision

* **Whether `afterRun` can be limited to Telegram runs cheaply.** It fires for web runs too; the hook
  must sniff the input entry's `data` and return `undefined` (one `api.entry` read per run). No
  per-conversation hook selection exists other than configuring different extensions
  (`README.md:670`), which would mean a Telegram-only extension.
* **Retry policy for a failing `sendMessage`** (429 `retry_after`, 5xx, 400): the durable shape is a
  `sleepUntil` checkpoint plus an `attempts` counter in the checkpoint; the brief above settles
  `failed` immediately to stay short. T4.3 must choose the numbers (and the `…` text of the fixed
  failure line — `telegram-spec.md:1084-1086` leaves it open).
* **Whether a delivery task may overlap a `markdown`-free `editMessageReplyMarkup`** for a callback
  (spec §7) — callbacks are host work, not tasks, in this design; whether that is acceptable at-least-once
  is a T4.4 decision.
* **`Extension.tasks` typing:** the registry erases definitions (`D/harness/generation.js:735-757`),
  but `Task` → `AnyTask` assignability under `exactOptionalPropertyTypes` was not checked by
  compilation here.
* **Restore path (T5.3)** must abort pending delivery tasks *before* `resume()` — `plan.md:47` says so.
  That works with this design only because the kind is stable: `tx.scanTasks({kind:"movin.tg.delivery"})`
  + `harness.abortTask(id)` for each non-terminal one, whose abort handler above settles `aborted`
  without sending.
