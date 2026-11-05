# Workflow and ownership

## Roles

- **Requestor:** submits and tracks their own requests, provides requirements, confirms meetings and agreements, reviews the evidence, and confirms completion or returns the work for correction.
- **Developer:** the IT worker assigned to a request. Sees assigned work plus their own requests. Plans, holds the requirements meeting, records the agreement, builds the timeline, does the work, supplies evidence, and confirms their own completion. No assignment authority and no user management.
- **Admin:** sees every request, manages users and roles, reviews and assigns work (to an active Developer or themselves), approves scope changes, performs final closure, and archives or deletes finished requests. An Admin who assigns work to themselves is its worker.

New accounts are Requestors. Every rule is enforced on the server (lists, search, details, actions, files, notifications, direct links). A colleague must sign in once before their account appears under Users, where any Admin can make them a Developer or an Admin, or return them to Requestor. Changes apply at once and are recorded. A notification about a record its reader can no longer see keeps its title but not its text.

If the Requestor's account is disabled, an Admin other than the worker reviews for them, as for a Developer's self-requested work. If the worker can no longer act, Admins are asked to reassign it.

## Departments and request categories

Both are required on a new request, chosen from a searchable list, with nothing chosen in advance. They are set once, on the request form.

- **Departments:** LEGAL · SALES · BUSINESS DEVELOPMENT · LEARNING · SUPPLY CHAIN · FINANCE · JARCET · SYS · HR & ADMIN · REGULATORY · COMMUNICATIONS · OOP
- **Request categories:** NETWORK, HARDWARE, & SOFTWARE SUPPORT · MONDAY · POWERBI · EXCEL · BUSINESS CENTRAL · ECOM · SUPPORT FOR DISTRIBUTOR

Older requests keep their original values: nothing renames or reclassifies them. Those values stay readable, can be filtered on (under "Earlier values" when a record you can see has one), and never stop an unrelated update. They are not offered for new requests.

## Request types

Chosen on the request form, separate from the request category. An Admin can change it until planning is agreed.

- **Ticket:** simple work. No mandatory meeting, Gantt chart, or project.
- **Project:** a mandatory requirements meeting and project planning before development.

## Shared completion process

1. Requestor submits.
2. Admin reviews, requests missing information if needed, and assigns an eligible worker.
3. Worker does the work and supplies evidence (at least one file or http/https link) with a delivery and testing summary.
4. Worker marks their work done.
5. Requestor reviews the evidence and independently marks it done, or returns it for correction with a reason.
6. Projects: the worker confirms the release or handover.
7. Only with both confirmations (and, for Projects, the handover) can an Admin close the request.

The two confirmations are recorded separately (who, which capacity, when). One account never confirms both sides, with one exception below: when a Developer is both the Requestor and the worker, an Admin reviews for the Requestor side. Returning for correction, the worker withdrawing their completion, reassignment while awaiting confirmation, and an approved scope change all clear earlier confirmations; the cleared confirmations and correction reasons stay on the record.

### An Admin's own request

An active Admin who is both the Requestor and the assigned worker completes the request without another Admin. Only that account, while it stays an active Admin: if it stops being one, the independent review applies again, and a Developer in the same position still needs an Admin.

- Every step stays a separate, explicit action: mark the work done as the worker, confirm as the Requestor, record the handover (Projects), close as Admin. One never counts as another. The same applies to the meeting confirmation, both agreement confirmations, and the Requestor side of a scope change.
- Nothing else is relaxed: evidence and the delivery summary, the Project meeting, agreement, timeline, and tasks, the handover, and the open scope change rule all still apply.
- The history records the same person with their capacity for each action (Worker, Requestor, Admin).
- The Requestor side is theirs alone while they can act: another Admin cannot confirm it, but can still return the work for correction, reassign it, or close it once both confirmations are in.
- This applies to existing requests as they stand. Nothing is filled in or reset.

## Archiving and permanent deletion

For Admin accounts in My workspace. The server checks the account on every action; the Archive and Delete controls appear on a closed, rejected, or cancelled request, and a scope change still open must be settled first. Nothing is archived or deleted unless an Admin chooses to.

- **Archive** is the normal way to take a finished request out of active lists. It leaves the dashboard, queues, activity feed, and searches, and sends no more reminders. It is read-only, and only Admins can see it (and its files) until it is restored. It appears under the **Archived** tab of the list, with **Restore**, which brings it back exactly as it was. Nothing is deleted.
- **Delete permanently** is in request details. The confirmation shows the request's ID and title and everything affected: the project, tasks, scope changes, attachments, and notifications. The request ID must be typed exactly. A file that a retained record also uses is kept and handed to that record; an upload still pending is never touched. The ID is never used again.
- **What stays after deletion:** a minimal audit entry (who, when, the request and scope change IDs, its type and status, and counts), shown in the **Deletion log** on the Archived tab. Titles, descriptions, comments, and file names are not kept. The audit entry is written first, and an interrupted deletion hides the request and is finished by the next scheduler run.

Records with no archive state are simply active, so existing records need no migration.

## Project planning

1. The worker schedules the requirements meeting; the Requestor confirms it.
2. After the meeting the worker records the meeting notes, agreed requirements, and acceptance criteria.
3. The worker and the Requestor confirm the agreement separately. With both confirmations it is locked (agreement v1); the server refuses direct edits from then on.
4. The worker creates the timeline from the locked agreement: tasks, owners, dates, and the delivery target.
5. Task progress stays available. Task dates can move within the delivery target; every change is recorded with its old and new dates.

## Linked changes

New or changed requirements -> linked change -> Admin review -> worker impact assessment -> Requestor agreement -> Admin approval -> a new agreement version (earlier versions kept), a change task, and the revised delivery target (recorded with the old and new dates) -> implementation -> testing -> Requestor acceptance -> release -> Admin closure.

Changes are accessible through the original request's Linked change requests section, not a sidebar tab. Fixes to agreed requirements stay on the original request as corrections. A closed original need not be reopened for a separately tracked change.

## Email

Email only tells people that something needs them, and links to the request. Every action still happens in the app. See README, Email.

## Guidance

The app shows each person the next step on a request and who takes it (see README, Guided next actions). The guidance is derived from the same workflow rules by trying the actions, so it cannot disagree with them; the server checks every action again.

## Older records

`npm run db:migrate-request-types` classifies existing requests (linked project: Project; otherwise Ticket), versioned and reversible. Projects from before locked agreements and requests completed before dual confirmation get no invented meetings, approvals, or confirmations: ticket details list the missing steps, and the worker and Requestor can still record them.
