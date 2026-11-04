# PulseShift API — Neon PostgreSQL + Better Auth

Express API for date-only healthcare staffing requests, private leave notes, approvals, workspaces, invitations and advisory AI. Companion frontend: `Viral-Ad-Media/pulseshift`. Supabase is no longer a runtime dependency.

## Architecture

- Neon PostgreSQL through the `pg` driver with a bounded connection pool and verified TLS.
- Self-hosted Better Auth 1.7.16 on the existing API host. User, credential, verification and session rows live in the same Neon database.
- Better Auth bearer sessions support the existing SPA/API deployment on separate Render domains. Tokens are opaque, revocable database sessions; the old custom JWT implementation is removed. Native Better Auth endpoints are mounted at `/api/auth/*` and preserve origin checks and bounded request bodies.
- Existing workspace authorization remains independent of auth-provider roles: each protected tenant operation checks current application memberships. Only owners/admins receive private note fields.
- PostgreSQL transaction functions retain quota locks, expected-version decisions, seat reservations, trial expiry and AI credit accounting.

Self-hosted Better Auth is used because credential migration requires a custom bcrypt verifier and the app has custom workspace creation/recovery flows. Managed Neon Auth is not required or enabled.

## Local setup

Use Node 22.22.2 from `.nvmrc` or supported Node 24.15+. Run `npm ci`, copy `.env.example` to `.env`, and fill in:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled PostgreSQL URL for request traffic |
| `DATABASE_URL_UNPOOLED` | Direct Neon URL for migrations/imports |
| `BETTER_AUTH_SECRET` | Unique random secret of at least 32 characters; generate with `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Public API origin, e.g. `https://pulseshift-server.onrender.com`; do not append `/api/auth` |
| `CORS_ORIGIN` | Comma-separated approved frontend origins |
| `PORT` | Listener port; Render supplies this |
| `GEMINI_API_KEY` | Optional; absence produces an explicit uncharged fallback |
| `TRUST_PROXY_HOPS` | Optional, verified proxy-hop count; unset trusts no forwarded IPs |

Run `npm run db:migrate` using the direct URL. Then `npm run dev` or `npm start`. Production requires explicit HTTPS `BETTER_AUTH_URL` and frontend origins. Never put database passwords or auth secrets in a VITE variable or source control.

## Render rollout

1. Create a dedicated Neon project/database for PulseShift; avoid sharing another application's database. A Vercel-managed Neon organization may require project creation from Vercel's Storage integration instead of Neon's project API.
2. Set the database URLs, a freshly generated `BETTER_AUTH_SECRET`, public `BETTER_AUTH_URL` and actual frontend `CORS_ORIGIN` in the existing Render API service. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `JWT_SECRET` are no longer used.
3. Apply `npm run db:migrate` with the direct URL. The runner holds a PostgreSQL advisory lock, tracks file checksums and commits each file and its history record atomically. It is safe to run again. The free Render service cannot use a pre-deploy command, so run this as a release task from a trusted workstation or CI with encrypted secrets. Paid services may use a pre-deploy release task.
4. Use build command `npm ci` and start command `npm start`. Set the HTTP health-check path to `/ready`.
5. Deploy the companion frontend with `VITE_API_URL` pointing to this API. Both repository branches must be released together for resumable setup and account password changes.
6. Verify sign-up, login, invitation acceptance, page reload, a protected request and logout. `/health` is process liveness; `/ready` verifies schema availability.

A new deploy must be triggered after environment changes. No production credentials are written by this repository. Old JWTs do not carry over; users sign in again. No destructive project or database deletion is required.

## Existing data migration

If a prior PulseShift database contains real data, pause application writes and back it up. Keep the source available until the Neon cutover is verified. The `db:import-legacy` script can read the previous PostgreSQL database, including a Supabase-hosted one, without the Supabase client or service-role API key:

1. Migrate an empty dedicated Neon target using `npm run db:migrate`.
2. Provide the source direct PostgreSQL connection as `SOURCE_DATABASE_URL`, target direct URL as `DATABASE_URL_UNPOOLED`, and set `IMPORT_LEGACY_DATA=yes` in a private environment.
3. Run `npm run db:import-legacy` once. The source transaction is read-only and repeatable-read. The destination must be empty. Inserts are one transaction and fail rather than overwrite data. Counts are printed; credentials and user data are not.
4. The script copies application users, organizations, memberships, requests, invitations and events, preserving IDs and ownership. It imports real users' bcrypt credentials into Better Auth. Known demo IDs are intentionally excluded from auth. Existing passwords continue to work, including passwords shorter than the new signup minimum. New passwords use Better Auth's scrypt hasher. Re-running credential import never replaces a changed password.
5. Verify counts, role assignments, requests and a representative login before pointing production traffic to Neon. Old sessions are not imported.

If data was restored with PostgreSQL tools before `db:migrate`, the auth migration imports those existing users directly. No data has been exported or imported merely by applying this repository change. Legacy `password_hash` values remain in the private application table for retention; they are not read by runtime login after the credential import.

## Account and workspace lifecycle

Compatibility routes `/auth/signup`, `/auth/login`, `/auth/logout` and `/me` delegate identity/session work to Better Auth. Native endpoints provide standard Better Auth session and password APIs. Logout revokes all database sessions for that user. Cookie caching is disabled so revocation is checked against the database immediately.

Identity registration and workspace setup are intentionally two phases. The identity is never deleted to compensate for a workspace failure. The atomic `pulse_provision_workspace` transaction locks that identity, creates the application membership and workspace or accepts an invitation, and prevents duplicate workspaces on retry. If an invite is invalid or a setup write fails, the SPA retains the signed-in account and shows a resumable setup form. Native Better Auth signup also reaches that form after sign-in. Existing accounts with memberships do not need setup.

The Account dialog changes a password with the current password and signs out other sessions. Password reset email delivery, email verification delivery, social OAuth, SSO and payment collection are not configured by this migration. These should be enabled only with the required provider settings and user-facing flows.

## Plans, requests and invitations

Limits are active retained-request capacities (40/120/500) and lifetime AI allowances (0/80/200), not monthly throughput. New trials last fourteen days then use Essentials entitlements. Cancellation retains history and frees an active slot. Each provider attempt atomically reserves one credit, including failed/malformed attempts; no provider configuration means no charge. AI is advisory and cannot approve a request.

Seven-day email-bound invitations reserve seats. They are manually shared, single-use and stored as hashes. Role changes and membership removal cannot leave a workspace without an administrator. Owner edits and admin decisions require the current request version; conflicts return 409.

## Checks

`npm run check`, `npm test`, `npm audit --audit-level=low`. Tests use the real Better Auth server and PostgreSQL SQL engine (PGlite), exercising legacy passwords/IDs, sessions, revocation, password changes, privacy, permissions, invitations, resumable setup, quota races, migrations and read-only import. PGlite is single-connection; production multi-connection load testing remains a staging check. CI runs these checks on every PR.

Auth limits use bounded per-process memory and Express-derived IPs. For multiple replicas, enforce shared limits at the ingress as well. Do not trust user-supplied forwarded IPs without verifying the hosting topology.
