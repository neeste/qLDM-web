/*
 * app.js — Browser UI, Web Audio API routing, Coupler Calibration, localStorage
 * persistence, and CSV/JSON export controller for qLDM (Quick Loudness Matching).
 *
 * All stimulus synthesis, buffer-level acoustic/clipping guards, adaptive track
 * stepping, and block maximum-likelihood logistic fitting live in qldm_core.js.
 */
(function () {
  "use strict";

  const QLDM = window.QLDMCore;
  if (!QLDM) {
    throw new Error("QLDMCore failed to load before app.js.");
  }

  const CAL_STORAGE_KEY = "qLDM_calibration_v1";
  const ACTIVE_SESSION_KEY = "qLDM_active_session_v1";
  const COMPLETED_SESSIONS_KEY = "qLDM_completed_sessions_v1";
  const COMPLETED_SESSIONS_MAX = 30;

  /* -------------------------------------------------------------------------
   * DOM Helpers & References
   * ------------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const dom = {
    participantId: $("participant-id"),
    testEar: $("test-ear"),
    matchSet: $("match-set"),
    includePractice: $("include-practice"),
    includeNull: $("include-null"),
    includeReverse: $("include-reverse"),
    stimDuration: $("stim-duration"),
    trialsPerTrack: $("trials-per-track"),
    rampMs: $("ramp-ms"),
    gapMs: $("gap-ms"),
    maxOutput: $("max-output"),
    compFlagDb: $("comp-flag-db"),
    cu5_1k: $("cu5-1k"),
    ucl_1k: $("ucl-1k"),
    cu5_4k: $("cu5-4k"),
    ucl_4k: $("ucl-4k"),
    importQclsBtn: $("import-qcls-btn"),
    qclsElcFile: $("qcls-elc-file"),
    qclsImportStatus: $("qcls-import-status"),
    rngSeed: $("rng-seed"),
    startSessionBtn: $("start-session-btn"),
    savedSessionsSel: $("saved-sessions-sel"),
    loadSavedBtn: $("load-saved-btn"),

    resumeBanner: $("resume-banner"),
    resumeSummary: $("resume-summary"),
    resumeSessionBtn: $("resume-session-btn"),
    discardSessionBtn: $("discard-session-btn"),

    calStatusBanner: $("cal-status-banner"),
    calStatusText: $("cal-status-text"),
    bannerCalBtn: $("banner-cal-btn"),
    openCalBtn: $("open-cal-btn"),

    idleCard: $("idle-card"),
    headroomPreviewWrap: $("headroom-preview-wrap"),
    matchCountLbl: $("match-count-lbl"),
    matchPlanPreview: $("match-plan-preview"),

    trialCard: $("trial-card"),
    phaseBadge: $("phase-badge"),
    progressBadge: $("progress-badge"),
    ceilingBadge: $("ceiling-badge"),
    pracCheckBadge: $("prac-check-badge"),
    trialSubStatus: $("trial-sub-status"),
    choice1Btn: $("choice-1-btn"),
    choice2Btn: $("choice-2-btn"),
    pauseBtn: $("pause-btn"),
    tooLoudBtn: $("too-loud-btn"),

    resultsCard: $("results-card"),
    dlPseBtn: $("dl-pse-btn"),
    dlTbtBtn: $("dl-tbt-btn"),
    dlSesBtn: $("dl-ses-btn"),
    compFlagBanner: $("comp-flag-banner"),
    compFlagText: $("comp-flag-text"),
    compRepeatBtns: $("comp-repeat-btns"),
    resultsSummaryMeta: $("results-summary-meta"),
    resultsTbody: $("results-tbody"),

    instructionModal: $("instruction-modal"),
    instrModalTitle: $("instr-modal-title"),
    instrModalNote: $("instr-modal-note"),
    instrCancelBtn: $("instr-cancel-btn"),
    instrOkBtn: $("instr-ok-btn"),

    practiceCheckModal: $("practice-check-modal"),
    practiceScoreSummary: $("practice-score-summary"),
    repeatPracticeBtn: $("repeat-practice-btn"),
    proceedBlock1Btn: $("proceed-block1-btn"),

    pauseModal: $("pause-modal"),
    pauseReturnBtn: $("pause-return-btn"),
    pauseRestartBtn: $("pause-restart-btn"),
    pauseResumeBtn: $("pause-resume-btn"),

    calModal: $("cal-modal"),
    calPresetSel: $("cal-preset-sel"),
    calTransducerName: $("cal-transducer-name"),
    calDateInput: $("cal-date-input"),
    calToneFreq: $("cal-tone-freq"),
    calToneSpl: $("cal-tone-spl"),
    calToneEar: $("cal-tone-ear"),
    calPlayBtn: $("cal-play-btn"),
    calMeasuredSpl: $("cal-measured-spl"),
    calApplyMeasBtn: $("cal-apply-meas-btn"),
    calToneReadout: $("cal-tone-readout"),
    calTableTbody: $("cal-table-tbody"),
    calCloseBtn: $("cal-close-btn"),
    calSaveBtn: $("cal-save-btn")
  };

  /* -------------------------------------------------------------------------
   * Runtime State
   * ------------------------------------------------------------------------- */
  let audioCtx = null;
  let activeSource = null;
  let activeCalSource = null;
  let isCalPlaying = false;
  let animFrameId = null;
  let itiTimerId = null;
  let awaitingResponse = false;
  let responseEnabledPerfNow = 0;
  let currentPresentation = null; // transient info for currently playing/awaiting trial
  let instrModalCallbacks = { onOk: null, onCancel: null };
  let importedQclsFilename = "";

  let calState = loadCalibrationState();
  let session = null;
  let rng = null;

  /* -------------------------------------------------------------------------
   * Date & Formatting Utilities
   * ------------------------------------------------------------------------- */
  function todayYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }

  function todayIsoDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function sanitizeId(raw) {
    const cleaned = String(raw || "SUBJ001").trim().replace(/[^A-Za-z0-9_-]/g, "_");
    return cleaned || "SUBJ001";
  }

  function parseOptionalNumber(inputEl) {
    const raw = String(inputEl.value || "").trim();
    if (raw === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  function formatSoundLabel(sound, centerHz) {
    if (!sound) return "--";
    if (sound.kind === "tone") return `${centerHz} Hz Tone`;
    if (sound.bwOct === 0.25) return `${centerHz} Hz 5TC (1/4-oct)`;
    return `${centerHz} Hz 5TC (1-oct)`;
  }

  function csvEscape(val) {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* -------------------------------------------------------------------------
   * Web Audio API Initialization & Monaural Routing
   * ------------------------------------------------------------------------- */
  async function ensureAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      try {
        audioCtx = new AudioCtx({ sampleRate: QLDM.DEFAULT_FS });
      } catch (_e) {
        audioCtx = new AudioCtx();
      }
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    return audioCtx;
  }

  async function queryOutputDevicesSafe() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return ["Web Audio Default Output (enumerateDevices unavailable)"];
    }
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outs = devs
        .filter((d) => d.kind === "audiooutput")
        .map((d) => d.label || `Audio Output (${d.deviceId ? d.deviceId.slice(0, 8) : "default"})`);
      return outs.length > 0 ? outs : ["System Default Audio Output"];
    } catch (_e) {
      return ["System Default Audio Output"];
    }
  }

  function stopAllAudio() {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (itiTimerId !== null) {
      clearTimeout(itiTimerId);
      itiTimerId = null;
    }
    if (activeSource) {
      try {
        activeSource.onended = null;
        activeSource.stop();
        activeSource.disconnect();
      } catch (_e) { /* ignore already stopped */ }
      activeSource = null;
    }
    stopCalibrationTone();
    dom.choice1Btn.classList.remove("playing");
    dom.choice2Btn.classList.remove("playing");
  }

  function playMonauralSamples(float32Samples, ear, onEndedCallback) {
    const fs = audioCtx.sampleRate;
    const audioBuf = audioCtx.createBuffer(1, float32Samples.length, fs);
    audioBuf.getChannelData(0).set(float32Samples);

    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;

    /* Strict monaural routing via 2-channel ChannelMergerNode:
     * Left ear -> input 0 (L), input 1 (R) receives 0.0 silence;
     * Right ear -> input 1 (R), input 0 (L) receives 0.0 silence. */
    const merger = audioCtx.createChannelMerger(2);
    const outChannel = ear === "Left" ? 0 : 1;
    src.connect(merger, 0, outChannel);
    merger.connect(audioCtx.destination);

    src.onended = () => {
      try {
        src.disconnect();
        merger.disconnect();
      } catch (_e) { /* ignore */ }
      if (activeSource === src) {
        activeSource = null;
      }
      if (typeof onEndedCallback === "function") {
        onEndedCallback();
      }
    };

    const startAt = audioCtx.currentTime + 0.015;
    activeSource = src;
    src.start(startAt);
    return startAt;
  }

  /* -------------------------------------------------------------------------
   * Coupler Calibration Persistence & UI
   * ------------------------------------------------------------------------- */
  function cloneCalPreset(presetKey) {
    const base = QLDM.TRANSDUCER_PRESETS[presetKey] || QLDM.TRANSDUCER_PRESETS.er3a_nominal;
    return {
      id: base.id,
      name: base.name,
      couplerVerified: Boolean(base.couplerVerified),
      date: base.date || todayIsoDate(),
      offsetsDb: { ...base.offsetsDb }
    };
  }

  function loadCalibrationState() {
    try {
      const raw = localStorage.getItem(CAL_STORAGE_KEY);
      if (!raw) return cloneCalPreset("er3a_nominal");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.offsetsDb !== "object") {
        return cloneCalPreset("er3a_nominal");
      }
      return {
        id: parsed.id || "custom",
        name: parsed.name || "Custom Transducer",
        couplerVerified: Boolean(parsed.couplerVerified),
        date: parsed.date || todayIsoDate(),
        offsetsDb: { ...parsed.offsetsDb }
      };
    } catch (_e) {
      return cloneCalPreset("er3a_nominal");
    }
  }

  function saveCalibrationState(state) {
    calState = {
      id: state.id || "custom",
      name: String(state.name || "Custom Transducer").trim(),
      couplerVerified: Boolean(state.couplerVerified),
      date: state.date || todayIsoDate(),
      offsetsDb: { ...state.offsetsDb }
    };
    try {
      localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(calState));
    } catch (_e) { /* ignore storage quota */ }
    renderCalibrationStatusBanner();
    renderIdlePreview();
  }

  function describeComponentUsage(freqHz) {
    const uses = [];
    const check = (fc, bw, lbl) => {
      const list = bw === 0 ? [fc] : QLDM.getComplexComponentFreqs(fc, bw);
      if (list.some((f) => Math.abs(f - freqHz) < 0.5)) uses.push(lbl);
    };
    check(1000, 0, "1k Tone");
    check(1000, 1.0, "1k 1-oct");
    check(1000, 0.25, "1k 1/4-oct");
    check(4000, 0, "4k Tone");
    check(4000, 1.0, "4k 1-oct");
    check(4000, 0.25, "4k 1/4-oct");
    return uses.join(", ");
  }

  function renderCalibrationStatusBanner() {
    const fsNote = audioCtx && audioCtx.sampleRate !== QLDM.DEFAULT_FS
      ? ` • Audio clock: ${audioCtx.sampleRate} Hz`
      : "";
    if (calState.couplerVerified) {
      dom.calStatusBanner.className = "banner banner-ok";
      dom.calStatusText.innerHTML =
        `<strong>Coupler-Verified Calibration Active:</strong> ${escapeHtml(calState.name)} ` +
        `(calibrated <code>${escapeHtml(calState.date)}</code>)${fsNote}`;
    } else {
      dom.calStatusBanner.className = "banner banner-warn";
      dom.calStatusText.innerHTML =
        `<strong>Unverified Preset Active:</strong> ${escapeHtml(calState.name)}. ` +
        `Measure all 18 component frequencies in an acoustic coupler before human testing.${fsNote}`;
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Working draft while the calibration modal is open */
  let modalCalDraft = null;

  function populateCalToneDropdown() {
    dom.calToneFreq.innerHTML = "";
    const grpPure = document.createElement("optgroup");
    grpPure.label = "Individual Pure-Tone Components (18 Freqs)";
    for (const f of QLDM.CALIBRATION_FREQS) {
      const opt = document.createElement("option");
      opt.value = `tone:${f}`;
      opt.textContent = `${f.toFixed(2)} Hz (${describeComponentUsage(f)})`;
      if (Math.abs(f - 1000) < 0.01) opt.selected = true;
      grpPure.appendChild(opt);
    }
    dom.calToneFreq.appendChild(grpPure);

    const grpComp = document.createElement("optgroup");
    grpComp.label = "Coupler Verification Complexes (5TC Overall RMS Check)";
    const compItems = [
      { val: "comp:1000:1", text: "1000 Hz — 1-Octave 5TC" },
      { val: "comp:4000:1", text: "4000 Hz — 1-Octave 5TC" },
      { val: "comp:1000:0.25", text: "1000 Hz — 1/4-Octave 5TC" },
      { val: "comp:4000:0.25", text: "4000 Hz — 1/4-Octave 5TC" }
    ];
    for (const c of compItems) {
      const opt = document.createElement("option");
      opt.value = c.val;
      opt.textContent = c.text;
      grpComp.appendChild(opt);
    }
    dom.calToneFreq.appendChild(grpComp);
  }

  function renderCalModalTable() {
    if (!modalCalDraft) return;
    dom.calTableTbody.innerHTML = "";
    for (const f of QLDM.CALIBRATION_FREQS) {
      const key = String(f);
      const off = QLDM.lookupCalOffsetDb(modalCalDraft, f);
      const boost = -off;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${f.toFixed(2)}</strong></td>
        <td style="font-size:12px; color:#475569;">${escapeHtml(describeComponentUsage(f))}</td>
        <td>
          <input type="number" step="0.1" min="-35" max="25" data-cal-freq="${key}"
                 value="${off.toFixed(1)}"
                 style="width:95px; padding:4px 6px; border:1px solid #cbd5e1; border-radius:5px; font-size:13px;">
        </td>
        <td data-boost-for="${key}" style="font-family:monospace; color:${boost > 0.05 ? "#b45309" : "#0f172a"};">
          ${boost >= 0 ? "+" : ""}${boost.toFixed(1)} dB
        </td>
      `;
      dom.calTableTbody.appendChild(tr);
    }

    dom.calTableTbody.querySelectorAll("input[data-cal-freq]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const k = inp.getAttribute("data-cal-freq");
        const v = Number(inp.value);
        if (Number.isFinite(v)) {
          modalCalDraft.offsetsDb[k] = Number(v.toFixed(2));
          const boostCell = dom.calTableTbody.querySelector(`[data-boost-for="${k}"]`);
          if (boostCell) {
            const b = -v;
            boostCell.textContent = `${b >= 0 ? "+" : ""}${b.toFixed(1)} dB`;
            boostCell.style.color = b > 0.05 ? "#b45309" : "#0f172a";
          }
          if (isCalPlaying) {
            startCalibrationTone();
          }
        }
      });
    });
  }

  function openCalibrationModal() {
    stopAllAudio();
    modalCalDraft = {
      id: calState.id || "custom",
      name: calState.name || "Etymotic ER-3A",
      couplerVerified: calState.couplerVerified,
      date: (/^\d{4}-\d{2}-\d{2}$/.test(calState.date) ? calState.date : todayIsoDate()),
      offsetsDb: { ...calState.offsetsDb }
    };
    dom.calPresetSel.value = QLDM.TRANSDUCER_PRESETS[modalCalDraft.id] ? modalCalDraft.id : "er3a_nominal";
    dom.calTransducerName.value = modalCalDraft.name;
    dom.calDateInput.value = modalCalDraft.date;
    dom.calToneEar.value = dom.testEar.value;
    dom.calMeasuredSpl.value = "";
    dom.calToneReadout.textContent = "Tone stopped.";
    populateCalToneDropdown();
    renderCalModalTable();
    dom.calModal.classList.add("open");
  }

  function closeCalibrationModal() {
    stopCalibrationTone();
    dom.calModal.classList.remove("open");
    modalCalDraft = null;
  }

  function stopCalibrationTone() {
    if (activeCalSource) {
      try {
        activeCalSource.onended = null;
        activeCalSource.stop();
        activeCalSource.disconnect();
      } catch (_e) { /* ignore */ }
      activeCalSource = null;
    }
    isCalPlaying = false;
    if (dom.calPlayBtn) {
      dom.calPlayBtn.textContent = "Play Continuous Tone";
      dom.calPlayBtn.classList.remove("btn-danger");
      dom.calPlayBtn.classList.add("btn-primary");
    }
  }

  async function startCalibrationTone() {
    stopCalibrationTone();
    await ensureAudioContext();
    const fs = audioCtx.sampleRate;
    const selVal = dom.calToneFreq.value;
    const nomSpl = Number(dom.calToneSpl.value || 80);
    const ear = dom.calToneEar.value;

    let centerHz = 1000;
    let sound = QLDM.SOUND_TONE;
    if (selVal.startsWith("tone:")) {
      centerHz = Number(selVal.split(":")[1]);
      sound = QLDM.SOUND_TONE;
    } else if (selVal.startsWith("comp:")) {
      const parts = selVal.split(":");
      centerHz = Number(parts[1]);
      const bw = Number(parts[2]);
      sound = bw === 0.25 ? QLDM.SOUND_QOCT : QLDM.SOUND_1OCT;
    }

    /* Synthesize a 12-second smooth-ramped buffer (repeatable) through the exact
     * stimulus & safety pipeline so coupler checks test the exact waveform path. */
    const wave = QLDM.generateSoundWaveform({
      centerHz,
      sound,
      levelSpl: nomSpl,
      sampleRate: fs,
      durationMs: 12000,
      rampMs: 20,
      calTable: modalCalDraft || calState,
      ceilingSpl: QLDM.EQUIPMENT_MAX_SPL
    });

    if (!wave.ok) {
      dom.calToneReadout.innerHTML =
        `<span style="color:#b91c1c; font-weight:700;">Refused to play (${escapeHtml(wave.reason)}): ` +
        `digital peak = ${Number.isFinite(wave.peak) ? wave.peak.toFixed(3) : "--"}. Lower nominal SPL or boost.</span>`;
      return;
    }

    const f32 = Float32Array.from(wave.samples);
    const buf = audioCtx.createBuffer(1, f32.length, fs);
    buf.getChannelData(0).set(f32);

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const merger = audioCtx.createChannelMerger(2);
    src.connect(merger, 0, ear === "Left" ? 0 : 1);
    merger.connect(audioCtx.destination);
    src.start();

    activeCalSource = src;
    isCalPlaying = true;
    dom.calPlayBtn.textContent = "Stop Tone";
    dom.calPlayBtn.classList.remove("btn-primary");
    dom.calPlayBtn.classList.add("btn-danger");

    const peakDbFs = 20 * Math.log10(Math.max(wave.peak, 1e-12));
    dom.calToneReadout.innerHTML =
      `Playing <strong>${escapeHtml(formatSoundLabel(sound, centerHz))}</strong> in <strong>${escapeHtml(ear)}</strong> channel ` +
      `at nominal <strong>${nomSpl.toFixed(1)} dB SPL</strong> ` +
      `(digital peak: <code>${peakDbFs.toFixed(1)} dBFS</code>, verified coupler target: <code>${wave.acousticSpl.toFixed(1)} dB SPL</code>).`;
  }

  function applyMeasuredCouplerReading() {
    if (!modalCalDraft) return;
    const selVal = dom.calToneFreq.value;
    if (!selVal.startsWith("tone:")) {
      dom.calToneReadout.innerHTML =
        `<span style="color:#b45309; font-weight:700;">Select one of the 18 individual pure-tone frequencies to update its calibration offset (use 5TC options to verify overall complex SPL).</span>`;
      return;
    }
    const freqHz = Number(selVal.split(":")[1]);
    const nomSpl = Number(dom.calToneSpl.value);
    const measSpl = Number(dom.calMeasuredSpl.value);
    if (!Number.isFinite(nomSpl) || !Number.isFinite(measSpl)) {
      dom.calToneReadout.innerHTML =
        `<span style="color:#b91c1c; font-weight:700;">Enter a valid sound-level meter reading (dB SPL) first.</span>`;
      return;
    }

    /* Since the calibration tone is played WITH curOffset active, any discrepancy
     * (measSpl - nomSpl) updates curOffset -> curOffset + (measSpl - nomSpl) so that
     * re-measuring immediately yields nomSpl (idempotent whether starting from Flat or ER-3A). */
    const curOff = QLDM.lookupCalOffsetDb(modalCalDraft, freqHz);
    const updatedOff = Number((curOff + (measSpl - nomSpl)).toFixed(2));
    const exactKey = QLDM.CALIBRATION_FREQS.find((f) => Math.abs(f - freqHz) < 0.01);
    if (exactKey !== undefined) {
      modalCalDraft.offsetsDb[String(exactKey)] = updatedOff;
    }
    modalCalDraft.id = "custom_coupler";
    renderCalModalTable();
    if (isCalPlaying) {
      startCalibrationTone();
    } else {
      dom.calToneReadout.innerHTML =
        `Updated <strong>${freqHz.toFixed(2)} Hz</strong> offset to <code>${updatedOff.toFixed(1)} dB</code> ` +
        `(digital boost <code>${(-updatedOff >= 0 ? "+" : "") + (-updatedOff).toFixed(1)} dB</code>). Play again to verify meter reads ${nomSpl.toFixed(1)} dB SPL.`;
    }
  }

  /* -------------------------------------------------------------------------
   * Setup Settings, Exclusions, & Pre-Session Preview
   * ------------------------------------------------------------------------- */
  function readSetupSettings() {
    const maxOutRaw = Number(dom.maxOutput.value || 100);
    const maxOutputSpl = Math.max(50, Math.min(QLDM.EQUIPMENT_MAX_SPL, Number.isFinite(maxOutRaw) ? maxOutRaw : 100));
    const trialsRaw = Math.round(Number(dom.trialsPerTrack.value || 8));
    const trialsPerTrack = Math.max(4, Math.min(24, Number.isFinite(trialsRaw) ? trialsRaw : 8));
    const durRaw = Number(dom.stimDuration.value || 500);
    const durationMs = durRaw === 1000 ? 1000 : 500;
    const rampRaw = Number(dom.rampMs.value || 20);
    const rampMs = Math.max(5, Math.min(100, Number.isFinite(rampRaw) ? rampRaw : 20));
    const gapRaw = Number(dom.gapMs.value || 400);
    const gapMs = Math.max(150, Math.min(1000, Number.isFinite(gapRaw) ? gapRaw : 400));
    const compFlagRaw = Number(dom.compFlagDb.value ?? -6.0);
    const compFlagDb = Number.isFinite(compFlagRaw) ? compFlagRaw : -6.0;
    const seedRaw = Number(dom.rngSeed.value || 20261120);

    return {
      participantId: sanitizeId(dom.participantId.value),
      ear: dom.testEar.value === "Left" ? "Left" : "Right",
      earCode: dom.testEar.value === "Left" ? "L" : "R",
      matchSet: dom.matchSet.value || "standard",
      includePractice: Boolean(dom.includePractice.checked),
      includeNullMatches: Boolean(dom.includeNull.checked),
      includeReverseMatches: Boolean(dom.includeReverse.checked),
      durationMs,
      rampMs,
      gapMs,
      itiMs: 300,
      trialsPerTrack,
      initialMaxOutputSpl: maxOutputSpl,
      compFlagDb,
      initialSeed: (Number.isFinite(seedRaw) ? (seedRaw >>> 0) : 20261120) || 20261120,
      limits: {
        cu5_1k: parseOptionalNumber(dom.cu5_1k),
        ucl_1k: parseOptionalNumber(dom.ucl_1k),
        cu5_4k: parseOptionalNumber(dom.cu5_4k),
        ucl_4k: parseOptionalNumber(dom.ucl_4k)
      },
      qclsSourceFile: importedQclsFilename
    };
  }

  function evaluateExclusionReason(matchRow, settings, activeCeilingSpl) {
    const fc = matchRow.centerHz;
    const lvl = matchRow.fixedLevelSpl;
    const cu5 = fc === 1000 ? settings.limits.cu5_1k : settings.limits.cu5_4k;
    const ucl = fc === 1000 ? settings.limits.ucl_1k : settings.limits.ucl_4k;

    if (cu5 !== null && Number.isFinite(cu5) && lvl < cu5 + 10.0 - 1e-9) {
      return `BELOW_CU5_PLUS_10DB (CU5=${cu5.toFixed(1)})`;
    }
    if (ucl !== null && Number.isFinite(ucl) && lvl > ucl + 1e-9) {
      return `ABOVE_LISTENER_TOO_LOUD (UCL=${ucl.toFixed(1)})`;
    }
    if (lvl > activeCeilingSpl + 1e-9) {
      return `ABOVE_MAX_OUTPUT (${activeCeilingSpl.toFixed(1)})`;
    }
    return "";
  }

  function renderIdlePreview() {
    const cfg = readSetupSettings();
    const fs = audioCtx ? audioCtx.sampleRate : QLDM.DEFAULT_FS;
    const headroom = QLDM.computeMaxUnclippedLevels(calState, {
      durationMs: cfg.durationMs,
      rampMs: cfg.rampMs,
      sampleRate: fs
    });

    const needQoct = cfg.matchSet === "extended";
    const visibleHeadroom = headroom.filter((h) => needQoct || h.bwOct !== 0.25);

    let html = `<table class="data-table"><thead><tr>
      <th>Stimulus</th>
      <th>Crest Factor</th>
      <th>Peak @ 60 dB SPL</th>
      <th>Highest Unclipped SPL</th>
      <th>Status vs. Max Output (${cfg.initialMaxOutputSpl} dB)</th>
    </tr></thead><tbody>`;

    for (const h of visibleHeadroom) {
      const crestDb = 20 * Math.log10(h.crestFactor);
      const pkDb = 20 * Math.log10(Math.max(h.peakAt60dB, 1e-12));
      const margin = h.maxUnclippedSpl - cfg.initialMaxOutputSpl;
      const ok = margin >= 0;
      const badge = ok
        ? `<span class="tag tag-ok">OK (+${margin.toFixed(1)} dB margin)</span>`
        : `<span class="tag tag-flag">Clips above ${h.maxUnclippedSpl.toFixed(1)} dB SPL</span>`;
      html += `<tr>
        <td><strong>${escapeHtml(h.label)}</strong></td>
        <td>${h.crestFactor.toFixed(2)} (${crestDb.toFixed(1)} dB)</td>
        <td><code>${pkDb.toFixed(1)} dBFS</code></td>
        <td><strong>${h.maxUnclippedSpl.toFixed(1)} dB SPL</strong></td>
        <td>${badge}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    dom.headroomPreviewWrap.innerHTML = html;

    const rawMatches = QLDM.buildMatchTable({
      matchSet: cfg.matchSet,
      includeNullMatches: cfg.includeNullMatches,
      includeReverseMatches: cfg.includeReverseMatches
    });
    const annotated = rawMatches.map((m) => ({
      ...m,
      excludedReason: evaluateExclusionReason(m, cfg, cfg.initialMaxOutputSpl)
    }));
    const activeCount = annotated.filter((m) => !m.excludedReason).length;
    const excludedCount = annotated.length - activeCount;
    const totalScoredTrials = activeCount * 2 * cfg.trialsPerTrack;
    const pracTrials = cfg.includePractice ? 8 : 0;
    const secPerTrial = (2 * cfg.durationMs + cfg.gapMs + cfg.itiMs) / 1000.0 + 1.25;
    const estMinutes = Math.max(1, Math.round(((totalScoredTrials + pracTrials) * secPerTrial) / 60.0));

    dom.matchCountLbl.textContent = `${activeCount} active` + (excludedCount ? ` (${excludedCount} excluded by limits)` : "");

    const byBlock = [1000, 4000].map((fc) => {
      const bm = annotated.filter((m) => m.centerHz === fc);
      const act = bm.filter((m) => !m.excludedReason);
      const excl = bm.filter((m) => m.excludedReason);
      const lvls = act.map((m) => `${m.fixedLevelSpl}${m.role === "null" ? "N" : m.role === "reverse" ? "R" : ""}`).join(", ");
      const exclTxt = excl.length > 0
        ? ` • Excluded: ${excl.map((e) => `${e.fixedLevelSpl} dB (${e.excludedReason.split(" ")[0]})`).join(", ")}`
        : "";
      return `<div><strong>Block ${fc === 1000 ? 1 : 2} (${fc} Hz):</strong> ${act.length} matches (${act.length * 2} interleaved tracks, ${act.length * 2 * cfg.trialsPerTrack} trials) — Fixed levels: [${lvls || "none"}] dB SPL${escapeHtml(exclTxt)}</div>`;
    });

    dom.matchPlanPreview.innerHTML =
      byBlock.join("") +
      `<div style="margin-top:6px; color:#0f172a;"><strong>Total trials:</strong> ${totalScoredTrials} scored` +
      (pracTrials ? ` + ${pracTrials} practice` : "") +
      ` &bull; <strong>Estimated time:</strong> ~${estMinutes} min</div>`;
  }

  /* -------------------------------------------------------------------------
   * Optional Import of qCLS Equal-Loudness Contour CSV (qCLS_ELC_*.csv)
   * ------------------------------------------------------------------------- */
  function handleQclsCsvText(csvText, filename) {
    const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return;

    let cu5_1k = null, ucl_1k = null, cu5_4k = null, ucl_4k = null;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      if (cols.length < 4) continue;
      const freq = Number(cols[1]);
      const cu = Number(cols[2]);
      const spl = Number(cols[3]);
      if (!Number.isFinite(freq) || !Number.isFinite(cu) || !Number.isFinite(spl)) continue;
      if (Math.abs(freq - 1000) < 1) {
        if (Math.abs(cu - 5) < 0.5) cu5_1k = spl;
        if (Math.abs(cu - 50) < 0.5) ucl_1k = spl;
      } else if (Math.abs(freq - 4000) < 1) {
        if (Math.abs(cu - 5) < 0.5) cu5_4k = spl;
        if (Math.abs(cu - 50) < 0.5) ucl_4k = spl;
      }
    }

    if (cu5_1k === null && cu5_4k === null && ucl_1k === null && ucl_4k === null) {
      dom.qclsImportStatus.style.display = "block";
      dom.qclsImportStatus.style.color = "#b91c1c";
      dom.qclsImportStatus.textContent = `Could not find 1000/4000 Hz CU 5 / CU 50 rows in ${filename}. Expected qCLS_ELC_*.csv.`;
      return;
    }

    if (cu5_1k !== null) dom.cu5_1k.value = cu5_1k.toFixed(1);
    if (ucl_1k !== null) dom.ucl_1k.value = ucl_1k.toFixed(1);
    if (cu5_4k !== null) dom.cu5_4k.value = cu5_4k.toFixed(1);
    if (ucl_4k !== null) dom.ucl_4k.value = ucl_4k.toFixed(1);

    /* Match qCLS filename convention qCLS_ELC_[ID]_[L|R]_[YYYYMMDD].csv if present */
    const m = /^qCLS_ELC_(.+)_([LR])_(\d{8})\.csv$/i.exec(filename);
    if (m) {
      dom.participantId.value = m[1];
      dom.testEar.value = m[2].toUpperCase() === "L" ? "Left" : "Right";
    }

    importedQclsFilename = filename;
    dom.qclsImportStatus.style.display = "block";
    dom.qclsImportStatus.style.color = "#0369a1";
    dom.qclsImportStatus.textContent =
      `Imported limits from ${filename}: 1k [CU5=${cu5_1k !== null ? cu5_1k.toFixed(1) : "--"}, CU50=${ucl_1k !== null ? ucl_1k.toFixed(1) : "--"}], ` +
      `4k [CU5=${cu5_4k !== null ? cu5_4k.toFixed(1) : "--"}, CU50=${ucl_4k !== null ? ucl_4k.toFixed(1) : "--"}] dB SPL.`;
    renderIdlePreview();
  }

  /* -------------------------------------------------------------------------
   * Session Construction, Persistence, & Completed History
   * ------------------------------------------------------------------------- */
  function createBlockState(centerHz, blockPass, matchRows, settings, ceilingSpl) {
    const matches = matchRows.map((m) => {
      const excludedReason = evaluateExclusionReason(m, settings, ceilingSpl);
      return { ...m, blockPass, excludedReason };
    });
    const pairs = matches.map((m) => {
      if (m.excludedReason) {
        return { upper: null, lower: null };
      }
      return {
        upper: QLDM.createTrackState(m, "upper", {
          startOffsetDb: 10.0,
          trialsPerTrack: settings.trialsPerTrack,
          ceilingSpl
        }),
        lower: QLDM.createTrackState(m, "lower", {
          startOffsetDb: 10.0,
          trialsPerTrack: settings.trialsPerTrack,
          ceilingSpl
        })
      };
    });

    return {
      blockPass,
      centerHz,
      matches,
      pairs,
      trialsInBlockCompleted: 0,
      completed: false,
      evalSummary: null
    };
  }

  async function buildNewSessionFromSetup() {
    await ensureAudioContext();
    const outputDevices = await queryOutputDevicesSafe();
    const cfg = readSetupSettings();
    const fs = audioCtx.sampleRate;

    rng = QLDM.createRng(cfg.initialSeed);
    const ceilingSpl = Math.min(cfg.initialMaxOutputSpl, QLDM.EQUIPMENT_MAX_SPL);
    const allMatches = QLDM.buildMatchTable({
      matchSet: cfg.matchSet,
      includeNullMatches: cfg.includeNullMatches,
      includeReverseMatches: cfg.includeReverseMatches
    });

    const blocks = QLDM.CENTER_FREQS_HZ.map((fc) =>
      createBlockState(
        fc,
        1,
        allMatches.filter((m) => m.centerHz === fc),
        cfg,
        ceilingSpl
      )
    );

    const headroom = QLDM.computeMaxUnclippedLevels(calState, {
      durationMs: cfg.durationMs,
      rampMs: cfg.rampMs,
      sampleRate: fs
    });

    session = {
      sessionId: `QLDM_${Date.now()}`,
      appVersion: QLDM.APP_VERSION,
      createdAtIso: new Date().toISOString(),
      dateYmd: todayYmd(),
      participantId: cfg.participantId,
      ear: cfg.ear,
      earCode: cfg.earCode,
      settings: cfg,
      audioInfo: {
        requestedSampleRate: QLDM.DEFAULT_FS,
        grantedSampleRate: fs,
        outputDevices
      },
      calibration: {
        ...calState,
        offsetsDb: { ...calState.offsetsDb },
        maxUnclippedLevels: headroom
      },
      rngState: rng.getState(),
      ceilingSpl,
      tooLoudEvents: [],
      practice: {
        enabled: cfg.includePractice,
        completed: !cfg.includePractice,
        passCount: cfg.includePractice ? 1 : 0,
        trialIndex: 0,
        totalTrials: 8,
        obviousCorrect: 0,
        obviousTotal: 0
      },
      blocks,
      activeBlockArrayIndex: 0,
      phase: cfg.includePractice ? "practice_gate" : "block_gate",
      tbtRows: []
    };

    renderCalibrationStatusBanner();
    persistActiveSession();
    return session;
  }

  function persistActiveSession() {
    if (!session) return;
    if (rng) {
      session.rngState = rng.getState();
    }
    try {
      if (session.phase === "complete") {
        localStorage.removeItem(ACTIVE_SESSION_KEY);
      } else {
        localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
      }
    } catch (_e) { /* ignore storage quota */ }
  }

  function clearActiveSessionStorage() {
    try {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch (_e) { /* ignore */ }
  }

  function loadCompletedSessions() {
    try {
      return JSON.parse(localStorage.getItem(COMPLETED_SESSIONS_KEY)) || [];
    } catch (_e) {
      return [];
    }
  }

  function saveToCompletedSessions(completedSession) {
    const all = loadCompletedSessions().filter((s) => s.sessionId !== completedSession.sessionId);
    all.unshift(completedSession);
    for (let keep = Math.min(all.length, COMPLETED_SESSIONS_MAX); keep >= 1; keep--) {
      try {
        localStorage.setItem(COMPLETED_SESSIONS_KEY, JSON.stringify(all.slice(0, keep)));
        break;
      } catch (_e) {
        if (keep === 1) break;
      }
    }
    refreshSavedSessionsDropdown();
  }

  function refreshSavedSessionsDropdown() {
    const all = loadCompletedSessions();
    dom.savedSessionsSel.innerHTML =
      `<option value="">${all.length} saved</option>` +
      all
        .map((s, idx) => {
          const dt = String(s.createdAtIso || "").slice(0, 16).replace("T", " ");
          return `<option value="${idx}">${escapeHtml(s.participantId)} (${escapeHtml(s.earCode)}) — ${escapeHtml(dt)}</option>`;
        })
        .join("");
  }

  function checkInterruptedSessionBanner() {
    try {
      const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
      if (!raw) {
        dom.resumeBanner.style.display = "none";
        return;
      }
      const saved = JSON.parse(raw);
      if (!saved || saved.phase === "complete") {
        dom.resumeBanner.style.display = "none";
        return;
      }
      const nTrialsDone = Array.isArray(saved.tbtRows) ? saved.tbtRows.length : 0;
      dom.resumeSummary.textContent =
        ` ${saved.participantId} (${saved.ear} Ear, ${saved.settings?.matchSet || "standard"} set, ${nTrialsDone} trial rows saved)`;
      dom.resumeBanner.style.display = "flex";
    } catch (_e) {
      dom.resumeBanner.style.display = "none";
    }
  }

  /* -------------------------------------------------------------------------
   * Instruction Modal & Phase Transitions
   * ------------------------------------------------------------------------- */
  function setSetupControlsDisabled(disabled) {
    const els = dom.idleCard ? document.querySelectorAll("#setup-panel input, #setup-panel select, #setup-panel button") : [];
    els.forEach((el) => {
      el.disabled = disabled;
    });
    dom.openCalBtn.disabled = disabled;
    dom.bannerCalBtn.disabled = disabled;
  }

  function showInstructionModal(title, noteText, onOk, onCancel) {
    dom.instrModalTitle.textContent = title;
    dom.instrModalNote.textContent = noteText;
    instrModalCallbacks = { onOk, onCancel };
    dom.instructionModal.classList.add("open");
  }

  function closeInstructionModal() {
    dom.instructionModal.classList.remove("open");
  }

  function enterSessionFlow() {
    if (!session) return;
    dom.resumeBanner.style.display = "none";

    if (session.phase === "complete") {
      setSetupControlsDisabled(false);
      dom.idleCard.style.display = "none";
      dom.trialCard.style.display = "none";
      renderResultsCard();
      return;
    }

    setSetupControlsDisabled(true);
    dom.idleCard.style.display = "none";
    dom.resultsCard.style.display = "none";
    dom.trialCard.style.display = "flex";
    updateTrialBadges();

    if (session.phase === "practice_gate") {
      showInstructionModal(
        "Practice Trials — Listener Instructions",
        `8 unscored practice trials at a comfortable level (${session.ear} ear) before Block 1 begins. Trials 1–3 have large level differences to confirm task understanding.`,
        () => {
          session.phase = "practice";
          persistActiveSession();
          presentNextTrial();
        },
        () => returnToSetupKeepSaved()
      );
      return;
    }

    if (session.phase === "practice") {
      presentNextTrial();
      return;
    }

    if (session.phase === "practice_check") {
      openPracticeCheckModal();
      return;
    }

    if (session.phase === "block_gate") {
      openCurrentBlockGateModal();
      return;
    }

    if (session.phase === "block") {
      presentNextTrial();
    }
  }

  function openPracticeCheckModal() {
    const p = session.practice;
    dom.practiceScoreSummary.textContent =
      `Obvious-difference check (Trials 1–3, ±10–12 dB): Listener chose the higher-level sound on ${p.obviousCorrect} of ${p.obviousTotal} check trials.`;
    dom.practiceCheckModal.classList.add("open");
  }

  function openCurrentBlockGateModal() {
    /* Advance past any block with zero runnable tracks (e.g., all levels excluded) */
    while (session.activeBlockArrayIndex < session.blocks.length) {
      const blk = session.blocks[session.activeBlockArrayIndex];
      const runnable = countRemainingTrialsInBlock(blk);
      if (runnable > 0) break;
      blk.completed = true;
      blk.evalSummary = QLDM.evaluateBlockMatches(blk.matches, blk.pairs, {
        componentFlagThresholdDb: session.settings.compFlagDb
      });
      session.activeBlockArrayIndex += 1;
    }

    if (session.activeBlockArrayIndex >= session.blocks.length) {
      finishSession();
      return;
    }

    const blk = session.blocks[session.activeBlockArrayIndex];
    const remTrials = countRemainingTrialsInBlock(blk);
    const passLabel = blk.blockPass > 1 ? ` (Repeat Pass #${blk.blockPass})` : "";
    showInstructionModal(
      `Block ${session.activeBlockArrayIndex + 1}: ${blk.centerHz} Hz${passLabel} — Repeat Instruction`,
      `${remTrials} trials in this block (${session.ear} ear). Remind the listener to judge the overall loudness of the whole sound and not a single component pitch.`,
      () => {
        session.phase = "block";
        persistActiveSession();
        presentNextTrial();
      },
      () => openPauseModal()
    );
  }

  /* -------------------------------------------------------------------------
   * Trial Selection, Audio Playback, & Response Handling
   * ------------------------------------------------------------------------- */
  function countTotalTrialsInBlock(blk) {
    let total = 0;
    for (const p of blk.pairs) {
      if (p.upper) total += p.upper.maxTrials;
      if (p.lower) total += p.lower.maxTrials;
    }
    return total;
  }

  function countRemainingTrialsInBlock(blk) {
    let rem = 0;
    for (const p of blk.pairs) {
      if (p.upper && !p.upper.finished) rem += (p.upper.maxTrials - p.upper.trialsCompleted);
      if (p.lower && !p.lower.finished) rem += (p.lower.maxTrials - p.lower.trialsCompleted);
    }
    return rem;
  }

  function updateTrialBadges() {
    if (!session) return;
    dom.ceilingBadge.textContent = `Ceiling: ${session.ceilingSpl.toFixed(0)} dB SPL (${session.ear})`;
    if (session.phase === "practice" || session.phase === "practice_gate" || session.phase === "practice_check") {
      const p = session.practice;
      dom.phaseBadge.textContent = `Practice${p.passCount > 1 ? ` (Pass ${p.passCount})` : ""}`;
      dom.progressBadge.textContent = `Trial ${Math.min(p.trialIndex + 1, p.totalTrials)} / ${p.totalTrials}`;
      dom.pracCheckBadge.textContent = p.obviousTotal > 0 ? `Check: ${p.obviousCorrect}/${p.obviousTotal}` : "";
    } else if (session.activeBlockArrayIndex < session.blocks.length) {
      const blk = session.blocks[session.activeBlockArrayIndex];
      const total = countTotalTrialsInBlock(blk);
      const done = blk.trialsInBlockCompleted;
      const passTag = blk.blockPass > 1 ? ` (Pass ${blk.blockPass})` : "";
      dom.phaseBadge.textContent = `Block ${session.activeBlockArrayIndex + 1}/${session.blocks.length} • ${blk.centerHz} Hz${passTag}`;
      dom.progressBadge.textContent = `Trial ${Math.min(done + 1, Math.max(total, 1))} / ${total}`;
      dom.pracCheckBadge.textContent = "";
    }
  }

  function buildPracticeTrialSpec() {
    /* Comfortable practice complex level: min(65, ceiling - 15), bounded >= 45 dB SPL.
     * Offsets: Trials 1–3 are +/-10..12 dB obvious comprehension checks (Advice Section 7);
     * Trials 4–8 step inward across both sides so listener hears typical match differences. */
    const p = session.practice;
    const fixedSpl = Math.max(45, Math.min(65, session.ceilingSpl - 15));
    const offsets = [+12, -12, +10, -8, +6, -6, +4, -4];
    const rawOffset = offsets[p.trialIndex % offsets.length];
    const variedSpl = Math.max(
      QLDM.MIN_VARIED_SPL,
      Math.min(session.ceilingSpl, fixedSpl + rawOffset)
    );
    const isObviousCheck = p.trialIndex < 3 && Math.abs(variedSpl - fixedSpl) >= 8.0;
    const variedInterval = rng.next() < 0.5 ? 1 : 2;
    session.rngState = rng.getState();

    return {
      isPractice: true,
      isObviousCheck,
      blockPass: p.passCount,
      blockHz: 1000,
      matchId: "PRACTICE_1000Hz_1oct",
      role: "practice",
      trackId: "PRACTICE",
      trackSlot: "practice",
      centerHz: 1000,
      bandwidthOct: 1.0,
      fixedSound: QLDM.SOUND_1OCT,
      variedSound: QLDM.SOUND_TONE,
      fixedLevelSpl: fixedSpl,
      variedLevelSpl: variedSpl,
      variedInterval
    };
  }

  function pickNextBlockTrack(blk) {
    const activeTracks = [];
    for (let i = 0; i < blk.pairs.length; i++) {
      const pair = blk.pairs[i];
      if (pair.upper && !pair.upper.finished) activeTracks.push(pair.upper);
      if (pair.lower && !pair.lower.finished) activeTracks.push(pair.lower);
    }
    if (activeTracks.length === 0) return null;
    const pickIdx = Math.floor(rng.next() * activeTracks.length);
    const track = activeTracks[pickIdx];
    const variedInterval = rng.next() < 0.5 ? 1 : 2;
    session.rngState = rng.getState();

    const bwOct =
      track.fixedSound.kind === "complex"
        ? track.fixedSound.bwOct
        : track.variedSound.kind === "complex"
          ? track.variedSound.bwOct
          : 0.0;

    return {
      isPractice: false,
      trackRef: track,
      blockPass: blk.blockPass,
      blockHz: blk.centerHz,
      matchId: track.matchId,
      role: track.role,
      trackId: track.trackId,
      trackSlot: track.slotLabel,
      centerHz: track.centerHz,
      bandwidthOct: bwOct,
      fixedSound: track.fixedSound,
      variedSound: track.variedSound,
      fixedLevelSpl: track.fixedLevelSpl,
      variedLevelSpl: track.curVariedSpl,
      variedInterval
    };
  }

  async function presentNextTrial() {
    if (!session) return;
    stopAllAudio();
    awaitingResponse = false;
    dom.choice1Btn.disabled = true;
    dom.choice2Btn.disabled = true;

    await ensureAudioContext();
    const fs = audioCtx.sampleRate;
    session.audioInfo.grantedSampleRate = fs;

    let spec = null;
    if (session.phase === "practice") {
      if (session.practice.trialIndex >= session.practice.totalTrials) {
        session.practice.completed = true;
        session.phase = "practice_check";
        persistActiveSession();
        openPracticeCheckModal();
        return;
      }
      spec = buildPracticeTrialSpec();
    } else if (session.phase === "block") {
      const blk = session.blocks[session.activeBlockArrayIndex];
      spec = pickNextBlockTrack(blk);
      if (!spec) {
        blk.completed = true;
        blk.evalSummary = QLDM.evaluateBlockMatches(blk.matches, blk.pairs, {
          componentFlagThresholdDb: session.settings.compFlagDb
        });
        session.activeBlockArrayIndex += 1;
        session.phase = "block_gate";
        persistActiveSession();
        openCurrentBlockGateModal();
        return;
      }
    } else {
      return;
    }

    updateTrialBadges();

    const sound1 = spec.variedInterval === 1 ? spec.variedSound : spec.fixedSound;
    const level1Spl = spec.variedInterval === 1 ? spec.variedLevelSpl : spec.fixedLevelSpl;
    const sound2 = spec.variedInterval === 2 ? spec.variedSound : spec.fixedSound;
    const level2Spl = spec.variedInterval === 2 ? spec.variedLevelSpl : spec.fixedLevelSpl;

    const tb = QLDM.buildTwoIntervalBuffer({
      centerHz: spec.centerHz,
      sound1,
      level1Spl,
      sound2,
      level2Spl,
      sampleRate: fs,
      durationMs: session.settings.durationMs,
      rampMs: session.settings.rampMs,
      gapMs: session.settings.gapMs,
      calTable: session.calibration,
      ceilingSpl: session.ceilingSpl
    });

    /* Pre-playback digital clipping & calibrated ceiling guard (Advice Section 3):
     * Refuse to play any buffer that would clip (> 0 dBFS) or exceed ceiling! */
    if (!tb.ok) {
      if (spec.isPractice) {
        session.practice.trialIndex += 1;
      } else if (spec.trackRef) {
        spec.trackRef.finished = true;
        spec.trackRef.stopReason = tb.reason;
      }
      session.tbtRows.push({
        phase: spec.isPractice ? "practice" : "block",
        blockPass: spec.blockPass,
        blockHz: spec.blockHz,
        matchId: spec.matchId,
        role: spec.role,
        trackId: spec.trackId,
        trackSlot: spec.trackSlot,
        trialInBlock: spec.isPractice ? session.practice.trialIndex : session.blocks[session.activeBlockArrayIndex].trialsInBlockCompleted,
        trialInTrack: spec.isPractice ? session.practice.trialIndex : spec.trackRef.trialsCompleted,
        centerHz: spec.centerHz,
        bandwidthOct: spec.bandwidthOct,
        fixedSound: spec.fixedSound.label,
        variedSound: spec.variedSound.label,
        fixedLevelSpl: spec.fixedLevelSpl,
        variedLevelSpl: spec.variedLevelSpl,
        variedInterval: spec.variedInterval,
        interval1Sound: sound1.label,
        interval1Spl: level1Spl,
        interval2Sound: sound2.label,
        interval2Spl: level2Spl,
        responseInterval: "",
        variedJudgedLouder: "",
        tooLoud: 0,
        rtMs: "",
        ceilingSpl: session.ceilingSpl,
        guardStatus: tb.reason
      });
      persistActiveSession();
      dom.trialSubStatus.textContent = `Buffer refused by safety guard (${tb.reason}); advancing safely...`;
      itiTimerId = setTimeout(() => presentNextTrial(), 350);
      return;
    }

    currentPresentation = {
      ...spec,
      sound1,
      level1Spl,
      sound2,
      level2Spl
    };

    dom.trialSubStatus.textContent = "Listening — First Sound...";
    const startAudioSec = playMonauralSamples(tb.samples, session.ear, () => {
      if (!session || (session.phase !== "practice" && session.phase !== "block")) return;
      dom.choice1Btn.classList.remove("playing");
      dom.choice2Btn.classList.remove("playing");
      dom.choice1Btn.disabled = false;
      dom.choice2Btn.disabled = false;
      dom.trialSubStatus.textContent = "Choose the louder sound (Click button or press 1 or 2)";
      awaitingResponse = true;
      responseEnabledPerfNow = performance.now();
    });

    /* Animate neutral interval border highlight using hardware AudioContext clock
     * (never distinguishes tone from complex). */
    const tick = () => {
      if (!activeSource || !audioCtx) return;
      const elapsed = audioCtx.currentTime - startAudioSec;
      if (elapsed >= 0 && elapsed < tb.interval1EndSec) {
        dom.choice1Btn.classList.add("playing");
        dom.choice2Btn.classList.remove("playing");
        dom.trialSubStatus.textContent = "Listening — First Sound...";
      } else if (elapsed >= tb.interval1EndSec && elapsed < tb.interval2StartSec) {
        dom.choice1Btn.classList.remove("playing");
        dom.choice2Btn.classList.remove("playing");
        dom.trialSubStatus.textContent = "Listen...";
      } else if (elapsed >= tb.interval2StartSec && elapsed <= tb.totalDurationSec + 0.05) {
        dom.choice1Btn.classList.remove("playing");
        dom.choice2Btn.classList.add("playing");
        dom.trialSubStatus.textContent = "Listening — Second Sound...";
      }
      animFrameId = requestAnimationFrame(tick);
    };
    animFrameId = requestAnimationFrame(tick);
  }

  function handleIntervalChoice(chosenInterval) {
    if (!awaitingResponse || !currentPresentation || !session) return;
    awaitingResponse = false;
    dom.choice1Btn.disabled = true;
    dom.choice2Btn.disabled = true;

    const rtMs = Math.max(0, Math.round(performance.now() - responseEnabledPerfNow));
    const p = currentPresentation;
    const variedJudgedLouder = chosenInterval === p.variedInterval;

    let trialInBlockNum = 0;
    let trialInTrackNum = 0;

    if (p.isPractice) {
      session.practice.trialIndex += 1;
      trialInBlockNum = session.practice.trialIndex;
      trialInTrackNum = session.practice.trialIndex;
      if (p.isObviousCheck) {
        const expectedVariedLouder = p.variedLevelSpl > p.fixedLevelSpl;
        session.practice.obviousTotal += 1;
        if (variedJudgedLouder === expectedVariedLouder) {
          session.practice.obviousCorrect += 1;
        }
      }
    } else {
      const blk = session.blocks[session.activeBlockArrayIndex];
      QLDM.stepTrack(p.trackRef, variedJudgedLouder, session.ceilingSpl);
      blk.trialsInBlockCompleted += 1;
      trialInBlockNum = blk.trialsInBlockCompleted;
      trialInTrackNum = p.trackRef.trialsCompleted;
    }

    session.tbtRows.push({
      phase: p.isPractice ? "practice" : "block",
      blockPass: p.blockPass,
      blockHz: p.blockHz,
      matchId: p.matchId,
      role: p.role,
      trackId: p.trackId,
      trackSlot: p.trackSlot,
      trialInBlock: trialInBlockNum,
      trialInTrack: trialInTrackNum,
      centerHz: p.centerHz,
      bandwidthOct: p.bandwidthOct,
      fixedSound: p.fixedSound.label,
      variedSound: p.variedSound.label,
      fixedLevelSpl: p.fixedLevelSpl,
      variedLevelSpl: p.variedLevelSpl,
      variedInterval: p.variedInterval,
      interval1Sound: p.sound1.label,
      interval1Spl: p.level1Spl,
      interval2Sound: p.sound2.label,
      interval2Spl: p.level2Spl,
      responseInterval: chosenInterval,
      variedJudgedLouder: variedJudgedLouder ? 1 : 0,
      tooLoud: 0,
      rtMs,
      ceilingSpl: session.ceilingSpl,
      guardStatus: "OK"
    });

    currentPresentation = null;
    dom.trialSubStatus.textContent = "Recorded.";
    persistActiveSession();

    itiTimerId = setTimeout(() => {
      presentNextTrial();
    }, session.settings.itiMs);
  }

  function handleTooLoudPressed() {
    if (!session || (session.phase !== "practice" && session.phase !== "block")) return;
    stopAllAudio();
    awaitingResponse = false;
    dom.choice1Btn.disabled = true;
    dom.choice2Btn.disabled = true;

    const oldCeiling = session.ceilingSpl;
    const newCeiling = Math.max(QLDM.MIN_VARIED_SPL + 15.0, oldCeiling - 5.0);
    session.ceilingSpl = newCeiling;

    /* Apply new ceiling across ALL blocks in the session (Spec Section 6):
     * lowers ceiling by 5 dB for the rest of the session and ends every track
     * whose fixed complex is above the new ceiling. */
    for (const blk of session.blocks) {
      blk.matches.forEach((m, idx) => {
        const pair = blk.pairs[idx];
        if (!pair || (!pair.upper && !pair.lower)) return;
        const hadTrials =
          (pair.upper ? pair.upper.trialsCompleted : 0) +
          (pair.lower ? pair.lower.trialsCompleted : 0);
        if (m.fixedLevelSpl > newCeiling + 1e-9 && hadTrials === 0 && !m.excludedReason) {
          m.excludedReason = `TOO_LOUD_CEILING (${newCeiling.toFixed(1)})`;
        }
        if (pair.upper) QLDM.applyCeilingChangeToTrack(pair.upper, newCeiling);
        if (pair.lower) QLDM.applyCeilingChangeToTrack(pair.lower, newCeiling);
      });
    }

    const p = currentPresentation;
    session.tooLoudEvents.push({
      timestampIso: new Date().toISOString(),
      phase: session.phase,
      blockPass: p ? p.blockPass : null,
      blockHz: p ? p.blockHz : null,
      matchId: p ? p.matchId : null,
      trackId: p ? p.trackId : null,
      fixedLevelSpl: p ? p.fixedLevelSpl : null,
      variedLevelSpl: p ? p.variedLevelSpl : null,
      oldCeilingSpl: oldCeiling,
      newCeilingSpl: newCeiling
    });

    if (p) {
      session.tbtRows.push({
        phase: p.isPractice ? "practice" : "block",
        blockPass: p.blockPass,
        blockHz: p.blockHz,
        matchId: p.matchId,
        role: p.role,
        trackId: p.trackId,
        trackSlot: p.trackSlot,
        trialInBlock: p.isPractice ? session.practice.trialIndex + 1 : session.blocks[session.activeBlockArrayIndex].trialsInBlockCompleted + 1,
        trialInTrack: p.isPractice ? session.practice.trialIndex + 1 : (p.trackRef ? p.trackRef.trialsCompleted + 1 : 0),
        centerHz: p.centerHz,
        bandwidthOct: p.bandwidthOct,
        fixedSound: p.fixedSound.label,
        variedSound: p.variedSound.label,
        fixedLevelSpl: p.fixedLevelSpl,
        variedLevelSpl: p.variedLevelSpl,
        variedInterval: p.variedInterval,
        interval1Sound: p.sound1.label,
        interval1Spl: p.level1Spl,
        interval2Sound: p.sound2.label,
        interval2Spl: p.level2Spl,
        responseInterval: "TOO_LOUD",
        variedJudgedLouder: "",
        tooLoud: 1,
        rtMs: "",
        ceilingSpl: newCeiling,
        guardStatus: "TOO_LOUD_PRESSED"
      });
      /* If varied sound alone exceeded the new ceiling on a still-active track, clamp it */
      if (!p.isPractice && p.trackRef && !p.trackRef.finished) {
        QLDM.applyCeilingChangeToTrack(p.trackRef, newCeiling);
      }
    }

    currentPresentation = null;
    updateTrialBadges();
    persistActiveSession();
    dom.trialSubStatus.textContent =
      `Ceiling lowered by 5 dB (${oldCeiling.toFixed(0)} → ${newCeiling.toFixed(0)} dB SPL). Continuing safely...`;

    itiTimerId = setTimeout(() => {
      presentNextTrial();
    }, 650);
  }

  /* -------------------------------------------------------------------------
   * Pause, Completion, Component-Listening Repeat, & Results Table
   * ------------------------------------------------------------------------- */
  function openPauseModal() {
    stopAllAudio();
    awaitingResponse = false;
    dom.choice1Btn.disabled = true;
    dom.choice2Btn.disabled = true;
    dom.pauseModal.classList.add("open");
  }

  function closePauseModal() {
    dom.pauseModal.classList.remove("open");
  }

  function returnToSetupKeepSaved() {
    stopAllAudio();
    closeInstructionModal();
    closePauseModal();
    dom.practiceCheckModal.classList.remove("open");
    awaitingResponse = false;
    setSetupControlsDisabled(false);
    dom.trialCard.style.display = "none";
    dom.resultsCard.style.display = "none";
    dom.idleCard.style.display = "block";
    renderIdlePreview();
    checkInterruptedSessionBanner();
  }

  function finishSession() {
    stopAllAudio();
    awaitingResponse = false;
    for (const blk of session.blocks) {
      blk.completed = true;
      blk.evalSummary = QLDM.evaluateBlockMatches(blk.matches, blk.pairs, {
        componentFlagThresholdDb: session.settings.compFlagDb
      });
    }
    session.phase = "complete";
    persistActiveSession();
    saveToCompletedSessions(session);

    setSetupControlsDisabled(false);
    dom.idleCard.style.display = "none";
    dom.trialCard.style.display = "none";
    renderResultsCard();
  }

  function collectAllPseRows(sess) {
    const out = [];
    for (const blk of sess.blocks) {
      const ev = blk.evalSummary || QLDM.evaluateBlockMatches(blk.matches, blk.pairs, {
        componentFlagThresholdDb: sess.settings.compFlagDb
      });
      for (const r of ev.rows) {
        const bwOct =
          r.fixedSound.kind === "complex"
            ? r.fixedSound.bwOct
            : r.variedSound.kind === "complex"
              ? r.variedSound.bwOct
              : 0.0;
        out.push({
          blockPass: blk.blockPass,
          centerHz: r.centerHz,
          bandwidthOct: bwOct,
          role: r.role,
          fixedSound: r.fixedSound,
          variedSound: r.variedSound,
          fixedLevelSpl: r.fixedLevelSpl,
          toneEqualSpl: r.toneEqualSpl,
          variedPseSpl: r.variedPseSpl,
          deltaDb: r.deltaDb,
          seDb: r.seDb,
          sharedSigmaDb: r.sharedSigmaDb,
          nTrials: r.nTrials,
          upperEndSpl: r.upperEndSpl,
          lowerEndSpl: r.lowerEndSpl,
          flags: r.flags || [],
          leftOutReason: r.leftOutReason || ""
        });
      }
    }
    return out;
  }

  function repeatFlaggedBlockWithInstruction(centerHz) {
    if (!session) return;
    /* Find highest pass for this centerHz so far */
    const existingForHz = session.blocks.filter((b) => b.centerHz === centerHz);
    const nextPass = existingForHz.length + 1;
    const allMatches = QLDM.buildMatchTable({
      matchSet: session.settings.matchSet,
      includeNullMatches: session.settings.includeNullMatches,
      includeReverseMatches: session.settings.includeReverseMatches
    }).filter((m) => m.centerHz === centerHz);

    const newBlk = createBlockState(centerHz, nextPass, allMatches, session.settings, session.ceilingSpl);
    session.blocks.push(newBlk);
    session.activeBlockArrayIndex = session.blocks.length - 1;
    session.phase = "block_gate";
    rng = QLDM.createRng(session.rngState || session.settings.initialSeed);
    persistActiveSession();
    enterSessionFlow();
  }

  function renderResultsCard() {
    if (!session) return;
    dom.resultsCard.style.display = "block";
    const rows = collectAllPseRows(session);

    const nScoredTrials = session.tbtRows.filter((t) => t.phase === "block" && t.tooLoud === 0 && t.guardStatus === "OK").length;
    dom.resultsSummaryMeta.innerHTML =
      `<strong>Participant:</strong> ${escapeHtml(session.participantId)} &bull; ` +
      `<strong>Ear:</strong> ${escapeHtml(session.ear)} &bull; ` +
      `<strong>Date:</strong> ${escapeHtml(session.dateYmd)} &bull; ` +
      `<strong>Scored Trials:</strong> ${nScoredTrials} &bull; ` +
      `<strong>Final Ceiling:</strong> ${session.ceilingSpl.toFixed(1)} dB SPL &bull; ` +
      `<strong>Sample Rate:</strong> ${session.audioInfo?.grantedSampleRate || QLDM.DEFAULT_FS} Hz`;

    /* Check latest pass of each frequency for COMPONENT_MATCH_SUSPECTED */
    const latestFlaggedHz = [];
    for (const fc of QLDM.CENTER_FREQS_HZ) {
      const blks = session.blocks.filter((b) => b.centerHz === fc);
      if (blks.length > 0) {
        const latest = blks[blks.length - 1];
        const ev = latest.evalSummary || QLDM.evaluateBlockMatches(latest.matches, latest.pairs, {
          componentFlagThresholdDb: session.settings.compFlagDb
        });
        if (ev.componentMatchFlag) {
          latestFlaggedHz.push({ fc, pass: latest.blockPass });
        }
      }
    }

    if (latestFlaggedHz.length > 0) {
      dom.compFlagBanner.style.display = "flex";
      const hzList = latestFlaggedHz.map((x) => `${x.fc} Hz (Pass ${x.pass})`).join(" and ");
      dom.compFlagText.innerHTML =
        `<strong>Component-Listening Flag (${escapeHtml(hzList)}):</strong> Every completed forward match in the block had ` +
        `&Delta; &le; ${session.settings.compFlagDb.toFixed(1)} dB (matching a single component of 5 tones shifts &Delta; by &minus;7 dB). ` +
        `Re-instruct the listener to judge the <strong>whole sound</strong> and repeat the flagged block.`;
      dom.compRepeatBtns.innerHTML = "";
      for (const item of latestFlaggedHz) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-danger";
        btn.textContent = `Repeat ${item.fc} Hz Block with Instruction`;
        btn.addEventListener("click", () => repeatFlaggedBlockWithInstruction(item.fc));
        dom.compRepeatBtns.appendChild(btn);
      }
    } else {
      dom.compFlagBanner.style.display = "none";
    }

    dom.resultsTbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      const passBadge = r.blockPass > 1 ? ` (P${r.blockPass})` : "";
      const roleClass = r.role === "null" ? "tag-warn" : r.role === "reverse" ? "tag-excl" : "tag-ok";
      const endsTxt =
        Number.isFinite(r.upperEndSpl) && Number.isFinite(r.lowerEndSpl)
          ? `${r.upperEndSpl.toFixed(1)} / ${r.lowerEndSpl.toFixed(1)}`
          : "--";

      let flagHtml = "";
      if (r.leftOutReason) {
        flagHtml = `<span class="tag tag-excl">${escapeHtml(r.leftOutReason)}</span>`;
      } else if (r.flags.length === 0) {
        flagHtml = `<span class="tag tag-ok">OK</span>`;
      } else {
        flagHtml = r.flags
          .map((f) => `<span class="tag ${f === "COMPONENT_MATCH_SUSPECTED" ? "tag-flag" : "tag-warn"}">${escapeHtml(f)}</span>`)
          .join(" ");
      }

      tr.innerHTML = `
        <td><strong>${r.centerHz}${escapeHtml(passBadge)}</strong></td>
        <td><span class="tag ${roleClass}">${escapeHtml(r.role)}</span></td>
        <td>${escapeHtml(formatSoundLabel(r.fixedSound, r.centerHz))}</td>
        <td>${escapeHtml(formatSoundLabel(r.variedSound, r.centerHz))}</td>
        <td><strong>${r.fixedLevelSpl.toFixed(1)}</strong></td>
        <td>${r.toneEqualSpl !== null ? r.toneEqualSpl.toFixed(2) : "--"}</td>
        <td><strong>${r.deltaDb !== null ? (r.deltaDb >= 0 ? "+" : "") + r.deltaDb.toFixed(2) : "--"}</strong></td>
        <td>${r.seDb !== null ? r.seDb.toFixed(2) : "--"}</td>
        <td>${r.sharedSigmaDb !== null && Number.isFinite(r.sharedSigmaDb) ? r.sharedSigmaDb.toFixed(2) : "--"}</td>
        <td>${r.nTrials}</td>
        <td>${endsTxt}</td>
        <td>${flagHtml}</td>
      `;
      dom.resultsTbody.appendChild(tr);
    }
  }

  /* -------------------------------------------------------------------------
   * File Exports (Spec Section 7): LM_PSE_*.csv, LM_TBT_*.csv, LM_SES_*.json
   * ------------------------------------------------------------------------- */
  function buildPseCsv(sess) {
    const header = [
      "participant_id",
      "ear",
      "date",
      "block_pass",
      "center_hz",
      "bandwidth_oct",
      "role",
      "fixed_sound",
      "varied_sound",
      "fixed_level_spl",
      "tone_equal_spl",
      "varied_pse_spl",
      "delta_db",
      "se_db",
      "shared_sigma_db",
      "n_trials",
      "upper_end_spl",
      "lower_end_spl",
      "flags",
      "left_out_reason"
    ];
    const lines = [header.join(",")];
    const rows = collectAllPseRows(sess);
    for (const r of rows) {
      const vals = [
        sess.participantId,
        sess.earCode,
        sess.dateYmd,
        r.blockPass,
        r.centerHz,
        r.bandwidthOct,
        r.role,
        r.fixedSound.label,
        r.variedSound.label,
        r.fixedLevelSpl.toFixed(1),
        r.toneEqualSpl !== null ? r.toneEqualSpl.toFixed(3) : "",
        r.variedPseSpl !== null ? r.variedPseSpl.toFixed(3) : "",
        r.deltaDb !== null ? r.deltaDb.toFixed(3) : "",
        r.seDb !== null ? r.seDb.toFixed(3) : "",
        r.sharedSigmaDb !== null && Number.isFinite(r.sharedSigmaDb) ? r.sharedSigmaDb.toFixed(3) : "",
        r.nTrials,
        Number.isFinite(r.upperEndSpl) ? r.upperEndSpl.toFixed(3) : "",
        Number.isFinite(r.lowerEndSpl) ? r.lowerEndSpl.toFixed(3) : "",
        r.flags.join(";"),
        r.leftOutReason
      ];
      lines.push(vals.map(csvEscape).join(","));
    }
    return lines.join("\n") + "\n";
  }

  function buildTbtCsv(sess) {
    const header = [
      "participant_id",
      "ear",
      "date",
      "phase",
      "block_pass",
      "block_hz",
      "match_id",
      "role",
      "track_id",
      "track_slot",
      "trial_in_block",
      "trial_in_track",
      "center_hz",
      "bandwidth_oct",
      "fixed_sound",
      "varied_sound",
      "fixed_level_spl",
      "varied_level_spl",
      "varied_interval",
      "interval_1_sound",
      "interval_1_spl",
      "interval_2_sound",
      "interval_2_spl",
      "response_interval",
      "varied_judged_louder",
      "too_loud",
      "rt_ms",
      "ceiling_spl",
      "guard_status"
    ];
    const lines = [header.join(",")];
    for (const t of sess.tbtRows) {
      const vals = [
        sess.participantId,
        sess.earCode,
        sess.dateYmd,
        t.phase,
        t.blockPass,
        t.blockHz,
        t.matchId,
        t.role,
        t.trackId,
        t.trackSlot,
        t.trialInBlock,
        t.trialInTrack,
        t.centerHz,
        t.bandwidthOct,
        t.fixedSound,
        t.variedSound,
        Number(t.fixedLevelSpl).toFixed(2),
        Number(t.variedLevelSpl).toFixed(2),
        t.variedInterval,
        t.interval1Sound,
        Number(t.interval1Spl).toFixed(2),
        t.interval2Sound,
        Number(t.interval2Spl).toFixed(2),
        t.responseInterval,
        t.variedJudgedLouder,
        t.tooLoud,
        t.rtMs,
        Number(t.ceilingSpl).toFixed(1),
        t.guardStatus || "OK"
      ];
      lines.push(vals.map(csvEscape).join(","));
    }
    return lines.join("\n") + "\n";
  }

  function buildSesJson(sess) {
    const pseRows = collectAllPseRows(sess).map((r) => ({
      block_pass: r.blockPass,
      center_hz: r.centerHz,
      bandwidth_oct: r.bandwidthOct,
      role: r.role,
      fixed_sound: r.fixedSound.label,
      varied_sound: r.variedSound.label,
      fixed_level_spl: r.fixedLevelSpl,
      tone_equal_spl: r.toneEqualSpl,
      varied_pse_spl: r.variedPseSpl,
      delta_db: r.deltaDb,
      se_db: r.seDb,
      shared_sigma_db: r.sharedSigmaDb,
      n_trials: r.nTrials,
      upper_end_spl: r.upperEndSpl,
      lower_end_spl: r.lowerEndSpl,
      flags: r.flags,
      left_out_reason: r.leftOutReason
    }));

    const payload = {
      app_name: "qLDM",
      app_version: sess.appVersion,
      exported_at_iso: new Date().toISOString(),
      session_created_at_iso: sess.createdAtIso,
      participant_id: sess.participantId,
      ear: sess.ear,
      ear_code: sess.earCode,
      date_ymd: sess.dateYmd,
      settings: sess.settings,
      audio_path: {
        requested_sample_rate_hz: sess.audioInfo?.requestedSampleRate || QLDM.DEFAULT_FS,
        granted_sample_rate_hz: sess.audioInfo?.grantedSampleRate || QLDM.DEFAULT_FS,
        monaural_channel_routing: sess.ear === "Left" ? "Channel 0 (Left) active; Channel 1 silent" : "Channel 1 (Right) active; Channel 0 silent",
        recommended_os_output_format: "24-bit integer or 32-bit float at 48000 Hz, OS enhancements disabled",
        output_devices_detected: sess.audioInfo?.outputDevices || []
      },
      stimulus_definition: {
        reference_spl_db: QLDM.REF_SPL_DB,
        reference_digital_rms_at_60db_spl: QLDM.REF_DIGITAL_RMS_60DB,
        reference_dbfs_rms_at_60db_spl: -70.0,
        component_spacing: "5 equal-amplitude geometric components f_c * 2^(m * bw_oct / 4), m in [-2, -1, 0, 1, 2], matching nea_gen_5tc.m",
        component_start_phases_rad: [0, 0, 0, 0, 0],
        component_start_phase_convention: "sine phase (0 rad at t = 0 onset)",
        complexes_hz: {
          "1000Hz_1oct": QLDM.getComplexComponentFreqs(1000, 1.0),
          "4000Hz_1oct": QLDM.getComplexComponentFreqs(4000, 1.0),
          "1000Hz_0.25oct": QLDM.getComplexComponentFreqs(1000, 0.25),
          "4000Hz_0.25oct": QLDM.getComplexComponentFreqs(4000, 0.25)
        },
        duration_ms: sess.settings.durationMs,
        raised_cosine_ramp_ms: sess.settings.rampMs,
        inter_interval_gap_ms: sess.settings.gapMs,
        post_response_iti_ms: sess.settings.itiMs
      },
      adaptive_and_estimator: {
        rule: "1-up, 1-down two-track interleaved staircase (+10 dB upper, -10 dB lower; 4 dB step until first reversal, 2 dB thereafter)",
        trials_per_track: sess.settings.trialsPerTrack,
        varied_offset_bounds_db: [-QLDM.VARIED_OFFSET_LIM_DB, QLDM.VARIED_OFFSET_LIM_DB],
        estimator: "Block maximum-likelihood logistic fit with shared slope sigma per frequency block and fixed lapse = 0.02",
        se_note: "Curvature-based SE underestimates true match SD by ~25% at 16 trials/match; NEA inversion uses empirical pilot test-retest SD."
      },
      calibration: sess.calibration,
      level_limits: {
        initial_max_output_spl: sess.settings.initialMaxOutputSpl,
        final_ceiling_spl: sess.ceilingSpl,
        equipment_max_spl: QLDM.EQUIPMENT_MAX_SPL,
        listener_limits: sess.settings.limits,
        qcls_contour_file: sess.settings.qclsSourceFile || null,
        too_loud_events: sess.tooLoudEvents
      },
      practice_summary: sess.practice,
      pse_summary: pseRows
    };

    return JSON.stringify(payload, null, 2) + "\n";
  }

  function exportFilename(prefix, ext) {
    if (!session) return `${prefix}_UNKNOWN.${ext}`;
    return `${prefix}_${session.participantId}_${session.earCode}_${session.dateYmd}.${ext}`;
  }

  /* -------------------------------------------------------------------------
   * Event Listeners & Startup Initialization
   * ------------------------------------------------------------------------- */
  function bindEvents() {
    const previewInputs = [
      dom.matchSet,
      dom.includePractice,
      dom.includeNull,
      dom.includeReverse,
      dom.stimDuration,
      dom.trialsPerTrack,
      dom.rampMs,
      dom.gapMs,
      dom.maxOutput,
      dom.compFlagDb,
      dom.cu5_1k,
      dom.ucl_1k,
      dom.cu5_4k,
      dom.ucl_4k
    ];
    previewInputs.forEach((el) => {
      el.addEventListener("input", renderIdlePreview);
      el.addEventListener("change", renderIdlePreview);
    });

    /* qCLS ELC CSV Import */
    dom.importQclsBtn.addEventListener("click", () => dom.qclsElcFile.click());
    dom.qclsElcFile.addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => handleQclsCsvText(String(reader.result || ""), file.name);
      reader.readAsText(file);
      ev.target.value = "";
    });

    /* Start / Resume / Discard / Load Completed */
    dom.startSessionBtn.addEventListener("click", async () => {
      await buildNewSessionFromSetup();
      enterSessionFlow();
    });

    dom.resumeSessionBtn.addEventListener("click", async () => {
      try {
        const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
        if (!raw) return;
        session = JSON.parse(raw);
        rng = QLDM.createRng(session.rngState || session.settings?.initialSeed || 20261120);
        await ensureAudioContext();
        enterSessionFlow();
      } catch (_e) {
        clearActiveSessionStorage();
        checkInterruptedSessionBanner();
      }
    });

    dom.discardSessionBtn.addEventListener("click", () => {
      clearActiveSessionStorage();
      checkInterruptedSessionBanner();
    });

    dom.loadSavedBtn.addEventListener("click", () => {
      const idxStr = dom.savedSessionsSel.value;
      if (idxStr === "") return;
      const all = loadCompletedSessions();
      const picked = all[Number(idxStr)];
      if (!picked) return;
      stopAllAudio();
      session = picked;
      dom.participantId.value = session.participantId;
      dom.testEar.value = session.ear;
      enterSessionFlow();
    });

    /* Instruction Modal */
    dom.instrOkBtn.addEventListener("click", () => {
      closeInstructionModal();
      if (typeof instrModalCallbacks.onOk === "function") instrModalCallbacks.onOk();
    });
    dom.instrCancelBtn.addEventListener("click", () => {
      closeInstructionModal();
      if (typeof instrModalCallbacks.onCancel === "function") instrModalCallbacks.onCancel();
    });

    /* Post-Practice Tester Check Modal */
    dom.repeatPracticeBtn.addEventListener("click", () => {
      dom.practiceCheckModal.classList.remove("open");
      if (!session) return;
      session.practice.passCount += 1;
      session.practice.trialIndex = 0;
      session.practice.completed = false;
      session.practice.obviousCorrect = 0;
      session.practice.obviousTotal = 0;
      session.phase = "practice_gate";
      persistActiveSession();
      enterSessionFlow();
    });

    dom.proceedBlock1Btn.addEventListener("click", () => {
      dom.practiceCheckModal.classList.remove("open");
      if (!session) return;
      session.phase = "block_gate";
      persistActiveSession();
      openCurrentBlockGateModal();
    });

    /* Trial Arena Controls + Keyboard Shortcuts (1 and 2) */
    dom.choice1Btn.addEventListener("click", () => handleIntervalChoice(1));
    dom.choice2Btn.addEventListener("click", () => handleIntervalChoice(2));
    dom.tooLoudBtn.addEventListener("click", handleTooLoudPressed);
    dom.pauseBtn.addEventListener("click", openPauseModal);

    window.addEventListener("keydown", (ev) => {
      if (!awaitingResponse) return;
      if (
        dom.instructionModal.classList.contains("open") ||
        dom.practiceCheckModal.classList.contains("open") ||
        dom.pauseModal.classList.contains("open") ||
        dom.calModal.classList.contains("open")
      ) {
        return;
      }
      if (ev.key === "1" || ev.code === "Digit1" || ev.code === "Numpad1") {
        ev.preventDefault();
        handleIntervalChoice(1);
      } else if (ev.key === "2" || ev.code === "Digit2" || ev.code === "Numpad2") {
        ev.preventDefault();
        handleIntervalChoice(2);
      }
    });

    /* Pause Modal */
    dom.pauseResumeBtn.addEventListener("click", () => {
      closePauseModal();
      if (session && (session.phase === "practice" || session.phase === "block")) {
        presentNextTrial();
      } else if (session) {
        enterSessionFlow();
      }
    });

    dom.pauseRestartBtn.addEventListener("click", async () => {
      closePauseModal();
      await buildNewSessionFromSetup();
      enterSessionFlow();
    });

    dom.pauseReturnBtn.addEventListener("click", () => {
      returnToSetupKeepSaved();
    });

    /* Export Downloads */
    dom.dlPseBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(buildPseCsv(session), exportFilename("LM_PSE", "csv"), "text/csv;charset=utf-8");
    });
    dom.dlTbtBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(buildTbtCsv(session), exportFilename("LM_TBT", "csv"), "text/csv;charset=utf-8");
    });
    dom.dlSesBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(buildSesJson(session), exportFilename("LM_SES", "json"), "application/json;charset=utf-8");
    });

    /* Coupler Calibration Modal */
    dom.openCalBtn.addEventListener("click", openCalibrationModal);
    dom.bannerCalBtn.addEventListener("click", openCalibrationModal);
    dom.calCloseBtn.addEventListener("click", closeCalibrationModal);

    dom.calPresetSel.addEventListener("change", () => {
      if (!modalCalDraft) return;
      const preset = cloneCalPreset(dom.calPresetSel.value);
      modalCalDraft.id = preset.id;
      modalCalDraft.name = preset.name;
      modalCalDraft.couplerVerified = false;
      modalCalDraft.offsetsDb = { ...preset.offsetsDb };
      dom.calTransducerName.value = modalCalDraft.name;
      renderCalModalTable();
      if (isCalPlaying) startCalibrationTone();
    });

    dom.calToneFreq.addEventListener("change", () => {
      dom.calMeasuredSpl.value = "";
      if (isCalPlaying) startCalibrationTone();
    });
    dom.calToneSpl.addEventListener("change", () => {
      if (isCalPlaying) startCalibrationTone();
    });
    dom.calToneEar.addEventListener("change", () => {
      if (isCalPlaying) startCalibrationTone();
    });

    dom.calPlayBtn.addEventListener("click", () => {
      if (isCalPlaying) {
        stopCalibrationTone();
        dom.calToneReadout.textContent = "Tone stopped.";
      } else {
        startCalibrationTone();
      }
    });

    dom.calApplyMeasBtn.addEventListener("click", applyMeasuredCouplerReading);

    dom.calSaveBtn.addEventListener("click", () => {
      if (!modalCalDraft) return;
      modalCalDraft.name = dom.calTransducerName.value.trim() || "Custom Transducer";
      modalCalDraft.date = dom.calDateInput.value || todayIsoDate();
      modalCalDraft.couplerVerified = true;
      saveCalibrationState(modalCalDraft);
      closeCalibrationModal();
    });
  }

  function init() {
    bindEvents();
    renderCalibrationStatusBanner();
    renderIdlePreview();
    refreshSavedSessionsDropdown();
    checkInterruptedSessionBanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
