# CDMSS Phase 1 — agent ↔ app CONTRACT (builder A, claude-sonnet-5-5)

Authoritative for builder B. A codes `studio/apps/agent/src/studio_cdmss_tools.py`; B codes against the shapes below. Anything marked **UNVERIFIED** was not checked against a live database. Changes to this file after the first commit are announced in `.bc/CONTRACT-CHANGES.md` (A appends, B reads).

## 0. Transport

Every view and every tool is one agent tool, reached exactly as existing screens reach theirs: app `POST /api/screen/<tool>` → agent `POST /agent/tools/<tool>` (JSON params in, JSON out). Chat uses the same tools. Staff id from the actor JWT. One `studio_audit` row per CDMSS query (tool, params_hash that includes the SQL hash).

| Tool name | Purpose | Screen gate |
|---|---|---|
| `cdmss_v1_this_week` | V1 module home | `cdmss` |
| `cdmss_v2_scorecard` | V2 family scorecard (site matrix + weekly trend) | `cdmss` |
| `cdmss_v3_doctor_variation` | V3 funnel + ranked dot-and-whisker | `cdmss` |
| `cdmss_v4_contributors` | V4 contributor table | `cdmss` |
| `cdmss_v5_redflags` | V5 red-flag dossiers | `cdmss` |
| `cdmss_v8_worklists` | V8 worklists (rows, B exports CSV) | `cdmss` |
| `cdmss_metric_catalogue` | T1 list of metric ids, status, definition | `cdmss` |
| `cdmss_metric` | T1 one catalogue metric (optionally by site/doctor) | `cdmss` |
| `cdmss_drilldown` | T2 worklist rows behind a metric/site/doctor | `cdmss` |
| `cdmss_finding_detail` | T2 one finding: quote, rationale, case link | `cdmss` |

