# Runway allocation

Worker starts choose account, model and effort by projecting every usage limit to the job's end
from numbers the coordinator learns itself (`apps/server/src/allocation/learning.ts`,
`runway.ts`). The decisions below are the ones the code alone does not explain.

**Claude's cost is cumulative.** The SDK's `total_cost_usd` is the query's running total and
restarts on resume or `/clear`; `ClaudeAdapter` reports the difference as `turnCostUsd`, which
includes subagents. `result.usage` is the main agent's alone, so pricing it undercounts.
Other providers' turns are priced from their tokens and `usage-model-rates.json`.

**Outside use absorbs what T3 cannot see.** A limit is fitted as change in percent = share × T3's
spend + outside use × hours, with both kept at or above zero. Use from other people, the CLI,
or a computer still on an older build lands in outside use, never in the share per dollar. The
share is therefore only as good as the fraction of an account's use T3 records; every computer
running this build closes the gap. Outside use is split by quarter of the UTC day once each
quarter has enough reading pairs.

**A new allowance restarts learning.** A plan label change, or a window whose length changed
(a weekly Codex limit that became monthly), discards the readings before it.

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

**A goal ranks, it never refuses.** Daily goals are measured against the meter's total. Stored
family values (`claude`, `codex`, `other`) are the defaults and are carried through every save,
including saves from builds that do not know them.
