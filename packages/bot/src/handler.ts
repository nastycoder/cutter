import { verifyKey } from "discord-interactions";
import {
  InteractionType,
  InteractionResponseType,
  type APIInteraction,
} from "discord-api-types/v10";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import * as store from "./store";
import {
  json,
  reply,
  commandName,
  subcommand,
  option,
  guildId,
  isOfficer,
} from "./discord";

interface DiscordSecret {
  publicKey: string;
  appId: string;
  botToken: string;
}

const sm = new SecretsManagerClient({});
let cachedSecret: DiscordSecret | undefined;

async function getSecret(): Promise<DiscordSecret> {
  if (cachedSecret) return cachedSecret;
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.DISCORD_SECRET_ARN! })
  );
  cachedSecret = JSON.parse(res.SecretString!) as DiscordSecret;
  return cachedSecret;
}

interface ProxyEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export async function handler(event: ProxyEvent) {
  const sig = event.headers?.["x-signature-ed25519"];
  const ts = event.headers?.["x-signature-timestamp"];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  const { publicKey } = await getSecret();
  const valid = !!sig && !!ts && (await verifyKey(rawBody, sig, ts, publicKey));
  if (!valid) return { statusCode: 401, body: "invalid request signature" };

  const interaction = JSON.parse(rawBody) as APIInteraction;

  if (interaction.type === InteractionType.Ping) {
    return json({ type: InteractionResponseType.Pong });
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    try {
      return await route(interaction);
    } catch (err) {
      console.error("command error", err);
      return reply("⚠️ Something went wrong handling that command.");
    }
  }

  return json({ type: InteractionResponseType.Pong });
}

async function route(i: any) {
  switch (commandName(i)) {
    case "ping":
      return reply("🔪 Cutter is live. *pong.*");
    case "setup":
      return handleSetup(i);
    case "config":
      return handleConfig(i);
    default:
      return reply(`Unknown command: \`${commandName(i)}\``);
  }
}

async function handleSetup(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  if (!isOfficer(i, config)) {
    return reply("⛔ `/setup` requires the **Manage Server** permission.");
  }
  const officerRoleId = option<string>(i, "officer");
  await store.seedDefaults(gid);
  await store.putConfig(gid, { ...config, officerRoleId });
  return reply(
    [
      "🛠️ **Cutter is set up.**",
      `• Officer role: <@&${officerRoleId}>`,
      "• Seeded product line **Honey** (catalog · recipes)",
      "• Default dials: labor $25/unit · 70/30 work·rank · 8% commission · ranks 5/4/3/2/1",
      "",
      "Next: map your ranks with `/rank map`, then tune with `/config`.",
    ].join("\n")
  );
}

async function handleConfig(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  const sub = subcommand(i);

  if (sub === "set") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const dial = option<string>(i, "dial")!;
    const value = option<number>(i, "value")!;
    if (dial === "labor-rate") config.laborRate = value;
    else if (dial === "work-split") config.workSplitPct = value / 100;
    else if (dial === "commission") config.commissionPct = value / 100;
    await store.putConfig(gid, config);
    return reply(`✅ Updated **${dial}** → ${value}.`);
  }

  // view
  const lines = await store.listLines(gid);
  const refs =
    lines.map((l) => `${l.name} $${l.referencePrice}`).join(" · ") || "—";
  const mults = Object.entries(config.rankMultipliers)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([lvl, w]) => `${w}×`)
    .join(" / ");
  return reply(
    [
      "⚙️ **Economy dials**",
      `• Labor rate: **$${config.laborRate}** / unit`,
      `• Work / Rank split: **${Math.round(config.workSplitPct * 100)} / ${Math.round(
        (1 - config.workSplitPct) * 100
      )}**`,
      `• Sell commission: **${Math.round(config.commissionPct * 100)}%**`,
      `• Rank weights (I→V): **${mults}**`,
      `• Reference prices: ${refs}`,
      `• Officer role: ${config.officerRoleId ? `<@&${config.officerRoleId}>` : "_unset_"}`,
    ].join("\n")
  );
}
