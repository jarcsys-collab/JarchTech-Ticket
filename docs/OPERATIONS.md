# Operating JarcTech Ticket

How the official deployment is set up, how to back it up and roll it back, and what risks remain. This is a working
guide, not a formal security audit or a guarantee.

**Official URL:** https://jarctech-ticket-production.up.railway.app
(https://jarcsys-collab.github.io/JarchTech-Ticket/ redirects there.)

## Deployment

| Item | Value |
| --- | --- |
| Service | Railway project `JarcTech-Ticket`, service `JarcTech-Ticket`, environment `production`, one instance |
| Deploys | Automatically from `main` on GitHub |
| Start and health check | `npm start` (Railway's default for this app). Health check `/readyz`, 60-second window, and restart on failure are set in the Railway service settings. `railway.json` repeats them, but Railway stops reading it on 2026-12-01 |
| Database | MongoDB Atlas, database `jarctech_ticket_staging` |
| Sign-in | Microsoft Entra ID, the existing app registration; member accounts of the company tenant only |

The database keeps its historic name. "staging" in the name has no effect, and renaming it would add risk for no benefit.

### Variables

| Variable | Official value | Notes |
| --- | --- | --- |
| `AUTH_MODE` | `entra` | Required when deployed |
| `ACCESS_POLICY` | `tenant-members` | New company members become Requestors at first sign-in |
| `BETA_SIMULATION`, `INSPECTION_MODE` | `disabled` | **The server refuses to start with either enabled when deployed**, or with an `APP_BASE_URL` that is not localhost |
| `ENTRA_*`, `SESSION_SECRET`, `MONGODB_URI`, `MONGODB_DB_NAME`, `APP_BASE_URL`, `NODE_ENV` | unchanged | Secrets are kept in Railway only |
| `ATTACHMENT_QUOTA_MB` | not set (200) | Optional. Total attachment storage |
| `EMAIL_DELIVERY` | not set (off) | Optional. Reminder email through Resend; needs `EMAIL_FROM` and `RESEND_API_KEY` |

Teams and calendar integrations do not exist. A meeting's location is plain text, and the screens say that no invitation is sent.

## Data inventory

Everything lives in one database. Real and beta data are in separate collections, and the official app has no route to the beta ones.

| Purpose | Collections |
| --- | --- |
| Accounts and audit | `users`, `sessions`, `events` |
| Real work | `tickets`, `ticket_changes`, `attachments`, `notifications`, `files.files`, `files.chunks` |
| Scheduling and email | `scheduler_locks`, `email_outbox` |
| Beta records, **preserved and unused** | `beta_tickets`, `beta_changes`, `beta_attachments`, `beta_notifications`, `beta_files.files`, `beta_files.chunks` |

`npm run db:official-release -- --confirm-db <name> --verify` recomputes content fingerprints of the beta collections and
compares them with those recorded at release. `npm run beta:seed` refuses to run on this database after the release.

## Commands

All of them need the database settings in the environment and the database named exactly with `--confirm-db`.
On the owner's machine: `$env:JARCTECH_ENV_FILE='.env.staging'` (PowerShell), which is ignored by Git. They print no secrets.

| Command | Purpose |
| --- | --- |
| `npm run db:backup -- --confirm-db <name> --out <new-folder>` | Reads only. Full logical backup, checked after writing |
| `npm run db:backup -- --verify <folder>` | Checks a backup against its manifest, without a database |
| `npm run db:restore -- --confirm-db <name> --from <folder>` | Restores into an empty database, and checks the result |
| `npm run db:restore -- --confirm-db <name> --from <folder> --replace` | Replaces the backup's collections with its contents |
| `npm run db:official-release -- --confirm-db <name> [--verify]` | Records the release; adds only missing collections and indexes; changes no record |
| `npm run db:setup -- --confirm-db <name>` | Creates missing collections and indexes. A *changed* validator needs more rights than the app's database user has |
| `npm run admin:bootstrap -- ...` | First Admin only; refuses once an active Admin exists |

### Backups

**The capability confirmed so far is the logical backup above.** It covers all collections, including attachment files, except sign-in
sessions (people simply sign in again). It needs no extra tools or paid plan, and its restore is tested in `tests/official.test.cjs`.
Backup folders hold real account data: keep them private, and outside the repository (the command refuses a folder inside it).

Atlas's own backups could not be confirmed from here, because no Atlas access is available. Free (M0) clusters have no cloud backups.
Run `db:backup` before every migration and on a regular schedule; nothing schedules it automatically yet.

### Restoring

1. Check the backup: `npm run db:backup -- --verify <folder>`.
2. Best first step: restore into a new empty database and inspect it. Point `MONGODB_DB_NAME` at it for the command only.
3. To restore in place, first take a new backup of the current state, then run `db:restore ... --replace`. Validators and indexes stay;
   records created after the backup are lost.

## Rollback

| Situation | Action | Data |
| --- | --- | --- |
| A new release fails its health check | Railway keeps the previous deployment running; nothing to do | None |
| A release misbehaves | Railway dashboard: redeploy the previous deployment; or revert the merge on `main` | None: no schema or record was changed by the official release |
| Back to the beta build | Redeploy commit `73970ed`, then set `BETA_SIMULATION` and `INSPECTION_MODE` to `enabled`. The official build refuses to start with them on, so change the code first | Beta records are intact. Real records stay and are ignored by the beta views |
| Data is damaged | Restore from a backup (above) | Records since the backup are lost |

The `release.official` audit event is only a marker. Earlier versions ignore it.

## Checks and limits in the running app

- **Readiness:** `/readyz` checks the database and the required collections. `/healthz` is only "the process is up".
- **Sessions:** cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`; 8-hour idle and 24-hour absolute limits. Only hashes are stored.
- **Cross-site protection:** every change requires the app's own `Origin`, and JSON or a declared upload.
- **Headers:** CSP with no inline script except the nonce-marked session, frame denial, nosniff, HSTS.
- **Rate limits** (one instance, in memory, reset on restart): 180 changes and 1,200 reads a minute per account; 60 uploads per 10 minutes per account; 60 sign-in attempts a minute per address. Exceeding one answers 429 and changes nothing.
- **Attachments:** PNG, JPEG, GIF, WebP, PDF, TXT, LOG, CSV, DOCX, XLSX, PPTX; 10 MB each; 5 per submission; 20 unsubmitted per person; 200 MB in total. Content is checked against the type; files always download, never open in the app. Unsubmitted uploads are removed after 24 hours by the scheduler.
- **Reminders:** every 5 minutes, one instance at a time through a database lease. Each run reads current state, so a restart or missed run catches up, and unique keys prevent duplicates.

## Finding interrupted work

A deletion that stopped part-way leaves a request with a `deleting` field: it is hidden from everyone and finished by the next scheduler run (5 minutes). The log says "finished N interrupted deletion(s)". Audit entries are `events` documents of type `request.deleted`, `request.archived`, and `request.restored`.

## Material remaining risks

1. **No confirmed automatic backup.** See above. A database loss could lose everything since the last manual `db:backup`.
2. **Storage plan unconfirmed.** The Atlas plan could not be read from here. If it is the free M0 tier, its 512 MB is shared by data, indexes, and files (real 200 MB limit, plus up to 200 MB of beta files allowed, of which about 2 MB is used), and it has connection and throughput limits unsuited to heavy use. The Users screen shows storage in use. Review before relying on attachments at volume.
3. **Attachments are not scanned for malware.** Types and content are checked, and they download rather than open, but a harmful document can still be uploaded. People should treat them as they would email attachments. CSV files can contain spreadsheet formulas.
4. **A scope change and its request are two saves, made recoverable rather than transactional.** An approved, released, or closed change is saved with a `pendingEffect` describing what it does to the request, and the request records the effect's key in the same write that applies it, so it applies exactly once. If the process stops in between, the effect is finished before the next action on that request or its changes, and within one scheduler run (5 minutes, also after a restart) otherwise. It cannot be used to bypass approval, the agreement lock, confirmations, or closure. Until then the request may briefly *show* its earlier agreement. To inspect: find `ticket_changes` documents with a `pendingEffect`; the log says "finished N interrupted scope change update(s)". A new change that stops before its note reaches the request has no rule attached: it appears on the request and holds up closure until an Admin rejects it. In-app notifications are sent after a save, and one lost in a crash is not resent.
5. **Rate limits are per instance and in memory.** They stop runaway clients and casual abuse, not a determined attacker. Adding a second instance needs a shared store, and would also multiply the limits.
6. **Scale.** The dashboard loads every record the person may see. This suits the current size (hundreds of requests), but thousands would need paging there too.
7. **Sign-in identity.** Roles bind to the Entra object ID, but the first sign-in links an invitation or a conflict check by email address. This relies on the tenant administrators controlling those addresses.
8. **Database network access.** See the checklist below; a list open to all addresses means the password is the only barrier.
9. **The audit log records account changes and request activity, but is not tamper-proof:** anyone with database access could alter it.
10. **The repository is public.** No secrets or account data are stored in it (history checked at release), but the code and its workflow are visible.

## External setup to review

These need portal access that this work did not have.

- [ ] **Atlas:** confirm the plan, its storage limit, and whether cloud backups exist. Upgrade if real use needs backups or more storage.
- [ ] **Atlas network access:** the app's Railway service has no fixed outbound address on its current plan, so the list is probably open to all addresses. Confirm, and restrict it if static outbound addresses become available.
- [ ] **Atlas database user:** the app has `readWrite` on this database only, which is good. Consider rotating the password (it is also in the owner's ignored local `.env.staging`), and update Railway when you do.
- [ ] **Entra:** note the client secret's expiry date. Sign-in stops working when it expires.
- [ ] **Railway after 2026-12-01:** [Railway stops reading `railway.json`](https://docs.railway.com/infrastructure-as-code) then. The health check and restart policy are in the service settings, and `npm start` is the default, so deployment keeps working; delete the file, or move to `.railway/railway.ts` with `railway config migrate` if you want settings in code. Railway checks `/readyz` only during a deployment, not afterwards, so an outage later needs outside monitoring to be noticed.
- [ ] **GitHub:** `main` has no branch protection. Consider requiring the `check` job, since `main` deploys automatically.

## Admin onboarding

1. Sign in at the official URL with your company Microsoft account.
2. Ask a colleague to sign in once. They appear under **Users** as a Requestor. Their account does not exist before that.
3. Give IT staff the **Developer** role under **Users**. Confirm the change; it applies at once.
4. Make a second **Admin**. The last active Admin cannot be removed, and a Developer's self-requested work needs an Admin to review it.
5. New requests appear in **Needs your action**. Review each, set a priority, and assign an active Developer or yourself.
6. Follow the next step shown on each request. Close it only after both confirmations (Projects also need the handover). On your own self-assigned request, you take each step yourself.
   Use **Archive** to clear finished requests from the active lists; **Delete permanently** is for records that must not be kept, and only a backup can bring one back.
7. When someone leaves, turn their access off under **Users**, then reassign their open work. An Admin other than the worker confirms for a disabled Requestor.
