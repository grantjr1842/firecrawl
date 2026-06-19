# QR-001(e) — Multi-pod RabbitMQ listener durability

**Status:** shipped in HEAD.

## Problem

The NuQ RabbitMQ listener path gave each pod a queue named
`{queueName}.listen.{listenChannelId}` and had the sender `sendToQueue()` the
recipient's queue by name. That worked for a single-pod smoke test, but it
tied routing to ephemeral queue names and forced the broker to track one
queue per channel id. Reconnects, pod restarts, and broker restarts each
required re-asserting queues in lock-step with sender bookkeeping.

## Fix

Route job-end notifications through a shared **direct exchange**
(`{queueName}.listen`, durable: `true`) keyed on the recipient pod's
`listenChannelId`:

- Listener: each pod asserts an **exclusive, auto-deleted, non-durable**
  queue bound to the exchange with `routingKey = this.listenChannelId`.
- Sender: publishes to the exchange with
  `routingKey = listenChannelId` and stamps the same id in the
  `x-listen-channel` header for observability.
- Receiver: defensively nacks any message whose `x-listen-channel` header
  does not match this pod's id, so a misrouted message can never trigger
  the wrong callback.

The exchange survives broker restarts (it's durable); only the bound queue
is transient — when a pod shuts down, RabbitMQ auto-deletes the queue and
its binding, leaving the topology intact for the next pod that comes
online.

## Tests

`apps/api/src/__tests__/services/worker/nuq-listener-routing.test.ts`
simulates two pods sharing a single in-memory broker mock:

1. `job-end notification routes only to the owning pod's listener` —
   verifies the publisher sets `x-listen-channel` as both routing key and
   header, and that delivery lands only on the bound queue.
2. `listener only fires its own completion callbacks, never the other
pod's` — verifies end-to-end consumer isolation.
3. `listener queue is non-durable with exclusive + auto-delete
semantics preserved` — guards the QR-001(e) durability contract.

All three pass under `pnpm vitest run` for the file.

## Verification

```bash
# typecheck
cd apps/api && npx tsc --noEmit

# knip (must be clean — no new dead exports)
cd apps/api && npx knip

# targeted vitest
cd apps/api && npx vitest run src/__tests__/services/worker/nuq-listener-routing.test.ts
```

## Files touched

- `apps/api/src/services/worker/nuq.ts` — listener now uses
  `assertExchange` + `bindQueue`; sender publishes via `publish()` with
  `x-listen-channel` header; `NuQ` is now exported and exposes
  `getListenChannelId()` for tests.
- `apps/api/src/__tests__/services/worker/nuq-listener-routing.test.ts`
  — new vitest integration test with an in-memory amqplib mock.
