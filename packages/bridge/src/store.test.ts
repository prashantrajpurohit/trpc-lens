import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
import { describe, expect, it } from "vitest";
import { EventStore } from "./store";

function event(id: string, overrides: Partial<InspectorEvent> = {}): InspectorEvent {
  return {
    id,
    projectId: "app-a",
    timestamp: 1,
    path: "user.get",
    type: "query",
    source: "client",
    status: "pending",
    ...overrides,
  };
}

const ids = (events: InspectorEvent[]) => events.map((e) => e.id);

describe("EventStore", () => {
  it("evicts the oldest event once historyPerProject is reached", () => {
    const store = new EventStore({ historyPerProject: 3, maxProjects: 5 });
    for (const id of ["1", "2", "3", "4", "5"]) store.add(event(id));
    expect(ids(store.snapshot())).toEqual(["3", "4", "5"]);
  });

  it("upserts by id in place, keeping the original position", () => {
    const store = new EventStore({ historyPerProject: 10, maxProjects: 5 });
    store.add(event("1"));
    store.add(event("2"));
    store.add(event("3"));
    store.add(event("2", { status: "success", durationMs: 4 }));
    const snapshot = store.snapshot();
    expect(ids(snapshot)).toEqual(["1", "2", "3"]);
    expect(snapshot[1]).toMatchObject({ status: "success", durationMs: 4 });
  });

  it("does not evict when upserting into a full buffer", () => {
    const store = new EventStore({ historyPerProject: 2, maxProjects: 5 });
    store.add(event("1"));
    store.add(event("2"));
    store.add(event("1", { status: "error" }));
    expect(ids(store.snapshot())).toEqual(["1", "2"]);
  });

  it("keeps projects separate and caps the number of projects", () => {
    const store = new EventStore({ historyPerProject: 10, maxProjects: 2 });
    expect(store.add(event("1", { projectId: "a" }))).toBe(true);
    expect(store.add(event("1", { projectId: "b" }))).toBe(true);
    expect(store.add(event("1", { projectId: "c" }))).toBe(false);
    expect(store.add(event("2", { projectId: "a" }))).toBe(true);
    expect(store.projects()).toEqual(["a", "b"]);
    expect(store.snapshot()).toHaveLength(3);
  });

  it("clears one project (freeing its slot) or everything", () => {
    const store = new EventStore({ historyPerProject: 10, maxProjects: 2 });
    store.add(event("1", { projectId: "a" }));
    store.add(event("1", { projectId: "b" }));
    store.clear("a");
    expect(store.projects()).toEqual(["b"]);
    expect(store.add(event("1", { projectId: "c" }))).toBe(true);
    store.clear();
    expect(store.projects()).toEqual([]);
    expect(store.snapshot()).toEqual([]);
  });
});
