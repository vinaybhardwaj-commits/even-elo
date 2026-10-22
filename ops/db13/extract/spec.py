"""The 8 DB13 extracts. Single source of truth: studio_dw DDL (ops/neon/0012_studio_dw.sql) must match these
column lists (a test compares them). Catalogue-named columns only (METRIC-CATALOGUE-v1); anything else needs a
catalogue entry first (fable G-D4). Every source column is cast server-side to its destination type.

Keyset: pages are `WHERE key > last ORDER BY key LIMIT n` on a key believed indexed (UNVERIFIED for all but the
kx_* `_id`, per the DB13 brief). `_id` is a technical key added to the tables that have one; no metric reads it.
wm = column compared with the previous run's DB13 snapshot time for incremental runs (`lookback` widens it)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Col:
    name: str
    type: str  # destination (and server-side cast) type
    metrics: str = ""  # catalogue metric ids, documentation only


@dataclass(frozen=True)
class Table:
    name: str  # destination table in studio_dw, also the name used in provenance
    source: str  # already-quoted source relation
    cols: tuple[Col, ...]
    key: str | None = None  # unique keyset column ("rows" mode)
    group_key: str | None = None  # "children" mode: rows grouped under this non-unique key
    wm: str | None = None  # incremental filter column, None = always full
    lookback: str = "0 seconds"
    extra: dict = field(default_factory=dict)

    @property
    def colnames(self):
        return [c.name for c in self.cols]


def C(name, type_, metrics=""):
    return Col(name, type_, metrics)


TABLES: tuple[Table, ...] = (
    # M-OPD-08..16, M-AMS-03/04 (Rx denominators, tests per consult, imaging, ICD denominators)
    Table(
        "individuals_prescriptions", 'public."individuals-prescriptions"',
        (C("_id", "text", "key: keyset paging, no metric"), C("_parent_id", "text", "M-OPD-15,16"), C("uid", "text", "M-OPD-08..16"),
         C("consult_uid", "text", "M-OPD-08..16"), C("kx_encounter_id", "text", "M-OPD-08..16"),
         C("doctor_uid", "text", "M-OPD-08..16"), C("timestamp", "timestamptz", "M-OPD-08..16"),
         C("uploaded_at", "timestamptz", "window anchor"), C("is_draft", "boolean", "M-OPD-08..16"),
         C("type_of_prescription", "text", "M-OPD-08..16"), C("consult_type", "text", "M-OPD-08..16"), C("consult_types", "text[]", "M-OPD-08..16"),
         C("medications", "jsonb", "M-OPD-08..13,M-AMS-*"), C("diagnosis_icd_codes", "text[]", "M-OPD-15,16,M-AMS-03,04"),
         C("impression_icd_codes", "text[]", "M-OPD-15,16,M-AMS-03,04"), C("further_investigation", "jsonb", "M-OPD-14..16")),
        key="_id", wm="uploaded_at"),
    # M-OPD-09/10 (age), M-OPD-14, M-AMS-03, M-PRE-03 strict, M-PRE-08
    Table(
        "dpipe_prescription_pipeline", 'public."dpipe_prescription_pipeline"',
        (C("presc_uid", "text", "M-OPD-09,10,M-PRE-08"), C("individual_uid", "text", "M-PRE-03,08"),
         C("age", "integer", "M-OPD-09,10"), C("timestamp", "timestamptz", "M-OPD-09,10,M-AMS-03,M-PRE-08"), C("uploaded_at", "timestamptz", "M-OPD-09,10,M-AMS-03,M-PRE-08"),
         C("presc_is_draft", "boolean", "M-OPD-09,10,M-AMS-03,M-PRE-08"), C("consult_type", "text", "M-OPD-09,10,M-AMS-03,M-PRE-08"), C("diagnosis", "jsonb", "M-AMS-03"),
         C("medicines", "jsonb", "M-OPD-09,10"), C("further_investigation", "jsonb", "M-OPD-14")),
        key="presc_uid", wm="uploaded_at"),
    # M-OPD-15, M-OPD-16, M-AMS-03, M-AMS-04 (diagnosis denominators); non-unique rows per parent
    Table(
        "dpipe_prescription_diagnosis", 'public."dpipe_prescription_pipeline__diagnosis"',
        (C("_parent_id", "text", "M-OPD-15,16,M-AMS-03,04"), C("diagnosis", "text", "M-OPD-15,16,M-AMS-03,04"), C("icd_code", "text", "M-OPD-15,16,M-AMS-03,04")),
        group_key="_parent_id"),
    # M-IPD-01..03, M-STAY-01 (doctor hop, site), M-RDM-01
    Table(
        "kx_ip_admissions", 'public."kx_ip_admissions"',
        (C("_id", "text", "key: keyset paging, no metric"), C("uid", "text", "M-IPD-*,M-STAY-01"), C("encounter_id", "text", "M-IPD-*,M-STAY-01"),
         C("current_treating_doctor_id", "text", "doctor hop G-04"), C("facility_name", "text", "site G-03"),
         C("admission_date_time", "timestamptz", "M-STAY-01"), C("encounter_type", "text", "M-RDM-01")),
        key="_id", wm="modified_at"),
    # M-RDM-01..03 (denominators); uhid = person key for incidence (G-22)
    Table(
        "kx_discharged_completed_patients", 'public."kx_discharged_completed_patients"',
        (C("_id", "text", "key: keyset paging, no metric"), C("uid", "text", "M-RDM-*"), C("encounter_id", "text", "M-RDM-*"), C("uhid", "text", "M-RDM-01 incidence"),
         C("encounter_type", "text", "M-RDM-01"), C("facility_name", "text", "M-RDM-01,G-03"),
         C("discharge_date", "timestamptz", "M-RDM-01"), C("treating_sub_department_name", "text", "M-RDM-01"),
         C("discharge_type_value", "text", "M-RDM-01"), C("admission_date_time", "timestamptz", "M-RDM-01"),
         C("status", "text", "M-RDM-01")),
        key="_id", wm="modified_at"),
    # M-PRE-08 (IP conversion by uhid)
    Table(
        "kx_billing_records", 'public."kx_billing_records"',
        (C("_id", "text", "key: keyset paging, no metric"), C("uid", "text", "M-PRE-08"), C("uhid", "text", "M-PRE-08"),
         C("patient_type", "text", "M-PRE-08"), C("bill_date_time", "timestamptz", "M-PRE-08")),
        key="_id", wm="bill_date_time", lookback="7 days"),
    # M-PRE-01..03, M-PRE-08
    Table(
        "surgery_cases", 'public."surgery_cases"',
        (C("uid", "text", "M-PRE-*"), C("individual_uid", "text", "M-PRE-08"), C("status", "text", "M-PRE-08"),
         C("created_at", "timestamptz", "M-PRE-*"), C("prescribed_at", "timestamptz", "M-PRE-*"), C("planned_surgery_date", "date", "M-PRE-*"),
         C("hospital_info__hospital_uid", "text", "site")),
        key="uid", wm="updated_at"),
    # doctor identity, hop, e-mail map (G-04..G-07); never bank/proofs/mobile/tariffs
    Table(
        "doctors", 'public."doctors"',
        (C("uid", "text", "all doctor-level"), C("email", "text", "G-07"), C("name_with_prefix", "text", "doctor hop G-04..G-07"), C("type", "text", "doctor hop G-04..G-07"),
         C("disabled", "boolean", "doctor hop G-04..G-07"), C("karexpert_metadata__uid", "text", "hop"),
         C("karexpert_metadata__practitioner_id", "text", "hop"),
         C("karexpert_metadata__practitioner_id_by_hospital", "jsonb", "hop,site")),
        key="uid"),
)

BY_NAME = {t.name: t for t in TABLES}
