# Billing cutover precursor

M0 creates the singleton in generation 1. Missing or malformed state fails closed.
The webhook authenticates before reaching billing. The precursor checks generation
before any legacy event insert or provider read and checks it again under a shared
row lock before billing mutations. Activation takes an exclusive lock on the same
row. Provider reads already in flight need not drain: they cannot subsequently
mutate billing if activation committed first.

The administrative activation script defaults to dry-run. `--apply` irreversibly
sets generation 2 and captures a 24-hour safety boundary in one transaction. There
is no disable command. This task executes it only against isolated local schemas.

After activation, rollback may target this precursor, which quarantines billing
with generic HTTP 503. Neither be5b8f8 nor ffa90f8 is a valid rollback after cutover.
No migration down is required. M0 and all newer additive storage must remain.
