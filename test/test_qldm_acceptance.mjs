#!/usr/bin/env node
/**
 * test_qldm_acceptance.mjs
 *
 * Headless acceptance test suite for qldm_core.js verifying all requirements of
 * LOUDNESS_MATCHING_APP_SPEC.md (Section 9) and LOUDNESS_MATCHING_APP_ADVICE.md
 * (Sections 3, 6, 7, 9), including direct trial-for-trial parity against
 * lm_track_sim.py (scipy L-BFGS-B) to < 0.01 dB.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const QLDM = require(path.join(__dirname, "..", "qldm_core.js"));

console.log("=== qLDM Headless Acceptance Suite ===\n");

/* -------------------------------------------------------------------------
 * 1. Stimulus Verification (Spec Section 3 & Advice Section 9.1)
 * ------------------------------------------------------------------------- */
const expectedRoundedFreqs = {
  "1000_1":    [707, 841, 1000, 1189, 1414],
  "4000_1":    [2828, 3364, 4000, 4757, 5657],
  "1000_0.25": [917, 958, 1000, 1044, 1091],
  "4000_0.25": [3668, 3830, 4000, 4177, 4362]
};

for (const [key, expArr] of Object.entries(expectedRoundedFreqs)) {
  const [fcStr, bwStr] = key.split("_");
  const fc = Number(fcStr), bw = Number(bwStr);
  const got = QLDM.getComplexComponentFreqs(fc, bw).map(f => Math.round(f));
  assert.deepEqual(got, expArr, `Component freq mismatch for ${key}`);

  const w = QLDM.generateSoundWaveform({
    centerHz: fc,
    sound: { kind: "complex", bwOct: bw },
    levelSpl: 80.0,
    sampleRate: 48000,
    durationMs: 500,
    rampMs: 20,
    calTable: QLDM.TRANSDUCER_PRESETS.flat_ref,
    ceilingSpl: 100.0
  });
  assert.equal(w.ok, true, `Stimulus generation failed for ${key}: ${w.reason}`);

  /* Nominal RMS check (within 0.01 dB of nominal) */
  const expectedDigitalRms = QLDM.REF_DIGITAL_RMS_60DB * Math.pow(10.0, (80.0 - 60.0) / 20.0);
  const rmsErrDb = Math.abs(20.0 * Math.log10(w.unrampedDigitalRms / expectedDigitalRms));
  assert.ok(rmsErrDb < 0.01, `RMS error ${rmsErrDb.toFixed(5)} dB >= 0.01 dB for ${key}`);

  /* Crest factor 2.95 to 3.15 */
  assert.ok(
    w.crestFactorRaw >= 2.945 && w.crestFactorRaw <= 3.155,
    `Crest factor ${w.crestFactorRaw.toFixed(4)} outside [2.95, 3.15] for ${key}`
  );
  /* Sine start phase => first sample at t=0 is 0 */
  assert.equal(w.samples[0], 0.0, "Onset sample at t=0 must be 0 (sine phase + cosine ramp)");

  console.log(
    `[PASS Stimuli] fc=${fc} Hz, bw=${bw} oct -> freqs=[${got.join(", ")}] Hz | ` +
    `RMS err=${rmsErrDb.toFixed(5)} dB | CF=${w.crestFactorRaw.toFixed(3)}`
  );
}

/* -------------------------------------------------------------------------
 * 2. Direct Parity Against lm_track_sim.py fit_block (Advice Section 7: <=0.01 dB)
 * ------------------------------------------------------------------------- */
const lmSimDir = process.env.LM_SIM_DIR || path.resolve(__dirname, "../../../../nea/neural-ensemble-averaging");
if (fs.existsSync(path.join(lmSimDir, "lm_track_sim.py"))) {
  const pyScript = `
import json, sys
import numpy as np
sys.path.insert(0, ${JSON.stringify(lmSimDir)})
import lm_track_sim as lms

rng = np.random.default_rng(20261120)
M = 6; n = 8; s = 4.0 / lms.K
nb = 250
mu = rng.uniform(-10.0, 6.0, (nb, M))
XU = np.empty((nb, M, n)); YU = np.empty((nb, M, n), bool)
XL = np.empty((nb, M, n)); YL = np.empty((nb, M, n), bool)
for m in range(M):
    X, Y = lms.sim_track(rng, nb, mu[:, m], s, 0.02, 'S', True, n, 10.0); XU[:, m] = X.T; YU[:, m] = Y.T
    X, Y = lms.sim_track(rng, nb, mu[:, m], s, 0.02, 'S', False, n, 10.0); XL[:, m] = X.T; YL[:, m] = Y.T

cases = []
for b in range(nb):
    xs = np.concatenate([XU[b], XL[b]], 1)
    ys = np.concatenate([YU[b], YL[b]], 1)
    est, se, sg, sls, atb = lms.fit_block(xs, ys)
    cases.append({
        "xs": xs.tolist(),
        "ys": ys.tolist(),
        "est": est.tolist(),
        "se": se.tolist(),
        "sigma": float(sg),
        "atb": bool(atb)
    })
print(json.dumps(cases))
`;
  const useArm64Arch = process.platform === "darwin" && process.arch === "x64" && fs.existsSync("/usr/bin/arch");
  const rawJson = useArm64Arch
    ? execFileSync("/usr/bin/arch", ["-arm64", "python3", "-c", pyScript], { maxBuffer: 32 * 1024 * 1024 }).toString()
    : execFileSync("python3", ["-c", pyScript], { maxBuffer: 32 * 1024 * 1024 }).toString();
  const pyCases = JSON.parse(rawJson);

  let maxMuDiff = 0.0;
  let maxSeDiff = 0.0;
  let maxSigDiff = 0.0;
  for (const c of pyCases) {
    const jsFit = QLDM.fitBlockML(c.xs, c.ys);
    for (let m = 0; m < c.est.length; m++) {
      const dm = Math.abs(jsFit.midpoints[m] - c.est[m]);
      const ds = Math.abs(jsFit.ses[m] - c.se[m]);
      if (dm > maxMuDiff) maxMuDiff = dm;
      if (ds > maxSeDiff) maxSeDiff = ds;
    }
    const dsg = Math.abs(jsFit.sigma - c.sigma);
    if (dsg > maxSigDiff) maxSigDiff = dsg;
  }
  console.log(
    `\n[PASS Python Parity (250 blocks / 1500 matches vs. lm_track_sim.py)] ` +
    `max |mu_JS - mu_Py| = ${maxMuDiff.toExponential(3)} dB | ` +
    `max |SE_JS - SE_Py| = ${maxSeDiff.toExponential(3)} dB | ` +
    `max |sigma_JS - sigma_Py| = ${maxSigDiff.toExponential(3)} dB`
  );
  assert.ok(maxMuDiff < 0.01, `Max midpoint diff ${maxMuDiff} >= 0.01 dB`);
  assert.ok(maxSeDiff < 0.01, `Max SE diff ${maxSeDiff} >= 0.01 dB`);
}

