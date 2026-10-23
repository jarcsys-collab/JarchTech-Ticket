# Authentication design: Microsoft Entra ID

Status: **implemented on `feature/entra-auth`** and tested with a mock Entra provider and a temporary MongoDB only. No Entra application has been created or changed, no real credentials are configured, and nothing has been written to Atlas. Browser records and recovery safeguards are unchanged. Configuration and commands are in README, "Microsoft Entra sign-in".

**Decided (2026-10-22):**
- single company tenant; guests excluded
- invite-only access as the default and the restorable policy; **beta access policy `tenant-members` (decided 2026-10-22)**: every member account of the configured JARC GROUP tenant may sign in without an Entra assignment or app invitation, and new users start as Requestor (see "Beta access policy" below)
- roles managed by JarcTech Admins in the app
- `openid-client`
- Requestor name pre-filled from the profile, with ownership from the server session (enforced when the ticket API exists)
- sessions of 8 hours idle and 24 hours maximum
- development base URL `http://localhost:4177`

**Still open:** the first Admin's work email (asked when real configuration starts); production app registration and credential type.

## Beta inspection mode (`INSPECTION_MODE=enabled`)

An explicit, separately switchable beta option. Signed-in people can preview the Requestor, Admin, and Developer views on **sample data in their own browser**, under the storage prefix `jarc-inspection:`.
- **No effect on authorization:** the session, the server role, `/api/v1/me`, and every server permission stay exactly as they are.
- **Only a display hint is sent:** the server sends `inspection.js` and an `inspection: true` hint only when the option is enabled.
- **Limited scope:** the switch affects only the browser-only prototype screens. Real user management is hidden while inspecting, and the admin API keeps refusing non-Admins.
- **Off by default:** `INSPECTION_MODE` is `disabled` unless set, and it is rejected in demo mode.

## Beta access policy (`ACCESS_POLICY=tenant-members`)

**Purpose:** let the whole company try JarcTech Ticket during the beta without an Admin inviting each person. It is an explicit setting: with `ACCESS_POLICY` unset (or `invite-only`), the invite-only rules below apply unchanged.

| Situation at sign-in | Result |
| --- | --- |
| Member of the configured tenant, no JarcTech account yet | Account created automatically as **Requestor** (status `active`, `autoAdmitted: true`), linked to the Entra object ID, and a `user.auto-admitted` event recorded |
| Account already linked to this Entra object ID | Signs in with its existing role and status. A role set by an Admin is never reset. |
| Pending invitation for this email | Bound exactly as in invite-only mode, **keeping the invited role** (this is how someone starts as Developer or Admin) |
| A record for this email is disabled (including a revoked invitation) | **Refused** ("turned off"); no replacement account is created |
| This email is already linked to a different Entra account | **Refused** (`account-conflict`) for an Admin to resolve |
| No usable email or UPN in the token | Refused (`missing-identity`) |
| Guest (`idp` claim from another provider, or `acct=1`), personal Microsoft account (`idp` live.com, or the consumer tenant `9188040d-…`), or another tenant's `tid` | **Refused** under both policies; nothing is created |

**Unchanged in both policies:**
- **Sign-in checks:** ID token validation, PKCE, state and nonce, the single-tenant issuer, and signature checks.
- **Sessions:** server-side storage, the 8-hour idle and 24-hour absolute limits, logout, and immediate revocation for disabled users.
- **Role rules:** roles are never read from claims (`roles`, `groups`, `wids`, or anything else) or from the browser. The automatic role is a server constant, `Requestor`. Admin and Developer come only from an Admin's change or an invitation naming that role. The self-change and last-Admin protections still apply.

**Entra side:** for the beta, the enterprise application's **Assignment required = No**, so Entra lets every member through to the app, where the rules above apply. To return to invite-only, remove `ACCESS_POLICY`, restart, and optionally set Assignment required back to Yes. Auto-admitted Requestors keep their accounts until an Admin disables them.

> **Current limitation:** sign-in, roles, sessions, and user management are server-protected. **Ticket ownership and developer filtering are not production-ready.** Tickets are still stored only in each browser; the Requestor name is a display pre-fill; the Developer view uses the demo identity. This is not secure multi-user ticketing until the ticket API exists.

