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

Open **Settings > Provider allocation** for account recommendations using your chosen model,
reasoning options and computer. Quota, pacing, reserve and load forecasts are advisory.
You or your master decide whether to start; warnings never veto a compatible explicit choice.
A recommendation does not promise that the provider will accept or complete the work.

Preview starts nothing. **Start** submits the selected profile, including when an older saved
policy says Observation. Actual unsupported profiles, ownership conflicts, unavailable execution
connections and provider authentication/quota failures remain errors. Choose one shared coordinator
for durable assignment accounting and keep it reachable; missing readings from other hosts are
warnings. While the coordinator cannot be reached, or runs a version that cannot read the request,
a start is decided on the requesting computer from its own readings and the policy it last read
from the coordinator, so account rules still apply, and records that warning. A computer that has
not read the policy since its server started records that account rules were not checked. A recommendation first refreshes quota readings older than the policy allows, for
at most a few seconds. Existing threads, forks and retries retain their selections. Agents that were not told
which computer to use can compare them first; see
[Choosing a computer for agent work](computers.md#choosing-a-computer-for-agent-work).

The page opens with the **Accounts** table: one row per account that can run workers, the same
login on several computers counted once. Each row shows the account's usage now (weekly and
5-hour percent when the provider reports them, with the age of the reading) and every value you
can tune for it, editable in place: whether workers are allowed, the most concurrent workers, the
priority, the budget, the hard cap, and the end time and note of each rule. Accounts whose
provider is turned off, or that report no subscription quota and have nothing saved, are folded
into **Other accounts** below the table; they can still be given a rule there.

**Family defaults** sit under the table. Each number is a percentage of the provider's weekly
allowance: the initial budget plus the daily budget builds a target from the weekly reset, capped
below the reserve, and the borrowing allowance is how far projected use may exceed the target
before a warning. Codex defaults to 30% initially plus 10 points per 24 hours since reset; Claude
defaults to 0% initially plus 17 points per 24 hours, which can use a weekly allowance before
seven days. Existing saved policies keep their values, including cycle-based pacing, until you
edit or reset them.

An account follows its family's budget unless you type an initial or daily budget in its row.
That is a **temporary budget** for that account's weekly windows: it ends by itself at the time
shown, by default the next weekly reset, and **Use family default** ends it at once. It needs a
known login and a weekly usage reading.