/* -------------------------------------------------------------------------
 * 3. Simulated-Listener Monte Carlo (Advice Section 9.2)
 *    sigma = 2.5 -> SD ~1.0 dB; sigma = 4.0 -> SD ~1.5 dB & ~7% apart-flag;
 *    sigma = 6.0 -> SD ~2.2 dB; all biases |bias| < 0.5 dB
 * ------------------------------------------------------------------------- */
console.log("");
for (const [sigma, expSd] of [[2.5, 1.0], [4.0, 1.5], [6.0, 2.2]]) {
  const rng = QLDM.createRng(20261120 + Math.round(sigma * 10));
  const nBlocks = 1500;
  const errs = [];
  let apartCount = 0;
  let totMatches = 0;

  for (let b = 0; b < nBlocks; b++) {
    const { trueDeltas, evalRes } = QLDM.runSimulatedBlock(rng, {
      matchesPerBlock: 6,
      trialsPerTrack: 8,
      sigma,
      startOffsetDb: 10.0,
      lapse: 0.02
    });
    evalRes.rows.forEach((r, m) => {
      errs.push(r.deltaDb - trueDeltas[m]);
      if (r.flags.includes("TRACKS_APART_GT_6DB")) apartCount++;
      totMatches++;
    });
  }
  const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
  const sd = Math.sqrt(errs.reduce((a, e) => a + (e - bias) * (e - bias), 0) / errs.length);
  const apartPct = (100.0 * apartCount) / totMatches;

  console.log(
    `[PASS Monte Carlo] sigma=${sigma.toFixed(1)} dB (${nBlocks} blocks, 16 trials/match): ` +
    `bias=${bias >= 0 ? "+" : ""}${bias.toFixed(3)} dB, SD=${sd.toFixed(2)} dB (target ~${expSd.toFixed(1)} dB), ` +
    `apart_flag=${apartPct.toFixed(1)}%`
  );
  assert.ok(Math.abs(bias) < 0.5, `Bias ${bias} exceeded 0.5 dB`);
  assert.ok(Math.abs(sd - expSd) < 0.20, `SD ${sd} differed from ${expSd} by >= 0.20 dB`);
  if (sigma === 4.0) {
    assert.ok(apartPct >= 5.0 && apartPct <= 9.5, `Apart flag rate ${apartPct}% outside expected ~7% range`);
  }
}

/* -------------------------------------------------------------------------
 * 4. Digital Reference (-60 dBFS default, -70..-50 range), Full-Scale 1 kHz,
 *    30 dB SPL Low-Level Tone, & No Clipping Across Sets (Follow-up §1)
 * ------------------------------------------------------------------------- */
assert.equal(QLDM.DEFAULT_REF_DBFS_60DB, -60.0);
assert.equal(QLDM.clampRefDbfs60(-80), -70.0);
assert.equal(QLDM.clampRefDbfs60(-40), -50.0);

const fs60 = QLDM.computeFullScale1kSpl(QLDM.TRANSDUCER_PRESETS.er3a_nominal);
assert.equal(fs60.refDbfsRms60, -60.0);
assert.equal(fs60.gainAboveQclsDb, 20.0);
assert.equal(fs60.fullScale1kSpl, 116.9);

const fs70 = QLDM.computeFullScale1kSpl({ ...QLDM.TRANSDUCER_PRESETS.er3a_nominal, refDbfsRms60: -70.0 });
assert.equal(fs70.gainAboveQclsDb, 30.0);
assert.equal(fs70.fullScale1kSpl, 126.9);

/* 30 dB SPL pure tone at -60 dBFS should synthesize cleanly with peak ~1.46 16-bit steps */
const lowTone30 = QLDM.generateSoundWaveform({
  centerHz: 1000,
  sound: QLDM.SOUND_TONE,
  levelSpl: 30.0,
  calTable: QLDM.TRANSDUCER_PRESETS.flat_ref,
  ceilingSpl: 100.0
});
assert.equal(lowTone30.ok, true);
const steps16Bit = lowTone30.peak * 32768.0;
assert.ok(steps16Bit > 1.4 && steps16Bit < 1.55, `Expected ~1.46 16-bit steps at 30 dB/-60 dBFS, got ${steps16Bit}`);
console.log(
  `\n[PASS Digital Ref] Default -60.0 dBFS => 1 kHz 0 dBFS = ${fs60.fullScale1kSpl} dB SPL (+${fs60.gainAboveQclsDb} dB re qCLS), ` +
  `30 dB tone peak = ${steps16Bit.toFixed(2)} 16-bit steps`
);