**Implementation notes (where it differs from or adds to the design below):**
- **Revoking invitations:** an Admin can revoke a pending invitation (status `disabled`). Restoring it returns it to `invited`; it is never `active` without a Microsoft sign-in. `admin:bootstrap --replace-invitation` replaces a mistyped first-Admin invitation, but only while no Admin is active.
- **Signature checks:** `openid-client` 6 relies on TLS for ID tokens from the token endpoint. Signature checking against the tenant's published keys is switched on explicitly (`enableNonRepudiationChecks`); a forged-signature test confirms it.
- **Demo mode:** demo is also the default when `AUTH_MODE` is unset **locally**. Entra settings without `AUTH_MODE`, or demo mode when deployed, stop the server at start-up.
- **Access requests:** there is no "request access" queue (invite-only). Denied sign-ins are recorded as `signin.denied` events.
- **Last Admin:** through the API, Admins cannot change themselves, so an active Admin always remains. The last-Admin rule is also enforced in the data layer, as a backstop for concurrent changes.
- **Users screen:** opened from a **Users** button in the header (Admins only), not from an avatar menu. The sidebar still has only Tickets and Projects.
- **Front-channel logout:** not implemented. Sign-out uses Entra's end-session endpoint.
- **Database setup:** collections and indexes are created only by `npm run db:setup`; the server checks them read-only in `/readyz` (`schema-missing`).

## Principles

1. **Company sign-in only.** Users sign in with their Microsoft Entra work account. The app never stores passwords.
2. **Signing in is not access.** A valid Microsoft sign-in only proves who someone is. To use JarcTech Ticket, the person must also be admitted: a user record with status `active` must exist in the app's database. Unknown, invited-but-unbound, or disabled users get no session and see an "access not granted" page.
3. **Roles come from the server, never from the browser.** The session stores only a user ID. The role (`Requestor`, `Admin`, or `Developer`) is read from the database on every request, so revoking or changing a role takes effect immediately. The API ignores any role, user ID, or requestor name sent by the browser. The demo role selector exists only in prototype mode.
4. **Identity is the Entra object ID, not the email address.** Users are matched on the tenant ID (`tid`) plus object ID (`oid`) claims, which never change. Email and display name are kept for display only. Microsoft advises against authorizing on `preferred_username` or `email`.
5. **Tests never contact Microsoft or Atlas.** Tests use a local mock OpenID provider and a temporary MongoDB.

## Sign-in flow

OpenID Connect authorization code flow with PKCE, with the server as a confidential client.

1. `GET /auth/login` creates random `state` and `nonce` values and a PKCE verifier. It stores them in a short-lived (10 minute) `HttpOnly` cookie signed with `SESSION_SECRET`, then redirects to Entra's authorize endpoint for **the configured tenant only**. Nothing is written to the database before sign-in, so anonymous traffic cannot fill it.
2. `GET /auth/callback` checks `state`, exchanges the code (PKCE plus the client credential), and validates the ID token:
   - signature, using the tenant's published signing keys
   - `iss`, which must be the tenant's v2.0 issuer
   - `aud`, which must be our client ID
   - `tid`, which must be the configured tenant
   - `nonce`
   - `exp` and `nbf`
3. **Admission:**
   - The server looks up the user by (`tid`, `oid`).
   - If there is no match, it looks for an admin-created **invitation** for the account's email (lowercased) within the same tenant. On first sign-in the invitation is bound to that `oid`, which becomes the permanent identity.
   - The user record must then be `active`. Otherwise the person sees "access not granted", and the attempt is recorded for admins to review. It grants no access.
4. A **new** session is created at sign-in, so an existing session ID can't be reused (session fixation). The person is then redirected into the app.
5. `POST /auth/logout` deletes the session, clears the cookie, and redirects to Entra's sign-out page.

No Microsoft Graph or other API access tokens are requested or stored. Only the `openid`, `profile` and `email` scopes are used.

## Admission rules (two gates)

| Gate | Where | Controlled by |
| --- | --- | --- |
| 1. Entra assignment | Enterprise application → Properties → **Assignment required = Yes**, with only the allowed users or a security group assigned | The company's Entra administrator |
| 2. App allowlist | `users` collection: status `invited`, then `active` (after binding); `disabled` blocks access | JarcTech Ticket Admins, in the app |

