# PulseShift API — Neon PostgreSQL + Better Auth

Express API for timed healthcare staff schedules, availability and leave requests, staffing checks, in-app notifications, private notes, workspaces, invitations and advisory AI. Companion frontend: `Viral-Ad-Media/pulseshift`. Supabase is no longer a runtime dependency.

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


## Timed scheduling release

Apply migrations with `npm run db:migrate` before starting the updated API, then deploy the matching frontend. `20261111_scheduling.sql` adds schedule documents, idempotent operations, assignment acknowledgements and notifications. It does not convert historical WORK availability requests into assignments. No production data or remote deployment is changed by editing this repository.

Managers use `GET/POST /orgs/:orgId/schedule` to manage a revisioned draft containing shifts, per-member eligible roles/limits and weekly templates. Staff receive only published shifts and their own scheduling profile/acknowledgements. Supported actions are SAVE_SHIFT, DELETE_SHIFT, DISCARD, SAVE_PROFILE, SAVE_TEMPLATE, DELETE_TEMPLATE, APPLY_TEMPLATE and PUBLISH. Mutations require a workspace revision and a stable operationId; retry the identical envelope after an uncertain transport failure. A confirmed 409 requires refresh and a new operation.

Each shift has a required role/count, department, location, local start/end, resolved UTC instants, staff assignments, per-person break intervals and an acknowledgement requirement. Drafts can contain conflicts; publishing revalidates current membership, role eligibility, approved leave, overlapping assignments, minimum rest and Monday–Sunday working-hour caps. Actual elapsed time and breaks are counted across local week boundaries and DST changes. Missing/ambiguous local clock times are rejected. A manager must explicitly set allowGaps to publish understaffed intervals. Other conflicts cannot be overridden. Eligibility is manager-maintained; no independent credential verification is claimed. Rest/hour settings are organizational rules, not a statutory compliance engine.

Short transactions use a PostgreSQL advisory transaction lock before organization row locks for schedule, acknowledgement and HTTP request mutations. This serializes shared-worker checks across workspaces; it prioritizes correctness for small-team pilots. Approved leave is additionally guarded by a database trigger against published assignments, including overnight/cross-workspace conflicts. Membership removal through the API is blocked while the member has upcoming published assignments. Rules configured in another workspace are checked without returning that workspace's shift details.

`POST /orgs/:orgId/schedule/:shiftId/acknowledge` requires the current publicationVersion and an assignment to the authenticated user. Editing an assignment does not change its published snapshot; publishing a meaningful change creates a new acknowledgement version. Notifications are inserted transactionally with published assignment changes and request changes. Unchanged assignments do not receive duplicate notices or lose acknowledgements.

`GET /orgs/:orgId/notifications` returns the latest 100 personal items plus the total unread count. `PUT /orgs/:orgId/notifications/read` marks one personal item or the inbox read. Reminders are generated idempotently on inbox polling for assignments starting within 24 hours; there is no unattended notification worker, email, SMS or push delivery. `GET /orgs/:orgId/request-history` returns the latest 200 requests, including cancellations and their event history. Staff can access only their own request history; administrators can access their team's private history.

Limits: 1,000 retained shifts, 50 templates, up to 12 repeated weeks, 100 assignees per shift and 24 elapsed hours per shift. Storage uses a revisioned JSON document per workspace, so schedule edits serialize within the workspace. Staging verification on real PostgreSQL with multiple connections is required before broad rollout; PGlite tests verify SQL and HTTP behavior but do not substitute for a production concurrency/load test.

Release smoke check: configure eligible roles → create a draft shift → verify it is hidden from staff → publish → sign in as assigned staff → read notification → acknowledge → edit and republish → verify a new acknowledgement is needed. Also verify overnight leave rejection, conflicting edits, template repetition and private cancelled-request history.


## Workforce implementation and isolated local API

Run `npm run dev:local` for a persistent PGlite-backed local test API on `127.0.0.1:4000`. It applies the migrations to `.local-data/database`, stores its local auth secret in the ignored data directory, approves `http://localhost:3000`, and never uses the hosted DATABASE_URL. Hosted users are not copied. External email and billing credentials are ignored by this mode unless `LOCAL_EXTERNAL_SERVICES=1` is explicitly set. Keep the data directory private.

The new migrations add workforce state/operations, explicit assignment responses, private credential documents, audit history, billing state and Better Auth authenticator/challenge storage. `workforce.js` implements role-scoped, revisioned mutations under the shared scheduling transaction lock. Every client mutation has an operation ID; identical successful retries replay instead of duplicating. Credential rules are checked again on publication, replacements and swaps. Accepted assignment hours come from explicit ACCEPT responses, not from the older acknowledgement table.

Workforce data includes deterministic builder explanations, absence/extra-shift previews, controlled-round replacement invitations, colleague-consented/manager-approved swaps, actual clock events and proposed corrections, rates/policy snapshots, daily payroll estimates, scoped department tools and preview/confirm CSV imports. Fairness definitions and gross-estimate limits are returned with reports. Unknown rates/policies stay null. CSV output escapes spreadsheet formulas. Calendar output is a private bearer-authenticated ICS download, not a public token URL.

`account-security.js` wraps Better Auth's actual TOTP/backup-code flows for bearer-session deployments. A password-only sign-in of a 2FA account returns a short-lived challenge, never an authenticated token; the challenge is hashed, limited and single-use. Native auth routes still enforce the same plugin. Enrollment/disable responses propagate rotated session tokens. Recovery uses single-use Better Auth tokens and revokes other sessions.

Provider activation is separate from local implementation. Set FRONTEND_URL, RESEND_API_KEY and MAIL_FROM with a verified sender to activate password reset. Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the two allowed price IDs to activate checkout/portal. Stripe webhooks use the raw request body, a five-minute HMAC timestamp window, event deduplication and current subscription retrieval. A checkout redirect alone never grants a paid plan. Subscribe to customer.subscription.created/updated/deleted. No independent credential verification provider is currently connected; uploaded and manager-reviewed records are explicitly distinguished.

Capacity and concurrency remain appropriate for small-team pilots: revisioned JSON workspace documents serialize writes, private uploads are limited to 3 MB, imports to 200 rows, and workforce records have explicit caps. Before production rollout, verify real PostgreSQL concurrent claims/edits, restore procedures and load limits in staging. The automated PGlite/HTTP tests verify application behavior but are not a production load test.
