import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Set GUILD_ID for instant guild-scoped registration during dev;
// leave unset for global registration (can take up to ~1h to propagate).
const GUILD_ID = process.env.GUILD_ID;

// Discord ApplicationCommandOptionType:
// 1=Subcommand 3=String 4=Integer 6=User 7=Channel 8=Role 10=Number
const LOSS_CAUSES = [
  { name: "busted", value: "busted" },
  { name: "robbed", value: "robbed" },
  { name: "spoiled", value: "spoiled" },
  { name: "other", value: "other" },
];

const commands = [
  { name: "ping", description: "Check that Cutter is alive", type: 1 },
  {
    name: "setup",
    description: "Build the stash houses, seed defaults, set the officer role (Manage Server)",
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

  // ---- logging work ----
  {
    name: "deposit",
    description: "Bank farmed/owned materials — farm pay to whoever did the work",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item", required: true, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity", required: true },
      { type: 6, name: "credit", description: "Who farmed it (default: you) — credit follows the doer", required: false },
    ],
  },
  {
    name: "buy",
    description: "Buy supplies or product with your own cash — capital at catalog value, owed back",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item", required: true, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity", required: true },
    ],
  },
  {
    name: "fund-cash",
    description: "Front the treasury cash — capital, owed back at payout",
    type: 1,
    options: [{ type: 10, name: "amount", description: "Cash amount ($)", required: true }],
  },
  {
    name: "process",
    description: "Log a craft step — report what you made; labor pay to the cook",
    type: 1,
    options: [
      { type: 3, name: "line", description: "Product line", required: true, autocomplete: true },
      { type: 3, name: "step", description: "Recipe step", required: true, autocomplete: true },
      { type: 10, name: "made", description: "Units produced", required: true },
      { type: 6, name: "credit", description: "Who cooked (default: you)", required: false },
    ],
  },
  {
    name: "transfer",
    description: "Move stock between houses — logistics only, no pay effect",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item", required: true, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity", required: true },
      { type: 7, name: "to", description: "Destination house channel", required: true, channel_types: [0] },
    ],
  },
  {
    name: "checkout",
    description: "Take product out to sell — crew product in your holding, not a withdrawal",
    type: 1,
    options: [
      { type: 3, name: "product", description: "Product", required: true, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity", required: true },
    ],
  },
  {
    name: "sale",
    description: "Log a real-cash sale — draws your holding first; commission to the seller",
    type: 1,
    options: [
      { type: 3, name: "product", description: "Product sold", required: true, autocomplete: true },
      { type: 10, name: "qty", description: "Units sold", required: true },
      { type: 10, name: "cash", description: "Cash received", required: true },
      { type: 6, name: "by", description: "Seller (default: you)", required: false },
    ],
  },
  {
    name: "return",
    description: "Put unsold product back on the shelf from your holding",
    type: 1,
    options: [
      { type: 3, name: "product", description: "Product", required: true, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity", required: true },
    ],
  },
  {
    name: "withdraw",
    description: "Take materials or cash for personal use — valued, off your tab at payout",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item", required: false, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity (with item)", required: false },
      { type: 10, name: "cash", description: "Cash amount", required: false },
    ],
  },
  {
    name: "loss",
    description: "Record busted/robbed/spoiled goods or cash — crew-shared unless charged",
    type: 1,
    options: [
      { type: 3, name: "cause", description: "What happened", required: true, choices: LOSS_CAUSES },
      { type: 3, name: "item", description: "Item lost", required: false, autocomplete: true },
      { type: 10, name: "qty", description: "Quantity lost (with item)", required: false },
      { type: 10, name: "cash", description: "Cash lost", required: false },
      { type: 6, name: "holder", description: "Lost from this member's holding (checked-out product)", required: false },
      { type: 6, name: "charge", description: "Officer: charge the loss to this member's tab", required: false },
      { type: 3, name: "note", description: "What happened, in a line", required: false },
    ],
  },

  // ---- treasury ----
  {
    name: "owed",
    description: "A member's live tab this cycle — earned, advanced, advanceable",
    type: 1,
    options: [{ type: 6, name: "member", description: "Member (default: you)", required: false }],
  },
  {
    name: "advance",
    description: "Officer: hand a member cash now against what they've earned this cycle",
    type: 1,
    options: [
      { type: 6, name: "member", description: "Who gets the advance", required: true },
      { type: 10, name: "amount", description: "Cash amount ($)", required: true },
    ],
  },
  {
    name: "payout",
    description: "Officer: settle the cycle — pay every tab + split the fund by rank, then reset",
    type: 1,
  },
  {
    name: "fund",
    description: "The fund right now — cash, what's owed for work, the profit on top",
    type: 1,
  },
  {
    name: "spend",
    description: "Officer: spend crew cash on operations (logged; comes out of the fund)",
    type: 1,
    options: [
      { type: 10, name: "amount", description: "Cash amount ($)", required: true },
      { type: 3, name: "reason", description: "What it was for", required: true },
    ],
  },
  {
    name: "holding",
    description: "Product members have checked out right now",
    type: 1,
    options: [{ type: 6, name: "member", description: "Member (default: everyone)", required: false }],
  },
  {
    name: "stash",
    description: "What the books say is in a house",
    type: 1,
    options: [
      {
        type: 3,
        name: "house",
        description: "Which house (default: this channel's, or all)",
        required: false,
        choices: [
          { name: "🌿 raw house", value: "raw" },
          { name: "🧪 product house", value: "product" },
          { name: "💰 money house", value: "money" },
        ],
      },
    ],
  },
  {
    name: "reconcile",
    description: "Officer: log a real in-game count — records shrinkage vs the books",
    type: 1,
    options: [
      { type: 3, name: "item", description: "Item counted", required: true, autocomplete: true },
      { type: 10, name: "count", description: "Actual count on the shelf", required: true },
    ],
  },
  {
    name: "me",
    description: "Your standing this cycle — tab, rank, holding",
    type: 1,
  },
  {
    name: "ledger",
    description: "This cycle's blow-by-blow history",
    type: 1,
  },
  {
    name: "status",
    description: "The whole treasury — houses, cash, fund, contributors",
    type: 1,
  },
  {
    name: "void",
    description: "Officer: reverse a mistaken entry (also how a recovered loss comes back)",
    type: 1,
    options: [
      { type: 3, name: "entry", description: "Pick the entry to void", required: true, autocomplete: true },
    ],
  },

  // ---- configuration ----
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
              { name: "Sell commission (%)", value: "commission" },
              { name: "Farm margin (%)", value: "farm-margin" },
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
      {
        type: 1,
        name: "remove",
        description: "Delete a product line and its steps (officers only)",
        options: [{ type: 3, name: "line", description: "Product line", required: true, autocomplete: true }],
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
