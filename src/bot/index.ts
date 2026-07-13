/**
 * Frank's Discord bridge — the buyer-side companion bot.
 *
 * A community that subscribed to Frank on OKX.AI runs this with their own
 * Discord bot token + the wallet that holds the subscription. It wires
 * Discord surface area to Frank's paid API:
 *
 *   /setup    → POST /onboard   (docs via text or attached file) + announcements channel
 *   /learn    → POST /learn     (incremental update)
 *   /ask + @mention → POST /qa
 *   /dispute  → POST /dispute   (reads recent channel messages, EXECUTES timeouts)
 *   /event    → POST /event
 *   announcements channel posts → POST /learn automatically (Frank stays current)
 *
 * Env: DISCORD_TOKEN, FRANK_URL, FRANK_SUB_ID, PAYER_PRIVATE_KEY
 */
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { FrankApiError, FrankClient, type DisputeResult } from "./frank-client.js";
import { getGuildConfig, setGuildConfig } from "./config-store.js";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const frank = new FrankClient({
  baseUrl: requireEnv("FRANK_URL"),
  subId: requireEnv("FRANK_SUB_ID") as `0x${string}`,
  privateKey: requireEnv("PAYER_PRIVATE_KEY") as `0x${string}`,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ---------- slash command definitions ----------

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Onboard this server: give Frank your docs and pick an announcements channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("project_name").setDescription("Your project's name").setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName("announcements")
        .setDescription("Channel Frank auto-learns updates from")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addAttachmentOption((o) =>
      o.setName("docs_file").setDescription("Text/markdown file with rules, FAQ, tone guide")
    )
    .addStringOption((o) =>
      o.setName("docs_text").setDescription("Or paste docs inline (for short docs)")
    ),
  new SlashCommandBuilder()
    .setName("learn")
    .setDescription("Teach Frank one update without re-uploading all docs.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("update").setDescription("The new fact/rule/announcement").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Frank a question about this project.")
    .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder()
    .setName("dispute")
    .setDescription("Have Frank adjudicate the recent conversation in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addIntegerOption((o) =>
      o
        .setName("messages")
        .setDescription("How many recent messages to review (default 15)")
        .setMinValue(2)
        .setMaxValue(50)
    ),
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Draft an event announcement in your project's tone.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("brief").setDescription("What/when/where of the event").setRequired(true)
    ),
].map((c) => c.toJSON());

// ---------- helpers ----------

function friendlyError(err: unknown): string {
  if (err instanceof FrankApiError) {
    const body = err.body as { error?: string } | undefined;
    if (err.status === 402) {
      return `Payment/subscription issue: ${body?.error ?? "subscription inactive or quota reached"}`;
    }
    return body?.error ?? `Frank returned ${err.status}`;
  }
  return (err as Error).message ?? "unknown error";
}

const TIMEOUT_MS: Record<string, number> = {
  timeout_5m: 5 * 60 * 1000,
  timeout_1h: 60 * 60 * 1000,
  timeout_1d: 24 * 60 * 60 * 1000,
};

/**
 * Frank names the violating party by the display name it saw in the
 * transcript; map that back to the actual guild member among the authors of
 * the reviewed messages (never timeout someone who wasn't in the excerpt).
 */
function resolveMember(name: string | null, msgs: Message[]): GuildMember | null {
  if (!name) return null;
  const needle = name.toLowerCase();
  for (const m of msgs) {
    const member = m.member;
    if (!member) continue;
    if (
      member.displayName.toLowerCase() === needle ||
      member.user.username.toLowerCase() === needle
    ) {
      return member;
    }
  }
  return null;
}

async function executeDisputeAction(
  result: DisputeResult,
  msgs: Message[]
): Promise<string> {
  const action = result.recommendedAction;
  if (action === "none") return "No action needed.";
  if (action === "escalate_to_human") return "⚠️ Escalated — a human mod should review this one.";

  const member = resolveMember(result.violatingParty, msgs);
  if (!member) {
    return `Recommended **${action}** for "${result.violatingParty}", but I couldn't match them to a member in the reviewed messages — no action taken.`;
  }

  if (action === "warn") {
    return `⚠️ **${member.displayName}** — this is a formal warning: ${result.ruleViolated ?? "rule violation"}.`;
  }

  const ms = TIMEOUT_MS[action];
  if (ms && member.moderatable) {
    await member.timeout(ms, `Frank: ${result.ruleViolated ?? result.summary}`);
    return `🔨 Timed out **${member.displayName}** (${action.replace("timeout_", "")}) — ${result.ruleViolated}.`;
  }
  return `Recommended ${action} for **${member.displayName}** but I lack permission to time them out (need Moderate Members + a role above theirs).`;
}

