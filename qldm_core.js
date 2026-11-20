/*
 * qldm_core.js
 *
 * Pure, zero-DOM psychoacoustic & psychometric module for qLDM (Quick Loudness
 * Matching), implementing LOUDNESS_MATCHING_APP_SPEC.md and
 * LOUDNESS_MATCHING_APP_ADVICE.md.
 *
 * Runs identically in browser (<script src="qldm_core.js">) and headless under
 * Node.js (const QLDM = require("./qldm_core.js")) for automated verification
 * against nea_gen_5tc.m and lm_track_sim.py.
 */
(function (global) {
  "use strict";

  const APP_VERSION = "1.0.0";
  const DEFAULT_FS = 48000;

  /*
   * Digital reference level:
   * -70 dBFS RMS (0.000316227766) corresponds to 60.0 dB SPL for a 0-dB-offset
   * calibrated component. This is 30 dB lower than qCLS's 0.01 (-40 dBFS) reference,
   * giving >20 dB of clean digital headroom above a 100 dB SPL 5-tone complex
   * (crest factor ~3.15 = 10 dB) even with ~15 dB of high-frequency insert-phone
   * roll-off compensation at 5657 Hz, while preserving ~60 dB of SNR above the
   * 24-bit quantization floor for a 30 dB SPL pure tone.
   */
  const REF_SPL_DB = 60.0;
  const REF_DIGITAL_RMS_60DB = Math.pow(10.0, -70.0 / 20.0); // 0.00031622776601683794
  const LOGISTIC_K = Math.PI / Math.sqrt(3.0);               // sigma = K * s
  const FIXED_LAPSE = 0.02;
  const VARIED_OFFSET_LIM_DB = 20.0;
  const EQUIPMENT_MAX_SPL = 110.0;
  const MIN_VARIED_SPL = 10.0;

  /*
   * Canonical 18 component frequencies required across Standard (1-octave) and
   * Extended (1-octave + 1/4-octave) sets at 1 kHz and 4 kHz.
   * Exact formula: f_m = f_c * 2^(m * bw_oct / 4) for m in [-2, -1, 0, 1, 2],
   * identical to nea_gen_5tc.m and generate_stimulus(STIM_FIVE_TONE_LOG) in qcls_core.c.
   */
  function getComplexComponentFreqs(centerHz, bwOct) {
    const fc = Number(centerHz);
    const bw = Number(bwOct);
    if (!(bw > 0)) return [fc];
    const out = [];
    for (let m = -2; m <= 2; m++) {
      out.push(fc * Math.pow(2.0, (m * bw) / 4.0));
    }
    return out;
  }

  const CALIBRATION_FREQS = (() => {
    const raw = [
      ...getComplexComponentFreqs(1000, 1.0),
      ...getComplexComponentFreqs(1000, 0.25),
      ...getComplexComponentFreqs(4000, 1.0),
      ...getComplexComponentFreqs(4000, 0.25)
    ];
    const uniq = [];
    for (const f of raw) {
      if (!uniq.some(u => Math.abs(u - f) < 1e-4)) uniq.push(Number(f.toFixed(4)));
    }
    return uniq.sort((a, b) => a - b);
  })();

  /*
   * Default transducer presets:
   * offsetDb is the acoustic coupler output relative to nominal (measured_SPL - nominal_SPL)
   * when driven at constant voltage re 1000 Hz:
   *   0.0 dB => transducer produces exact nominal SPL at REF_DIGITAL_RMS_60DB
   *  -14.0 dB => transducer rolls off by 14 dB in coupler (app boosts component by +14 dB)
   */
  const TRANSDUCER_PRESETS = {
    er3a_nominal: {
      id: "er3a_nominal",
      name: "Etymotic ER-3A Insert (Nominal Starting Curve — Verify on Local Coupler)",
      couplerVerified: false,
      date: "UnverifiedPreset",
      offsetsDb: {
        "707.1068": -0.4,
        "840.8964": -0.2,
        "917.004":  -0.1,
        "957.6033":  0.0,
        "1000":      0.0,
        "1044.2738": 0.0,
        "1090.5077": 0.1,
        "1189.2071": 0.3,
        "1414.2136": 0.8,
        "2828.4271": 1.2,
        "3363.5857": -1.0,
        "3668.0162": -2.6,
        "3830.4131": -3.6,
        "4000":      -4.8,
        "4177.0951": -6.1,
        "4362.0309": -7.5,
        "4756.8285": -10.5,
        "5656.8542": -14.5
      }
    },
    flat_ref: {
      id: "flat_ref",
      name: "Flat 0-dB Reference (Ideal / Loopback Verification)",
      couplerVerified: false,
      date: "Reference",
      offsetsDb: Object.fromEntries(CALIBRATION_FREQS.map(f => [String(f), 0.0]))
    }
  };

  function lookupCalOffsetDb(calTable, freqHz) {
    if (!calTable || !calTable.offsetsDb) return 0.0;
    let bestKey = null;
    let bestDiff = Infinity;
    for (const k of Object.keys(calTable.offsetsDb)) {
      const fk = Number(k);
      const d = Math.abs(fk - freqHz);
      if (d < bestDiff) {
        bestDiff = d;
        bestKey = k;
      }
    }
    if (bestKey !== null && bestDiff < 2.0) {
      const v = Number(calTable.offsetsDb[bestKey]);
      return Number.isFinite(v) ? v : 0.0;
    }
    return 0.0;
  }

  /* -------------------------------------------------------------------------
   * Deterministic Seeded PRNG (Mulberry32 — 32-bit state, reproducible)
   * ------------------------------------------------------------------------- */
  function createRng(seed) {
    let s = (Number(seed) >>> 0) || 20261120;
    return {
      next() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296.0;
      },
      getState() { return s >>> 0; },
      setState(newState) { s = (Number(newState) >>> 0); }
    };
  }

  /* -------------------------------------------------------------------------
   * Sound Specification & Match-Set Data Tables (Section 2 & 3)
   * Each sound is { kind: "tone" | "complex", bwOct: 0 | 0.25 | 1.0 }
   * Each match row is { id, blockHz, fixedSound, variedSound, fixedLevelSpl, role }
   * ------------------------------------------------------------------------- */
  const SOUND_TONE = Object.freeze({ kind: "tone", bwOct: 0.0, label: "tone" });
  const SOUND_1OCT = Object.freeze({ kind: "complex", bwOct: 1.0, label: "5tc_1oct" });
  const SOUND_QOCT = Object.freeze({ kind: "complex", bwOct: 0.25, label: "5tc_0.25oct" });

  const STANDARD_LEVELS_SPL = [50, 60, 70, 80, 90, 100];
  const CENTER_FREQS_HZ = [1000, 4000];

  function buildMatchTable(options = {}) {
    const setMode = options.matchSet || "standard"; // "standard" (12) | "extended" (24) | "short4" (4)
    const includeNull = Boolean(options.includeNullMatches);
    const includeReverse = Boolean(options.includeReverseMatches);
    const levels = options.levelsSpl || (setMode === "short4" ? [60, 90] : STANDARD_LEVELS_SPL);
    const bws = setMode === "extended" ? [1.0, 0.25] : [1.0];

    const table = [];
    let idx = 1;
    for (const fc of CENTER_FREQS_HZ) {
      for (const bw of bws) {
        const compSound = bw === 0.25 ? { ...SOUND_QOCT } : { ...SOUND_1OCT };
        for (const lvl of levels) {
          table.push({
            matchIndex: idx++,
            id: `M${String(table.length + 1).padStart(2, "0")}_F_${fc}Hz_${bw}oct_${lvl}dB`,
            centerHz: fc,
            fixedSound: compSound,
            variedSound: { ...SOUND_TONE },
            fixedLevelSpl: lvl,
            role: "forward"
          });
          if (includeReverse) {
            table.push({
              matchIndex: idx++,
              id: `M${String(table.length + 1).padStart(2, "0")}_R_${fc}Hz_${bw}oct_${lvl}dB`,
              centerHz: fc,
              fixedSound: { ...SOUND_TONE },
              variedSound: compSound,
              fixedLevelSpl: lvl,
              role: "reverse"
            });
          }
        }
      }
      if (includeNull) {
        const nullLevels = options.nullLevelsSpl || [60, 90];
        for (const nl of nullLevels) {
          table.push({
            matchIndex: idx++,
            id: `M${String(table.length + 1).padStart(2, "0")}_N_${fc}Hz_tone_${nl}dB`,
            centerHz: fc,
            fixedSound: { ...SOUND_TONE },
            variedSound: { ...SOUND_TONE },
            fixedLevelSpl: nl,
            role: "null"
          });
        }
      }
    }
    return table;
  }

  /* -------------------------------------------------------------------------
   * Stimulus Synthesis, Clipping Check, & Buffer-Based Acoustic Safety Guard
   * ------------------------------------------------------------------------- */
  function generateSoundWaveform(params) {
    const centerHz = Number(params.centerHz);
    const sound = params.sound; // { kind: "tone" | "complex", bwOct }
    const levelSpl = Number(params.levelSpl);
    const fs = Number(params.sampleRate || DEFAULT_FS);
    const durationMs = Number(params.durationMs ?? 500);
    const rampMs = Number(params.rampMs ?? 20);
    const calTable = params.calTable || TRANSDUCER_PRESETS.flat_ref;
    const refRms60 = Number(params.refDigitalRms60 ?? REF_DIGITAL_RMS_60DB);

    if (!Number.isFinite(centerHz) || !Number.isFinite(levelSpl) || !(fs > 0) || !(durationMs > 0)) {
      return { ok: false, reason: "INVALID_NUMERIC_PARAM", samples: new Float64Array(0), peak: NaN, acousticSpl: NaN };
    }

    const nSamples = Math.round((durationMs / 1000.0) * fs);
    const nRamp = Math.min(Math.floor(nSamples / 2), Math.round((rampMs / 1000.0) * fs));
    const compFreqs = (sound && sound.kind === "complex" && sound.bwOct > 0)
      ? getComplexComponentFreqs(centerHz, sound.bwOct)
      : [centerHz];
    const nComp = compFreqs.length;

    /*
     * Step 1: Synthesize unweighted sine-phase components and compute the exact
     * finite-duration cross-correlation factor rho of the uncalibrated unit-RMS
     * sum (as in nea_gen_5tc.m: w = raw * (rms_val / rms(raw))), so that the
     * acoustic sum has RMS within <0.001 dB of nominal even for slow 1.9-Hz
     * quarter-octave beats at 500 ms.
     */
    const rawUnweighted = new Float64Array(nSamples);
    const calLinGains = compFreqs.map(f => Math.pow(10.0, -lookupCalOffsetDb(calTable, f) / 20.0));
    const calWeightedSum = new Float64Array(nSamples);

    let sumSqUnweighted = 0.0;
    for (let i = 0; i < nSamples; i++) {
      const t = i / fs;
      let u = 0.0;
      let w = 0.0;
      for (let k = 0; k < nComp; k++) {
        const s = Math.sin(2.0 * Math.PI * compFreqs[k] * t); // exact sine start phase (0 rad)
        u += s;
        w += calLinGains[k] * s;
      }
      rawUnweighted[i] = u;
      calWeightedSum[i] = w;
      sumSqUnweighted += u * u;
    }

    const rmsUnweighted = Math.sqrt(sumSqUnweighted / nSamples); // ~ sqrt(nComp / 2)
    const targetAcousticRms = refRms60 * Math.pow(10.0, (levelSpl - REF_SPL_DB) / 20.0);
    const scale = targetAcousticRms / rmsUnweighted;

    const out = new Float64Array(nSamples);
    let peak = 0.0;
    let sumSqUnrampedOut = 0.0;
    for (let i = 0; i < nSamples; i++) {
      let win = 1.0;
      if (nRamp > 0) {
        if (i < nRamp) {
          win = 0.5 * (1.0 - Math.cos((Math.PI * i) / nRamp));
        } else if (i >= nSamples - nRamp) {
          const rem = nSamples - 1 - i;
          /* Symmetric raised-cosine offset matching qcls_core.c convention */
          win = 0.5 * (1.0 - Math.cos((Math.PI * (nSamples - i)) / nRamp));
        }
      }
      const unwinSample = calWeightedSum[i] * scale;
      sumSqUnrampedOut += unwinSample * unwinSample;
      const v = unwinSample * win;
      out[i] = v;
      const av = Math.abs(v);
      if (av > peak) peak = av;
    }

    const unrampedDigitalRms = Math.sqrt(sumSqUnrampedOut / nSamples);
    const crestFactorRaw = (() => {
      let pkRaw = 0.0;
      for (let i = 0; i < nSamples; i++) {
        const a = Math.abs(rawUnweighted[i]);
        if (a > pkRaw) pkRaw = a;
      }
      return pkRaw / rmsUnweighted;
    })();

    const guard = verifyBufferSafety(out, {
      sampleRate: fs,
      rampSamples: nRamp,
      compFreqs,
      calTable,
      refDigitalRms60: refRms60,
      ceilingSpl: params.ceilingSpl ?? EQUIPMENT_MAX_SPL
    });

    return {
      ok: guard.ok,
      reason: guard.reason,
      samples: out,
      peak,
      unrampedDigitalRms,
      crestFactorRaw,
      acousticSpl: guard.estimatedSpl,
      compFreqs
    };
  }

  /*
   * Independent pre-playback buffer guard (Advice Section 3 & Section 6):
   * Inspects the synthesized sample buffer directly (not nominal parameters) to:
   *   1. Reject any NaN / non-finite sample,
   *   2. Reject any buffer with digital peak > 1.0 (0 dBFS — never clip!),
   *   3. Project the steady-state plateau onto the component calibration table
   *      (plus any unmodeled residual energy) to compute actual acoustic coupler
   *      SPL directly from the buffer and enforce <= ceilingSpl.
   */
  function verifyBufferSafety(samples, opts) {
    const n = samples.length;
    if (n === 0) return { ok: false, reason: "EMPTY_BUFFER", peak: NaN, estimatedSpl: NaN };

    let peak = 0.0;
    for (let i = 0; i < n; i++) {
      const v = samples[i];
      if (!Number.isFinite(v)) {
        return { ok: false, reason: "NAN_OR_INFINITE_SAMPLE", peak: NaN, estimatedSpl: NaN };
      }
      const av = Math.abs(v);
      if (av > peak) peak = av;
    }
    if (peak > 1.0) {
      return { ok: false, reason: "DIGITAL_CLIP_PREVENTED", peak, estimatedSpl: NaN };
    }

    const fs = Number(opts.sampleRate || DEFAULT_FS);
    const nRamp = Number(opts.rampSamples || 0);
    const i0 = Math.min(nRamp, Math.floor(n / 4));
    const i1 = Math.max(i0 + 1, n - i0);
    const nMid = i1 - i0;
    const refRms60 = Number(opts.refDigitalRms60 ?? REF_DIGITAL_RMS_60DB);
    const calTable = opts.calTable || TRANSDUCER_PRESETS.flat_ref;
    const compFreqs = opts.compFreqs || [];

    let totalDigitalPwr = 0.0;
    for (let i = i0; i < i1; i++) totalDigitalPwr += samples[i] * samples[i];
    totalDigitalPwr /= nMid;

    let acousticPwrSum = 0.0;
    let modeledDigitalPwr = 0.0;
    for (const f of compFreqs) {
      let cSum = 0.0, sSum = 0.0;
      const w = (2.0 * Math.PI * f) / fs;
      for (let i = i0; i < i1; i++) {
        const ph = w * i;
        cSum += samples[i] * Math.cos(ph);
        sSum += samples[i] * Math.sin(ph);
      }
      const amp = (2.0 / nMid) * Math.hypot(cSum, sSum);
      const digRmsK = amp / Math.SQRT2;
      modeledDigitalPwr += digRmsK * digRmsK;
      const calGain = Math.pow(10.0, lookupCalOffsetDb(calTable, f) / 20.0);
      const acRmsK = digRmsK * calGain;
      acousticPwrSum += acRmsK * acRmsK;
    }

    /* Conservative bound on any unmodeled broadband energy */
    const residDigPwr = Math.max(0.0, totalDigitalPwr - modeledDigitalPwr * 1.08);
    acousticPwrSum += residDigPwr;

    const acRms = Math.sqrt(Math.max(acousticPwrSum, 1e-30));
    const estimatedSpl = REF_SPL_DB + 20.0 * Math.log10(acRms / refRms60);
    const limitSpl = Math.min(Number(opts.ceilingSpl ?? EQUIPMENT_MAX_SPL), EQUIPMENT_MAX_SPL);

    if (!Number.isFinite(estimatedSpl)) {
      return { ok: false, reason: "INVALID_BUFFER_SPL", peak, estimatedSpl: NaN };
    }
    if (estimatedSpl > limitSpl + 0.35) {
      return { ok: false, reason: "CEILING_EXCEEDED_BY_BUFFER", peak, estimatedSpl };
    }
    return { ok: true, reason: "OK", peak, estimatedSpl };
  }

  /*
   * Compute highest unclipped SPL (dB SPL) before a listener is seated
   * for each distinct stimulus in the active set (Advice Section 3).
   */
  function computeMaxUnclippedLevels(calTable, opts = {}) {
    const durationMs = Number(opts.durationMs ?? 500);
    const rampMs = Number(opts.rampMs ?? 20);
    const fs = Number(opts.sampleRate || DEFAULT_FS);
    const refRms60 = Number(opts.refDigitalRms60 ?? REF_DIGITAL_RMS_60DB);

    const specs = [
      { label: "1 kHz Pure Tone", centerHz: 1000, sound: SOUND_TONE },
      { label: "4 kHz Pure Tone", centerHz: 4000, sound: SOUND_TONE },
      { label: "1 kHz 1-Octave Complex (5TC)", centerHz: 1000, sound: SOUND_1OCT },
      { label: "4 kHz 1-Octave Complex (5TC)", centerHz: 4000, sound: SOUND_1OCT },
      { label: "1 kHz 1/4-Octave Complex (5TC)", centerHz: 1000, sound: SOUND_QOCT },
      { label: "4 kHz 1/4-Octave Complex (5TC)", centerHz: 4000, sound: SOUND_QOCT }
    ];

    return specs.map(sp => {
      const refWave = generateSoundWaveform({
        centerHz: sp.centerHz,
        sound: sp.sound,
        levelSpl: 60.0,
        sampleRate: fs,
        durationMs,
        rampMs,
        calTable,
        refDigitalRms60: refRms60,
        ceilingSpl: 200.0
      });
      const maxSplBeforeClip = 60.0 + 20.0 * Math.log10(1.0 / refWave.peak);
      return {
        label: sp.label,
        centerHz: sp.centerHz,
        bwOct: sp.sound.bwOct,
        kind: sp.sound.kind,
        peakAt60dB: refWave.peak,
        crestFactor: Number(refWave.crestFactorRaw.toFixed(3)),
        maxUnclippedSpl: Number((Math.floor(maxSplBeforeClip * 10) / 10).toFixed(1))
      };
    });
  }

  /*
   * Build a single contiguous two-interval trial buffer (Interval 1 + silence gap + Interval 2)
   * so interval timing runs on the hardware audio sample clock rather than setTimeout.
   */
  function buildTwoIntervalBuffer(params) {
    const fs = Number(params.sampleRate || DEFAULT_FS);
    const durationMs = Number(params.durationMs ?? 500);
    const rampMs = Number(params.rampMs ?? 20);
    const gapMs = Number(params.gapMs ?? 400);

    const w1 = generateSoundWaveform({
      centerHz: params.centerHz,
      sound: params.sound1,
      levelSpl: params.level1Spl,
      sampleRate: fs,
      durationMs,
      rampMs,
      calTable: params.calTable,
      refDigitalRms60: params.refDigitalRms60,
      ceilingSpl: params.ceilingSpl
    });
    if (!w1.ok) return { ok: false, which: 1, reason: w1.reason, peak: w1.peak };

    const w2 = generateSoundWaveform({
      centerHz: params.centerHz,
      sound: params.sound2,
      levelSpl: params.level2Spl,
      sampleRate: fs,
      durationMs,
      rampMs,
      calTable: params.calTable,
      refDigitalRms60: params.refDigitalRms60,
      ceilingSpl: params.ceilingSpl
    });
    if (!w2.ok) return { ok: false, which: 2, reason: w2.reason, peak: w2.peak };

    const n1 = w1.samples.length;
    const nGap = Math.round((gapMs / 1000.0) * fs);
    const n2 = w2.samples.length;
    const combined = new Float32Array(n1 + nGap + n2);
    for (let i = 0; i < n1; i++) combined[i] = w1.samples[i];
    for (let i = 0; i < n2; i++) combined[n1 + nGap + i] = w2.samples[i];

    return {
      ok: true,
      reason: "OK",
      samples: combined,
      nIntervalSamples: n1,
      nGapSamples: nGap,
      totalDurationSec: combined.length / fs,
      interval1EndSec: n1 / fs,
      interval2StartSec: (n1 + nGap) / fs,
      peak1: w1.peak,
      peak2: w2.peak,
      spl1Verified: w1.acousticSpl,
      spl2Verified: w2.acousticSpl
    };
  }

  /* -------------------------------------------------------------------------
   * Adaptive Staircase Track State (Section 5 Baseline: 1-up, 1-down)
   * ------------------------------------------------------------------------- */
  function createTrackState(matchSpec, trackSlot, opts = {}) {
    const startOffset = Number(opts.startOffsetDb ?? 10.0);
    const maxTrials = Number(opts.trialsPerTrack ?? 8);
    const ceilingSpl = Math.min(Number(opts.ceilingSpl ?? 100.0), EQUIPMENT_MAX_SPL);
    const upper = trackSlot === "upper";
    const rawInitVaried = matchSpec.fixedLevelSpl + (upper ? startOffset : -startOffset);
    const minSpl = Math.max(MIN_VARIED_SPL, matchSpec.fixedLevelSpl - VARIED_OFFSET_LIM_DB);
    const maxSpl = Math.min(ceilingSpl, matchSpec.fixedLevelSpl + VARIED_OFFSET_LIM_DB);
    const initVaried = Math.max(minSpl, Math.min(maxSpl, rawInitVaried));

    return {
      trackId: `${matchSpec.id}_${upper ? "U" : "L"}`,
      matchId: matchSpec.id,
      matchIndex: matchSpec.matchIndex,
      upper,
      slotLabel: upper ? "upper" : "lower",
      centerHz: matchSpec.centerHz,
      fixedSound: matchSpec.fixedSound,
      variedSound: matchSpec.variedSound,
      fixedLevelSpl: matchSpec.fixedLevelSpl,
      role: matchSpec.role,
      maxTrials,
      trialsCompleted: 0,
      curVariedSpl: initVaried,
      lastDir: 0,
      hasReversed: false,
      finished: false,
      stopReason: null,
      variedOffsetsDb: [],
      variedLevelsSpl: [],
      variedJudgedLouder: [],
      hitLimitFlags: []
    };
  }

  function stepTrack(track, variedWasJudgedLouder, ceilingSpl) {
    const effCeil = Math.min(Number(ceilingSpl ?? 100.0), EQUIPMENT_MAX_SPL);
    const minSpl = Math.max(MIN_VARIED_SPL, track.fixedLevelSpl - VARIED_OFFSET_LIM_DB);
    const maxSpl = Math.min(effCeil, track.fixedLevelSpl + VARIED_OFFSET_LIM_DB);

    const usedSpl = track.curVariedSpl;
    const usedOffset = usedSpl - track.fixedLevelSpl;
    const atLimit = (usedSpl <= minSpl + 1e-9) || (usedSpl >= maxSpl - 1e-9);

    track.variedLevelsSpl.push(usedSpl);
    track.variedOffsetsDb.push(usedOffset);
    track.variedJudgedLouder.push(Boolean(variedWasJudgedLouder));
    track.hitLimitFlags.push(atLimit);
    track.trialsCompleted += 1;

    /* One-up, one-down: varied goes down (-1) after "varied louder", up (+1) after "fixed louder" */
    const d = variedWasJudgedLouder ? -1 : 1;
    if (d !== 0 && track.lastDir !== 0 && d !== track.lastDir) {
      track.hasReversed = true;
    }
    const stepDb = track.hasReversed ? 2.0 : 4.0;
    track.curVariedSpl = Math.max(minSpl, Math.min(maxSpl, usedSpl + d * stepDb));
    if (d !== 0) track.lastDir = d;

    if (track.trialsCompleted >= track.maxTrials) {
      track.finished = true;
      track.stopReason = "COMPLETED";
    }
    return track;
  }

  function applyCeilingChangeToTrack(track, newCeilingSpl) {
    const effCeil = Math.min(Number(newCeilingSpl), EQUIPMENT_MAX_SPL);
    if (track.finished) return;
    if (track.fixedLevelSpl > effCeil + 1e-9) {
      track.finished = true;
      track.stopReason = "TOO_LOUD_CEILING";
      return;
    }
    const maxSpl = Math.min(effCeil, track.fixedLevelSpl + VARIED_OFFSET_LIM_DB);
    if (track.curVariedSpl > maxSpl) {
      track.curVariedSpl = maxSpl;
    }
  }

  /* -------------------------------------------------------------------------
   * Block Maximum-Likelihood Logistic Estimator (Reproducing lm_track_sim.py)
   *
   * Model: P(varied louder) = lapse/2 + (1 - lapse) * expit((x - mu_m) / s)
   *   where x = varied_SPL - fixed_SPL, s = sigma / K, K = pi / sqrt(3),
   *   mu_m in [-25, +25] dB, sigma in [0.5, 20.0] dB, lapse = 0.02 fixed.
   * ------------------------------------------------------------------------- */
  function expit(z) {
    if (z >= 0) {
      const ez = Math.exp(-z);
      return 1.0 / (1.0 + ez);
    }
    const ez = Math.exp(z);
    return ez / (1.0 + ez);
  }

  /* Symmetric eigenvalue decomposition (Jacobi) for exact Moore-Penrose pinv(I) */
  function symPinvDiag(A) {
    const n = A.length;
    const V = Array.from({ length: n }, (_, i) => {
      const row = new Float64Array(n);
      row[i] = 1.0;
      return row;
    });
    const M = A.map(r => Float64Array.from(r));

    for (let sweep = 0; sweep < 80; sweep++) {
      let maxOff = 0.0;
      let p = 0, q = 1;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const v = Math.abs(M[i][j]);
          if (v > maxOff) { maxOff = v; p = i; q = j; }
        }
      }
      if (maxOff < 1e-15) break;
      const app = M[p][p], aqq = M[q][q], apq = M[p][q];
      const tau = (aqq - app) / (2.0 * apq);
      const t = tau >= 0 ? 1.0 / (tau + Math.hypot(1.0, tau)) : -1.0 / (-tau + Math.hypot(1.0, tau));
      const c = 1.0 / Math.hypot(1.0, t);
      const s = t * c;

      M[p][p] = app - t * apq;
      M[q][q] = aqq + t * apq;
      M[p][q] = M[q][p] = 0.0;
      for (let k = 0; k < n; k++) {
        if (k !== p && k !== q) {
          const mkp = M[k][p], mkq = M[k][q];
          M[k][p] = M[p][k] = c * mkp - s * mkq;
          M[k][q] = M[q][k] = s * mkp + c * mkq;
        }
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }

    let maxEig = 0.0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(M[i][i]) > maxEig) maxEig = Math.abs(M[i][i]);
    }
    const tol = 1e-15 * n * Math.max(maxEig, 1e-30);
    const diagPinv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0.0;
      for (let k = 0; k < n; k++) {
        const lam = M[k][k];
        if (lam > tol) sum += (V[i][k] * V[i][k]) / lam;
      }
      diagPinv[i] = Math.max(0.0, sum);
    }
    return diagPinv;
  }

  /* Solve symmetric positive-definite linear system (H + reg*I) * dx = -g */
  function solveLinearSPD(H, g) {
    const n = g.length;
    const A = H.map((row, i) => {
      const r = Float64Array.from(row);
      r[i] += 1e-12;
      return r;
    });
    const b = Float64Array.from(g, v => -v);

    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) {
        if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      }
      if (piv !== i) {
        const tmp = A[i]; A[i] = A[piv]; A[piv] = tmp;
        const tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      }
      const diag = A[i][i];
      if (Math.abs(diag) < 1e-14) return null;
      for (let r = i + 1; r < n; r++) {
        const fac = A[r][i] / diag;
        for (let c = i; c < n; c++) A[r][c] -= fac * A[i][c];
        b[r] -= fac * b[i];
      }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  function fitBlockML(xsPerMatch, ysPerMatch) {
    const M = xsPerMatch.length;
    if (M === 0) {
      return { midpoints: [], ses: [], sigma: NaN, seLogSigma: NaN, atBound: false };
    }

    const lo = new Float64Array(M + 1);
    const hi = new Float64Array(M + 1);
    const th = new Float64Array(M + 1);
    for (let m = 0; m < M; m++) {
      lo[m] = -25.0;
      hi[m] = 25.0;
      const xm = xsPerMatch[m];
      let sum = 0.0;
      for (let i = 0; i < xm.length; i++) sum += xm[i];
      const meanX = xm.length > 0 ? sum / xm.length : 0.0;
      th[m] = Math.max(-25.0, Math.min(25.0, meanX));
    }
    lo[M] = Math.log(0.5 / LOGISTIC_K);
    hi[M] = Math.log(20.0 / LOGISTIC_K);
    th[M] = Math.log(4.0 / LOGISTIC_K);

    function evalObjGradHess(vec, wantHess) {
      const s = Math.exp(vec[M]);
      let nll = 0.0;
      const grad = new Float64Array(M + 1);
      const H = wantHess ? Array.from({ length: M + 1 }, () => new Float64Array(M + 1)) : null;

      for (let m = 0; m < M; m++) {
        const xm = xsPerMatch[m];
        const ym = ysPerMatch[m];
        const mu = vec[m];
        let gm = 0.0;
        let hmm = 0.0, hmM = 0.0;

        for (let i = 0; i < xm.length; i++) {
          const z = (xm[i] - mu) / s;
          const F = expit(z);
          const p = FIXED_LAPSE / 2.0 + (1.0 - FIXED_LAPSE) * F;
          const y = ym[i] ? 1 : 0;
          nll -= y ? Math.log(p) : Math.log(1.0 - p);

          const dpdz = (1.0 - FIXED_LAPSE) * F * (1.0 - F);
          const w = (y ? (1.0 / p) : (-1.0 / (1.0 - p))) * dpdz; // d(ll)/dz
          gm += w / s;
          grad[M] += w * z;

          if (wantHess) {
            /* Exact Fisher / Gauss-Newton curvature + exact 2nd-order NLL curvature */
            const fishZ = (dpdz * dpdz) / (p * (1.0 - p));
            hmm += fishZ / (s * s);
            hmM += (fishZ * z) / s;
            H[M][M] += fishZ * z * z;
          }
        }
        grad[m] = gm;
        if (wantHess) {
          H[m][m] = Math.max(hmm, 1e-10);
          H[m][M] = H[M][m] = hmM;
        }
      }
      if (wantHess) H[M][M] = Math.max(H[M][M], 1e-10);
      return { nll, grad, H };
    }

    /* Projected BFGS with Strong-Wolfe / backtracking line search (matches scipy L-BFGS-B) */
    function runBoundedSolve(initVec) {
      const dim = M + 1;
      const cur = Float64Array.from(initVec);
      for (let i = 0; i < dim; i++) cur[i] = Math.max(lo[i], Math.min(hi[i], cur[i]));

      /* Inverse Hessian approximation B (initialized to I) */
      let B = Array.from({ length: dim }, (_, i) => {
        const r = new Float64Array(dim);
        r[i] = 1.0;
        return r;
      });

      let { nll: fCur, grad: gCur } = evalObjGradHess(cur, false);

      for (let iter = 0; iter < 200; iter++) {
        /* Projected gradient convergence check */
        let pgMax = 0.0;
        const clamped = new Uint8Array(dim);
        for (let i = 0; i < dim; i++) {
          if ((cur[i] <= lo[i] + 1e-12 && gCur[i] >= 0.0) ||
              (cur[i] >= hi[i] - 1e-12 && gCur[i] <= 0.0)) {
            clamped[i] = 1;
          } else {
            const a = Math.abs(gCur[i]);
            if (a > pgMax) pgMax = a;
          }
        }
        if (pgMax < 1e-9) break;

        /* Quasi-Newton search direction d = -B_free * g_free */
        const d = new Float64Array(dim);
        let dg = 0.0;
        for (let i = 0; i < dim; i++) {
          if (clamped[i]) continue;
          let sum = 0.0;
          for (let j = 0; j < dim; j++) {
            if (!clamped[j]) sum -= B[i][j] * gCur[j];
          }
          d[i] = sum;
          dg += d[i] * gCur[i];
        }
        if (!(dg < -1e-14)) {
          /* Reset B to identity if curvature was lost after a bound activation */
          for (let i = 0; i < dim; i++) {
            B[i].fill(0.0);
            B[i][i] = 1.0;
            d[i] = clamped[i] ? 0.0 : -gCur[i];
          }
          dg = 0.0;
          for (let i = 0; i < dim; i++) dg += d[i] * gCur[i];
        }

        /* Backtracking line search with projection onto [lo, hi] */
        let alpha = 1.0;
        const next = new Float64Array(dim);
        let fNext = fCur, gNext = gCur;
        let accepted = false;
        for (let ls = 0; ls < 40; ls++) {
          for (let i = 0; i < dim; i++) {
            next[i] = Math.max(lo[i], Math.min(hi[i], cur[i] + alpha * d[i]));
          }
          const ev = evalObjGradHess(next, false);
          if (ev.nll <= fCur + 1e-4 * alpha * dg || (ev.nll < fCur)) {
            fNext = ev.nll;
            gNext = ev.grad;
            accepted = true;
            break;
          }
          alpha *= 0.5;
        }
        if (!accepted) break;

        /* BFGS rank-2 inverse-Hessian update on free subspace */
        const sVec = new Float64Array(dim);
        const yVec = new Float64Array(dim);
        let sy = 0.0, sMax = 0.0;
        for (let i = 0; i < dim; i++) {
          sVec[i] = next[i] - cur[i];
          yVec[i] = gNext[i] - gCur[i];
          if (Math.abs(sVec[i]) > sMax) sMax = Math.abs(sVec[i]);
          if (!clamped[i] && !(next[i] <= lo[i] + 1e-12 || next[i] >= hi[i] - 1e-12)) {
            sy += sVec[i] * yVec[i];
          } else {
            sVec[i] = 0.0;
            yVec[i] = 0.0;
          }
          cur[i] = next[i];
        }
        fCur = fNext;
        gCur = gNext;

        if (sy > 1e-12) {
          const rho = 1.0 / sy;
          const By = new Float64Array(dim);
          let yBy = 0.0;
          for (let i = 0; i < dim; i++) {
            let sum = 0.0;
            for (let j = 0; j < dim; j++) sum += B[i][j] * yVec[j];
            By[i] = sum;
            yBy += yVec[i] * sum;
          }
          const c1 = (sy + yBy) * (rho * rho);
          for (let i = 0; i < dim; i++) {
            for (let j = 0; j < dim; j++) {
              B[i][j] += c1 * sVec[i] * sVec[j] - rho * (By[i] * sVec[j] + sVec[i] * By[j]);
            }
          }
        }
        if (sMax < 1e-12 && pgMax < 1e-7) break;
      }
      return { vec: cur, nll: fCur };
    }

    /* Run exact start matching lm_track_sim.py (th0 = [mean(xs), log(4/K)]) first */
    const best = runBoundedSolve(th);

    const opt = best.vec;
    const sOpt = Math.exp(opt[M]);
    const I = Array.from({ length: M + 1 }, () => new Float64Array(M + 1));
    for (let m = 0; m < M; m++) {
      const xm = xsPerMatch[m];
      const mu = opt[m];
      let imm = 0.0, imM = 0.0;
      for (let i = 0; i < xm.length; i++) {
        const z = (xm[i] - mu) / sOpt;
        const F = expit(z);
        const p = FIXED_LAPSE / 2.0 + (1.0 - FIXED_LAPSE) * F;
        const dpdz = (1.0 - FIXED_LAPSE) * F * (1.0 - F);
        const v = 1.0 / (p * (1.0 - p));
        imm += v * Math.pow(dpdz / sOpt, 2);
        imM += v * (dpdz / sOpt) * (dpdz * z);
        I[M][M] += v * Math.pow(dpdz * z, 2);
      }
      I[m][m] = imm;
      I[m][M] = I[M][m] = imM;
    }

    const pinvDiag = symPinvDiag(I);
    const ses = Array.from({ length: M }, (_, m) => Math.sqrt(pinvDiag[m]));
    const seLogSigma = Math.sqrt(pinvDiag[M]);
    const atBound =
      Math.abs(opt[M] - lo[M]) < 1e-6 ||
      Math.abs(opt[M] - hi[M]) < 1e-6 ||
      Array.from({ length: M }, (_, m) => Math.abs(opt[m]) > 25.0 - 1e-6).some(Boolean);

    return {
      midpoints: Array.from(opt.slice(0, M)),
      ses,
      sigma: LOGISTIC_K * sOpt,
      seLogSigma,
      atBound
    };
  }

  /* -------------------------------------------------------------------------
   * Match Diagnostics & Flags (Spec Section 5 + Advice Section 7)
   * ------------------------------------------------------------------------- */
  function evaluateBlockMatches(blockMatches, trackPairs, opts = {}) {
    const compFlagThresholdDb = Number(opts.componentFlagThresholdDb ?? -6.0);

    const activeIdx = [];
    const xs = [];
    const ys = [];

    blockMatches.forEach((m, idx) => {
      if (m.excludedReason) return;
      const pair = trackPairs[idx];
      const allX = [...pair.upper.variedOffsetsDb, ...pair.lower.variedOffsetsDb];
      const allY = [...pair.upper.variedJudgedLouder, ...pair.lower.variedJudgedLouder];
      if (allX.length >= 2) {
        activeIdx.push(idx);
        xs.push(allX);
        ys.push(allY);
      }
    });

    const fit = activeIdx.length > 0 ? fitBlockML(xs, ys) : { midpoints: [], ses: [], sigma: NaN, atBound: false };
    const fitMap = new Map();
    activeIdx.forEach((mIdx, k) => {
      fitMap.set(mIdx, { mu: fit.midpoints[k], se: fit.ses[k] });
    });

    const rows = blockMatches.map((m, idx) => {
      if (m.excludedReason) {
        return {
          ...m,
          nTrials: 0,
          variedPseSpl: null,
          toneEqualSpl: null,
          deltaDb: null,
          seDb: null,
          sharedSigmaDb: Number.isFinite(fit.sigma) ? fit.sigma : null,
          upperEndSpl: null,
          lowerEndSpl: null,
          flags: ["EXCLUDED"],
          leftOutReason: m.excludedReason
        };
      }

      const pair = trackPairs[idx];
      const uLvls = pair.upper.variedLevelsSpl;
      const lLvls = pair.lower.variedLevelsSpl;
      const nTrials = uLvls.length + lLvls.length;
      const fRes = fitMap.get(idx);

      if (!fRes) {
        return {
          ...m,
          nTrials,
          variedPseSpl: null,
          toneEqualSpl: null,
          deltaDb: null,
          seDb: null,
          sharedSigmaDb: Number.isFinite(fit.sigma) ? fit.sigma : null,
          upperEndSpl: null,
          lowerEndSpl: null,
          flags: [pair.upper.stopReason || pair.lower.stopReason || "INCOMPLETE"],
          leftOutReason: pair.upper.stopReason || pair.lower.stopReason || "INCOMPLETE"
        };
      }

      const meanTail = arr => {
        if (arr.length === 0) return NaN;
        const k = Math.min(4, arr.length);
        const sub = arr.slice(arr.length - k);
        return sub.reduce((a, b) => a + b, 0) / sub.length;
      };
      const has3Consec = boolArr => {
        for (let i = 0; i + 2 < boolArr.length; i++) {
          if (boolArr[i] && boolArr[i + 1] && boolArr[i + 2]) return true;
        }
        return false;
      };

      const upperEndSpl = meanTail(uLvls);
      const lowerEndSpl = meanTail(lLvls);
      const flags = [];
      if (Number.isFinite(upperEndSpl) && Number.isFinite(lowerEndSpl) && Math.abs(upperEndSpl - lowerEndSpl) > 6.0) {
        flags.push("TRACKS_APART_GT_6DB");
      }
      if (has3Consec(pair.upper.hitLimitFlags) || has3Consec(pair.lower.hitLimitFlags)) {
        flags.push("AT_LIMIT_3_CONSEC");
      }
      if (fRes.se > 3.0) {
        flags.push("SE_GT_3DB");
      }
      if (pair.upper.stopReason && pair.upper.stopReason !== "COMPLETED") {
        flags.push(pair.upper.stopReason);
      }
      if (pair.lower.stopReason && pair.lower.stopReason !== "COMPLETED" && !flags.includes(pair.lower.stopReason)) {
        flags.push(pair.lower.stopReason);
      }

      const variedPseSpl = m.fixedLevelSpl + fRes.mu;
      /* Delta = (level of tone at equal loudness) - (level of complex) */
      let toneEqualSpl = variedPseSpl;
      let deltaDb = fRes.mu;
      if (m.role === "reverse") {
        toneEqualSpl = m.fixedLevelSpl;
        deltaDb = -fRes.mu;
      }

      return {
        ...m,
        nTrials,
        muVariedMinusFixedDb: fRes.mu,
        variedPseSpl,
        toneEqualSpl,
        deltaDb,
        seDb: fRes.se,
        sharedSigmaDb: fit.sigma,
        upperEndSpl,
        lowerEndSpl,
        flags,
        leftOutReason: ""
      };
    });

    /* Component-listening check (Advice Section 7 & 8):
     * Flag if every completed forward match in the block has Delta <= -6 dB. */
    const forwardCompleted = rows.filter(r => r.role === "forward" && r.deltaDb !== null && r.nTrials >= 8);
    const componentMatchFlag =
      forwardCompleted.length >= 2 &&
      forwardCompleted.every(r => r.deltaDb <= compFlagThresholdDb);

    if (componentMatchFlag) {
      for (const r of forwardCompleted) {
        if (!r.flags.includes("COMPONENT_MATCH_SUSPECTED")) {
          r.flags.push("COMPONENT_MATCH_SUSPECTED");
        }
      }
    }

    return {
      rows,
      sharedSigmaDb: fit.sigma,
      atBound: fit.atBound,
      componentMatchFlag
    };
  }

  /* -------------------------------------------------------------------------
   * Headless Simulated-Listener Harness (Matches lm_track_sim.py for Acceptance)
   * ------------------------------------------------------------------------- */
  function runSimulatedBlock(rng, params = {}) {
    const M = Number(params.matchesPerBlock ?? 6);
    const nPerTrack = Number(params.trialsPerTrack ?? 8);
    const trueSigma = Number(params.sigma ?? 4.0);
    const startDb = Number(params.startOffsetDb ?? 10.0);
    const trueLapse = Number(params.lapse ?? 0.02);
    const sTrue = trueSigma / LOGISTIC_K;

    const trueDeltas = params.trueDeltas || Array.from({ length: M }, () => -8.0 + 10.0 * rng.next());
    const matches = trueDeltas.map((_, idx) => ({
      matchIndex: idx + 1,
      id: `SIM_M${idx + 1}`,
      centerHz: 1000,
      fixedSound: SOUND_1OCT,
      variedSound: SOUND_TONE,
      fixedLevelSpl: 50 + idx * 10,
      role: "forward"
    }));

    const pairs = matches.map(m => ({
      upper: createTrackState(m, "upper", { startOffsetDb: startDb, trialsPerTrack: nPerTrack, ceilingSpl: 130 }),
      lower: createTrackState(m, "lower", { startOffsetDb: startDb, trialsPerTrack: nPerTrack, ceilingSpl: 130 })
    }));

    /* Randomly interleave all unfinished tracks in the block (Spec Section 5) */
    const pool = [];
    pairs.forEach(p => { pool.push(p.upper, p.lower); });

    while (true) {
      const active = pool.filter(t => !t.finished);
      if (active.length === 0) break;
      const pick = active[Math.floor(rng.next() * active.length)];
      const mIdx = pick.matchIndex - 1;
      const x = pick.curVariedSpl - pick.fixedLevelSpl;
      const pToneLouder = trueLapse / 2.0 + (1.0 - trueLapse) * expit((x - trueDeltas[mIdx]) / sTrue);
      const resp = rng.next() < pToneLouder;
      stepTrack(pick, resp, 130);
    }

    const evalRes = evaluateBlockMatches(matches, pairs, { componentFlagThresholdDb: -999 });
    return { trueDeltas, evalRes };
  }

  const api = {
    APP_VERSION,
    DEFAULT_FS,
    REF_SPL_DB,
    REF_DIGITAL_RMS_60DB,
    LOGISTIC_K,
    FIXED_LAPSE,
    VARIED_OFFSET_LIM_DB,
    EQUIPMENT_MAX_SPL,
    MIN_VARIED_SPL,
    SOUND_TONE,
    SOUND_1OCT,
    SOUND_QOCT,
    STANDARD_LEVELS_SPL,
    CENTER_FREQS_HZ,
    CALIBRATION_FREQS,
    TRANSDUCER_PRESETS,
    getComplexComponentFreqs,
    lookupCalOffsetDb,
    createRng,
    buildMatchTable,
    generateSoundWaveform,
    verifyBufferSafety,
    computeMaxUnclippedLevels,
    buildTwoIntervalBuffer,
    createTrackState,
    stepTrack,
    applyCeilingChangeToTrack,
    fitBlockML,
    evaluateBlockMatches,
    runSimulatedBlock
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.QLDMCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
