export type AuthValue = string | number | null;
export interface AuthResult { meta: { changes: number } }
export interface AuthStatement {
  bind(...values: AuthValue[]): AuthStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<AuthResult>;
  all<T>(): Promise<{ results: T[] }>;
}
/** D1-compatible operations. Every batch must commit together or roll back completely. */
export interface AuthDatabase {
  prepare(sql: string): AuthStatement;
  batch(statements: AuthStatement[]): Promise<AuthResult[]>;
}

/** Additive account tables; no migration of anonymous analytical ownership occurs here. */
export const AUTH_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lab_accounts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, user_handle TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lab_passkeys (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES lab_accounts(id),
    public_key TEXT NOT NULL, counter INTEGER NOT NULL CHECK(counter>=0),
    device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
    backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)), transports TEXT NOT NULL,
    rp_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS lab_passkeys_account ON lab_passkeys(account_id)',
  `CREATE TABLE IF NOT EXISTS lab_auth_sessions (
    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES lab_accounts(id),
    origin TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    ceremony_hash TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS lab_auth_sessions_expiry ON lab_auth_sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS lab_auth_sessions_ceremony ON lab_auth_sessions(ceremony_hash)',
  `CREATE TABLE IF NOT EXISTS lab_auth_ceremonies (
    token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('registration','authentication','add-key')),
    challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL,
    account_id TEXT, user_handle TEXT, display_name TEXT, expires_at INTEGER NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)), session_token_hash TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS lab_auth_ceremonies_expiry ON lab_auth_ceremonies(expires_at)',
  `CREATE TABLE IF NOT EXISTS lab_auth_limits (
    key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS lab_auth_limits_expiry ON lab_auth_limits(expires_at)',
];

/** Existing account databases need additive columns before indexes are created. */
export const AUTH_COLUMN_MIGRATIONS = [
  { table: 'lab_auth_ceremonies', column: 'claimed', sql: 'ALTER TABLE lab_auth_ceremonies ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1))' },
  { table: 'lab_auth_ceremonies', column: 'session_token_hash', sql: 'ALTER TABLE lab_auth_ceremonies ADD COLUMN session_token_hash TEXT' },
  { table: 'lab_auth_sessions', column: 'ceremony_hash', sql: 'ALTER TABLE lab_auth_sessions ADD COLUMN ceremony_hash TEXT' },
] as const;
