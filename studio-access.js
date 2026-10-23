// Which Studio screens a staff member may open (gov/role-parity). ONE predicate table for the even-elo middleware.
// MIRROR of studio/apps/app/src/lib/zone/access.ts (the Studio zone enforces the same table server-side);
// src/lib/__tests__/studio-access-parity.test.ts compares the two for every role combination. Change both together.
//
// Rule: access to a Studio screen = access to the even-elo SOURCE page it replaces (see the access matrix):
//   overview, physicians, document-audits, rmo-inbox, feedback, onboarding  any active staff
//   cdmss (module)      super_admin | site_medical_head | sgc_member
//   audit-findings      super_admin | site_medical_head | sgc_member    (src/lib/staff-guard.ts "view")
//   incidents (e-IRIS)  super_admin | sgc_member                        (src/app/safety/page.tsx)
//   surgical, admin     super_admin                                     (src/middleware.ts)
const SCREEN_ROLES = {
  overview: [],
  physicians: [],
  "audit-findings": ["is_super_admin", "is_site_medical_head", "is_sgc_member"],
  "document-audits": [],
  cdmss: ["is_super_admin", "is_site_medical_head", "is_sgc_member"],
  "rmo-inbox": [],
  incidents: ["is_super_admin", "is_sgc_member"],
  feedback: [],
  surgical: ["is_super_admin"],
  onboarding: [],
  admin: ["is_super_admin"],
};

// `user` is the (already active, PIN-settled) session payload: { is_super_admin, is_sgc_member, is_site_medical_head, is_hr }.
function canAccessStudioScreen(user, screen) {
  const wanted = SCREEN_ROLES[screen];
  if (!wanted) return false;
  if (wanted.length === 0) return true;
  return wanted.some((flag) => user && user[flag] === true);
}

// "/studio/admin/users" -> "admin"; anything that is not a Studio screen path -> null.
function studioScreenOf(studioPath) {
  const m = /^\/studio\/([^/]+)/.exec(studioPath || "");
  return m && Object.prototype.hasOwnProperty.call(SCREEN_ROLES, m[1]) ? m[1] : null;
}

// May this user be redirected to this Studio path? Only when they satisfy the TARGET screen's predicate.
function canAccessStudioPath(user, studioPath) {
  const screen = studioScreenOf(studioPath);
  return screen !== null && canAccessStudioScreen(user, screen);
}

module.exports = { SCREEN_ROLES, canAccessStudioScreen, canAccessStudioPath, studioScreenOf };
