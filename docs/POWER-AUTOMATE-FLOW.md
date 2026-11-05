# The Power Automate email flow

JarcTech Ticket keeps its queue, recipients, templates, preferences, and stale checks. A scheduled flow collects a small batch from
the app every 2 minutes, sends each message through Outlook, and reports back. The app holds nothing that can send email, and the flow
has no trigger anyone can call. **No Entra registration is involved.**

Keep this document in step with the flow. It holds no secrets or addresses; those live in Railway and in the flow.

## Pieces

| Piece | Name | Notes |
| --- | --- | --- |
| Flow | `JarcTech Ticket - Send Email` | Scheduled. Owner needs Power Automate Premium. Add a co-owner |
| SharePoint list | `JarcTech Ticket Email Ledger` | Holds a hash and a status per message, nothing personal |
| Sender | a shared mailbox | Fixed in the flow. Its display name is what recipients see |
| Secret | `EMAIL_COLLECT_SECRET` | In Railway and in two actions of the flow. At least 32 random characters |

If the owner leaves with no other owner, the flow must be recreated. If their connections go, those actions fail until a remaining owner updates them. The Outlook connector doesn't support service principals, so its connection is a signed-in account, and a dedicated service account is better than a person's.

## What the secret can do

`Authorization: Bearer <secret>` reaches three routes, and nothing else. All are POST. They are rate limited to 60 requests a minute per address, and answer 404 while delivery is off.

| Route | Does |
| --- | --- |
| `/api/v1/email-flow/check` | Confirms the secret. Reads nothing |
| `/api/v1/email-flow/collect` | Returns up to 10 due messages: `{ "messages": [{ "id", "claim", "eventId", "to", "subject", "html", "replyTo" }] }` |
| `/api/v1/email-flow/report` | Takes `{ "id", "claim", "eventId", "outcome", "code" }` for one message |

It can't create a message, choose a recipient, or read a request. If it leaks, someone could read queued recipients, subjects, and message text, and falsify results; they can't send email. **To rotate it:** in Railway set `EMAIL_COLLECT_SECRET_PREVIOUS` to the old value and `EMAIL_COLLECT_SECRET` to a new one; update both actions in the flow; delete `EMAIL_COLLECT_SECRET_PREVIOUS`.

## Delivery is not exactly-once

Each message has a stable `eventId`. The flow records it in the ledger **before** sending, and the list refuses a second entry with the same ID.

