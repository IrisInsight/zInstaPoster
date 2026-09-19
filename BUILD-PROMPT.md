# Build Prompt — zInstaPoster

Paste this whole file into Claude Code as the opening prompt, or drop it in the repo root
and say "read BUILD-PROMPT.md and build it."

Internal tool. Branding assets are in `brand/`.

---

## What you are building

A multi-tenant web app that generates branded Instagram carousel posts, routes them through
a human approval gate, and publishes them to Instagram on a schedule.

Tenant #1 is **Precision Vitality**, a solo-provider medical practice (psychiatric nurse
practitioner, Yorba Linda CA). Tenants 2–15 will be senior living communities under the
**Ativo** and **Oak Harbor** brands, owned by the operator running this app.

The content pipeline is: **Claude writes the copy → Gemini generates the photo → an HTML
renderer composites brand typography over it → a human approves → a scheduler publishes.**

---

## Decisions already made — do not relitigate these

These were researched and settled. Build to them.

1. **Publish direct to Meta.** No Ayrshare/Postiz/Buffer. The only reason to pay one is to
   skip App Review, and this app never needs App Review (see §Meta below).
2. **Instagram API with Instagram Login**, not Facebook Login for Business. No Facebook Page
   dependency. Scopes: `instagram_business_basic`, `instagram_business_content_publish`.
3. **Meta app stays in development mode.** Each Instagram account is added as an Instagram
   Tester. Cap is 50 tester accounts without business verification; the roadmap needs 15.
4. **Slides render at 1080 × 1350 (4:5), JPEG, sRGB.** Not PNG — Meta rejects PNG.
5. **Nano Banana (Gemini image) generates photos only.** All typography is rendered
   deterministically in HTML/CSS. Legal disclaimer text must be exact, diffable and
   versionable; never let a generative model produce it.
6. **There is no auto-publish path.** Not behind a flag, not in an admin override. A human
   approves every post. This is a compliance requirement, not a preference.

---

## Hard constraints from the Instagram API

Verified against Meta's docs. Violating any of these fails at runtime, usually silently.

| Constraint | Value |
|---|---|
| Image format | **JPEG only.** PNG and extended JPEG (MPO, JPS) are rejected |
| Max file size | 8 MB |
| Width | 320px min, **1440px max** (wider gets downscaled) |
| Aspect ratio | 4:5 to 1.91:1 — we use **4:5, 1080×1350** |
| Color space | sRGB |
| Carousel items | 2 min, **10 max** |
| Carousel cropping | **All slides are cropped to the FIRST image's aspect ratio.** Render every slide at identical dimensions |
| Caption | 2,200 chars |
| Alt text | 1,000 chars, images only — use it, accessibility matters for a medical practice |
| Image hosting | **Public HTTPS URL required.** There is no binary upload path for images. Meta fetches the URL at publish time |
| Container expiry | **24 hours.** Never pre-create containers at approval time |
| Native scheduling | **Does not exist.** You build the scheduler |
| API draft state | **Does not exist.** The approval gate is yours |
| Rate limit | 100 published posts / rolling 24h per account. A carousel counts as 1 |
| API version | **Pin explicitly.** v20.0 sunset 2026-09-24. Use v25.0 or later. Never call unversioned |

### The publish flow

```
For each slide:  POST /{ig-user-id}/media   image_url=<public>  is_carousel_item=true
                 → child container id

Parent:          POST /{ig-user-id}/media   media_type=CAROUSEL
                                            children=<id1>,<id2>,<id3>,<id4>
                                            caption=<text>
                 → carousel container id

Publish:         POST /{ig-user-id}/media_publish   creation_id=<carousel container id>

Poll:            GET /{ig-container-id}?fields=status_code
                 → EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED
                 Poll once per minute, max 5 minutes.
```

Run all three steps as **one job at fire time**, because of the 24h container expiry.
Persist the returned media ID.

### Token refresh — the thing that will silently break this

