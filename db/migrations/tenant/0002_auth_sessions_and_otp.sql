-- Sign-in sessions and one-time codes (P0-7). user_id gets its foreign key to users when the
-- identity module creates that table (P1-5).

-- One row per signed-in device. Only hashes of refresh tokens are stored; the previous hash is
-- kept to detect a rotated-away token being used again (theft), which revokes the session.
create table auth_sessions (
  id                          uuid primary key,
  user_id                     uuid not null,
  refresh_token_hash          text not null unique,
  previous_refresh_token_hash text,
  created_at                  timestamptz not null,
  last_rotated_at             timestamptz not null,
  expires_at                  timestamptz not null,
  revoked_at                  timestamptz,
  revocation_reason           text
                              check (revocation_reason in ('logout', 'refresh_token_reuse',
                                                           'password_changed', 'user_disabled',
                                                           'admin_revoked')),
  user_agent                  text,
  ip                          inet,
  check ((revoked_at is null) = (revocation_reason is null)),
  check (expires_at > created_at)
);

-- "Sign out everywhere" and the active-sessions list of a user.
create index auth_sessions_user_active_idx on auth_sessions (user_id) where revoked_at is null;
-- Retention clean-up of expired sessions.
create index auth_sessions_expires_idx on auth_sessions (expires_at);

-- Issued one-time codes, stored as keyed hashes. Attempts are counted per challenge.
create table otp_challenges (
  id             uuid primary key,
  subject        text not null check (length(subject) between 1 and 320),
  purpose        text not null
                 check (purpose in ('email_verification', 'phone_verification', 'password_reset',
                                    'login_verification', 'document_signing',
                                    'billing_extension')),
  code_hash      text not null,
  attempts       integer not null default 0 check (attempts >= 0),
  max_attempts   integer not null check (max_attempts > 0),
  created_at     timestamptz not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  invalidated_at timestamptz,
  check (expires_at > created_at),
  check (consumed_at is null or invalidated_at is null)
);

-- Lookup of the open challenge for a subject and purpose (newest first).
create index otp_challenges_open_idx on otp_challenges (subject, purpose, created_at desc)
  where consumed_at is null and invalidated_at is null;
create index otp_challenges_expires_idx on otp_challenges (expires_at);
