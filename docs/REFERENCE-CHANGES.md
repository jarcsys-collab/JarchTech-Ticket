# Review changes and decisions

Source: `reference/annotated-review.pdf`, supplied by the owner on 21 October 2026. Page numbers refer to that PDF. The original reference is retained unchanged. Older screenshots describe an earlier UI and are not a current specification where crossed out.

| Reference | Requested change / evidence | Implemented behavior |
| --- | --- | --- |
| Pages 4, 5, 9, 13; prior chat | Meetings and Change requests sidebar items crossed out | Sidebar contains Tickets received / My ticket and Projects only. Meeting and linked change actions remain in ticket details. |
| Page 4 | Notes: all tickets from all requestors; tickets received; change to my ticket | Admin heading/navigation: Tickets received. Main ticket table tab: My ticket. Requestor/developer heading and navigation: My ticket. Admin sees all records; requestor and developer scopes are filtered. |
| Pages 4, 5, 9, 13 | Other-role buttons crossed out | Removed the central role preview strip. A compact header Demo role selector remains solely for testing until real sign-in is built. |
| Pages 5, 9, 10, 13 | Kanban labels/screens crossed out | Removed the Kanban navigation option. Project monitoring uses the Gantt chart. |
| Page 6 | Form to be discussed per request type/category | Owner confirmed in chat: keep current fields for now. No speculative category-specific fields added. |
| Page 7 | Detail to push to developer or reject; follow process flow | Kept admin priority, assignment, clarification, rejection reasons, and hold actions. Assignment routes to the developer queue. |
| Page 11 | Set meeting schedule for planning and requirement/criteria gathering | Meetings remain attached to ticket details; planning actions support schedule, location, notes, requirements, and criteria. Existing project meetings can be edited there. |
| Page 12 | Add project name; agreed requirements and criteria as tasks with a timeline; Gantt view | Project scope captures a name, requirements, criteria, target date. Dated tasks capture requirements, criteria, owner, start, and end. Gantt lists and plots them. |
| Page 13 | Project list; click to show Gantt listing tasks | Project rows open the Gantt panel, with linked ticket navigation and task detail editing. |
| Page 18 | Next page of project creation | Two-step project wizard: scope first, tasks/timeline second. Back preserves entered task drafts. |

## Interpretation of ambiguous marks

- Pages 14-17 cross out standalone or repeated meeting screens, while page 11 explicitly requests planning meetings. Accordingly, standalone meeting navigation was removed, but meetings remain in the ticket workflow. This can be revised if the owner intends to remove meeting confirmation entirely.
- Crossed role buttons indicate separate role workspaces. The prototype retains a clearly labeled demo selector for verification. Real sign-in and roles are the next development phase.
- The PDF does not supply a request type/category taxonomy, production backend, authentication provider, or hosting target. These remain decisions for the owner.

## New validation

- Task name, requirement, criteria, start, and end are required.
- End date cannot precede start date.
- Task end cannot exceed the project target date.
- A project needs at least one task and agreement on scope/criteria/schedule.
- Project edits cannot shorten the target date before an existing task ends.
- Existing undated tasks stay unscheduled; the app does not invent dates for them.

## Verification performed

- Syntax checks for the server and all scripts.
- Automated tests for calendar validity, inclusive Gantt duration, reversed dates, unscheduled tasks, static serving, unsupported methods, and traversal protection.
- Browser walkthrough: assigned an isolated demo ticket; created a named project in two steps; rejected reversed dates; saved a valid task; rendered Gantt; completed a task; reloaded; confirmed saved progress and requestor read-only project access.

The walkthrough used an isolated demo origin and did not change the owner's main localhost working records.

## Phase 1 - ticket-core extraction and stored-data recovery

Owner-approved change on `feature/phase1-ticket-core`. Statuses, demo identities, role visibility, progress, and localStorage access moved from `app.js` into `public/ticket-core.js`. Storage key, data format, UI, and workflow are unchanged.

Intended behavior change: unreadable or structurally invalid stored data previously fell back to sample data, which the next save wrote over the original records. Now:

- The original `jarc-helpdesk-v1` value is never modified on load.
- The exact raw value is copied to a unique `jarc-helpdesk-v1-backup-<timestamp>` key; an identical earlier backup is reused. A failed or mismatched backup is reported and the original is still kept.
- Saving is paused and a recovery screen offers download, retry, and an explicit, confirmed reset to sample data. Reset removes only the main record; backups remain.
- Storage read failures enter recovery; write failures show a warning and keep the last saved value.

"Structurally valid" means `tickets`, `changes`, and `notices` arrays, with every ticket having a string `id`, `tasks`, and `history`, and every change a string `id` and `history`. Data created by the app always meets this.

A stored value of exactly `null` (valid JSON, but not a records object) intentionally enters recovery mode as `invalid`. The earlier prototype replaced it with sample data. Only a missing record, where nothing is stored under the key, starts fresh sample data. This keeps one rule: anything stored that is not usable records is preserved and backed up, never silently replaced. Covered by the `JSON null` case in `tests/ticket-core.test.cjs`.

Verified with `tests/ticket-core.test.cjs` (preservation, role filtering, progress, invalid data, failed backup, blocked saves, write failure, reset) and `npm run walkthrough`, an optional isolated headless-browser check of the full workflow plus recovery cases (see README).
