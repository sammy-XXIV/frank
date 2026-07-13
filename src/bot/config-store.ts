/**
 * Tiny JSON-file persistence for per-guild bot settings. One bot deployment
 * serves ONE community (one wallet = one subscription = one docs tenant on
 * Frank), but config is keyed by guildId anyway so nothing breaks if the bot
 * is in a test guild + real guild at once during a demo.
 */
import fs from "node:fs";
import path from "node:path";

export interface GuildConfig {
  projectName?: string;
  /** Channel Frank auto-ingests announcements from. */
  announceChannelId?: string;
}

const FILE = path.resolve(process.cwd(), "bot-config.json");

type Store = Record<string, GuildConfig>;

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

export function getGuildConfig(guildId: string): GuildConfig {
  return load()[guildId] ?? {};
}

export function setGuildConfig(guildId: string, patch: Partial<GuildConfig>): GuildConfig {
  const store = load();
  store[guildId] = { ...store[guildId], ...patch };
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  return store[guildId];
}
