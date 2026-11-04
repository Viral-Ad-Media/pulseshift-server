import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { validateSecret } from "./security.js";
export const DEMO_IDS = new Set([
  "u-admin",
  "u-jake",
  "u-sergio",
  "u-cgomez",
  "u-devon",
]);
export const authModels = {
  user: {
    modelName: "auth_users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    modelName: "auth_sessions",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
    },
    expiresIn: 43200,
    updateAge: 3600,
    cookieCache: { enabled: false },
  },
  account: {
    modelName: "auth_accounts",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "auth_verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
};
export function authOptions({
  pool,
  secret,
  baseURL = "http://localhost:4000",
  trustedOrigins = ["http://localhost:3000"],
}) {
  validateSecret(secret);
  return {
    appName: "PulseShift",
    database: pool,
    secret,
    baseURL,
    basePath: "/api/auth",
    trustedOrigins,
    ...authModels,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 72,
      autoSignIn: true,
      password: {
        hash: hashPassword,
        verify: async ({ hash, password }) =>
          /^\$2[aby]\$/.test(hash)
            ? Buffer.byteLength(password, "utf8") <= 72
              ? bcrypt.compare(password, hash)
              : false
            : verifyPassword({ hash, password }),
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-pulseshift-ip"] },
      database: { generateId: () => `u-${randomUUID()}` },
    },
    plugins: [bearer()],
    databaseHooks: {
      session: {
        create: {
          before: async (session) =>
            DEMO_IDS.has(session.userId) ? false : undefined,
        },
      },
    },
    rateLimit: { enabled: true, window: 60, max: 20 },
  };
}
export const createAuthentication = (options) =>
  betterAuth(authOptions(options));
