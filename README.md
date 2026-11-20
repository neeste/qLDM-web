# qLDM — Quick Two-Interval Loudness Matching

Stand-alone client-side web application for monaural two-interval loudness matching between a pure tone and a geometrically spaced five-tone complex (`5TC`) centered at `1000 Hz` and `4000 Hz`, implementing `LOUDNESS_MATCHING_APP_SPEC.md` and `LOUDNESS_MATCHING_APP_ADVICE.md`.

## Key Architecture & Features

- **Zero-Build Client-Side Architecture:** Plain HTML, CSS, and JavaScript (`index.html`, `style.css`, `qldm_core.js`, `app.js`, `guide.html`) using the Web Audio API (`48 kHz` sample clock, single-buffer sample-accurate two-interval timing, `ChannelMergerNode(2)` monaural routing). Nothing leaves the browser except operator-downloaded CSV/JSON files.
- **Headless Core Module (`qldm_core.js`):** Stimulus generation (exact match to `nea_gen_5tc.m`), pre-playback sample-buffer clipping & calibrated acoustic ceiling guard, 1-up/1-down interleaved two-track adaptive staircase, and projected-BFGS block maximum-likelihood logistic estimator (exact match to `lm_track_sim.py`).
- **30 dB Extra Digital Headroom:** Uses `-70.0 dBFS RMS = 60.0 dB SPL` (`0.0003162278` RMS) with a per-frequency 18-component acoustic coupler calibration table (`707.11 Hz` to `5656.85 Hz`), keeping a `100 dB SPL` 5-tone complex (>10 dB crest factor) unclipped up to `112.3 dB SPL` even with `-14.5 dB` ER-3A high-frequency roll-off compensation.
- **General Match Table:** Supports the **Standard** set (12 matches, ~10 min), **Extended** set (24 matches, ~19 min), and **Short Anchor** set (4 matches, ~3 min), plus optional Pilot **Null** (`tone` vs. `tone`) and **Reverse** (`fixed tone`, `varied complex`) matches (off by default).
- **Component-Listening Safeguards:** Standardized whole-sound instruction modal before Practice and each Block, 8-trial practice with obvious level checks and post-practice tester prompt, and automatic `COMPONENT_MATCH_SUSPECTED` flagging (`Δ <= -6 dB` across a block) with 1-click block repeat.
- **Crash-Safe Persistence & qCLS Integration:** Saves session state + seeded PRNG state to `localStorage` after every single trial, imports listener `CU 5` and `CU 50` limits directly from `qCLS_ELC_*.csv`, and exports `LM_PSE_[ID]_[L|R]_[YYYYMMDD].csv`, `LM_TBT_[ID]_[L|R]_[YYYYMMDD].csv`, and `LM_SES_[ID]_[L|R]_[YYYYMMDD].json`.

## Running Automated Acceptance Tests

```bash
make test
```

Runs syntax checks (`node --check`) plus `test/test_qldm_acceptance.mjs`, verifying:
1. Waveform component frequencies, sine onset phase, crest factor (`[2.95, 3.15]`), and RMS within `< 0.001 dB` of nominal across all complexes (`500 ms` and `1000 ms`).
2. Direct numerical parity of `QLDMCore.fitBlockML` against `lm_track_sim.py` (`scipy.optimize.minimize` `L-BFGS-B`) to `< 0.002 dB` across 250 random blocks (1,500 matches).
3. Simulated-listener Monte Carlo accuracy (`1,500` blocks per $\sigma \in \{2.5, 4.0, 6.0\}$ dB): $|\text{bias}| < 0.03\text{ dB}$, match $\text{SD} \approx 1.05, 1.54, 2.16\text{ dB}$ at 16 trials/match.
4. Pre-playback buffer safety guard rejection of clipped (`> 0 dBFS`), ceiling-exceeding, and `NaN` buffers.