**Access (`cdmss` screen, mirrored in `studio_access.py` and `tests/access_matrix.json`):** `super_admin`, `sgc_member` (SGO/SGC), `site_medical_head` (SMH). Everyone else 403, doctors never. **B must add the same `cdmss` screen to `apps/app/src/lib/zone/access.ts`.** (A2 ruling: transport is B's dedicated app route `/api/cdmss/[view]`; the shared `/api/screen` route and `tool-schema.ts` stay untouched.) Phase 1 access is exactly these three roles; "named clinical reviewers" are deferred until V names them. `tests/access_matrix.json` (pinned by `role-matrix.test.ts` against `access.ts`) is deliberately NOT changed on the agent branch, because that would turn the app's test red until B lands. The finished matrix is `.bc/access_matrix.cdmss.json`: the merger copies it over `studio/apps/agent/tests/access_matrix.json` in the same merge as B's `access.ts` (allowed personas for `cdmss` and all ten tools: super_admin, sgc_member, site_medical_head, sgo_and_hr). "Named clinical reviewers": deferred (A2 ruling); no role flag exists for them in `ops/neon/0011`.

### 0.1 Response wrapper (compatible with `SourceTablePayload`)
```jsonc
{
  "source": { "tool": "cdmss_v2_scorecard", "query_hash": "<12 hex of the SHA-256 of the concatenated SQL>" },
  "mode": "live",                // "live" only. STUDIO_LIVE_READS off => 502 tool_failed (no fixtures exist for CDMSS)
  "synthetic": false,
  "columns": ["..."],            // flat primary table of the view (see per view); every cell string|number|boolean|null
  "rows": [ { } ],
  "row_count": 12,
  "total": 12,                   // only for paged lists (V5 and V8 and the drilldown)
  "incomplete": "string<=300",   // present when a cap truncated the read (see 0.6)
  "view": { }                    // EVERYTHING ELSE: the envelope + view-specific blocks (sections 2-3)
}
```
**B action:** the dedicated `/api/cdmss/[view]` route must pass `view` through unchanged (a zod `z.object` strips unknown keys) and may use a looser `Cell` for `rows`. Errors: `{ok:false,error:"forbidden"|"bad_params"|"tool_failed"|...}` as today; tool_failed `message` is a fixed string.

### 0.2 Common param names
`window_days` (int 7–182, default per view), `site` (string site code, e.g. `EHRC`), `doctor_uid` (string), `family` (`opd`|`ams`), `limit` (1–500), `offset`. Unknown keys → 422 `bad_params`.

### 0.3 The envelope (`view.envelope`) — present on EVERY view and EVERY T1/T2 result
```jsonc
"envelope": {
  "provenance": {
    "window":        { "from": "2026-10-17", "to": "2026-10-23", "days": 7, "tz": "Asia/Kolkata", "anchor": "today (IST calendar days, inclusive)" },
    "data_cutoff":   "2026-10-23T02:41:07+00:00",   // max(audited_at) over the rows read; null if none
    "sources":       ["cdmss_ro.opd_note_audit", "cdmss_ro.opd_finding", "studio_ro.dw_individuals_prescriptions"],
    "engine_family": "opd-note-audit/0.81.3+ (derived by shape; versions seen: 0.81.20, 0.81.21)",
    "db13_as_of":    "2026-10-22T17:00:00+00:00" | null,   // dw_extract_status; null when no DB13 data was used
    "generated_at":  "ISO", "query_hashes": ["12hex", "..."]
  },
  "headline": { "sentence": "Mean OPD NQI is 78 over 62% of notes ...", "plain": "about 3 in 10 notes ..." },
  "stats":   [ Stat ],          // the numbers behind the headline (section 1)
  "caveats": [ "string" ],      // C-7 standing caveats + family precision line + metric-specific ones, deduped
  "precision_line": "About 1 in 5 findings are wrong or contested (engine precision; no family-specific figure in the catalogue).",
  "action_line": "Site medical heads: start with the three doctors above the 99.8% limit ..."
}
```
`caveats` always includes the C-7 lines (score is an encounter proxy, "not a clinician scorecard"; unscored PDQI-9 raises the index; underuse findings carry zero penalty) when an NQI figure is shown.

## 1. `Stat` — every number, anywhere
```jsonc
{
  "metric_id": "M-OPD-01",            // catalogue id (+ ruling suffix where needed, e.g. "M-OPD-03")
  "label": "Mean OPD NQI (stored index, PDQI-assessed notes only)",
  "value": 78.4 | null,               // null when status is count_only or unavailable
  "unit": "score" | "percent" | "per_100" | "per_1000" | "ratio" | "count",
  "numerator": 4210.0 | null, "denominator": 54 | null, "n": 54,   // n = notes (or Rx/consults) behind the figure; for NQI, n = PDQI-assessed notes
  "ci95": [74.1, 82.7] | null, "ci_method": "wilson" | "mean_normal" | "none",
  "window": { "from": "...", "to": "...", "days": 7 },
  "coverage": { "assessed": 54, "total": 87, "pct": 62.1 } | null,   // NQI family only
  "status": "ok" | "greyed" | "count_only" | "unavailable",
  "grey_reason": null | "min_n" | "coverage_lt_50" | "no_denominator" | "not_available",
  "change": Change | null,
  "plain": "about 3 in 10" | null,
  "note": "string" | null,            // e.g. UNAVAILABLE reason, "lower bound" qualifier
  "band": "A".."E" | null,            // raw band of the value, NQI family only
  "extra": { }                        // optional, metric-specific: M-OPD-02 {counts:{A..E}, pct_a, pct_ab, pct_ce, basis, band_stats:{A..E: Stat}}; M-OPD-05 {pct_notes_with_one_or_more, notes_with_one_or_more, pct_ci95, ci_method}; M-OPD-06 {banded_coverage, expected_rate, raw_rate}
}
```
Rules the agent enforces (B only renders): doctor rows `n >= 10`, site/specialty groups `n >= 15`, funnel inclusion `>= 50` audited notes — below that `status:"count_only"` (value null, n kept, no rank, no ci). `coverage.pct < 50` ⇒ `status:"greyed"`, `grey_reason:"coverage_lt_50"` (value kept so the UI may show it greyed). `unavailable` ⇒ value null, `note` = the reason, `grey_reason:"not_available"`.
`Change` = `{ "direction": "rising"|"falling"|"no clear change", "p_value": 0.013|null, "relative_change": 0.18|null, "early": {"from","to","value","n"}, "late": {"from","to","value","n"} }`. Early = the equal-length window immediately before the selected one; late = the selected window. Rising/falling only when p < 0.05 AND |relative change| >= 10%. Proportions: two-proportion z-test; means: Welch z.
Doctor names appear only inside a row that also carries `n` and the interval (`ci95` or funnel limits).
`Stat.value` follows `unit` (`percent` = 0-100, `per_100` / `per_1000` as stated, `score` 0-100, `ratio`, `count`). Inside V3/V4 rows the raw rate fields (`value` for `lv_rate`, `rate`, `ci95`, `expected_rate`, `centre`, funnel limits, `share_of_gap`, `site_rate_without`) are FRACTIONS 0-1; the row's `stat` is the percent-unit Stat.
Three module-local ids are not catalogue metrics and appear only as counts: `M-SIG-01` (open signal threads), `M-WL-01` (low-value findings in a worklist), `M-WL-02` (notes without PDQI-9). They are `unit:"count"` and are never min-n gated.

## 2. Metric ids shipped in Phase 1 (`cdmss_metric_catalogue` returns exactly this)
| id | label | status |
|---|---|---|
| `M-OPD-01` | Mean OPD NQI (PDQI-assessed notes only; coverage beside it) | ok |
| `M-OPD-02` | NQI band mix (raw band; % A, % A–B, % C–E; assessed notes) | ok |
| `M-OPD-03` | Clinical NQI (prescribing safety + appropriateness, reweighted to 100; all canonical notes) | ok |
| `M-OPD-04` | Documentation completeness (mean completeness_pct) | ok |
| `M-OPD-05` | Low-value findings per 100 notes (+ % notes with ≥1) | ok |
| `M-OPD-06` | LVC observed/expected per doctor (complexity-band expected; **no age adjustment**) | ok |
| `M-OPD-08` | Same-class duplicates per 1,000 Rx | ok (Rx from DB13; class membership is rule text, UNVERIFIED) |
| `M-OPD-12` | NSAID + antithrombotic per 1,000 Rx | ok (text-match on rationale, UNVERIFIED) |
| `M-OPD-13` | 5+ medicines per prescription (% of Rx) | ok (DB13 only) |
| `M-OPD-14` | Tests per consult | ok (DB13 only; shape of `further_investigation` UNVERIFIED) |
| `M-OPD-09/10/11` | Sedatives 60+, NSAID 60+/CKD, triple whammy per 1,000 Rx | **unavailable** (no age/CKD, no 3-drug rule) |
| `M-AMS-01` | WHO Access share | **unavailable** (no AWaRe list; formulary has `restricted` = Reserve only) |
| `M-AMS-02` | % with a Watch agent | **unavailable** (same) |
| `M-AMS-03` | Antibiotic flagged in viral URTI (per 100 audited URTI consults; lower bound) | ok (ICD J00–J06,J20–J22 UNVERIFIED) |
| `M-AMS-04` | Antibiotics in gastroenteritis | **unavailable** (no ratified rule) |
| `M-AMS-05` | Post-op prophylaxis > 24 h | **unavailable** (no order/MAR data in the DB13 extract) |

`cdmss_metric_catalogue` result: `view.metrics: [{id, label, family, unit, status, definition, caveats[], sources[], min_n_kind}]`; flat table `columns=["id","label","family","status","unit"]`.

**OPD site is not on the CDMSS row (GAPS G-01).** Site for OPD figures = the doctor's home site from the governance DB (`physicians.cdmss_doctor_uid` → active `physician_engagements` → `hospitals.code`). A doctor with no or several engaged hospitals gets site `UNMAPPED` / `MULTI` and counts only in "All sites". Every site breakdown carries `caveats` "OPD site = the doctor's home site, not where the note was written" and `view.site_basis:"doctor_home_site"`. **UNVERIFIED** that hospital codes line up with the CDMSS site codes `EHRC`/`EHBR`; the view reports whatever `hospitals.code` holds.

## 3. Views

Common params for all views: `window_days` (default as below), `site` (optional filter), `family` (V2–V8, default `opd`).

### 3.1 `cdmss_v1_this_week` — params `{ window_days?: 7 }`
Flat table: `columns:["family","status","metric_id","label","value","unit","n","state"]`, one row per tile.
```jsonc
"view": {
  "envelope": { ... headline = one sentence for the module ... },
  "families": [
    { "family":"opd", "label":"OPD note audit", "status":"live", "tiles":[ { "stat":Stat, "headline":"...", "plain":"..." } ] },  // NQI, Clinical NQI, band mix (A-B share), low-value per 100, completeness
    { "family":"ams", "label":"Antimicrobial stewardship", "status":"live", "tiles":[ ... AMS-01..05 incl. unavailable ones ] },
    { "family":"ipd", "label":"IPD discharge & episode audits", "status":"coming" },
    { "family":"ot", "status":"coming", "label":"OT notes" },
    { "family":"preop", "status":"coming", "label":"Pre-op risk" },
    { "family":"readmission", "status":"coming", "label":"Readmissions" }
  ]
}
```
"coming" families have no `tiles`. Each live tile `stat.change` compares this week with the previous 7 days.

### 3.2 `cdmss_v2_scorecard` — params `{ window_days?: 28, family?: "opd"|"ams" }`
Flat table: one row per (site, metric): `columns:["site","metric_id","label","value","unit","n","status","ci_lo","ci_hi"]`.
```jsonc
"view": {
  "envelope": {...},
  "site_basis": "doctor_home_site",
  "sites": [ {"code":"ALL","label":"All sites","n":412}, {"code":"EHRC","label":"EHRC","n":300} ],   // data-driven site picker: every site with audited notes in the window (n = canonical notes), not only the filtered one
  "matrix_sites": ["ALL","EHRC"],                      // the rows actually in `matrix` (honours the `site` param)
  "band_mix": [ { "site":"EHRC", "counts":{"A":6,"B":106,"C":20,"D":0,"E":0}, "bands": { "A": Stat, "B": Stat, "C": Stat, "D": Stat, "E": Stat } } ],   // opd only; for the stacked mix bar. Each Stat = that raw band's share (percent, Wilson CI) of PDQI-assessed notes, metric_id M-OPD-02, `band` = the letter; same min-n / coverage-grey rules
  "metrics": [ {"metric_id":"M-OPD-01","label":"...","unit":"score"} ],
  "matrix": [ { "site":"EHRC", "n_notes":412, "cells": { "M-OPD-01": Stat, "M-OPD-03": Stat, ... } } ],   // site group needs n>=15 else count_only
  "trend": [ { "site":"EHRC", "metric_id":"M-OPD-01", "points":[ {"week_from":"2026-10-04","week_to":"2026-10-10","value":77.1,"n":96,"status":"ok"} ] } ]  // IST calendar weeks ending at the window end, 4 points for 28 d
}
```
Trend site colours are B's (fixed per site code).

### 3.3 `cdmss_v3_doctor_variation` — params `{ window_days?: 28, metric?: "lv_rate"|"nqi", site?, specialty? }`
`lv_rate` = share of notes with ≥1 low-value finding (funnel, proportion). `nqi` = mean NQI (dot-and-whisker, assessed notes). Flat table: `columns:["doctor_uid","doctor_name","site","speciality","n","value","ci_lo","ci_hi","position"]`.
```jsonc
"view": {
  "envelope": {...},
  "metric": "lv_rate",
  "funnel": { "centre": 0.31, "centre_basis": "pooled rate over included doctors", "z95":1.96, "z998":3.09,
              "adjustment": "plain binomial limits (catalogue method; no overdispersion adjustment, no age adjustment)",
              "min_n_include": 50,
              "limits": [ {"n":10,"lo95":..,"hi95":..,"lo998":..,"hi998":..} ] },   // 25 points, n from 10 up to max doctor n, for drawing the funnel
  "doctors": [ { "doctor_uid","doctor_name","site","speciality","n", "value":0.42, "ci95":[lo,hi],      // Wilson
                  "numerator":.., "denominator":.., "expected_rate":0.30|null, "oe":1.4|null,             // M-OPD-06, null for n<10
                  "position":"above_998"|"above_95"|"within"|"below_95"|"below_998"|"greyed", "rank":3|null,
                  "stat": Stat } ],   // rank null + stat.status count_only when n<10 (funnel inclusion needs n>=50 audited notes: those 10..49 are listed, value shown, position "greyed")
  "excluded": { "count": 14, "reason": "fewer than 10 audited notes" }
}
```
For `metric:"nqi"`: `funnel` is null, `doctors[].value` = mean NQI, `ci95` = mean ± 1.96·sd/√n, coverage per doctor in `stat.coverage` (greyed under 50%).

### 3.4 `cdmss_v4_contributors` — params `{ window_days?: 28, site (required), metric?: "lv_rate" }`
Flat table: `columns:["doctor_uid","doctor_name","n","events","rate","share_of_gap","rate_without"]`.
```jsonc
"view": {
  "envelope": {...},
  "site": "EHRC", "metric":"lv_rate",
  "sites": [ {"code":"ALL","label":"All sites","n":135}, {"code":"EHRC","label":"EHRC","n":100} ],   // same shape as V2: all sites in the window, for the picker
  "site_rate": Stat, "other_sites_rate": Stat,
  "gap": { "absolute": 0.06, "relative": 0.2 } | null,
  "contributors": [ { "doctor_uid","doctor_name","n","events","rate","ci95",
                      "share_of_gap": 0.41,        // doctor's excess events (events - n*other_sites_rate) / site excess events; null when the site has no gap, or n<10
                      "site_rate_without": 0.27,   // site rate recomputed without this doctor
                      "status":"ok"|"count_only" } ],
  "top_contributor_removed": { "doctor_uid":"...", "site_rate_without": 0.27 }
}
```
Sorted by `share_of_gap` desc; count_only doctors last, unranked.

### 3.5 `cdmss_v5_redflags` — params `{ window_days?: 28, site?, doctor_uid?, limit?: 50 }`
Flat table: `columns:["doctor_uid","doctor_name","site","n_signals","n_open","top_importance","n_evidence"]`.
```jsonc
"view": {
  "envelope": {...},
  "dossiers": [ { "doctor_uid","doctor_name","site", 
      "signals":[ {"signal_id","reference","doctor_uid","doctor_name","site","signal_type","importance","status","response_required":true,"window_from","window_to","sla_due_at","overdue":false} ],
      "evidence":[ Evidence ] } ]       // <= 5 per dossier, newest first
}
```
`Evidence` = `{ "audit_id","uid","note_day","finding_no","subject","domain","verdict","signal_type","rule_ref","quote": "evidence text or null","rationale":"text or null","case": {"family":"opd","uid":"...","url":"https://.../care/<uid>"|null,"url_verified":false} }`.
**Red-flag basis (UNVERIFIED):** `gov_signal` rows with `response_required = true` or `importance` in the high set, plus the doctor's recent low-value/interaction findings as evidence. No stored dossier or severity table exists in `cdmss_ro` (catalogue §Worklists); importance and status vocabularies are passed through raw and never filtered on a guessed value.

### 3.6 `cdmss_v8_worklists` — params `{ list: "signals_open"|"signals_overdue"|"low_value_findings"|"missing_pdqi", window_days?: 28, site?, doctor_uid?, limit?: 500, offset?: 0 }`
Flat table = the named worklist (B renders + CSV-exports it): columns per list:
Signals are open threads (status not `ruled`/`closed`), OPD note class, NOT limited to the window (the envelope caveat says so); `site` is the prefix of the reference (e.g. `EHRC-AUD-...`), else the doctor's home site. `response_required` is true unless the stored value is `none`/empty.
- `signals_open` / `signals_overdue`: `reference, doctor_uid, doctor_name, site, signal_type, importance, status, response_required, window_from, window_to, sla_due_at, overdue, case_url`
- `low_value_findings`: `note_day, doctor_uid, doctor_name, site, uid, finding_no, subject, lvc_category, rule_ref, quote, case_url`
- `missing_pdqi`: `note_day, doctor_uid, doctor_name, site, uid, nqi, raw_band, case_url`
`view`: `{ envelope, list, columns_meta:[{key,label,kind}], total }`. Lists cap at 500 rows; `total` is the match count (page with `offset`).

## 4. Tools

### 4.1 `cdmss_metric_catalogue` — `{}` → table of ids (section 2).
### 4.2 `cdmss_metric` — `{ metric_id, window_days?: 28, group_by?: "none"|"site"|"doctor", site?, doctor_uid?, limit?: 50 }`
`view`: `{ envelope (headline + stats), metric: <catalogue entry>, groups: [ {key, label, site, stat: Stat} ] }`. Flat table: `key,label,value,unit,n,status`. `group_by:"doctor"` applies the doctor min-n; `group_by:"site"` the site min-n. Unavailable metric ⇒ `groups: []`, `stats:[Stat status unavailable]`, still a 200 with the reason.
### 4.3 `cdmss_drilldown` — `{ metric_id, site?, doctor_uid?, window_days?: 28, limit?: 100, offset?: 0 }`
Worklist rows behind the metric (notes/findings that make up the numerator, or the lowest-scoring notes for score metrics). Table `columns:["note_day","doctor_uid","doctor_name","site","uid","finding_no","subject","value","quote","case_url"]`; `view`: `{ envelope, metric_id, total }`.
### 4.4 `cdmss_finding_detail` — `{ uid, finding_no?: int }`
Table of that note's findings; `view`: `{ envelope, note:{uid,audit_id,doctor_uid,doctor_name,note_day,engine_version,raw_band,nqi,pdqi9_assessed}, findings:[Evidence & {confidence, source, concept_id}] , case:{url|null} }`.

## 5. Conventions
- Dates `YYYY-MM-DD` = IST calendar day; timestamps ISO-8601 with offset. Numbers are JSON numbers (rates as fractions 0–1 when `unit:"percent"` is **not** used; `unit:"percent"` values are 0–100). Decimals rounded to 4 places (scores 1 place) only for display fields (`plain`); raw values are unrounded.
- **Case link** (`case.url`): `${CDMSS_CASE_BASE_URL or "https://even-cdmss.vercel.app"}/care/${uid}`. The repo has no existing governance case-page pattern (the audit-findings screen links only to its own thread page `/audit-findings/<reference>`); `/care/[uid]` is the CDMSS prescription page and it is **UNVERIFIED** that its uid equals the OPD audit uid. `case.url` is null when no uid. Every `case` object (evidence rows and `cdmss_finding_detail.view.case`) carries `url_verified:false` until gov-orch confirms the pattern, so the UI can label the link as unverified.
- **No PHI gating** (V's rule): names/UHIDs/quotes appear for anyone who can open the module. OPD views carry no UHID.
- Band is always the RAW band (`raw_band`); `displayed_band` is never exposed in Phase 1.
- Caps: aggregate scans ≤ 50,000 rows (`incomplete` set when hit), lists ≤ 500 rows, CDMSS statement timeout 30 s (a timeout ⇒ 502 `tool_failed`).
- Error to screen: only the fixed codes of `studio_screen.py`.
- Fixtures for B: `studio/apps/agent/tests/fixtures/cdmss/<tool>.json` — one payload per tool, produced by the real SQL over a hand-seeded scratch database (so the shapes are exactly what the agent sends), relabelled `"mode":"fixture","synthetic":true`. **Test fixtures only; the agent never serves them** (with STUDIO_LIVE_READS off the CDMSS tools fail with a fixed message). A test fails if the live shape drifts from them, so a contract change shows up as a fixture change.

## 6. Open questions (UNVERIFIED, for gov-orch)
1. OPD site = doctor home site (needs sign-off; G-01). 2. Hospital codes in `hospitals.code` vs CDMSS `EHRC/EHBR`. 3. Clinical-reviewer role flag does not exist. 4. Case URL `/care/<uid>` vs the OPD uid. 5. Domain score scale (`score_appropriateness` etc.) assumed 0–100 like the NQI. 6. `gov_signal.importance` / `status` vocabularies. 7. Whether the DB13 extract's `further_investigation` / `medications` jsonb are arrays of items (assumed; non-array ⇒ treated as 0 items and counted in `n_unparsed`).
