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

Open **Settings → Provider allocation** to preview which account can safely run a new assignment
with your chosen model, reasoning options and execution computer. Allocation starts in
**Observation** mode: it records the proposed choice without starting a session. Choose one
linked environment as coordinator and connect every participating environment to it. The
coordinator must remain reachable; missing host or quota readings prevent automatic admission.

Preview policy changes before saving. **Automatic** mode lets you start a new session from the
allocation page, or let an agent create an allocated worker. Existing threads, forks and retries
keep their selected account. Stop or cancel ongoing work before releasing its capacity; unused
reservations expire automatically.

Claude's sustainable preset spreads usable allowance across its reported cycle. The aggressive
17-points-per-day preset can run out before seven days. Codex defaults to an initial 30-point
allowance plus 10 points per elapsed day. Reserves and bounded borrowing protect ongoing work;
weekly underuse never overrides an unsafe short window. Temporary use-by targets expire, and
reset plans do not replenish quota until the provider confirms it. Allocation never redeems
reset credits or enables paid overage.

A provider rejection remains blocked until that window reports recovery or fresh readings confirm
its reset. Older errors without a recorded reset recover after fresh readings confirm that all
reported allowance cycles began after the error; the old conversation can stay failed. Refresh
provider usage after replenishment. Completing work does not renew borrowed allowance: consumed
usage and pending work both count against the target plus borrowing.

If worker creation is definitively refused before startup, inspection releases its reservation.
Correct the request and create a new assignment. A lost response stays reserved until the execution
computer can confirm what happened.

Forecasts show their freshness and sample coverage. Sparse evidence uses conservative estimates;
token costs are not subscription percentages. History charts are available only for accounts
already opted into retained usage measurements. Native mobile supports inspection and assignment
preview; use the linked web page for tuning, charts and creating sessions.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. T3 cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Cursor reports
its monthly allowance, including separate Auto and API usage, using the CLI login or
`CURSOR_AUTH_TOKEN`. On macOS, this includes the default Keychain login after you enable Cursor
usage. Keychain login is used for limits only with Cursor's default API endpoint. If you configure
a custom Cursor endpoint, use an explicit token or file-based CLI login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

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
