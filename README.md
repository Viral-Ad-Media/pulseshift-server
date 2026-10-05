# PulseShift API

Express API for healthcare date-only staffing requests, private leave notes, administrator decisions, workspace invitations and advisory Gemini responses. The companion frontend is `Viral-Ad-Media/pulseshift`.

## Setup

Use the Node version in `.nvmrc` (22.22.2) or supported Node 24.15+. Run `npm ci`, copy `.env.example` to `.env`, and configure Supabase URL and service-role key. Generate a unique JWT secret with `openssl rand -hex 32`; default, short, repetitive and example secrets are rejected in every environment. Restrict `CORS_ORIGIN` to your frontend URLs.

For a new Supabase project, run `supabase/schema.sql` and then `supabase/migrations/20261005_audit.sql` in the SQL editor. Run `npm start` or `npm run dev`. No accounts or demo data are seeded automatically. Startup fails if the migration is missing. `/health` is liveness and `/ready` checks database schema availability.

The service-role key stays on the server. All app JWTs carry issuer, audience and a per-user session version, and all tenant routes check membership. Logout revokes existing sessions for that user. The historical seed IDs (`u-admin`, `u-jake`, `u-sergio`, `u-cgomez`, `u-devon`) cannot log in. Existing legitimate users keep their current password hashes, but old JWTs no longer authenticate.

## Upgrading an existing deployment

1. Back up the database and pause API writes during the coordinated upgrade.
2. Check for invalid legacy dates before applying the migration. `select id,date from public.requests order by date;` provides the values; the migration aborts on impossible or noncanonical dates so they can be corrected deliberately. It does not silently move a request to a different day.
3. Run `supabase/migrations/20261005_audit.sql` once against the existing schema. It is safe to rerun. It adds versions, cancellation timestamps, invitations, event history and service-only transaction functions, and converts legacy trial end dates to an inclusive UTC end-of-day timestamp.
4. Configure a newly generated JWT secret and explicit frontend CORS URLs. Deploy this API and the companion frontend together: edits/cancellation now require request versions, and AI response drafting uses `requestId`. Old clients will receive 400 on versionless writes.
5. Sign in again, test invite acceptance, a request/decision/cancellation, and `/ready`. Review existing demo data separately; the upgrade blocks known seeded logins but does not delete organizations or their history.

Do not run the migration against an unidentified project. Every `pulse_*` function revokes EXECUTE from PUBLIC, anon and authenticated and grants it only to service_role. RLS remains enabled on every data table, with no browser policies. App-managed JWTs do not directly authenticate to Supabase.

## Transaction and entitlement policy

- Signup creates the account, workspace/membership or invitation acceptance in one transaction, using full UUIDs. Failures roll back all writes without compensating deletes.
- Request creation locks the organization and checks capacity before insert. One active request per person/date is enforced in Postgres. Decisions and edits lock and compare the current version; only owners may edit pending details and only admins may decide. Stale edits return 409.
- Cancellation retains the record and an event, removes it from active schedules, and frees an active request slot. Approval/edit/cancellation events retain actor, timestamp, type and decision; private medical note text is not copied into events.
- Plan request limits (40/120/500) are **active retained-request capacities**, not monthly throughput. Canceled rows do not count; rejected rows count until dismissed. No automatic billing-period reset is advertised.
- New Team trials last exactly fourteen days. At expiration the effective plan becomes Essentials (40 active requests, no AI); historical requests remain visible and existing over-capacity workspaces may cancel/decide requests but cannot create more until below capacity. Existing non-trial plans retain their configured allowance.
- AI credits (0/80/200) are lifetime workspace allowances until explicitly replenished by an administrator through the billing integration when one exists. Every provider attempt reserves one credit atomically before work and retains a usage event. Failed or malformed provider attempts also consume that reserved credit. Missing provider configuration does not consume credits. Fallbacks explicitly state that no availability check happened. AI is advisory and cannot approve requests.

## Teams

Admins can create a seven-day, single-use, email-bound invitation. The API returns the plaintext token only on creation and stores its SHA-256 hash. Active invitations reserve seats; expired/revoked ones do not. New accounts can include `inviteToken` at signup; existing signed-in users can accept via `POST /invitations/accept`. Users must use the invited email. Admins can revoke invitations, change roles and remove members, but cannot remove/demote the last administrator. Seat usage is derived from memberships. Invitation links are shared manually; there is no email delivery provider.

## Routes

- `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /me`
- `GET /orgs/:orgId/full`, `GET /orgs/:orgId/requests`
- `POST /orgs/:orgId/requests` (date, type, optional notes)
- `PUT /orgs/:orgId/requests/:id` (version; owner details or admin decision)
- `DELETE /orgs/:orgId/requests/:id` (JSON body containing version)
- `GET/POST /orgs/:orgId/invitations`, `DELETE /orgs/:orgId/invitations/:id`
- `POST /invitations/accept` (token)
- `PUT/DELETE /orgs/:orgId/members/:userId`
- `POST /ai/analyze` (orgId, date, type), `POST /ai/respond` (orgId, requestId, decision)

Schedule endpoints redact coworkers' private notes and administrator replies for non-admin users. Owners and admins retain those fields.

## Verification and operations

`npm run check`, `npm test`, `npm audit --audit-level=low`. Tests execute migrations and transaction functions against embedded PostgreSQL (PGlite) and run actual Express HTTP requests for authorization, privacy, signup and invitations. PGlite has one connection; concurrent-call tests do not substitute for a multi-connection staging load test. CI runs these checks on every pull request.

Async bcrypt and bounded per-IP/per-account auth rate limits protect the event loop. In a replicated deployment, add a shared ingress rate limiter; the local limits are per API process. Trust proxy headers only after configuring the verified `TRUST_PROXY_HOPS` count; the default trusts no proxy. AI has a bounded provider timeout and the frontend request timeout is thirty seconds.

Password recovery, email notifications, real billing/payment collection and SSO are not integrated. Plan changes remain an explicit sales workflow. Database backups, retention policy and external provider availability remain deployment responsibilities.
