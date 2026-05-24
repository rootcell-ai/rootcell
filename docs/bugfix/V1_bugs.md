# V1 Browser Spy Bug Archive

This file was moved out of `PLAN.md` so the plan can focus on V1.5
development. It preserves the completed V1 manual browser QA findings,
prioritized bug handoff, evidence notes, and verification baseline.

## V1 Manual Browser QA Findings

QA date: 2026-05-23.

Manual test context:

- Re-enabled spy on the `default` Lima instance, launched `./rootcell spy
  --no-open`, and inspected the browser UI through the local SSH tunnel.
- Captured a longer Pi.dev session using Amazon Bedrock model
  `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- Added a temporary large cache-anchor system prompt to force provider cache
  accounting, then verified calls with cache write and cache read values in the
  API and browser inspector.
- Observed 17 real Bedrock `converse-stream` calls, including a call with
  provider usage `input 10`, `output 32`, `cache read 10175`, and `cache write
  29`, and a later long call with `input 10`, `output 2641`, `cache write
  4570`, `total 7221`, 515 stream events, and 35 request blocks. The latest
  live retry call showed `input 10`, `output 262`, `cache write 7195`, `total
  7467`, 72 stream events, and 38 request blocks.
- Created additional live Pi/Bedrock turns while the browser was open and
  verified the timeline count and health values updated without refresh. A long
  call visibly transitioned from pending with `output 0 B`, `usage n/a`, and
  `duration pending` to complete with `output 7.5 KiB`, `usage 7.2k tok`, and
  `duration 13 s`.
- Cross-checked the browser against `/api/health` and `/api/calls`; the API
  reported 17 calls, 0 pending calls, 0 dropped captures, 0 B spool, 1.9 MiB
  DB size, and the same cache-heavy usage values shown in the inspector.
- Continued the QA loop after 05:30 PM with a fresh Live spy URL. By 05:40 PM
  `/api/health` reported 22 provider calls, 0 pending calls, 0 dropped captures,
  0 B spool, and 2.7 MiB DB size. The newest Pi/Bedrock call showed provider
  usage `input 10`, `output 104`, `cache read 5123`, `cache write 77`, `total
  5314`, 36 stream events, and 23 request blocks.
- While `Today` was selected, a new 05:40:59 PM Pi/Bedrock call appeared live
  without refresh, taking the visible Today count to 23 calls. The API reported
  `input 10`, `output 98`, `cache read 5200`, `cache write 81`, `total 5389`,
  29 stream events, and 26 request blocks.
- A later 05:45:03 PM health-live Pi/Bedrock call took the visible Today count
  to 24 calls. The API reported `input 10`, `output 105`, `cache read 5281`,
  `cache write 79`, `total 5475`, 30 stream events, and 29 request blocks.

Checks that passed:

- The cache-heavy call's Usage Records panel showed `input 10`, `output 32`,
  `cache read 10175`, `cache write 29`, and `total 10246`.
- The latest long cache-write call's Usage Records panel showed `input 10`,
  `output 2641`, `cache read 0`, `cache write 4570`, and `total 7221`.
- The latest live retry call's API and timeline values matched at `input 27 KiB`,
  `output 2.6 KiB`, `usage 7.5k tok`, `duration 2.5 s`, and Usage Records
  showed `input 10`, `output 262`, `cache read 0`, `cache write 7195`, and
  `total 7467`.
- Health updated after the live call and matched the API: Enabled, DB size
  1.9 MiB, spool 0 B, dropped captures 0, last ingest May 23 05:14:10 PM,
  Calls 17, Pending 0, Schema 2.
- The 05:37:36 PM cache-read/write call matched between API and UI after
  selection: the row showed `input 17 KiB`, `output 1.3 KiB`, `usage 5.3k tok`,
  `duration 1.6 s`, and the inspector showed `in 10 · out 104 · cache
  5,123/77`.
- The Today range updated in place when the 05:40:59 PM call completed, and the
  row showed the expected `input 18 KiB`, `output 1.2 KiB`, `usage 5.4k tok`,
  `duration 1.4 s`; selecting it showed `in 10 · out 98 · cache 5,200/81`.
- The 05:45:03 PM call also appeared live in Today, and the row/API/inspector
  agreed at `input 19 KiB`, `output 1.2 KiB`, `usage 5.5k tok`, `duration 1.4 s`,
  and `in 10 · out 105 · cache 5,281/79`.
- Browser console logs stayed empty after the post-5:30 live-update, search,
  filtering, and inspector-selection checks.
- Pending provider calls render live in the timeline and update in place after
  completion; the latest long turn matched the API values after completion.
- No-result search and no-result status filtering clear the old inspector detail
  and show an explicit empty inspector state.
- Raw payloads correctly report that raw storage is disabled or no raw payloads
  are stored.

Prioritized fix handoff:

Priority scale: P0 blocks ordinary UI use or hides core data; P1 is high-impact
workflow correctness/usability; P2 is important clarity or inspection quality;
P3 is polish, minor copy, or secondary accessibility.

- [x] [P0] SPY-QA-01: Rework the two-column page layout so the timeline and
  inspector own their scroll containers instead of letting `main` hide overflow.
  Today/long-call views can put rows, footer controls, and lower inspector panels
  thousands of pixels below the visible viewport.
  - Fixed on 2026-05-23: changed the spy UI shell to a fixed header plus
    shrinkable body grid, added `min-h-0` to the timeline and inspector scroll
    owners, and covered the clipping regression in Playwright.
- [x] [P0] SPY-QA-02: Fix hidden top-level scrolling. Focus/opening lower
  inspector panels can set `main.scrollTop` despite `overflow-hidden`, pushing
  the global header and range controls offscreen with no visible page scrollbar.
  - Closed on 2026-05-24 as stale/no-repro in the current tree after a
    dedicated RCA in `docs/bugfix/SPY-QA-02-RCA.md`: lower inspector navigation
    and stream-event loading kept `main.scrollTop=0`, `main` had no hidden
    scroll range, and the existing Playwright guard for buried inspector
    navigation passed.
- [x] [P0] SPY-QA-03: Fix timeline row and footer overlap. Rows in the short
  10-minute view overlap each other by about 12 px, hit-testing can return two
  row buttons at one point, and the call-count/Load More footer can cover row
  content.
  - Fixed on 2026-05-23: timeline rows now use actual virtualizer measurement
    instead of a too-small fixed estimate, and the footer sits outside the
    timeline scroll viewport so it cannot overlay row content. Added Playwright
    coverage for adjacent row overlap and footer coverage at max scroll.
- [x] [P0] SPY-QA-04: Make long inspectors navigable. The inspector often
  measures taller than the visible viewport, Request/Response Blocks open by
  default for huge calls, and Usage Records/Network/Stream/Raw/Health become
  effectively buried.
  - Fixed on 2026-05-23: added a sticky inspector section navigator, made
    high-volume Request/Response block sections start collapsed, and covered
    the navigation regression in Playwright.
- [x] [P1] SPY-QA-05: Virtualize or paginate Stream Events and reset stale loaded
  stream state on call/range changes. Loading 72-765 events renders hundreds or
  thousands of inline lines and can leave the operator stranded in an old deep
  scroll position.
  - Fixed on 2026-05-23: stream events now render through a bounded 25-event
    window with collapsed payload previews, and loaded stream state is cleared
    when selecting a new call or changing timeline context. Added Playwright
    coverage with a synthetic 250-event stream response.
- [x] [P1] SPY-QA-06: Reset inspector scroll and panel state when selecting a new
  call, or expose an explicit reset affordance. Selecting a different call after
  deep stream inspection can keep `scrollTop` thousands of pixels down.
  - Fixed on 2026-05-23: re-clicking the already-selected timeline row now
    clears loaded stream state, remounts inspector sections so lower panels
    close, and scrolls the inspector to the top. Added Playwright coverage for
    the deep stream-inspection reset path.
- [x] [P1] SPY-QA-07: Clarify selected-call pinning while live calls arrive.
  New rows appear above the selected row, but the inspector stays on the older
  call without an explicit pinned/auto-follow state.
  - Fixed on 2026-05-23: the inspector now shows a `Pinned` badge and `Follow
    Latest` button when the selected call is older than the newest visible
    timeline row, while preserving pinned inspection by default.
- [x] [P1] SPY-QA-08: Keep URL/query state in sync with selected time range and
  distinguish fixed `since` URLs from true Live mode. Reloading old `since` URLs
  can show historical data while the header still says `Live from now`.
  - Fixed on 2026-05-23: the browser now parses URL range state as a coherent
    `preset`/`since` pair, treats fixed `since` URLs as non-live unless
    `preset=live` is explicit, and writes canonical range query state when the
    operator changes Live, 10 min, 1 hour, Today, or Custom. Added unit and
    Playwright coverage for fixed `since` URLs, range changes, and reloads.
- [x] [P1] SPY-QA-09: Decide whether `10 min` and `1 hour` are rolling windows or
  fixed snapshots, then label/update them consistently. Refresh currently keeps
  the original fixed start.
  - Fixed on 2026-05-23: `10 min` and `1 hour` now act as rolling windows on
    refresh and SSE reloads, dynamic preset URLs no longer persist stale
    `since` timestamps, and Playwright coverage verifies the refreshed API query
    start advances.
- [x] [P1] SPY-QA-10: Keep service Health reachable independently of selected
  calls. Empty search/filter results clear the inspector and remove access to
  health even though `/api/health` is still valid.
  - Fixed on 2026-05-23: the no-call inspector state now renders service Health
    independently of selected call detail and hides the call-section navigator
    when no selected-call sections exist. Added Playwright coverage for an empty
    Pending filter result.
- [x] [P1] SPY-QA-11: Improve empty-state copy for active filters/search. A
  Pending filter in Today with 23 completed calls says "No provider calls in this
  range" instead of explaining that filters excluded the calls.
  - Fixed on 2026-05-24: timeline empty states now distinguish unconstrained
    range emptiness from active search/provider/model/operation/status query
    constraints. Filtered or searched empty results say no calls match the
    current search or filters, while true range-empty states such as clear-data
    keep the range-only copy. Added Playwright coverage for filtered empty
    states and preserved clear-data coverage for the range-empty copy.
- [x] [P1] SPY-QA-12: Add a single clear/reset control for search and filters.
  Recovering the full list currently requires clearing text, resetting multiple
  selects, and submitting again.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. The
    existing controls can recover the full list; a future reset affordance
    should be tracked outside the bug backlog if needed.
- [x] [P1] SPY-QA-13: Make search results explain why they matched. Rows need
  snippets/highlights; exact-looking hyphenated marker searches currently behave
  like broad token matches and can return surprising older calls.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. Search is
    functioning as normalized FTS token search; snippets/highlights would be an
    explanatory feature.
- [x] [P1] SPY-QA-14: Clarify search scope and include or explicitly exclude call
  ids/model ids/metadata. Visible call-id fragments return no results while the
  placeholder only says `Search text`.
  - Fixed on 2026-05-24: `/api/search` now matches normalized block text plus
    visible provider-call metadata including call ids, flow ids, model ids,
    provider, operation, and status. The UI search label now names the expanded
    scope, and store/service/Playwright coverage proves call-id, model-fragment,
    and normalized-text searches.
- [x] [P1] SPY-QA-15: Submit search on Enter. The input updates but results do not
  change until the Search button is clicked.
  - Closed on 2026-05-24 as stale/no-repro in the current tree. The search input
    is inside a form with `onSubmit`, and Enter submits the search.
- [x] [P1] SPY-QA-16: Group related provider calls into Pi turns/sessions or show
  prompt snippets. Tool-use cycles appear as adjacent unrelated Haiku rows.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. Turn or
    session grouping belongs in a future UX scope if needed.
- [x] [P1] SPY-QA-17: Make diff baseline scope explicit. Live/ranged views can
  diff against a prior request outside the visible range without saying so.
  - Fixed on 2026-05-24: the browser Diff section now labels the previous
    request as a global baseline across stored comparable calls, and shows an
    `outside current range` or `outside current Live window` badge when the
    baseline is older than the active timeline range. Added Playwright coverage
    for a visible ranged call whose diff baseline is outside that range.
- [x] [P1] SPY-QA-18: Surface cache read/write in the timeline summary and rename
  or clarify the `cache 2` marker badge. Cache-read and cache-write calls look
  nearly identical from the row alone.
  - Fixed on 2026-05-24: timeline rows now show provider `read`, `write`,
    `cache read`, and `cache write` token values separately, remove the
    ambiguous request cache-marker count badge, and move byte sizes/duration
    into the row metadata line. Added Playwright coverage for a cache-heavy
    call proving the row no longer shows total `tok` usage or `cache 2`.
- [x] [P1] SPY-QA-19: Fix Bedrock reasoning classification. Prior-history
  `reasoningContent` and signature-only reasoning chunks show as `Unknown`
  instead of thinking/reasoning metadata.
  - Fixed on 2026-05-24: the Bedrock adapter now classifies request
    `reasoningContent` and response reasoning deltas as `thinking`, including
    nested `reasoningText.text` and signature-only reasoning metadata. Added
    adapter coverage for prior-history reasoning, nested response reasoning
    text, and signature-only response reasoning chunks.
- [x] [P1] SPY-QA-20: Fix pending-row formatting. Pending rows can render
  `usage usage n/a`.
  - Closed on 2026-05-24 as stale/no-repro in the current tree. The RCA in
    `docs/bugfix/SPY-QA-21-RCA.md` proves a mocked pending row with null usage
    renders explicit `read`, `write`, `cache read`, and `cache write` metrics
    with `-` values and no `usage` text.
- [x] [P1] SPY-QA-21: Fix modal focus management for Clear spy data. Focus stays
  on the background icon button, the background is not effectively inert, and
  Escape did not close the dialog during QA.
  - Fixed on 2026-05-24: the Clear Spy Data dialog now renders outside the
    inert app shell, focuses Cancel on open, traps Tab/Shift+Tab inside the
    dialog, closes on Escape, and restores focus to the header trigger. Added
    Playwright coverage for the modal focus loop and Escape close path.
- [x] [P2] SPY-QA-22: Make request composition responsive. Provider usage and
  cache read/write suffixes truncate, and the section table clips horizontally
  at the normal in-app browser width.
  - Fixed on 2026-05-24: Request Composition metrics now use responsive
    two/four-column layout with wrapping detail text, and the section table uses
    narrower fitting tracks instead of hidden horizontal clipping. Added
    Playwright coverage at 1100 px proving Provider usage and section-table
    content fit without hidden overflow.
- [x] [P2] SPY-QA-23: Move or scope the block-kind filter. It lives under Request
  Blocks, affects request and response blocks, persists across call selection,
  and can make Response Blocks look empty.
  - Fixed on 2026-05-24: moved the block-kind filter to an inspector-level
    toolbar above both Request Blocks and Response Blocks, labeled its
    request/response scope, and changed filtered-empty block lists to explain
    that the selected kind has no blocks in that section. Added Playwright
    coverage for the shared filter scope and call-selection persistence.
- [x] [P2] SPY-QA-24: Improve custom-range state. `Apply` stays green while all
  range pills are inactive, lacks ARIA state, and minute precision rounded a
  prior `since` down to `:00`.
  - Fixed on 2026-05-24: Custom is now an explicit active range segment with
    `aria-pressed` state, `Apply` is styled as a command instead of selected
    state, and no-op applies preserve second-level `since` values. Added
    Playwright coverage for active custom state, ARIA state, no-op precision
    preservation, and intentional changed-minute commits.
- [x] [P2] SPY-QA-25: Expand or restyle the custom datetime input so the AM/PM
  and time controls are not cramped at the normal desktop width.
  - Fixed on 2026-05-24: widened the custom datetime input and added
    Playwright coverage at the original normal desktop QA viewport proving the
    control has measurable slack for the PM display.
- [x] [P2] SPY-QA-26: Reduce visual noise in stream-event JSON. Opaque Bedrock
  `p` fields dominate the event payload and look like rendering artifacts.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. The field
    is real provider metadata; redaction/summarization should be tracked outside
    the bug backlog if desired.
- [x] [P2] SPY-QA-27: Improve Network Metadata readability. Paths truncate and
  URL-encoded model punctuation such as `%3A0` makes the request target harder
  to verify.
  - Fixed on 2026-05-24: Network Metadata now formats HTTP targets for display
    without changing the raw persisted path, decodes readable model punctuation
    such as `%3A0` to `:0`, splits path/query into wrapping detail rows, keeps
    the raw encoded target available, and wraps long header values. Added
    formatter unit coverage and Playwright coverage proving the decoded target
    is visible without hidden horizontal overflow at 1100 px.
- [x] [P2] SPY-QA-28: Show the full provider model id somewhere prominent. The
  normal row/header omit the `us.anthropic.` Bedrock namespace.
  - Fixed on 2026-05-24: the inspector Summary panel now shows a prominent
    wrapped `Model ID` field with the exact provider model id, while preserving
    compact row/header labels. Added Playwright coverage proving the row remains
    shortened but the selected-call summary exposes
    `us.anthropic.claude-sonnet-4-6`.
- [x] [P2] SPY-QA-29: Fix sticky inspector header overlap. Scrolled detail content
  can slide underneath the fixed title/status area and appear clipped.
  - Fixed on 2026-05-24: split the inspector into a non-scrolling header and a
    dedicated detail scroll body, updated section navigation/reset to target the
    body, and added Playwright coverage proving scrolled detail content is not
    present underneath the header hit-test area.
- [x] [P2] SPY-QA-30: Add ARIA state for selected timeline row and active range
  segment. Current active/selected states are visual only.
  - Fixed on 2026-05-24: confirmed range segments already exposed
    `aria-pressed`, added `aria-current` to the selected timeline row button,
    and added Playwright coverage proving row selection state moves between
    selected calls while active range state remains exposed.
- [x] [P2] SPY-QA-31: Improve timeline row accessible names. `aria-label` only
  exposes `Open call <id>` and hides visible model/status/time/usage context from
  assistive technology.
  - Fixed on 2026-05-24: timeline row accessible names now include the call id,
    model, status, start time, operation, provider usage classes, byte sizes,
    duration, and request/response block counts. Added Playwright coverage that
    locates rows by the richer accessible name and verifies model/cache-usage
    context is exposed.
- [x] [P2] SPY-QA-32: Make the disconnected SSE `Reconnect` badge either a real
  control or passive status text. It currently reads like a clickable action.
  - Fixed on 2026-05-24: disconnected SSE now renders as passive `SSE offline`
    status text with a status role instead of an action-like `Reconnect` label.
    Added Playwright coverage that forces `/api/events` offline and proves no
    `Reconnect` control is exposed.
- [x] [P2] SPY-QA-33: Reduce nested scroll traps in large JSON/detail panels.
  Stream events and other large detail payloads can catch wheel input and make it
  awkward to continue through the inspector.
  - Closed on 2026-05-24 as a product enhancement, not a proved current bug. The
    bounded detail panes are intentional; any alternate detail-pane interaction
    should be tracked outside the bug backlog.
- [x] [P3] SPY-QA-34: Fix singular/plural call count grammar (`1 calls`).
  - Fixed on 2026-05-24: added a shared count formatter for singular/plural UI
    labels and used it in the timeline footer so one visible provider call now
    renders `1 call` instead of `1 calls`. Added unit coverage for count labels
    and Playwright coverage for a one-call filtered timeline.
- [x] [P3] SPY-QA-35: Loosen timeline row chips/badges. Long token labels,
  token values, and timestamps can wrap or clip into awkward multi-line
  fragments.
  - Fixed on 2026-05-24: timeline usage now renders as one compact, fit-content
    metric pill with `down arrow` for read, `up arrow` for write, `R` for cache
    read, and `W` for cache write. Cache metrics are omitted when the provider
    does not report cache usage, while exact full meanings remain in titles,
    `aria-label`s, and the row accessible name. The timestamp is protected from
    wrapping, markers share the same size/line-height as token values, and
    Playwright coverage measures the cache-heavy row at 1100 px to ensure the
    usage pill does not stretch or clip.
- [x] [P3] SPY-QA-36: Prevent top inspector summary cards from truncating
  important values such as exact `Started` time.
  - Fixed on 2026-05-24: changed the inspector Summary metrics from a fixed
    four-column layout to a two-column layout at normal inspector widths, with
    four columns only at very wide desktop sizes. Metric values now wrap instead
    of using ellipsis truncation, and Playwright coverage proves the exact
    `Started` timestamp does not clip at the reproduced 1280 px viewport.

ID-keyed evidence notes:

These notes are retained only where they clarify an open bug ID. They are not
separate tasks.

- SPY-QA-22: Request composition has correct provider usage text in the DOM, but
  the visible cache read/write suffix can truncate at normal desktop width. The
  section table is also wider than its visible card without a responsive
  treatment.
- SPY-QA-25: The custom datetime input is cramped at the normal desktop browser
  width; the stored value is correct, but the AM/PM/time affordance is visually
  crowded.
- SPY-QA-29: The sticky inspector call header can visually cover scrolled detail
  content, leaving rows partially clipped at the top of the detail pane.
- SPY-QA-30: Selected timeline row lacked ARIA state while active time-range
  segments already exposed `aria-pressed`; fixed by exposing `aria-current` on
  the selected timeline row.
- SPY-QA-31: Timeline row accessible names now expose visible model, status,
  time, operation, usage, size, duration, and block-count context.
- SPY-QA-32: The disconnected SSE badge now renders passive `SSE offline`
  status text instead of the action-like `Reconnect` label.
- SPY-QA-34: The timeline count footer can display `1 calls`.
- SPY-QA-35: Timeline row usage now uses one compact fit-content metric pill,
  preserving full labels through `aria-label`/title text; cache metrics are
  omitted when absent, and timestamps are protected from wrapping.
- SPY-QA-36: Top inspector summary cards can truncate important values such as
  the exact `Started` timestamp.

Free-form notes removed from the active bug list:

- Search result snippets/highlights, combined reset controls, Pi turn/session
  grouping, stream-event JSON summarization, and alternate nested-detail
  scrolling are product enhancements rather than current bugs.
- Historical `since` URL labeling, URL/range sync, timeline clipping, row/footer
  overlap, stream-event over-rendering, deep inspector reset, hidden top-level
  scrolling, and long-call section navigation are stale duplicates of
  `SPY-QA-01` through `SPY-QA-10`, which are closed and covered by existing
  Playwright tests.

Keep the verification baseline for the follow-up fixes:

- `bun run typecheck`
- `bun run lint`
- `python3 -m unittest discover -s proxy -p 'test_*.py'`
- `bun run build:spy`
- `bun run test` (requires permission to bind localhost in this workspace)
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e` (requires localhost/browser permissions)
- `bun run test:integration`
- `bun run test:integration:clean`