Long-lived Instagram tokens expire on roughly a 60-day cycle and must be refreshed
programmatically before expiry. **Confirm the exact TTL and refresh endpoint against
Meta's current docs during implementation — do not trust the 60-day figure blindly.**

Requirements:
- Refresh job runs on a schedule well before expiry, not at expiry.
- **Failure must alert a human.** A silent refresh failure means publishing dies until the
  account owner re-authorizes, and nobody finds out until a post doesn't go up.
- Store per-account tokens encrypted **in the database, not in env vars.** They rotate.
- Surface token health in the UI — last refresh, next expiry, per account.

---

## Stack

- **Next.js (App Router) on Vercel** — team slug `iris-codes`
- **Postgres** — Neon or Supabase
- **Vercel Blob** for rendered slide JPEGs (public URLs, which Meta requires)
- **QStash or Inngest** for the scheduler. **Not Vercel Cron** — its granularity is too
  coarse for minute-level publishing
- **Playwright** (or Satori / `@vercel/og`) for HTML → JPEG rendering. If Playwright on
  serverless is painful, `@sparticuz/chromium` is the usual fix; Satori is lighter but has
  narrower CSS support — check it can do the layouts before committing
- Auth: any standard solution. Small, known user set

---

## Data model

```
tenant            id, slug, name, brand_tokens (jsonb), compliance_rules (jsonb),
                  template_set, created_at

ig_account        id, tenant_id, ig_user_id, username, access_token (encrypted),
                  token_expires_at, last_refreshed_at, status

post              id, tenant_id, ig_account_id, template, status, caption, alt_texts (jsonb),
                  scheduled_for (timestamptz), published_media_id, created_by,
                  approved_by, approved_at, failure_reason

slide             id, post_id, position, copy (jsonb), photo_prompt, photo_url,
                  rendered_url, width, height

audit_log         id, tenant_id, post_id, actor, action, payload (jsonb), created_at
```

### Post state machine

```
draft → pending_approval → approved → scheduled → publishing → published
                        ↘ rejected                          ↘ failed
```

- Only a human moves `pending_approval → approved`. No service account, no API key path.
- `approved → scheduled` sets `scheduled_for`.
- `scheduled → publishing` is the job picking it up.
- Every transition writes to `audit_log` with the actor. For a medical tenant this is the
  record that shows who approved what.

---

## Tenant configuration

`tenants/precision-vitality.json` is included in this package — it carries brand tokens,
the compliance ruleset, and template definitions. Load tenant config from the database,
seeded from files like this one.

**Compliance rules are per-tenant and are enforced in code, not left to the model.**
Precision Vitality's rules are medical-practice rules (HIPAA, FTC health claims, FDA
compounded-drug promotion, CA Bus & Prof Code §651). The senior living tenants will have
a *different* ruleset — Fair Housing, HOPA advertising, resident photo releases. Do not
hardcode either. The rules engine reads from tenant config.

Enforcement should be a validation pass that runs before a post can reach
`pending_approval`, returning blocking errors and warnings. A blocking error means the post
cannot be submitted.

---

## Content generation

### Copy
Claude (Anthropic API) writes slide copy and captions from the tenant's template
definitions and compliance rules. Feed the rules into the prompt **and** validate the
output against them afterward — prompt-level guidance is not enforcement.

### Photos
Gemini image generation ("Nano Banana") fills the photo slot on hook slides. Each template
carries a `photo_prompt`. Generated photos:
- Are **not** real patients and must never be captioned or implied as such.
- Still carry a disclosure line in the caption — treat AI imagery as requiring at least the
  same disclosure a stock model would under CA §651(b)(3)(B). Whether that rule covers AI
  images is untested; disclose and let the tenant's counsel refine it.
- Google applies SynthID watermarking. Do not attempt to strip it.