for (const preset of [QLDM.TRANSDUCER_PRESETS.er3a_nominal, QLDM.TRANSDUCER_PRESETS.flat_ref]) {
  const headroom = QLDM.computeMaxUnclippedLevels(preset, { durationMs: 500, rampMs: 20 });
  const minMaxSpl = Math.min(...headroom.map(h => h.maxUnclippedSpl));
  console.log(`[PASS Headroom @ -60 dBFS: ${preset.id}] Lowest max-unclipped ceiling across all 6 stimuli = ${minMaxSpl.toFixed(1)} dB SPL (> 100 dB SPL)`);
  assert.ok(minMaxSpl >= 102.0, `Expected >= 102.0 dB SPL unclipped ceiling at -60 dBFS, got ${minMaxSpl}`);

  const extMatches = QLDM.buildMatchTable({ matchSet: "extended", includeNullMatches: true, includeReverseMatches: true });
  for (const m of extMatches) {
    for (const vSpl of [30, 50, 80, 100]) {
      const tb = QLDM.buildTwoIntervalBuffer({
        centerHz: m.centerHz,
        sound1: m.fixedSound,
        level1Spl: m.fixedLevelSpl,
        sound2: m.variedSound,
        level2Spl: vSpl,
        calTable: preset,
        ceilingSpl: 100.0
      });
      assert.equal(tb.ok, true, `Unexpected failure at ${m.id}, vSpl=${vSpl}: ${tb.reason}`);
      assert.ok(tb.peak1 <= 1.0 && tb.peak2 <= 1.0, "Peak exceeded 1.0 full scale!");
    }
  }
}

/* -------------------------------------------------------------------------
 * 5. Safety Guard: Clipping, Ceiling, NaN, & Missing Calibration Entry (Follow-up §4)
 * ------------------------------------------------------------------------- */
const clipRes = QLDM.generateSoundWaveform({
  centerHz: 4000,
  sound: QLDM.SOUND_1OCT,
  levelSpl: 115.0,
  calTable: QLDM.TRANSDUCER_PRESETS.er3a_nominal,
  ceilingSpl: 130.0
});
assert.equal(clipRes.ok, false);
assert.equal(clipRes.reason, "DIGITAL_CLIP_PREVENTED");

const ceilRes = QLDM.generateSoundWaveform({
  centerHz: 1000,
  sound: QLDM.SOUND_TONE,
  levelSpl: 96.0,
  calTable: QLDM.TRANSDUCER_PRESETS.flat_ref,
  ceilingSpl: 90.0
});
assert.equal(ceilRes.ok, false);
assert.equal(ceilRes.reason, "CEILING_EXCEEDED_BY_BUFFER");

const nanBuf = new Float64Array(100);
nanBuf[42] = NaN;
assert.equal(QLDM.verifyBufferSafety(nanBuf, { sampleRate: 48000, compFreqs: [1000] }).reason, "NAN_OR_INFINITE_SAMPLE");

/* Missing component calibration entry must refuse stimulus (not default to 0 dB) */
const incompleteCal = {
  ...QLDM.TRANSDUCER_PRESETS.er3a_nominal,
  offsetsDb: { ...QLDM.TRANSDUCER_PRESETS.er3a_nominal.offsetsDb }
};
delete incompleteCal.offsetsDb["5656.8542"];
assert.ok(Number.isNaN(QLDM.lookupCalOffsetDb(incompleteCal, 5656.8542)));
const missingCalRes = QLDM.generateSoundWaveform({
  centerHz: 4000,
  sound: QLDM.SOUND_1OCT,
  levelSpl: 70.0,
  calTable: incompleteCal,
  ceilingSpl: 100.0
});
assert.equal(missingCalRes.ok, false);
assert.equal(missingCalRes.reason, "MISSING_CALIBRATION_ENTRY");
console.log(`[PASS Safety Guard] Verified refusal of DIGITAL_CLIP_PREVENTED, CEILING_EXCEEDED_BY_BUFFER, NAN_OR_INFINITE_SAMPLE, and MISSING_CALIBRATION_ENTRY.`);

/* -------------------------------------------------------------------------
 * 6. AT_CEILING vs. AT_LIMIT_3_CONSEC & Upper-Track Start Clamp (Follow-up 1 & 3)
 * ------------------------------------------------------------------------- */
const std1k = QLDM.buildMatchTable({ matchSet: "standard" }).filter(m => m.centerHz === 1000);
assert.deepEqual(std1k.map(m => m.fixedLevelSpl), [60, 70, 80, 85, 90, 95]);

/* Upper track starts at ceiling (100 dB) for both T-5 (90 dB) and T (95 dB, +5 dB above complex) */
const m90 = std1k.find(m => m.fixedLevelSpl === 90);
const m95 = std1k.find(m => m.fixedLevelSpl === 95);
const uStart90 = QLDM.createTrackState(m90, "upper", { trialsPerTrack: 8, ceilingSpl: 100.0 });
const uStart95 = QLDM.createTrackState(m95, "upper", { trialsPerTrack: 8, ceilingSpl: 100.0 });
assert.equal(uStart90.curVariedSpl, 100.0, "Upper track for T-5 (90 dB) must start at ceiling (100 dB)");
assert.equal(uStart95.curVariedSpl, 100.0, "Upper track for T (95 dB) must start clamped at ceiling (100 dB = +5 dB)");
QLDM.stepTrack(uStart95, true, 100.0);
assert.equal(uStart95.hitCeilingFlags[0], true, "Clamped start trial at ceiling must count as a trial at the ceiling");

const capPairs = std1k.map(m => {
  const u = QLDM.createTrackState(m, "upper", { trialsPerTrack: 8, ceilingSpl: 100.0 });
  const l = QLDM.createTrackState(m, "lower", { trialsPerTrack: 8, ceilingSpl: 100.0 });
  for (let i = 0; i < 8; i++) {
    if (m.fixedLevelSpl === 95) {
      /* Listener always judges 95 dB complex louder than capped 100 dB tone -> hits ceiling */
      QLDM.stepTrack(u, false, 100.0);
      QLDM.stepTrack(l, false, 100.0);
    } else if (m.fixedLevelSpl === 60) {
      /* Listener always judges 60 dB complex louder -> hits +20 dB range limit at 80 dB (< 100 ceiling) */
      QLDM.stepTrack(u, false, 100.0);
      QLDM.stepTrack(l, false, 100.0);
    } else {
      QLDM.stepTrack(u, u.curVariedSpl > m.fixedLevelSpl, 100.0);
      QLDM.stepTrack(l, l.curVariedSpl > m.fixedLevelSpl, 100.0);
    }
  }
  return { upper: u, lower: l };
});
const capEval = QLDM.evaluateBlockMatches(std1k, capPairs, { componentFlagThresholdDb: -6.0 });
const row95 = capEval.rows.find(r => r.fixedLevelSpl === 95);
const row60 = capEval.rows.find(r => r.fixedLevelSpl === 60);
assert.ok(row95.flags.includes("AT_CEILING"), "95 dB match capped at 100 dB ceiling should carry AT_CEILING");
assert.ok(!row95.flags.includes("AT_LIMIT_3_CONSEC"), "95 dB match at ceiling should not carry AT_LIMIT_3_CONSEC");
assert.ok(row95.nAtCeiling >= 10 && row95.nAtCeilingFixedLouder === row95.nAtCeiling);
assert.ok(row60.flags.includes("AT_LIMIT_3_CONSEC"), "60 dB match hitting 80 dB (+20 range) should carry AT_LIMIT_3_CONSEC");
assert.ok(!row60.flags.includes("AT_CEILING"), "60 dB match at 80 dB should not carry AT_CEILING");
assert.equal(row60.nAtCeiling, 0);
console.log(
  `[PASS Ceiling Bounds] 95 dB match (ceil 100): flags=[${row95.flags.join(",")}], n_at_ceiling=${row95.nAtCeiling}, ` +
  `fixed_louder=${row95.nAtCeilingFixedLouder} | 60 dB (+20 range): flags=[${row60.flags.join(",")}]`
);

