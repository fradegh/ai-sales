import session from "express-session";
import connectPg from "connect-pg-simple";

/**
 * Session middleware: PostgreSQL store, 1 week TTL.
 * Used for email/password auth (session.userId).
 */
export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  const isProduction = process.env.NODE_ENV === "production";
  const trustProxy = process.env.TRUST_PROXY === "true";
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: trustProxy ? "auto" : isProduction,
      sameSite: "lax",
      maxAge: sessionTtl,
    },
  });
}