### Rendering
HTML/CSS templates with brand tokens injected, rendered headless to **JPEG at 1080×1350,
sRGB, under 8MB**. All four slides identical dimensions. Upload to Vercel Blob, store the
public URL on the slide row.

---

## The UI, screen by screen

This is the product. Build these screens, not a generic CRUD admin.

### Tone

Internal tool, but it should feel built rather than scaffolded. Dense over airy — this is a
working surface, not a marketing page. Real states for loading, empty, and error; generation
takes 20–60 seconds and the UI has to make that feel deliberate instead of broken. Branding
in `brand/` is deliberately scrappy; keep the *app* chrome clean and let the logo be the
only loud thing.

### 1. Queue (home)

The landing screen. A list of posts across all statuses, newest first, filterable by status
and tenant.

- Each row: 4 slide thumbnails, the hook headline, tenant badge, status pill, scheduled time.
- Status pills are colour-coded and unambiguous: `draft` `pending approval` `approved`
  `scheduled` `published` `failed`.
- **`failed` rows are loud and sticky at the top** with the failure reason inline. A post
  that didn't publish is the single most important thing this screen can tell you.
- Primary action, always visible: **New post**.
- Tenant switcher in the header. A single-tenant user never sees it.

### 2. Compose

One prompt box. Not a form.

- Large textarea, real placeholder: *"Make a post about why a normal TSH doesn't mean a
  normal thyroid."*
- Below it, collapsed by default: template picker (defaults to the tenant's primary
  template), target account, and an optional "reference this" field for pasting source
  material.
- The model infers the template from the prompt when it can; the picker is an override,
  not a required step.
- Submit generates. No intermediate confirm screen.

### 3. Generating

20–60 seconds. Show real progress, not a spinner.

Stepped indicator with each step completing visibly:
`Writing copy → Generating photo → Rendering slides → Running compliance checks`

Stream the copy in as it's written if the API allows it. Watching the headline appear makes
the wait feel like work happening. A spinner makes it feel hung.

### 4. Review — the core screen

Everything happens here. Two panes.

**Left — the carousel.** All four slides as large thumbnails, click to enlarge, swipeable in
the enlarged view exactly as Instagram will present it. This is the fidelity check: what you
see must be the JPEG that gets published, not an HTML approximation.

**Right — the editor.**
- Caption in a textarea with a live character count against Instagram's 2,200 limit and a
  **hashtag counter that turns red past 5**.
- Per-slide copy fields, inline editable. Editing re-renders that slide only.
- On the hook slide: the photo with **Regenerate**, plus an editable photo prompt. Keep the
  last 3–4 generations selectable as thumbnails — image gen is hit-or-miss and you'll want
  the second one back after trying a fourth.
- Alt text per slide, prefilled, editable.
- Slide reorder and delete. Enforce the 2–10 carousel bounds in the UI, not just server-side.

**Compliance panel** — persistent, in the right pane, never a modal.
- Green: *"5 checks passed."*
- Warnings are yellow, non-blocking, and explain themselves:
  *"Second-person condition framing. Fine organically — breaks Meta's ad policy if you boost
  this. "*
- **Blocking errors are red and disable the approve button**, naming the rule and the fix:
  *"'FDA-approved' appears near a compounded product. Misbranding under 21 U.S.C. 352(bb).
  Remove it or name the mechanism instead."*
- Every rule shows its `id` so a tenant's rules can be discussed and amended precisely.

**Footer actions:** `Save draft` · `Approve` → unlocks `Post now` and `Schedule`.

### 5. Schedule

A small popover, not a page.

- Date and time picker defaulting to **the tenant's next compliant posting window** — for
  Precision Vitality, the next Wed 12:00/18:00, Thu 09:00, or weekday 19:00–21:00.
