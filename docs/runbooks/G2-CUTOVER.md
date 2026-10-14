# G2 cutover runbook: staff / portal JWT audience split

Cutover window: Thu 15 Oct 2026, 21:30 IST. Legacy window closes 22:30 IST.
Everyone (staff and doctors) logs in once. The governance MCP connector re-authorizes.
Names of env vars only in logs, LOG.md, ubus, reports. Never values.

## Preconditions
- C1: Studio (`gov/m0s-studio`) reads `STAFF_JWT_SECRET`, verifies audience `staff`, honours the same legacy window. Deployed with `STAFF_JWT_SECRET` set on the studio Vercel project. If not deployed by 21:00 IST, the cutover slips. Do not cut over with Studio on `JWT_SECRET`.
- C4: the 18:00 notice tells the MCP client operator to re-authorize after cutover.

## Secrets (stdin only)
Two distinct values. Each is piped straight into Vercel; never on argv, never echoed.

    openssl rand -base64 48 | vercel env add STAFF_JWT_SECRET production
    openssl rand -base64 48 | vercel env add STAFF_JWT_SECRET preview
    openssl rand -base64 48 | vercel env add PORTAL_JWT_SECRET production
    openssl rand -base64 48 | vercel env add PORTAL_JWT_SECRET preview

Preview and production may differ from each other, but STAFF must differ from PORTAL in every environment.
Distinctness: compare local sha256 of the two generated values, then discard them. Do not store or print the values.
The app also refuses to sign (non-secret error naming the variable) if a secret is under 32 bytes or STAFF equals PORTAL.
`JWT_SECRET` stays set permanently until `CAPTURE_IP_HASH_SALT` is set (it salts the capture IP hash; the fallback is a public constant).

## Checks
- K0 (21:00): R13 deployed on Studio. `vercel env ls` on even-elo shows `STAFF_JWT_SECRET`, `PORTAL_JWT_SECRET`, `JWT_SECRET`, `JWT_LEGACY_ACCEPT_UNTIL` (names only) on Production and Preview. Abort if any is missing.
- K1 (21:30): set `JWT_LEGACY_ACCEPT_UNTIL=2026-10-15T17:00:00Z` (22:30 IST). Merge, deploy, note the deploy id.
- K2: staff login on the staff host succeeds; the `epi_session` cookie decodes (payload only, no secret) with aud `staff`.
- K3: doctor PIN login on doctors.evenos.app succeeds; `epi_physician_session` has aud `portal`; a doctor with `portal_must_change_pin` is still forced to /portal/set-pin.
- K4: cross-surface: staff cookie on a portal API gives 401; portal cookie on a staff API gives the no-cookie response; any staff route on the doctors host gives 404.
- K5: Studio page loads with the new staff session; MCP connector re-auth completes and one read tool call succeeds.
- K6: an old pre-cutover session (saved cookie) still works on its own surface until 22:30 and is rejected after. Confirm at 22:35 and log.
- K7: if K2 or K3 fails, rollback (below) and page gov-orch.

## Rollback
Keep this build. Do NOT redeploy the previous build: it knows only `JWT_SECRET` and would reject every post-cutover session, a second forced logout.
1. Extend `JWT_LEGACY_ACCEPT_UNTIL` (e.g. now + 24 h, ISO time). It is read per request.
2. Env-only redeploy so the change is live. No code rollback.
3. Page gov-orch. Old sessions work on their own surface until the new deadline.

## Cutover log (C5, in gov-orch LOG)
Env names set (not values), window ISO time, deploy id, K1-K6 results, and the 22:30 "window closed, legacy rejected" confirmation.
