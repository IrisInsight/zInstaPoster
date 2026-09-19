import { env } from "@/lib/env";

/**
 * A silent token-refresh failure means publishing dies until the account owner
 * re-authorises, and nobody finds out until a post does not go up. So a
 * failure here is loud: webhook, email, and a server log, and the alert
 * function itself never throws into the caller.
 */

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  severity: AlertSeverity;
  title: string;
  body: string;
  context?: Record<string, unknown>;
}

export async function sendAlert(alert: Alert): Promise<void> {
  const line = `[${alert.severity.toUpperCase()}] ${alert.title} — ${alert.body}`;
  if (alert.severity === "critical") console.error(line, alert.context ?? {});
  else console.warn(line, alert.context ?? {});

  await Promise.allSettled([webhookAlert(alert), emailAlert(alert)]);
}

async function webhookAlert(alert: Alert): Promise<void> {
  if (!env.alertWebhookUrl) return;
  await fetch(env.alertWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // `text` is what Slack-style webhooks render; the rest is for anything
      // that wants the parts rather than the sentence.
      text: `*${alert.title}*\n${alert.body}`,
      title: alert.title,
      body: alert.body,
      severity: alert.severity,
      context: alert.context ?? {},
      app: "zInstaPoster",
      at: new Date().toISOString(),
    }),
  }).catch((error) => {
    console.error("Alert webhook failed", error);
  });
}

async function emailAlert(alert: Alert): Promise<void> {
  if (!env.resendApiKey || !env.alertEmailTo) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.alertEmailFrom,
      to: [env.alertEmailTo],
      subject: `[zInstaPoster ${alert.severity}] ${alert.title}`,
      text: [
        alert.body,
        "",
        alert.context ? JSON.stringify(alert.context, null, 2) : "",
      ].join("\n"),
    }),
  }).catch((error) => {
    console.error("Alert email failed", error);
  });
}

/** True when nothing is wired up — surfaced in the UI so it is not a surprise. */
export function alertingConfigured(): boolean {
  return Boolean(env.alertWebhookUrl || (env.resendApiKey && env.alertEmailTo));
}
