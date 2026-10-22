Hi Shubh,

We're building a Governance Studio module that reports on clinical documentation quality, and a few of its numbers (prescription counts, readmission denominators, surgery conversion) need to read DB13. We'd like to do it in a way that you own and can switch off.

**What we need from you**
1. Run `0001_gov_studio_ro.sql` as the DB admin. It creates one login `gov_studio_ro` (max 3 connections, read-only, 60-second query limit), a schema `gov_studio` and 8 views holding only the columns our metric list names. It rolls itself back if the role could read anything else or write anything. It sets no password; please set it yourself with `\password gov_studio_ro` (or IAM auth if this is Cloud SQL).
2. An SSH account on ada for one key (ours, from the Asus relay), locked to a single port-forward to the DB13 host and port, no shell. The exact `authorized_keys` line is in RUNBOOK.md.
3. Please confirm the provider, region and maintenance window (we believe Cloud SQL, PostgreSQL 17.10; not verified), and whether the other databases on that server still let anyone connect (the script ends with a query that lists them).
4. A written line (email or Slack) saying the role and views are yours to own.

**What we never get**: admin rights, any write, any other database, any table outside those views, doctors' bank/ID/mobile details, patient names, addresses or phone numbers.

**How we behave**: one connection, at most 2 queries a second, a nightly batch (not live from screens), and our first session only runs six checks written in VERIFY.sql. If any check differs, we stop and tell you.

**Kill switch**: delete our one line from ada's `authorized_keys` and the connection is gone. You can also `ALTER ROLE gov_studio_ro NOLOGIN;` at any time.

Thanks,
V
