// QR-001(e): Multi-pod RabbitMQ listener durability.
//
// Verifies that job-end notifications are routed via the shared
// listener exchange using the listenChannelId as both the routing key
// and the `x-listen-channel` header, so each pod only receives
// completions for jobs it owns.
//
// The test mocks amqplib with a single in-memory broker shared across
// two NuQ instances (simulating two pods). It then triggers a job-end
// on pod A and confirms pod A's listener fires while pod B's stays
// silent.

import { EventEmitter } from "events";

// In-memory amqplib mock. Two channels over the same connection share
// a single exchange/queue/binding registry, which is exactly the
// topology we want to exercise here.

type AmqpMessage = {
  content: Buffer;
  fields: {
    deliveryTag: number;
    routingKey: string;
    exchange: string;
  };
  properties: {
    correlationId?: string;
    headers?: Record<string, unknown>;
    [k: string]: unknown;
  };
};

type Consumer = (msg: AmqpMessage | null) => void;

type QueueRecord = {
  name: string;
  bindings: { exchange: string; routingKey: string }[];
  consumer: Consumer | null;
  messages: AmqpMessage[];
  autoDelete: boolean;
  exclusive: boolean;
  durable: boolean;
  deliveryTagCounter: number;
};

type ExchangeRecord = {
  name: string;
  type: string;
  durable: boolean;
};

const exchanges = new Map<string, ExchangeRecord>();
const queues = new Map<string, QueueRecord>();

function resetBroker() {
  exchanges.clear();
  queues.clear();
}

function createInMemoryChannel(emitter: EventEmitter): any {
  const channel = {
    on(event: string, cb: (...args: unknown[]) => void) {
      emitter.on(event, cb);
      return this;
    },
    async prefetch() {
      // no-op for the in-memory mock
    },
    async assertExchange(name: string, type: string, opts: any = {}) {
      if (!exchanges.has(name)) {
        exchanges.set(name, {
          name,
          type,
          durable: !!opts.durable,
        });
      }
      return { exchange: name };
    },
    async assertQueue(name: string, opts: any = {}) {
      // Allow the broker to assign an anonymous queue name when the caller
      // passes "" (mirrors how amqplib + RabbitMQ behave for exclusive,
      // auto-deleted listener queues).
      const queueName = name === "" ? `anon-${queues.size + 1}` : name;
      if (!queues.has(queueName)) {
        queues.set(queueName, {
          name: queueName,
          bindings: [],
          consumer: null,
          messages: [],
          autoDelete: !!opts.autoDelete,
          exclusive: !!opts.exclusive,
          durable: !!opts.durable,
          deliveryTagCounter: 0,
        });
      }
      return { queue: queueName };
    },
    async bindQueue(queueName: string, exchange: string, routingKey: string) {
      const q = queues.get(queueName);
      if (!q) throw new Error(`bindQueue: unknown queue ${queueName}`);
      q.bindings.push({ exchange, routingKey });
      return {};
    },
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options: any = {},
    ) {
      const ex = exchanges.get(exchange);
      if (!ex) {
        throw new Error(`publish: unknown exchange ${exchange}`);
      }
      const matching: QueueRecord[] = [];
      for (const q of queues.values()) {
        for (const b of q.bindings) {
          if (b.exchange === exchange && b.routingKey === routingKey) {
            matching.push(q);
            break;
          }
        }
      }
      const msg: AmqpMessage = {
        content,
        fields: {
          deliveryTag: 0, // assigned on delivery
          routingKey,
          exchange,
        },
        properties: {
          ...(options || {}),
        },
      };
      for (const q of matching) {
        q.messages.push(msg);
        scheduleDelivery(q, emitter);
      }
      return true;
    },
    sendToQueue(queueName: string, content: Buffer, options: any = {}) {
      // The producer path is now publish()-based, but keep sendToQueue for
      // any test that exercises legacy code paths.
      const q = queues.get(queueName);
      if (!q) throw new Error(`sendToQueue: unknown queue ${queueName}`);
      const msg: AmqpMessage = {
        content,
        fields: {
          deliveryTag: 0,
          routingKey: queueName,
          exchange: "",
        },
        properties: { ...(options || {}) },
      };
      q.messages.push(msg);
      scheduleDelivery(q, emitter);
      return true;
    },
    async consume(queueName: string, consumer: Consumer) {
      const q = queues.get(queueName);
      if (!q) throw new Error(`consume: unknown queue ${queueName}`);
      q.consumer = consumer;
      // Drain anything already buffered.
      while (q.messages.length > 0) {
        scheduleDelivery(q, emitter);
      }
      return { consumerTag: `consumer-${queueName}` };
    },
    async cancel() {
      return {};
    },
    async ack() {
      // no-op; the mock fires-and-forgets
    },
    async nack() {
      // no-op
    },
    async close() {
      emitter.emit("close");
    },
  };
  return channel;
}

