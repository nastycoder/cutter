// Thin Discord REST client (bot-token authed) for managing channels/categories.
import { getSecret } from "./secret";

const API = "https://discord.com/api/v10";

async function dapi(path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const { botToken } = await getSecret();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${botToken}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 429 && attempt < 5) {
    const body: any = await res.clone().json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, (body.retry_after ?? 1) * 1000 + 250));
    return dapi(path, init, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Discord ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? undefined : res.json();
}

// type: 0 = text channel, 4 = category
export function createChannel(
  guildId: string,
  opts: { name: string; type: number; parent_id?: string; topic?: string }
): Promise<{ id: string }> {
  return dapi(`/guilds/${guildId}/channels`, { method: "POST", body: JSON.stringify(opts) });
}

export function modifyChannel(channelId: string, opts: Record<string, unknown>): Promise<any> {
  return dapi(`/channels/${channelId}`, { method: "PATCH", body: JSON.stringify(opts) });
}

type MsgBody = string | { content?: string; embeds?: any[]; components?: any[] };
const toBody = (m: MsgBody) => (typeof m === "string" ? { content: m } : m);

export function postMessage(channelId: string, message: MsgBody): Promise<any> {
  return dapi(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(toBody(message)),
  });
}

/** Upload files (multipart) to a channel — e.g. the tutorial deck. */
export async function postFiles(
  channelId: string,
  files: { name: string; data: Uint8Array; contentType: string }[],
  content?: string
): Promise<any> {
  const { botToken } = await getSecret();
  const form = new FormData();
  if (content) form.append("payload_json", JSON.stringify({ content }));
  files.forEach((f, idx) => {
    form.append(`files[${idx}]`, new Blob([f.data], { type: f.contentType }), f.name);
  });
  // Don't set content-type: fetch derives the multipart boundary from the FormData.
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Discord upload ${channelId}: ${res.status} ${await res.text()}`);
  return res.json();
}

export function getMember(guildId: string, userId: string): Promise<{ roles: string[] }> {
  return dapi(`/guilds/${guildId}/members/${userId}`);
}

/** Edit the original (deferred) interaction reply via the interaction-token webhook. */
export async function editOriginal(appId: string, token: string, message: MsgBody): Promise<void> {
  const res = await fetch(`${API}/webhooks/${appId}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toBody(message)),
  });
  if (!res.ok) console.error("editOriginal failed", res.status, await res.text());
}