/* -------------------------------------------------------------------------
 * 7. Component-Listening Flag on Extended Set (Follow-up §3):
 *    1-octave matches at -7 dB, 1/4-octave matches at -1 dB => flag fires & marks ONLY 1-octave
 * ------------------------------------------------------------------------- */
const ext1k = QLDM.buildMatchTable({ matchSet: "extended" }).filter(m => m.centerHz === 1000);
const extCompPairs = ext1k.map(m => {
  const targetDelta = m.fixedSound.bwOct === 1.0 ? -7.0 : -1.0;
  const u = QLDM.createTrackState(m, "upper", { trialsPerTrack: 8, ceilingSpl: 100.0 });
  const l = QLDM.createTrackState(m, "lower", { trialsPerTrack: 8, ceilingSpl: 100.0 });
  for (let i = 0; i < 8; i++) {
    QLDM.stepTrack(u, u.curVariedSpl > m.fixedLevelSpl + targetDelta, 100.0);
    QLDM.stepTrack(l, l.curVariedSpl > m.fixedLevelSpl + targetDelta, 100.0);
  }
  return { upper: u, lower: l };
});
const extCompEval = QLDM.evaluateBlockMatches(ext1k, extCompPairs, { componentFlagThresholdDb: -6.0 });
assert.equal(extCompEval.componentMatchFlag, true, "Extended-set component flag must fire when 1-oct matches are at -7 dB and 1/4-oct at -1 dB");
for (const r of extCompEval.rows) {
  if (r.fixedSound.bwOct === 1.0) {
    assert.ok(r.flags.includes("COMPONENT_MATCH_SUSPECTED"), `Expected 1-oct row ${r.id} marked COMPONENT_MATCH_SUSPECTED`);
  } else {
    assert.ok(!r.flags.includes("COMPONENT_MATCH_SUSPECTED"), `Quarter-oct row ${r.id} must NOT be marked COMPONENT_MATCH_SUSPECTED`);
  }
}
console.log(`[PASS Extended Component Flag] 1-oct (-7 dB) flagged & marked; 1/4-oct (-1 dB) unmarked.`);

/* -------------------------------------------------------------------------
 * 8. Headless Exercise of "Too Loud" Flow, Reload Recovery, & CSV/JSON Exports
 * ------------------------------------------------------------------------- */
function makeMockSession(seed, matchSetOverride = "short4", limitsOverride = null) {
  const rngLocal = QLDM.createRng(seed);
  const settings = {
    matchSet: matchSetOverride,
    durationMs: 500,
    rampMs: 20,
    gapMs: 400,
    itiMs: 300,
    trialsPerTrack: 8,
    initialMaxOutputSpl: 100,
    compFlagDb: -6.0,
    initialSeed: seed,
    limits: limitsOverride || { cu5_1k: 25, ucl_1k: null, cu5_4k: 35, ucl_4k: null }
  };
  const b1 = QLDM.createSessionBlockState(1000, 1, settings);
  const b2 = QLDM.createSessionBlockState(4000, 1, settings);
  b1.started = true;
  return {
    rngLocal,
    sess: {
      sessionId: "TEST_SES",
      appVersion: QLDM.APP_VERSION,
      createdAtIso: "2026-11-20T15:00:00Z",
      dateYmd: "20261120",
      participantId: "SUBJ_TEST",
      ear: "Right",
      earCode: "R",
      settings,
      analogGainConfirmation: {
        confirmed: true,
        confirmed_at_iso: "2026-11-20T15:00:00Z",
        ref_dbfs_rms_at_60db_spl: -60.0,
        analog_gain_above_qcls_db: 20.0,
        full_scale_1khz_spl_db: 116.9
      },
      audioInfo: { requestedSampleRate: 48000, grantedSampleRate: 48000, outputDevices: ["Coupler Test DAC"] },
      calibration: { ...QLDM.TRANSDUCER_PRESETS.er3a_nominal },
      rngState: rngLocal.getState(),
      ceilingSpl: b1.ceilingSpl,
      tooLoudEvents: [],
      blocks: [b1, b2],
      activeBlockArrayIndex: 0,
      phase: "block",
      tbtRows: []
    }
  };
}

/* 8a. Reload recovery equivalence: run halfway, serialize/deserialize JSON + RNG state, finish */
const runContinuous = makeMockSession(999111);
const runReloaded = makeMockSession(999111);

