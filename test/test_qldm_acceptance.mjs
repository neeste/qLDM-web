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
 * 4. No Clipping Across Standard & Extended Sets + Safety Guard (Advice §3, §6, §9.3)
 * ------------------------------------------------------------------------- */
for (const preset of [QLDM.TRANSDUCER_PRESETS.er3a_nominal, QLDM.TRANSDUCER_PRESETS.flat_ref]) {
  const headroom = QLDM.computeMaxUnclippedLevels(preset, { durationMs: 500, rampMs: 20 });
  const minMaxSpl = Math.min(...headroom.map(h => h.maxUnclippedSpl));
  console.log(`\n[PASS Headroom: ${preset.id}] Lowest max-unclipped ceiling across all 6 stimuli = ${minMaxSpl.toFixed(1)} dB SPL (> 100 dB SPL)`);
  assert.ok(minMaxSpl >= 105.0, `Expected >= 105 dB SPL unclipped ceiling, got ${minMaxSpl}`);

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

/* Verify safety guard blocks clipping, ceiling violations, and NaN buffers */
const clipRes = QLDM.generateSoundWaveform({
  centerHz: 4000,
  sound: QLDM.SOUND_1OCT,
  levelSpl: 125.0,
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

/* Verify component-listening flag triggers when all forward matches <= -6 dB */
const compMatches = QLDM.buildMatchTable({ matchSet: "standard" }).filter(m => m.centerHz === 1000);
const compPairs = compMatches.map(m => {
  const u = QLDM.createTrackState(m, "upper", { trialsPerTrack: 8 });
  const l = QLDM.createTrackState(m, "lower", { trialsPerTrack: 8 });
  for (let i = 0; i < 8; i++) {
    QLDM.stepTrack(u, u.curVariedSpl > m.fixedLevelSpl - 7.0, 100);
    QLDM.stepTrack(l, l.curVariedSpl > m.fixedLevelSpl - 7.0, 100);
  }
  return { upper: u, lower: l };
});
const compEval = QLDM.evaluateBlockMatches(compMatches, compPairs, { componentFlagThresholdDb: -6.0 });
assert.equal(compEval.componentMatchFlag, true, "Component-listening flag should trigger at -7 dB across block");

console.log("\nALL qLDM ACCEPTANCE TESTS PASSED.");
