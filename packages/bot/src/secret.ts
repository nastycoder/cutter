import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export interface DiscordSecret {
  publicKey: string;
  appId: string;
  botToken: string;
}

const sm = new SecretsManagerClient({});
let cached: DiscordSecret | undefined;

export async function getSecret(): Promise<DiscordSecret> {
  if (cached) return cached;
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.DISCORD_SECRET_ARN! })
  );
  cached = JSON.parse(res.SecretString!) as DiscordSecret;
  return cached;
}
