import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Set GUILD_ID for instant guild-scoped registration during dev;
// leave unset for global registration (can take up to ~1h to propagate).
const GUILD_ID = process.env.GUILD_ID;

const commands = [
  { name: "ping", description: "Check that Cutter is alive", type: 1 },
];

async function main() {
  const sm = new SecretsManagerClient({});
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: "cutter/discord" })
  );
  const { appId, botToken } = JSON.parse(res.SecretString ?? "{}");
  if (!appId || !botToken) {
    throw new Error("secret cutter/discord is missing appId/botToken");
  }

  const url = GUILD_ID
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${GUILD_ID}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  console.log(`${r.status} ${r.statusText}`);
  console.log(await r.text());
  if (!r.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
