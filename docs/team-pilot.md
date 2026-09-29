# Team pilot

Each enrolled computer collects retained local tool logs and exchanges allowlisted usage snapshots through [Dashlar Registry](https://registry.dashlar.com). Each computer serves its own localhost team dashboard and retains its cache offline. The shared `drillbit-team-usage` installer uses the existing Registry CLI, personal macOS Keychain credential, and registered machine identity. GitHub installs code and packages; new enrollment does not upload usage there. Existing GitHub enrollments remain compatible until deliberately migrated.

## Estimated excess

The primary metric is `sum(max(0, account usage value - account modeled allowance))`. Weekly allowances are prorated over the selected period, once per person/account across machines. Unused allowances do not offset other accounts. These are planning estimates, not bills or published provider entitlements.

Pilot assumptions inherited from the prior team audit:

| Plan | Weekly API-equivalent allowance | Sensitivity range |
| --- | ---: | ---: |
| Claude recorded 5x tier | $500 | $400–$800 |
| OpenAI Pro, assumed 20x | $1,400 | $1,200–$2,000 |
| OpenAI self_serve_business_prolite | $350 | $300–$500 |
| OpenAI standard Team | $70 | $60–$100 |

Other plans require an explicit allowance. Subscription price is never treated as the included usage value. Sensitivity covers allowance assumptions only, not every source of estimation error. A zero estimate means measured/modeled usage is below the assumed allowance, not proof of no charges.

The upstream queue drops account identity. For this pilot, unattributed Claude/Codex buckets are modeled against the sole observed account for that provider/person, with an explicit assumption that its current plan applied throughout the selected period. Multiple candidate accounts stay unallocated. Model-less usage uses that account's observed blended token rate when available, with the proxy value displayed. Entirely unpriced/unobserved accounts stay unknown. Copied sessions on multiple machines can overlap. Selected periods beyond retained logs can over-deduct allowances; the snapshot retains only 90 days.

## Install and test

Use the [shared team skill](https://github.com/Dashlar/toolbelt/tree/main/plugins/drillbit-skills/skills/drillbit-team-usage). It installs Node 24+, the pinned runtime, the existing Registry CLI and one login service. A teammate supplies their own personal Registry key once at the machine registration helper's hidden terminal prompt; it is verified and saved in macOS Keychain, never configuration or command arguments. Registry workspace membership and GitHub Packages access for installation are prerequisites.

For development with an installed, pinned Registry bridge:

```sh
node bin/tracker.js team setup --registry-bridge /absolute/path/registry_sync.py --registry-python /absolute/path/python3 --name 'Your Name'
node bin/tracker.js team sync
node bin/tracker.js team install-service
```

The bridge uses the existing Registry HTTP API for writes and reads. Each machine has one JSON custom field, `tokentracker_snapshot_v1`, whose value is its latest 90-day metadata snapshot. Snapshots are replaced, never summed as repeated uploads. The machine's owner and identifier must match the snapshot. The MCP can query this field through `app.attributes` joined to `app.attribute_types` and `app.registry__machines`; it is not `runs.tokens_used`, which measures tokens consumed by the automation itself.

Migration retains the former configuration and cached files, replaces the local snapshot's person/device identifiers with verified Registry identities, and switches to a separate Registry cache index to prevent double counting old GitHub copies. Registry failures never fall back to GitHub uploads. Setup does not change Slack schedules or invitations.

Open http://127.0.0.1:7682. The macOS login service polls locally and syncs every 15 minutes, retrying network failures after 1, 2, 4, 8, then 15 minutes. Previously downloaded data remains usable offline. macOS service restarts require login; a sleeping/offline laptop catches up when available.

Configuration, snapshots, receipts, and logs are in `~/.tokentracker/team`. `team status` prints enrollment/sync status. To customize an allowance, obtain the account ID from `snapshot.json`:

```sh
node bin/tracker.js team allowance --account ACCOUNT_ID --weekly-usd 500
node bin/tracker.js team sync
```

The existing report-owner setting is preserved during migration. William's scheduled Slack sender is currently paused; enrollment never resumes it. The worker prepares one durable report after 10am America/Chicago; it coalesces multi-day offline backlogs into the most recently due daily report. **Slack delivery requires a separately configured sender**. `team report` previews the current estimate; `team report-sent --date YYYY-MM-DD --message-url URL` records a verified delivery. No provider credentials, raw logs, prompts, titles, or source paths are uploaded.

To stop the pilot service while preserving its data:

```sh
launchctl bootout "gui/$(id -u)/com.tokentracker.team"
```

Remove its `~/Library/LaunchAgents/com.tokentracker.team.plist` to prevent the next login from restarting it. This does not stop the normal TokenTracker application.

## Boundaries

This is a pilot, not an all-provider billing integration or a complete historical account attribution system. It reuses supported upstream local parsers; browser-only activity, arbitrary profile paths, and missing machines may be absent. Registry workspace members can read and edit shared snapshots; this is a cooperative reporting system, not a tamper-proof audit ledger. The Registry bridge accepts snapshots up to 25 MB and the local transport caps a team response at 50 MB. One API read per machine is suitable for the pilot; use a paginated bulk snapshot endpoint if roster size or payload size exceeds those limits. Missing or truncated responses retain the previous complete cache and surface an error.
