(function () {
  "use strict";
  var cfg = window.__UPLAYER_PLAYER_CONFIG__ || {};
  var videoEl = document.getElementById("videoPlayer");
  if (!videoEl || typeof videojs === "undefined") return;

  // One full-screen Video.js player using its built-in controls (the control bar
  // already has a subtitles/captions menu, volume, seek, speed and fullscreen).
  // autoplay is driven by startPlayback() below rather than Video.js, so we can try
  // to start WITH sound and only fall back to muted if the browser refuses.
  var player = videojs(videoEl, {
    controls: true,
    autoplay: false,
    preload: "auto",
    fill: true,
    playbackRates: [0.5, 1, 1.25, 1.5, 2],
    html5: { vhs: { overrideNative: !videojs.browser.IS_SAFARI }, nativeAudioTracks: false, nativeVideoTracks: false },
  });

  // Start unmuted. Browsers reject autoplay-with-sound until a site has enough user
  // engagement, so if play() is rejected, retry muted — starting silently beats not
  // starting at all — and unmuteOnce() below restores sound on the first interaction.
  function startPlayback() {
    try { player.muted(false); if (player.volume() < 0.1) player.volume(1); } catch (e) {}
    var p = player.play();
    if (p && typeof p.catch === "function") {
      p.catch(function () {
        try { player.muted(true); } catch (e) {}
        var retry = player.play();
        if (retry && typeof retry.catch === "function") retry.catch(function () {});
      });
    }
  }

  // Unmute on the first user gesture (click/key/touch anywhere). Only has an effect if
  // startPlayback() had to fall back to a muted start.
  function unmuteOnce() {
    try { if (player.muted()) { player.muted(false); if (player.volume() < 0.1) player.volume(1); } } catch (e) {}
    document.removeEventListener("pointerdown", unmuteOnce);
    document.removeEventListener("keydown", unmuteOnce);
  }
  document.addEventListener("pointerdown", unmuteOnce);
  document.addEventListener("keydown", unmuteOnce);

  function sourceType() {
    if (cfg.isHlsSource) return "application/x-mpegURL";
    var u = String(cfg.videoUrl || "").toLowerCase();
    if (/\.webm($|\?)/.test(u)) return "video/webm";
    if (/\.mkv($|\?)/.test(u)) return "video/x-matroska";
    return "video/mp4";
  }
  if (cfg.videoUrl) player.src({ src: cfg.videoUrl, type: sourceType() });
  player.ready(startPlayback);

  // --- resume + progress reporting ------------------------------------------
  // ?t=<seconds> resumes where the user left off (threaded in by the app from
  // watch history). Seek once, as soon as the duration is known.
  var startAt = parseFloat(new URLSearchParams(window.location.search).get("t"));
  if (isFinite(startAt) && startAt > 0) {
    player.one("loadedmetadata", function () {
      try { if (startAt < (player.duration() || Infinity) - 5) player.currentTime(startAt); } catch (e) {}
    });
  }

  // Report the playhead every 10s while playing (plus on pause, and a beacon on
  // tab close) to this stream's own origin — the server folds it into watch
  // history for "Continue Watching". Positions below the floor are startup noise;
  // the threshold is injected so it has a single owner (core/playback-target.js).
  var minPositionSec = isFinite(cfg.minPositionSec) ? cfg.minPositionSec : 5;
  function progressPayload(ended) {
    var pos = player.currentTime(), dur = player.duration();
    if (!isFinite(pos) || pos < minPositionSec) return null;
    return JSON.stringify({
      positionSec: Math.floor(pos),
      durationSec: isFinite(dur) && dur > 0 ? Math.floor(dur) : null,
      ended: !!ended,
    });
  }
  function post(body) {
    if (!cfg.progressUrl || !body) return;
    try {
      fetch(cfg.progressUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  function reportProgress(ended) {
    post(progressPayload(ended));
  }
  setInterval(function () { if (!player.paused()) reportProgress(false); }, 10000);
  player.on("pause", function () { reportProgress(false); });
  player.on("ended", function () { reportProgress(true); });
  window.addEventListener("pagehide", function () {
    if (!cfg.progressUrl || !navigator.sendBeacon) return reportProgress(false);
    var body = progressPayload(false);
    if (body) { try { navigator.sendBeacon(cfg.progressUrl, new Blob([body], { type: "application/json" })); } catch (e) {} }
  });

  // Tell the server when playback fails. Video.js shows its own error modal on this
  // tab, but the tab the user is actually looking at is the main app — without this
  // it has no idea anything went wrong and just keeps showing "loading".
  player.on("error", function () {
    var err = null;
    try { err = player.error(); } catch (e) {}
    post(JSON.stringify({
      error: {
        code: err && err.code ? err.code : null,
        message: (err && err.message) ? String(err.message) : "Playback failed",
      },
    }));
  });

  // --- subtitles -----------------------------------------------------------
  // Pull tracks from /api/subtitles into Video.js's native captions menu, turning the
  // first one on by default. Subtitles are extracted in two passes (a quick "first
  // minutes" file, then the full one), so when a track flips to complete we reload it
  // once to pick up the rest of the cues — without duplicating it on screen.
  var subTracks = {}; // url -> { el, sig }
  function showingTrack() {
    var t = player.textTracks();
    for (var i = 0; i < t.length; i++) {
      if ((t[i].kind === "subtitles" || t[i].kind === "captions") && t[i].mode === "showing") return t[i];
    }
    return null;
  }
  // A track is identified by its URL, but its CONTENT can change underneath that URL:
  // the timing auto-fix swaps the corrected file in at the SAME index, so
  // /subtitle_0.vtt silently becomes a different file. Keying the "already loaded"
  // check on the URL alone meant the player bailed out and kept showing the
  // uncorrected cues forever, while the "Original timing" track the fix appends showed
  // up as a NEW entry — so it looked like the fix had created a second track instead of
  // updating the first. The signature is what actually moves: the label gains
  // "(auto-synced)", and `complete` flips when extraction finishes.
  function subSig(s) { return (s.label || s.name || "") + "|" + (s.complete ? 1 : 0); }
  function syncSub(s) {
    if (!s || !s.url) return;
    var cur = subTracks[s.url];
    if (cur && cur.sig === subSig(s)) return;  // same track, same version — nothing to do
    // Defaulting this to TRUE turned on every newly discovered track, not just the
    // first: a file with three embedded tracks showed three at once, and the "Original
    // timing" copy the auto-fix appends lit up alongside the corrected one — so the
    // viewer got the fixed and unfixed subtitle stacked on screen together. A track
    // being RELOADED keeps whatever state it had; a genuinely NEW one only comes on if
    // nothing is on yet, which is the "turn the first one on by default" rule.
    var wasShowing = false;
    if (cur && cur.el) {
      try { if (cur.el.track) wasShowing = (cur.el.track.mode === "showing"); } catch (e) {}
      try { player.removeRemoteTextTrack(cur.el); } catch (e) {}
    }
    var src = s.url + (s.url.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
    try {
      var el = player.addRemoteTextTrack({ kind: "subtitles", src: src, srclang: s.language || "en", label: s.label || s.name || "Subtitle" }, false);
      if (el && el.track && (wasShowing || !showingTrack())) el.track.mode = "showing";
      subTracks[s.url] = { el: el, sig: subSig(s) };
    } catch (e) {}
  }
  function pollSubs() {
    if (!cfg.subtitleManifestUrl) return;
    fetch(cfg.subtitleManifestUrl, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        ((d && d.subtitles) || []).forEach(function (s) { if (s.ready && s.url) syncSub(s); });
        updateToolButtons(d && d.tools, d && d.job, (d && d.subtitles) || []);
      })
      .catch(function () {});
  }
  setTimeout(pollSubs, 800);
  setInterval(pollSubs, 8000);

  // --- one-click subtitle tools (whisper generate / alass sync) -------------
  // Buttons appear in the control bar only when the server reports the binary is
  // installed. Both fire a background job on the stream's own origin; the finished
  // track then arrives through the normal manifest poll above.
  var toolButtons = {}; // kind -> videojs button component
  var manifestBase = String(cfg.subtitleManifestUrl || "").replace(/\/api\/subtitles$/, "");
  var lastSubCount = 0;

  function postTool(kind, payload) {
    return fetch(manifestBase + "/api/subtitles/" + kind, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; });
  }

  function makeToolButton(kind, text, title, onClick) {
    var Button = videojs.getComponent("Button");
    var btn = new Button(player, { clickHandler: onClick });
    btn.addClass("vjs-subtitle-tool");
    btn.addClass("vjs-subtitle-tool-" + kind);
    btn.controlText(title);
    btn.el().querySelector(".vjs-icon-placeholder").textContent = text;
    var bar = player.getChild("controlBar");
    // Insert before the fullscreen toggle so the buttons sit with the other menus.
    var fs = bar.getChild("fullscreenToggle");
    bar.addChild(btn, {}, fs ? bar.children().indexOf(fs) : undefined);
    return btn;
  }

  function updateToolButtons(tools, job, subs) {
    if (tools && tools.whisper && !toolButtons.generate) {
      toolButtons.generate = makeToolButton("generate", "AI CC", "Generate subtitles from the audio (whisper)", function () {
        postTool("generate", {});
        setButtonBusy("generate", true);
      });
    }
    // There is deliberately NO timing-fix button. The fix runs by itself on every
    // downloaded subtitle from the moment the stream starts
    // (StreamManager._autoSyncExternalSubtitle), and the corrected file replaces the
    // original at the SAME track index — so syncSub swaps it in and keeps it selected
    // if it was the track being watched. A button here only ever meant "do the thing
    // that was already happening", and its presence implied the fix was a step the
    // viewer was supposed to take.
    var running = job && job.running;
    setButtonBusy("generate", running && job.kind === "generate");
    // A finished job that produced a new track: auto-show it once.
    if (subs.length > lastSubCount) {
      var newest = subs[subs.length - 1];
      if (newest && (newest.source === "whisper" || newest.source === "alass") && newest.ready) {
        setTimeout(function () {
          var t = player.textTracks();
          for (var i = 0; i < t.length; i++) {
            if (t[i].label === newest.label) t[i].mode = "showing";
            else if (t[i].kind === "subtitles" || t[i].kind === "captions") t[i].mode = "disabled";
          }
        }, 500);
      }
    }
    lastSubCount = subs.length;
  }

  function setButtonBusy(kind, busy) {
    var btn = toolButtons[kind];
    if (!btn) return;
    if (busy) btn.addClass("vjs-subtitle-tool-busy");
    else btn.removeClass("vjs-subtitle-tool-busy");
    btn.el().disabled = !!busy;
  }

  // Nudge subtitle timing with [ and ] — no on-screen clutter.
  function shiftSubs(delta) {
    var tr = showingTrack();
    if (!tr || !tr.cues) return;
    for (var i = 0; i < tr.cues.length; i++) { tr.cues[i].startTime += delta; tr.cues[i].endTime += delta; }
  }

  // --- keyboard shortcuts --------------------------------------------------
  document.addEventListener("keydown", function (e) {
    if (e.target && /input|textarea|select/i.test(e.target.tagName || "")) return;
    switch (e.key) {
      case " ": case "Spacebar": e.preventDefault(); if (player.paused()) player.play(); else player.pause(); break;
      case "ArrowRight": player.currentTime(player.currentTime() + 5); break;
      case "ArrowLeft": player.currentTime(Math.max(0, player.currentTime() - 5)); break;
      case "ArrowUp": player.volume(Math.min(1, player.volume() + 0.1)); break;
      case "ArrowDown": player.volume(Math.max(0, player.volume() - 0.1)); break;
      case "m": case "M": player.muted(!player.muted()); break;
      case "f": case "F": if (player.isFullscreen()) player.exitFullscreen(); else player.requestFullscreen(); break;
      case "[": shiftSubs(-0.1); break;
      case "]": shiftSubs(0.1); break;
    }
  });
})();