- Picking a discouraged slot shows an inline note (*"Fridays and Saturdays underperform at
  every hour"*) but does not block. It's guidance, not a rule.
- Shows the tenant's timezone explicitly. Off-by-one-timezone is the classic bug here.

### 6. Accounts

Per-tenant connected Instagram accounts.

- Username, profile picture, account type, connection status.
- **Token health: last refreshed, next expiry, with a countdown.** Anything under 7 days is
  visibly alarming.
- `Connect account` runs the OAuth flow. `Reconnect` for an expired one.
- Today's publish count against the 100/24h limit.

### 7. Post detail

For published and failed posts.

- The four slides as published, final caption, published timestamp, link to the live post.
- **Full audit trail**: who generated it, who approved it, when, every state transition.
  For a medical tenant this is the record of who signed off.
- Failed posts: the error from Meta verbatim, plus `Retry`.

### Non-negotiable UI rules

- **No publish control anywhere except after a human approval.** Not in the queue, not a bulk
  action, not a keyboard shortcut.
- **Approve and Post now are separate clicks.** Approving is a judgement; publishing is an
  action. Fusing them means someone ships a post while skimming.
- The review screen shows **the actual rendered JPEGs**, never a CSS preview that could
  differ from output.
- Compliance state is visible without interaction. Never behind a tab or modal.

---

## Build order

Build a working vertical slice before breadth. Do not build auth, multi-tenancy UI, or the
scheduler until one carousel renders correctly.

1. **Renderer.** HTML templates → JPEG 1080×1350 → Vercel Blob → public URL. Verify with a
   real fetch that the URL is publicly reachable and the file is a valid JPEG under 8MB.
2. **Content pipeline.** Claude writes copy → Gemini generates the photo → renderer
   composites → 4 slide URLs. Precision Vitality's five carousels are in
   `content/precision-vitality-carousels.json` as both seed data and expected-output examples.
3. **Meta integration.** OAuth connect, token storage, token refresh with alerting, then the
   three-step publish flow. Test against a throwaway Instagram Business account added as a
   tester before touching a real one.
4. **Approval gate + state machine + audit log.**
5. **Scheduler.** QStash/Inngest, fire-time job runs all three Meta steps.
6. **Multi-tenant UI.** Tenant switcher, per-tenant branding, roles.

---

## Things that will bite you

- **PNG anywhere in the pipeline.** Meta rejects it. Emit JPEG from the start.
- **Mismatched slide dimensions.** Slides 2–4 get cropped to slide 1's ratio.
- **Pre-creating containers.** 24h expiry. Create at fire time only.
- **Vercel Cron for scheduling.** Too coarse. Use QStash or Inngest.
- **Unversioned Graph API calls.** v20.0 sunset 2026-09-24. Pin explicitly.
- **Silent token refresh failure.** Alert on it or you find out when a post doesn't publish.
- **Signed/expiring blob URLs.** Meta fetches at publish time. The URL must be live and
  unauthenticated at that moment.
- **Trusting the model for compliance.** Validate output in code against tenant rules.
- **Private or personal Instagram accounts.** Must be public Business or Creator.

---

## Environment variables

See `.env.example`. Note that **per-account Instagram tokens are NOT env vars** — they live
encrypted in the database and rotate.

---

## Meta app setup (human steps, do these once)

1. Create a Meta app, **Business** type, at developers.facebook.com.
2. Add the **Instagram** product. Use **Instagram Login**, not Facebook Login for Business.
3. Leave the app in **development mode**. Do not submit for App Review.
4. Note the App ID and App Secret → env vars.
5. Set the OAuth redirect URI to the deployed callback URL.
6. For each Instagram account to publish to: add it as an **Instagram Tester** in App Roles.
   The account owner accepts the invite inside Instagram, under app/website permissions →
   tester invites. The exact menu path moves between app versions — do this on a screen
   share rather than by written instructions.
7. Each account must be **public** and **Business or Creator**.

**When App Review becomes unavoidable:** the moment an Instagram account connects whose
owner does not hold a role on the Meta app — i.e. self-serve signup. Business Verification
gates App Review and must be completed first. Review has been running slow; start roughly
two months before you need it.