function stepMockSessionOnce(sess, rngInst) {
  const blk = sess.blocks[sess.activeBlockArrayIndex];
  blk.started = true;
  sess.ceilingSpl = blk.ceilingSpl;
  const active = [];
  blk.pairs.forEach(p => {
    if (p.upper && !p.upper.finished) active.push(p.upper);
    if (p.lower && !p.lower.finished) active.push(p.lower);
  });
  if (active.length === 0) {
    blk.completed = true;
    blk.evalSummary = QLDM.evaluateBlockMatches(blk.matches, blk.pairs, { componentFlagThresholdDb: -6.0 });
    sess.activeBlockArrayIndex += 1;
    return sess.activeBlockArrayIndex < sess.blocks.length;
  }
  const tr = active[Math.floor(rngInst.next() * active.length)];
  const vInt = rngInst.next() < 0.5 ? 1 : 2;
  const resp = rngInst.next() < 0.5;
  sess.rngState = rngInst.getState();
  QLDM.stepTrack(tr, resp, blk.ceilingSpl);
  blk.trialsInBlockCompleted += 1;
  sess.tbtRows.push({
    phase: "block", blockPass: 1, blockHz: blk.centerHz, matchId: tr.matchId, role: tr.role,
    trackId: tr.trackId, trackSlot: tr.slotLabel, trialInBlock: blk.trialsInBlockCompleted,
    trialInTrack: tr.trialsCompleted, centerHz: tr.centerHz, bandwidthOct: 1.0,
    fixedSound: "5tc_1oct", variedSound: "tone", fixedLevelSpl: tr.fixedLevelSpl,
    variedLevelSpl: tr.variedLevelsSpl[tr.variedLevelsSpl.length - 1], variedInterval: vInt,
    interval1Sound: vInt === 1 ? "tone" : "5tc_1oct", interval1Spl: 60,
    interval2Sound: vInt === 2 ? "tone" : "5tc_1oct", interval2Spl: 60,
    responseInterval: resp ? vInt : (vInt === 1 ? 2 : 1), variedJudgedLouder: resp ? 1 : 0,
    tooLoud: 0, rtMs: 420, ceilingSpl: blk.ceilingSpl, guardStatus: "OK"
  });
  return true;
}

while (stepMockSessionOnce(runContinuous.sess, runContinuous.rngLocal)) { /* run to completion */ }
for (let step = 0; step < 20; step++) stepMockSessionOnce(runReloaded.sess, runReloaded.rngLocal);
/* Simulate browser reload from localStorage JSON */
const restoredSess = JSON.parse(JSON.stringify(runReloaded.sess));
const restoredRng = QLDM.createRng(1);
restoredRng.setState(restoredSess.rngState);
while (stepMockSessionOnce(restoredSess, restoredRng)) { /* finish after reload */ }

assert.equal(QLDM.formatPseCsv(restoredSess), QLDM.formatPseCsv(runContinuous.sess), "Reloaded session PSE CSV must match uninterrupted run identically");
assert.equal(QLDM.formatTbtCsv(restoredSess), QLDM.formatTbtCsv(runContinuous.sess), "Reloaded session TBT CSV must match uninterrupted run identically");

/* 8b. "Too loud" flow: started Block 1 ends tracks > new ceiling; unstarted Block 2 recomputes T & full 6 levels! */
const tlRun = makeMockSession(777333, "standard", { cu5_1k: 20, ucl_1k: null, cu5_4k: 20, ucl_4k: null });
assert.equal(tlRun.sess.blocks[1].started, false);
/* Trigger three "Too loud" presses during Block 1 (100 -> 95 -> 90 -> 85 dB) */
for (let k = 0; k < 3; k++) {
  const tr95 = tlRun.sess.blocks[0].pairs[5].upper;
  QLDM.applyTooLoudToSession(tlRun.sess, {
    isPractice: false, trackRef: tr95, blockPass: 1, blockHz: 1000, matchId: tr95.matchId,
    role: "forward", trackId: tr95.trackId, trackSlot: "upper", centerHz: 1000, bandwidthOct: 1.0,
    fixedSound: QLDM.SOUND_1OCT, variedSound: QLDM.SOUND_TONE, fixedLevelSpl: 95, variedLevelSpl: 100,
    variedInterval: 1, sound1: QLDM.SOUND_TONE, level1Spl: 100, sound2: QLDM.SOUND_1OCT, level2Spl: 95
  }, "2026-11-20T15:02:00Z");
}
assert.equal(tlRun.sess.blocks[0].ceilingSpl, 85.0, "Three Too Loud presses should lower Block 1 ceiling from 100 to 85 dB SPL");
assert.equal(tlRun.sess.blocks[1].ceilingSpl, 85.0, "Three Too Loud presses should lower Block 2 ceiling from 100 to 85 dB SPL");
assert.equal(tlRun.sess.blocks[0].pairs[5].upper.stopReason, "TOO_LOUD_CEILING", "Started Block 1 95 dB track must stop");
assert.equal(tlRun.sess.blocks[0].pairs[4].upper.stopReason, "TOO_LOUD_CEILING", "Started Block 1 90 dB track must stop");
/* Unstarted Block 2 must have recomputed T = 80 dB SPL and kept all 6 levels [45, 55, 65, 70, 75, 80] */
assert.equal(tlRun.sess.blocks[1].topLevelSpl, 80.0);
assert.deepEqual(tlRun.sess.blocks[1].matches.map(m => m.fixedLevelSpl), [45, 55, 65, 70, 75, 80]);
assert.ok(tlRun.sess.blocks[1].matches.every(m => !m.excludedReason), "Recomputed unstarted Block 2 should run all 6 levels");

while (stepMockSessionOnce(tlRun.sess, tlRun.rngLocal)) { /* finish remaining 60 dB tracks */ }
const pseCsv = QLDM.formatPseCsv(tlRun.sess);
const tbtCsv = QLDM.formatTbtCsv(tlRun.sess);
const sesObj = JSON.parse(QLDM.formatSesJson(tlRun.sess, "2026-11-20T15:05:00Z"));

assert.ok(pseCsv.includes("n_at_ceiling,n_at_ceiling_fixed_louder"), "LM_PSE header must include ceiling bound columns");
assert.ok(tbtCsv.includes("TOO_LOUD_PRESSED"), "LM_TBT must log TOO_LOUD_PRESSED events");
assert.equal(sesObj.analog_gain_confirmation.confirmed, true, "LM_SES JSON must record operator analog gain confirmation");
assert.equal(sesObj.stimulus_definition.reference_dbfs_rms_at_60db_spl, -60.0);
assert.equal(sesObj.stimulus_definition.nominal_full_scale_1khz_spl_db, 116.9);
assert.equal(sesObj.level_limits.too_loud_events.length, 3);
console.log(`[PASS Session Flows] Verified mid-session JSON reload recovery, Too Loud ceiling step-down, and LM_PSE / LM_TBT / LM_SES exports.`);