Each family can also have a **default worker model**: a model and effort, with an optional end
time and note. A worker start that names no model then uses it instead of the difficulty/stakes
table on the [Model selection](#model-selection) page, even a model the table never chooses, and
after the end time the table applies again. A start that names its model, and sessions you start
yourself, are unaffected.

Use **Save settings** to apply changes; no assignment preview is required. **Reset to defaults**
changes the draft, then Save applies it. Reconnecting keeps unsaved edits. If someone saved a newer
version, **Reload saved settings** discards your old draft explicitly.

Optional **hard caps** apply per account identity. Weekly caps use the provider's
account-wide weekly window; Claude accounts also support its 5-hour session. Enter a percentage
and choose whether reaching it stops workers, masters, or both. Blank fields are disabled. A fresh
reading at or above the cap is checked immediately and at least every 15 seconds, and blocks new
turns on that account, including queued, scheduled, renewal, and notification-triggered ones.
Turns that are already running finish. Stopping a worker leaves one notice for its owning master. A worker assignment headed
for a capped account moves to another account of the same provider that has headroom; otherwise it
stays queued and starts by itself when the cap no longer applies. Turning both block actions off
keeps the threshold saved but inactive. The cap remains latched until the provider window resets, a
newer reading is below the cap, the cap is raised or removed, or both block actions are disabled.
Missing, unsupported, or stale readings are shown honestly and cannot create a new hard stop; they
also do not imply zero usage. Raising a cap or waiting for a reset makes the account eligible
again, and held worker assignments start within about half a minute.

A transient provider quota read failure keeps an already reached cap enforced until its reported
reset, a below-cap verified reading, or a configuration change. A failed read cannot create a new
crossing on its own.

Accounts whose provider proves that subscription quota does not apply, such as an API-key-backed
or custom model provider, do not offer these controls. Cached subscription windows from another
login are ignored rather than borrowed by that account. Caps also stay inactive while the quota
source cannot be verified, rather than assuming a subscription applies.

**Account rules** are standing instructions that every worker start obeys, so you state them
once instead of at each start. For each account you can set three rules, each with an optional
end time, after which it stops applying by itself, and a note:

- **Workers** off: the account is never recommended for a worker, and a worker
  pinned to it is refused with the rule as the reason. Sessions you start yourself still run.
  A computer's own **Available for workers** switch, under the advanced account details, shows
  beside it when it is off.
- **Max workers**: once that many workers are running or starting on the account,
  the next one goes elsewhere and a worker pinned to it is refused.
- **Priority** (-100 to 100, 0 when unset): among the remaining accounts the higher priority
  wins while the account has quota headroom, meaning its projected use fits every allowance
  window. Out of headroom, the preference no longer counts. A negative priority is used last.

Equal priorities are ordered by projected budget headroom: recommendations subtract forecast
running, queued, reserved and incoming work from the available budget, comparing the tightest
short or weekly window. The **Account preference margin** under advanced estimation settings
favors the previous account among close choices. A rule covers the same login on every
computer; unidentified accounts stay separate. Agents read and change the same rules, budgets,
hard caps, temporary budgets and default worker models with the `t3_allocation_policy` tool. Usage analytics show account allowance points/hour when measured. Model and
effort token samples are separate evidence, not subscription percentages; missing rates say
**Not enough data**. Collection remains limited to accounts already opted into measurements.

Advanced sections contain forecast estimates, connection setup, the assignment simulator, use-by
targets, reset plans, the JSON view of every temporary override, and diagnostics. Short-window
forecasts use their own observed rate or the fallback burn. Reset plans do not replenish quota or
change the reset schedule; allocation never redeems credits or enables overage.

An earlier denied or observation-only proposal can start with the same assignment and thread IDs.
The master may choose an account before startup. After startup is attempted, retry the entire input
unchanged if a response is lost; this reconciles its durable receipt without duplicating the work.
A confirmed failed start remains recorded as an error. Stop or cancel running work before releasing
its accounting; unused reservations expire.

History charts remain limited to accounts opted into usage retention. Native mobile shows the
same account rows and family defaults read-only, with usage inspection and assignment preview;
server enforcement is shared, but use the web page to edit settings and start human sessions.

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

## Model selection

Open **Settings → Model selection** beside Provider allocation, or find it through
Settings search or the command palette. Choose the shared coordinator in Provider
allocation first. Automatic selection is opt-in through this page or an agent automatic
request; ordinary model pickers keep their explicit choices. While a provider family has a
default worker model in [Provider allocation](#allocate-accounts-for-new-work), workers that
name no model use that instead of this table, and a preview here says so.

The page is one lookup table per provider, on separate Codex and Claude tabs. Columns are
an assignment's difficulty and rows are its stakes, each scored 0–10. Each cell is the model
and reasoning that assignment gets, for example difficulty 7 with stakes 8. Select a cell,
then change its model or reasoning, or set an alternative that is used only when that choice
is unavailable. Only that cell changes. Choices come from what your connected accounts
advertise, and a cell they cannot currently offer is flagged and keeps its saved value.
Changing a model keeps the cell's reasoning when the new model offers it; otherwise you
choose the reasoning yourself. Automatic selection never uses Luna, Haiku or Fable.

Edited cells are marked until you press **Save table**, which creates a new policy version.
**Discard changes** returns to the saved table, and **Reset to defaults** restores the built-in
table for the provider you are viewing as an unsaved edit. Tables saved before cells were
editable one by one keep the same choice for every score pair until you save again. If another
editor saves while you are editing, keep your edits on top of the newer version or discard
them; a save never overwrites changes you have not seen. Existing sessions and assignment
retries retain their selections.

Assess the scoped assignment on two integer axes, each from 0 to 10, with a short reason.
Difficulty measures reasoning, uncertainty and interactions. Stakes measures failure impact,
reversibility and detectability. Use 0–3 for routine/low, 4–6 for moderate, 7 for
demanding/high, 8 for very demanding/very high, 9 for extreme, and 10 only for exceptional
assignments. An assignment started without an assessment uses the `normal` tier, 5 on both
axes; the `routine` and `hard` tiers use 2 and 8.

The collapsed sections below the table hold the rest. **Test an assignment** previews the
exact model, effort, rule, account recommendation and warnings using your unsaved table, and
starts a new assignment from a saved one. The master chooses the account and starts it; quota
forecasts do not block that choice. Exact user overrides remain authoritative; conflicts are
shown for you to resolve. A missing capability uses only an explicitly configured
alternative; low quota never chooses a weaker choice or another computer. **Policy settings,
versions and raw JSON** holds the reassessment limit, reverts and the raw policy.
**Recent decisions** can start an explicit reassessment as a new session after substantive
failure or a justified scope change, within the configured bound. A provider-family change
requires explicit consent. Transport or installation failures alone are not reasons to
escalate. **Connection** shows coordinator status and refreshes the saved version.

Agents use the same preview and managed startup services through `t3_allocate_account` and
`t3_start_allocated_assignment`. Every agent-created worker, including forks, has an assessment
or a tier; the server always records the table's model/effort, the recommended account and
computer advice next to the actual choice. A choice that differs starts as it is, with the
master's reason when it gave one. They read the same saved table. Retry the identical IDs and intent after a lost
response; use new IDs for new work. Native mobile edits the same table in **Settings → Model
selection**, including relay connections, with the same version and catalog checks. Use the web
editor for human-session startup, exact-override and reassessment controls, previous-policy
reverts, raw JSON and full history. A direct connection offers an editor link; relay and SSH
connections require opening this custom build's web client and selecting the same environment.
Pair the browser if prompted.

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
