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
      { type: 1, name: "panel", description: "Open the interactive dial panel (officers only)" },
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
  {
    name: "catalog",
    description: "Manage catalog items & prices",
    type: 1,
    options: [
      { type: 1, name: "list", description: "List catalog items & values" },
      {
        type: 1,
        name: "add",
        description: "Add a new item (officers only)",
        options: [
          { type: 3, name: "name", description: "Item name (e.g. Syringe)", required: true },
          { type: 10, name: "value", description: "Catalog value ($)", required: true },
          {
            type: 3,
            name: "source",
            description: "farmed or bought (default bought)",
            required: false,
            choices: [
              { name: "farmed", value: "farmed" },
              { name: "bought", value: "bought" },
            ],
          },
          {
            type: 3,
            name: "kind",
            description: "base / intermediate / final (default base)",
            required: false,
            choices: [
              { name: "base", value: "base" },
              { name: "intermediate", value: "intermediate" },
              { name: "final", value: "final" },
            ],
          },
        ],
      },
      {
        type: 1,
        name: "set",
        description: "Update an existing item's price (officers only)",
        options: [
          { type: 3, name: "item", description: "Pick an item", required: true, autocomplete: true },
          { type: 10, name: "value", description: "New value ($)", required: true },
          {
            type: 3,
            name: "source",
            description: "Change source (optional)",
            required: false,
            choices: [
              { name: "farmed", value: "farmed" },
              { name: "bought", value: "bought" },
            ],
          },
        ],
      },
      {
        type: 1,
        name: "remove",
        description: "Delete an item (officers only)",
        options: [
          { type: 3, name: "item", description: "Pick an item", required: true, autocomplete: true },
        ],
      },
    ],
  },
  {
    name: "rank",
    description: "View or edit the role → level map",
    type: 1,
    options: [
      { type: 1, name: "list", description: "Show the role → level map" },
      {
        type: 1,
        name: "map",
        description: "Map a role to a level (officers only)",
        options: [
          { type: 8, name: "role", description: "Role", required: true },
          {
            type: 4,
            name: "level",
            description: "Rank level (I = top)",
            required: true,
            choices: [
              { name: "I — Leadership", value: 1 },
              { name: "II — Consigliere", value: 2 },
              { name: "III — Capos", value: 3 },
              { name: "IV — Enforcers", value: 4 },
              { name: "V — Associates", value: 5 },
            ],
          },
        ],
      },
      {
        type: 1,
        name: "unmap",
        description: "Remove a role mapping (officers only)",
        options: [{ type: 8, name: "role", description: "Role", required: true }],
      },
      {
        type: 1,
        name: "weights",
        description: "Set a level's multiplier / weight (officers only)",
        options: [
          {
            type: 4,
            name: "level",
            description: "Rank level (I = top)",
            required: true,
            choices: [
              { name: "I — Leadership", value: 1 },
              { name: "II — Consigliere", value: 2 },
              { name: "III — Capos", value: 3 },
              { name: "IV — Enforcers", value: 4 },
              { name: "V — Associates", value: 5 },
            ],
          },
          { type: 10, name: "weight", description: "Multiplier, e.g. 5", required: true },
        ],
      },
    ],
  },
  {
    name: "job",
    description: "Open / list / close operations",
    type: 1,
    options: [
      {
        type: 1,
        name: "open",
        description: "Open a new job in this channel",
        options: [
          { type: 3, name: "name", description: "Job name", required: true },
          { type: 3, name: "product", description: "Product line", required: true, autocomplete: true },
        ],
      },
      { type: 1, name: "list", description: "List open jobs" },
      {
        type: 1,
        name: "close",
        description: "Close this channel's job without settling (opener or officer)",
      },
      {
        type: 1,
        name: "reopen",
        description: "Reopen this channel's settled job for corrections (officers only)",
      },
    ],
  },
  {
    name: "deposit",
    description: "Add materials or cash to a job",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item", required: false, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity (with item)", required: false },
      { type: 10, name: "cash", description: "Cash amount", required: false },    ],
  },
  {
    name: "process",
    description: "Log a craft step — report what you made",
    type: 1,
    options: [
      { type: 3, name: "step", description: "Recipe step", required: true, autocomplete: true },
      { type: 10, name: "made", description: "Units produced", required: true },    ],
  },
  {
    name: "withdraw",
    description: "Take materials or cash from a job",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item", required: false, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity (with item)", required: false },
      { type: 10, name: "cash", description: "Cash amount", required: false },    ],
  },
  {
    name: "sale",
    description: "Log a real-cash sale of the job's product",
    type: 1,
    options: [
      { type: 10, name: "qty", description: "Units sold", required: true },
      { type: 10, name: "cash", description: "Cash received", required: true },
      { type: 6, name: "by", description: "Seller (default: you)", required: false },    ],
  },
  {
    name: "ledger",
    description: "Show this channel's job history",
    type: 1,
  },
  {
    name: "status",
    description: "Show this channel's job status & reconciliation",
    type: 1,
  },
  {
    name: "settle",
    description: "Settle this channel's job and post the payout (opener or officer)",
    type: 1,
  },
  {
    name: "me",
    description: "Your standing in this channel's job",
    type: 1,
  },
  {
    name: "void",
    description: "Reverse a mistaken entry (officers only)",
    type: 1,
    options: [
      { type: 3, name: "entry", description: "Pick the entry to void", required: true, autocomplete: true },
    ],
  },
  {
    name: "recipe",
    description: "Define product lines & their chains (officers only)",
    type: 1,
    options: [
      {
        type: 1,
        name: "line",
        description: "Add a new product line",
        options: [
          { type: 3, name: "name", description: "Line name (e.g. Cocaine)", required: true },
          { type: 3, name: "final", description: "Final product name (e.g. Brick)", required: true },
          { type: 10, name: "price", description: "Reference sell price ($)", required: true },
        ],
      },
      {
        type: 1,
        name: "build",
        description: "Define a line's steps (opens a form)",
        options: [{ type: 3, name: "line", description: "Product line", required: true, autocomplete: true }],
      },
      { type: 1, name: "list", description: "List product lines & their steps" },
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