/* -------------------------------------------------------------------------
 * 9. Legacy v1.0.0 Calibration & Session Record Preservation (Follow-up 2)
 *    A record without `refDbfsRms60` (or session with appVersion "1.0.0") must
 *    load at -70.0 dBFS (+30 dB re qCLS) and give identical digital RMS to v1.0.0.
 * ------------------------------------------------------------------------- */
const v1CalRaw = {
  id: "custom_coupler",
  name: "Lab ER-3A (Measured under v1.0.0)",
  couplerVerified: true,
  date: "2026-11-20",
  offsetsDb: { ...QLDM.TRANSDUCER_PRESETS.flat_ref.offsetsDb }
  /* Note: intentionally no refDbfsRms60 field, matching qLDM_calibration_v1 */
};

const loadedV1Cal = QLDM.normalizeCalibrationRecord(v1CalRaw);
assert.equal(loadedV1Cal.refDbfsRms60, -70.0, "Legacy v1 calibration without refDbfsRms60 must load at -70.0 dBFS");
const v1FsInfo = QLDM.computeFullScale1kSpl(loadedV1Cal);
assert.equal(v1FsInfo.refDbfsRms60, -70.0);
assert.equal(v1FsInfo.gainAboveQclsDb, 30.0);
assert.equal(v1FsInfo.fullScale1kSpl, 126.9);

/* Verify stimulus at nominal 80 dB SPL has exact v1.0.0 digital RMS (10^(-70/20) * 10^((80-60)/20) = 10^(-50/20)) */
const v1ExpectedRms80 = Math.pow(10.0, -70.0 / 20.0) * Math.pow(10.0, (80.0 - 60.0) / 20.0);
for (const calCandidate of [v1CalRaw, loadedV1Cal]) {
  const wV1 = QLDM.generateSoundWaveform({
    centerHz: 1000,
    sound: QLDM.SOUND_1OCT,
    levelSpl: 80.0,
    sampleRate: 48000,
    durationMs: 500,
    rampMs: 20,
    calTable: calCandidate,
    ceilingSpl: 100.0
  });
  assert.equal(wV1.ok, true);
  const v1RmsDiffDb = Math.abs(20.0 * Math.log10(wV1.unrampedDigitalRms / v1ExpectedRms80));
  assert.ok(v1RmsDiffDb < 1e-5, `v1 record RMS differed from v1.0.0 nominal by ${v1RmsDiffDb} dB`);
}

/* Verify interrupted/stored v1.0.0 session normalizes to -70.0 dBFS on resume/load */
const v1SessionRaw = makeMockSession(123456).sess;
v1SessionRaw.appVersion = "1.0.0";
delete v1SessionRaw.calibration.refDbfsRms60;
const resumedV1Sess = QLDM.normalizeSessionRecord(JSON.parse(JSON.stringify(v1SessionRaw)));
assert.equal(resumedV1Sess.calibration.refDbfsRms60, -70.0);
assert.equal(resumedV1Sess.calibration.gainAboveQclsDb, 30.0);
assert.equal(resumedV1Sess.calibration.fullScale1kSpl, 126.9);
const v1SesExport = JSON.parse(QLDM.formatSesJson(resumedV1Sess, "2026-11-20T16:50:00Z"));
assert.equal(v1SesExport.stimulus_definition.reference_dbfs_rms_at_60db_spl, -70.0);
assert.equal(v1SesExport.stimulus_definition.analog_gain_above_qcls_db, 30.0);

/* Confirm default for new calibrations remains -60.0 dBFS */
assert.equal(QLDM.TRANSDUCER_PRESETS.er3a_nominal.refDbfsRms60, -60.0);
console.log(`[PASS Legacy v1.0.0 Compatibility] v1 records & sessions preserve -70.0 dBFS (+30 dB re qCLS, exact v1.0.0 digital RMS); new calibrations default to -60.0 dBFS.`);

/* -------------------------------------------------------------------------
 * 10. v1.1.2 Booth Polish & v1.2.0 Listener-Specific Top Level T (Follow-up 3)
 * ------------------------------------------------------------------------- */
assert.equal(QLDM.APP_VERSION, "1.2.0");

/* 10a. Per-ear Left/Right receiver calibration + JSON export/import round-trip */
const perEarCal = {
  id: "er3a_dual",
  name: "Booth A ER-3A Pair",
  couplerVerified: true,
  date: "2026-11-21",
  refDbfsRms60: -60.0,
  perEarEnabled: true,
  offsetsByEar: {
    Left: { ...QLDM.TRANSDUCER_PRESETS.er3a_nominal.offsetsDb, "4000": -3.5, "5656.8542": -12.0 },
    Right: { ...QLDM.TRANSDUCER_PRESETS.er3a_nominal.offsetsDb, "4000": -5.5, "5656.8542": -15.0 }
  },
  offsetsDb: { ...QLDM.TRANSDUCER_PRESETS.er3a_nominal.offsetsDb }
};
assert.equal(QLDM.lookupCalOffsetDb(perEarCal, 4000, "Left"), -3.5);
assert.equal(QLDM.lookupCalOffsetDb(perEarCal, 4000, "Right"), -5.5);

const wLeft4k = QLDM.generateSoundWaveform({
  centerHz: 4000,
  sound: QLDM.SOUND_TONE,
  levelSpl: 80.0,
  sampleRate: 48000,
  durationMs: 500,
  rampMs: 20,
  calTable: perEarCal,
  ear: "Left"
});
const wRight4k = QLDM.generateSoundWaveform({
  centerHz: 4000,
  sound: QLDM.SOUND_TONE,
  levelSpl: 80.0,
  sampleRate: 48000,
  durationMs: 500,
  rampMs: 20,
  calTable: perEarCal,
  ear: "Right"
});
assert.equal(wLeft4k.ok, true);
assert.equal(wRight4k.ok, true);
/* Right ear rolls off 2.0 dB more at 4 kHz (-5.5 vs -3.5), so digital RMS must be +2.0 dB higher */
const lrDiffDb = 20.0 * Math.log10(wRight4k.unrampedDigitalRms / wLeft4k.unrampedDigitalRms);
assert.ok(Math.abs(lrDiffDb - 2.0) < 1e-6, `Expected +2.0 dB Right vs Left digital boost, got ${lrDiffDb}`);

