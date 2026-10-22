"""studio_cdmss_ro against a scratch Postgres holding the CDMSS schema (built from Even-CDMSS migrations + the transcribed
runtime DDL). Proves: the role reads every view, reads no base table, sees exactly the allowlisted columns; and the
canonical-row / excluded / site rules hold on fixture rows. Fixture rows are synthetic (no real identifiers)."""

import json
import re
from decimal import Decimal

import psycopg
import pytest

from tests.cdmss_harness import ROLE, SQL_POST, cdmss, needs_env  # noqa: F401  (fixture)

pytestmark = needs_env

VIEWS = (
    "ams_formulary ccb_brief doctor_dim gov_signal ipd_discharge_audit ipd_episode_audit lvc_concept lvc_rule lvc_rule_event "
    "opd_engine_version opd_finding opd_note_audit ot_note_audit preop_finding readmission_finding site_dim site_observed"
).split()


def allowlist():
    text = SQL_POST.read_text()
    return {m.group(1): m.group(2).split() for m in re.finditer(r"^\s*\('([a-z_]+)', '([a-z0-9_ ]+)'\)", text, re.M)}


def opd(c, uid, ver, *, model="gemini-2.5-pro", idx=80, band="B", disp=None, excl=None, at="2026-10-01T10:00:00Z", app="standalone",
        findings=None, scorecard=None, pdqi9=None, doctor="D1", note_date="2026-09-30T08:00:00Z"):
    c.su_exec(
        """INSERT INTO opd_note_audits (uid, engine_version, model, note_quality_index, band, displayed_band, excluded_reason,
             audited_at, app_source, findings, scorecard, pdqi9, doctor_uid, note_date)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (uid, f"opd-note-audit/{ver}", model, idx, band, disp, excl, at, app,
         json.dumps(findings) if findings is not None else None, json.dumps(scorecard) if scorecard is not None else None,
         json.dumps(pdqi9) if pdqi9 is not None else None, doctor, note_date),
    )


def sc(weight):
    return {"headline": 80, "domains": [{"domain": "documentation", "weight": 0.3}, {"domain": "note_quality", "weight": weight}]}


@pytest.fixture(scope="module")
def data(cdmss):
    c = cdmss
    # canonical: numeric (not lexicographic) version order
    opd(c, "u-num", "0.81.9", idx=70, band="C")
    opd(c, "u-num", "0.81.17", idx=80, band="B", disp="C")
    # grader tier beats a newer version: local qwen on the NEWEST version loses to cloud on an older one
    opd(c, "u-qwen", "0.81.21", model="qwen2.5:14b", idx=99, band="A", at="2026-10-02T00:00:00Z")
    opd(c, "u-qwen", "0.81.19", idx=60, band="D")
    # excluded rows leave BEFORE ranking: the older clean row wins; a note with only an excluded row is absent
    opd(c, "u-excl", "0.81.21", idx=95, band="A", excl="vertex_outage_mislabel_2026_07")
    opd(c, "u-excl", "0.81.20", idx=61, band="D")
    opd(c, "u-only-excl", "0.81.21", excl="house_account")
    # family is derived, not listed: 0.81.22 and 0.82.0 are read; -mini, below-floor and odd tails are not (and cannot raise)
    opd(c, "u-new", "0.81.22", idx=88)
    opd(c, "u-next", "0.82.0", idx=89)
    opd(c, "u-mini", "0.81.20-mini", idx=50)
    opd(c, "u-old", "0.81.2", idx=51)
    opd(c, "u-odd", "0.81.x", idx=52)
    c.su_exec("INSERT INTO opd_note_audits (uid, engine_version, note_quality_index, band) VALUES ('u-foreign','other-engine/1.0',1,'E')")
    # app_source partitions the identity
    opd(c, "u-app", "0.81.21", app="standalone")
    opd(c, "u-app", "0.81.20", app="other")
    # PDQI-9 flag
    opd(c, "u-pq0", "0.81.21", scorecard=sc(0))
    opd(c, "u-pq1", "0.81.21", scorecard=sc(0.2))
    opd(c, "u-pqe", "0.81.21", pdqi9={})
    opd(c, "u-pqf", "0.81.21", pdqi9={"accurate": 3})
    # findings: structured keys exposed, text never; non-array findings give no rows and no error
    opd(c, "u-find", "0.81.21", findings=[
        {"subject": "SECRET-SUBJECT", "verdict": "low_value", "confidence": 0.8, "domain": "appropriateness", "rationale": "SECRET-RATIONALE",
         "evidence": ["SECRET-EVIDENCE"], "source": "llm", "informational": False, "signal_type": "antibiotic_stewardship",
         "lvc_category": "antibiotic", "direction": "overuse", "concept_id": "overuse:order:cbc", "rule_ref": "R5", "finding_ref": "f1", "stable_ref": "s1"},
        {"verdict": "ok", "confidence": "n/a", "informational": "maybe"}, "scalar"])
    opd(c, "u-fnull", "0.81.21", findings=None)
    c.su_exec("INSERT INTO opd_note_audits (uid, engine_version, note_quality_index, band, findings) VALUES ('u-fobj','opd-note-audit/0.81.21',1,'E','{\"a\":1}')")
    # IPD discharge
    for doc, ip, ver, model in [("doc1", "IP-1250", "ipd-discharge-audit/0.1", "gemini-2.5-pro"), ("doc1", "IP-1250", "ipd-discharge-audit/0.2", "gemini-2.5-pro"),
                                ("doc1", "IP-1250", "ipd-discharge-audit/0.2-mini", "qwen2.5:14b"), ("doc2", "IPNO-229", "ipd-discharge-audit/0.2", "gemini-2.5-pro"),
                                ("doc3", "ER-511", "ipd-discharge-audit/0.2", "gemini-2.5-pro")]:
        c.su_exec("INSERT INTO ipd_discharge_audits (document_id, ip_uid, engine_version, model, care_value_index, band, member_id, report) "
                  "VALUES (%s,%s,%s,%s,70,'C','MEMBER-SECRET','{\"x\":\"REPORT-SECRET\"}')", (doc, ip, ver, model))
    # site matching is trim + upper + startsWith (readmission-rates-core.ts:201-204); local-only documents are dropped (audit-canonical.ts:226-229)
    for doc, ip, ver, model in [("doc4", " ip-77", "ipd-discharge-audit/0.2", "gemini-2.5-pro"), ("doc5", "IPNO123", "ipd-discharge-audit/0.2", "gemini-2.5-pro"),
                                ("doc6", "adm9", "ipd-discharge-audit/0.2", "gemini-2.5-pro"), ("doc7", "ER-1", "ipd-discharge-audit/0.2-mini", "qwen2.5:14b"),
                                ("doc8", "ER-2", "ipd-discharge-audit/0.2", "qwen2.5:14b")]:
        c.su_exec("INSERT INTO ipd_discharge_audits (document_id, ip_uid, engine_version, model, care_value_index, band) VALUES (%s,%s,%s,%s,70,'C')", (doc, ip, ver, model))
    # IPD episode
    for enc, ip, fac, cur in [("e1", "IP-1", "Even", True), ("e2", "IP-2", "Even-EHRC", True), ("e3", "IPNO-3", "Even-EHBR", True),
                              ("e4", "IP-4", "Mystery Hospital", True), ("e5", "XX-5", "Mystery Hospital", True), ("e6", "IP-6", "Even", False)]:
        c.su_exec("INSERT INTO ipd_episode_audits (encounter_id, ip_uid, facility_name, is_current, engine_version, run_seq, real_course) "
                  "VALUES (%s,%s,%s,%s,'ipd-episode-audit/0.2',1,%s)", (enc, ip, fac, cur, json.dumps("COURSE-SECRET")))
    # OT
    c.su_exec("INSERT INTO ot_note_audits (uid, hospital_uid, uhid, note, component_json, surgeon_raw, doctor_uid, map_status, engine_version, note_day) "
              "VALUES ('ot1','hosp-uid-1','UHID-SECRET','NOTE-SECRET','{\"a\":1}','SURGEON-SECRET','D1','mapped','ot-note-audit/0.1','2026-09-01'),"
              "('ot2','hosp-uid-1',NULL,NULL,NULL,NULL,NULL,'unmapped','ot-note-audit/0.1','2026-09-02')")
    c.su_exec("INSERT INTO ot_note_audits (uid, engine_version, model, map_status, note_day) VALUES "
              "('ot3','ot-note-audit/0.2','qwen2.5:14b','unmapped','2026-09-03'),('ot3','ot-note-audit/0.1','gemini-2.5-pro','unmapped','2026-09-03')")
    # pre-op
    c.su_exec("INSERT INTO preop_findings (episode_key, engine_version, hospital, patient_name, uhid, tier, snapshot, snapshot_fingerprint) VALUES "
              "('ep1','preop-risk/0.1','Even-EHBR','NAME-SECRET','UHID-SECRET','high','{}','fp'),('ep2','preop-risk/0.1','uid-xyz','NAME-SECRET','UHID-SECRET','low','{}','fp')")
    # readmission
    for key, ver, enc in [("k1", "readmission/0.1", "IP-9"), ("k1", "readmission/0.2", "IP-9"), ("k2", "readmission/0.2", "IPNO-4"), ("k3", "readmission/0.2", "ZZ-4")]:
        c.su_exec("INSERT INTO readmission_findings (dedup_key, engine_version, finding_class, index_encounter_id, lane, uhid, cm_note, finding) "
                  "VALUES (%s,%s,'even_even',%s,'structural_30d','UHID-SECRET','CMNOTE-SECRET','{\"x\":1}')", (key, ver, enc))
    # misc families
    c.su_exec("INSERT INTO opd_gov_signal (reference, doctor_uid, signal_type, importance, response_required, latest_response, ruling) "
              "VALUES ('EHRC-AUD-1','D1','t','high','yes','{\"t\":\"RESPONSE-SECRET\"}','{\"t\":\"RULING-SECRET\"}')")
    c.su_exec("INSERT INTO ccb_briefs (presc_uid, individual_uid, uhid, envelope) VALUES ('p1','IND-SECRET','UHID-SECRET','{\"x\":\"ENV-SECRET\"}')")
    c.su_exec("INSERT INTO doctor_directory (doctor_uid, doctor_name, speciality) VALUES ('D1','Dr Test','Medicine')")
    c.su_exec("INSERT INTO doctor_roster (doctor_uid, name, alias_uids) VALUES ('D1','Dr Test','[\"D9\"]'), ('D2','Dr Roster Only','[]')")
    return c


def q(c, sql, params=None):
    return c.as_role(sql, params)


def col(c, view, column, where="true"):
    return [r[0] for r in q(c, f"SELECT {column} FROM cdmss_ro.{view} WHERE {where}")]


# ---------------------------------------------------------------- role: reads views, reads no base table


def test_role_reads_every_view(data):
    for v in VIEWS:
        q(data, f"SELECT * FROM cdmss_ro.{v} LIMIT 1")


def test_view_columns_are_exactly_the_allowlist(data):
    allow = allowlist()
    assert set(allow) == set(VIEWS)
    for v in VIEWS:
        cols = [r[0] for r in q(data, "SELECT column_name FROM information_schema.columns WHERE table_schema='cdmss_ro' AND table_name=%s ORDER BY ordinal_position", (v,))]
        assert cols == allow[v], v


def test_role_cannot_read_any_base_table(data):
    tables = [r[0] for r in data.su_exec("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')")]
    assert len(tables) > 40
    for t in tables:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            q(data, f'SELECT 1 FROM public."{t}" LIMIT 1')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            q(data, f'SELECT * FROM public."{t}" LIMIT 1')
    # column-level too: a single column of a PHI-bearing table
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(data, "SELECT uhid FROM public.readmission_findings")
    assert not data.su_exec("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND has_any_column_privilege(%s, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')", (ROLE,))


def test_role_cannot_write_or_create_or_call(data):
    for stmt in ("INSERT INTO cdmss_ro.site_dim VALUES ('a','b','c','d','e')", "UPDATE cdmss_ro.opd_note_audit SET uid='x'", "DELETE FROM cdmss_ro.lvc_rule",
                 "CREATE TABLE cdmss_ro.t(i int)", "CREATE TABLE public.t(i int)", "CREATE VIEW cdmss_ro.v AS SELECT 1"):
        with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.ReadOnlySqlTransaction, psycopg.errors.WrongObjectType, psycopg.errors.ObjectNotInPrerequisiteState)):
            q(data, stmt)


def test_role_settings_and_no_membership(data):
    (cfg, login, limit, sup, members) = data.su_exec(
        "SELECT rolconfig, rolcanlogin, rolconnlimit, rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication, "
        "(SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE rolname=%s", (ROLE,))[0]
    assert login is False and limit == 5 and sup is False and members == 0
    assert "default_transaction_read_only=on" in cfg and "statement_timeout=20s" in cfg


def test_security_barrier_owner_owned_no_invoker(data):
    rows = data.su_exec("SELECT c.relname, c.reloptions, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cdmss_ro'")
    assert len(rows) == 17
    for name, opts, owner in rows:
        assert "security_barrier=true" in opts and not any("security_invoker" in o for o in opts), name
        assert owner == "neondb_owner"


def test_postcheck_file_passes_standalone(data):
    data.owner_exec_file(SQL_POST)


# ---------------------------------------------------------------- OPD canonical rules


def test_opd_one_row_per_note_and_numeric_version_order(data):
    rows = q(data, "SELECT engine_version, raw_band, displayed_band FROM cdmss_ro.opd_note_audit WHERE uid='u-num'")
    assert rows == [("opd-note-audit/0.81.17", "B", "C")]  # 0.81.17 beats 0.81.9 (not lexicographic); raw and displayed are separate columns


def test_opd_grader_tier_beats_newer_local_version(data):
    assert q(data, "SELECT engine_version, grader_tier, raw_band FROM cdmss_ro.opd_note_audit WHERE uid='u-qwen'") == [("opd-note-audit/0.81.19", "cloud", "D")]


def test_opd_excluded_rows_leave_before_ranking(data):
    assert q(data, "SELECT engine_version FROM cdmss_ro.opd_note_audit WHERE uid='u-excl'") == [("opd-note-audit/0.81.20",)]
    assert col(data, "opd_note_audit", "uid", "uid='u-only-excl'") == []
    assert q(data, "SELECT count(*) FROM cdmss_ro.opd_note_audit a JOIN cdmss_ro.opd_engine_version v USING (engine_version)")[0][0] > 0


def test_opd_family_is_derived_from_data_with_a_guard(data):
    got = set(col(data, "opd_note_audit", "uid"))
    assert {"u-new", "u-next"} <= got  # 0.81.22 / 0.82.0 were never in any hard-coded list
    assert not ({"u-mini", "u-old", "u-odd", "u-foreign"} & got)
    fam = dict(q(data, "SELECT engine_version, in_family FROM cdmss_ro.opd_engine_version"))
    assert fam["opd-note-audit/0.81.22"] is True and fam["opd-note-audit/0.82.0"] is True
    assert fam["opd-note-audit/0.81.20-mini"] is False and fam["opd-note-audit/0.81.2"] is False
    assert fam["opd-note-audit/0.81.x"] is False and fam["other-engine/1.0"] is False
    shape = dict(q(data, "SELECT engine_version, shape_ok FROM cdmss_ro.opd_engine_version"))
    assert shape["opd-note-audit/0.81.20-mini"] is False and shape["opd-note-audit/0.81.9"] is True


def test_opd_exactly_one_canonical_row_per_app_source_and_uid(data):
    assert q(data, "SELECT count(*) - count(DISTINCT (app_source, uid)) FROM cdmss_ro.opd_note_audit") == [(0,)]
    assert sorted(col(data, "opd_note_audit", "app_source", "uid='u-app'")) == ["other", "standalone"]


def test_opd_pdqi9_assessed_flag(data):
    flag = {u: (a, b) for u, a, b in q(data, "SELECT uid, pdqi9_assessed, pdqi9_assessed_basis FROM cdmss_ro.opd_note_audit WHERE uid LIKE 'u-pq%'")}
    assert flag == {"u-pq0": (False, "scorecard"), "u-pq1": (True, "scorecard"), "u-pqe": (False, "pdqi9_column"), "u-pqf": (True, "pdqi9_column")}
    assert q(data, "SELECT scorecard_recorded FROM cdmss_ro.opd_note_audit WHERE uid='u-pq0'") == [(True,)]
    assert q(data, "SELECT scorecard_recorded FROM cdmss_ro.opd_note_audit WHERE uid='u-pqe'") == [(False,)]


def test_opd_finding_exposes_structure_and_text(data):
    rows = q(data, "SELECT finding_no, domain, verdict, confidence, informational, signal_type, lvc_category, direction, concept_id, rule_ref FROM cdmss_ro.opd_finding WHERE uid='u-find' ORDER BY finding_no")
    assert rows[0] == (1, "appropriateness", "low_value", Decimal('0.8'), False, "antibiotic_stewardship", "antibiotic", "overuse", "overuse:order:cbc", "R5")
    assert rows[1][3] is None and rows[1][4] is None and len(rows) == 3  # junk confidence / informational -> NULL, no error
    assert col(data, "opd_finding", "uid", "uid IN ('u-fnull','u-fobj')") == []
    subj, ev, rat = q(data, "SELECT subject, evidence, rationale FROM cdmss_ro.opd_finding WHERE uid='u-find' AND finding_no=1")[0]
    assert (subj, ev, rat) == ("SECRET-SUBJECT", ["SECRET-EVIDENCE"], "SECRET-RATIONALE")  # text is exposed by ruling


# ---------------------------------------------------------------- other families, sites


def test_ipd_discharge_canonical_and_site(data):
    rows = {ip: (v, site, basis) for ip, v, site, basis in q(data, "SELECT ip_uid, engine_version, site_code, site_basis FROM cdmss_ro.ipd_discharge_audit")}
    assert rows["IP-1250"] == ("ipd-discharge-audit/0.2", "EHRC", "encounter_prefix")  # 0.2 beats 0.1; the -mini/qwen row loses
    assert rows["IPNO-229"][1] == "EHBR"
    assert rows["ER-511"] == ("ipd-discharge-audit/0.2", "UNMAPPED", "none")  # no code evidence for ER-: kept, not dropped
    assert q(data, "SELECT count(*) FROM cdmss_ro.ipd_discharge_audit") == [(6,)]


def test_ipd_discharge_drops_local_graders_before_ranking(data):
    got = set(col(data, "ipd_discharge_audit", "ip_uid"))
    assert "ER-1" not in got and "ER-2" not in got  # doc7 only -mini/qwen, doc8 only qwen on the plain version: absent, not demoted
    assert set(col(data, "ipd_discharge_audit", "grader_tier")) == {"cloud"}


def test_prefix_site_matching_is_trim_upper_startswith(data):
    got = {ip: s for ip, s in q(data, "SELECT ip_uid, site_code FROM cdmss_ro.ipd_discharge_audit")}
    assert got[" ip-77"] == "EHRC" and got["IPNO123"] == "EHBR" and got["adm9"] == "EHBR"  # 'IPNO' without dash; lower case; padded
    assert ("encounter_prefix", "IPNO", "EHBR") in {(v, r, s) for v, r, s in q(data, "SELECT vocabulary, raw_value, site_code FROM cdmss_ro.site_dim")}
    seen = {r: s for r, s in q(data, "SELECT raw_value, site_code FROM cdmss_ro.site_observed WHERE source='ipd_discharge_audit.ip_uid'")}
    assert seen["IP-"] == "EHRC" and seen["IPNO"] == "EHBR" and seen["ADM"] == "EHBR"


def test_ot_rank_is_the_full_canonical_rank(data):
    assert q(data, "SELECT engine_version, model FROM cdmss_ro.ot_note_audit WHERE uid='ot3'") == [("ot-note-audit/0.1", "gemini-2.5-pro")]  # grader tier beats version


def test_site_dim_canonicalises_the_relabel(data):
    sd = {(v, r): s for v, r, s in q(data, "SELECT vocabulary, raw_value, site_code FROM cdmss_ro.site_dim")}
    assert sd[("facility_name", "Even")] == sd[("facility_name", "Even-EHRC")] == "EHRC" and sd[("facility_name", "Even-EHBR")] == "EHBR"
    assert sd[("encounter_prefix", "IP-")] == "EHRC" and sd[("encounter_prefix", "IPNO")] == sd[("encounter_prefix", "ADM")] == "EHBR"
    assert not any(v == "hospital_uid" for v, _ in sd)  # no code evidence: never invented
    ep = {e: (s, b) for e, s, b in q(data, "SELECT encounter_id, site_code, site_basis FROM cdmss_ro.ipd_episode_audit")}
    assert ep["e1"] == ("EHRC", "facility_name") and ep["e2"] == ("EHRC", "facility_name") and ep["e3"] == ("EHBR", "facility_name")
    assert ep["e4"] == ("EHRC", "encounter_prefix")  # unknown facility string, known prefix
    assert ep["e5"] == ("UNMAPPED", "none")
    assert "e6" not in ep  # is_current = false


def test_unmapped_is_kept_and_listed(data):
    assert col(data, "ot_note_audit", "site_code") == ["UNMAPPED"] * 3
    assert col(data, "preop_finding", "site_code", "episode_key='ep1'") == ["EHBR"]
    assert col(data, "preop_finding", "site_code", "episode_key='ep2'") == ["UNMAPPED"]
    seen = {(s, r): (site, n) for s, r, site, n in q(data, "SELECT source, raw_value, site_code, n_rows FROM cdmss_ro.site_observed")}
    assert seen[("ipd_episode_audit.facility_name", "Mystery Hospital")] == ("UNMAPPED", 2)
    assert seen[("ipd_episode_audit.facility_name", "Even")][0] == "EHRC" and seen[("ipd_episode_audit.facility_name", "Even-EHRC")][0] == "EHRC"
    assert seen[("ot_note_audit.hospital_uid", "hosp-uid-1")] == ("UNMAPPED", 2)
    assert seen[("readmission_finding.index_encounter_id", "ZZ-")][0] == "UNMAPPED"


def test_readmission_newest_version_and_site(data):
    rows = {k: (v, s) for k, v, s in q(data, "SELECT index_encounter_id, engine_version, site_code FROM cdmss_ro.readmission_finding")}
    assert rows["IP-9"] == ("readmission/0.2", "EHRC") and rows["IPNO-4"][1] == "EHBR" and rows["ZZ-4"][1] == "UNMAPPED"
    assert q(data, "SELECT count(*) FROM cdmss_ro.readmission_finding") == [(3,)]


def test_ot_surgeon_mapping_flag(data):
    assert dict(q(data, "SELECT uid, surgeon_mapped FROM cdmss_ro.ot_note_audit")) == {"ot1": True, "ot2": False, "ot3": False}


def test_doctor_dim_has_roster_only_doctors_and_no_aliases(data):
    assert {r[0] for r in q(data, "SELECT doctor_uid FROM cdmss_ro.doctor_dim")} == {"D1", "D2"}


def test_identity_and_text_columns_are_exposed_by_ruling(data):
    """gov-orch ruling 21 Oct: no PHI gating. Identity keys and stored finding text are readable through the views."""
    def one(view, cols, where="true"):
        return q(data, f"SELECT {cols} FROM cdmss_ro.{view} WHERE {where}")
    assert one("ot_note_audit", "uhid, note, surgeon_raw, component_json", "uid='ot1'") == [("UHID-SECRET", "NOTE-SECRET", "SURGEON-SECRET", {"a": 1})]
    assert one("preop_finding", "patient_name, uhid", "episode_key='ep1'") == [("NAME-SECRET", "UHID-SECRET")]
    assert one("readmission_finding", "uhid, cm_note, finding", "index_encounter_id='IP-9'") == [("UHID-SECRET", "CMNOTE-SECRET", {"x": 1})]
    assert one("ipd_discharge_audit", "document_id, member_id, report", "ip_uid='IP-1250'")[0][1:] == ("MEMBER-SECRET", {"x": "REPORT-SECRET"})
    assert one("ipd_episode_audit", "real_course", "encounter_id='e1'") == [("COURSE-SECRET",)]
    assert one("gov_signal", "latest_response, ruling") == [({"t": "RESPONSE-SECRET"}, {"t": "RULING-SECRET"})]
    assert one("ccb_brief", "individual_uid, uhid, envelope") == [("IND-SECRET", "UHID-SECRET", {"x": "ENV-SECRET"})]
    assert one("opd_note_audit", "consult_uid, kx_encounter_id, pdqi9", "uid='u-pqf'")[0][2] == {"accurate": 3}
    assert one("doctor_dim", "alias_uids", "doctor_uid='D1'") == [(["D9"],)]
    cols = [r[0] for r in q(data, "SELECT column_name FROM information_schema.columns WHERE table_schema='cdmss_ro'")]
    assert not [c for c in cols if re.search(r"secret|token|password|api_?key|prompt|trace|raw_judge|stage_timings", c)]
    assert {"clinical_review_decision", "clinical_review_quote", "clinical_review_model"} <= set(allowlist()["readmission_finding"])
    assert "doctor_uid" not in allowlist()["ccb_brief"]  # UNVERIFIED-live: in no migration or runtime DDL


def test_precheck_source_list_matches_the_view_dependencies(data):
    """0000 is generated from pg_depend of the views; this regenerates it and fails on drift (edit 0002 and 0000 together)."""
    from tests.cdmss_harness import SQL_PRE
    live = data.su_exec("""SELECT t.relname, a.attname FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class v ON v.oid=r.ev_class
        JOIN pg_namespace vn ON vn.oid=v.relnamespace JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
        WHERE vn.nspname='cdmss_ro' AND tn.nspname='public' AND d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0""")
    listed = {(m.group(1), c) for m in re.finditer(r"^\s*\('([a-z_]+)', '([a-z0-9_ ]+)'\)", SQL_PRE.read_text(), re.M) for c in m.group(2).split()}
    assert listed == set(live) and len(listed) > 250
