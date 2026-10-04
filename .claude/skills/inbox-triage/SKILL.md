---
name: inbox-triage
description: Classify unread mail, label it, and prepare reply drafts.
---

1. Read unread Gmail threads and classify each as `reply`, `read`, or `ignore`.
2. Find labels `assistant/reply` and `assistant/read`; create either label if it is missing.
3. Apply `assistant/reply` to reply items and `assistant/read` to read items.
4. Draft replies only for reply items, using the `draft-as-john` skill.
5. Add a follow-up task through the `tasks` skill's capture rules for every reply item that has none yet.
6. Report a table with thread subject, class, and whether a draft was created.