const exportedCalJson = QLDM.formatCalibrationJson(perEarCal, "2026-11-21T08:00:00Z");
const importedCalRes = QLDM.parseImportedCalibrationJson(exportedCalJson);
assert.equal(importedCalRes.ok, true);
assert.equal(importedCalRes.calibration.perEarEnabled, true);
assert.equal(QLDM.lookupCalOffsetDb(importedCalRes.calibration, 5656.8542, "Left"), -12.0);
assert.equal(QLDM.lookupCalOffsetDb(importedCalRes.calibration, 5656.8542, "Right"), -15.0);

/* Legacy v1.0.0 calibration JSON import retains -70.0 dBFS */
const legacyImp = QLDM.parseImportedCalibrationJson(JSON.stringify({ offsetsDb: v1CalRaw.offsetsDb, name: "LegacyRig" }));
assert.equal(legacyImp.ok, true);
assert.equal(legacyImp.calibration.refDbfsRms60, -70.0);

/* Missing frequency in Left ear is rejected on import */
const brokenPerEar = JSON.parse(exportedCalJson);
delete brokenPerEar.calibration.offsetsByEar.Left["4000"];
const brokenImp = QLDM.parseImportedCalibrationJson(JSON.stringify(brokenPerEar));
assert.equal(brokenImp.ok, false);

/* 10b. Random seed generator range check */
for (let k = 0; k < 20; k++) {
  const sd = QLDM.generateRandomSeed();
  assert.ok(Number.isInteger(sd) && sd >= 10000000 && sd <= 99999999);
}

/* 10c. Flexible qCLS_ELC CSV parser (_HHMM & browser duplicate suffix) */
const sampleElcCsv = [
  "Listener,Freq_Hz,CU,SPL_dB,HL_dB",
  "HL012,1000,5,28.4,21.4",
  "HL012,1000,50,96.2,89.2",
  "HL012,4000,5,52.0,42.5",
  "HL012,4000,50,101.5,92.0"
].join("\n");
const parsedElc = QLDM.parseQclsElcCsv(sampleElcCsv, "qCLS_ELC_HL012_L_20261121_1435 (1).csv");
assert.equal(parsedElc.ok, true);
assert.equal(parsedElc.participantId, "HL012");
assert.equal(parsedElc.ear, "Left");
assert.equal(parsedElc.cu5_1k, 28.4);
assert.equal(parsedElc.ucl_4k, 101.5);

/* 10d. Two-panel Results SVG plot */
const svgSession = makeMockSession(777888).sess;
const svgMarkup = QLDM.renderResultsSvg(svgSession);
assert.ok(svgMarkup.startsWith("<svg ") && svgMarkup.endsWith("</svg>"));
assert.ok(svgMarkup.includes("1 kHz Block") && svgMarkup.includes("4 kHz Block"));
console.log(`[PASS v1.1.2 Booth Polish] Per-ear calibration & JSON import/export, random seeds, qCLS_ELC (_HHMM) parsing, & 2-panel Results SVG verified.`);

/* -------------------------------------------------------------------------
 * 11. Follow-up 3 Verification: Per-Frequency T & Block Ceiling Derivation,
 *     20 dB SPL Low-Tone Resolution @ T=75, & Request 6 Top-Level Simulation
 * ------------------------------------------------------------------------- */
/* 11a. Verify spec table of T -> 6 levels and independent 1k / 4k block ceilings */
const expectedLevelSets = [
  [105, 95, [60, 70, 80, 85, 90, 95]],
  [100, 95, [60, 70, 80, 85, 90, 95]],
  [99.2, 90, [55, 65, 75, 80, 85, 90]],
  [95, 90, [55, 65, 75, 80, 85, 90]],
  [90, 85, [50, 60, 70, 75, 80, 85]],
  [85, 80, [45, 55, 65, 70, 75, 80]],
  [83.4, 75, [40, 50, 60, 65, 70, 75]]
];
for (const [uclVal, expT, expLvls] of expectedLevelSets) {
  const p = QLDM.deriveBlockLevelPlan({ centerHz: 4000, maxOutputSpl: 100, uclSpl: uclVal, cu5Spl: 20 });
  assert.equal(p.ceilingSpl, Math.min(100, uclVal));
  assert.equal(p.topLevelSpl, expT);
  assert.deepEqual(p.candidateLevelsSpl, expLvls);
  assert.ok(p.excludedLevels.every(e => !e.excludedReason.includes("ABOVE_LISTENER_TOO_LOUD")));
}

/* Empty Too Loud -> ceiling = Max Output, T = 95; short4 -> [T-35, T-5] = [60, 90] */
const pEmpty = QLDM.deriveBlockLevelPlan({ centerHz: 1000, maxOutputSpl: 105, uclSpl: null, cu5Spl: 55 });
assert.equal(pEmpty.ceilingSpl, 105);
assert.equal(pEmpty.topLevelSpl, 95);
assert.deepEqual(pEmpty.activeLevelsSpl, [70, 80, 85, 90, 95]);
assert.equal(pEmpty.excludedLevels.length, 1);
assert.ok(pEmpty.excludedLevels[0].excludedReason.startsWith("BELOW_CU5_PLUS_10DB"));

const pShort = QLDM.deriveBlockLevelPlan({ centerHz: 1000, maxOutputSpl: 100, uclSpl: 85, matchSet: "short4" });
assert.equal(pShort.topLevelSpl, 80);
assert.deepEqual(pShort.candidateLevelsSpl, [45, 75]);