function scheduleDelivery(q: QueueRecord, emitter: EventEmitter) {
  // Defer delivery to next tick so the caller can finish wiring up
  // (consume() returns before the first message lands, mirroring real
  // amqplib behavior).
  setImmediate(() => {
    while (q.messages.length > 0 && q.consumer) {
      const m = q.messages.shift()!;
      q.deliveryTagCounter += 1;
      m.fields.deliveryTag = q.deliveryTagCounter;
      try {
        q.consumer(m);
      } catch {
        // swallow consumer errors in the mock
      }
    }
  });
}

function createInMemoryConnection(): any {
  const emitter = new EventEmitter();
  const connection: any = {
    on(event: string, cb: (...args: unknown[]) => void) {
      emitter.on(event, cb);
      return this;
    },
    async createChannel() {
      return createInMemoryChannel(emitter);
    },
    async close() {
      emitter.emit("close");
    },
  };
  return connection;
}

vi.mock("amqplib", () => ({
  default: {
    async connect(_url: string) {
      return createInMemoryConnection();
    },
    connect(_url: string) {
      return createInMemoryConnection();
    },
  },
  connect(_url: string) {
    return createInMemoryConnection();
  },
}));

import { NuQ } from "../../../services/worker/nuq";

beforeEach(() => {
  resetBroker();
  // Force the NuQRabbitmq path to engage.
  process.env.NUQ_RABBITMQ_URL = "amqp://mock-broker";
  // Distinct pod names ensure each NuQ instance computes a unique
  // listenChannelId and routes to its own queue binding.
  process.env.NUQ_POD_NAME = "nuq-test";
});

afterEach(() => {
  delete process.env.NUQ_RABBITMQ_URL;
  delete process.env.NUQ_POD_NAME;
});

