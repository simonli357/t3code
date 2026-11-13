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

A master that starts a worker gives two scores, difficulty and stakes, the computer, and its
estimate of the job's length in hours. T3 then picks the account, model and effort together:

1. The table on the [Model selection](#model-selection) page gives the wanted model and effort.
2. Every usage limit of each account (5-hour, weekly, or a model's own weekly window such as
   Fable's) is projected to the job's end: every working session on that login on any computer
   at its own model, effort and context, masters at their lower rate, idle sessions not at all,
   plus the account's use outside T3. An account **fits** when no limit runs out before the job
   ends; a hard cap counts as the limit.
3. Among accounts that fit, those within their **daily goal** come first, then the one with the
   most spare capacity per hour until the tightest limit resets. Between accounts within the
   **closeness margin** (percent of the best one's room), the earlier one in the **preference
   order** wins, then the one with fewer workers, then the one that resets sooner. Accounts over
   their goal are used only when none is within it, the least over first.
4. When the model fits nowhere, the start waits for a limit that resets within 30 minutes
   (45 at stakes 8 or more); otherwise it takes the nearest ladder model that fits, at most two
   rungs away; otherwise, below the fallback's threshold, the **fallback** model; otherwise the
   wanted model on the account that lasts longest. It is refused only when every account is
   really out, with the earliest reset time. Codex is used only when a start asks for it and
   never changes model.

The result names the choice, the table's choice when it differs, when a waiting start begins,
one reason line with the numbers (for example "XY: room for about 3 more Fable-medium workers
until the weekly reset; tightest limit Fable weekly"), and one line per account. A model the
user named is the starting point and is replaced the same way. An account the user named is
exact: when the model is used up there, the start is refused.

A **daily goal** is the share of the weekly (or monthly) limit an account should use each day.
Without one, an account uses its provider's default. A goal only changes which account is
recommended: it never stops, queues or changes a start, and a pinned account over its goal starts
normally. Only a hard cap or a real limit stops work.

**Fable workers** is one switch. Turned off, no worker runs on a Fable model: a table entry or
pin that names Fable starts from the nearest ladder model without it, and a running worker never
moves onto it. The result says so.

A running worker that hits a limit moves to another account with the same model that lasts the
rest of its job. If there is none, it waits when the reset is within the **long wait** time
(3 hours unless changed); otherwise it continues on the nearest model that fits, at most two
rungs away, and its master is told. A worker that supervises its own workers only waits.

The numbers behind these choices are learned, not set: what an hour of work costs at API prices
for each model, effort and context, and how much of each account's limit a dollar of use takes,
including use T3 does not see. Every computer records its turns and the limit readings it
already fetches; the coordinator learns from all of them and sends the result to every computer.
A model or account without enough history uses an estimate scaled from a measured one, marked
as estimated.

Open **Settings > Provider allocation** for the accounts: each one's usage windows with their
resets, what each limit holds, how long the account lasts at the current load, its workers now,
whether workers may use it, its daily goal and its hard cap; then the preference order, the
closeness margin, the long wait, the Fable switch, and the learned numbers with their sample
counts. Choose one shared coordinator and keep it reachable: it holds the settings and decides
every start. Every value is stored there, so a change made on any computer applies to the next
start on every computer, without a restart. Every computer keeps a copy of the settings and
learned numbers the coordinator last sent; while the coordinator cannot be reached, a start is
decided on the requesting computer from that copy, and the result says how old it is. A decision
first refreshes usage readings older than the policy allows, for at most a few seconds. Agents
that were not told which computer to use read each computer's numbers first; see
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

The page is one lookup table per provider, on separate Codex and Claude tabs. Columns are
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

Edits are marked until you save, which creates a new policy version used by the next start on
every computer. If another editor saves while you are editing, keep your edits on top of the
newer version or discard them. Existing sessions and assignment retries retain their selections.

Score the scoped assignment on two integer axes from 0 to 10. Difficulty measures reasoning,
uncertainty and interactions. Stakes measures failure impact, reversibility and detectability.
Use 0–3 for routine/low, 4–6 for moderate, 7 for demanding/high, 8 for very demanding/very
high, 9 for extreme, and 10 only for exceptional assignments.

**Test an assignment** previews the choice for a pair of scores with your unsaved table: the
account, model and effort, the table's choice when it differs, and the reason. **Policy
settings, versions and raw JSON** holds reverts and the raw policy.

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
