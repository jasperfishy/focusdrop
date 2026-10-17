/* FocusDrop service worker
 * - caches the app shell so it opens instantly and works offline
 * - shows reminder notifications and opens the right thought when tapped
 * - on Chromium installed apps, can wake up now and then (periodic background
 *   sync) to send a gentle nudge. Nothing here talks to a server.
 */
var VERSION = "focusdrop-v2";
var CORE = [
  "./",
  "index.html",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) { return cache.addAll(CORE); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: try the network first so updates arrive, but don't make anyone wait
  // more than a moment. Fall back to the cached copy.
  if (req.mode === "navigate") {
    event.respondWith(
      new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          caches.match("index.html").then(function (c) { if (c && !settled) { settled = true; resolve(c); } });
        }, 2500);
        fetch(req).then(function (res) {
          clearTimeout(timer);
          if (!settled) { settled = true; resolve(res); }
          var copy = res.clone();
          caches.open(VERSION).then(function (cache) { cache.put("index.html", copy); });
        }).catch(function () {
          clearTimeout(timer);
          caches.match("index.html").then(function (c) {
            if (!settled) { settled = true; resolve(c || Response.error()); }
          });
        });
      })
    );
    return;
  }

  // Everything else (icons, manifest): cached copy first, refreshed quietly
  event.respondWith(
    caches.match(req).then(function (cached) {
      var refresh = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || refresh;
    })
  );
});

// ---- notifications ----
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var id = data.itemId || null;
  var target = new URL("./" + (id ? "#item=" + encodeURIComponent(id) : ""), self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(self.registration.scope) === 0 && "focus" in c) {
          if (id) c.postMessage({ type: "focus-item", id: id });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// ---- periodic nudge (Chromium installed apps only) ----
function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open("focusdrop-sw", 1);
    req.onupgradeneeded = function () { req.result.createObjectStore("kv"); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
function readSnap() {
  return openDb().then(function (db) {
    return new Promise(function (resolve) {
      var r = db.transaction("kv").objectStore("kv").get("snapshot");
      r.onsuccess = function () { db.close(); resolve(r.result || null); };
      r.onerror = function () { db.close(); resolve(null); };
    });
  }).catch(function () { return null; });
}
function writeSnap(snap) {
  return openDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(snap, "snapshot");
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); resolve(); };
    });
  }).catch(function () {});
}
function toMin(hhmm) {
  var p = String(hhmm).split(":");
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
function inQuiet(q) {
  if (!q) return false;
  var d = new Date();
  var m = d.getHours() * 60 + d.getMinutes();
  var s = toMin(q.start), e = toMin(q.end);
  if (s === e) return false;
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

function maybeNudge() {
  return readSnap().then(function (snap) {
    if (!snap || !snap.enabled) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    var now = Date.now();
    var hrs = snap.hours || 12;
    if ((now - (snap.lastFired || 0)) / 3600000 < hrs) return;
    if ((now - (snap.lastActive || 0)) / 3600000 < hrs) return;
    if (inQuiet(snap.quiet)) return;
    return self.clients.matchAll({ type: "window" }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) { if (wins[i].visibilityState === "visible") return; }
      var pool = (snap.items || []).filter(function (it) { return !(it.snoozeUntil && it.snoozeUntil > now); });
      var title, body, itemId = null;
      if (pool.length) {
        var it = pool[Math.floor(Math.random() * pool.length)];
        var t = it.text.length > 90 ? it.text.slice(0, 87) + "…" : it.text;
        title = "Still on your mind?";
        body = "“" + t + "”\n" + (it.firstStep ? "To start: " + it.firstStep : "One tiny step is plenty. No pressure.");
        itemId = it.id;
      } else {
        if ((now - (snap.lastFired || 0)) / 3600000 < 24) return;
        title = "FocusDrop";
        body = "Anything floating around in your head? Drop it here before it slips away.";
      }
      snap.lastFired = now;
      return self.registration.showNotification(title, {
        body: body,
        tag: "focusdrop-nudge",
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        data: { itemId: itemId }
      }).then(function () { return writeSnap(snap); });
    });
  });
}

self.addEventListener("periodicsync", function (event) {
  if (event.tag === "focusdrop-nudge") event.waitUntil(maybeNudge());
});
