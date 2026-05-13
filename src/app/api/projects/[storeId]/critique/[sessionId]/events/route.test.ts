import { test, expect, beforeEach } from "bun:test";
import {
  type IncomingSessionEvent,
  type ManagedAgentClient,
  setManagedAgentClient,
} from "@/lib/anthropic";
import { GET } from "./route";

function makeClient(events: IncomingSessionEvent[]): {
  client: ManagedAgentClient;
  openLog: string[];
} {
  const openLog: string[] = [];
  const client: ManagedAgentClient = {
    async createSession() {
      return { sessionId: "sess_x" };
    },
    async sendEvent() {},
    streamSession(sessionId) {
      openLog.push(sessionId);
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      };
    },
  };
  return { client, openLog };
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) acc += decoder.decode(value, { stream: true });
    if (done) break;
  }
  return acc;
}

beforeEach(() => {
  // nothing
});

test("forwards events including outcome-evaluation span events", async () => {
  const events: IncomingSessionEvent[] = [
    {
      type: "other",
      sessionId: "sess_x",
      eventId: "e1",
      rawType: "span.outcome_evaluation_start",
      raw: { type: "span.outcome_evaluation_start", iteration: 1 },
    },
    {
      type: "agent.message",
      sessionId: "sess_x",
      eventId: "e2",
      text: "scoring",
      raw: {},
    },
    {
      type: "other",
      sessionId: "sess_x",
      eventId: "e3",
      rawType: "span.outcome_evaluation_end",
      raw: { type: "span.outcome_evaluation_end", satisfied: true },
    },
    {
      type: "session.status_idle",
      sessionId: "sess_x",
      eventId: "e4",
      stopReason: "end_turn",
      raw: {},
    },
  ];
  const { client } = makeClient(events);
  setManagedAgentClient(client);

  const res = await GET(new Request("http://test/events"), {
    params: Promise.resolve({ storeId: "store_x", sessionId: "sess_x" }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const body = await readBody(res);
  expect(body).toContain("span.outcome_evaluation_start");
  expect(body).toContain("span.outcome_evaluation_end");
  expect(body).toContain("agent.message");
  expect(body).toContain("session.status_idle");
});

test("closes on session.status_idle end_turn", async () => {
  const events: IncomingSessionEvent[] = [
    {
      type: "session.status_idle",
      sessionId: "sess_x",
      eventId: "e1",
      stopReason: "end_turn",
      raw: {},
    },
    // This should never be delivered.
    {
      type: "agent.message",
      sessionId: "sess_x",
      eventId: "e2",
      text: "after-close",
      raw: {},
    },
  ];
  const { client } = makeClient(events);
  setManagedAgentClient(client);

  const res = await GET(new Request("http://test/events"), {
    params: Promise.resolve({ storeId: "store_x", sessionId: "sess_x" }),
  });
  const body = await readBody(res);
  expect(body).toContain("session.status_idle");
  expect(body).not.toContain("after-close");
});
