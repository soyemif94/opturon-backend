# BILL-009 public checkout rollout note

The public checkout change adds no database migration. Account creation uses the existing clinic, portal-user, subscription, and billing-event records; checkout reservations and immutable contracts continue through the canonical BILL-006 service. A new account is explicitly left unactivated until BILL-007 accepts a valid approved payment.

Before releasing BILL-009, review the Render Pre-Deploy Command. The current production command is pinned to migration 090 and must not remain the release mechanism for a future candidate containing a new migration. For a candidate with one reviewed additive migration, pin the command to that exact filename, for example `node src/db/migrate.js --only 091_example.sql`. Use the generic `node src/db/migrate.js` command only when the candidate's complete pending migration set has been reviewed as safe to apply before web startup. Do not change the Render setting as part of this local BILL-009 implementation.

Release ordering remains: candidate code/artifact available, reviewed migration command completes, migration state is read back, current runtime health is verified, then the candidate web runtime starts. BILL-009 itself has no migration to execute.
