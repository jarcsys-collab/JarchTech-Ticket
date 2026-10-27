# Workflow and ownership

## Roles

- **Requestor:** submits and tracks their own requests, provides requirements, confirms meetings and agreements, reviews the evidence, and confirms completion or returns the work for correction.
- **Developer:** the IT worker assigned to a request. Sees assigned work plus their own requests. Plans, holds the requirements meeting, records the agreement, builds the timeline, does the work, supplies evidence, and confirms their own completion. No assignment authority and no user management.
- **Admin:** sees every request, manages users and roles, reviews and assigns work (to an active Developer or themselves), approves scope changes, and performs final closure. An Admin who assigns work to themselves is its worker.

New accounts are Requestors. Every rule is enforced on the server (lists, search, details, actions, files, notifications, direct links).

## Request types

Chosen on the request form, separate from the category (bug, enhancement, access request, ...). An Admin can change it until planning is agreed.

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

The two confirmations are recorded separately (who, which capacity, when). One account never confirms both sides: when the Requestor is also the worker, a different Admin reviews for the Requestor side. Returning for correction, the worker withdrawing their completion, reassignment while awaiting confirmation, and an approved scope change all clear earlier confirmations; the cleared confirmations and correction reasons stay on the record.

## Project planning

1. The worker schedules the requirements meeting; the Requestor confirms it.
2. After the meeting the worker records the meeting notes, agreed requirements, and acceptance criteria.
3. The worker and the Requestor confirm the agreement separately. With both confirmations it is locked (agreement v1); the server refuses direct edits from then on.
4. The worker creates the timeline from the locked agreement: tasks, owners, dates, and the delivery target.
5. Task progress stays available. Task dates can move within the delivery target; every change is recorded with its old and new dates.

## Linked changes

New or changed requirements -> linked change -> Admin review -> worker impact assessment -> Requestor agreement -> Admin approval -> a new agreement version (earlier versions kept), a change task, and the revised delivery target (recorded with the old and new dates) -> implementation -> testing -> Requestor acceptance -> release -> Admin closure.

Changes are accessible through the original request's Linked change requests section, not a sidebar tab. Fixes to agreed requirements stay on the original request as corrections. A closed original need not be reopened for a separately tracked change.

## Older records

`npm run db:migrate-request-types` classifies existing requests (linked project: Project; otherwise Ticket), versioned and reversible. Projects from before locked agreements and requests completed before dual confirmation get no invented meetings, approvals, or confirmations: ticket details list the missing steps, and the worker and Requestor can still record them.
