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
      setSubtitleIndex(parseInt(subtitleSelect.value, 10));
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

  if (video) {
    video.addEventListener("loadedmetadata", function () {
      setStatus(cfg.transcoding ? "Transcoding stream ready" : "Ready");
      refreshSubtitleSelect();
      setSubtitleIndex(selectedSubtitleIndex === null ? findInitialSubtitleIndex(getSubtitleTracks()) : selectedSubtitleIndex);
      updateOffsetDisplay();
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
      renderSubtitleOverlay(true);
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
