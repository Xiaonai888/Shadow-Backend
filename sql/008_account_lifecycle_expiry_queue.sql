BEGIN;

CREATE OR REPLACE VIEW shadow_account_lifecycle.expired_accounts_queue AS
SELECT d.id, d.user_id, d.deleted_at, d.recover_until
FROM shadow_account_lifecycle.deletion_records d
WHERE d.restored_at IS NULL
  AND d.recover_until <= statement_timestamp();

REVOKE ALL ON shadow_account_lifecycle.expired_accounts_queue FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
