import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Set GUILD_ID for instant guild-scoped registration during dev;
// leave unset for global registration (can take up to ~1h to propagate).
const GUILD_ID = process.env.GUILD_ID;

// Discord ApplicationCommandOptionType: 1=Subcommand 3=String 4=Integer 8=Role 10=Number
const commands = [
  { name: "ping", description: "Check that Cutter is alive", type: 1 },
  {
    name: "setup",
    description: "Seed defaults and set the officer role (Manage Server)",
    type: 1,
    options: [
      {
        type: 8,
        name: "officer",
        description: "Role that can run privileged commands (e.g. Capo+)",
        required: true,
      },
    ],
  },
  {
    name: "config",
    description: "View or change the economy dials",
    type: 1,
    options: [
      { type: 1, name: "view", description: "Show the current dials" },
      {
        type: 1,
        name: "set",
        description: "Change a dial (officers only)",
        options: [
          {
            type: 3,
            name: "dial",
            description: "Which dial to change",
            required: true,
            choices: [
              { name: "Labor rate ($/unit)", value: "labor-rate" },
              { name: "Work split (%)", value: "work-split" },
              { name: "Sell commission (%)", value: "commission" },
            ],
          },
          {
            type: 10,
            name: "value",
            description: "New value",
            required: true,
          },
        ],
      },
    ],
  },
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
