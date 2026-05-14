# Even-ELO

EHRC Surgical Governance Committee — Visiting Consultant scoring tool. Tracks
Caseload / Outcomes / Adherence per VC and recomputes the **ELO score** on every
observation write.

## Status: v1 SHIPPED 🎉

- **Live:** <https://even-elo.vercel.app/>
- **Ship tag:** `v1-shipped` on origin (head `92cc27a`)
- **Tests:** 70/70 unit · 51/51 smoke endpoints
- **Stakeholder:** EHRC Surgical Governance Committee (peer-led, 5 seats)
- **Confidentiality:** committee use only — URL is the gate (no auth in v1)

## Documentation (in the workspace folder)

- **PRD (locked v1.1):** `EVEN-EPI-PRD.md` — full data model, stream catalogue, scoring engine
- **Visual spec (BINDING):** `EVEN-ELO-MOCKUPS.html` — 6 mockup screens; no UI improvisation allowed during build
- **Build journal:** `EVEN-ELO-BUILD-JOURNAL.md` — per-sprint scope + close for ELO.0 → ELO.7
- **UAT checklist:** `EVEN-ELO-UAT-CHECKLIST.md` — Chrome MCP UAT script with sign-off
- **Carryover prompt:** `EVEN-ELO-CARRYOVER-2026-04-30.md` — paste this to spin up new threads

## Tech

- Next.js 14.2.0 App Router · TypeScript 5 · Tailwind · vitest
- `@neondatabase/serverless` HTTP driver (NOT a pool — `neon()` lazy via Proxy)
- Vercel Pro (Hospital Product team, auto-deploy on push to `main`)
- Neon Postgres project `even-elo` (Singapore sin1)
- No auth — URL is the gate. Every form stamps the entrant's **position** (e.g. "Customer Care Lead") from localStorage for audit defensibility

## Local development

```bash
npm install
cp .env.local.example .env.local
# Fill in DATABASE_URL from your Neon project
npm run dev
```

Open <http://localhost:3000>.

## Database migrations

```bash
# After deploying with a configured DATABASE_URL:
curl -X POST https://even-elo.vercel.app/api/admin/migrate
```

Idempotent — uses a `_migrations` marker table. 6 migrations applied at v1.

## Tests

```bash
npm test            # vitest, 70 unit tests on src/lib/scoring/
npm run test:watch
```

All tests are on the pure-functional scoring engine — no DB dependency, no flake risk.

## Sprint status

`EVEN-ELO-BUILD-JOURNAL.md` §3 has the full close history.

- ELO.0 → ELO.7 all shipped 2026-04-30 in a single session
- 12 sub-sprints, 14 commits, 0 deploy regressions
- All sprint rollback anchor tags (`pre-elo-*`) on origin
- `v1-shipped` is the launch tag

## Deploy

Auto-deploy on push to `main` via Vercel. Always poll `list_deployments` until `state === "READY"` before declaring a sprint shipped — webhook job ID is not a deploy success.

## Smoke matrix

```bash
bash scripts/elo-smoke.sh
```

Exercises 51 endpoints. Re-run on every push.

## Rollback playbook

1. `git revert <bad-commit>..HEAD && git push --force-with-lease origin main`
2. If a schema migration is involved: restore the Neon `pre-elo-schema-snapshot` branch
3. Vercel auto-redeploys the revert

## v1.1 backlog (parked)

Per PRD §14: VC self-service dashboards, statistical CIs, per-stream weighting, OPD→IPD conversion, multi-surgeon attribution, mobile responsive, SSO with Even OS, email/SMS digests, anomaly detection, hand hygiene unit dashboard.
