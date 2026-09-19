import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Post lifecycle.
 *
 *   draft → pending_approval → approved → scheduled → publishing → published
 *                           ↘ rejected                          ↘ failed
 *
 * Only a human moves pending_approval → approved. Enforced in
 * src/lib/posts/state-machine.ts, not here.
 */
export const POST_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "scheduled",
  "publishing",
  "published",
  "failed",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const IG_ACCOUNT_STATUSES = [
  "connected",
  "expiring",
  "expired",
  "revoked",
  "error",
] as const;
export type IgAccountStatus = (typeof IG_ACCOUNT_STATUSES)[number];

export const tenant = pgTable("tenant", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  vertical: text("vertical").notNull().default("unspecified"),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  brandTokens: jsonb("brand_tokens").notNull().default({}),
  complianceRules: jsonb("compliance_rules").notNull().default({}),
  templateSet: jsonb("template_set").notNull().default({}),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const appUser = pgTable("app_user", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("approver"), // owner | approver | editor
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Which tenants a user may act on. A single-tenant user never sees the switcher. */
export const userTenant = pgTable(
  "user_tenant",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("user_tenant_pk").on(t.userId, t.tenantId)],
);

export const igAccount = pgTable(
  "ig_account",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    igUserId: text("ig_user_id").notNull(),
    username: text("username").notNull(),
    accountType: text("account_type"),
    profilePictureUrl: text("profile_picture_url"),
    /** AES-256-GCM ciphertext. Never a plaintext token, never an env var. */
    accessToken: text("access_token").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastRefreshError: text("last_refresh_error"),
    status: text("status").notNull().default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("ig_account_ig_user_id").on(t.igUserId)],
);

export const post = pgTable(
  "post",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    igAccountId: uuid("ig_account_id").references(() => igAccount.id, {
      onDelete: "set null",
    }),
    template: text("template").notNull().default("symptom_carousel"),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull().default("Untitled post"),
    prompt: text("prompt"),
    caption: text("caption").notNull().default(""),
    altTexts: jsonb("alt_texts").notNull().default([]),
    complianceReport: jsonb("compliance_report"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedMediaId: text("published_media_id"),
    /** Scheduler handle, so a reschedule can cancel the pending job. */
    scheduleJobId: text("schedule_job_id"),
    permalink: text("permalink"),
    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("post_tenant_created").on(t.tenantId, t.createdAt),
    index("post_status").on(t.status),
    index("post_scheduled_for").on(t.scheduledFor),
  ],
);

export const slide = pgTable(
  "slide",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull().default("hook"),
    copy: jsonb("copy").notNull().default({}),
    altText: text("alt_text").notNull().default(""),
    photoPrompt: text("photo_prompt"),
    photoUrl: text("photo_url"),
    renderedUrl: text("rendered_url"),
    width: integer("width").notNull().default(1080),
    height: integer("height").notNull().default(1350),
    bytes: integer("bytes"),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("slide_post_position").on(t.postId, t.position)],
);

/** Kept generations for the hook photo, so a rejected one can be recovered. */
export const photoGeneration = pgTable(
  "photo_generation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slideId: uuid("slide_id")
      .notNull()
      .references(() => slide.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    url: text("url").notNull(),
    provider: text("provider").notNull().default("gemini"),
    model: text("model"),
    selected: text("selected").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("photo_generation_slide").on(t.slideId, t.createdAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenant.id, {
      onDelete: "cascade",
    }),
    postId: uuid("post_id").references(() => post.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    actorType: text("actor_type").notNull().default("human"), // human | system
    action: text("action").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_post").on(t.postId, t.createdAt),
    index("audit_log_tenant").on(t.tenantId, t.createdAt),
  ],
);

/** One row per published/attempted publish, for the 100-per-24h rate limit. */
export const publishAttempt = pgTable(
  "publish_attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    igAccountId: uuid("ig_account_id")
      .notNull()
      .references(() => igAccount.id, { onDelete: "cascade" }),
    postId: uuid("post_id").references(() => post.id, { onDelete: "set null" }),
    succeeded: text("succeeded").notNull().default("false"),
    mediaId: text("media_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("publish_attempt_account").on(t.igAccountId, t.createdAt)],
);

export type Tenant = typeof tenant.$inferSelect;
export type AppUser = typeof appUser.$inferSelect;
export type IgAccount = typeof igAccount.$inferSelect;
export type Post = typeof post.$inferSelect;
export type Slide = typeof slide.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type PhotoGeneration = typeof photoGeneration.$inferSelect;
