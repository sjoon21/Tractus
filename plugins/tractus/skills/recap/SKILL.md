---
name: recap
description: Recap the user's meetings over a period — decisions, open action items with owners and due dates, and anything still undecided — from Tractus notes.
argument-hint: "[period, e.g. 지난주 | this month | 2026-10-01..2026-10-15]"
disable-model-invocation: true
---

# Meeting recap: $ARGUMENTS

Build a recap of the user's Tractus meetings for the period in the arguments (default: the last 7 days). Work out concrete `date_from`/`date_to` dates from today's date.

1. `list_meetings` for the period. If there are none, say so and stop.
2. `list_action_items` for the same period; for meetings without a summary, skim them with `get_transcript` (first and last pages) or `search_meetings` for "결정", "하기로", "decided", "by Friday".
3. Write the recap in the user's language:
   - **Decisions** — one line each, with `(meeting title, HH:MM:SS)`.
   - **Action items** — task · owner · due, grouped by owner; mark ones past due.
   - **Still open** — topics postponed or disagreed on.
   - Meetings in the period (title · date) at the end.

Cite every line. Do not invent owners or dates that the notes don't state.
