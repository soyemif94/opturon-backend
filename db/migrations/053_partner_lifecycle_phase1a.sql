DO $$
DECLARE
  current_constraint_name TEXT;
BEGIN
  SELECT con.conname
    INTO current_constraint_name
  FROM pg_constraint con
  INNER JOIN pg_class rel
    ON rel.oid = con.conrelid
  INNER JOIN pg_namespace nsp
    ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'partner_accounts'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  ORDER BY con.conname
  LIMIT 1;

  IF current_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.partner_accounts DROP CONSTRAINT %I', current_constraint_name);
  END IF;
END $$;

ALTER TABLE partner_accounts
  ADD CONSTRAINT partner_accounts_status_check
  CHECK (status IN ('invited', 'active', 'suspended', 'disabled', 'invitation_canceled'));