/* Independent block ceilings in one session: 1 kHz empty (ceil 100, T=95) vs 4 kHz ucl=82 (ceil 82, T=75, lowest tone=20 dB) */
const asymPlans = QLDM.deriveSessionLevelPlans({
  initialMaxOutputSpl: 100,
  matchSet: "standard",
  limits: { cu5_1k: 20, ucl_1k: null, cu5_4k: 20, ucl_4k: 82.0 }
});
assert.equal(asymPlans.plansByHz[1000].ceilingSpl, 100.0);
assert.equal(asymPlans.plansByHz[1000].topLevelSpl, 95.0);
assert.equal(asymPlans.plansByHz[1000].lowestToneSpl, 40.0);
assert.equal(asymPlans.plansByHz[4000].ceilingSpl, 82.0);
assert.equal(asymPlans.plansByHz[4000].topLevelSpl, 75.0);
assert.equal(asymPlans.plansByHz[4000].lowestToneSpl, 20.0);
assert.equal(asymPlans.sessionLowestToneSpl, 20.0);

/* Pre-playback guard uses each block's own ceiling: 85 dB tone refused in 4k block (ceil 82) but allowed in 1k block (ceil 100) */
const guard4kBlock = QLDM.generateSoundWaveform({
  centerHz: 4000, sound: QLDM.SOUND_TONE, levelSpl: 85.0,
  calTable: QLDM.TRANSDUCER_PRESETS.flat_ref, ceilingSpl: asymPlans.plansByHz[4000].ceilingSpl
});
assert.equal(guard4kBlock.ok, false);
assert.equal(guard4kBlock.reason, "CEILING_EXCEEDED_BY_BUFFER");

/* 20 dB SPL lowest tone (T=75) synthesizes cleanly on 24-bit path (-100 dBFS RMS) */
const lowTone20 = QLDM.generateSoundWaveform({
  centerHz: 4000, sound: QLDM.SOUND_TONE, levelSpl: 20.0,
  calTable: QLDM.TRANSDUCER_PRESETS.flat_ref, ceilingSpl: asymPlans.plansByHz[4000].ceilingSpl
});
assert.equal(lowTone20.ok, true);

/* SVG plot x-axis ticks reflect levels in use per block (e.g. 75 at 4 kHz, 95 at 1 kHz; no hardcoded 100) */
const asymSess = makeMockSession(445566, "standard", { cu5_1k: 20, ucl_1k: null, cu5_4k: 20, ucl_4k: 82.0 }).sess;
const asymSvg = QLDM.renderResultsSvg(asymSess);
assert.ok(asymSvg.includes(">85</text>") && asymSvg.includes(">95</text>"));
assert.ok(asymSvg.includes(">40</text>") && asymSvg.includes(">75</text>"));
assert.ok(!asymSvg.includes(">100</text>"), "Result SVG must not use hardcoded 100 dB tick when levels are [60..95] and [40..75]");

const asymSesJson = JSON.parse(QLDM.formatSesJson(asymSess, "2026-11-21T14:00:00Z"));
assert.equal(asymSesJson.level_limits.blocks_by_frequency.length, 2);
assert.equal(asymSesJson.level_limits.blocks_by_frequency[0].final_top_level_t_spl, 95);
assert.equal(asymSesJson.level_limits.blocks_by_frequency[1].final_top_level_t_spl, 75);
assert.equal(asymSesJson.level_limits.blocks_by_frequency[1].final_ceiling_spl, 82);

/* 11b. Request 6 Simulation: Complex at T (95 dB), Ceiling at T + 5 (100 dB), sigma = 4 dB, 16 trials/match */
console.log("\n=== Top-Level Ceiling Simulation (Complex = T = 95 dB, Ceiling = 100 dB, sigma = 4.0 dB, 16 trials, N = 2000 blocks/point) ===");
const topSimRows = QLDM.runTopLevelCeilingSimulation({
  topLevelSpl: 95.0,
  ceilingSpl: 100.0,
  sigma: 4.0,
  trialsPerTrack: 8,
  nBlocks: 2000,
  testDeltas: [-4, -2, 0, 2, 4, 6],
  seed: 20261121
});
for (const r of topSimRows) {
  const dStr = (r.trueDeltaDb >= 0 ? "+" : "") + r.trueDeltaDb.toFixed(0);
  const bAll = (r.biasAllDb >= 0 ? "+" : "") + r.biasAllDb.toFixed(3);
  const bUnf = Number.isFinite(r.biasUnflaggedDb) ? ((r.biasUnflaggedDb >= 0 ? "+" : "") + r.biasUnflaggedDb.toFixed(3)) : "  n/a ";
  const sdUnf = Number.isFinite(r.sdUnflaggedDb) ? r.sdUnflaggedDb.toFixed(2) : " n/a";
  console.log(
    `  True Delta = ${dStr.padStart(3)} dB | All: bias=${bAll} dB, SD=${r.sdAllDb.toFixed(2)} dB | ` +
    `Unflagged: bias=${bUnf} dB, SD=${sdUnf} dB | ` +
    `AT_CEILING = ${r.atCeilingRatePct.toFixed(1).padStart(5)}% | ` +
    `mean(n_ceil / fixed_louder) = ${r.meanNAtCeilingAll.toFixed(2)} / ${r.meanNFixedLouderAll.toFixed(2)} ` +
    `(when flagged: ${r.meanNAtCeilingWhenFlagged.toFixed(2)} / ${r.meanNFixedLouderWhenFlagged.toFixed(2)})`
  );
}
/* Verify AT_CEILING rate rises monotonically from negative to positive true Delta, and Delta <= 0 stays well-behaved */
for (let i = 1; i < topSimRows.length; i++) {
  assert.ok(topSimRows[i].atCeilingRatePct >= topSimRows[i - 1].atCeilingRatePct, "AT_CEILING rate must increase monotonically with true Delta");
}
assert.ok(Math.abs(topSimRows[0].biasAllDb) < 0.25 && topSimRows[0].atCeilingRatePct < 2.0, "At true Delta = -4 dB, bias and AT_CEILING rate should be negligible");
console.log(`[PASS Follow-up 3 / v1.2.0] Verified per-listener T, per-block ceilings, unstarted T recomputation, dynamic low-tone check, and top-level T simulation.`);

console.log("\nALL qLDM ACCEPTANCE TESTS PASSED.");
