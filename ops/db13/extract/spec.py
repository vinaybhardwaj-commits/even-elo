"""The 8 DB13 extracts. Single source of truth: studio_dw DDL (ops/neon/0012_studio_dw.sql) must match these
column lists (a test compares them). Catalogue-named columns only (METRIC-CATALOGUE-v1); anything else needs a
catalogue entry first (fable G-D4). `metrics` holds real catalogue ids ONLY; why a column is there goes in `purpose`.
A column with no metric id must be a technical key (purpose starts with "key"). Every source column is cast
server-side to its destination type.

Reading: ONE named-cursor query per table per run (no ORDER BY, no paging), `FETCH 2000` per round trip, FETCHes
throttled to <= 2/s, one READ ONLY transaction per table. Incremental = `wm` column newer than the previous
successful snapshot of that table minus `lookback` (30 min covers commit lag). `large` tables run only 22:00-07:00 IST."""
from __future__ import annotations

from dataclasses import dataclass, field


def ids(prefix: str, lo: int, hi: int | None = None) -> str:
    return ",".join(f"{prefix}-{n:02d}" for n in range(lo, (hi or lo) + 1))


@dataclass(frozen=True)
class Col:
    name: str
    type: str  # destination (and server-side cast) type
    metrics: str = ""  # catalogue metric ids, comma separated, nothing else
    purpose: str = ""


@dataclass(frozen=True)
class Table:
    name: str  # destination table in studio_dw, also the name used in provenance
    source: str  # already-quoted source relation
    cols: tuple[Col, ...]
    key: str | None = None  # unique column = Neon primary key (upsert); None for the child table
    group_key: str | None = None  # child table: replaced wholesale per run (views show the latest ok run only)
    wm: str | None = None  # incremental filter column, None = always full
    lookback: str = "30 minutes"
    large: bool = False  # off-peak (22:00-07:00 IST) only
    cap_seconds: int | None = None  # per-table DB13 fetch cap override (default 15 min), with the reason logged
    cap_reason: str = ""
    est_bytes: int = 200_000_000  # rough spill size (UNVERIFIED), for the disk preflight
    extra: dict = field(default_factory=dict)

    @property
    def colnames(self):
        return [c.name for c in self.cols]


def C(name, type_, metrics="", purpose=""):
    return Col(name, type_, metrics, purpose)


RX = ids("M-OPD", 8, 16)
RX_ICD = ids("M-OPD", 15, 16) + ",M-AMS-03,M-AMS-04"
AGE = "M-OPD-09,M-OPD-10"
IPD = ids("M-IPD", 1, 3) + ",M-STAY-01"
RDM = ids("M-RDM", 1, 3)
PRE = ids("M-PRE", 1, 3) + ",M-PRE-08"

