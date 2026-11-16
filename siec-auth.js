/*
 * Eye on the Almond: SIEC sign-in in the browser (for the hosted tester site).
 *
 * SIEC's SensorThings (FROST) data is only available to signed-in users, so
 * on a site without the local helper each visitor signs in to SIEC's Keycloak
 * with their own account (OpenID Connect, authorization code flow with PKCE).
 * The browser then sends the access token with every SensorThings request.
 * No password ever passes through this page, and no SIEC data is stored on
 * the site.
 *
 * Turned on by siec-auth.json next to this file:
 *   { "keycloakUrl": "https://kc.siec.ac.uk", "realm": "siec",
 *     "clientId": "...", "staUrl": "https://sensors.siec.ac.uk/FROST-Server/v1.1" }
 * Without that file (the Mac copy with its local helper) nothing changes.
 *
 * window.SiecAuth:
 *   ready            Promise, resolves once config and any sign-in redirect are handled
 *   enabled()        true when sign-in is configured
 *   signedIn()       true when there is a usable token
 *   user()           the signed-in user's name, or ""
 *   staUrl()         the SensorThings base URL to use
 *   handles(url)     true when url is on the SensorThings server
 *   fetchJson(url)   GET with the token; throws an error with .signInNeeded when not signed in
 *   signIn()         go to SIEC's sign-in page and come back here
 *   signOut()        forget the token (and end the SIEC session)
 *   onChange(fn)     called when the sign-in state changes
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var base = new URL(".", script ? script.src : location.href).href; // site root
  var CONFIG_URL = base + "siec-auth.json";
  var TOKEN_KEY = "almond.siec.token";
  var PENDING_KEY = "almond.siec.pending";
  var listeners = [];
  var config = null;
  var token = null; // { access, expiresAt, refresh, refreshExpiresAt, user }

  function store(t) {
    token = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* private window: keep it for this page only */
    }
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* ignore */
      }
    });
  }

  try {
    token = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
  } catch (e) {
    token = null;
  }

  // Take the sign-in answer off the address straight away, before the map
  // reads its own settings from it.
  var query = new URLSearchParams(location.search);
  var returned = null;
  if (query.has("code") && query.has("state")) {
    returned = { code: query.get("code"), state: query.get("state") };
    ["code", "state", "session_state", "iss"].forEach(function (k) {
      query.delete(k);
    });
    var q = query.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
  } else if (query.has("error") && query.has("state")) {
    console.warn("SIEC sign-in failed:", query.get("error"), query.get("error_description"));
    ["error", "error_description", "state", "session_state", "iss"].forEach(function (k) {
      query.delete(k);
    });
    var q2 = query.toString();
    history.replaceState(null, "", location.pathname + (q2 ? "?" + q2 : "") + location.hash);
  }

  function endpoint(name) {
    return (
      config.keycloakUrl.replace(/\/+$/, "") +
      "/realms/" + encodeURIComponent(config.realm) +
      "/protocol/openid-connect/" + name
    );
  }

  function b64url(bytes) {
    var s = "";
    bytes.forEach(function (b) {
      s += String.fromCharCode(b);
    });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64url(a);
  }

  function nameFrom(jwt) {
    try {
      var p = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return p.name || p.preferred_username || p.email || "";
    } catch (e) {
      return "";
    }
  }

  function fromResponse(json) {
    var now = Date.now();
    return {
      access: json.access_token,
      expiresAt: now + Math.max(0, (json.expires_in || 60) - 30) * 1000,
      refresh: json.refresh_token || null,
      refreshExpiresAt: json.refresh_expires_in
        ? now + Math.max(0, json.refresh_expires_in - 30) * 1000
        : now + 8 * 3600 * 1000,
      idToken: json.id_token || null,
      user: nameFrom(json.id_token || json.access_token)
    };
  }

  async function tokenRequest(params) {
    params.client_id = config.clientId;
    var res = await fetch(endpoint("token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    });
    var json = await res.json().catch(function () {
      return {};
    });
    if (!res.ok || !json.access_token)
      throw new Error("SIEC sign-in: " + (json.error_description || json.error || "HTTP " + res.status));
    return fromResponse(json);
  }

  async function finishSignIn() {
    var pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
      sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {
      pending = null;
    }
    if (!pending || pending.state !== returned.state) {
      console.warn("SIEC sign-in: unexpected answer, ignored");
      return;
    }
    try {
      store(
        await tokenRequest({
          grant_type: "authorization_code",
          code: returned.code,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier
        })
      );
    } catch (e) {
      console.warn(e.message);
      return;
    }
    // Go back to the page the sign-in started from (e.g. the sensor explorer).
    if (pending.returnTo && pending.returnTo.split("#")[0] !== location.href.split("#")[0]) {
      location.replace(pending.returnTo);
    }
  }

  async function accessToken() {
    if (!token) return null;
    var now = Date.now();
    if (token.expiresAt > now) return token.access;
    if (token.refresh && token.refreshExpiresAt > now) {
      try {
        var t = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh });
        if (!t.user) t.user = token.user;
        store(t);
        return t.access;
      } catch (e) {
        console.warn(e.message);
      }
    }
    store(null);
    return null;
  }

  function signInNeeded() {
    var e = new Error("Sign in to SIEC to see the sensor data.");
    e.signInNeeded = true;
    return e;
  }

  var api = {
    ready: null,
    enabled: function () {
      return !!(config && config.clientId);
    },
    signedIn: function () {
      return !!(token && (token.expiresAt > Date.now() || token.refreshExpiresAt > Date.now()));
    },
    user: function () {
      return (token && token.user) || "";
    },
    staUrl: function () {
      return config && config.staUrl ? config.staUrl.replace(/\/+$/, "") : "";
    },
    handles: function (url) {
      var sta = api.staUrl();
      return !!sta && String(url).indexOf(sta) === 0;
    },
    fetchJson: async function (url) {
      await api.ready;
      var headers = { Accept: "application/json" };
      if (api.enabled() && api.handles(url)) {
        var t = await accessToken();
        if (!t) throw signInNeeded();
        headers.Authorization = "Bearer " + t;
      }
      // FROST answers a missing or expired sign-in with a redirect to the
      // sign-in page; don't follow it.
      var res = await fetch(url, { headers: headers, redirect: "manual" });
      if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) {
        if (api.handles(url)) {
          store(null);
          throw signInNeeded();
        }
      }
      if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
      return res.json();
    },
    signIn: async function () {
      await api.ready;
      if (!api.enabled()) return;
      var verifier = randomString(48);
      var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      var state = randomString(16);
      var redirectUri = config.redirectUri || base;
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({ state: state, verifier: verifier, redirectUri: redirectUri, returnTo: location.href })
        );
      } catch (e) {
        /* sign-in still works, but the answer can't be checked: refuse */
        alert("Sign-in needs this browser to allow site storage.");
        return;
      }
      location.assign(
        endpoint("auth") +
          "?" +
          new URLSearchParams({
            client_id: config.clientId,
            response_type: "code",
            scope: "openid",
            redirect_uri: redirectUri,
            state: state,
            code_challenge: b64url(new Uint8Array(digest)),
            code_challenge_method: "S256"
          }).toString()
      );
    },
    signOut: function () {
      var idToken = token && token.idToken;
      store(null);
      if (api.enabled() && idToken) {
        location.assign(
          endpoint("logout") +
            "?" +
            new URLSearchParams({
              client_id: config.clientId,
              id_token_hint: idToken,
              post_logout_redirect_uri: config.redirectUri || base
            }).toString()
        );
      } else {
        location.reload();
      }
    },
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) {
          return f !== fn;
        });
      };
    }
  };

  api.ready = (async function () {
    try {
      var res = await fetch(CONFIG_URL, { cache: "no-cache" });
      if (res.ok) config = await res.json();
    } catch (e) {
      config = null;
    }
    if (config && config.clientId && returned) await finishSignIn();
  })();

  window.SiecAuth = api;
})();
