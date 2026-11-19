# Private co-op signaling

The Vercel game opens an invitation through a Cloudflare Worker. A Durable Object owns the room code, pilot count, host name and short-lived negotiation grants. Its WebSocket goes idle once the pilots exchange WebRTC session descriptions. Flight, cargo, mining, saves and reconnect credentials belong to the host game. A TURN relay carries encrypted WebRTC traffic when a direct path is unavailable.

## Local development

Run these commands from the repository root in separate terminals. The local Worker needs Wrangler 4 and a Node version supported by that CLI.

```sh
pnpm dlx wrangler@4 dev --local --config services/coop-signal/wrangler.jsonc --port 8791
NEXT_PUBLIC_COOP_SIGNAL_URL=http://127.0.0.1:8791 pnpm start --port 3001
```

Open the game at `http://127.0.0.1:3001`. The checked-in Worker accepts that origin and `http://localhost:3001`. With both TURN bindings absent, the Worker supplies STUN for direct connections. Local TURN secrets can go in an ignored `services/coop-signal/.dev.vars`. The two-browser driver can also supply an existing test relay. [Browser checks](../../docs/AUTOMATED_TESTING.md#two-browsers-co-op)

## Vercel preview and Cloudflare staging

1. Run `pnpm dlx wrangler@4 whoami` to check the active Cloudflare account. If the login expired, run `pnpm dlx wrangler@4 login` in an interactive terminal. Choose a stable HTTPS Vercel preview origin for both players. Use a staging Worker name and set `GAME_ORIGINS` in its Wrangler configuration to that exact preview origin. Separate additional origins with commas. Each origin includes its scheme and any nondefault port, with no trailing slash.
2. Deploy the Worker using that configuration. The first deployment creates the room namespace and returns a `workers.dev` URL. The game domain can keep its existing DNS records.
3. Create a Cloudflare Realtime TURN key. Store its key ID as `TURN_KEY_ID` and its associated API token as `TURN_API_TOKEN` using `wrangler secret put` on the **same Worker**. Wrangler prompts for each value. Only the Worker uses these bindings. A guest receives temporary ICE credentials after the host offers it a connection. [Cloudflare TURN setup](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
4. Set `NEXT_PUBLIC_COOP_SIGNAL_URL` to the HTTPS Worker origin in the Vercel project's **Preview** environment and redeploy the preview. Next.js includes the value in the client bundle at build time. Both players must be able to open the preview and run the same game version.
5. On desktop Wi-Fi, open a world and choose **Settings → friends → open to friends**. Open the invite on a phone using cellular data. Check the connection type in the guest's Friends settings. Mine a shared rock, disconnect the guest and rejoin the same pilot. Repeat with `&coopRelay=1` appended to the guest's invite URL and confirm **Relay connection**. This uses the Worker's issued TURN credentials.
6. Sleep and wake the host, then reopen the same world after a host restart. Check that the guest sees the wait, can resume and retains its cargo. Stop hosting with the guest connected and verify the guest sees the closure. Check the expired invite from the title screen. Record the routes, devices and outcomes in the M4 plan before enabling production.

Example commands after configuring the staging Worker name and preview origin, from its configuration directory:

```sh
pnpm dlx wrangler@4 deploy
pnpm dlx wrangler@4 secret put TURN_KEY_ID
pnpm dlx wrangler@4 secret put TURN_API_TOKEN
```
