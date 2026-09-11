CREATE TABLE IF NOT EXISTS lab_integration_tokens (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES lab_accounts(id),
    token_hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, label TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('read','write')), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), last_used_at INTEGER
  );
CREATE INDEX IF NOT EXISTS lab_integration_tokens_account ON lab_integration_tokens(account_id,expires_at);
