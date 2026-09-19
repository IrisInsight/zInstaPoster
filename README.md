# zInstaPoster

Internal tool. Generates branded Instagram carousels, routes every one through a
human approval gate, and publishes them on a schedule.

The pipeline is: **Claude writes the copy → Gemini generates the photo → an HTML
renderer composites brand typography over it → a person approves → a scheduler
publishes.**

Tenant #1 is Precision Vitality, a solo-provider psychiatric practice in Yorba
Linda, CA. Tenants 2–15 are senior living communities with a different
compliance ruleset, which is why nothing about either vertical is in the code.

---

## Running it

```bash
npm install
npm run db:push      # create the schema
npm run db:seed      # tenants, a login, and the five shipped carousels
npm run dev
```

With an empty `.env` this works immediately: the database is PGlite in
`.pglite/`, rendered slides go to `.storage/` and are served from `/api/media/…`,
and the scheduler uses in-process timers. The UI says which capabilities are
switched off. Sign in with the credentials `db:seed` prints.

Add `ANTHROPIC_API_KEY` to generate copy, `GEMINI_API_KEY` to generate photos.
Everything else is listed in `.env.example`.

**PGlite is single-writer.** Stop the dev server before running `db:push`,
`db:seed`, `db:reset` or either smoke script, or the script will fail to open
the database. Point `DATABASE_URL` at a real Postgres if you would rather not
think about it. Scripts close the connection on the way out; killing one
mid-write leaves the directory locked, and `npm run db:reset` clears it.

### Verifying the pieces

```bash
npm test                 # compliance, renderer, publish, tokens, scheduling, multi-tenant
npm run render:smoke     # renders a carousel, checks JPEG/size/dimensions
npm run pipeline:smoke   # whole pipeline, then fetches each slide URL back
npm run ui:smoke         # walks every screen against a running dev server
```

`render:smoke` and `pipeline:smoke` write real files and hit the real renderer.
`pipeline:smoke` re-fetches every stored slide URL over HTTP and fails if the
bytes are not a valid JPEG at the tenant's exact dimensions. `ui:smoke` needs a
server already running and fails on an uncaught page error, a 4xx/5xx, or a
screen that renders without its content.

---

## Architecture

```
src/lib/
  compliance/     rules engine — generic predicates, per-tenant rulesets
  content/        Claude copy, Gemini photos, the pipeline that joins them
  render/         HTML templates → Chromium → JPEG 1080×1350
  instagram/      OAuth, encrypted tokens, refresh, the 3-step publish flow
  posts/          state machine and the service that enforces it
  scheduler/      QStash, with a local driver and a sweep safety net
  storage.ts      Vercel Blob, with a local driver for development
  db/             Drizzle schema and driver selection
src/app/
  (app)/          queue, compose, review, accounts, post detail
  api/            generate (SSE), jobs, media, Instagram OAuth
```

### The approval gate

```
draft → pending_approval → approved → scheduled → publishing → published
                        ↘ rejected                          ↘ failed
```

`src/lib/posts/state-machine.ts` holds the rules and `assertTransition` runs on
every transition. Three of them matter:

- `pending_approval → approved` is human-only. There is no service-account path,
  no API key path, no admin override.
- Nothing reaches `publishing` unless `approved_by` is already recorded on the
  row, checked again inside the publish call itself.
- Editing an approved post withdraws the approval and cancels its schedule.

Every transition writes to `audit_log` with the actor. For a medical tenant that
table is the record of who signed off on what.

### The compliance engine

Rules live in tenant config, not in code. A rule names a predicate and supplies
its parameters:

```json
{
  "id": "no-fda-approved-compounded",
  "check": "phrase_proximity",
  "reason": "Misleading promotion of a compounded drug is misbranding under 21 U.S.C. 352(bb).",
  "fix": "Remove the claim, or name the mechanism instead.",
  "params": {
    "phrases": ["FDA-approved", "FDA approved"],
    "near": ["compounded", "peptide", "GHK-Cu"],
    "window": 200
  }
}
```

The predicates in `src/lib/compliance/predicates.ts` know nothing about
medicine or housing: `banned_phrases`, `pattern_match`, `phrase_proximity`,
`required_caption_line`, `max_hashtags`, `requires_one_of`,
`conditional_disclaimer`. Each accepts `except_patterns` so mandated language
does not trip a ban on its own words — the FDA disclaimer contains "is not
guaranteed", which would otherwise trip the outcome-claims rule.

A ruleset naming a predicate that does not exist produces a blocking finding.
Failing open would be the worst possible behaviour here.

`docs/example-tenant-senior-living.json` is the worked example for tenants 2–15:
Fair Housing, HOPA age claims, resident photo releases. `tests/multi-tenant.test.ts`
runs it through the same engine and asserts the two rulesets do not leak into
each other.

The rules are also fed to Claude as prompt guidance, and then the output is
validated against them in code. Prompt guidance is not enforcement.

### The renderer

HTML/CSS templates with brand tokens injected, rendered headless to JPEG at
1080×1350, sRGB, well under 8MB. Fonts are embedded as data URIs rather than
linked, so a render can never silently fall back to a system font.

Generated copy varies in length, so each text block carries `data-fit="max,min"`
and a script shrinks it until it fits before the screenshot is taken. The
renderer waits for that to finish, then for `document.fonts.ready`.

No typography is ever generated by an image model. Disclaimer text has to be
exact, diffable and versionable.

### Instagram