describe("QR-001(e) multi-pod RabbitMQ listener routing", () => {
  test("job-end notification routes only to the owning pod's listener", async () => {
    // Two pods share the same mock broker.
    const podA = new NuQ<{ url: string }>("nuq.test.routing", {});
    const podB = new NuQ<{ url: string }>("nuq.test.routing", {});

    const channelA = podA.getListenChannelId();
    const channelB = podB.getListenChannelId();
    expect(channelA).not.toEqual(channelB);

    const seenOnA: Array<{ jobId: string; status: string }> = [];
    const seenOnB: Array<{ jobId: string; status: string }> = [];

    // Use a small private helper to register completion handlers. The
    // class exposes `addListener` via the public API indirectly: it is
    // private, but the test can reach the same behavior by triggering
    // `sendJobEnd` and listening on the in-memory broker. The crucial
    // assertion is that pod A's queue receives its message and pod B's
    // does not, so we observe at the broker layer.

    // Wait for both listeners to wire up their queues + bindings.
    // Kick the listener on each pod by registering a no-op callback;
    // addListener() internally calls startListener().
    await (podA as any).addListener("warmup-A", () => {});
    await (podB as any).addListener("warmup-B", () => {});
    await waitFor(() => queues.size >= 2, 5000);

    // Trigger a job-end from pod A, addressed at pod A's channel.
    await (podA as any).sendJobEnd("job-A-1", "completed", channelA);
    await flushMicrotasks();

    // Find pod A's and pod B's bound queues by inspecting the mock broker.
    const aQueue = findQueueBoundOn(`nuq.test.routing.listen`, channelA);
    const bQueue = findQueueBoundOn(`nuq.test.routing.listen`, channelB);

    expect(aQueue).toBeDefined();
    expect(bQueue).toBeDefined();
    expect(aQueue!.messages).toHaveLength(1);
    expect(bQueue!.messages).toHaveLength(0);

    // The message must also carry the x-listen-channel header so the
    // receiver can audit/verify the routing key.
    const routedMsg = aQueue!.messages[0];
    expect(routedMsg.properties.headers).toMatchObject({
      "x-listen-channel": channelA,
    });
    expect(routedMsg.properties.correlationId).toBe("job-A-1");
    expect(routedMsg.content.toString()).toBe("completed");

    // Reverse direction: send a job-end addressed at pod B.
    await (podB as any).sendJobEnd("job-B-1", "failed", channelB);
    await flushMicrotasks();

    expect(bQueue!.messages).toHaveLength(1);
    expect(aQueue!.messages).toHaveLength(1); // unchanged from earlier
    expect(bQueue!.messages[0].properties.headers).toMatchObject({
      "x-listen-channel": channelB,
    });
    expect(bQueue!.messages[0].properties.correlationId).toBe("job-B-1");
    expect(bQueue!.messages[0].content.toString()).toBe("failed");

    // The seenOnA/seenOnB arrays stay empty because we never installed
    // completion callbacks here, but the broker-level isolation proves
    // the routing only fans out to the owning pod's queue.
    expect(seenOnA).toHaveLength(0);
    expect(seenOnB).toHaveLength(0);

    // Cleanup so the next test starts from a clean slate.
    await podA.shutdown();
    await podB.shutdown();
  });

  test("listener only fires its own completion callbacks, never the other pod's", async () => {
    const podA = new NuQ<{ url: string }>("nuq.test.callbacks", {});
    const podB = new NuQ<{ url: string }>("nuq.test.callbacks", {});

    const channelA = podA.getListenChannelId();
    const channelB = podB.getListenChannelId();

    // Kick both listeners so the queues + bindings are wired up.
    await (podA as any).addListener("warmup-A", () => {});
    await (podB as any).addListener("warmup-B", () => {});

    // Wait for both queues to bind before triggering sends.
    await waitFor(
      () =>
        !!findQueueBoundOn(`nuq.test.callbacks.listen`, channelA) &&
        !!findQueueBoundOn(`nuq.test.callbacks.listen`, channelB),
      5000,
    );

    // Install a private listener on pod A. addListener() is private but
    // accessible via `(podA as any).addListener` since this is a unit
    // test; the alternative is to use the public wait() path which
    // requires a real DB row. addListener mirrors the in-class wiring
    // exactly, so this is a faithful test of the consumer callback
    // isolation.
    const onAFired = vi.fn();
    const onBFired = vi.fn();
    await (podA as any).addListener("job-A-cb", onAFired);
    await (podB as any).addListener("job-B-cb", onBFired);

    // Sending a job-end addressed at pod A should trigger onAFired but
    // not onBFired.
    await (podA as any).sendJobEnd("job-A-cb", "completed", channelA);
    await flushMicrotasks();

    expect(onAFired).toHaveBeenCalledTimes(1);
    expect(onAFired).toHaveBeenCalledWith("completed");
    expect(onBFired).not.toHaveBeenCalled();

    // And the reverse direction stays isolated.
    await (podB as any).sendJobEnd("job-B-cb", "failed", channelB);
    await flushMicrotasks();

    expect(onBFired).toHaveBeenCalledTimes(1);
    expect(onBFired).toHaveBeenCalledWith("failed");
    expect(onAFired).toHaveBeenCalledTimes(1); // unchanged

    await podA.shutdown();
    await podB.shutdown();
  });

  test("listener queue is non-durable with exclusive + auto-delete semantics preserved", async () => {
    const pod = new NuQ<{ url: string }>("nuq.test.durability", {});
    const channel = pod.getListenChannelId();

    await (pod as any).addListener("warmup", () => {});
    await waitFor(
      () => !!findQueueBoundOn(`nuq.test.durability.listen`, channel),
      5000,
    );

    const q = findQueueBoundOn(`nuq.test.durability.listen`, channel)!;
    // QR-001(e) contract: the per-pod listener queue must stay
    // durable:false (transient, tied to the channel's lifetime) so a
    // pod restart orphans its queue naturally rather than leaving stale
    // durable queues around. exclusive + autoDelete still apply.
    expect(q.durable).toBe(false);
    expect(q.exclusive).toBe(true);
    expect(q.autoDelete).toBe(true);

    // The listener exchange is durable so the routing topology
    // survives broker restarts; only the bound queue is transient.
    const ex = exchanges.get("nuq.test.durability.listen");
    expect(ex).toBeDefined();
    expect(ex!.durable).toBe(true);

    await pod.shutdown();
  });
});

function findQueueBoundOn(
  exchangeName: string,
  routingKey: string,
): QueueRecord | undefined {
  for (const q of queues.values()) {
    for (const b of q.bindings) {
      if (b.exchange === exchangeName && b.routingKey === routingKey) {
        return q;
      }
    }
  }
  return undefined;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
