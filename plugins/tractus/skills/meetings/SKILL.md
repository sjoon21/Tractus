---
name: meetings
description: Load this before using the tractus MCP tools or answering anything about the user's past meetings, calls, interviews or notes (what was said, decided, promised or assigned, and when) — it explains how to search and how to cite for a human reader. Triggers include "the meeting", "last week's call", a decision or deadline, "check my notes", and Korean like 회의, 미팅, 지난주에 정한, 할 일, 노트에서 찾아줘.
---

# Tractus meeting memory

Tractus keeps the user's meetings and notes on their Mac: transcripts (who said what, with timestamps), the user's own memos, summaries, completed notes and action items. The `tractus` MCP server gives read access; it never calls an AI service itself.

## How to answer

1. **Search first, then answer.** Call `search_meetings` with the key terms (try the user's wording and a synonym or two; Korean and English both work). Use `date_from`/`date_to` when the user gives a period ("지난주", "last month"). For "what did we decide/assign", also call `list_action_items` or `get_summary`.
2. **Read around the hit before concluding.** Use `get_transcript` with an `offset` near the matching segment when the snippet alone is ambiguous (a decision is often revised a few lines later).
3. **Cite every claim for a human.** Tool results mark evidence as `[<meeting_id>#s0012 00:05:31]`; that format is for you. In your answer, rewrite each as the note title and time, e.g. `(3분기 예산 계획 회의, 00:01:56)` — look the title up from the search result or `list_meetings`. Memo lines are cited as `메모 n번째 줄`. Never show meeting IDs or segment IDs like `s0012` to the user.
4. **Say so when it isn't there.** If the search finds nothing relevant, say that the notes don't mention it — do not fill gaps from general knowledge. If `status` shows zero notes or an empty index, tell the user to open the Tractus app (it indexes notes) or run `tractus index`.
5. Answer in the user's language. Speaker names are the ones the user confirmed in Tractus; generic labels like `참석자 2` mean the speaker is unknown.

## Writing

`save_summary` is the only write tool. Use it only when the user explicitly asks you to write or update a meeting summary, and every item must carry the evidence segment IDs the tool requires.
