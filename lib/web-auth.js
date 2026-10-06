const crypto = require("node:crypto");

const SESSION_COOKIE = "soundbots_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function sessionTokenFrom(request) {
  const cookies = request.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)soundbots_session=([a-f0-9]{64})(?:;|$)/);
  return match ? match[1] : null;
}

function createWebAuth(key, options = {}) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Set WEB_KEY in the environment before starting the dashboard.");
  }

  const now = options.now || Date.now;
  const ttl = options.sessionTtlMs || SESSION_TTL_MS;
  const keyDigest = digest(key);
  const sessions = new Map();

  function expireSessions() {
    const timestamp = now();
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= timestamp) sessions.delete(token);
    }
  }

  function verifyKey(candidate) {
    if (typeof candidate !== "string") return false;
    return crypto.timingSafeEqual(keyDigest, digest(candidate));
  }

  function createSession() {
    expireSessions();
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, now() + ttl);
    return token;
  }

  function hasSession(request) {
    expireSessions();
    const token = sessionTokenFrom(request);
    return Boolean(token && sessions.has(token));
  }

  function clearSession(request) {
    const token = sessionTokenFrom(request);
    if (token) sessions.delete(token);
  }

  function cookie(token, secure = false) {
    const attributes = [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(ttl / 1000)}`
    ];
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
  }

  return {
    verifyKey,
    createSession,
    hasSession,
    clearSession,
    cookie,
    clearCookie(secure = false) {
      return [
        `${SESSION_COOKIE}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0",
        ...(secure ? ["Secure"] : [])
      ].join("; ");
    }
  };
}

module.exports = { createWebAuth };
