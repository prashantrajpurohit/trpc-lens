import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";

export interface EventStoreOptions {
  historyPerProject: number;
  maxProjects: number;
}

/**
 * Bounded, in-memory, per-project event history.
 *
 * Each project is a Map keyed by event id. Map iteration follows insertion
 * order and `set` on an existing key keeps its slot, so this behaves as a
 * ring buffer (oldest evicted first) with O(1) in-place upserts.
 */
export class EventStore {
  private readonly history = new Map<string, Map<string, InspectorEvent>>();

  constructor(private readonly options: EventStoreOptions) {}

  /** Returns false if the event was dropped because the project cap is reached. */
  add(event: InspectorEvent): boolean {
    let events = this.history.get(event.projectId);
    if (!events) {
      if (this.history.size >= this.options.maxProjects) return false;
      events = new Map();
      this.history.set(event.projectId, events);
    }
    if (!events.has(event.id) && events.size >= this.options.historyPerProject) {
      const oldest = events.keys().next().value;
      if (oldest !== undefined) events.delete(oldest);
    }
    events.set(event.id, event);
    return true;
  }

  /** All events, grouped by project, oldest first within each project. */
  snapshot(): InspectorEvent[] {
    const out: InspectorEvent[] = [];
    for (const events of this.history.values()) out.push(...events.values());
    return out;
  }

  /** Clears one project (freeing its slot), or everything when omitted. */
  clear(projectId?: string): void {
    if (projectId === undefined) this.history.clear();
    else this.history.delete(projectId);
  }

  projects(): string[] {
    return [...this.history.keys()];
  }
}
