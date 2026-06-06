import { verifyKey } from "discord-interactions";
import {
  InteractionType,
  InteractionResponseType,
  type APIInteraction,
  type APIInteractionResponse,
} from "discord-api-types/v10";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

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
  if (!valid) {
    return { statusCode: 401, body: "invalid request signature" };
  }

  const interaction = JSON.parse(rawBody) as APIInteraction;

  // Discord endpoint health check
  if (interaction.type === InteractionType.Ping) {
    return json({ type: InteractionResponseType.Pong });
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    const name = interaction.data.name;
    switch (name) {
      case "ping":
        return reply("🔪 Cutter is live. *pong.*");
      default:
        return reply(`Unknown command: \`${name}\``);
    }
  }

  return json({ type: InteractionResponseType.Pong });
}

function reply(content: string) {
  return json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content },
  });
}

function json(payload: APIInteractionResponse | Record<string, unknown>) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}
