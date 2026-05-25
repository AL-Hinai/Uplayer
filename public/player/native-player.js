(function () {
  "use strict";

  var cfg = window.__UPLAYER_PLAYER_CONFIG__ || {};
  var video = document.getElementById("videoPlayer");
  var subtitleSelect = document.getElementById("subtitleSelect");
  var subtitleOverlay = document.getElementById("subtitleOverlay");
  var subtitleAdjustBtn = document.getElementById("subtitleAdjustBtn");
  var subtitleAdjustPopup = document.getElementById("subtitleAdjustPopup");
  var closePopupBtn = document.getElementById("closePopupBtn");
  var subtitlePreview = document.getElementById("subtitlePreview");
  var offsetValue = document.getElementById("offsetValue");
  var statusText = document.getElementById("statusText");
  var retryBtn = document.getElementById("retryBtn");
  var errorOverlay = document.getElementById("errorOverlay");
  var errorMessage = document.getElementById("errorMessage");
  var reloadBtn = document.getElementById("reloadBtn");

  var fallbackTried = false;
  var selectedSubtitleIndex = null;
  var subtitleOffset = 0;
  var subtitlePollId = null;
  var subtitleManifestPollId = null;
  var subtitleTrackReady = {};
  var subtitleTrackComplete = {};
  var subtitleTrackFinalized = {};
  var stallRecoveryTimer = null;
  var lastRecoveryAt = 0;
  var lastKnownCueCount = -1;
  var lastPreviewSignature = "";
  var lastOverlaySignature = "";
  var lastOverlayRenderAt = 0;
  var lastPreviewRenderAt = 0;

  function setStatus(text) {
    if (statusText) statusText.textContent = text;
  }

  function hideError() {
    if (errorOverlay) errorOverlay.classList.remove("visible");
  }

  function showError(text) {
    if (errorMessage) errorMessage.textContent = text || "Playback failed.";
    if (errorOverlay) errorOverlay.classList.add("visible");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatCueText(value) {
    return escapeHtml(value).replace(/\r?\n/g, "<br>");
  }

  function formatTime(seconds) {
    var total = Number.isFinite(seconds) ? seconds : 0;
    var sign = total < 0 ? "-" : "";
    var abs = Math.abs(total);
    var hours = Math.floor(abs / 3600);
    var minutes = Math.floor((abs % 3600) / 60);
    var secs = Math.floor(abs % 60);
    var millis = Math.floor((abs % 1) * 1000);

    if (hours > 0) {
      return sign
        + hours
        + ":"
        + String(minutes).padStart(2, "0")
        + ":"
        + String(secs).padStart(2, "0")
        + "."
        + String(millis).padStart(3, "0");
    }

    return sign
      + minutes
      + ":"
      + String(secs).padStart(2, "0")
      + "."
      + String(millis).padStart(3, "0");
  }

  function isPopupVisible() {
    return !!(subtitleAdjustPopup && !subtitleAdjustPopup.hidden);
  }

  function setPreviewMessage(text) {
    if (!subtitlePreview) return;
    var html = '<div class="subtitle-empty">' + escapeHtml(text) + "</div>";
    if (html !== lastPreviewSignature) {
      subtitlePreview.innerHTML = html;
      lastPreviewSignature = html;
    }
  }

  function clearSubtitleOverlay() {
    if (!subtitleOverlay) return;
    subtitleOverlay.innerHTML = "";
    subtitleOverlay.classList.remove("visible");
    lastOverlaySignature = "";
  }

  function getSubtitleTracks() {
    if (!video || !video.textTracks) return [];
    return Array.prototype.slice.call(video.textTracks).filter(function (track) {
      return track.kind === "subtitles";
    });
  }

  function mapTrackName(track, idx) {
    var meta = Array.isArray(cfg.subtitleTracks) ? cfg.subtitleTracks[idx] : null;
    var label = track.label || (meta && meta.label) || ("Subtitle " + (idx + 1));
    var language = track.language || (meta && meta.language) || "";

    if (language && label.toLowerCase().indexOf(language.toLowerCase()) === -1) {
      return label + " (" + language + ")";
    }

    return label;
  }

  function getSelectedTrack() {
    var tracks = getSubtitleTracks();
    if (selectedSubtitleIndex === null || selectedSubtitleIndex < 0 || selectedSubtitleIndex >= tracks.length) {
      return null;
    }
    return tracks[selectedSubtitleIndex];
  }

  function findInitialSubtitleIndex(tracks) {
    var activeIndex = tracks.findIndex(function (track) {
      return track.mode === "showing" || track.mode === "hidden";
    });

    if (activeIndex !== -1) return activeIndex;
    return tracks.length > 0 ? 0 : -1;
  }

  function refreshSubtitleControlsVisibility() {
    var hasTracks = getSubtitleTracks().length > 0;
    if (subtitleAdjustBtn) subtitleAdjustBtn.hidden = !hasTracks;
    if (!hasTracks && subtitleAdjustPopup) {
      subtitleAdjustPopup.hidden = true;
    }
  }

  function refreshSubtitleSelect() {
    if (!subtitleSelect) return;

    var tracks = getSubtitleTracks();
    subtitleSelect.innerHTML = "";

    var off = document.createElement("option");
    off.value = "-1";
    off.textContent = "Subtitles: Off";
    subtitleSelect.appendChild(off);

    tracks.forEach(function (track, idx) {
      var opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = mapTrackName(track, idx);
      subtitleSelect.appendChild(opt);
    });

    if (selectedSubtitleIndex === null) {
      selectedSubtitleIndex = findInitialSubtitleIndex(tracks);
    } else if (selectedSubtitleIndex >= tracks.length) {
      selectedSubtitleIndex = tracks.length > 0 ? 0 : -1;
    }

    subtitleSelect.value = String(selectedSubtitleIndex >= 0 ? selectedSubtitleIndex : -1);
    refreshSubtitleControlsVisibility();
  }

  function clearSubtitlePolling() {
    if (subtitlePollId) {
      clearInterval(subtitlePollId);
      subtitlePollId = null;
    }
  }

  function syncSelectedTrack() {
    var track = getSelectedTrack();
    var cueCount = track && track.cues ? track.cues.length : 0;

    if (cueCount !== lastKnownCueCount) {
      lastKnownCueCount = cueCount;
      renderSubtitleOverlay(true);
      if (isPopupVisible()) renderSubtitlePreview(true);
    }
  }

  function startSubtitlePolling() {
    clearSubtitlePolling();
    syncSelectedTrack();
    subtitlePollId = setInterval(syncSelectedTrack, 1500);
  }

  // Embedded subtitles are extracted on the server while the torrent downloads, so the
  // .vtt grows over time. The browser only fetches a <track> once, so we rebuild the
  // active track element with a cache-busting query to pull in newly-extracted cues.
  function getTrackElements() {
    if (!video) return [];
    return Array.prototype.slice.call(video.querySelectorAll("track"));
  }

  function refreshActiveSubtitleTrack() {
    if (selectedSubtitleIndex === null || selectedSubtitleIndex < 0) return;

    var trackEls = getTrackElements();
    var oldEl = trackEls[selectedSubtitleIndex];
    if (!oldEl) return;

    var meta = Array.isArray(cfg.subtitleTracks) ? cfg.subtitleTracks[selectedSubtitleIndex] : null;
    var baseUrl = (meta && meta.url) || oldEl.getAttribute("src") || "";
    if (!baseUrl) return;
    var cleanUrl = baseUrl.split("?")[0];

    var newEl = document.createElement("track");
    newEl.kind = "subtitles";
    newEl.setAttribute("src", cleanUrl + "?t=" + Date.now());
    var srclang = oldEl.getAttribute("srclang");
    if (srclang) newEl.setAttribute("srclang", srclang);
    var label = oldEl.getAttribute("label");
    if (label) newEl.setAttribute("label", label);

    // Replacing in the same DOM position keeps textTracks ordering stable, so
    // selectedSubtitleIndex still maps correctly. The addtrack handler re-applies
    // selection and offset.
    oldEl.replaceWith(newEl);
  }

  function pollSubtitleManifest() {
    var url = cfg.subtitleManifestUrl;
    if (!url) {
      stopSubtitleManifestPolling();
      return;
    }

    fetch(url, { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var subs = (data && Array.isArray(data.subtitles)) ? data.subtitles : [];
        subs.forEach(function (sub) {
          if (sub && typeof sub.index === "number") {
            subtitleTrackReady[sub.index] = sub.ready === true;
            subtitleTrackComplete[sub.index] = sub.complete === true;
          }
        });

        var active = selectedSubtitleIndex;
        if (active !== null && active >= 0 && subtitleTrackReady[active]) {
          if (!subtitleTrackComplete[active]) {
            // Still extracting — pull the latest cues.
            refreshActiveSubtitleTrack();
          } else if (!subtitleTrackFinalized[active]) {
            // Just finished — grab the full file once, then stop refreshing it.
            subtitleTrackFinalized[active] = true;
            refreshActiveSubtitleTrack();
          }
        }

        var total = Array.isArray(cfg.subtitleTracks) ? cfg.subtitleTracks.length : 0;
        var everythingComplete = total > 0 && subs.length >= total
          && subs.every(function (sub) { return sub && sub.complete === true; });
        var activeSettled = active === null || active < 0 || subtitleTrackFinalized[active];
        if (total === 0 || (everythingComplete && activeSettled)) {
          stopSubtitleManifestPolling();
        }
      })
      .catch(function () { /* transient network errors are fine; next tick retries */ });
  }

  function startSubtitleManifestPolling() {
    if (subtitleManifestPollId || !cfg.subtitleManifestUrl) return;
    if (!Array.isArray(cfg.subtitleTracks) || cfg.subtitleTracks.length === 0) return;
    setTimeout(pollSubtitleManifest, 3000);
    subtitleManifestPollId = setInterval(pollSubtitleManifest, 9000);
  }

  function stopSubtitleManifestPolling() {
    if (subtitleManifestPollId) {
      clearInterval(subtitleManifestPollId);
      subtitleManifestPollId = null;
    }
  }

  // Buffer-health watcher: torrent throughput can dip below the bitrate and stall the
  // <video>. If playback is genuinely stuck for a while, reload at the current position
  // as a last resort. hls.js owns its own recovery, so this only applies to direct files.
  function cancelStallRecovery() {
    if (stallRecoveryTimer) {
      clearTimeout(stallRecoveryTimer);
      stallRecoveryTimer = null;
    }
  }

  function scheduleStallRecovery() {
    if (!video || cfg.isHlsSource || stallRecoveryTimer) return;
    stallRecoveryTimer = setTimeout(function () {
      stallRecoveryTimer = null;
      if (!video || video.paused || video.ended) return;
      if (video.readyState >= 3 /* HAVE_FUTURE_DATA */) return; // recovered on its own
      var now = Date.now();
      if (now - lastRecoveryAt < 15000) return; // never thrash the stream
      lastRecoveryAt = now;
      var pos = video.currentTime;
      try {
        var resume = function () {
          video.removeEventListener("loadedmetadata", resume);
          try { video.currentTime = pos; } catch (e) { /* ignore */ }
          video.play().catch(function () { /* ignore autoplay failure */ });
        };
        video.addEventListener("loadedmetadata", resume);
        video.load();
      } catch (e) { /* ignore */ }
    }, 8000);
  }

  function setSubtitleIndex(index) {
    var tracks = getSubtitleTracks();
    var nextIndex = Number.isInteger(index) ? index : -1;

    if (nextIndex < 0 || nextIndex >= tracks.length) {
      nextIndex = -1;
    }

    selectedSubtitleIndex = nextIndex;

    tracks.forEach(function (track, trackIndex) {
      track.mode = trackIndex === selectedSubtitleIndex ? "hidden" : "disabled";
    });

    if (subtitleSelect) {
      subtitleSelect.value = String(selectedSubtitleIndex >= 0 ? selectedSubtitleIndex : -1);
    }

    lastKnownCueCount = -1;

    if (selectedSubtitleIndex >= 0) {
      startSubtitlePolling();
    } else {
      clearSubtitlePolling();
      clearSubtitleOverlay();
      if (isPopupVisible()) {
        setPreviewMessage("Select a subtitle track to inspect timing.");
      }
    }

    renderSubtitleOverlay(true);
    if (isPopupVisible()) renderSubtitlePreview(true);
  }

  function buildActiveCueLines(track, currentTime) {
    if (!track || !track.cues || track.cues.length === 0) return [];

    var lines = [];
    for (var i = 0; i < track.cues.length; i += 1) {
      var cue = track.cues[i];
      var start = cue.startTime + subtitleOffset;
      var end = cue.endTime + subtitleOffset;

      if (currentTime < start && lines.length === 0) {
        break;
      }

      if (currentTime >= start && currentTime <= end) {
        lines.push(String(cue.text || ""));
      }
    }

    return lines;
  }

  function renderSubtitleOverlay(force) {
    if (!video || !subtitleOverlay) return;

    var track = getSelectedTrack();
    var lines = buildActiveCueLines(track, video.currentTime || 0);

    if (lines.length === 0) {
      clearSubtitleOverlay();
      return;
    }

    var html = lines.map(function (line) {
      return '<div class="subtitle-overlay-line">' + formatCueText(line) + "</div>";
    }).join("");

    if (force || html !== lastOverlaySignature) {
      subtitleOverlay.innerHTML = html;
      subtitleOverlay.classList.add("visible");
      lastOverlaySignature = html;
    }
  }

  function renderSubtitlePreview(force) {
    if (!subtitlePreview || !isPopupVisible()) return;

    var track = getSelectedTrack();
    if (!track) {
      setPreviewMessage("Select a subtitle track to inspect timing.");
      return;
    }

    if (!track.cues || track.cues.length === 0) {
      setPreviewMessage("Waiting for subtitle cues to load...");
      return;
    }

    var currentTime = video ? (video.currentTime || 0) : 0;
    var timeWindow = 120;
    var html = "";
    var activeIndex = -1;

    for (var i = 0; i < track.cues.length; i += 1) {
      var cue = track.cues[i];
      var adjustedStart = cue.startTime + subtitleOffset;
      var adjustedEnd = cue.endTime + subtitleOffset;

      if (currentTime >= adjustedStart && currentTime <= adjustedEnd && activeIndex === -1) {
        activeIndex = i;
      }

      if (adjustedStart < currentTime - timeWindow) {
        continue;
      }

      if (adjustedStart > currentTime + timeWindow) {
        break;
      }

      html += '<div class="subtitle-item'
        + (i === activeIndex ? " active" : "")
        + '" data-cue-index="'
        + i
        + '"><div class="time">'
        + escapeHtml(formatTime(adjustedStart) + " -> " + formatTime(adjustedEnd))
        + '</div><div class="text">'
        + formatCueText(cue.text || "")
        + "</div></div>";
    }

    if (!html) {
      html = '<div class="subtitle-empty">No subtitles in the current time window.</div>';
    }

    if (force || html !== lastPreviewSignature) {
      subtitlePreview.innerHTML = html;
      lastPreviewSignature = html;
    }

    if (activeIndex >= 0) {
      var activeItem = subtitlePreview.querySelector('[data-cue-index="' + activeIndex + '"]');
      if (activeItem) {
        activeItem.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  function updateOffsetDisplay() {
    if (offsetValue) {
      var sign = subtitleOffset >= 0 ? "+" : "";
      offsetValue.textContent = sign + subtitleOffset.toFixed(2) + "s";
    }
    renderSubtitleOverlay(true);
    if (isPopupVisible()) renderSubtitlePreview(true);
  }

  function adjustOffset(delta) {
    subtitleOffset = Math.round((subtitleOffset + delta) * 100) / 100;
    updateOffsetDisplay();
  }

  function toggleSubtitlePopup() {
    if (!subtitleAdjustPopup || getSubtitleTracks().length === 0) return;
    subtitleAdjustPopup.hidden = !subtitleAdjustPopup.hidden;
    if (subtitleAdjustPopup.hidden) {
      lastPreviewSignature = "";
    } else {
      renderSubtitlePreview(true);
    }
  }

  function closeSubtitlePopup() {
    if (!subtitleAdjustPopup) return;
    subtitleAdjustPopup.hidden = true;
    lastPreviewSignature = "";
  }

  function attemptCompatFallback() {
    if (fallbackTried || !cfg.compatFallbackUrl || !video) return false;
    fallbackTried = true;
    setStatus("Applying compatibility fallback...");
    video.src = cfg.compatFallbackUrl;
    video.load();
    video.play().catch(function () { /* ignore autoplay failure */ });
    return true;
  }

  if (subtitleSelect) {
    subtitleSelect.addEventListener("change", function () {
      var nextIndex = parseInt(subtitleSelect.value, 10);
      setSubtitleIndex(nextIndex);
      // A freshly-selected track may have loaded empty/partial earlier; allow the
      // poller to refresh it again and resume polling if it had stopped.
      if (Number.isInteger(nextIndex) && nextIndex >= 0) {
        subtitleTrackFinalized[nextIndex] = false;
        startSubtitleManifestPolling();
        pollSubtitleManifest();
      }
    });
  }

  if (subtitleAdjustBtn) {
    subtitleAdjustBtn.addEventListener("click", toggleSubtitlePopup);
  }

  if (closePopupBtn) {
    closePopupBtn.addEventListener("click", closeSubtitlePopup);
  }

  if (subtitlePreview) {
    subtitlePreview.addEventListener("click", function (event) {
      var item = event.target && event.target.closest ? event.target.closest("[data-cue-index]") : null;
      var track = getSelectedTrack();
      if (!item || !track || !track.cues) return;

      var cueIndex = parseInt(item.getAttribute("data-cue-index"), 10);
      if (!Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= track.cues.length) return;

      var cue = track.cues[cueIndex];
      if (!cue || !video) return;
      video.currentTime = Math.max(0, cue.startTime + subtitleOffset);
      renderSubtitleOverlay(true);
      renderSubtitlePreview(true);
    });
  }

  [
    ["subtract1Btn", -1.0],
    ["subtract0_5Btn", -0.5],
    ["add0_5Btn", 0.5],
    ["add1Btn", 1.0],
    ["subtract0_1Btn", -0.1],
    ["add0_1Btn", 0.1],
  ].forEach(function (entry) {
    var button = document.getElementById(entry[0]);
    if (button) {
      button.addEventListener("click", function () {
        adjustOffset(entry[1]);
      });
    }
  });

  var resetBtn = document.getElementById("resetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      subtitleOffset = 0;
      updateOffsetDisplay();
    });
  }

  // HLS attach — Safari plays m3u8 natively; everything else needs hls.js (loaded as CDN <script>).
  if (video && cfg.isHlsSource && cfg.videoUrl) {
    var canNative = typeof video.canPlayType === "function"
      && video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (canNative) {
      try { video.src = cfg.videoUrl; } catch (e) { /* keep <source> fallback */ }
    } else if (typeof window.Hls !== "undefined" && window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
      try {
        var hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
        hls.loadSource(cfg.videoUrl);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, function (_event, data) {
          if (data && data.fatal) {
            showError("HLS error: " + (data.details || data.type || "unknown"));
          }
        });
      } catch (e) {
        showError("HLS playback failed to initialize.");
      }
    } else {
      showError("This browser cannot play HLS streams. Use Safari, Edge, Chrome, or open the VLC link.");
    }
  }

  if (video) {
    video.addEventListener("loadedmetadata", function () {
      setStatus(cfg.transcoding ? "Transcoding stream ready" : "Ready");
      refreshSubtitleSelect();
      setSubtitleIndex(selectedSubtitleIndex === null ? findInitialSubtitleIndex(getSubtitleTracks()) : selectedSubtitleIndex);
      updateOffsetDisplay();
      startSubtitleManifestPolling();
    });

    video.addEventListener("loadeddata", function () {
      syncSelectedTrack();
      renderSubtitleOverlay(true);
      if (isPopupVisible()) renderSubtitlePreview(true);
    });

    video.addEventListener("error", function () {
      var err = video.error;
      var msg = err && err.message ? err.message : "The media could not be loaded.";
      if (!attemptCompatFallback()) {
        showError(msg);
        setStatus("Playback error");
      }
    });

    video.addEventListener("playing", function () {
      hideError();
      setStatus("Playing");
      cancelStallRecovery();
      renderSubtitleOverlay(true);
    });

    video.addEventListener("canplay", function () {
      cancelStallRecovery();
    });

    video.addEventListener("stalled", function () {
      scheduleStallRecovery();
    });

    video.addEventListener("pause", function () {
      renderSubtitleOverlay(true);
    });

    video.addEventListener("seeked", function () {
      renderSubtitleOverlay(true);
      if (isPopupVisible()) renderSubtitlePreview(true);
    });

    video.addEventListener("waiting", function () {
      setStatus("Buffering...");
      scheduleStallRecovery();
    });

    video.addEventListener("timeupdate", function () {
      var now = Date.now();
      if (now - lastOverlayRenderAt >= 120) {
        lastOverlayRenderAt = now;
        renderSubtitleOverlay(false);
      }

      if (isPopupVisible() && now - lastPreviewRenderAt >= 500) {
        lastPreviewRenderAt = now;
        renderSubtitlePreview(false);
      }
    });
  }

  var textTrackList = video ? video.textTracks : null;
  if (textTrackList) {
    var handleTrackListChange = function () {
      var before = selectedSubtitleIndex;
      refreshSubtitleSelect();
      if (before !== null && before >= 0) {
        setSubtitleIndex(before);
      }
    };

    if (typeof textTrackList.addEventListener === "function") {
      textTrackList.addEventListener("addtrack", handleTrackListChange);
    } else {
      textTrackList.onaddtrack = handleTrackListChange;
    }
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", function () {
      hideError();
      if (!video) return;
      video.load();
      video.play().catch(function () { /* ignore autoplay failure */ });
    });
  }

  if (reloadBtn) {
    reloadBtn.addEventListener("click", function () {
      window.location.reload();
    });
  }

  document.addEventListener("keydown", function (event) {
    if (!video) return;
    if (event.target && /input|textarea|select|button/i.test(event.target.tagName)) return;

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (video.paused) video.play().catch(function () {});
      else video.pause();
      return;
    }

    if (event.key === "ArrowRight") {
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
      return;
    }

    if (event.key === "ArrowLeft") {
      video.currentTime = Math.max(0, video.currentTime - 5);
      return;
    }

    if (event.key.toLowerCase() === "m") {
      video.muted = !video.muted;
      return;
    }

    if (event.key.toLowerCase() === "f") {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      } else if (video.requestFullscreen) {
        video.requestFullscreen().catch(function () {});
      }
      return;
    }

    if (event.key === "[") {
      adjustOffset(-0.1);
      return;
    }

    if (event.key === "]") {
      adjustOffset(0.1);
      return;
    }
  });
})();
