/**
 * File-backed persistence for Frank's three state stores, so redeploys and
 * restarts never lose docs, quotas, or subscription state again.
 *
 * DATA_DIR points at a Railway volume in production (survives deploys) and
 * ./data locally. Writes are synchronous write-through on every mutation —
 * state is tiny (KBs) and correctness beats micro-optimization here.
 */
import fs from "node:fs";
import path from "node:path";
import type { Subscription } from "@okxweb3/app-x402-core/subscription";
import { InMemoryStore } from "@okxweb3/app-x402-core/subscription";

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function fileFor(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

function loadJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson(name: string, value: unknown): void {
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file); // atomic-ish: no torn files on crash mid-write
}

/** A Map<string, V> that reloads from disk at boot and write-through persists. */
export class PersistentMap<V> {
  private map: Map<string, V>;

  constructor(private name: string) {
    this.map = new Map(Object.entries(loadJson<Record<string, V>>(name, {})));
  }

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): this {
    this.map.set(key, value);
    saveJson(this.name, Object.fromEntries(this.map));
    return this;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * SubscriptionStore with the same interface as InMemoryStore (get/put/delete/
 * list) but persisted to disk, so active subscriptions survive restarts even
 * without the facilitator-rehydration fallback.
 */
export class FileSubscriptionStore extends InMemoryStore {
  private static NAME = "subscriptions";

  constructor() {
    super();
    for (const sub of Object.values(
      loadJson<Record<string, Subscription>>(FileSubscriptionStore.NAME, {})
    )) {
      void super.put(sub);
    }
  }

  override async put(sub: Subscription): Promise<void> {
    await super.put(sub);
    await this.flush();
  }

  override async delete(subId: string): Promise<void> {
    await super.delete(subId);
    await this.flush();
  }

  private async flush(): Promise<void> {
    const all = await this.list();
    saveJson(
      FileSubscriptionStore.NAME,
      Object.fromEntries(all.map((s) => [s.subId, s]))
    );
  }
}
