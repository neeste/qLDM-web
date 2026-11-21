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

  const APP_VERSION = "1.1.2";
  const DEFAULT_FS = 48000;

  /*
   * Digital reference level (configurable in calibration from -70 to -50 dBFS):
   * Default -60.0 dBFS RMS (0.001000) corresponds to 60.0 dB SPL for a 0-dB-offset
   * calibrated component (20 dB lower digital reference / +20 dB higher analog gain
   * than qCLS's -40 dBFS = 0.01 reference):
   *   - At -60 dBFS: a full-scale (0 dBFS peak) 1-kHz tone is nominally 116.9 dB SPL,
   *     the nominal ER-3A table leaves a 102.3 dB SPL unclipped ceiling across the
   *     entire stimulus set, and a 30 dB SPL tone (-90 dBFS RMS) has a peak of 1.5
   *     16-bit steps and sits 56-59 dB above the ideal 24-bit quantization floor.
   *   - At -70 dBFS: full-scale 1-kHz tone is 126.9 dB SPL (+30 dB gain re qCLS),
   *     and a 30 dB SPL tone (-100 dBFS RMS) has a peak of 0.46 of one 16-bit step
   *     and sits 46-49 dB above the 24-bit quantization floor.
   *   A 24-bit (or 32-bit float) OS output path is required across the full range.
   */
  const REF_SPL_DB = 60.0;
  const DEFAULT_REF_DBFS_60DB = -60.0;
  const LEGACY_V1_REF_DBFS_60DB = -70.0;
  const MIN_REF_DBFS_60DB = -70.0;
  const MAX_REF_DBFS_60DB = -50.0;
  const QCLS_REF_DBFS_60DB = -40.0;
  const REF_DIGITAL_RMS_60DB = Math.pow(10.0, DEFAULT_REF_DBFS_60DB / 20.0); // 0.001
  const LOGISTIC_K = Math.PI / Math.sqrt(3.0);               // sigma = K * s
  const FIXED_LAPSE = 0.02;
  const VARIED_OFFSET_LIM_DB = 20.0;
  const EQUIPMENT_MAX_SPL = 110.0;
  const MIN_VARIED_SPL = 10.0;

  function clampRefDbfs60(dbfs) {
    const v = Number(dbfs);
    if (!Number.isFinite(v)) return DEFAULT_REF_DBFS_60DB;
    return Math.max(MIN_REF_DBFS_60DB, Math.min(MAX_REF_DBFS_60DB, v));
  }

  function hasExplicitRefField(obj) {
    return (
      obj !== null &&
      obj !== undefined &&
      typeof obj === "object" &&
      obj.refDbfsRms60 !== undefined &&
      obj.refDbfsRms60 !== null &&
      obj.refDbfsRms60 !== "" &&
      Number.isFinite(Number(obj.refDbfsRms60))
    );
  }

  function resolveRefDbfs60(calTable, explicitRefDbfs) {
    if (explicitRefDbfs !== undefined && explicitRefDbfs !== null && Number.isFinite(Number(explicitRefDbfs))) {
      return clampRefDbfs60(explicitRefDbfs);
    }
    if (calTable && typeof calTable === "object") {
      if (hasExplicitRefField(calTable)) {
        return clampRefDbfs60(calTable.refDbfsRms60);
      }
      /* A calibration record with offsetsDb but no refDbfsRms60 field was saved by
       * qLDM v1.0.0 at -70.0 dBFS RMS @ 60 dB SPL; keep -70.0 dBFS so levels never shift +10 dB. */
      if (calTable.offsetsDb && typeof calTable.offsetsDb === "object") {
        return LEGACY_V1_REF_DBFS_60DB;
      }
    }
    return DEFAULT_REF_DBFS_60DB;
  }

  function resolveRefDigitalRms60(calTable, explicitRefRms60) {
    if (explicitRefRms60 !== undefined && explicitRefRms60 !== null && Number(explicitRefRms60) > 0 && Number.isFinite(Number(explicitRefRms60))) {
      return Number(explicitRefRms60);
    }
    const dbfs = resolveRefDbfs60(calTable, null);
    return Math.pow(10.0, dbfs / 20.0);
  }

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
      refDbfsRms60: DEFAULT_REF_DBFS_60DB,
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
      refDbfsRms60: DEFAULT_REF_DBFS_60DB,
      offsetsDb: Object.fromEntries(CALIBRATION_FREQS.map(f => [String(f), 0.0]))
    }
  };

  /*
   * Resolve ear-specific calibration map when perEarEnabled is active, while
   * keeping backward-compatible single-map calTable.offsetsDb behavior by default.
   */
  function resolveCalForEar(calTable, ear = null) {
    if (!calTable || typeof calTable !== "object") return calTable;
    const earKey = ear === "Left" ? "Left" : ear === "Right" ? "Right" : null;
    if (
      calTable.perEarEnabled &&
      earKey &&
      calTable.offsetsByEar &&
      calTable.offsetsByEar[earKey] &&
      typeof calTable.offsetsByEar[earKey] === "object"
    ) {
      return {
        ...calTable,
        activeEar: earKey,
        offsetsDb: { ...calTable.offsetsByEar[earKey] }
      };
    }
    return calTable;
  }

  /*
   * Strict component calibration lookup:
   * Returns NaN if no table entry is within 2 Hz or if the value is missing/non-finite,
   * so an uncalibrated component is refused rather than silently treated as 0 dB.
   */
  function lookupCalOffsetDb(calTable, freqHz, ear = null) {
    const resolved = resolveCalForEar(calTable, ear);
    if (!resolved || !resolved.offsetsDb) return NaN;
    let bestKey = null;
    let bestDiff = Infinity;
    for (const k of Object.keys(resolved.offsetsDb)) {
      const fk = Number(k);
      if (!Number.isFinite(fk)) continue;
      const d = Math.abs(fk - freqHz);
      if (d < bestDiff) {
        bestDiff = d;
        bestKey = k;
      }
    }
    if (bestKey !== null && bestDiff < 2.0) {
      const raw = resolved.offsetsDb[bestKey];
      if (raw === null || raw === undefined || raw === "") return NaN;
      const v = Number(raw);
      return Number.isFinite(v) ? v : NaN;
    }
    return NaN;
  }

  /*
   * Nominal SPL of a full-scale (0 dBFS peak = -3.0103 dBFS RMS) 1-kHz pure tone
   * under the active digital reference and 1-kHz calibration offset, plus the
   * analog hardware gain difference relative to qCLS (-40 dBFS RMS @ 60 dB SPL).
   */
  function computeFullScale1kSpl(calTable, explicitRefDbfs, ear = null) {
    const refDbfs = resolveRefDbfs60(calTable, explicitRefDbfs);
    const off1k = lookupCalOffsetDb(calTable, 1000.0, ear);
    const offsetUsed = Number.isFinite(off1k) ? off1k : 0.0;
    const exactSpl = REF_SPL_DB - refDbfs - 20.0 * Math.log10(Math.SQRT2) + offsetUsed;
    return {
      refDbfsRms60: refDbfs,
      refDigitalRms60: Math.pow(10.0, refDbfs / 20.0),
      gainAboveQclsDb: QCLS_REF_DBFS_60DB - refDbfs,
      fullScale1kSpl: Number((Math.floor(exactSpl * 10) / 10).toFixed(1)),
      exactFullScale1kSpl: exactSpl,
      hasValid1kCal: Number.isFinite(off1k)
    };
  }

  /* Generate a fresh 8-digit integer RNG seed [10000000..99999999] per new session */
  function generateRandomSeed() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return 10000000 + (arr[0] % 90000000);
      }
    } catch (_e) { /* fall through */ }
    return 10000000 + Math.floor(Math.random() * 90000000);
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
    const calTable = resolveCalForEar(params.calTable || TRANSDUCER_PRESETS.flat_ref, params.ear);
    const refRms60 = resolveRefDigitalRms60(calTable, params.refDigitalRms60);

    if (!Number.isFinite(centerHz) || !Number.isFinite(levelSpl) || !(fs > 0) || !(durationMs > 0)) {
      return { ok: false, reason: "INVALID_NUMERIC_PARAM", samples: new Float64Array(0), peak: NaN, acousticSpl: NaN };
    }

    const nSamples = Math.round((durationMs / 1000.0) * fs);
    const nRamp = Math.min(Math.floor(nSamples / 2), Math.round((rampMs / 1000.0) * fs));
    const compFreqs = (sound && sound.kind === "complex" && sound.bwOct > 0)
      ? getComplexComponentFreqs(centerHz, sound.bwOct)
      : [centerHz];
    const nComp = compFreqs.length;

    /* Refuse immediately if any component lacks a valid calibration table entry */
    const calOffsetsDb = [];
    for (const f of compFreqs) {
      const offDb = lookupCalOffsetDb(calTable, f);
      if (!Number.isFinite(offDb)) {
        return {
          ok: false,
          reason: "MISSING_CALIBRATION_ENTRY",
          missingFreqHz: f,
          samples: new Float64Array(0),
          peak: NaN,
          acousticSpl: NaN
        };
      }
      calOffsetsDb.push(offDb);
    }

    /*
     * Step 1: Synthesize unweighted sine-phase components and compute the exact
     * finite-duration cross-correlation factor rho of the uncalibrated unit-RMS
     * sum (as in nea_gen_5tc.m: w = raw * (rms_val / rms(raw))), so that the
     * acoustic sum has RMS within <0.001 dB of nominal even for slow 1.9-Hz
     * quarter-octave beats at 500 ms.
     */
    const rawUnweighted = new Float64Array(nSamples);
    const calLinGains = calOffsetsDb.map(offDb => Math.pow(10.0, -offDb / 20.0));
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
    const calTable = resolveCalForEar(opts.calTable || TRANSDUCER_PRESETS.flat_ref, opts.ear);
    const refRms60 = resolveRefDigitalRms60(calTable, opts.refDigitalRms60);
    const compFreqs = opts.compFreqs || [];

    for (const f of compFreqs) {
      if (!Number.isFinite(lookupCalOffsetDb(calTable, f))) {
        return { ok: false, reason: "MISSING_CALIBRATION_ENTRY", missingFreqHz: f, peak, estimatedSpl: NaN };
      }
    }

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
    const resolvedCal = resolveCalForEar(calTable, opts.ear);
    const refRms60 = resolveRefDigitalRms60(resolvedCal, opts.refDigitalRms60);

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
        calTable: resolvedCal,
        refDigitalRms60: refRms60,
        ceilingSpl: 200.0
      });
      if (!refWave.ok) {
        return {
          label: sp.label,
          centerHz: sp.centerHz,
          bwOct: sp.sound.bwOct,
          kind: sp.sound.kind,
          ok: false,
          reason: refWave.reason,
          peakAt60dB: NaN,
          crestFactor: NaN,
          maxUnclippedSpl: NaN
        };
      }
      const maxSplBeforeClip = 60.0 + 20.0 * Math.log10(1.0 / refWave.peak);
      return {
        label: sp.label,
        centerHz: sp.centerHz,
        bwOct: sp.sound.bwOct,
        kind: sp.sound.kind,
        ok: true,
        reason: "OK",
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
      ear: params.ear,
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
      ear: params.ear,
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
      hitCeilingFlags: [],
      hitLimitFlags: []
    };
  }

  function stepTrack(track, variedWasJudgedLouder, ceilingSpl) {
    const effCeil = Math.min(Number(ceilingSpl ?? 100.0), EQUIPMENT_MAX_SPL);
    const minSpl = Math.max(MIN_VARIED_SPL, track.fixedLevelSpl - VARIED_OFFSET_LIM_DB);
    const rangeMaxSpl = track.fixedLevelSpl + VARIED_OFFSET_LIM_DB;
    const maxSpl = Math.min(effCeil, rangeMaxSpl);

    const usedSpl = track.curVariedSpl;
    const usedOffset = usedSpl - track.fixedLevelSpl;
    /* Separate ceiling cap (Max Output or "Too loud"-lowered ceiling) from +/-20 dB range & 10 dB floor */
    const atCeiling = usedSpl >= effCeil - 1e-9;
    const atRangeOrFloor = !atCeiling && ((usedSpl <= minSpl + 1e-9) || (usedSpl >= rangeMaxSpl - 1e-9));

    if (!Array.isArray(track.hitCeilingFlags)) track.hitCeilingFlags = [];
    if (!Array.isArray(track.hitLimitFlags)) track.hitLimitFlags = [];

    track.variedLevelsSpl.push(usedSpl);
    track.variedOffsetsDb.push(usedOffset);
    track.variedJudgedLouder.push(Boolean(variedWasJudgedLouder));
    track.hitCeilingFlags.push(atCeiling);
    track.hitLimitFlags.push(atRangeOrFloor);
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

    const countCeilingStats = pair => {
      let nAtCeiling = 0;
      let nAtCeilingFixedLouder = 0;
      for (const tr of [pair?.upper, pair?.lower]) {
        if (!tr || !Array.isArray(tr.hitCeilingFlags)) continue;
        for (let i = 0; i < tr.hitCeilingFlags.length; i++) {
          if (tr.hitCeilingFlags[i]) {
            nAtCeiling += 1;
            if (!tr.variedJudgedLouder[i]) nAtCeilingFixedLouder += 1;
          }
        }
      }
      return { nAtCeiling, nAtCeilingFixedLouder };
    };

    const rows = blockMatches.map((m, idx) => {
      if (m.excludedReason) {
        return {
          ...m,
          nTrials: 0,
          nAtCeiling: 0,
          nAtCeilingFixedLouder: 0,
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
      const { nAtCeiling, nAtCeilingFixedLouder } = countCeilingStats(pair);
      const fRes = fitMap.get(idx);

      if (!fRes) {
        return {
          ...m,
          nTrials,
          nAtCeiling,
          nAtCeilingFixedLouder,
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
        if (!Array.isArray(boolArr)) return false;
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
      if (has3Consec(pair.upper.hitCeilingFlags) || has3Consec(pair.lower.hitCeilingFlags)) {
        flags.push("AT_CEILING");
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
        nAtCeiling,
        nAtCeilingFixedLouder,
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

    /* Component-listening check (Follow-up Section 3):
     * Evaluate ONLY over completed forward 1-octave matches in the block (at least 2 completed),
     * since quarter-octave complexes do not produce -7 dB single-component matches, and mark only those. */
    const forwardOneOctCompleted = rows.filter(
      r =>
        r.role === "forward" &&
        r.fixedSound &&
        r.fixedSound.kind === "complex" &&
        Math.abs(Number(r.fixedSound.bwOct) - 1.0) < 1e-6 &&
        r.deltaDb !== null &&
        r.nTrials >= 8
    );
    const componentMatchFlag =
      forwardOneOctCompleted.length >= 2 &&
      forwardOneOctCompleted.every(r => r.deltaDb <= compFlagThresholdDb);

    if (componentMatchFlag) {
      for (const r of forwardOneOctCompleted) {
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
    const ceilingSpl = Number(params.ceilingSpl ?? 130);
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
      upper: createTrackState(m, "upper", { startOffsetDb: startDb, trialsPerTrack: nPerTrack, ceilingSpl }),
      lower: createTrackState(m, "lower", { startOffsetDb: startDb, trialsPerTrack: nPerTrack, ceilingSpl })
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
      stepTrack(pick, resp, ceilingSpl);
    }

    const evalRes = evaluateBlockMatches(matches, pairs, { componentFlagThresholdDb: -999 });
    return { trueDeltas, evalRes };
  }

  /* -------------------------------------------------------------------------
   * Pure Session Mutation & File Export Formatters (Shared by Browser & Tests)
   * ------------------------------------------------------------------------- */
  function csvEscape(val) {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  /*
   * Apply a "Too loud" event to a session object (Spec Section 6):
   * Lowers ceilingSpl by 5 dB for the rest of the session, ends every track whose
   * fixed level exceeds the new ceiling, clamps active tracks, and logs the event.
   */
  function applyTooLoudToSession(sess, presentation = null, timestampIso = null) {
    const oldCeiling = Number(sess.ceilingSpl ?? 100.0);
    const newCeiling = Math.max(MIN_VARIED_SPL + 15.0, oldCeiling - 5.0);
    sess.ceilingSpl = newCeiling;

    if (Array.isArray(sess.blocks)) {
      for (const blk of sess.blocks) {
        blk.matches.forEach((m, idx) => {
          const pair = blk.pairs[idx];
          if (!pair || (!pair.upper && !pair.lower)) return;
          const hadTrials =
            (pair.upper ? pair.upper.trialsCompleted : 0) +
            (pair.lower ? pair.lower.trialsCompleted : 0);
          if (m.fixedLevelSpl > newCeiling + 1e-9 && hadTrials === 0 && !m.excludedReason) {
            m.excludedReason = `TOO_LOUD_CEILING (${newCeiling.toFixed(1)})`;
          }
          if (pair.upper) applyCeilingChangeToTrack(pair.upper, newCeiling);
          if (pair.lower) applyCeilingChangeToTrack(pair.lower, newCeiling);
        });
      }
    }

    if (!Array.isArray(sess.tooLoudEvents)) sess.tooLoudEvents = [];
    sess.tooLoudEvents.push({
      timestampIso: timestampIso || new Date().toISOString(),
      phase: sess.phase || "block",
      blockPass: presentation ? presentation.blockPass : null,
      blockHz: presentation ? presentation.blockHz : null,
      matchId: presentation ? presentation.matchId : null,
      trackId: presentation ? presentation.trackId : null,
      fixedLevelSpl: presentation ? presentation.fixedLevelSpl : null,
      variedLevelSpl: presentation ? presentation.variedLevelSpl : null,
      oldCeilingSpl: oldCeiling,
      newCeilingSpl: newCeiling
    });

    if (presentation) {
      if (!Array.isArray(sess.tbtRows)) sess.tbtRows = [];
      const blk = sess.blocks && sess.blocks[sess.activeBlockArrayIndex];
      sess.tbtRows.push({
        phase: presentation.isPractice ? "practice" : "block",
        blockPass: presentation.blockPass,
        blockHz: presentation.blockHz,
        matchId: presentation.matchId,
        role: presentation.role,
        trackId: presentation.trackId,
        trackSlot: presentation.trackSlot,
        trialInBlock: presentation.isPractice
          ? (sess.practice ? sess.practice.trialIndex + 1 : 1)
          : (blk ? blk.trialsInBlockCompleted + 1 : 1),
        trialInTrack: presentation.isPractice
          ? (sess.practice ? sess.practice.trialIndex + 1 : 1)
          : (presentation.trackRef ? presentation.trackRef.trialsCompleted + 1 : 0),
        centerHz: presentation.centerHz,
        bandwidthOct: presentation.bandwidthOct,
        fixedSound: presentation.fixedSound.label,
        variedSound: presentation.variedSound.label,
        fixedLevelSpl: presentation.fixedLevelSpl,
        variedLevelSpl: presentation.variedLevelSpl,
        variedInterval: presentation.variedInterval,
        interval1Sound: presentation.sound1.label,
        interval1Spl: presentation.level1Spl,
        interval2Sound: presentation.sound2.label,
        interval2Spl: presentation.level2Spl,
        responseInterval: "TOO_LOUD",
        variedJudgedLouder: "",
        tooLoud: 1,
        rtMs: "",
        ceilingSpl: newCeiling,
        guardStatus: "TOO_LOUD_PRESSED"
      });
      if (!presentation.isPractice && presentation.trackRef && !presentation.trackRef.finished) {
        applyCeilingChangeToTrack(presentation.trackRef, newCeiling);
      }
    }

    return { oldCeiling, newCeiling };
  }

  function collectSessionPseRows(sess) {
    const out = [];
    const compThresh = Number(sess.settings?.compFlagDb ?? -6.0);
    for (const blk of (sess.blocks || [])) {
      const ev = blk.evalSummary || evaluateBlockMatches(blk.matches, blk.pairs, {
        componentFlagThresholdDb: compThresh
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
          nAtCeiling: r.nAtCeiling ?? 0,
          nAtCeilingFixedLouder: r.nAtCeilingFixedLouder ?? 0,
          upperEndSpl: r.upperEndSpl,
          lowerEndSpl: r.lowerEndSpl,
          flags: r.flags || [],
          leftOutReason: r.leftOutReason || ""
        });
      }
    }
    return out;
  }

  function formatPseCsv(sess) {
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
      "n_at_ceiling",
      "n_at_ceiling_fixed_louder",
      "upper_end_spl",
      "lower_end_spl",
      "flags",
      "left_out_reason"
    ];
    const lines = [header.join(",")];
    const rows = collectSessionPseRows(sess);
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
        r.nAtCeiling,
        r.nAtCeilingFixedLouder,
        Number.isFinite(r.upperEndSpl) ? r.upperEndSpl.toFixed(3) : "",
        Number.isFinite(r.lowerEndSpl) ? r.lowerEndSpl.toFixed(3) : "",
        r.flags.join(";"),
        r.leftOutReason
      ];
      lines.push(vals.map(csvEscape).join(","));
    }
    return lines.join("\n") + "\n";
  }

  function formatTbtCsv(sess) {
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
    for (const t of (sess.tbtRows || [])) {
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

  function formatSesJson(sess, exportedAtIso = null) {
    const fsInfo = computeFullScale1kSpl(sess.calibration);
    const pseRows = collectSessionPseRows(sess).map((r) => ({
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
      n_at_ceiling: r.nAtCeiling,
      n_at_ceiling_fixed_louder: r.nAtCeilingFixedLouder,
      upper_end_spl: r.upperEndSpl,
      lower_end_spl: r.lowerEndSpl,
      flags: r.flags,
      left_out_reason: r.leftOutReason
    }));

    const payload = {
      app_name: "qLDM",
      app_version: sess.appVersion || APP_VERSION,
      exported_at_iso: exportedAtIso || new Date().toISOString(),
      session_created_at_iso: sess.createdAtIso,
      participant_id: sess.participantId,
      ear: sess.ear,
      ear_code: sess.earCode,
      date_ymd: sess.dateYmd,
      settings: sess.settings,
      analog_gain_confirmation: sess.analogGainConfirmation || null,
      audio_path: {
        requested_sample_rate_hz: sess.audioInfo?.requestedSampleRate || DEFAULT_FS,
        granted_sample_rate_hz: sess.audioInfo?.grantedSampleRate || DEFAULT_FS,
        monaural_channel_routing: sess.ear === "Left" ? "Channel 0 (Left) active; Channel 1 silent" : "Channel 1 (Right) active; Channel 0 silent",
        recommended_os_output_format: "24-bit integer or 32-bit float at 48000 Hz, OS enhancements disabled",
        output_devices_detected: sess.audioInfo?.outputDevices || []
      },
      stimulus_definition: {
        reference_spl_db: REF_SPL_DB,
        reference_dbfs_rms_at_60db_spl: fsInfo.refDbfsRms60,
        reference_digital_rms_at_60db_spl: fsInfo.refDigitalRms60,
        nominal_full_scale_1khz_spl_db: fsInfo.fullScale1kSpl,
        analog_gain_above_qcls_db: fsInfo.gainAboveQclsDb,
        component_spacing: "5 equal-amplitude geometric components f_c * 2^(m * bw_oct / 4), m in [-2, -1, 0, 1, 2], matching nea_gen_5tc.m",
        component_start_phases_rad: [0, 0, 0, 0, 0],
        component_start_phase_convention: "sine phase (0 rad at t = 0 onset)",
        complexes_hz: {
          "1000Hz_1oct": getComplexComponentFreqs(1000, 1.0),
          "4000Hz_1oct": getComplexComponentFreqs(4000, 1.0),
          "1000Hz_0.25oct": getComplexComponentFreqs(1000, 0.25),
          "4000Hz_0.25oct": getComplexComponentFreqs(4000, 0.25)
        },
        duration_ms: sess.settings?.durationMs ?? 500,
        raised_cosine_ramp_ms: sess.settings?.rampMs ?? 20,
        inter_interval_gap_ms: sess.settings?.gapMs ?? 400,
        post_response_iti_ms: sess.settings?.itiMs ?? 300
      },
      adaptive_and_estimator: {
        rule: "1-up, 1-down two-track interleaved staircase (+10 dB upper, -10 dB lower; 4 dB step until first reversal, 2 dB thereafter)",
        trials_per_track: sess.settings?.trialsPerTrack ?? 8,
        varied_offset_bounds_db: [-VARIED_OFFSET_LIM_DB, VARIED_OFFSET_LIM_DB],
        estimator: "Block maximum-likelihood logistic fit with shared slope sigma per frequency block and fixed lapse = 0.02",
        ceiling_flags_and_bounds: "AT_CEILING marks >=3 consecutive trials at ceilingSpl (separate from AT_LIMIT_3_CONSEC for +/-20 dB range/floor); n_at_ceiling and n_at_ceiling_fixed_louder record bound counts.",
        se_note: "Curvature-based SE underestimates true match SD by ~25% at 16 trials/match; NEA inversion uses empirical pilot test-retest SD."
      },
      calibration: {
        ...sess.calibration,
        refDbfsRms60: fsInfo.refDbfsRms60,
        fullScale1kSpl: fsInfo.fullScale1kSpl,
        gainAboveQclsDb: fsInfo.gainAboveQclsDb
      },
      level_limits: {
        initial_max_output_spl: sess.settings?.initialMaxOutputSpl ?? 100,
        final_ceiling_spl: sess.ceilingSpl,
        equipment_max_spl: EQUIPMENT_MAX_SPL,
        listener_limits: sess.settings?.limits || {},
        qcls_contour_file: sess.settings?.qclsSourceFile || null,
        too_loud_events: sess.tooLoudEvents || []
      },
      practice_summary: sess.practice || null,
      pse_summary: pseRows
    };

    return JSON.stringify(payload, null, 2) + "\n";
  }

  /*
   * Normalize a stored calibration record (Follow-up 2):
   * Any stored calibration object lacking `refDbfsRms60` (or belonging to a session
   * saved by v1.0.0) was measured at -70.0 dBFS RMS @ 60 dB SPL and must retain
   * -70.0 dBFS rather than inheriting the -60.0 dBFS default for new calibrations.
   */
  function normalizeCalibrationRecord(parsed, sessionAppVersion = null) {
    if (!parsed || typeof parsed !== "object" || !parsed.offsetsDb || typeof parsed.offsetsDb !== "object") {
      return null;
    }
    const isV1 = String(sessionAppVersion || "") === "1.0.0" || !hasExplicitRefField(parsed);
    const refDbfsRms60 = isV1 ? LEGACY_V1_REF_DBFS_60DB : clampRefDbfs60(parsed.refDbfsRms60);
    const baseOffsets = { ...parsed.offsetsDb };
    const perEarEnabled = Boolean(parsed.perEarEnabled);
    let offsetsByEar = undefined;
    if (parsed.offsetsByEar && typeof parsed.offsetsByEar === "object") {
      offsetsByEar = {
        Left: parsed.offsetsByEar.Left && typeof parsed.offsetsByEar.Left === "object"
          ? { ...parsed.offsetsByEar.Left }
          : { ...baseOffsets },
        Right: parsed.offsetsByEar.Right && typeof parsed.offsetsByEar.Right === "object"
          ? { ...parsed.offsetsByEar.Right }
          : { ...baseOffsets }
      };
    } else if (perEarEnabled) {
      offsetsByEar = {
        Left: { ...baseOffsets },
        Right: { ...baseOffsets }
      };
    }
    return {
      ...parsed,
      id: parsed.id || "custom",
      name: parsed.name || "Custom Transducer",
      couplerVerified: Boolean(parsed.couplerVerified),
      date: parsed.date || "LegacyV1",
      refDbfsRms60,
      perEarEnabled,
      ...(offsetsByEar ? { offsetsByEar } : {}),
      offsetsDb: baseOffsets
    };
  }

  /*
   * Export & Import Coupler Calibration JSON (protects measured 18-frequency coupler
   * tables across browser storage clears, private tabs, or booth hardware backups).
   */
  function formatCalibrationJson(calTable, exportedAtIso = null) {
    const norm = normalizeCalibrationRecord(calTable, APP_VERSION) || {
      ...TRANSDUCER_PRESETS.er3a_nominal,
      offsetsDb: { ...TRANSDUCER_PRESETS.er3a_nominal.offsetsDb }
    };
    const fsInfo = computeFullScale1kSpl(norm);
    const payload = {
      schema: "qLDM_calibration_v2",
      app_name: "qLDM",
      app_version: APP_VERSION,
      exported_at_iso: exportedAtIso || new Date().toISOString(),
      calibration: {
        id: norm.id || "custom",
        name: norm.name || "Custom Transducer",
        couplerVerified: Boolean(norm.couplerVerified),
        date: norm.date || "Reference",
        refDbfsRms60: fsInfo.refDbfsRms60,
        fullScale1kSpl: fsInfo.fullScale1kSpl,
        gainAboveQclsDb: fsInfo.gainAboveQclsDb,
        perEarEnabled: Boolean(norm.perEarEnabled),
        ...(norm.offsetsByEar ? { offsetsByEar: norm.offsetsByEar } : {}),
        offsetsDb: { ...norm.offsetsDb }
      }
    };
    return JSON.stringify(payload, null, 2) + "\n";
  }

  function parseImportedCalibrationJson(jsonText) {
    let raw = null;
    try {
      raw = JSON.parse(String(jsonText || ""));
    } catch (_e) {
      return { ok: false, error: "Invalid JSON file." };
    }
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Calibration JSON must be an object." };
    }
    const sessionVer = raw.app_version || raw.appVersion || null;
    const calCandidate = (raw.calibration && typeof raw.calibration === "object") ? raw.calibration : raw;
    const norm = normalizeCalibrationRecord(calCandidate, sessionVer);
    if (!norm) {
      return { ok: false, error: "No valid offsetsDb table found in JSON." };
    }
    const earsToCheck = norm.perEarEnabled ? ["Left", "Right"] : [null];
    for (const ear of earsToCheck) {
      const missing = CALIBRATION_FREQS.filter(f => !Number.isFinite(lookupCalOffsetDb(norm, f, ear)));
      if (missing.length > 0) {
        const earTag = ear ? ` (${ear} ear)` : "";
        return {
          ok: false,
          error: `Missing calibration entries${earTag}: ${missing.map(f => f.toFixed(2) + " Hz").join(", ")}.`
        };
      }
    }
    return { ok: true, calibration: norm };
  }

  /*
   * Parse qCLS Equal-Loudness Contour CSV (qCLS_ELC_*.csv) including filenames with
   * optional _HHMM timestamps or browser duplicate suffixes such as " (1)".
   */
  function parseQclsElcCsv(csvText, filename = "") {
    const lines = String(csvText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return { ok: false, error: "Empty CSV file." };
    }
    let cu5_1k = null, ucl_1k = null, cu5_4k = null, ucl_4k = null;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map(c => c.trim());
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
      return {
        ok: false,
        error: `Could not find 1000/4000 Hz CU 5 / CU 50 rows in ${filename || "CSV"}. Expected qCLS_ELC_*.csv.`
      };
    }

    let participantId = null;
    let ear = null;
    const baseName = String(filename || "").replace(/^.*[\\/]/, "");
    const m = /^qCLS_ELC_(.+?)_([LRB])_(\d{8})(?:_\d{4,6})?(?:\s*\(\d+\))?\.csv$/i.exec(baseName);
    if (m) {
      participantId = m[1];
      const ec = m[2].toUpperCase();
      if (ec === "L") ear = "Left";
      else if (ec === "R") ear = "Right";
    }

    return {
      ok: true,
      cu5_1k,
      ucl_1k,
      cu5_4k,
      ucl_4k,
      participantId,
      ear
    };
  }

  /*
   * Pure two-panel (1000 Hz & 4000 Hz) SVG plot of Delta = Tone PSE - Complex Level (dB)
   * vs. Fixed Level (dB SPL) with +/- Fit SE bars, 0-dB reference, and shaded <= compFlagDb zone.
   */
  function renderResultsSvg(sess) {
    if (!sess) return "";
    const rows = collectSessionPseRows(sess);
    const valid = rows.filter(r => !r.leftOutReason && r.deltaDb !== null && Number.isFinite(r.deltaDb));
    const compFlagDb = Number(sess.settings?.compFlagDb ?? -6.0);

    let yMin = Math.min(-10.0, compFlagDb - 3.0);
    let yMax = 14.0;
    for (const r of valid) {
      const se = Number.isFinite(r.seDb) ? r.seDb : 0.0;
      if (r.deltaDb - se - 1.5 < yMin) yMin = Math.floor((r.deltaDb - se - 1.5) / 2) * 2;
      if (r.deltaDb + se + 1.5 > yMax) yMax = Math.ceil((r.deltaDb + se + 1.5) / 2) * 2;
    }
    yMin = Math.max(-24, yMin);
    yMax = Math.min(26, yMax);

    const W = 760, H = 248;
    const padTop = 32, padBot = 40, padLeft = 48, padRight = 18, midGap = 46;
    const pW = Math.floor((W - padLeft - padRight - midGap) / 2);
    const pH = H - padTop - padBot;
    const xMin = 46.0, xMax = 104.0;

    const mapX = (px0, lvl) => px0 + ((lvl - xMin) / (xMax - xMin)) * pW;
    const mapY = (d) => padTop + ((yMax - d) / (yMax - yMin)) * pH;

    const yTicks = [];
    const yStep = (yMax - yMin) > 28 ? 5 : 4;
    for (let yv = Math.ceil(yMin / yStep) * yStep; yv <= yMax + 1e-6; yv += yStep) {
      yTicks.push(yv);
    }
    if (!yTicks.some(v => Math.abs(v) < 1e-6) && 0 >= yMin && 0 <= yMax) {
      yTicks.push(0);
      yTicks.sort((a, b) => a - b);
    }

    const xTicks = [50, 60, 70, 80, 90, 100];
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; height:auto; display:block; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px;">`
    ];

    CENTER_FREQS_HZ.forEach((fc, pIdx) => {
      const px0 = padLeft + pIdx * (pW + midGap);
      const fcRows = valid.filter(r => r.centerHz === fc);
      const maxPass = fcRows.reduce((m, r) => Math.max(m, r.blockPass || 1), 1);

      /* Panel frame & shaded component-listening region (<= compFlagDb) */
      parts.push(`<rect x="${px0}" y="${padTop}" width="${pW}" height="${pH}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1"/>`);
      if (compFlagDb > yMin) {
        const yCompTop = mapY(Math.min(compFlagDb, yMax));
        const hComp = Math.max(0, (padTop + pH) - yCompTop);
        parts.push(`<rect x="${px0}" y="${yCompTop.toFixed(1)}" width="${pW}" height="${hComp.toFixed(1)}" fill="#fee2e2" opacity="0.55"/>`);
        if (compFlagDb <= yMax) {
          parts.push(`<line x1="${px0}" y1="${yCompTop.toFixed(1)}" x2="${px0 + pW}" y2="${yCompTop.toFixed(1)}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4,3"/>`);
        }
      }

      /* Gridlines & ticks */
      for (const yt of yTicks) {
        const yy = mapY(yt);
        const isZero = Math.abs(yt) < 1e-6;
        parts.push(`<line x1="${px0}" y1="${yy.toFixed(1)}" x2="${px0 + pW}" y2="${yy.toFixed(1)}" stroke="${isZero ? "#64748b" : "#e2e8f0"}" stroke-width="${isZero ? "1.3" : "0.8"}" ${isZero ? 'stroke-dasharray="5,3"' : ""}/>`);
        if (pIdx === 0) {
          const lbl = yt > 0 ? `+${yt}` : `${yt}`;
          parts.push(`<text x="${(px0 - 6).toFixed(1)}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-family="system-ui,sans-serif" font-size="10.5" fill="#475569">${lbl}</text>`);
        }
      }
      for (const xt of xTicks) {
        const xx = mapX(px0, xt);
        parts.push(`<line x1="${xx.toFixed(1)}" y1="${padTop}" x2="${xx.toFixed(1)}" y2="${padTop + pH}" stroke="#e2e8f0" stroke-width="0.7"/>`);
        parts.push(`<text x="${xx.toFixed(1)}" y="${padTop + pH + 14}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" fill="#475569">${xt}</text>`);
      }

      /* Panel title & axis labels */
      const passNote = maxPass > 1 ? ` (Pass ${maxPass} solid)` : "";
      parts.push(`<text x="${(px0 + pW / 2).toFixed(1)}" y="20" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5" font-weight="700" fill="#0f172a">${fc === 1000 ? "1 kHz" : "4 kHz"} Block${passNote}</text>`);
      parts.push(`<text x="${(px0 + pW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#334155">Fixed Level (dB SPL)</text>`);

      /* Group series by (blockPass, role, bandwidthOct) */
      const seriesDefs = [
        { role: "forward", bw: 1.0, color: "#1d4ed8", dash: "" },
        { role: "forward", bw: 0.25, color: "#0d9488", dash: "4,2" },
        { role: "reverse", bw: 1.0, color: "#7c3aed", dash: "2,2" },
        { role: "reverse", bw: 0.25, color: "#9333ea", dash: "2,2" },
        { role: "null", bw: 0.0, color: "#64748b", dash: "3,3" }
      ];

      for (let pass = 1; pass <= maxPass; pass++) {
        const isOldPass = pass < maxPass;
        const opacity = isOldPass ? "0.35" : "1.0";
        for (const sd of seriesDefs) {
          const pts = fcRows
            .filter(r => (r.blockPass || 1) === pass && r.role === sd.role && Math.abs((r.bandwidthOct || 0) - sd.bw) < 0.01)
            .sort((a, b) => a.fixedLevelSpl - b.fixedLevelSpl);
          if (pts.length === 0) continue;

          if (pts.length >= 2) {
            const dPath = pts
              .map((p, idx) => `${idx === 0 ? "M" : "L"}${mapX(px0, p.fixedLevelSpl).toFixed(1)},${mapY(p.deltaDb).toFixed(1)}`)
              .join(" ");
            const dashAttr = isOldPass ? 'stroke-dasharray="2,3"' : (sd.dash ? `stroke-dasharray="${sd.dash}"` : "");
            parts.push(`<path d="${dPath}" fill="none" stroke="${sd.color}" stroke-width="${isOldPass ? "1.3" : "2.0"}" opacity="${opacity}" ${dashAttr}/>`);
          }

          for (const p of pts) {
            const cx = mapX(px0, p.fixedLevelSpl);
            const cy = mapY(p.deltaDb);
            const se = Number.isFinite(p.seDb) ? p.seDb : 0.0;
            if (se > 0 && !isOldPass) {
              const yLo = mapY(Math.max(yMin, p.deltaDb - se));
              const yHi = mapY(Math.min(yMax, p.deltaDb + se));
              parts.push(`<line x1="${cx.toFixed(1)}" y1="${yHi.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yLo.toFixed(1)}" stroke="${sd.color}" stroke-width="1.3" opacity="0.75"/>`);
              parts.push(`<line x1="${(cx - 3).toFixed(1)}" y1="${yHi.toFixed(1)}" x2="${(cx + 3).toFixed(1)}" y2="${yHi.toFixed(1)}" stroke="${sd.color}" stroke-width="1.3" opacity="0.75"/>`);
              parts.push(`<line x1="${(cx - 3).toFixed(1)}" y1="${yLo.toFixed(1)}" x2="${(cx + 3).toFixed(1)}" y2="${yLo.toFixed(1)}" stroke="${sd.color}" stroke-width="1.3" opacity="0.75"/>`);
            }
            const atCeil = Array.isArray(p.flags) && p.flags.includes("AT_CEILING");
            parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${atCeil ? "4.6" : "3.8"}" fill="${atCeil ? "#f59e0b" : sd.color}" stroke="#ffffff" stroke-width="1.1" opacity="${opacity}"/>`);
          }
        }
      }

      if (fcRows.length === 0) {
        parts.push(`<text x="${(px0 + pW / 2).toFixed(1)}" y="${(padTop + pH / 2).toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#94a3b8">No active matches</text>`);
      }
    });

    /* Y-axis label + legend strip */
    const yMid = padTop + pH / 2;
    parts.push(`<text x="14" y="${yMid.toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#334155" transform="rotate(-90 14 ${yMid.toFixed(1)})">Δ = Tone PSE − Complex (dB)</text>`);
    parts.push(`<text x="${W - padRight}" y="14" text-anchor="end" font-family="system-ui,sans-serif" font-size="10" fill="#64748b">Blue: 1-oct • Teal: 1/4-oct • Amber dot: AT_CEILING • Red zone: ≤ ${compFlagDb.toFixed(1)} dB</text>`);
    parts.push(`</svg>`);
    return parts.join("");
  }

  /*
   * Normalize a resumed or loaded session record (Follow-up 2):
   * Ensures a session saved under v1.0.0 (or lacking `calibration.refDbfsRms60`)
   * retains -70.0 dBFS RMS @ 60 dB SPL for playback, UI display, and JSON export.
   */
  function normalizeSessionRecord(saved) {
    if (!saved || typeof saved !== "object") return null;
    const normCal =
      normalizeCalibrationRecord(saved.calibration, saved.appVersion) || {
        ...TRANSDUCER_PRESETS.er3a_nominal,
        refDbfsRms60: String(saved.appVersion || "") === "1.0.0" ? LEGACY_V1_REF_DBFS_60DB : DEFAULT_REF_DBFS_60DB,
        offsetsDb: { ...TRANSDUCER_PRESETS.er3a_nominal.offsetsDb }
      };
    const fsInfo = computeFullScale1kSpl(normCal, null, saved.ear || null);
    return {
      ...saved,
      calibration: {
        ...normCal,
        refDbfsRms60: fsInfo.refDbfsRms60,
        fullScale1kSpl: fsInfo.fullScale1kSpl,
        gainAboveQclsDb: fsInfo.gainAboveQclsDb
      }
    };
  }

  const api = {
    APP_VERSION,
    DEFAULT_FS,
    REF_SPL_DB,
    DEFAULT_REF_DBFS_60DB,
    LEGACY_V1_REF_DBFS_60DB,
    MIN_REF_DBFS_60DB,
    MAX_REF_DBFS_60DB,
    QCLS_REF_DBFS_60DB,
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
    clampRefDbfs60,
    resolveRefDbfs60,
    resolveRefDigitalRms60,
    resolveCalForEar,
    computeFullScale1kSpl,
    generateRandomSeed,
    normalizeCalibrationRecord,
    normalizeSessionRecord,
    formatCalibrationJson,
    parseImportedCalibrationJson,
    parseQclsElcCsv,
    renderResultsSvg,
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
    runSimulatedBlock,
    applyTooLoudToSession,
    collectSessionPseRows,
    formatPseCsv,
    formatTbtCsv,
    formatSesJson
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.QLDMCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
