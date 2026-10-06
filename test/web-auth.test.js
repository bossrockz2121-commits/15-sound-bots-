const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createWebAuth } = require("../lib/web-auth");

function requestWithCookie(cookie) {
  return { headers: { cookie } };
}

describe("dashboard web-key authentication", () => {
  it("checks keys without exposing or storing the submitted value", () => {
    const auth = createWebAuth("a-private-key");
    assert.equal(auth.verifyKey("a-private-key"), true);
    assert.equal(auth.verifyKey("incorrect"), false);
    assert.equal(auth.verifyKey(undefined), false);
  });

  it("creates an HttpOnly same-site session cookie and validates the session", () => {
    const auth = createWebAuth("a-private-key");
    const token = auth.createSession();
    const cookie = auth.cookie(token, true);

    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=2592000/);
    assert.equal(auth.hasSession(requestWithCookie(cookie)), true);
  });

  it("expires sessions", () => {
    let timestamp = 100;
    const auth = createWebAuth("a-private-key", {
      now: () => timestamp,
      sessionTtlMs: 50
    });
    const token = auth.createSession();
    const request = requestWithCookie(`soundbots_session=${token}`);

    assert.equal(auth.hasSession(request), true);
    timestamp += 50;
    assert.equal(auth.hasSession(request), false);
    assert.match(auth.clearCookie(), /Max-Age=0/);
  });

  it("keeps signed sessions valid across server restarts without exposing the key", () => {
    const auth = createWebAuth("a-private-key");
    const token = auth.createSession();
    const request = requestWithCookie(`soundbots_session=${token}`);

    assert.equal(createWebAuth("a-private-key").hasSession(request), true);
    assert.equal(createWebAuth("different-key").hasSession(request), false);
    assert.equal(auth.hasSession(requestWithCookie(`soundbots_session=${token}x`)), false);
  });

  it("requires a configured key", () => {
    assert.throws(() => createWebAuth(""), /Set WEB_KEY/);
  });
});
