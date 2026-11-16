import { randomBytes, createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { httpError, text, email, password, rateLimit } from "./security.js";
const digest = (s) => createHash("sha256").update(s).digest("hex");
async function readResponse(response) {
  const data = await response.json();
  if (!response.ok)
    throw httpError(
      response.status,
      data.message || "Account security request failed",
    );
  return data;
}
export function createAccountSecurity({
  db,
  authentication,
  session,
  syncUser,
  frontendURL = process.env.FRONTEND_URL,
}) {
  return {
    async signIn(req, res) {
      const response = await authentication.api.signInEmail({
        asResponse: true,
        body: {
          email: email(req.body.email),
          password: password(req.body.password),
        },
        headers: fromNodeHeaders(req.headers),
      });
      const result = await readResponse(response);
      if (result.twoFactorRedirect) {
        const cookies = (response.headers.getSetCookie?.() || [])
          .map((c) => c.split(";")[0])
          .filter((c) => c.includes("two_factor=") && !c.endsWith("="));
        if (!cookies.length)
          throw httpError(502, "Could not start two-step sign-in");
        const challenge = randomBytes(32).toString("hex");
        await db.pool.query(
          "delete from auth_challenges where expires_at<now()",
        );
        await db.pool.query(
          "insert into auth_challenges(token_hash,cookie,expires_at) values($1,$2,now()+interval '5 minutes')",
          [digest(challenge), cookies.join("; ")],
        );
        res.json({ twoFactorRequired: true, challenge });
        return;
      }
      res.json(await session(await syncUser(result.user), result.token));
    },
    register(app, { auth, asyncHandler }) {
      app.use(
        ["/auth/two-factor", "/auth/security", "/auth/recovery"],
        rateLimit({ max: 15, windowMs: 300000 }),
      );
      app.post(
        "/auth/two-factor",
        asyncHandler(async (req, res) => {
          const challenge = text(req.body.challenge, "challenge", 128);
          const code = text(req.body.code, "verification code", 100);
          const row = (
            await db.pool.query(
              "update auth_challenges set attempts=attempts+1 where token_hash=$1 and expires_at>now() and attempts<5 returning cookie",
              [digest(challenge)],
            )
          ).rows[0];
          if (!row)
            throw httpError(
              401,
              "Verification expired or attempt limit reached. Sign in again",
            );
          const headers = fromNodeHeaders(req.headers);
          headers.delete("authorization");
          headers.set("cookie", row.cookie);
          const response = await (
            req.body.backup === true
              ? authentication.api.verifyBackupCode
              : authentication.api.verifyTOTP
          )({ asResponse: true, body: { code, trustDevice: false }, headers });
          const result = await readResponse(response);
          await db.pool.query(
            "delete from auth_challenges where token_hash=$1",
            [digest(challenge)],
          );
          res.json(
            await session(
              await syncUser(result.user),
              response.headers.get("set-auth-token") || result.token,
            ),
          );
        }),
      );
      app.get(
        "/auth/security",
        auth,
        asyncHandler(async (req, res) =>
          res.json({
            twoFactorEnabled: req.authSession.user.twoFactorEnabled === true,
            recoveryConfigured:
              !!authentication.options.emailAndPassword?.sendResetPassword,
          }),
        ),
      );
      for (const [action, method] of [
        ["enable", "enableTwoFactor"],
        ["verify", "verifyTOTP"],
        ["disable", "disableTwoFactor"],
      ])
        app.post(
          "/auth/security/" + action,
          auth,
          asyncHandler(async (req, res) => {
            const body =
              action === "verify"
                ? { code: text(req.body.code, "authenticator code", 10) }
                : {
                    password: password(req.body.password),
                    ...(action === "enable" ? { method: "totp" } : {}),
                  };
            const response = await authentication.api[method]({
              asResponse: true,
              headers: fromNodeHeaders(req.headers),
              body,
            });
            const result = await readResponse(response);
            const rotated = response.headers.get("set-auth-token");
            res.json({ ...result, ...(rotated ? { token: rotated } : {}) });
          }),
        );
      app.post(
        "/auth/recovery",
        asyncHandler(async (req, res) => {
          if (
            !authentication.options.emailAndPassword?.sendResetPassword ||
            !frontendURL
          )
            throw httpError(
              503,
              "Password-reset email is not configured. Contact your workspace administrator",
            );
          await authentication.api.requestPasswordReset({
            body: {
              email: email(req.body.email),
              redirectTo: new URL(frontendURL).origin,
            },
            headers: fromNodeHeaders(req.headers),
          });
          res.json({
            message:
              "If that account exists, a password-reset link has been sent.",
          });
        }),
      );
      app.post(
        "/auth/recovery/reset",
        asyncHandler(async (req, res) => {
          await authentication.api.resetPassword({
            body: {
              token: text(req.body.token, "reset token", 200),
              newPassword: password(req.body.newPassword, true),
            },
            headers: fromNodeHeaders(req.headers),
          });
          res.json({
            message: "Password reset. Sign in with your new password.",
          });
        }),
      );
    },
  };
}
