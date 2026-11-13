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

A master that starts a worker gives two scores, difficulty and stakes, and the computer. T3 then
picks the account, model and effort together:

1. The table on the [Model selection](#model-selection) page gives the wanted model and effort.
2. That model runs on the account with the most room: the percentage left on the tightest usage
   window that applies to the model (5-hour, weekly, or a model's own weekly window such as
   Fable's). Between accounts whose room is within the **closeness margin**, the earlier one in
   the **preference order** wins, then the one with fewer workers, then the one that resets
   sooner. The order never overrides a clear difference.
3. A model is **drained** on an account when one of those windows is used up, the provider's
   recorded limit rejection is still in force, or the account's hard cap is reached. Nothing
   softer counts: a forecast or a nearly full window never changes the model.
4. When the wanted model is drained on every account, the nearest model on the **ladder** that
   has room replaces it; a tie goes to the weaker one. When no Claude model has room, work whose
   wanted model is below the fallback's threshold starts on the **fallback** model, and anything
   else is refused as drained, with the earliest reset time. Codex is used only when a start
   asks for it and never changes model.

A model the user named is the starting point and is replaced the same way. An account the user
named is exact: when the model is drained there, the start is refused. The result names the
choice, the table's choice when it differs, one reason line and one line per account.

A running worker that hits a limit moves to another account with the same model. If there is
none, it waits when the reset is within the **long wait** time (3 hours unless changed);
otherwise it continues on the nearest model with room and its master is told; otherwise it waits
and its master is told. A worker that supervises its own workers only waits.

Open **Settings > Provider allocation** for the accounts: each one's usage windows with their
resets, its workers now, whether workers may use it, its hard cap, and the preference order.
The closeness margin and the long wait are set there too. Choose one shared coordinator and
keep it reachable: it holds the policy and decides every start. Every value is stored there, so
a change made on any computer applies to the next start on every computer, without a restart.
While the coordinator cannot be reached, a start is decided on the requesting computer from the
policy it last read. A decision first refreshes usage readings older than the policy allows, for
at most a few seconds. Agents that were not told which computer to use read each computer's
numbers first; see [Choosing a computer for agent work](computers.md#choosing-a-computer-for-agent-work).

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
or custom model provider, do not offer caps and have no room reading; they are used only when
nothing with a reading is close.

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

Collection is off by default. Set the server's `usageMeasurementInstanceIds` to
the provider instance IDs you own; leave shared accounts out. Removing an instance
also removes its retained measurements. History starts at installation, is bounded
to 14 days/5,000 turns/30,000 quota changes, and survives server restarts. No prompts,
responses, tool arguments, or credentials are stored by this collector.

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
