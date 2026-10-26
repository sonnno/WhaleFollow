# 智能暫停 / Smart pause

跟單任務操作欄 / Copy task actions:

- 智能暫停 / Smart pause: freezes the events with unsettled holdings at activation. It continues buys in those events, including sibling markets, and blocks new events. Temporary sell-outs do not remove retained events. Official parent event closure fences all its markets; a single half or additional-markets child closing does not close the parent match.
- 全部暫停 / Pause all buys: stops every further buy, including existing events.
- 開始跟單 / Start following: exits smart pause or resumes from full pause. Smart-mode exit retains the current task generation, event-ratio history and join time.

持倉繼續跟賣與結算。新比賽跳過時不產生訂單；智能暫停範圍會儲存，重新啟動不會遺失。

Existing holdings continue to follow sells and settle. Excluded new-event signals create no orders. Task funds, order limits, copy percentages and event-specific percentage locks remain unchanged.

Authenticated control API:

```http
POST /api/follow-tasks/:wallet/control
Content-Type: application/json
X-Requested-With: XMLHttpRequest

{"action":"smart_pause"}
```

Use `pause` for all buys, `start` to resume. Repeating `smart_pause` keeps the same frozen list. List responses retain `state: "running"` while draining and expose `smartPause: {id,at,events}`; full pause uses `state: "paused"` with `smartPause: null`. The UI shows the human-readable smart-pause status.

A completed buy may finish bookkeeping after a control switch. Its receipt is recorded without re-execution and its event is retained for smart draining. This does not replay old failed orders.
