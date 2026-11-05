# The Power Automate email flow

How JarcTech Ticket sends email through the Office 365 Outlook connector, and exactly what the flow must contain. The app keeps
its queue, recipients, templates, preferences, stale checks, and retries. The flow only checks a message, records it, and sends it.

Keep this document in step with the flow. It holds no addresses, URLs, or secrets; those live in Railway and in the flow.

## Pieces

| Piece | Name | Notes |
| --- | --- | --- |
| Entra app registration | `JarcTech Ticket Email` | **Needs Entra rights.** No API permissions and no redirect URI. Separate from the sign-in registration, so its secret can be replaced on its own. Note the secret's expiry date |
| Flow | `JarcTech Ticket - Send Email` | In a solution if the environment allows, so that ownership can change later |
| SharePoint list | `JarcTech Ticket Email Ledger` | Duplicate protection. Holds a hash and a status, nothing personal |
| Sender | a shared mailbox | Fixed in the flow. Its display name is what recipients see, so name it "JarcTech Ticket" |

The flow's owner account needs Power Automate Premium, because the plan follows the owner and the HTTP trigger is a premium feature. Add a
co-owner. If the owner leaves with no other owner, the flow must be recreated; if their connections go, actions fail until a remaining
owner updates them. Microsoft's Outlook connector does not support service principals, so the Outlook connection is always a signed-in account,
and that account needs access to the shared mailbox. A dedicated service account is better than a person's account.

## What the app sends

`POST` to the trigger with a token for `https://service.flow.microsoft.com/`, signed in as `JarcTech Ticket Email`. Body, per [trigger-schema.json](../deploy/power-automate/trigger-schema.json):

```json
{ "schema": 1, "eventId": "<64 hex characters, the same on every retry>", "to": "<one address>", "subject": "...", "html": "...", "replyTo": "<address or empty>" }
```

A connection check sends `"check": true` with empty fields and must never reach a mail action.

## What the flow answers

| Answer | Meaning to the app | App does |
| --- | --- | --- |
| `200 {"outcome":"sent"}` | Outlook's send action succeeded | Sent |
| `200 {"outcome":"already-sent"}` | An earlier attempt sent it | Sent, nothing goes out again |
| `200 {"outcome":"check"}` | The connection check | Nothing is sent |
| `422 {"outcome":"rejected","code":"..."}` | The flow refused it | Failed |
| `409 {"outcome":"in-doubt"}` | An earlier attempt started, and its result is unknown | Retries, then asks an Admin |
| `502 {"outcome":"in-doubt"}` | Outlook timed out, so the mail may have gone | Retries, then asks an Admin |
| `502 {"outcome":"outlook-failed","code":"<status>"}` | Outlook definitely failed | 401, 403, 404: failed, stops the run. 429: waits. Others: retries |
| `503 {"outcome":"ledger-unavailable"}` | SharePoint failed, nothing was sent | Retries |
| `202` with no outcome | The flow accepted it, and **nothing says Outlook sent it**. The Response actions are missing | Not counted as sent |

## The flow, step by step

Action names matter, because the expressions use them. On **every** SharePoint and Outlook action: **Settings → Retry policy → None**. Retries belong to the app, because a retried Outlook action can send twice.

**Trigger: When an HTTP request is received**
- Who can trigger the flow: **Specific users in my tenant**. Allowed users: the **object ID of the service principal** of `JarcTech Ticket Email` (Enterprise applications, not App registrations). **Never "Anyone".**
- Method: POST. Schema: paste `trigger-schema.json`.

**1. Condition `Is_check`**: `triggerBody()?['check']` is equal to `true`
- Yes: **Response** `Respond_check`, status 200, body `{"outcome":"check"}`; then **Terminate**, Succeeded.

**2. Condition `Is_allowed`**, all of these:
- `triggerBody()?['schema']` equals `1`
- `length(triggerBody()?['eventId'])` equals `64`
- `endsWith(toLower(triggerBody()?['to']), '@<company-domain>')` is true
- `contains(triggerBody()?['to'], ';')` is false, and `contains(triggerBody()?['to'], ',')` is false
- `or(empty(triggerBody()?['replyTo']), endsWith(toLower(triggerBody()?['replyTo']), '@<company-domain>'))` is true
- No: **Response** `Respond_rejected`, status 422, body `{"outcome":"rejected","code":"recipient"}`; then **Terminate**, Succeeded.

