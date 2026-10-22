---
name: Uptime endpoint security
description: Security boundary for exposing the Minecraft bot's keep-alive endpoint publicly.
---

The public keep-alive route should return only a minimal health response. Status and bot-control routes must remain token-protected when the service binds beyond loopback; without a token, those routes should deny access rather than expose state or fail the server startup.

**Why:** Uptime monitoring needs an externally reachable endpoint, but public access must not reveal account details or allow control of the Minecraft bot.

**How to apply:** When exposing this service, keep `/` and `/health` minimal and require `CONTROL_TOKEN` for any public status or bot-control endpoint.