| What happened | What the ledger shows | Result |
| --- | --- | --- |
| The run stopped before the ledger entry | No entry | Collected again after 20 minutes, and sent |
| Outlook definitely failed | The flow removes its entry | Retried by the app, up to 5 attempts |
| Sent, but the report was lost | `sent` | Collected again; the flow reports `already-sent`; **nothing goes out** |
| The run stopped between the ledger entry and the send result | `sending` | **In doubt** |
| Outlook timed out (Microsoft says a 504 doesn't mean it failed) | `sending` | **In doubt** |
| Collected but never reported, for 48 hours | Unknown | **In doubt** |

**In doubt is never resent by itself, and never silently dropped.** The message is marked failed, the log says so without its content, and Admins get an in-app alert. An Admin checks the mailbox's Sent Items, then either leaves it, or chooses **Send again (may duplicate)** under Users → Email delivery. That starts a new attempt with a new `eventId`, so a duplicate is possible only by that choice.

A message can still be lost if the process stops between saving an action and queuing its email. Sent status means Outlook's send action succeeded, not that it reached an inbox.

## Overlaps and batches

- The flow's trigger has concurrency 1, and the app also holds a lease. A collection while a batch is out gets an empty list, even if the flow is misconfigured.
- One batch is at most 10 messages. A claim lasts 20 minutes.
- After Outlook reports 401, 403, or 404, collections pause for 15 minutes; after 429, 5 minutes.
- Messages are checked against the live record when collected, so a message can only be up to one batch out of date when sent.

## The flow, step by step

Action names matter, because expressions use them. **Set Retry policy to None on the SharePoint and Outlook actions**: a retried Outlook action can send twice. Leave the `Report` action's default retry on, because reports are safe to repeat.

**Don't use Parse JSON or Compose on message data.** Microsoft's docs (written for Logic Apps, the engine underneath) say they can't hide data, and they stop hiding from passing downstream.

**Trigger: Recurrence** every 2 minutes. Settings → Concurrency Control: **on, degree 1**. Microsoft notes that turning this on can't be undone without re-adding the trigger.

**1. Initialize variables** (at the top, before the loop): `Outcome` (string), `Code` (string).

**2. HTTP `Collect`:** POST to `<app address>/api/v1/email-flow/collect`, header `Authorization` = `Bearer <secret>`. Settings: **Secure Inputs on, Secure Outputs on**, Retry policy None.

**3. Apply to each `Each_message`** over `body('Collect')?['messages']`. Leave concurrency off, so messages go one at a time. Inside it:

- a. Set `Outcome` to empty and `Code` to empty.
- b. Condition `Is_allowed`, all of these:
  - `endsWith(toLower(items('Each_message')?['to']), '@<company-domain>')` is true (use `or` for several domains)
  - `contains(items('Each_message')?['to'], ';')` is false, and `contains(items('Each_message')?['to'], ',')` is false
  - `length(items('Each_message')?['eventId'])` equals `64`
  - `or(empty(items('Each_message')?['replyTo']), endsWith(toLower(items('Each_message')?['replyTo']), '@<company-domain>'))` is true
- c. **No:** set `Outcome` = `rejected`, `Code` = `recipient`.
- d. **Yes:** SharePoint **Create item** `Claim_in_ledger`: Title = `items('Each_message')?['eventId']`, Status = `sending`. Then Condition `Claimed`, **run after succeeded, failed**: `actions('Claim_in_ledger')?['status']` equals `Succeeded`.
  - **Yes:** Outlook **Send an email from a shared mailbox (V2)** `Send_email`: Original Mailbox Address typed in, never from the message. To, Subject, Body (html), and Reply To from `items('Each_message')`. Settings: **Secure Inputs on**, Action timeout `PT90S`, Retry None. Then Condition `Sent`, **run after succeeded, failed, timed out**: `actions('Send_email')?['status']` equals `Succeeded`.
    - Yes: SharePoint **Update item** `Ledger_sent`, Status = `sent`, Retry None. Then, **run after succeeded, failed**, set `Outcome` = `sent`.
    - No: Condition `Timed_out`: `or(equals(actions('Send_email')?['status'], 'TimedOut'), equals(string(outputs('Send_email')?['statusCode']), '504'))`.
      - Yes: set `Outcome` = `in-doubt`. Leave the ledger entry.
      - No: SharePoint **Delete item** `Ledger_clear`. Then, **run after succeeded, failed**, set `Outcome` = `outlook-failed`, `Code` = `string(outputs('Send_email')?['statusCode'])`.
  - **No:** SharePoint **Get items** `Find_entry`: Filter Query `Title eq '@{items('Each_message')?['eventId']}'`, Top Count 1. Then Condition `Found`, **run after succeeded, failed**: `length(coalesce(body('Find_entry')?['value'], json('[]')))` is greater than 0.
    - No: set `Outcome` = `ledger-unavailable`. Nothing was sent.
    - Yes: if `first(body('Find_entry')?['value'])?['Status']` equals `sent`, set `Outcome` = `already-sent`; otherwise `in-doubt`.
- e. HTTP `Report`, last in the loop, **run after the condition above succeeded, failed**: POST to `<app address>/api/v1/email-flow/report`, header `Authorization` = `Bearer <secret>`, header `Content-Type` = `application/json`, body with `id`, `claim`, and `eventId` from `items('Each_message')`, and `outcome` = variable `Outcome`, `code` = variable `Code`. Settings: **Secure Inputs on, Secure Outputs on**.

## The ledger list

A new SharePoint list on a site the flow's account can edit:
- **Title**: List settings → Title → **Enforce unique values: Yes**. This is what makes a second send impossible.
- **Status**: a single line of text.

Rows older than a few days can be deleted at any time; a message retried after 48 hours is treated as in doubt anyway. Nothing prunes the list automatically yet.

## After the first real email

Open that run's history and confirm **no recipient, subject, or message body is visible** in any step. Microsoft's Power Automate page on this could not be read, and its Logic Apps page says hiding carries only to actions that use the hidden output directly, so this needs checking in your tenant. If anything shows, turn on Secure Inputs and Outputs for that action. Run history is kept for 30 days, and Microsoft doesn't state whether owners can reveal hidden values.

## Limits (read from Microsoft on 2026-11-05)

- **Official Premium limit: 40,000 Power Platform requests per user per 24 hours**, across all of that user's flows. **During the current transition period Microsoft applies 200,000 per flow instead.** Enforcement of the official limit starts at least six months after usage reporting is generally available. Microsoft calls these figures approximate.
- All actions count, including failed ones and retries. Microsoft doesn't say whether the trigger counts.
- **My estimate, not a measurement:** a run with nothing to send uses about 3 actions, so 720 runs is about 2,200 a day. Each email adds about 10. At 300 emails a day that's about 5,200, or 13% of 40,000. The account's other flows share that limit. Check it under the flow's **Analytics → Actions**.
- Over the limit, flows slow down. A flow consistently over it for 14 days is turned off.
- Outlook: 300 calls a minute per connection, plus Exchange's own limits. SharePoint: 600 calls a minute per connection. Neither is close at 10 messages per 2 minutes (about 7,200 a day at most).

## Connectors and policy

Microsoft's pages don't say how your tenant classifies these. **Only your environment's data policy can answer whether HTTP, Office 365 Outlook, and SharePoint may be used together.** A maker sees a "blocked by policy" error when saving a flow that breaks it. The portal also shows whether HTTP needs Premium, which Microsoft's pages could not confirm here.

## Turning it off

- **App:** set Railway's `EMAIL_DELIVERY` to `disabled`. The routes answer 404, and saved actions and in-app notifications carry on.
- **Flow:** turn it off. Messages wait; Admins are alerted after 30 minutes, and unsent ones expire after 48 hours.

## When something breaks

| Under Users → Email delivery | Likely cause | Fix |
| --- | --- | --- |
| Flow last collected long ago | Flow off, or Collect failing | Turn it on; check its run history |
| `Outlook 401` or `Outlook 403` | Expired connection, or no mailbox access | A flow owner updates the connection; retries resume |
| `ledger unavailable` | SharePoint connection or list | A flow owner fixes it; retries resume |
| `rejected recipient` | Address outside the flow's domains | Check the domain list in the flow and in `EMAIL_ALLOWED_DOMAINS` |
| `in doubt` | See above | Check Sent Items, then decide |
| `Outlook 429` | Throttled | Waits by itself |
