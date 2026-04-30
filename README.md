# Even-ELO

EHRC Surgical Governance Committee — Visiting Consultant scoring tool. Tracks
Caseload / Outcomes / Adherence per VC and recomputes the **ELO score** on every
input write.

- **PRD (locked):** `EVEN-EPI-PRD.md` v1.1 in the Daily Dash EHRC workspace folder
- **Visual spec (binding):** `EVEN-ELO-MOCKUPS.html` in the same folder
- **Build journal:** `EVEN-ELO-BUILD-JOURNAL.md`
- **Stakeholder:** EHRC Surgical Governance Committee (peer-led, 5 seats)
- **Confidentiality:** committee use only — URL is the gate (no auth in v1)

## Tech

- Next.js 14 App Router · TypeScript · Tailwind · shadcn/ui
- Neon Postgres (HTTP driver) · Vercel Pro
- No auth in v1 — every form stamps the entrant's **position**
  (e.g. "Customer Care Lead") for audit defensibility

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

Idempotent — uses a `_migrations` marker table.

## Sprint status

See `EVEN-ELO-BUILD-JOURNAL.md` §3 for sprint close history.

Currently: **ELO.0 (scaffold) shipped** — see §3.1 in the build journal.

## Deploy

Auto-deploy on push to `main` via Vercel.

## Smoke matrix

```bash
bash scripts/elo-smoke.sh
```
