# Workflow and ownership

## Ticket delivery

1. Requestor submits the current request form. System creates an ID and admin notification.
2. Admin checks completeness, duplicates, and priority. Request clarification or reject with a reason when needed.
3. Admin assigns a developer.
4. Developer reviews the ticket, proposes a planning meeting where useful, and gathers requirements and acceptance criteria. Requestor confirms proposed meeting details.
5. Once agreed, developer creates a named linked project: scope first, then dated tasks.
6. Developer works on tasks and updates dates/progress. Requestor and admin monitor the Gantt chart.
7. Developer completes internal testing and submits testing results and delivery instructions for requestor acceptance.
8. Requestor accepts against agreed criteria or returns a correction with feedback.
9. Developer confirms release/handover. Admin closes the ticket.

## Linked changes

New/changed requirements -> linked change -> admin review -> developer impact assessment -> requestor agreement -> admin approval -> implementation -> internal testing -> requestor acceptance -> release -> admin closure.

Changes are accessible through the original ticket's Linked change requests section, not a sidebar tab. Approved changes add a project task. The developer must enter its requirement, criteria, and schedule before it appears as a dated bar. The original work continues unless explicitly put on hold. A closed original ticket need not be reopened for a separately tracked change.

## Production data model to discuss

Users and roles; tickets and assignments; ticket events/comments; meeting proposals and confirmations; projects; project participants; requirements/acceptance criteria; dated project tasks; changes; impact assessments; approval decisions; notification outbox.

Ownership and access must be checked on the server in the production version. Preserve audit events and timestamps, use stable user IDs rather than names, and plan versioned local-data import before replacing browser persistence.
