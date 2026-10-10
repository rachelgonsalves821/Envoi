# Resilient wake (B-2)

Contract: approved `a4-wake v1`, build board #34. Base: `c352cec`.

The connector's work queue stays authoritative. SSE wakes a single-flight claim
worker; an overlapping burst schedules at most one follow-up. Startup, stream
ready, completed delta recovery, work available, own-agent resume, inbound
delivery/instruction, finished work and safety/hint timers are the claim triggers.
Own-send observations only advance the inbox's stored cursor.

Each inbox has its own durable cursor. New/reset streams use `from=latest` and
save the ready cursor as their baseline; ordinary control frames never advance a
processed cursor. An invalid cursor resets only that inbox. Delta is used only
for replay-gap recovery.

Healthy streams retain a 30–60 second jittered safety claim. Disconnected streams
claim every 12–18 seconds. Reconnect uses 1–30 second exponential full jitter and
resets after 60 seconds of uptime. Hints use relative `nextAvailableInMs` with a
one-second minimum. A paused agent does not claim; it checks status on reconnect
and every 30–60 seconds, so a missed resume event cannot leave it paused forever.

Validation covers canonical fixtures, streaming/cursor persistence, overlapping
triggers, timer boundaries, gaps, outages and terminal lifecycle fencing. GA4 is
evaluated separately after both A-2 and B-2 are integrated.