TABLES: tuple[Table, ...] = (
    Table(
        "individuals_prescriptions", 'public."individuals-prescriptions"',
        (C("_id", "text", purpose="key: Neon primary key"), C("_parent_id", "text", ids("M-OPD", 15, 16), "join to diagnosis rows"),
         C("uid", "text", RX, "key to the audit row"), C("consult_uid", "text", RX, "key to the audit row"),
         C("kx_encounter_id", "text", RX, "key to the audit row"), C("doctor_uid", "text", RX, "doctor attribution"),
         C("timestamp", "timestamptz", RX, "window anchor"), C("uploaded_at", "timestamptz", RX, "window anchor"),
         C("is_draft", "boolean", RX, "exclude drafts"), C("type_of_prescription", "text", RX, "Rx scope"),
         C("consult_type", "text", RX, "Rx scope"), C("consult_types", "text[]", RX, "Rx scope"),
         C("medications", "jsonb", ids("M-OPD", 8, 13) + ",M-AMS-01,M-AMS-02,M-AMS-03", "Rx denominator, 5+ medicines, drug classes"),
         C("diagnosis_icd_codes", "text[]", RX_ICD, "LBP / headache / URTI denominators"),
         C("impression_icd_codes", "text[]", RX_ICD, "LBP / headache / URTI denominators"),
         C("further_investigation", "jsonb", ids("M-OPD", 14, 16), "tests per consult, imaging")),
        key="_id", wm="_update_time", large=True, est_bytes=4_400_000_000),
    Table(
        "dpipe_prescription_pipeline", 'public."dpipe_prescription_pipeline"',
        (C("presc_uid", "text", AGE + ",M-PRE-08", "key to the prescription"), C("individual_uid", "text", "M-PRE-03,M-PRE-08", "member-level conversion match"),
         C("age", "integer", AGE, "only source of patient age"), C("timestamp", "timestamptz", AGE + ",M-AMS-03", "window anchor"),
         C("uploaded_at", "timestamptz", AGE + ",M-AMS-03", "window anchor"), C("presc_is_draft", "boolean", AGE, "exclude drafts"),
         C("consult_type", "text", AGE, "Rx scope"), C("diagnosis", "jsonb", "M-AMS-03", "URTI denominator"),
         C("medicines", "jsonb", AGE, "drug classes in age 60+"), C("further_investigation", "jsonb", "M-OPD-14", "tests per consult")),
        # dpipe_prescription_pipeline is a pipeline view with NO _update_time (DB13-COLUMNS.md); uploaded_at is its only
        # change marker. Edits that do not move uploaded_at are missed until a --full run; `timestamp` (the visit time)
        # is NOT a fallback: it never moves on an edit.
        key="presc_uid", wm="uploaded_at", large=True, est_bytes=2_000_000_000),
    Table(
        "dpipe_prescription_diagnosis", 'public."dpipe_prescription_pipeline__diagnosis"',
        (C("_parent_id", "text", RX_ICD, "join to the pipeline row"), C("diagnosis", "text", RX_ICD, "diagnosis denominators"),
         C("icd_code", "text", RX_ICD, "diagnosis denominators")),
        # ~3M rows (UNVERIFIED) is ~12.5 min of fetch floor, too close to 15. Chosen over splitting by _parent_id range: a
        # split would add range-filtered query shapes and, on an unindexed table, a second full scan of the primary plus a
        # more complex child replace. A 25 min cap (still under the 30 min line) adds no SQL and no load.
        group_key="_parent_id", large=True, cap_seconds=25 * 60, cap_reason="diagnosis table is one pass of ~3M rows (est. 12.5 min floor)", est_bytes=1_000_000_000),
    Table(
        "kx_ip_admissions", 'public."kx_ip_admissions"',
        (C("_id", "text", purpose="key: Neon primary key"), C("uid", "text", IPD, "admission identity"),
         C("encounter_id", "text", IPD, "join to ipd audits"), C("current_treating_doctor_id", "text", IPD, "IPD doctor hop"),
         C("facility_name", "text", IPD, "site, canonicalise Even-EHRC"), C("admission_date_time", "timestamptz", IPD, "window anchor"),
         C("encounter_type", "text", "M-RDM-01", "scope")),
        key="_id", wm="modified_at"),
    Table(
        "kx_discharged_completed_patients", 'public."kx_discharged_completed_patients"',
        (C("_id", "text", purpose="key: Neon primary key"), C("uid", "text", RDM, "episode identity"),
         C("encounter_id", "text", RDM, "episode identity"), C("uhid", "text", "M-RDM-01", "person key for incidence"),
         C("encounter_type", "text", "M-RDM-01", "ip_admission filter"), C("facility_name", "text", RDM, "site, canonicalise Even-EHRC"),
         C("discharge_date", "timestamptz", RDM, "window"), C("treating_sub_department_name", "text", "M-RDM-01", "excluded-department rule"),
         C("discharge_type_value", "text", "M-RDM-01", "DAMA/LAMA/expired exclusions"),
         C("admission_date_time", "timestamptz", RDM, "stay start for pairing"), C("status", "text", "M-RDM-01", "completed-only filter")),
        key="_id", wm="modified_at"),
    Table(
        "kx_billing_records", 'public."kx_billing_records"',
        (C("_id", "text", purpose="key: Neon primary key"), C("uid", "text", "M-PRE-08", "bill identity"), C("uhid", "text", "M-PRE-08", "IP conversion by uhid"),
         C("patient_type", "text", "M-PRE-08", "IP filter"), C("bill_date_time", "timestamptz", "M-PRE-08", "conversion window")),
        key="_id", wm="bill_date_time", lookback="7 days", large=True, est_bytes=1_000_000_000),
    Table(
        "surgery_cases", 'public."surgery_cases"',
        (C("uid", "text", PRE, "case identity"), C("individual_uid", "text", "M-PRE-08", "member-level conversion match"),
         C("status", "text", "M-PRE-08", "exclude CANCELLED"), C("created_at", "timestamptz", PRE, "window anchor"),
         C("prescribed_at", "timestamptz", PRE, "window anchor"), C("planned_surgery_date", "date", PRE, "pre-op timing"),
         C("hospital_info__hospital_uid", "text", PRE, "site")),
        key="uid", wm="updated_at"),
    # Only the IPD doctor hop: no e-mail, name, type or flags (no catalogue id needs them; names come from the CDMSS directory).
    Table(
        "doctors", 'public."doctors"',
        (C("uid", "text", IPD, "doctor identity"), C("karexpert_metadata__uid", "text", IPD, "IPD doctor hop"),
         C("karexpert_metadata__practitioner_id", "text", IPD, "IPD doctor hop"),
         C("karexpert_metadata__practitioner_id_by_hospital", "jsonb", IPD, "IPD doctor hop, doctor-to-site")),
        key="uid"),
)

BY_NAME = {t.name: t for t in TABLES}