**3. SharePoint: Create item** `Claim_in_ledger`: the ledger list, Title = `triggerBody()?['eventId']`, Status = `sending`.

**4. Condition `Claimed`**, with **run after: Claim_in_ledger succeeded, failed**: `actions('Claim_in_ledger')?['status']` equals `Succeeded`.

**Yes branch:**

- a. **Office 365 Outlook: Send an email from a shared mailbox (V2)** `Send_email`: Original Mailbox Address = the shared mailbox, typed in, never from the request. To = `triggerBody()?['to']`. Subject = `triggerBody()?['subject']`. Body = `triggerBody()?['html']`. Reply To = `triggerBody()?['replyTo']`. Settings → Action timeout = `PT90S`.
- b. Condition `Sent`, **run after: Send_email succeeded, failed, timed out**: `actions('Send_email')?['status']` equals `Succeeded`.
  - Yes: **SharePoint: Update item** `Ledger_sent`, Status = `sent`. Then **Response** `Respond_sent`, **run after: Ledger_sent succeeded, failed**, status 200, body `{"outcome":"sent"}`.
  - No: Condition `Timed_out`: `or(equals(actions('Send_email')?['status'], 'TimedOut'), equals(string(outputs('Send_email')?['statusCode']), '504'))` is true.
    - Yes: **Response** status 502, body `{"outcome":"in-doubt"}`. The ledger entry stays, because Microsoft says a 504 does not mean the mail failed.
    - No: **SharePoint: Delete item** `Ledger_clear`, so a retry can send. Then **Response**, **run after: Ledger_clear succeeded, failed**, status 502, body `{"outcome":"outlook-failed","code":"@{outputs('Send_email')?['statusCode']}"}`.

**No branch:** (the claim failed: a duplicate, or SharePoint is down)

- a. **SharePoint: Get items** `Find_entry`: Filter Query `Title eq '@{triggerBody()?['eventId']}'`, Top Count 1.
- b. Condition `Found`, **run after: Find_entry succeeded, failed**: `length(coalesce(body('Find_entry')?['value'], json('[]')))` is greater than `0`.
  - No: **Response** status 503, body `{"outcome":"ledger-unavailable"}`.
  - Yes: Condition `Already_sent`: `first(body('Find_entry')?['value'])?['Status']` equals `sent`.
    - Yes: **Response** status 200, body `{"outcome":"already-sent"}`.
    - No: **Response** status 409, body `{"outcome":"in-doubt"}`.

Don't put Response actions in parallel branches: Microsoft documents that they aren't supported there. Every path above must reach a Response, or the app sees an error.

## The ledger list

A new SharePoint list on a site the flow's account can edit:
- **Title**: List settings → Title → **Enforce unique values: Yes**. This is what makes duplicates impossible.
- **Status**: a single line of text.

It holds hashes, not addresses or content. It grows by one short row per email, and nothing prunes it yet: delete rows older than a few days whenever you like, since the app's messages expire after 48 hours.

## Checking and switching

- `npm run email:check` signs in and calls the flow with `check`. It sends nothing, and it proves the secret, the allowed caller, and that the flow is on. **It cannot prove the Outlook connection still works.**
- **To stop email at once:** set Railway's `EMAIL_DELIVERY` to `disabled`. To stop it from the Microsoft side, turn the flow off; messages wait, retry, and expire after 48 hours. Saved actions and in-app notifications carry on either way.

## When something breaks

| Admin sees (Users → Email delivery) | Likely cause | Fix |
| --- | --- | --- |
| `Outlook 401` or `Outlook 403` | Expired Outlook connection, or no mailbox access | A flow owner updates the connection, then choose Retry |
| `token invalid_client` | The app secret expired or changed | New secret in Entra, then update `EMAIL_FLOW_CLIENT_SECRET` |
| `HTTP 401` or `HTTP 403` | The allowed caller on the trigger is wrong | Check the service principal's object ID |
| `HTTP 404` | The flow is off, or was deleted | Turn it on, or recreate it |
| `flow accepted, no result` | Response actions are missing | Fix the flow |
| `in doubt` | A timeout: it may have gone | Check the mailbox's Sent Items, then **Send again** only if needed |
| `Outlook 429` or `HTTP 429` | Throttled: 300 sends a minute per connection, plus Exchange's own limits | Waits by itself |
