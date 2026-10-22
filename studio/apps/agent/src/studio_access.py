"""Per-screen / per-tool access for the Studio agent (gov/role-parity).

MIRROR of apps/app/src/lib/zone/access.ts (tests/access_matrix.json pins both). The actor JWT `role` claim is a
comma-joined list of KNOWN roles ("staff", "super_admin", "sgc_member", "site_medical_head", "hr"); the app builds
it from the live staff row on every request. A tool is allowed when the actor satisfies the predicate of the screen
the tool belongs to, which is the access of the even-elo source page. Unknown tools are refused.
"""

from __future__ import annotations

from typing import Iterable, Optional

BASE_ROLE = "staff"
ROLE_FLAGS = ("hr", "sgc_member", "site_medical_head", "super_admin")
KNOWN_ROLES = frozenset({BASE_ROLE, *ROLE_FLAGS})

_ANY: frozenset[str] = frozenset()
SCREEN_ROLES: dict[str, frozenset[str]] = {
    "overview": _ANY,
    "physicians": _ANY,
    "audit-findings": frozenset({"super_admin", "site_medical_head", "sgc_member"}),
    "document-audits": _ANY,
    "rmo-inbox": _ANY,
    "incidents": frozenset({"super_admin", "sgc_member"}),
    "feedback": _ANY,
    "surgical": frozenset({"super_admin"}),
    "onboarding": _ANY,
    "admin": frozenset({"super_admin"}),
}

GOVERNANCE_SCREEN = {
    "list_physicians": "physicians",
    "physician_profile": "physicians",
    "physician_privileges": "physicians",
    "physician_oppe": "physicians",
    "physician_metrics": "physicians",
    "physician_qualifications": "physicians",
    "signal_snapshots": "overview",
    "interventions": "overview",
    "incident_summary": "overview",
    "overview_counts": "overview",
    "capture_gaps": "overview",
    "feedback_by_physician": "feedback",
    "list_document_audits": "document-audits",
    "document_audit_detail": "document-audits",
    "document_audit_doctor_rollup": "document-audits",
    "document_audit_headline": "document-audits",
}
HTTP_SCREEN = {
    "eiris_incidents": "incidents",
    "eiris_incident_detail": "incidents",
    "opd_signals": "audit-findings",
    "audit_findings": "audit-findings",
    "audit_finding_detail": "audit-findings",
    "rmo_inbox": "rmo-inbox",
    "rmo_author": "rmo-inbox",
    "rmo_release": "rmo-inbox",
    "patient_feedback": "feedback",
    "feedback_retract": "feedback",
    "surgical_write": "surgical",
    "onboarding_write": "onboarding",
    "admin_set_status": "admin",
    "admin_grant_role": "admin",
    "admin_process_resignation": "admin",
}


def parse_roles(role: object) -> Optional[frozenset[str]]:
    """The role claim as a set, or None when it is not a non-empty list of known roles (fail closed)."""
    if not isinstance(role, str):
        return None
    parts = [p.strip() for p in role.split(",")]
    if not parts or any(p not in KNOWN_ROLES for p in parts):
        return None
    return frozenset(parts)


def screen_for_tool(tool: str) -> Optional[str]:
    if tool in GOVERNANCE_SCREEN:
        return GOVERNANCE_SCREEN[tool]
    if tool in HTTP_SCREEN:
        return HTTP_SCREEN[tool]
    for prefix, screen in (("surgical_", "surgical"), ("onboarding_", "onboarding"), ("admin_", "admin")):
        if tool.startswith(prefix):
            return screen
    return None


def can_access_screen(roles: Optional[Iterable[str]], screen: str) -> bool:
    have = frozenset(roles or ())
    if not have or screen not in SCREEN_ROLES:
        return False
    wanted = SCREEN_ROLES[screen]
    return not wanted or bool(have & wanted)


def can_use_tool(roles: Optional[Iterable[str]], tool: str) -> bool:
    if tool == "plan_visualization":
        return bool(frozenset(roles or ()))
    screen = screen_for_tool(tool)
    return screen is not None and can_access_screen(roles, screen)
