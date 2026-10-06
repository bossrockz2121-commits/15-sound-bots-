const crypto = require("node:crypto");

const SESSION_COOKIE = "soundbots_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function sessionTokenFrom(request) {
  const cookies = request.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)soundbots_session=([^;]*)(?:;|$)/);
  return match ? match[1] : null;
}

function createWebAuth(key, options = {}) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Set WEB_KEY in the environment before starting the dashboard.");
  }

  const now = options.now || Date.now;
  const ttl = options.sessionTtlMs || SESSION_TTL_MS;
  const keyDigest = digest(key);
  const sessionSecret = crypto.createHmac("sha256", keyDigest).update("soundbots-session").digest();

  function verifyKey(candidate) {
    if (typeof candidate !== "string") return false;
    return crypto.timingSafeEqual(keyDigest, digest(candidate));
  }

  function createSession() {
    const expiresAt = now() + ttl;
    const payload = `${expiresAt}.${crypto.randomBytes(16).toString("hex")}`;
    const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
    return `${payload}.${signature}`;
  }

  function hasSession(request) {
    const token = sessionTokenFrom(request);
    const match = token && token.match(/^(\d+)\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
    if (!match) return false;
    const expiresAt = Number(match[1]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false;
    const payload = `${match[1]}.${match[2]}`;
    const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(match[3], "hex"));
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
