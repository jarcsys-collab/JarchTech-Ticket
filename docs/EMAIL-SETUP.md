# Setting up email with Resend (not in use)

**The official deployment uses Power Automate instead: see [POWER-AUTOMATE-FLOW.md](POWER-AUTOMATE-FLOW.md).** This stays as the alternative. What the owner does to turn email on, in order. Nothing here needs Microsoft Graph,
Teams, or any change in Entra. **Never put an API key in chat, Git, or a screenshot.**

Limits and prices below were read from Resend's pages on 2026-11-05. Check them again on [resend.com/pricing](https://resend.com/pricing) before deciding.

## 1. Choose the sender address

Pick one address on a domain the company controls, on a **subdomain**, for example `tickets@notify.<company-domain>`. Resend strongly
recommends a subdomain, and it keeps this mail separate from your Microsoft 365 mail. The mailbox does not need to exist.

Also decide a **support address** for replies to automatic reminders (optional). People's replies to other emails go to the person who acted.

## 2. Resend account and domain

1. Create an account at [resend.com](https://resend.com). The Free plan is enough to start; see the limits below.
2. **Domains → Add Domain**, and enter the subdomain you chose. A region close to the Philippines (Tokyo, if offered) is a sensible choice.
3. Leave the page open. It lists the exact records your domain needs.

## 3. DNS records

Add **exactly what Resend's Records tab shows**: the values are unique to your domain, so none are listed here. Expect a DKIM TXT
record and, on a sending subdomain under the one you chose (usually `send`), an SPF TXT record and an MX record.

**Protect your existing Microsoft 365 mail:**

- **Do not change or replace the MX records on your main domain.** Outlook depends on them. The MX record Resend asks for is on its own sending subdomain, and only handles bounces.
- **Do not add a second SPF record on your main domain,** and don't edit the existing one. A host may have only one SPF record. Resend's goes on its own sending subdomain, so it doesn't conflict. If your DNS screen shows an SPF record already on *that exact host*, stop and ask before changing anything.
- If the DNS provider is Cloudflare, set any CNAME Resend gives you to **DNS only** (grey cloud), as Resend asks.
- **DMARC is a separate step, after verification.** If your main domain already has a DMARC record, leave it alone. Note that a strict policy may also apply to the subdomain, which can affect delivery; that is a reason to test with real recipients first (step 6).

Then choose **Verify** in Resend. It often takes about 15 minutes and can take up to 72 hours.

## 4. API key

In Resend, **API Keys → Create**: permission **Sending access**, limited to this domain. It is shown once. Paste it straight into Railway in the next step, nowhere else.

## 5. Railway variables, test recipients first

Railway → project `JarcTech-Ticket` → service `JarcTech-Ticket` → **Variables**. Setting these redeploys the service.

| Variable | Value | Notes |
| --- | --- | --- |
| `EMAIL_DELIVERY` | `resend` | Turns delivery on. Remove it or set `disabled` to turn it off |
| `EMAIL_FROM` | your sender address, such as `tickets@notify.<company-domain>` | Must be on the verified domain. The name is always "JarcTech Ticket" |
| `RESEND_API_KEY` | the key | Secret |
| `EMAIL_TEST_RECIPIENTS` | the agreed test addresses, separated by commas | **Set this first.** Only these accounts get email; for everyone else it is recorded as suppressed |
| `EMAIL_REPLY_TO` | your support address | Optional. Used for automatic reminders |

`APP_BASE_URL` is already the official address, and the links in emails use it.

If a value is wrong, the new deployment refuses to start and Railway keeps the previous one running.

## 6. Small test

Tell Claude who the test recipients are **before** any real test email goes. Then:

1. As an Admin on the list: **Users → Email delivery → Send a test email to myself**. It touches no request.
2. Confirm it arrives in Outlook, not in Junk, and that the button opens the app.
3. For a full check, run one request through assignment, meeting, and completed work between test recipients, and follow each email's button, once signed in and once signed out. You choose any request to use, and you archive or delete it in the app afterwards.
4. **Users → Email delivery** should show those messages as *Accepted by provider*, with nothing failed.

## 7. Everyone

After you approve: **delete `EMAIL_TEST_RECIPIENTS`** in Railway. From then on, new events email the people involved.
Nothing that happened earlier is sent: nothing was queued while email was off, and messages suppressed in the test phase stay suppressed.

To stop at any time, set `EMAIL_DELIVERY=disabled`. Saved actions and in-app notifications carry on as before.

## Plans and limits

| Plan | Price | Emails | Daily limit | Domains |
| --- | --- | --- | --- | --- |
| Free | $0 | 3,000 a month | **100 a day** (resets at midnight UTC) | 3 |
| Pro | $20 a month | 50,000 a month, then $0.90 per 1,000 | None | 10 |

- Each recipient counts as one email. Closure, for example, is two.
- Rate limit: 10 requests a second, shared by the whole account. The app sends one at a time, well below this.
- At the daily limit, messages wait and go after the reset. A monthly limit marks them failed, and an Admin can retry them.
- Keep bounces under 4% and spam complaints under 0.08%, or Resend may pause sending.
- Resend keeps its copy of messages for 30 days on these plans, so the message text (ID, request title, names) is held there too.

**No payment is needed to start.** If regular use nears 100 a day, Pro is the next step. That is the owner's decision, and nothing here upgrades it.

## What email cannot tell you

"Accepted by provider" means Resend took the message. It does not prove it reached an inbox. Bounces and complaints show in
Resend's dashboard, not in this app: the app does not receive Resend's webhooks.
