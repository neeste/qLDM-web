/*
 * app.js — Browser UI, Web Audio API routing, Coupler Calibration, localStorage
 * persistence, and CSV/JSON export controller for qLDM (Quick Loudness Matching).
 *
 * All stimulus synthesis, buffer-level acoustic/clipping guards, adaptive track
 * stepping, block maximum-likelihood logistic fitting, and CSV/JSON formatters
 * live in qldm_core.js.
 */
(function () {
  "use strict";

  const QLDM = window.QLDMCore;
  if (!QLDM) {
    throw new Error("QLDMCore failed to load before app.js.");
  }

  const CAL_STORAGE_KEY = "qLDM_calibration_v2";
  const LEGACY_CAL_STORAGE_KEY = "qLDM_calibration_v1";
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
    newSeedBtn: $("new-seed-btn"),
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
    idleRefSummary: $("idle-ref-summary"),
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
    dlAllBtn: $("dl-all-btn"),
    dlPseBtn: $("dl-pse-btn"),
    dlTbtBtn: $("dl-tbt-btn"),
    dlSesBtn: $("dl-ses-btn"),
    compFlagBanner: $("comp-flag-banner"),
    compFlagText: $("comp-flag-text"),
    compRepeatBtns: $("comp-repeat-btns"),
    resultsSummaryMeta: $("results-summary-meta"),
    resultsPlotWrap: $("results-plot-wrap"),
    resultsTbody: $("results-tbody"),

    gainConfirmModal: $("gain-confirm-modal"),
    gainConfirmDetails: $("gain-confirm-details"),
    gainConfirmChk: $("gain-confirm-chk"),
    gainConfirmCancelBtn: $("gain-confirm-cancel-btn"),
    gainConfirmOkBtn: $("gain-confirm-ok-btn"),

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
    calRefDbfs: $("cal-ref-dbfs"),
    calTransducerName: $("cal-transducer-name"),
    calDateInput: $("cal-date-input"),
    calFullscaleReadout: $("cal-fullscale-readout"),
    calPerEarChk: $("cal-per-ear-chk"),
    calCopyEarBtn: $("cal-copy-ear-btn"),
    calExportJsonBtn: $("cal-export-json-btn"),
    calImportJsonBtn: $("cal-import-json-btn"),
    calImportFile: $("cal-import-file"),
    calEarColLbl: $("cal-ear-col-lbl"),
    calToneFreq: $("cal-tone-freq"),
    calToneSpl: $("cal-tone-spl"),
    calLvl30Btn: $("cal-lvl-30-btn"),
    calLvl80Btn: $("cal-lvl-80-btn"),
    calToneEar: $("cal-tone-ear"),
    calPlayBtn: $("cal-play-btn"),
    calMeasuredSpl: $("cal-measured-spl"),
    calApplyMeasBtn: $("cal-apply-meas-btn"),
    calToneReadout: $("cal-tone-readout"),
    calTableTbody: $("cal-table-tbody"),
    calSaveErr: $("cal-save-err"),
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
  let currentPresentation = null;
  let instrModalCallbacks = { onOk: null, onCancel: null };
  let gainModalCallback = null;
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

  function todayHm() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}${mm}`;
  }

  function randomizeSeedInput() {
    if (dom.rngSeed) {
      dom.rngSeed.value = String(QLDM.generateRandomSeed());
    }
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

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
  function cloneCalPreset(presetKey, refDbfsOverride) {
    const base = QLDM.TRANSDUCER_PRESETS[presetKey] || QLDM.TRANSDUCER_PRESETS.er3a_nominal;
    return {
      id: base.id,
      name: base.name,
      couplerVerified: Boolean(base.couplerVerified),
      date: base.date || todayIsoDate(),
      refDbfsRms60: QLDM.clampRefDbfs60(refDbfsOverride ?? base.refDbfsRms60 ?? QLDM.DEFAULT_REF_DBFS_60DB),
      offsetsDb: { ...base.offsetsDb }
    };
  }

  function loadCalibrationState() {
    try {
      const raw = localStorage.getItem(CAL_STORAGE_KEY) || localStorage.getItem(LEGACY_CAL_STORAGE_KEY);
      if (!raw) return cloneCalPreset("er3a_nominal");
      const parsed = JSON.parse(raw);
      const norm = QLDM.normalizeCalibrationRecord(parsed);
      if (!norm) return cloneCalPreset("er3a_nominal");
      return {
        ...norm,
        date: parsed.date || todayIsoDate()
      };
    } catch (_e) {
      return cloneCalPreset("er3a_nominal");
    }
  }

  function saveCalibrationState(state) {
    const perEarEnabled = Boolean(state.perEarEnabled);
    const baseOffsets = { ...state.offsetsDb };
    const offsetsByEar = state.offsetsByEar && typeof state.offsetsByEar === "object"
      ? {
          Left: { ...(state.offsetsByEar.Left || baseOffsets) },
          Right: { ...(state.offsetsByEar.Right || baseOffsets) }
        }
      : (perEarEnabled ? { Left: { ...baseOffsets }, Right: { ...baseOffsets } } : undefined);

    calState = {
      id: state.id || "custom",
      name: String(state.name || "Custom Transducer").trim(),
      couplerVerified: Boolean(state.couplerVerified),
      date: state.date || todayIsoDate(),
      refDbfsRms60: QLDM.clampRefDbfs60(state.refDbfsRms60),
      perEarEnabled,
      ...(offsetsByEar ? { offsetsByEar } : {}),
      offsetsDb: perEarEnabled && offsetsByEar ? { ...offsetsByEar.Right } : baseOffsets
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
    const activeEar = dom.testEar.value === "Left" ? "Left" : "Right";
    const fsInfo = QLDM.computeFullScale1kSpl(calState, null, activeEar);
    const fsNote = audioCtx && audioCtx.sampleRate !== QLDM.DEFAULT_FS
      ? ` &bull; Audio clock: ${audioCtx.sampleRate} Hz`
      : "";
    const earModeTag = calState.perEarEnabled ? ` [${activeEar} table]` : "";
    const refNote = ` &bull; Ref: <code>${fsInfo.refDbfsRms60.toFixed(1)} dBFS</code> = 60 dB SPL (1 kHz 0 dBFS = <code>${fsInfo.fullScale1kSpl.toFixed(1)} dB SPL</code>)${earModeTag}`;
    if (calState.couplerVerified) {
      dom.calStatusBanner.className = "banner banner-ok";
      dom.calStatusText.innerHTML =
        `<strong>Coupler-Verified Calibration Active:</strong> ${escapeHtml(calState.name)} ` +
        `(calibrated <code>${escapeHtml(calState.date)}</code>)${refNote}${fsNote}`;
    } else {
      dom.calStatusBanner.className = "banner banner-warn";
      dom.calStatusText.innerHTML =
        `<strong>Unverified Preset Active:</strong> ${escapeHtml(calState.name)}. ` +
        `Measure all 18 component frequencies in your qCLS coupler before human testing.${refNote}${fsNote}`;
    }
  }

  /* Working draft while the calibration modal is open */
  let modalCalDraft = null;

  function getModalActiveEar() {
    return dom.calToneEar && dom.calToneEar.value === "Left" ? "Left" : "Right";
  }

  function ensureDraftEarMaps() {
    if (!modalCalDraft) return;
    if (!modalCalDraft.offsetsByEar || typeof modalCalDraft.offsetsByEar !== "object") {
      modalCalDraft.offsetsByEar = {
        Left: { ...modalCalDraft.offsetsDb },
        Right: { ...modalCalDraft.offsetsDb }
      };
    }
  }

  function getDraftEditableOffsetsMap() {
    if (!modalCalDraft) return {};
    if (modalCalDraft.perEarEnabled) {
      ensureDraftEarMaps();
      return modalCalDraft.offsetsByEar[getModalActiveEar()];
    }
    return modalCalDraft.offsetsDb;
  }

  function renderModalFullScaleReadout() {
    if (!modalCalDraft) return;
    const ear = getModalActiveEar();
    const info = QLDM.computeFullScale1kSpl(modalCalDraft, null, ear);
    const gainSign = info.gainAboveQclsDb >= 0 ? "+" : "";
    const earTag = modalCalDraft.perEarEnabled ? ` (${ear} Receiver)` : "";
    dom.calFullscaleReadout.innerHTML =
      `<div>` +
      `<strong>Nominal Full-Scale (0 dBFS peak) 1 kHz Tone${escapeHtml(earTag)}:</strong> <code>${info.fullScale1kSpl.toFixed(1)} dB SPL</code> &bull; ` +
      `<strong>Digital Ref:</strong> <code>${info.refDbfsRms60.toFixed(1)} dBFS RMS = 60.0 dB SPL</code> &bull; ` +
      `<strong>Analog Gain vs. qCLS (&minus;40 dBFS):</strong> <code>${gainSign}${info.gainAboveQclsDb.toFixed(1)} dB</code>` +
      `</div>`;
  }

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
    dom.calSaveErr.style.display = "none";

    const activeEar = getModalActiveEar();
    const otherEar = activeEar === "Left" ? "Right" : "Left";
    if (dom.calEarColLbl) {
      dom.calEarColLbl.textContent = modalCalDraft.perEarEnabled
        ? `Sensitivity Offset — ${activeEar} Ear (dB re Nominal)`
        : "Sensitivity Offset (dB re Nominal)";
    }
    if (dom.calCopyEarBtn) {
      dom.calCopyEarBtn.style.display = modalCalDraft.perEarEnabled ? "inline-block" : "none";
      dom.calCopyEarBtn.textContent = `Copy ${otherEar} → ${activeEar}`;
    }

    for (const f of QLDM.CALIBRATION_FREQS) {
      const key = String(f);
      const off = QLDM.lookupCalOffsetDb(modalCalDraft, f, activeEar);
      const hasVal = Number.isFinite(off);
      const boost = hasVal ? -off : NaN;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${f.toFixed(2)}</strong></td>
        <td style="font-size:12px; color:#475569;">${escapeHtml(describeComponentUsage(f))}</td>
        <td>
          <input type="number" step="0.1" min="-35" max="25" data-cal-freq="${key}"
                 value="${hasVal ? off.toFixed(1) : ""}"
                 style="width:95px; padding:4px 6px; border:1px solid #cbd5e1; border-radius:5px; font-size:13px;">
        </td>
        <td data-boost-for="${key}" style="font-family:monospace; color:${hasVal && boost > 0.05 ? "#b45309" : hasVal ? "#0f172a" : "#b91c1c"};">
          ${hasVal ? `${boost >= 0 ? "+" : ""}${boost.toFixed(1)} dB` : "MISSING"}
        </td>
      `;
      dom.calTableTbody.appendChild(tr);
    }

    dom.calTableTbody.querySelectorAll("input[data-cal-freq]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const k = inp.getAttribute("data-cal-freq");
        const raw = inp.value.trim();
        const targetMap = getDraftEditableOffsetsMap();
        const boostCell = dom.calTableTbody.querySelector(`[data-boost-for="${k}"]`);
        if (raw === "" || !Number.isFinite(Number(raw))) {
          delete targetMap[k];
          if (boostCell) {
            boostCell.textContent = "MISSING";
            boostCell.style.color = "#b91c1c";
          }
        } else {
          const v = Number(raw);
          targetMap[k] = Number(v.toFixed(2));
          if (modalCalDraft.perEarEnabled && getModalActiveEar() === "Right") {
            modalCalDraft.offsetsDb[k] = targetMap[k];
          }
          if (boostCell) {
            const b = -v;
            boostCell.textContent = `${b >= 0 ? "+" : ""}${b.toFixed(1)} dB`;
            boostCell.style.color = b > 0.05 ? "#b45309" : "#0f172a";
          }
        }
        renderModalFullScaleReadout();
        if (isCalPlaying) {
          startCalibrationTone();
        }
      });
    });
  }

  function openCalibrationModal() {
    stopAllAudio();
    const perEar = Boolean(calState.perEarEnabled);
    modalCalDraft = {
      id: calState.id || "custom",
      name: calState.name || "Etymotic ER-3A",
      couplerVerified: calState.couplerVerified,
      date: (/^\d{4}-\d{2}-\d{2}$/.test(calState.date) ? calState.date : todayIsoDate()),
      refDbfsRms60: QLDM.clampRefDbfs60(calState.refDbfsRms60),
      perEarEnabled: perEar,
      offsetsByEar: calState.offsetsByEar
        ? {
            Left: { ...(calState.offsetsByEar.Left || calState.offsetsDb) },
            Right: { ...(calState.offsetsByEar.Right || calState.offsetsDb) }
          }
        : {
            Left: { ...calState.offsetsDb },
            Right: { ...calState.offsetsDb }
          },
      offsetsDb: { ...calState.offsetsDb }
    };
    dom.calPresetSel.value = QLDM.TRANSDUCER_PRESETS[modalCalDraft.id] ? modalCalDraft.id : "er3a_nominal";
    dom.calRefDbfs.value = modalCalDraft.refDbfsRms60.toFixed(1);
    dom.calTransducerName.value = modalCalDraft.name;
    dom.calDateInput.value = modalCalDraft.date;
    dom.calToneEar.value = dom.testEar.value;
    dom.calPerEarChk.checked = perEar;
    dom.calMeasuredSpl.value = "";
    dom.calToneReadout.textContent = "Tone stopped.";
    dom.calSaveErr.style.display = "none";
    populateCalToneDropdown();
    renderModalFullScaleReadout();
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
    const activeCal = modalCalDraft || calState;

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

    const wave = QLDM.generateSoundWaveform({
      centerHz,
      sound,
      levelSpl: nomSpl,
      sampleRate: fs,
      durationMs: 12000,
      rampMs: 20,
      calTable: activeCal,
      ear,
      ceilingSpl: QLDM.EQUIPMENT_MAX_SPL
    });

    if (!wave.ok) {
      dom.calToneReadout.innerHTML =
        `<span style="color:#b91c1c; font-weight:700;">Refused to play (${escapeHtml(wave.reason)}): ` +
        `digital peak = ${Number.isFinite(wave.peak) ? wave.peak.toFixed(3) : "--"}. Check calibration offset or lower nominal SPL.</span>`;
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

    const activeEar = getModalActiveEar();
    const curOffRaw = QLDM.lookupCalOffsetDb(modalCalDraft, freqHz, activeEar);
    const curOff = Number.isFinite(curOffRaw) ? curOffRaw : 0.0;
    const updatedOff = Number((curOff + (measSpl - nomSpl)).toFixed(2));
    const exactKey = QLDM.CALIBRATION_FREQS.find((f) => Math.abs(f - freqHz) < 0.01);
    if (exactKey !== undefined) {
      const targetMap = getDraftEditableOffsetsMap();
      targetMap[String(exactKey)] = updatedOff;
      if (modalCalDraft.perEarEnabled && activeEar === "Right") {
        modalCalDraft.offsetsDb[String(exactKey)] = updatedOff;
      }
    }
    modalCalDraft.id = "custom_coupler";
    renderModalFullScaleReadout();
    renderCalModalTable();
    if (isCalPlaying) {
      startCalibrationTone();
    } else {
      const earNote = modalCalDraft.perEarEnabled ? ` (${activeEar} ear)` : "";
      dom.calToneReadout.innerHTML =
        `Updated <strong>${freqHz.toFixed(2)} Hz</strong>${escapeHtml(earNote)} offset to <code>${updatedOff.toFixed(1)} dB</code> ` +
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
    const fsInfo = QLDM.computeFullScale1kSpl(calState, null, cfg.ear);
    const gainSign = fsInfo.gainAboveQclsDb >= 0 ? "+" : "";

    if (dom.idleRefSummary) {
      dom.idleRefSummary.innerHTML =
        `Digital reference: <strong>${fsInfo.refDbfsRms60.toFixed(1)} dBFS RMS = 60.0 dB SPL</strong> ` +
        `(<strong>${gainSign}${fsInfo.gainAboveQclsDb.toFixed(1)} dB</strong> analog gain re qCLS; ` +
        `nominal full-scale 1 kHz tone = <strong>${fsInfo.fullScale1kSpl.toFixed(1)} dB SPL</strong>; ` +
        `<strong>24-bit / 48 kHz</strong> OS output path required with OS enhancements disabled). ` +
        `Any buffer exceeding <code>0 dBFS</code>, missing calibration, or exceeding ceiling is refused before playback.`;
    }

    const headroom = QLDM.computeMaxUnclippedLevels(calState, {
      durationMs: cfg.durationMs,
      rampMs: cfg.rampMs,
      sampleRate: fs,
      ear: cfg.ear
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
      if (!h.ok) {
        html += `<tr>
          <td><strong>${escapeHtml(h.label)}</strong></td>
          <td>--</td>
          <td>--</td>
          <td>--</td>
          <td><span class="tag tag-flag">${escapeHtml(h.reason)}</span></td>
        </tr>`;
        continue;
      }
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
    const parsed = QLDM.parseQclsElcCsv(csvText, filename);
    if (!parsed.ok) {
      dom.qclsImportStatus.style.display = "block";
      dom.qclsImportStatus.style.color = "#b91c1c";
      dom.qclsImportStatus.textContent = parsed.error || `Failed to parse ${filename}.`;
      return;
    }

    if (parsed.cu5_1k !== null) dom.cu5_1k.value = parsed.cu5_1k.toFixed(1);
    if (parsed.ucl_1k !== null) dom.ucl_1k.value = parsed.ucl_1k.toFixed(1);
    if (parsed.cu5_4k !== null) dom.cu5_4k.value = parsed.cu5_4k.toFixed(1);
    if (parsed.ucl_4k !== null) dom.ucl_4k.value = parsed.ucl_4k.toFixed(1);

    if (parsed.participantId) dom.participantId.value = parsed.participantId;
    if (parsed.ear) dom.testEar.value = parsed.ear;

    importedQclsFilename = filename;
    dom.qclsImportStatus.style.display = "block";
    dom.qclsImportStatus.style.color = "#0369a1";
    dom.qclsImportStatus.textContent =
      `Imported limits from ${filename}: 1k [CU5=${parsed.cu5_1k !== null ? parsed.cu5_1k.toFixed(1) : "--"}, CU50=${parsed.ucl_1k !== null ? parsed.ucl_1k.toFixed(1) : "--"}], ` +
      `4k [CU5=${parsed.cu5_4k !== null ? parsed.cu5_4k.toFixed(1) : "--"}, CU50=${parsed.ucl_4k !== null ? parsed.ucl_4k.toFixed(1) : "--"}] dB SPL.`;
    renderCalibrationStatusBanner();
    renderIdlePreview();
  }

  /* -------------------------------------------------------------------------
   * Operator Analog Gain Confirmation Gate (Follow-up Request 1.4)
   * ------------------------------------------------------------------------- */
  function openGainConfirmationModal(onConfirmed) {
    const activeEar = dom.testEar.value === "Left" ? "Left" : "Right";
    const fsInfo = QLDM.computeFullScale1kSpl(calState, null, activeEar);
    const gainSign = fsInfo.gainAboveQclsDb >= 0 ? "+" : "";
    const earCalNote = calState.perEarEnabled ? ` (${activeEar} receiver calibration)` : "";
    dom.gainConfirmDetails.innerHTML =
      `<strong>Active Transducer:</strong> ${escapeHtml(calState.name)}${escapeHtml(earCalNote)}<br>` +
      `<strong>qLDM Digital Reference:</strong> <code>${fsInfo.refDbfsRms60.toFixed(1)} dBFS RMS = 60.0 dB SPL</code><br>` +
      `<strong>Analog Gain Relative to qCLS:</strong> <code>${gainSign}${fsInfo.gainAboveQclsDb.toFixed(1)} dB</code><br>` +
      `<strong>Nominal Full-Scale (0 dBFS) 1 kHz Tone:</strong> <code>${fsInfo.fullScale1kSpl.toFixed(1)} dB SPL</code>`;
    dom.gainConfirmChk.checked = false;
    dom.gainConfirmOkBtn.disabled = true;
    gainModalCallback = onConfirmed;
    dom.gainConfirmModal.classList.add("open");
  }

  function closeGainConfirmationModal() {
    dom.gainConfirmModal.classList.remove("open");
    gainModalCallback = null;
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

  async function buildNewSessionFromSetup(gainConfirmationRecord) {
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

    const resolvedEarCal = QLDM.resolveCalForEar(calState, cfg.ear);
    const headroom = QLDM.computeMaxUnclippedLevels(resolvedEarCal, {
      durationMs: cfg.durationMs,
      rampMs: cfg.rampMs,
      sampleRate: fs,
      ear: cfg.ear
    });
    const fsInfo = QLDM.computeFullScale1kSpl(resolvedEarCal, null, cfg.ear);

    session = {
      sessionId: `QLDM_${Date.now()}`,
      appVersion: QLDM.APP_VERSION,
      createdAtIso: new Date().toISOString(),
      dateYmd: todayYmd(),
      timeHm: todayHm(),
      participantId: cfg.participantId,
      ear: cfg.ear,
      earCode: cfg.earCode,
      settings: cfg,
      analogGainConfirmation: gainConfirmationRecord || {
        confirmed: true,
        confirmed_at_iso: new Date().toISOString(),
        ref_dbfs_rms_at_60db_spl: fsInfo.refDbfsRms60,
        analog_gain_above_qcls_db: fsInfo.gainAboveQclsDb,
        full_scale_1khz_spl_db: fsInfo.fullScale1kSpl
      },
      audioInfo: {
        requestedSampleRate: QLDM.DEFAULT_FS,
        grantedSampleRate: fs,
        outputDevices
      },
      calibration: {
        ...resolvedEarCal,
        refDbfsRms60: fsInfo.refDbfsRms60,
        fullScale1kSpl: fsInfo.fullScale1kSpl,
        gainAboveQclsDb: fsInfo.gainAboveQclsDb,
        offsetsDb: { ...resolvedEarCal.offsetsDb },
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
      const arr = JSON.parse(localStorage.getItem(COMPLETED_SESSIONS_KEY)) || [];
      return Array.isArray(arr) ? arr.map((s) => QLDM.normalizeSessionRecord(s)).filter(Boolean) : [];
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
      ear: session.ear,
      ceilingSpl: session.ceilingSpl
    });

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

    const { oldCeiling, newCeiling } = QLDM.applyTooLoudToSession(session, currentPresentation);
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

  function repeatFlaggedBlockWithInstruction(centerHz) {
    if (!session) return;
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
    const rows = QLDM.collectSessionPseRows(session);
    const fsInfo = QLDM.computeFullScale1kSpl(session.calibration);

    const nScoredTrials = session.tbtRows.filter((t) => t.phase === "block" && t.tooLoud === 0 && t.guardStatus === "OK").length;
    dom.resultsSummaryMeta.innerHTML =
      `<strong>Participant:</strong> ${escapeHtml(session.participantId)} &bull; ` +
      `<strong>Ear:</strong> ${escapeHtml(session.ear)} &bull; ` +
      `<strong>Date:</strong> ${escapeHtml(session.dateYmd)} &bull; ` +
      `<strong>Scored Trials:</strong> ${nScoredTrials} &bull; ` +
      `<strong>Final Ceiling:</strong> ${session.ceilingSpl.toFixed(1)} dB SPL &bull; ` +
      `<strong>Ref:</strong> ${fsInfo.refDbfsRms60.toFixed(1)} dBFS = 60 dB SPL &bull; ` +
      `<strong>Sample Rate:</strong> ${session.audioInfo?.grantedSampleRate || QLDM.DEFAULT_FS} Hz`;

    /* Check latest pass of each frequency for COMPONENT_MATCH_SUSPECTED (1-oct forward matches) */
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
        `<strong>Component-Listening Flag (${escapeHtml(hzList)}):</strong> Every completed forward 1-octave match in the block had ` +
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

    if (dom.resultsPlotWrap) {
      dom.resultsPlotWrap.innerHTML = QLDM.renderResultsSvg(session);
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
      const ceilTxt =
        r.nAtCeiling > 0
          ? `${r.nAtCeilingFixedLouder} / ${r.nAtCeiling}`
          : "0";

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
        <td>${ceilTxt}</td>
        <td>${endsTxt}</td>
        <td>${flagHtml}</td>
      `;
      dom.resultsTbody.appendChild(tr);
    }
  }

  function resolveSessionHm(sess) {
    if (sess && sess.timeHm && /^\d{4}$/.test(String(sess.timeHm))) {
      return String(sess.timeHm);
    }
    if (sess && sess.createdAtIso) {
      const dt = new Date(sess.createdAtIso);
      if (!Number.isNaN(dt.getTime())) {
        return String(dt.getHours()).padStart(2, "0") + String(dt.getMinutes()).padStart(2, "0");
      }
    }
    return todayHm();
  }

  function exportFilename(prefix, ext) {
    if (!session) return `${prefix}_UNKNOWN.${ext}`;
    const hm = resolveSessionHm(session);
    return `${prefix}_${session.participantId}_${session.earCode}_${session.dateYmd}_${hm}.${ext}`;
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

    dom.testEar.addEventListener("change", () => {
      renderCalibrationStatusBanner();
      renderIdlePreview();
    });

    dom.participantId.addEventListener("change", () => {
      randomizeSeedInput();
    });

    dom.newSeedBtn.addEventListener("click", () => {
      randomizeSeedInput();
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

    /* Begin Session -> Operator Analog Gain Confirmation Gate */
    dom.startSessionBtn.addEventListener("click", () => {
      openGainConfirmationModal(async (confirmRecord) => {
        await buildNewSessionFromSetup(confirmRecord);
        enterSessionFlow();
      });
    });

    dom.gainConfirmChk.addEventListener("change", () => {
      dom.gainConfirmOkBtn.disabled = !dom.gainConfirmChk.checked;
    });

    dom.gainConfirmCancelBtn.addEventListener("click", () => {
      closeGainConfirmationModal();
    });

    dom.gainConfirmOkBtn.addEventListener("click", () => {
      if (!dom.gainConfirmChk.checked) return;
      const activeEar = dom.testEar.value === "Left" ? "Left" : "Right";
      const fsInfo = QLDM.computeFullScale1kSpl(calState, null, activeEar);
      const confirmRecord = {
        confirmed: true,
        confirmed_at_iso: new Date().toISOString(),
        ref_dbfs_rms_at_60db_spl: fsInfo.refDbfsRms60,
        analog_gain_above_qcls_db: fsInfo.gainAboveQclsDb,
        full_scale_1khz_spl_db: fsInfo.fullScale1kSpl
      };
      const cb = gainModalCallback;
      closeGainConfirmationModal();
      if (typeof cb === "function") cb(confirmRecord);
    });

    dom.resumeSessionBtn.addEventListener("click", async () => {
      try {
        const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
        if (!raw) return;
        session = QLDM.normalizeSessionRecord(JSON.parse(raw));
        if (!session) return;
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
        dom.gainConfirmModal.classList.contains("open") ||
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

    dom.pauseRestartBtn.addEventListener("click", () => {
      closePauseModal();
      openGainConfirmationModal(async (confirmRecord) => {
        await buildNewSessionFromSetup(confirmRecord);
        enterSessionFlow();
      });
    });

    dom.pauseReturnBtn.addEventListener("click", () => {
      returnToSetupKeepSaved();
    });

    /* Export Downloads */
    dom.dlAllBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(QLDM.formatPseCsv(session), exportFilename("LM_PSE", "csv"), "text/csv;charset=utf-8");
      setTimeout(() => {
        if (!session) return;
        triggerDownload(QLDM.formatTbtCsv(session), exportFilename("LM_TBT", "csv"), "text/csv;charset=utf-8");
      }, 130);
      setTimeout(() => {
        if (!session) return;
        triggerDownload(QLDM.formatSesJson(session), exportFilename("LM_SES", "json"), "application/json;charset=utf-8");
      }, 260);
    });
    dom.dlPseBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(QLDM.formatPseCsv(session), exportFilename("LM_PSE", "csv"), "text/csv;charset=utf-8");
    });
    dom.dlTbtBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(QLDM.formatTbtCsv(session), exportFilename("LM_TBT", "csv"), "text/csv;charset=utf-8");
    });
    dom.dlSesBtn.addEventListener("click", () => {
      if (!session) return;
      triggerDownload(QLDM.formatSesJson(session), exportFilename("LM_SES", "json"), "application/json;charset=utf-8");
    });

    /* Coupler Calibration Modal */
    dom.openCalBtn.addEventListener("click", openCalibrationModal);
    dom.bannerCalBtn.addEventListener("click", openCalibrationModal);
    dom.calCloseBtn.addEventListener("click", closeCalibrationModal);

    dom.calPerEarChk.addEventListener("change", () => {
      if (!modalCalDraft) return;
      modalCalDraft.perEarEnabled = Boolean(dom.calPerEarChk.checked);
      ensureDraftEarMaps();
      renderModalFullScaleReadout();
      renderCalModalTable();
      if (isCalPlaying) startCalibrationTone();
    });

    dom.calCopyEarBtn.addEventListener("click", () => {
      if (!modalCalDraft || !modalCalDraft.perEarEnabled) return;
      ensureDraftEarMaps();
      const activeEar = getModalActiveEar();
      const otherEar = activeEar === "Left" ? "Right" : "Left";
      modalCalDraft.offsetsByEar[activeEar] = { ...modalCalDraft.offsetsByEar[otherEar] };
      if (activeEar === "Right") {
        modalCalDraft.offsetsDb = { ...modalCalDraft.offsetsByEar.Right };
      }
      renderModalFullScaleReadout();
      renderCalModalTable();
      if (isCalPlaying) startCalibrationTone();
    });

    dom.calExportJsonBtn.addEventListener("click", () => {
      if (!modalCalDraft) return;
      modalCalDraft.refDbfsRms60 = QLDM.clampRefDbfs60(dom.calRefDbfs.value);
      modalCalDraft.name = dom.calTransducerName.value.trim() || "Custom Transducer";
      modalCalDraft.date = dom.calDateInput.value || todayIsoDate();
      const safeName = sanitizeId(modalCalDraft.name).slice(0, 28);
      const fname = `qLDM_CAL_${safeName}_${todayYmd()}_${todayHm()}.json`;
      triggerDownload(QLDM.formatCalibrationJson(modalCalDraft), fname, "application/json;charset=utf-8");
    });

    dom.calImportJsonBtn.addEventListener("click", () => {
      dom.calImportFile.click();
    });

    dom.calImportFile.addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = QLDM.parseImportedCalibrationJson(String(reader.result || ""));
        if (!res.ok) {
          dom.calSaveErr.style.display = "block";
          dom.calSaveErr.textContent = `Import failed: ${res.error}`;
          return;
        }
        const imp = res.calibration;
        modalCalDraft = {
          ...imp,
          date: (/^\d{4}-\d{2}-\d{2}$/.test(imp.date) ? imp.date : todayIsoDate()),
          perEarEnabled: Boolean(imp.perEarEnabled),
          offsetsByEar: imp.offsetsByEar
            ? { Left: { ...imp.offsetsByEar.Left }, Right: { ...imp.offsetsByEar.Right } }
            : { Left: { ...imp.offsetsDb }, Right: { ...imp.offsetsDb } },
          offsetsDb: { ...imp.offsetsDb }
        };
        dom.calRefDbfs.value = modalCalDraft.refDbfsRms60.toFixed(1);
        dom.calTransducerName.value = modalCalDraft.name;
        dom.calDateInput.value = modalCalDraft.date;
        dom.calPerEarChk.checked = modalCalDraft.perEarEnabled;
        dom.calSaveErr.style.display = "none";
        dom.calToneReadout.innerHTML =
          `<span style="color:#0369a1; font-weight:700;">Imported calibration from ${escapeHtml(file.name)} (${modalCalDraft.refDbfsRms60.toFixed(1)} dBFS @ 60 dB SPL). Click Save Coupler Calibration to apply.</span>`;
        renderModalFullScaleReadout();
        renderCalModalTable();
        if (isCalPlaying) startCalibrationTone();
      };
      reader.readAsText(file);
      ev.target.value = "";
    });

    dom.calPresetSel.addEventListener("change", () => {
      if (!modalCalDraft) return;
      const preset = cloneCalPreset(dom.calPresetSel.value, modalCalDraft.refDbfsRms60);
      modalCalDraft.id = preset.id;
      modalCalDraft.name = preset.name;
      modalCalDraft.couplerVerified = false;
      if (modalCalDraft.perEarEnabled) {
        ensureDraftEarMaps();
        modalCalDraft.offsetsByEar[getModalActiveEar()] = { ...preset.offsetsDb };
      } else {
        modalCalDraft.offsetsDb = { ...preset.offsetsDb };
        modalCalDraft.offsetsByEar = {
          Left: { ...preset.offsetsDb },
          Right: { ...preset.offsetsDb }
        };
      }
      dom.calTransducerName.value = modalCalDraft.name;
      renderModalFullScaleReadout();
      renderCalModalTable();
      if (isCalPlaying) startCalibrationTone();
    });

    dom.calRefDbfs.addEventListener("input", () => {
      if (!modalCalDraft) return;
      const v = Number(dom.calRefDbfs.value);
      if (Number.isFinite(v)) {
        modalCalDraft.refDbfsRms60 = QLDM.clampRefDbfs60(v);
        renderModalFullScaleReadout();
        if (isCalPlaying) startCalibrationTone();
      }
    });
    dom.calRefDbfs.addEventListener("change", () => {
      if (!modalCalDraft) return;
      modalCalDraft.refDbfsRms60 = QLDM.clampRefDbfs60(dom.calRefDbfs.value);
      dom.calRefDbfs.value = modalCalDraft.refDbfsRms60.toFixed(1);
      renderModalFullScaleReadout();
      if (isCalPlaying) startCalibrationTone();
    });

    dom.calLvl30Btn.addEventListener("click", () => {
      dom.calToneSpl.value = "30";
      if (isCalPlaying) startCalibrationTone();
    });
    dom.calLvl80Btn.addEventListener("click", () => {
      dom.calToneSpl.value = "80";
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
      if (modalCalDraft && modalCalDraft.perEarEnabled) {
        renderModalFullScaleReadout();
        renderCalModalTable();
      }
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
      const earsToCheck = modalCalDraft.perEarEnabled ? ["Left", "Right"] : [null];
      for (const earKey of earsToCheck) {
        const missingFreqs = QLDM.CALIBRATION_FREQS.filter(
          (f) => !Number.isFinite(QLDM.lookupCalOffsetDb(modalCalDraft, f, earKey))
        );
        if (missingFreqs.length > 0) {
          const earTag = earKey ? ` (${earKey} ear)` : "";
          dom.calSaveErr.style.display = "block";
          dom.calSaveErr.textContent =
            `Cannot save: missing calibration offset${earTag} for ${missingFreqs.map((f) => f.toFixed(2) + " Hz").join(", ")}.`;
          return;
        }
      }
      modalCalDraft.refDbfsRms60 = QLDM.clampRefDbfs60(dom.calRefDbfs.value);
      modalCalDraft.name = dom.calTransducerName.value.trim() || "Custom Transducer";
      modalCalDraft.date = dom.calDateInput.value || todayIsoDate();
      modalCalDraft.couplerVerified = true;
      saveCalibrationState(modalCalDraft);
      closeCalibrationModal();
    });
  }

  function init() {
    randomizeSeedInput();
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
