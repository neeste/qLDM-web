# qLDM — Quick Two-Interval Loudness Matching

Stand-alone client-side web application for monaural two-interval loudness matching between a pure tone and a geometrically spaced five-tone complex (`5TC`) centered at `1000 Hz` and `4000 Hz`, implementing `LOUDNESS_MATCHING_APP_SPEC.md`, `LOUDNESS_MATCHING_APP_ADVICE.md`, and `LOUDNESS_MATCHING_APP_FOLLOWUP` 1–3 (`v1.2.0`).

## Key Architecture & Features

- **Zero-Build Client-Side Architecture:** Plain HTML, CSS, and JavaScript (`index.html`, `style.css`, `qldm_core.js`, `app.js`, `guide.html`) using the Web Audio API (`48 kHz` sample clock, single-buffer sample-accurate two-interval timing, `ChannelMergerNode(2)` monaural routing). Nothing leaves the browser except operator-downloaded CSV/JSON files.
- **Per-Frequency Block Ceiling & Top Level `T`:** Derives each block's ceiling from `min(Max Output, listener Too Loud)` (or `Max Output` when empty) and sets top complex level `T = min(95, 5 * floor((ceiling - 5) / 5))` dB SPL with standard offsets `[-35, -25, -15, -10, -5, 0] dB` (`[60, 70, 80, 85, 90, 95] dB SPL` at `T = 95`; `[T-35, T-5]` for the 4-match anchor set), excluding levels `< CU 5 + 10 dB` and recomputing `T` on unstarted blocks if `"Too loud"` lowers block ceilings by `5 dB`.
- **Headless Core Module (`qldm_core.js`):** Stimulus generation (exact match to `nea_gen_5tc.m`), strict per-component calibration enforcement (`MISSING_CALIBRATION_ENTRY`), pre-playback sample-buffer clipping & per-block calibrated acoustic ceiling guard, 1-up/1-down interleaved two-track adaptive staircase, projected-BFGS block maximum-likelihood logistic estimator (exact match to `lm_track_sim.py`), and pure session/export formatters.
- **Configurable Digital Reference & Headroom Table:** Defaults to `-60.0 dBFS RMS = 60.0 dB SPL` (adjustable from `-70` to `-50 dBFS` in calibration, `+20 dB` analog gain re `qCLS`), displaying nominal full-scale (`0 dBFS` peak) `1 kHz` SPL (`116.9 dB SPL` at `-60 dBFS`), pre-session unclipped SPL margins (`102.3 dB SPL` lowest ceiling on nominal ER-3A, `+7.3 dB` above `T = 95`), a dynamic lowest-session-tone 24-bit resolution check (`40 dB SPL` at `T = 95`, `20 dB SPL` at `T = 75`), and a mandatory pre-session operator analog-gain confirmation recorded in `LM_SES_*.json`.
- **Ceiling Bound Diagnostics (`AT_CEILING`):** Separates `AT_CEILING` (3 consecutive trials at `Max Output` or `"Too loud"` lowered ceiling) from `AT_LIMIT_3_CONSEC` (`±20 dB` offset range and `10 dB` floor), recording `n_at_ceiling` and `n_at_ceiling_fixed_louder` on every match row without excluding or repeating capped matches.
- **Component-Listening Safeguards:** Standardized whole-sound instruction modal before Practice and each Block, 8-trial practice with obvious level checks and post-practice tester prompt, and automatic `COMPONENT_MATCH_SUSPECTED` flagging evaluated specifically over forward 1-octave matches (`Δ <= -6 dB`) with 1-click block repeat.
- **Crash-Safe Persistence, Calibration Backup, & qCLS Integration:** Auto-generates a fresh reproducible 8-digit RNG seed per session, saves session + PRNG state to `localStorage` after every trial, supports **Export / Import Calibration JSON** and optional **separate Left/Right receiver coupler tables**, imports listener `CU 5` and `CU 50` limits directly from `qCLS_ELC_*.csv`, renders an inline two-panel (`1 kHz` & `4 kHz`) `Δ` vs. Level summary plot, and exports `LM_PSE_[ID]_[L|R]_[YYYYMMDD]_[HHMM].csv`, `LM_TBT_[ID]_[L|R]_[YYYYMMDD]_[HHMM].csv`, and `LM_SES_[ID]_[L|R]_[YYYYMMDD]_[HHMM].json` (individually or via one-click **Download All 3 Files**).

## Running Automated Acceptance Tests

```bash
make test
```

Runs syntax checks (`node --check`), DOM wiring checks (`test/test_dom_wiring.mjs`), and `test/test_qldm_acceptance.mjs`.
