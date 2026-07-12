import { answerQuestion, settleDispute, draftEventPost } from "./reasoning.js";
import type { ProjectKnowledge } from "./knowledge.js";

const kb: ProjectKnowledge = {
  projectName: "MoonPixel DAO",
  docs: `
RULES:
1. No harassment, personal attacks, or slurs — instant 1-day timeout, repeat offense = ban.
2. No unsolicited DM pitching or spam links in any channel.
3. Be respectful during price discussions — FUD and shilling are both fine, personal insults are not.
4. Off-topic chat is welcome in #general, keep #trading-talk on topic.

FAQ:
- Vesting schedule: Team tokens vest linearly over 24 months, 6-month cliff. Public sale tokens have no vesting, fully unlocked at TGE.
- How to get whitelisted: Fill out the form pinned in #whitelist, applications reviewed weekly on Fridays.
- Contract address: 0xMOONPIXELCONTRACTADDRESSPLACEHOLDER (always verify against the pinned message — we do not DM addresses).

TONE: Casual, a little irreverent, we use "gm" a lot, avoid corporate-speak.
`.trim(),
};

async function main() {
  console.log("=== QA mode ===");
  const qa1 = await answerQuestion(kb, "when do team tokens unlock?");
  console.log(JSON.stringify(qa1, null, 2));

  const qa2 = await answerQuestion(kb, "what's the current price target?");
  console.log(JSON.stringify(qa2, null, 2));

  console.log("\n=== Dispute mode ===");
  const dispute1 = await settleDispute(
    kb,
    `User_A: "your project is a scam and you're all idiots for buying this shit"
User_B: "chill man that's not helpful, why don't you think it's legit"
User_A: "because youre all braindead sheep who deserve to get rugged"`
  );
  console.log(JSON.stringify(dispute1, null, 2));

  const dispute2 = await settleDispute(
    kb,
    `User_C: "I think the roadmap is too slow, we should have shipped v2 by now"
User_D: "disagree, rushing it would be worse, look what happened to [other project]"
User_C: "fair point, I hadn't considered that angle"`
  );
  console.log(JSON.stringify(dispute2, null, 2));

  console.log("\n=== Event mode ===");
  const event1 = await draftEventPost(kb, "AMA with the founding team next Friday 3pm UTC in voice chat, Q&A after");
  console.log(JSON.stringify(event1, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
