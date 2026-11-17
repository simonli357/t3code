# Runway allocation

Worker starts choose account, model and effort by projecting every usage limit to the job's end
from numbers the coordinator learns itself (`apps/server/src/allocation/learning.ts`,
`runway.ts`). The decisions below are the ones the code alone does not explain.

**Claude's cost is cumulative, also across a resume.** The SDK's `total_cost_usd` is the
session's running total, and a resumed query carries on from its earlier turns. `ClaudeAdapter`
keeps the total in the resume cursor and reports the difference as `turnCostUsd`, which includes
subagents; a resumed session whose cursor has no total reports none. Until the cursor kept it,
each resumed session's first turn carried the whole running total, which made T3's spend look
three to five times what it was. Learning prices a turn without subagents from its own tokens and
`usage-model-rates.json` (within about 10% of the SDK's figure), and takes the SDK's figure only
for turns with subagents, whose use `result.usage` leaves out. Other providers' turns are priced
from their tokens.

**Outside use is what a limit does while T3 leaves it alone.** Outside use per hour comes from
the reading pairs in which T3 spent nothing on the window, split by quarter of the UTC day once
that idle time covers every quarter; T3's share per dollar is the rest of the movement in the
other pairs over T3's spend in them. A joint fit of both against spend and hours could not tell
them apart under a steady load, and shrank the share whenever spend landed a few minutes off its
pair. Without idle time outside use is not seen and counts as none, so use T3 cannot see while
it works lands in the share and the limit looks smaller, never larger. A login's readings count
from when every computer reporting it started measuring, and the turn cap drops a computer's
readings together with its turns. Every computer reads every login, so the readings form one
series: one a point or two below the last is rounding, a larger drop in the same cycle is a reset
credit, and pairs that start or end at 100% are left out because a full window shows no use.

**A new allowance restarts learning.** A plan label change, or a window whose length changed
(a weekly Codex limit that became monthly), discards the readings before it.

**A learn never replaces better numbers with worse ones.** A computer that has just started
reaches its linked computers late, and a learn that cannot read one counts all of that
computer's work as outside use: on 2026-11-17 such a learn made a Max 20x week hold $163. So a
learn that could not read every linked computer's history keeps the stored numbers, and one
resting on under half their turns or measured limits keeps them for up to a day. A measured size
more than three times above or below what its plan suggests (the other measured accounts' size
per plan unit, or the seed with fewer than two) is set aside for the plan's estimate.

**Unmeasured means estimated, never a default.** A missing model is repriced from a measured
model's token mix. A thin one (under 20 turns or 10 working hours) is blended with that estimate
in proportion to its evidence, at the blended context, so half an hour at small context cannot
undercut the model above it. A missing account takes a measured account's share, scaled by plan
tier: the SDK reports only "Claude Max", so the tier comes from the login record's
`rateLimitTier` (never anything else in that file), and Max 20x (now Ultra) is 20 Pros per five
hours but 10 per week and per Fable limit. Unknown sizes count as equal. The seeds in
`runway.ts` are for an install that has learned nothing at all.

**Every computer keeps a copy.** The coordinator's policy, model policy and learned numbers are
stored on each computer (`allocation_policy_copy`) whenever they change and at most every
10 minutes otherwise. A computer that cannot reach the coordinator decides from that copy, also
after a restart, and says how old it is. Older builds never ask for learned numbers: `caps`
carries `learnedAt` only from this build, and the coordinator answers only when it has newer ones.

**A goal ranks, it never refuses, and in points.** Accounts that fit rank by how far their
tightest paced window (weekly, a model's own weekly, monthly) is behind its goal line at the
job's end. Dollars of room multiplied slack by learned size, so large plans won regardless of
goals; sizes only project use. The order never lifts one ahead of its goal over one behind.
Goals count the meter's total. Stored family values (`claude`, `codex`, `other`) are the
defaults and are carried through every save, including saves from builds that do not know them.

**The Fable window has its own line, and it only adds Fable.** Fable's weekly limit runs out at
its own pace, so on the account's goal it counted as on pace while it would run out in days. An
account's Fable goal (`fableGoals`) is that window's line instead. It also puts the account in
Fable mode for an unpinned worker start, judged once before the choice (`chooseProfile`) on the
Fable rung the table entry starts from: at or behind the line, and only when that rung fits
there (not drained, not rejected, lasting the job). The fit condition is what keeps the goal from
refusing, queueing or delaying a start, since an account in Fable mode lets only Fable rungs stand
in. Judging once keeps the set of Fable-mode accounts fixed while the choice steps through waits
and stand-ins, as the stored list (`fableAccounts`) is. A pin is never judged.

**The master's computer chooses the worker's computer.** A worker start without `environmentId`
is placed by the requesting server before any account is chosen (`placement.ts`), because accounts
are judged per computer. Free memory lags a start by minutes, so each computer reports when its
working sessions were created (`recentStarts` in a placement read), and the requesting server
also remembers its own placements in memory until that computer reports them. Two masters on
different computers that start in the same few seconds can still both see the same room; the
next read corrects it. An account choice is previewed on each candidate before one is reserved:
a stored decision binds its assignment ID to one computer, so trying a second computer with a
reserving call would be refused as a conflict. A retry stays on its first computer, from the
remembered placement or the worker record. A computer on a build without `recentStarts` is not
chosen automatically, since its starts cannot be counted.

**Free memory at one instant is not room.** One reading of free memory does not show what the sessions already on a computer do, and no
server samples memory between reads (the Computers page keeps a history only while it is open).
So room also loses a stored reserve per working session, and a computer whose placement read
finds a recent `runtime.error` activity with code `oom_kill` ranks after every other one. Only
Linux records those kills (`agentScope`). Worker memory is a stored value, not
learned: resource telemetry measures T3's own process tree, not memory per session.
