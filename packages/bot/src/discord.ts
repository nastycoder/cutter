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

export function reply(content: string, ephemeral = true) {
  return json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, ...(ephemeral ? { flags: 64 } : {}) },
  });
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
