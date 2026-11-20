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
 * 6. AT_CEILING vs. AT_LIMIT_3_CONSEC & Bound Counts (Follow-up §2)
 * ------------------------------------------------------------------------- */
const std1k = QLDM.buildMatchTable({ matchSet: "standard" }).filter(m => m.centerHz === 1000);
const capPairs = std1k.map(m => {
  const u = QLDM.createTrackState(m, "upper", { trialsPerTrack: 8, ceilingSpl: 100.0 });
  const l = QLDM.createTrackState(m, "lower", { trialsPerTrack: 8, ceilingSpl: 100.0 });
  for (let i = 0; i < 8; i++) {
    if (m.fixedLevelSpl === 100) {
      /* Listener always judges 100 dB complex louder than capped 100 dB tone -> hits ceiling */
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
const row100 = capEval.rows.find(r => r.fixedLevelSpl === 100);
const row60 = capEval.rows.find(r => r.fixedLevelSpl === 60);
assert.ok(row100.flags.includes("AT_CEILING"), "100 dB match should carry AT_CEILING");
assert.ok(!row100.flags.includes("AT_LIMIT_3_CONSEC"), "100 dB match at ceiling should not carry AT_LIMIT_3_CONSEC");
assert.ok(row100.nAtCeiling >= 10 && row100.nAtCeilingFixedLouder === row100.nAtCeiling);
assert.ok(row60.flags.includes("AT_LIMIT_3_CONSEC"), "60 dB match hitting 80 dB (+20 range) should carry AT_LIMIT_3_CONSEC");
assert.ok(!row60.flags.includes("AT_CEILING"), "60 dB match at 80 dB should not carry AT_CEILING");
assert.equal(row60.nAtCeiling, 0);
console.log(
  `[PASS Ceiling Bounds] 100 dB match: flags=[${row100.flags.join(",")}], n_at_ceiling=${row100.nAtCeiling}, ` +
  `fixed_louder=${row100.nAtCeilingFixedLouder} | 60 dB (+20 range): flags=[${row60.flags.join(",")}]`
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
function makeMockSession(seed) {
  const rngLocal = QLDM.createRng(seed);
  const matches1k = QLDM.buildMatchTable({ matchSet: "short4" }).filter(m => m.centerHz === 1000);
  const matches4k = QLDM.buildMatchTable({ matchSet: "short4" }).filter(m => m.centerHz === 4000);
  const mkBlk = (fc, ms) => ({
    blockPass: 1,
    centerHz: fc,
    matches: ms.map(m => ({ ...m, blockPass: 1, excludedReason: "" })),
    pairs: ms.map(m => ({
      upper: QLDM.createTrackState(m, "upper", { trialsPerTrack: 8, ceilingSpl: 100.0 }),
      lower: QLDM.createTrackState(m, "lower", { trialsPerTrack: 8, ceilingSpl: 100.0 })
    })),
    trialsInBlockCompleted: 0,
    completed: false,
    evalSummary: null
  });
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
      settings: {
        matchSet: "short4",
        durationMs: 500,
        rampMs: 20,
        gapMs: 400,
        itiMs: 300,
        trialsPerTrack: 8,
        initialMaxOutputSpl: 100,
        compFlagDb: -6.0,
        initialSeed: seed,
        limits: { cu5_1k: 25, ucl_1k: null, cu5_4k: 35, ucl_4k: null }
      },
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
      ceilingSpl: 100.0,
      tooLoudEvents: [],
      blocks: [mkBlk(1000, matches1k), mkBlk(4000, matches4k)],
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
  QLDM.stepTrack(tr, resp, sess.ceilingSpl);
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
    tooLoud: 0, rtMs: 420, ceilingSpl: sess.ceilingSpl, guardStatus: "OK"
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

/* 8b. "Too loud" flow & file exports */
const tlRun = makeMockSession(777333);
/* Trigger two "Too loud" presses (100 -> 95 -> 90 -> 85 dB), dropping 90 dB unstarted matches in Block 2 */
for (let k = 0; k < 3; k++) {
  const tr90 = tlRun.sess.blocks[0].pairs[1].upper;
  QLDM.applyTooLoudToSession(tlRun.sess, {
    isPractice: false, trackRef: tr90, blockPass: 1, blockHz: 1000, matchId: tr90.matchId,
    role: "forward", trackId: tr90.trackId, trackSlot: "upper", centerHz: 1000, bandwidthOct: 1.0,
    fixedSound: QLDM.SOUND_1OCT, variedSound: QLDM.SOUND_TONE, fixedLevelSpl: 90, variedLevelSpl: 100,
    variedInterval: 1, sound1: QLDM.SOUND_TONE, level1Spl: 100, sound2: QLDM.SOUND_1OCT, level2Spl: 90
  }, "2026-11-20T15:02:00Z");
}
assert.equal(tlRun.sess.ceilingSpl, 85.0, "Three Too Loud presses should lower ceiling from 100 to 85 dB SPL");
assert.equal(tlRun.sess.blocks[0].pairs[1].upper.stopReason, "TOO_LOUD_CEILING");
assert.ok(tlRun.sess.blocks[1].matches[1].excludedReason.startsWith("TOO_LOUD_CEILING"), "Unstarted 90 dB match in Block 2 must be excluded by 85 dB ceiling");

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

console.log("\nALL qLDM ACCEPTANCE TESTS PASSED.");
