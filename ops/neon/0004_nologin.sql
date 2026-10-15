-- Containment / rotation step 0, run by `run-roles.sh --nologin [--role R]` and automatically by a FAILED
-- `run-roles.sh --login`. ONE statement, deliberately NOT inside the transaction of any other step, so it is
-- committed on its own: whatever else fails, the role cannot log in afterwards. Idempotent, no password.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on
ALTER ROLE :"role" NOLOGIN;
