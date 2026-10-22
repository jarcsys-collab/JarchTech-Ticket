# Architecture decision

Status: decided by the owner on 2026-10-22. Details marked "pending" still need the owner's answer before the related work starts.

## Decision

| Concern | Choice | Notes |
| --- | --- | --- |
| Source control | GitHub (`jarcsys-collab/JarchTech-Ticket`) | Feature branches and pull requests into `main`. GitHub Actions runs checks. |
| Application and backend hosting | Railway | Use the owner's **existing paid Railway account and project**. Do not create new accounts or buy additional plans. |
| Shared database | MongoDB Atlas | Use the owner's **existing paid Atlas account**. Do not create new accounts or buy additional plans. Development uses the separate database `jarctech_ticket_dev`, with a user restricted to that database. |
| Sign-in | Microsoft Entra ID | The company's existing Entra sign-in, using OpenID Connect (`openid-client`). Implemented on `feature/entra-auth` and tested with mocks; no app registration or real credentials configured yet. See `docs/AUTH-DESIGN.md`. |

Do not substitute another database or hosting platform without a new owner decision recorded here.

## Secrets and configuration

- Credentials such as the MongoDB connection string, session secret, and sign-in client secrets live in **Railway environment variables** for deployed environments. For local development they go in an **untracked `.env` file**, which `.gitignore` already excludes.
- `.env.example` lists every variable with **placeholders only**.
- Never commit credentials, and never paste passwords or connection strings that contain passwords into chat, issues, or pull requests.
- Each environment (local, staging, production) uses its own database and its own least-privilege database user.

## Pending owner details

| Detail | Why it matters | Status |
| --- | --- | --- |
| Is the MongoDB deployment Atlas, Railway-hosted MongoDB, or another existing instance? | Network access, backups, and whether multi-document transactions are available (needed for an all-or-nothing import) | Decided 2026-10-22: Atlas. The cluster tier, which affects backups, is still to confirm. |
| Sign-in: company Microsoft or Google accounts, or email and password? | Determines the authentication design, account onboarding and offboarding, and password reset | Decided 2026-10-22: Microsoft Entra ID |
| Which existing Railway project and environment to use, and whether a new service may be added to it | Railway bills by usage, so a running service consumes plan usage | Pending |
| Database name(s) and a dedicated database user per environment | Least privilege; keeps test data out of production | Development: `jarctech_ticket_dev`. Staging and production: pending. |

## Guardrails until those details are confirmed

- No deployment, no Railway changes, and no connections to, reads from, or writes to any existing MongoDB database.
- No paid resources are provisioned.
- Backend development runs against a local or temporary test database only. Automated tests use `mongodb-memory-server` on `127.0.0.1` and never read `.env`.

## Implemented so far

- The connection-ready server foundation: settings validation, health and readiness endpoints, Railway `PORT`/`HOST` binding, clean shutdown, and the MongoDB driver (ping only). See README, "Backend foundation". The UI still stores records in the browser.
- 2026-10-22: Atlas connectivity was verified locally against `jarctech_ticket_dev` with a dedicated user restricted to that database. `/readyz` reported `ready` / `connected`. The check sent only `ping`; no collections or records were created. The credentials are only in the owner's Git-ignored local `.env`.
- Microsoft Entra sign-in (on `feature/entra-auth`): invite-only admission, server-side sessions and roles, the Admin Users screen, and the `db:setup` and `admin:bootstrap` commands. It is tested with a mock Entra provider and a temporary database, and not yet connected to a real app registration.
- Not done yet: server-enforced ticket permissions and the ticket/project/change API, the browser-data import, and Railway deployment.

See `docs/BACKEND-PLAN.md` for the implementation plan.
