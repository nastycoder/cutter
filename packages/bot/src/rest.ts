// Thin Discord REST client (bot-token authed) for managing channels/categories.
import { getSecret } from "./secret";

const API = "https://discord.com/api/v10";

async function dapi(path: string, init: RequestInit = {}): Promise<any> {
  const { botToken } = await getSecret();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${botToken}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
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

export function postMessage(channelId: string, content: string): Promise<any> {
  return dapi(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export function getMember(guildId: string, userId: string): Promise<{ roles: string[] }> {
  return dapi(`/guilds/${guildId}/members/${userId}`);
}
