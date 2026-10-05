# October 2026 audit remediation

The coordinated frontend and API changes address all 18 findings from the review.

| Finding | Resolution |
| --- | --- |
| Production demo accounts | Removed auto-seeding; blocked historical seed IDs at login; removed demo frontend credentials |
| Predictable JWT secrets | Required random secret in every environment; issuer/audience/algorithm/version validation |
| Authentication CPU abuse | Async bcrypt, bounded inputs and IP/account throttles |
| Coworker private notes | API projects private fields only for owner/admin |
| AI credit race | Transactional reservation before provider attempt and persistent attempt ledger |
| Request quota race | Organization lock and insert in one transaction |
| Approved-request stale edits | Current pending status and expected version enforced while locked |
| Signup collision/rollback | Full UUIDs and atomic signup; no cleanup deletes |
| Expired trial privileges | Exact trial expiry and Essentials effective entitlements |
| Missing staff onboarding | Email-bound invites, acceptance, roles, removals, seats and frontend Team modal |
| Invented dispatch times | Date-only approved availability with explicit absence of start/end times |
| Impossible dates | Strict API validation plus Postgres check constraint |
| Stale AI cache counters | In-flight deduplication only; session scoping and monotonic UI counters |
| Lost local saves/drafts | Functional version-aware merges, busy guards and retained failed drafts |
| Wrong shift opened | Pass clicked request identity and show coworker details |
| Leave counted as staffing | Work-only Scheduled Today metric |
| Node engine mismatch | Supported Node versions and locked dependencies aligned; CI |
| Runtime Tailwind compiler | Locally compiled Tailwind 4 CSS via Vite |

Additional changes: dependency security updates, retained cancellation/audit history, schema readiness, honest AI fallback, workspace-local Today dates, accessible dialogs and deployment instructions. Apply the SQL migration and deploy the paired frontend as described in README.md.
