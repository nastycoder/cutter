# Cutter

Discord bot that tracks contributions to Midnight Mafia operations and settles each haul fairly.
Serverless on AWS (API Gateway → Lambda → DynamoDB), TypeScript end to end. See `DESIGN.md` for the full spec.

## Layout

```
packages/shared   # domain types (engine ↔ bot contract)
packages/engine   # pure settlement math (golden-tested) — Phase 3
packages/bot      # interactions Lambda (verify, route, command impls)
packages/infra    # CDK app + CutterStack
scripts/          # register-commands.ts
```

## Build & deploy

```bash
npm install
npm run build      # type-check shared + engine + bot
npm run synth      # cdk synth (no deploy)
npm run deploy     # cdk deploy
```

Set `AWS_PROFILE` (or pass `--profile <name>`) to target your own AWS account/region;
run `aws sso login --profile <name>` first if your SSO session has expired.

## One-time Discord setup

1. Create an application at <https://discord.com/developers/applications>.
2. From **General Information** copy the **Application ID** and **Public Key**.
3. Under **Bot**, create a bot and copy its **Token**.
4. After the first `npm run deploy`, put all three into the `cutter/discord` secret:
   ```bash
   aws secretsmanager put-secret-value --secret-id cutter/discord \
     --secret-string '{"publicKey":"...","appId":"...","botToken":"..."}'
   ```
5. Copy the stack's `InteractionsUrl` output into the app's
   **Interactions Endpoint URL** (General Information). Discord sends a PING — it must verify.
6. Register commands, then `/ping` in your server:
   ```bash
   GUILD_ID=<your server id> npm run register
   ```

## Phases

0. **Skeleton** — stack + signature verify + `/ping`→pong  ← *current*
1. Config — `/setup`, `/catalog`, `/config set`, `/rank`
2. Ledger — `/job` `/deposit` `/process` `/withdraw` `/sale` `/status` `/ledger`
3. Settle — engine + golden test + `/settle`
4. Polish — autocomplete, `/config` panel, `/me`, edge cases
5. Harden — tests, observability, runbook
