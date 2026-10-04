# Launch posts

Every image under `img/` comes from the mock pages in `mocks/` via `node showcase/render.mjs`. All names, addresses, and messages in them are invented. `REPO_URL` stands in for the public link.

## X thread

1/ I gave Claude Code read access to three inboxes and three calendars. The system prompt is not what keeps it from mailing my contacts. A 346-test PreToolUse hook is. [img/injection-denied.png]

2/ The hook reads every tool call before it runs. Gmail drafts and labels pass. Trash, spam, and any Slack or Notion write are denied, and so is every send except calendar invite mail to my stated contacts, even when a connector adds a new send tool tomorrow.

3/ Calendar guests are where it gets interesting. Adding one needs a turn I started, a word asking for the addition, and an address already in my stated contacts. A look-alike that only extends a known address fails. [img/guard-tests.png]

4/ The browser gets the same treatment. On 48 real-site cases, a judge that saw only button labels allowed 27 charges and sign-ups. Given the page's accessibility tree, it allowed none, for a median 5.7s per submit.

5/ What comes out is a morning brief on Telegram, and even its prose is linted: "could", "might", and "may" fail the build, because they hide how sure the model is. [img/telegram-brief.png]

6/ No app server, no database, no dependencies: systemd timers, a headless `claude -p`, Markdown memory, and a guard hook. REPO_URL [img/architecture.png]

## LinkedIn

My assistant reads every email I get, and some of those emails are trying to give it orders.

That was the problem I kept hitting while building a personal chief of staff on Claude Code. A prompt that says "never send mail" is a request, and a well-written phishing email is a competing request. So I stopped asking the model to behave and moved the rules into code.

Every tool call passes through a PreToolUse hook before it runs. Drafts and labels go through. Trashing mail and every Slack or Notion write are denied outright, the only send allowed is a calendar invite to a contact I've stated, and an event is deleted only when I ask for it. A calendar guest needs an explicit ask in a conversation I started and an address I've stated myself. 346 tests pin those rules, including the odd ones, like an address that merely ends a longer mailbox.

The browser was harder. A safety check that read only button labels approved 27 of 48 real-site charges and sign-ups. Feeding it the page's accessibility tree took that to zero, at a median cost of 5.7 seconds per submit.

If your agent can act, its permissions belong where a test can fail.

REPO_URL

## Show HN

Title: Show HN: A Claude Code assistant whose write policy is a hook, not a prompt

Body: This is the repo behind my personal assistant: it reads mail, calendar, and the web, and sends me a brief on Telegram. Mail is untrusted input, so every tool call goes through a PreToolUse hook that allows drafts, labels, and calendar holds, denies trash and Slack or Notion writes, sends only calendar invites to stated contacts, and deletes an event only on an explicit ask, with 346 tests on that hook alone. Browser submits wait on a second model that judges the page's accessibility tree (0 of 48 real-site charges approved, versus 27 when it saw only labels). No dependencies: Node scripts, systemd timers, a headless `claude -p`, and Markdown memory with an enforced grammar. The screenshots use invented data. REPO_URL

## Bluesky

An email told my assistant to "ignore all previous instructions." The model never had a vote: a PreToolUse hook denies the send before it runs, and 346 tests say so. REPO_URL [img/injection-denied.png]
