import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { httpError, PLAN_LIMITS } from "./security.js";
import { withScheduleLock } from "./scheduling.js";
export function makeResetMailer({
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.MAIL_FROM,
  frontendURL = process.env.FRONTEND_URL,
  send = fetch,
} = {}) {
  if (!apiKey || !from || !frontendURL) return null;
  const origin = new URL(frontendURL).origin;
  if (!origin.startsWith("https:") && process.env.NODE_ENV === "production")
    throw new Error("FRONTEND_URL must use HTTPS in production");
  return async ({ user, token }) => {
    const url = `${origin}/#reset=${encodeURIComponent(token)}`;
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `reset/${createHash("sha256").update(token).digest("hex")}`,
      },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject: "Reset your PulseShift password",
        text: `Reset your PulseShift password using this link:\n\n${url}\n\nThis link expires in one hour and can be used once. If you did not request this change, ignore this email.`,
      }),
    });
    if (!response.ok) throw new Error("Password-reset email delivery failed");
  };
}
export function verifyStripeSignature(raw, header, secret, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || typeof header !== "string" || !secret)
    return false;
  const values = header.split(",").map((p) => p.split("="));
  const timestamp = values.find(([k]) => k === "t")?.[1];
  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest();
  return values
    .filter(([k]) => k === "v1")
    .some(
      ([, v]) =>
        /^[a-f\d]{64}$/i.test(v) &&
        timingSafeEqual(Buffer.from(v, "hex"), expected),
    );
}
export function createBilling({
  db,
  secret = process.env.STRIPE_SECRET_KEY,
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  frontendURL = process.env.FRONTEND_URL,
  prices = {
    TEAM: process.env.STRIPE_TEAM_PRICE_ID,
    BUSINESS: process.env.STRIPE_BUSINESS_PRICE_ID,
  },
  send = fetch,
} = {}) {
  const configured = !!(
    secret &&
    webhookSecret &&
    frontendURL &&
    prices.TEAM &&
    prices.BUSINESS
  );
  async function stripe(path, body, key) {
    const response = await send("https://api.stripe.com/v1" + path, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw httpError(
        502,
        "The billing provider could not complete the request",
      );
    return result;
  }
  return {
    configured,
    async webhook(req, res, next) {
      try {
        if (!configured)
          throw httpError(503, "Automatic billing is not configured");
        if (
          !verifyStripeSignature(
            req.body,
            req.headers["stripe-signature"],
            webhookSecret,
          )
        )
          throw httpError(400, "Invalid billing signature");
        const event = JSON.parse(req.body.toString("utf8"));
        if (
          !/^customer\.subscription\.(created|updated|deleted)$/.test(
            event.type,
          )
        ) {
          res.json({ received: true, ignored: true });
          return;
        }
        const object = event.data.object;
        // Retrieve the current object rather than trusting delivery order or a stale event snapshot.
        const subscription = event.type.endsWith("deleted")
          ? object
          : await stripe("/subscriptions/" + encodeURIComponent(object.id));
        await withScheduleLock(db, async (client) => {
          if (
            (
              await client.query("select 1 from billing_events where id=$1", [
                event.id,
              ])
            ).rows.length
          )
            return;
          const orgId = subscription.metadata?.orgId;
          const customer =
            typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer?.id;
          const account = (
            await client.query(
              "select * from billing_accounts where org_id=$1 for update",
              [orgId],
            )
          ).rows[0];
          if (!account || account.customer_id !== customer)
            throw httpError(400, "Billing workspace does not match");
          if (account.last_event_created > event.created) {
            await client.query("insert into billing_events(id) values($1)", [
              event.id,
            ]);
            return;
          }
          const price = subscription.items?.data?.[0]?.price?.id;
          const tier = Object.keys(prices).find((k) => prices[k] === price);
          if (!tier) throw httpError(400, "Unknown subscription price");
          const paid = ["active", "trialing"].includes(subscription.status);
          const plan = paid ? tier : "ESSENTIALS";
          const limits = PLAN_LIMITS[plan];
          await client.query(
            "update billing_accounts set subscription_id=$2,status=$3,price_id=$4,last_event_created=$5,updated_at=now() where org_id=$1",
            [orgId, subscription.id, subscription.status, price, event.created],
          );
          await client.query(
            "update organizations set plan=$2,request_limit=$3,ai_credits=$4,trial_expires_at=null,trial_ends_on=null where id=$1",
            [orgId, plan, limits.requestLimit, limits.aiCredits],
          );
          await client.query("insert into billing_events(id) values($1)", [
            event.id,
          ]);
          await client.query(
            "insert into workforce_audit(org_id,action,entity_id,details) values($1,'BILLING_SYNC',$2,$3::jsonb)",
            [
              orgId,
              subscription.id,
              JSON.stringify({ status: subscription.status, plan }),
            ],
          );
        });
        res.json({ received: true });
      } catch (error) {
        next(error);
      }
    },
    register(app, { auth, member, admin, asyncHandler }) {
      const base = "/orgs/:orgId/billing";
      app.get(
        base,
        auth,
        member,
        admin,
        asyncHandler(async (req, res) => {
          res.json({
            configured,
            account:
              (
                await db.pool.query(
                  'select status,subscription_id as "subscriptionId" from billing_accounts where org_id=$1',
                  [req.orgId],
                )
              ).rows[0] || null,
          });
        }),
      );
      app.post(
        base + "/checkout",
        auth,
        member,
        admin,
        asyncHandler(async (req, res) => {
          if (!configured)
            throw httpError(
              503,
              "Configure billing keys and plan prices before accepting payments",
            );
          if (!Object.hasOwn(prices, req.body.plan) || !prices[req.body.plan])
            throw httpError(400, "Choose a supported plan");
          if (
            typeof req.body.operationId !== "string" ||
            !/^[\w-]{10,100}$/.test(req.body.operationId)
          )
            throw httpError(400, "Operation ID required");
          let account = (
            await db.pool.query(
              "select * from billing_accounts where org_id=$1",
              [req.orgId],
            )
          ).rows[0];
          if (
            account?.subscription_id &&
            ["active", "trialing", "past_due"].includes(account.status)
          )
            throw httpError(
              409,
              "Manage the existing subscription in the billing portal",
            );
          if (!account?.customer_id) {
            const customer = await stripe(
              "/customers",
              { "metadata[orgId]": req.orgId },
              "customer/" + req.orgId,
            );
            await db.pool.query(
              "insert into billing_accounts(org_id,customer_id,status) values($1,$2,'PENDING') on conflict(org_id) do update set customer_id=excluded.customer_id",
              [req.orgId, customer.id],
            );
            account = { customer_id: customer.id };
          }
          const origin = new URL(frontendURL).origin;
          const session = await stripe(
            "/checkout/sessions",
            {
              customer: account.customer_id,
              mode: "subscription",
              "line_items[0][price]": prices[req.body.plan],
              "line_items[0][quantity]": "1",
              "subscription_data[metadata][orgId]": req.orgId,
              success_url: origin + "/?billing=success",
              cancel_url: origin + "/?billing=cancelled",
            },
            `checkout/${req.orgId}/${req.userId}/${req.body.operationId}`,
          );
          res.json({ url: session.url });
        }),
      );
      app.post(
        base + "/portal",
        auth,
        member,
        admin,
        asyncHandler(async (req, res) => {
          if (!configured) throw httpError(503, "Billing is not configured");
          const account = (
            await db.pool.query(
              "select customer_id from billing_accounts where org_id=$1",
              [req.orgId],
            )
          ).rows[0];
          if (!account?.customer_id)
            throw httpError(404, "No billing account exists");
          res.json({
            url: (
              await stripe("/billing_portal/sessions", {
                customer: account.customer_id,
                return_url: new URL(frontendURL).origin,
              })
            ).url,
          });
        }),
      );
    },
  };
}