// ---------- interaction handlers ----------

async function handleSetup(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const projectName = i.options.getString("project_name", true);
  const announcements = i.options.getChannel("announcements", true);
  const file = i.options.getAttachment("docs_file");
  const inline = i.options.getString("docs_text");

  let docs = inline ?? "";
  if (file) {
    const res = await fetch(file.url);
    docs = await res.text();
  }
  if (!docs.trim()) {
    await i.editReply("Give me docs — either attach a text file or use `docs_text`.");
    return;
  }

  await frank.onboard(projectName, docs);
  setGuildConfig(i.guildId!, { projectName, announceChannelId: announcements.id });
  await i.editReply(
    `✅ **${projectName}** onboarded (${docs.length.toLocaleString()} chars of docs). ` +
      `I'll auto-learn from <#${announcements.id}>. Members can /ask or @mention me.`
  );
}

async function handleLearn(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const update = i.options.getString("update", true);
  const { updates } = await frank.learn(update);
  await i.editReply(`🧠 Learned. (${updates} update${updates === 1 ? "" : "s"} on file)`);
}

async function handleAsk(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const q = i.options.getString("question", true);
  const r = await frank.ask(q);
  await i.editReply(
    r.answered
      ? `${r.answer}\n\n-# grounded in: ${r.groundedIn} · confidence: ${r.confidence}`
      : `I can't answer that from this project's docs — ask a mod to /learn it. (${r.answer})`
  );
}

async function handleDispute(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const count = i.options.getInteger("messages") ?? 15;
  const channel = i.channel as TextChannel;
  const fetched = await channel.messages.fetch({ limit: count });
  const msgs = [...fetched.values()]
    .filter((m) => !m.author.bot && m.content.trim())
    .reverse(); // oldest → newest reads like a transcript

  if (msgs.length < 2) {
    await i.editReply("Not enough recent human messages here to adjudicate.");
    return;
  }

  const transcript = msgs
    .map((m) => `${m.member?.displayName ?? m.author.username}: "${m.content}"`)
    .join("\n");

  const result = await frank.dispute(transcript);
  const acted = await executeDisputeAction(result, msgs);
  await i.editReply(
    `**Verdict:** ${result.summary}\n**Reasoning:** ${result.reasoning}\n\n${acted}\n-# confidence: ${result.confidence}`
  );
}

async function handleEvent(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const brief = i.options.getString("brief", true);
  const r = await frank.event(brief);
  await i.editReply(`${r.announcementText}\n\n-# tone: ${r.groundedInTone}`);
}

// ---------- wiring ----------

client.once(Events.ClientReady, async (c) => {
  for (const [, guild] of c.guilds.cache) {
    await guild.commands.set(commands);
  }
  console.log(`Frank bridge online as ${c.user.tag}, payer ${frank.payer}`);
});

client.on(Events.GuildCreate, async (guild) => {
  await guild.commands.set(commands);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || !i.inGuild()) return;
  try {
    if (i.commandName === "setup") await handleSetup(i);
    else if (i.commandName === "learn") await handleLearn(i);
    else if (i.commandName === "ask") await handleAsk(i);
    else if (i.commandName === "dispute") await handleDispute(i);
    else if (i.commandName === "event") await handleEvent(i);
  } catch (err) {
    console.error(`${i.commandName} failed:`, err);
    const msg = `❌ ${friendlyError(err)}`;
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.inGuild()) return;

  const cfg = getGuildConfig(msg.guildId);

  // Auto-learn: posts in the announcements channel become knowledge — but only
  // from members with Manage Server. Without this gate, any member posting in
  // an unlocked channel could poison Frank's knowledge (e.g. a fake contract
  // address), and updates deliberately override base docs.
  if (
    cfg.announceChannelId &&
    msg.channelId === cfg.announceChannelId &&
    msg.content.trim() &&
    msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    try {
      await frank.learn(msg.content);
      await msg.react("🧠");
    } catch (err) {
      console.error("auto-learn failed:", err);
    }
    return;
  }

  // @mention → QA
  if (client.user && msg.mentions.has(client.user) && !msg.mentions.everyone) {
    const question = msg.content.replaceAll(`<@${client.user.id}>`, "").trim();
    if (!question) return;
    try {
      await msg.channel.sendTyping();
      const r = await frank.ask(question);
      await msg.reply(
        r.answered
          ? `${r.answer}\n-# ${r.groundedIn} · ${r.confidence}`
          : `Not covered in this project's docs — a mod can /learn it.`
      );
    } catch (err) {
      console.error("mention-qa failed:", err);
      await msg.reply(`❌ ${friendlyError(err)}`).catch(() => {});
    }
  }
});

client.login(requireEnv("DISCORD_TOKEN"));
