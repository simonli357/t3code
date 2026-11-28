# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, and Cursor history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost. These estimates are not your subscription bill.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including T3-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on the
server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's dashboard API using the CLI login saved on the server.
This includes headless T3 sessions and desktop usage across machines; the same account counts
once across connected environments. Without an accessible CLI login, T3 shows a
notice instead of incomplete local totals. T3 does not estimate missing tokens from conversation text.
On macOS, choose **Enable Cursor usage** on Usage to allow T3 to read your existing CLI login
from Keychain. You can turn it off in **Settings → Providers → Usage providers**. macOS may ask
you to allow access on the server Mac.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Use absolute paths or `~/` paths in the account's environment settings; relative
environment paths depend on each project's working directory and cannot be reliably discovered
by Usage. Accounts sharing a history directory count once.

When your app and server support different providers, usage totals may cover only the providers
your app understands. Update the app to include newly supported providers.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Allocate accounts for new work

A master that starts a worker gives two scores, difficulty and stakes, and its estimate of the
job's length in hours. T3 picks the computer (see
[Choosing a computer for agent work](computers.md#choosing-a-computer-for-agent-work)) unless
the master names one, and then the account, model and effort together:

1. The table on the [Model selection](#model-selection) page gives the wanted model and effort.
2. Every usage limit of each account (5-hour, weekly, or a model's own weekly window such as
   Fable's) is projected to the job's end: every working session on that login on any computer
   at its own model, effort and context, masters at their lower rate, idle sessions not at all,
   plus the account's use outside T3. An account **fits** when no limit runs out before the job
   ends; a hard cap counts as the limit. A Codex account whose limit is used up but which has
   ChatGPT credits can run on them: they cover the job when they pay for its use past the limit,
   at 25 credits a dollar unless an agent changes `creditsPerDollar`, and its line says how many
   are left. Credits never pay past a hard cap, and an account Codex refuses stays out.
3. Among accounts that fit, the one furthest behind its **daily goal** wins, in points of its
   tightest weekly window at the job's end; an account's Fable window is measured against its
   **Fable goal** when it has one and weekly pacing is off. Among those on its side of the goal within the
   **closeness margin** (points), the **preference order** decides, then fewer workers, then
   the sooner reset. Accounts without a goal line follow, by points left. An account that would
   spend credits on the job comes after all of these, the one with the most left after it first,
   and before accounts whose limit runs out.
4. When the model fits nowhere, the start waits for a limit that resets within 30 minutes
   (45 at stakes 8 or more); otherwise it takes the nearest ladder model that fits, at most two
   rungs away; otherwise, below the fallback's threshold, the **fallback** model; otherwise the
   wanted model on credits; otherwise on the account that lasts longest. A pinned account on
   credits starts at once. When every account is out now but a limit
   resets within that wait, the same choice is made as of the reset and the start waits for it.
   It is refused only when everything stays out beyond the wait, with the earliest reset time.
   A Codex account never changes model.
5. A start that names no provider family ranks the Claude and Codex accounts that are on for
   workers together, each on its own family's table entry, and each account line names the
   model it was judged on. A start that asks for one family looks at that family only.

The result names the choice, the table's choice when it differs, when a waiting start begins,
one reason line with the numbers (for example "ARA: 35 points behind its goal (Weekly 16% used,
18% by the job's end against a goal of 53%)"), and one line per account. A model the user named
is the starting point and is replaced the same way. An account the user named is exact: when the
model is used up there, the start is refused.

A **daily goal** is the share of each weekly (or monthly) limit an account should use each day.
Without one, an account uses its provider's default. A goal only changes which account is
recommended: it never stops, queues or changes a start, and a pinned account over its goal starts
normally. Only a hard cap or a real limit stops work.

**Keep Fable in step with weekly** compares each Claude account’s Fable and Weekly percentages
at the projected end of an unpinned worker’s job, assuming it starts on the Fable rung. At or
below Weekly, the account runs in Fable mode. Ahead of Weekly, it keeps a non-Fable table entry
or replaces a Fable entry with the nearest available non-Fable rung, preferring the stronger
rung on a tie. Each account’s decision line shows both projections and its rung. A model or
account pin keeps its usual behavior. Accounts without a Fable reading use the usual rules.

The switch defaults to off. Turning it on suspends saved **Fable goals**. With it off, a
Fable goal sets the daily target for the account’s Weekly · Fable limit. An unpinned model
starts in Fable mode when it would finish at or behind that target and fits on the account.
Otherwise the table entry applies. Without a Fable goal the account’s daily goal applies to
the Fable limit.

**Fable workers** is one switch. Turned off, no worker runs on a Fable model: a table entry or
pin that names Fable starts from the nearest ladder model without it, and a running worker never
moves onto it. The result says so.

Claude Pro accounts run the nearest available ladder rung for a Fable table entry. A tie goes to
the stronger rung. Pinning a Fable model excludes Pro accounts.

**Fable mode** is a switch on each Claude account. On accounts with Fable access, turning it on
applies Fable mode unless the weekly comparison selects the rung for this start. A worker in
Fable mode starts on the first Fable rung at or above its table entry. If that rung has no room,
only another Fable rung can stand in. When
that account's Fable limit is used up, it takes no workers until the limit resets. A worker on any
other account gets the table's choice as usual. Each account is judged on the model it would run
there, so the account furthest behind its goal still wins; the result shows the table's choice
when it differs and names the account's Fable mode. A model you pin for one worker is kept, with a
note.
Turning an account's Fable mode on turns Fable workers on; turning Fable workers off turns every
account's Fable mode off, including what a Fable goal would turn on.

A running worker that hits a limit moves to another account with the same model that lasts the
rest of its job. If there is none, it waits when the reset is within the **long wait** time
(3 hours unless changed); otherwise it continues on the nearest model that fits, at most two
rungs away, and its master is told. A worker that supervises its own workers only waits. A worker
on an account running on its credits stays where it is until Codex refuses a turn. **Usage →
Limits** shows an account's credit balance as a Credits row.

The numbers behind these choices are learned, not set: what an hour of work costs at API prices
for each model, effort and context, and how much of each account's limit a dollar of use takes,
including use T3 does not see. Every computer records its turns and the limit readings it
already fetches; the coordinator learns from all of them and sends the result to every computer.
A model without history is estimated from a measured one by price; one with only a little
history is marked thin and leans on that estimate until it has enough turns and hours. An
account without history is sized from a measured one by plan tier (Pro, Max 5x, Max 20x), marked
as estimated, until its own readings replace it.

Open **Settings > Provider allocation** for the accounts, most preferred first. Each account is
one line: its limits with the percent used and the time to the reset, whether workers may use it
and how many run, its Fable mode, its daily goal, its Fable goal and its hard cap. Hover a limit
for when it was read, what it holds and what its goal allows by now (the Fable goal on the Fable
limit when one is active). A line under the limits appears only
when the account takes no more work or soon will not, and names the limit or the hard cap that
is the reason. The arrows change the preference order. Below are the close-call margin, the wait
for a reset and both Fable switches, and, folded, the five values behind the choice of
computer, the learned numbers with their sample counts, and the **Settings computer**.

The page has no Save button. A switch or a move in the order is stored at once, a typed number
when you pause or leave its field, and a hard cap only when you leave its field, since a
half-typed cap could stop running work. The page says Saved, or Not saved with the reason and
a mark beside the value, and offers to try again or drop the change. A change made meanwhile on
another computer or by an agent is kept: yours is applied on top of it, and when both changed
the same value the page asks which one to keep.

Choose one shared coordinator under **Settings computer** and keep it reachable: it holds the
settings and decides every start. The saved settings show at once; accounts and usage fill in as
each computer answers. Every value is stored there, so a change made on any computer applies to
the next start on every computer, without a restart. Every computer keeps a copy of the settings and
learned numbers the coordinator last sent; while the coordinator cannot be reached, a start is
decided on the requesting computer from that copy, and the result says how old it is. A decision
first refreshes usage readings older than the policy allows, for at most a few seconds. The
computer a worker starts on is chosen by the server too, from five more stored values; see
[Choosing a computer for agent work](computers.md#choosing-a-computer-for-agent-work).

Optional **hard caps** apply per account identity. Weekly caps use the provider's
account-wide weekly window; Claude accounts also support its 5-hour session. Enter a percentage
and choose whether reaching it stops workers, masters, or both. Blank fields are disabled. A fresh
reading at or above the cap is checked immediately and at least every 15 seconds, and blocks new
turns on that account, including queued, scheduled, renewal, and notification-triggered ones.
Turns that are already running finish. Stopping a worker leaves one notice for its owning master.
A capped account counts as drained for new workers. Turning both block actions off keeps the
threshold saved but inactive. The cap remains latched until the provider window resets, a newer
reading is below the cap, the cap is raised or removed, or both block actions are disabled.
Missing, unsupported, or stale readings are shown honestly and cannot create a new hard stop; they
also do not imply zero usage.

Accounts whose provider proves that subscription quota does not apply, such as an API-key-backed
or custom model provider, do not offer caps and have no limit reading; they come after accounts
with a reading.

Agents read and change the same values with the `t3_allocation_policy` tool. A limit on how many
workers a master may run is not stored in T3: the master that was given it keeps to it.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Model selection

Open **Settings → Model selection** beside Provider allocation, or find it through
Settings search or the command palette. Choose the shared coordinator in Provider
allocation first.

The page is one lookup table per provider, on separate Claude and Codex tabs; it opens on
Claude. Columns are
an assignment's difficulty and rows are its stakes, each scored 0–10. Each cell is the model
and reasoning that assignment wants, for example difficulty 7 with stakes 8. Select a cell,
then change its model or reasoning, or set an alternative that is used only when no account on
the computer offers that choice. The table's model list takes any model ID, typed or picked
from what connected accounts advertise. A model no connected account offers is saved with a
warning, never refused, so a model can be set up before its account is connected.

Below the table are the **ladder**, the Claude models and efforts from weakest to strongest
that stand in for a drained model, and the **fallback**: the model and effort used when no
ladder model has room, and the ladder entry below which it applies. Turn the fallback off to
refuse such starts instead.

Every change is stored as you make it, as a new version used by the next start on every
computer; quick changes to the table are stored together. A cell that is not stored yet is
marked, and a save that fails says why and offers to try again or drop the change. A change
saved meanwhile by another editor is kept: yours goes on top of it, and when both changed the
same cell or setting the page asks which one to keep. Existing sessions and assignment retries
retain their selections. In a narrow window a cell shows a letter for its model and two for its
reasoning; the legend and the editor above the table spell them out.

Score the scoped assignment on two integer axes from 0 to 10. Difficulty measures reasoning,
uncertainty and interactions. Stakes measures failure impact, reversibility and detectability.
Use 0–3 for routine/low, 4–6 for moderate, 7 for demanding/high, 8 for very demanding/very
high, 9 for extreme, and 10 only for exceptional assignments.

**Try a task** shows what an agent's start would get for a difficulty, stakes and job length in
hours, using the table shown on the tab you are viewing: the account, model and effort, and
the reason. **Earlier versions** is the undo for the table: it goes back to a stored version or
to the built-in table, saved again as the newest version.
**Recent decisions** lists the starts agents made: when, their scores, the account, model and
effort chosen, and why.

Agents use the same choice through `t3_allocate_account` (preview) and
`t3_start_allocated_assignment`, and edit the table, ladder and fallback with
`t3_allocation_policy`. Native mobile edits the same policy in **Settings → Model selection**.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while T3 is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen T3 to refresh expired readings.

## Measure worker capacity

The custom build provides the read-only `t3_usage_measurements` agent tool and
`GET /api/orchestration/usage-measurements`. Both report context size, session age,
turn and tool duration, provider API time when available, token/cache totals, and
recent account quota consumption. Optional filters are `instanceId`, `threadId`,
`lookbackHours` (1–336), and `turnLimit` (1–100).

Every configured account is recorded, from the turns T3 runs and the limit readings it already
fetches; nothing is polled for it, and account allocation learns from it. History starts at
installation, is bounded to 14 days/5,000 turns/30,000 quota changes, and survives server
restarts. No prompts, responses, tool arguments, or credentials are stored by this collector.

Quota rates include all traffic on an account, including other machines. Per-model
token baselines are grouped by effort and context size; they are not subscription
percentages. Session age includes idle time, and non-tool wall time is not model
compute time. Missing or stale observations do not produce quota forecasts. The
tool supplies evidence; it never assigns work, changes accounts or redeems resets.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
