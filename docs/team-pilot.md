# Team pilot

Each enrolled computer collects retained local tool logs, uploads a compressed metadata-only snapshot to a **private** GitHub repository, and downloads the team's snapshots for a localhost dashboard. GitHub authentication and repository write access are required. The public code repository must never hold team snapshots. Inviting collaborators is a separate administrator action.

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

Requires Node 20+ and GitHub CLI, authenticated as the teammate with write access to the private data repository. Run from a stable checkout; the login service points to that checkout's executable. Initial setup collects existing logs without replacing the normal TokenTracker installation.

```sh
npm ci --ignore-scripts --omit=dev
node bin/tracker.js team setup --repo OWNER/PRIVATE-DATA-REPO --name 'Your Name'
node bin/tracker.js team collect
node bin/tracker.js team sync --no-collect
node bin/tracker.js team install-service
```

Open http://127.0.0.1:7682. The macOS login service polls locally and syncs every 15 minutes, retrying network failures after 1, 2, 4, 8, then 15 minutes. Previously downloaded data remains usable offline. macOS service restarts require login; a sleeping/offline laptop catches up when available.

Configuration, snapshots, receipts, and logs are in `~/.tokentracker/team`. `team status` prints enrollment/sync status. To customize an allowance, obtain the account ID from `snapshot.json`:

```sh
node bin/tracker.js team allowance --account ACCOUNT_ID --weekly-usd 500
node bin/tracker.js team sync
```

The report owner's setup also uses `--report-owner`. The worker prepares one durable report after 10am America/Chicago; it coalesces multi-day offline backlogs into the most recently due daily report. **Slack delivery requires a separately configured sender**. `team report` previews the current estimate; `team report-sent --date YYYY-MM-DD --message-url URL` records a verified delivery. No provider credentials, raw logs, prompts, titles, or source paths are uploaded.

To stop the pilot service while preserving its data:

```sh
launchctl bootout "gui/$(id -u)/com.tokentracker.team"
```

Remove its `~/Library/LaunchAgents/com.tokentracker.team.plist` to prevent the next login from restarting it. This does not stop the normal TokenTracker application.

## Boundaries

This is a pilot, not an all-provider billing integration or a complete historical account attribution system. It reuses supported upstream local parsers; browser-only activity, arbitrary profile paths, and missing machines may be absent. GitHub collaborators can read and edit team snapshots; this is not a tamper-proof audit system. The 900 KB compressed per-machine limit bounds the simple GitHub exchange. Long-term git history and request volume require a different store if the pilot grows.
