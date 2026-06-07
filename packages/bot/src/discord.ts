import { InteractionResponseType } from "discord-api-types/v10";
import type { Config } from "@cutter/shared";

const MANAGE_GUILD = 1n << 5n; // Discord "Manage Server" permission bit

export function json(payload: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export interface MsgData {
  content?: string;
  embeds?: any[];
  components?: any[];
  flags?: number;
}

export const COLORS = {
  gold: 0xe8b84b,
  green: 0x5fcf82,
  red: 0xd6452f,
  blue: 0x5865f2,
  gray: 0x8c8576,
};

/** Build an embed message body. */
export function embed(opts: {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
}): MsgData {
  return {
    embeds: [
      {
        title: opts.title,
        description: opts.description,
        color: opts.color ?? COLORS.gold,
        fields: opts.fields,
        footer: opts.footer ? { text: opts.footer } : undefined,
      },
    ],
  };
}

export function reply(data: string | MsgData, ephemeral = true) {
  const d: MsgData = typeof data === "string" ? { content: data } : { ...data };
  if (ephemeral) d.flags = (d.flags ?? 0) | 64;
  return json({ type: InteractionResponseType.ChannelMessageWithSource, data: d });
}

/** Top-level command name. */
export function commandName(i: any): string {
  return i.data?.name;
}

/** Subcommand name, if the command uses subcommands. */
export function subcommand(i: any): string | undefined {
  const first = i.data?.options?.[0];
  return first && first.type === 1 ? first.name : undefined;
}

/** Read an option by name from the command (or its active subcommand). */
export function option<T = any>(i: any, name: string): T | undefined {
  const sub = i.data?.options?.[0];
  const opts =
    sub && sub.type === 1 ? sub.options ?? [] : i.data?.options ?? [];
  return opts.find((o: any) => o.name === name)?.value as T | undefined;
}

export function guildId(i: any): string {
  return i.guild_id;
}
export const actorId = (i: any): string => i.member?.user?.id ?? i.user?.id;
export const channelId = (i: any): string => i.channel_id ?? i.channel?.id;
/** Discord snowflake → unix-ms timestamp (entry ids double as ordered keys). */
export const snowflakeTs = (id: string): number =>
  Number((BigInt(id) >> 22n) + 1420070400000n);

/** The option the user is currently typing in an autocomplete interaction. */
export function focusedOption(i: any): { name: string; value: string } | undefined {
  const walk = (opts: any[] | undefined): any => {
    for (const o of opts ?? []) {
      if (o.focused) return o;
      const nested = walk(o.options);
      if (nested) return nested;
    }
    return undefined;
  };
  const f = walk(i.data?.options);
  return f ? { name: f.name, value: String(f.value ?? "") } : undefined;
}

export function autocompleteResult(choices: { name: string; value: string }[]) {
  return json({
    type: InteractionResponseType.ApplicationCommandAutocompleteResult,
    data: { choices: choices.slice(0, 25) },
  });
}

/** name -> slug id, e.g. "Cleaning Kit" -> "cleaning_kit" */
export const slug = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Officer = holds the configured officer role, or (fallback) Manage Server. */
export function isOfficer(i: any, config: Config): boolean {
  const member = i.member;
  if (!member) return false;
  if (config.officerRoleId && member.roles?.includes(config.officerRoleId)) {
    return true;
  }
  try {
    return (BigInt(member.permissions ?? "0") & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}