A person needs **both**. Gate 1 stops sign-in at Microsoft. Gate 2 means that even an Entra misconfiguration, such as assignment being turned off, cannot admit someone the app doesn't know.

## Users, roles, and sessions (MongoDB)

**`users`**
- Fields: `tenantId`, `entraObjectId` (empty until first sign-in), `email` (lowercase), `displayName`, `role`, `status` (`invited` / `active` / `disabled`), `invitedBy`, `createdAt`, `updatedAt`, `lastSignInAt`.
- Indexes: unique (`tenantId`, `entraObjectId`) where the object ID is set; unique `email`.
- Schema validator: role and status must be one of the allowed values.

**Role changes:** only an Admin can make them, through `PATCH /api/v1/users/:id`, and each one is written to `events` with who changed what and when.
- Admins cannot change their own role or disable themselves.
- The last active Admin cannot be demoted or disabled.
- A role is never set from a sign-in claim or a request field other than this admin action.

**`sessions`**
- Fields: the SHA-256 **hash** of the session ID (the plain ID exists only in the cookie, so a database leak doesn't expose usable sessions), `userId`, `createdAt`, `lastSeenAt`, `expiresAt`.
- A TTL index removes expired sessions.
- Proposed limits: 8 hours idle and 24 hours absolute. This is a decision for you.

**Cookie:** `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, no domain. It is named `__Host-jt_session` on HTTPS (Railway) and `jt_session` on `http://localhost`.

**Cross-site request forgery:** every state-changing request must come from the app's own origin (checked against `APP_BASE_URL`), and API writes must use JSON. This works together with `SameSite=Lax`.

## First admin

The first admin is created deliberately, not automatically: a one-time command run by the owner against the target database:

```text
npm run admin:bootstrap -- --email <work-email>
```

It creates an `invited` Admin record and refuses to run if any active Admin already exists. That person becomes active on their first Microsoft sign-in. There are no default accounts or passwords. The command reads the database settings from `.env` or the environment, like the server.

## Endpoints in this feature

| Endpoint | Access |
| --- | --- |
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Public (the flow itself) |
| `GET /api/v1/me` | Signed-in, active users: returns ID, name, email, and role |
| `GET /api/v1/users`, `POST /api/v1/users` (invite with email and role), `PATCH /api/v1/users/:id` (role or status) | Admin only |

Ticket, project, and change APIs are later steps. Until then, ticket data in signed-in mode would still be browser-local and keyed to demo names. So the UI keeps prototype mode as it is, and signed-in mode adds only the sign-in screen, the signed-in user's name, sign-out, and an Admin "Users" screen. That screen is reached from the header avatar menu, so the sidebar keeps only Tickets and Projects.

**Requestor name field:** the request form keeps its current fields. In signed-in mode, the "Requestor name" field is pre-filled from the signed-in account, and **the server sets the ticket owner from the session**, never from that field. This becomes active when the ticket API exists.

## Configuration (placeholders in `.env.example`; values in `.env` or Railway only)

| Variable | Secret? | Purpose |
| --- | --- | --- |
| `AUTH_MODE` | No | `entra` turns on sign-in. If unset, the app stays in prototype mode. |
| `ENTRA_TENANT_ID` | No (identifier) | The single allowed tenant |
| `ENTRA_CLIENT_ID` | No (identifier) | App registration's Application (client) ID |
| `ENTRA_CLIENT_SECRET` | **Yes** | Client secret value, unless a certificate is chosen |
| `APP_BASE_URL` | No | For example `http://localhost:4177`. The redirect URI is `APP_BASE_URL` + `/auth/callback`. |
| `SESSION_SECRET` | **Yes** | At least 32 random bytes, different per environment. Generated locally with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and pasted directly into `.env`. |

The server refuses to start with `AUTH_MODE=entra` if any of these is missing, a placeholder, or too short. As now, messages never show values.

## Tests (no Microsoft, no Atlas)

- A **local mock OpenID provider** inside the test process serves discovery, signing keys, and a token endpoint. It signs ID tokens with a test key generated on the fly.
- MongoDB is the temporary `mongodb-memory-server` instance, as now.
- Cases:
  - An active user signs in and gets a session, with correct cookie flags and a new session ID each time.
  - Rejected with no session created: an unknown user; an invited user from another tenant; a disabled user; the wrong `tid`, `iss` or `aud`; a bad signature; an expired token; a mismatched `state` or `nonce`; a missing PKCE verifier.
  - An invitation binds to the `oid` on first sign-in, and is never re-bound to a different `oid`.
  - The role always comes from the database:
    - A role in the query string, body, header or cookie is ignored.
    - A role change applies to the next request.
    - The self-change and last-admin rules hold.
  - Logout removes the session. Expired and idle sessions are rejected.
  - Writes from another origin are rejected.
  - Admin-only endpoints return 403 for Requestor and Developer, and 401 without a session.
  - Prototype mode (no `AUTH_MODE`) behaves exactly as today. The browser walkthrough still passes.

## Proposed library

`openid-client` (v6), a standards-based OpenID Connect client. It needs only the ID token sign-in described here; no Microsoft Graph calls are required. `@azure/msal-node`, Microsoft's own library, would also work if company policy prefers it.

## App registration settings (for the Entra administrator, later; nothing is changed now)

A **new, dedicated** registration is created, so existing Entra applications stay untouched. Separate registrations are recommended for development and for staging/production, so a developer laptop never holds the production secret.

| Setting | Development registration | Staging / production registration |
| --- | --- | --- |
| Name | `JarcTech Ticket (Dev)` | `JarcTech Ticket` |
| Supported account types | Accounts in this organizational directory only (single tenant) | Same |
| Platform | Web | Web |
| Redirect URI | `http://localhost:4177/auth/callback` (Entra allows `http` only for localhost) | `https://<railway-domain>/auth/callback` per environment |
| Front-channel logout URL | Not needed | `https://<railway-domain>/auth/logged-out` (optional) |
| Implicit grant / hybrid flows | Off (both the access token and ID token boxes unchecked) | Off |
| Credentials | A client secret with an expiry date (12 months suggested), entered only in `.env` | A client secret or certificate, entered only in Railway variables; expiry reminder set |
| API permissions | Microsoft Graph delegated `openid`, `profile`, `email` (admin consent if the tenant blocks user consent). `User.Read` isn't needed. | Same |
| Token configuration | Optional claim `email` on the ID token | Same |
| Enterprise application → Assignment required | **No** for the beta (`ACCESS_POLICY=tenant-members`). Yes, with the testers assigned, if invite-only is restored. | Same rule as development |
| App roles | None (roles are managed in the app; see decision 3) | None |

## Decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | **Tenant:** which Entra tenant (the company's primary directory)? Single-tenant only, with guest (B2B) accounts not admitted? | Single tenant; no guests at first |
| 2 | **Who may sign in:** which users or security group are assigned in Entra, and do JarcTech Admins invite each person in the app, or should unknown people be able to request access for an Admin to approve? | An Entra security group for gate 1. Admin invitations for gate 2, plus a visible "access not granted" page. |
| 3 | **Where roles are managed:** in JarcTech Ticket by its Admins, or as Entra app roles managed by IT? | In the app, with an audit trail. Entra controls only who may sign in. |
| 4 | **Initial admin:** whose work email gets the first Admin invitation (via the bootstrap command)? | The owner |
| 5 | **App registrations:** may a new dedicated registration be created (dev first, production later)? Who in IT creates it? | Yes, separate dev and production registrations |
| 6 | **Local callback URL:** fix development at `http://localhost:4177/auth/callback`? Entra needs the exact URI, including the port. | Yes. 4175 and 4176 are in use on this machine. |
| 7 | **Credential type:** client secret or certificate? | A secret for development; consider a certificate for production |
| 8 | **Session lifetime:** 8 hours idle and 24 hours absolute? | Yes |
| 9 | **Library:** `openid-client` or `@azure/msal-node`? | `openid-client`, unless policy requires Microsoft's library |
| 10 | **Prototype mode:** keep the browser-only demo when `AUTH_MODE` is unset? | Yes |
| 11 | **Requestor name field:** pre-fill it from the signed-in account and treat it as display text only (the owner comes from the session)? | Yes |