Instagram API with Instagram Login. No Facebook Page, no App Review: the Meta app
stays in development mode and each account is added as an Instagram Tester (the
cap is 50 without business verification; the roadmap needs 15).

Publishing is one job at fire time, because containers expire after 24 hours:

```
per slide  POST /{ig-user-id}/media   image_url=… is_carousel_item=true
parent     POST /{ig-user-id}/media   media_type=CAROUSEL children=… caption=…
poll       GET  /{container-id}?fields=status_code   (once a minute, 5 max)
publish    POST /{ig-user-id}/media_publish   creation_id=…
```

Every graph call is version-pinned from `META_API_VERSION`. The OAuth token
endpoints are deliberately not version-prefixed — they sit outside the graph
versioning scheme.

`assertPublishable` runs before any API call and rejects the failures that are
otherwise silent: a slide URL that is not public https, slides with differing
dimensions, a caption over 2,200 characters, fewer than 2 or more than 10 slides,
and any post without a recorded human approval.

### Tokens

Long-lived tokens last about 60 days, can be refreshed once they are 24 hours
old, and die permanently if 60 days pass without a refresh. Confirmed against
Meta's documentation during implementation; `src/lib/instagram/client.ts` holds
the endpoint list.

- Stored AES-256-GCM encrypted in `ig_account`, never in env vars.
- Refreshed by `/api/jobs/refresh-tokens` on a daily cron, inside a 14-day
  window — well before expiry, not at expiry.
- A failure alerts a human on a webhook and by email, marks the account, and
  shows the error on the accounts screen. Silent failure is the thing that kills
  publishing without anyone noticing.
- The accounts screen shows last refresh, next expiry and a countdown that turns
  alarming under 7 days.

### The scheduler

QStash fires one job at publish time. Vercel Cron is not used for publishing —
its granularity is too coarse. It *is* used for the daily token refresh and an
hourly sweep, where coarse is exactly right (`vercel.json`).

Without `QSTASH_TOKEN` the local driver runs: in-process timers, restored on
boot by `src/instrumentation.ts`, plus `/api/jobs/sweep` which publishes anything
whose time has passed. Job endpoints accept either a verified QStash signature
or the `CRON_SECRET` header.

---

## Deploying

1. Vercel project on team `iris-codes`. Set every variable from `.env.example`.
2. Postgres on Neon or Supabase → `DATABASE_URL`. Run `npm run db:push`, or apply
   `drizzle/` with your own migration runner.
3. Vercel Blob store → `BLOB_READ_WRITE_TOKEN`. URLs must be public and
   non-expiring: Meta fetches them, unauthenticated, at publish time.
4. QStash → `QSTASH_TOKEN` and both signing keys.
5. `npm run db:seed` once against the production database to load tenants.

Chromium comes from `@sparticuz/chromium` when `VERCEL` is set, and from
Playwright's own download locally. `CHROMIUM_EXECUTABLE_PATH` overrides both.

### Meta app setup (human steps, once)

1. Create a Meta app, **Business** type, at developers.facebook.com.
2. Add the **Instagram** product. Use **Instagram Login**, not Facebook Login for
   Business.
3. Leave the app in **development mode**. Do not submit for App Review.
4. App ID and App Secret → `META_APP_ID`, `META_APP_SECRET`.
5. Register the OAuth redirect URI. The accounts screen prints the exact value.
6. For each Instagram account: add it as an **Instagram Tester** under App Roles.
   The owner accepts the invite inside Instagram. The menu path moves between app
   versions — do this on a screen share, not by written instructions.
7. Each account must be **public** and **Business or Creator**.

App Review becomes unavoidable the moment an account connects whose owner holds
no role on the Meta app, i.e. self-serve signup. Business Verification gates
review and review has been slow; start roughly two months ahead.

---

## Adding a tenant

1. Copy `tenants/precision-vitality.json` or
   `docs/example-tenant-senior-living.json` and edit it: brand tokens, output
   size, compliance ruleset, templates, disclaimers, footer, posting windows.
2. Every rule's `check` must name a predicate that exists. `tests/multi-tenant.test.ts`
   asserts this for the shipped configs; add yours to that list.
3. `npm run db:seed` upserts tenants from `tenants/*.json`.
4. Assign users to the tenant in `user_tenant`. A single-tenant user never sees
   the tenant switcher.

Adding a vertical should not require touching `src/lib/compliance/`. If it does,
the new predicate belongs in the registry as something generic, not as a rule
about one client.

---

## Things that will bite you

These are load-bearing. Each one is enforced somewhere in the code, with the
reason written next to it.

- **PNG anywhere in the pipeline.** Meta rejects it. Generated photos are
  converted to JPEG on arrival and slides are only ever emitted as JPEG.
- **Mismatched slide dimensions.** Instagram crops slides 2..n to slide 1's
  ratio. Checked at render time and again before publishing.
- **Pre-creating containers.** 24-hour expiry. Containers are created inside the
  publish job, never at approval time.
- **Vercel Cron for publishing.** Too coarse. QStash fires the job.
- **Unversioned graph calls.** `graphGet`/`graphPost` always insert the pinned
  version.
- **Silent token refresh failure.** Alerts are wired and tested.
- **Signed or expiring blob URLs.** `isPubliclyFetchable` refuses anything that
  is not a public https URL before a container is created.
- **Trusting the model for compliance.** Every generation is re-validated in code
  against the tenant's ruleset before it can reach `pending_approval`.
- **Private or personal Instagram accounts.** Must be public Business or Creator.
