"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';

// --- Constants & Physics Configuration ---
const IDLE_RPM = 800;
const REDLINE_RPM = 10000;
const MAX_SPEED = 330;

const GEAR_MAX_SPEEDS = {
  '-1': 60,
  0: 0,
  1: 65,
  2: 115,
  3: 165,
  4: 220,
  5: 275,
  6: 330,
};

const MODES = ['ECO', 'SPORT', 'SPORT+'];
const MODE_MULT = { ECO: 0.4, SPORT: 0.7, 'SPORT+': 1.0 };

// --- Deep Roaring Exhaust & Backfire Audio Engine ---
class V10EngineSound {
  constructor() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    // Master Engine Gain (controlled strictly by engineOn & stalled state)
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;
    this.masterGain.connect(this.ctx.destination);

    // Separate Output Bus for Exhaust Backfire Pops (so pops ring out even on throttle lift)
    this.backfireBus = this.ctx.createGain();
    this.backfireBus.gain.value = 0.9;
    this.backfireBus.connect(this.ctx.destination);

    // 1. Primary Deep Combustion Oscillators (32Hz idle -> 260Hz redline)
    this.oscMain = this.ctx.createOscillator();
    this.oscSub = this.ctx.createOscillator();
    this.oscGrowl = this.ctx.createOscillator();

    this.oscMain.type = 'sawtooth';
    this.oscSub.type = 'triangle'; // Deep chest sub-bass
    this.oscGrowl.type = 'sawtooth'; // Cross-plane harmonic

    this.subGain = this.ctx.createGain();
    this.subGain.gain.value = 0.65;
    this.growlGain = this.ctx.createGain();
    this.growlGain.gain.value = 0.4;

    // 2. Brown Noise Generator for Mechanical Exhaust Air Rush
    const bufferSize = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + 0.02 * white) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5;
    }

    this.noiseSource = this.ctx.createBufferSource();
    this.noiseSource.buffer = this.noiseBuffer;
    this.noiseSource.loop = true;

    this.noiseFilter = this.ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 180;
    this.noiseFilter.Q.value = 1.2;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0.25;

    // 3. Lowpass Muffler Filter (cuts harsh high-pitch buzz, keeps deep roar)
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 280;
    this.filter.Q.value = 2.2;

    // 4. Warm Exhaust Saturation / Distortion
    this.distortion = this.ctx.createWaveShaper();
    this.distortion.curve = this.makeDistortionCurve(28);
    this.distortion.oversample = '4x';
    
    // Exhaust/cabin bus: gentle compression keeps the synthesized V10 controlled.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 3.5;
    this.compressor.attack.value = 0.008;
    this.compressor.release.value = 0.12;

    // High-frequency intake / valvetrain texture gives the upper register more character.
    this.intakeOsc = this.ctx.createOscillator();
    this.intakeOsc.type = 'triangle';
    this.intakeOsc.frequency.value = 180;
    this.intakeFilter = this.ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 900;
    this.intakeFilter.Q.value = 0.7;
    this.intakeGain = this.ctx.createGain();
    this.intakeGain.gain.value = 0.018;
    this.intakeOsc.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.filter);

    // Connect Graph
    this.oscMain.connect(this.filter);
    this.oscSub.connect(this.subGain);
    this.subGain.connect(this.filter);
    this.oscGrowl.connect(this.growlGain);
    this.growlGain.connect(this.filter);

    this.noiseSource.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);

    this.filter.connect(this.distortion);
    this.distortion.connect(this.compressor);
    this.compressor.connect(this.masterGain);

    this.oscMain.start();
    this.oscSub.start();
    this.oscGrowl.start();
    this.intakeOsc.start();
    this.noiseSource.start();

    this.isRunning = false;
  }

  makeDistortionCurve(amount = 30) {
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // Immediate hard mute when engine is switched off or stalled
  shutDown() {
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.setTargetAtTime(0, now, 0.02);
    this.isRunning = false;
  }

  // Concussive Exhaust Fire Burst (Backfire Pop & Bang)
  triggerBackfire(intensity = 1.0) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const now = this.ctx.currentTime;
    const clampedIntensity = Math.min(1.3, Math.max(0.3, intensity));

    // Brief 35ms Ignition-Cut Audio Dip right before detonation (makes the pop hit much harder)
    if (this.isRunning) {
      const currentGain = this.masterGain.gain.value;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(currentGain, now);
      this.masterGain.gain.linearRampToValueAtTime(currentGain * 0.25, now + 0.015);
      this.masterGain.gain.linearRampToValueAtTime(currentGain, now + 0.09);
    }

    const popTime = now + 0.035; // Fires right after the brief ignition-cut vacuum dip

    // A) Low-End Muffler Thump / Detonation Wave (165Hz -> 28Hz)
    const thumpOsc = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    const thumpShaper = this.ctx.createWaveShaper();
    thumpShaper.curve = this.makeDistortionCurve(85);

    thumpOsc.type = 'triangle';
    const startFreq = 155 + Math.random() * 35;
    thumpOsc.frequency.setValueAtTime(startFreq, popTime);
    thumpOsc.frequency.exponentialRampToValueAtTime(28, popTime + 0.11);

    thumpGain.gain.setValueAtTime(0.001, popTime);
    thumpGain.gain.linearRampToValueAtTime(0.95 * clampedIntensity, popTime + 0.004);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.125);

    thumpOsc.connect(thumpShaper);
    thumpShaper.connect(thumpGain);
    thumpGain.connect(this.backfireBus);

    thumpOsc.start(popTime);
    thumpOsc.stop(popTime + 0.13);

    // B) High-Pressure Exhaust Pipe Crack (Bandpass Noise Impulse)
    const crackSource = this.ctx.createBufferSource();
    crackSource.buffer = this.noiseBuffer;

    const crackFilter = this.ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.setValueAtTime(620 + Math.random() * 180, popTime);
    crackFilter.Q.setValueAtTime(1.6, popTime);

    const crackGain = this.ctx.createGain();
    crackGain.gain.setValueAtTime(0.001, popTime);
    crackGain.gain.linearRampToValueAtTime(0.85 * clampedIntensity, popTime + 0.002);
    crackGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.115);

    crackSource.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(this.backfireBus);

    const randomOffset = Math.random() * 1.2;
    crackSource.start(popTime, randomOffset, 0.13);
  }

  triggerShift(isUpshift = true, intensity = 1) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = isUpshift ? 'triangle' : 'sawtooth';
    osc.frequency.setValueAtTime(isUpshift ? 115 : 260, now);
    osc.frequency.exponentialRampToValueAtTime(isUpshift ? 58 : 620, now + (isUpshift ? 0.095 : 0.075));
    filter.type = 'bandpass'; filter.frequency.value = isUpshift ? 240 : 760; filter.Q.value = 1.15;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16 * intensity, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(filter); filter.connect(gain); gain.connect(this.backfireBus);
    osc.start(now); osc.stop(now + 0.13);
  }

  update(rpm, throttle, engineOn, stalled, gear = 1, modeIdx = 2, audioMuted = false, engineLoad = 0) {
    const now = this.ctx.currentTime;
    this.backfireBus.gain.setTargetAtTime(audioMuted ? 0 : 0.9, now, 0.03);

    // Immediately silence masterGain if engine is off or stalled
    if (!engineOn || stalled) {
      if (this.isRunning || this.masterGain.gain.value > 0.0005) {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.setTargetAtTime(0, now, 0.02);
        this.isRunning = false;
      }
      return;
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.isRunning = true;

    // Even-fire V10 pulse rate: five combustion events per crank revolution.
    const rpmNorm = Math.max(0, (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
    const baseFreq = Math.max(38, (rpm / 60) * 5);

    // Idle lope modulation for mechanical realism
    const lope = rpm < 1350 ? Math.sin(now * 28) * 1.8 : 0;

    this.oscMain.frequency.setTargetAtTime(baseFreq + lope, now, 0.03);
    this.oscSub.frequency.setTargetAtTime(baseFreq * 0.5 + lope * 0.5, now, 0.03);
    // V10-inspired harmonic stack: a rising intake note and staggered exhaust harmonics.
    this.oscGrowl.frequency.setTargetAtTime(baseFreq * 1.498, now, 0.03);
    this.intakeOsc.frequency.setTargetAtTime(140 + rpmNorm * 980 + throttle * 220, now, 0.045);
    this.intakeFilter.frequency.setTargetAtTime(650 + rpmNorm * 1750 + throttle * 900, now, 0.06);
    this.intakeGain.gain.setTargetAtTime(0.008 + rpmNorm * 0.025 + throttle * 0.035, now, 0.06);

    // Muffler Lowpass Filter opens up with throttle load and RPM
    const modeTone = modeIdx === 0 ? 0.82 : modeIdx === 1 ? 1.0 : 1.16;
    const gearResonance = gear > 0 ? Math.min(1.25, 0.9 + gear * 0.035) : 0.78;
    const targetFilterFreq = (260 + rpmNorm * 820 + throttle * 520 + engineLoad * 180) * modeTone * gearResonance;
    this.filter.frequency.setTargetAtTime(Math.min(1650, targetFilterFreq), now, 0.05);

    // Exhaust rush bandpass tracks RPM
    this.noiseFilter.frequency.setTargetAtTime(140 + rpmNorm * 600, now, 0.05);
    this.noiseGain.gain.setTargetAtTime(0.15 + throttle * 0.35 + rpmNorm * 0.2, now, 0.05);

    // Smooth Master Volume Envelope
    const targetVolume = audioMuted ? 0 : (0.20 + throttle * 0.24 + rpmNorm * 0.20 + engineLoad * 0.04);
    this.masterGain.gain.setTargetAtTime(targetVolume, now, 0.045);
  }
}

export default function App() {
  const audioEngineRef = useRef(null);
  const speedNeedleRef = useRef(null);
  const rpmNeedleRef = useRef(null);
  const shiftLedsRef = useRef(null);
  const lastUiPublishRef = useRef(0);

  // --- UI State (Updated rapidly via rAF for rendering) ---
  const [ui, setUi] = useState({
    rpm: 0,
    speed: 0,
    gear: 0,
    modeIdx: 2,
    engineOn: false,
    throttle: 0,
    brake: 0,
    clutch: 0,
    launchActive: false,
    gameMode: 'selection', // 'selection', 'normal', 'gearhead'
    stalled: false,
    exhaustFlameIntensity: 0,
    coolantTemp: 82,
    oilTemp: 91,
    fuel: 86,
    engineWear: 0,
    engineLoad: 0,
    gForce: 0,
    distance: 0,
    audioMuted: false,
    themeIdx: 0,
    displayPage: 0,
    controllerConnected: false,
    gameModeChoice: 0,
  });

  // --- High-Performance Physics State (Refs prevent React render lag) ---
  const phys = useRef({
    rpm: 0,
    speed: 0,
    gear: 0,
    modeIdx: 2,
    engineOn: false,

    throttle: 0,
    prevThrottle: 0,
    brake: 0,
    clutch: 0,

    prevStart: false,
    prevMode: false,
    prevUp: false,
    prevDown: false,

    lastContinuousHaptic: 0,
    hapticBurstLockUntil: 0,
    lastOverrunTime: 0,
    exhaustFlameIntensity: 0,
    launchBounceOffset: 0,
    animatingStart: false,

    gameMode: 'selection',
    stalled: false,
    lastLimiterBounce: 0,
    lastAbsStutter: 0,
    coolantTemp: 82,
    oilTemp: 91,
    fuel: 86,
    engineWear: 0,
    engineLoad: 0,
    gForce: 0,
    distance: 0,
    previousSpeed: 0,
    audioMuted: false,
    themeIdx: 0,
    displayPage: 0,
    gameModeChoice: 0,
    controllerConnected: false,
    prevA: false,
    prevB: false,
    prevX: false,
    prevY: false,
    prevBack: false,
    prevDpadLeft: false,
    prevDpadUp: false,
    prevDpadDown: false,
    prevL3: false,
    lastUiPublish: 0,
    lastFrameTime: 0,
  });

  // --- Haptic Helper for One-Shot Impulses ---
  const triggerOneShotHaptic = useCallback((gp, duration, weak, strong) => {
    if (!gp?.vibrationActuator) return;
    try {
      gp.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude: Math.min(1.0, Math.max(0, weak)),
        strongMagnitude: Math.min(1.0, Math.max(0, strong)),
      });
    } catch (e) {}
  }, []);

  // --- Synchronized Exhaust Fire Burst (Low -> High -> Low -> RPM Calibrated Haptic Wave) ---
  const triggerExhaustFireBurst = useCallback((intensity = 1.0) => {
    const p = phys.current;
    if (!p.engineOn || p.stalled) return;

    // 1. Fire Concussive Web Audio Backfire (with 35ms ignition-cut dip)
    if (audioEngineRef.current) {
      audioEngineRef.current.triggerBackfire(intensity);
    }

    // 2. Multi-Stage Haptic Wave: LOW (Vacuum Dip) -> HIGH (Detonation) -> LOW (Aftershock) -> RPM Resume
    const now = performance.now();
    p.hapticBurstLockUntil = now + 225;

    const playStage = (duration, weak, strong) => {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = gamepads.find((g) => g !== null);
      if (gp?.vibrationActuator) {
        try {
          gp.vibrationActuator.playEffect('dual-rumble', {
            startDelay: 0,
            duration,
            weakMagnitude: Math.min(1.0, Math.max(0, weak)),
            strongMagnitude: Math.min(1.0, Math.max(0, strong)),
          });
        } catch (e) {}
      }
    };

    // Stage 1 (0ms - 40ms): LOW — Sudden Ignition/Fuel-Cut Drop so the upcoming spike feels massive
    playStage(40, 0.015, 0.0);

    // Stage 2 (40ms - 130ms): HIGH — Violent Exhaust Pipe Detonation Kick + Visual Flame Flash
    setTimeout(() => {
      if (!phys.current.engineOn || phys.current.stalled) return;
      playStage(90, Math.min(1.0, 0.95 * intensity), Math.min(1.0, 1.0 * intensity));
      phys.current.exhaustFlameIntensity = Math.min(
        1.4,
        Math.max(phys.current.exhaustFlameIntensity, intensity)
      );
    }, 40);

    // Stage 3 (130ms - 215ms): LOW — Muffler Resonance Tail Decay before handing back to RPM loop
    setTimeout(() => {
      if (!phys.current.engineOn || phys.current.stalled) return;
      playStage(85, Math.min(1.0, 0.16 * intensity), Math.min(1.0, 0.07 * intensity));
    }, 130);
  }, []);

  const triggerSmoothHaptics = useCallback((gp, rpm) => {
    if (!gp?.vibrationActuator) return;
    const now = performance.now();

    // Respect haptic burst lock so exhaust backfire kicks aren't overwritten
    if (now < phys.current.hapticBurstLockUntil) return;

    // Overlapping 100ms triggers to prevent "stuttering" motor reset
    if (now - phys.current.lastContinuousHaptic < 100) return;
    phys.current.lastContinuousHaptic = now;

    let weak = 0;
    let strong = 0;

    if (rpm < 4000) {
      // Calibrated Idle (800 RPM = 0.005 barely noticeable heartbeat) scaling smoothly to 4000 RPM
      const lowProgress = Math.max(0, (rpm - IDLE_RPM) / (4000 - IDLE_RPM));
      weak = 0.005 + lowProgress * 0.045;
      strong = lowProgress * 0.015;
    } else {
      // Quadratic curve + subtle mechanical combustion flutter for raw engine feel
      const progress = (rpm - 4000) / (REDLINE_RPM - 4000);
      const baseIntensity = Math.min(1.0, progress * progress);
      const flutter = (Math.random() - 0.5) * 0.08 * progress;
      weak = Math.min(1.0, Math.max(0.05, baseIntensity + flutter));
      strong = Math.min(1.0, Math.max(0.015, baseIntensity * 0.85 + flutter));
    }

    try {
      gp.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: 150, // Slightly longer than interval to blend smoothly
        weakMagnitude: weak,
        strongMagnitude: strong,
      });
    } catch (e) {}
  }, []);

  // --- Engine Ignition Toggle Helper ---
  const toggleEngine = useCallback(
    (gp = null) => {
      const p = phys.current;
      if (!audioEngineRef.current) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) audioEngineRef.current = new V10EngineSound();
      } else if (audioEngineRef.current.ctx.state === 'suspended') {
        audioEngineRef.current.ctx.resume();
      }

      if (p.engineOn) {
        p.engineOn = false;
        p.rpm = 0;
        p.exhaustFlameIntensity = 0;
        // Immediately kill engine sound and stop controller vibration
        audioEngineRef.current?.shutDown();
        if (gp) triggerOneShotHaptic(gp, 40, 0, 0);
      } else {
        p.stalled = false;
        p.engineOn = true;
        p.animatingStart = true;
        if (gp) triggerOneShotHaptic(gp, 800, 0.6, 1.0); // Startup roar

        // Fire an aggressive ignition bark on startup
        setTimeout(() => {
          if (phys.current.engineOn) {
            triggerExhaustFireBurst(0.9);
          }
        }, 180);

        // Gauge Sweep
        p.rpm = REDLINE_RPM + 1000;
        p.speed = MAX_SPEED;
        setTimeout(() => {
          if (phys.current.engineOn) {
            phys.current.rpm = IDLE_RPM;
            phys.current.speed = 0;
          }
          phys.current.animatingStart = false;
        }, 800);
      }
    },
    [triggerOneShotHaptic, triggerExhaustFireBurst]
  );

  // --- Physics & Gamepad Loop ---
  const updatePhysics = useCallback(
    (gp, dtScale = 1) => {
      const p = phys.current;

      // Decay visual exhaust flame smoothly every frame
      if (p.exhaustFlameIntensity > 0.01) {
        p.exhaustFlameIntensity *= Math.pow(0.82, dtScale);
      } else {
        p.exhaustFlameIntensity = 0;
      }

      if (p.animatingStart) return;

      const now = performance.now();

      // 1. Read Inputs
      if (gp) {
        p.prevThrottle = p.throttle;
        p.clutch = gp.buttons[6]?.value || 0; // LT mapped to clutch
        p.throttle = gp.buttons[7]?.value || 0; // RT mapped to throttle
        p.brake = Math.max(0, gp.axes[1] || 0); // L-Stick Down mapped to brake

        const btnStart = gp.buttons[9]?.pressed; // Start/Menu
        const btnMode = gp.buttons[15]?.pressed; // D-Pad Right
        const dpadRight = btnMode;
        const btnUp = gp.buttons[5]?.pressed; // RB
        const btnDown = gp.buttons[4]?.pressed; // LB
        const btnA = gp.buttons[0]?.pressed;
        const btnB = gp.buttons[1]?.pressed;
        const btnX = gp.buttons[2]?.pressed;
        const btnY = gp.buttons[3]?.pressed;
        const btnBack = gp.buttons[8]?.pressed;
        const dpadLeft = gp.buttons[14]?.pressed;
        const dpadUp = gp.buttons[12]?.pressed;
        const dpadDown = gp.buttons[13]?.pressed;
        const btnL3 = gp.buttons[10]?.pressed;
        p.controllerConnected = true;

        // Controller-first boot menu and cockpit navigation.
        if (p.gameMode === 'selection') {
          if ((dpadLeft && !p.prevDpadLeft) || (dpadRight && !p.prevMode)) { p.gameModeChoice = (p.gameModeChoice + 1) % 2; triggerOneShotHaptic(gp, 28, 0.12, 0.05); }
          if (btnA && !p.prevA) {
            p.gameMode = p.gameModeChoice === 0 ? 'normal' : 'gearhead';
            triggerOneShotHaptic(gp, 75, 0.28, 0.16);
            if (!audioEngineRef.current) {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              if (AudioCtx) audioEngineRef.current = new V10EngineSound();
            }
          }
        } else {
          if (btnBack && !p.prevBack) { p.displayPage = (p.displayPage + 1) % 4; triggerOneShotHaptic(gp, 28, 0.12, 0.05); }
          if (dpadLeft && !p.prevDpadLeft) { p.displayPage = (p.displayPage + 3) % 4; triggerOneShotHaptic(gp, 28, 0.12, 0.05); }
          if (dpadRight && !p.prevMode) { p.displayPage = (p.displayPage + 1) % 4; triggerOneShotHaptic(gp, 28, 0.12, 0.05); }
          if (dpadUp && !p.prevDpadUp) { p.modeIdx = (p.modeIdx + 1) % MODES.length; triggerOneShotHaptic(gp, 48, 0.24, 0.12); }
          if (dpadDown && !p.prevDpadDown) { p.modeIdx = (p.modeIdx + MODES.length - 1) % MODES.length; triggerOneShotHaptic(gp, 48, 0.24, 0.12); }
          if (btnY && !p.prevY) { p.audioMuted = !p.audioMuted; triggerOneShotHaptic(gp, 35, 0.18, 0.08); }
          if (btnX && !p.prevX) { p.themeIdx = (p.themeIdx + 1) % 3; triggerOneShotHaptic(gp, 35, 0.18, 0.08); }
          if (btnL3 && !p.prevL3 && p.engineOn && !p.stalled) triggerExhaustFireBurst(0.95);
          if (btnB && !p.prevB) p.displayPage = 0;
          if (btnA && !p.prevA && p.stalled) toggleEngine(gp);
        }

        // Engine Toggle
        if (btnStart && !p.prevStart && p.gameMode !== 'selection') {
          toggleEngine(gp);
        }

        // High-RPM Throttle Lift-Off Overrun Pops & Bangs (Burble Tune)
        if (
          p.engineOn &&
          !p.stalled &&
          p.rpm > 5200 &&
          p.prevThrottle > 0.35 &&
          p.throttle < 0.08 &&
          now - p.lastOverrunTime > 380
        ) {
          p.lastOverrunTime = now;
          const popDelays =
            p.modeIdx === 2
              ? [0, 90, 195, 305] // SPORT+ aggressive 4-pop overrun
              : p.modeIdx === 1
              ? [0, 110, 230] // SPORT 3-pop overrun
              : [0, 130]; // ECO 2-pop overrun

          popDelays.forEach((delay, idx) => {
            setTimeout(() => {
              if (phys.current.engineOn && !phys.current.stalled && phys.current.throttle < 0.2) {
                const burstPower = Math.max(0.55, 1.0 - idx * 0.15);
                triggerExhaustFireBurst(burstPower);
              }
            }, delay);
          });
        }

        // Sequential Shifting Logic
        if (p.engineOn && !p.animatingStart && !p.stalled) {
          let shiftTriggered = false;
          let isUpshift = false;
          let isDownshift = false;
          let newGear = p.gear;

          if (btnUp && !p.prevUp && p.gear < 6) {
            newGear++;
            shiftTriggered = true;
            isUpshift = true;
          }
          if (btnDown && !p.prevDown && p.gear > -1) {
            newGear--;
            shiftTriggered = true;
            isDownshift = true;
          }

          if (shiftTriggered && newGear !== p.gear) {
            if (p.gameMode === 'gearhead' && p.clutch < 0.5 && p.gear !== 0) {
              // Missed shift grind
              triggerOneShotHaptic(gp, 300, 1.0, 1.0);
            } else {
              // Shift quality + Exhaust Fire Burst on aggressive shifts
              if (isDownshift && p.rpm > 4000) {
                // Aggressive Rev-Match Downshift Bark + Crackle
                triggerExhaustFireBurst(1.0);
                setTimeout(() => triggerExhaustFireBurst(0.75), 85);
              } else if (isUpshift && p.rpm > 7000) {
                // High-RPM Ignition Cut Upshift Bang
                triggerExhaustFireBurst(0.95);
              } else if (p.rpm >= 8500 && p.rpm <= 9500) {
                triggerOneShotHaptic(gp, 80, 0.8, 0.2); // Crisp shift
              } else {
                triggerOneShotHaptic(gp, 200, 0.5, 0.9); // Lower-RPM mechanical clunk
              }
              audioEngineRef.current?.triggerShift(isUpshift, Math.min(1.25, 0.75 + p.rpm / REDLINE_RPM * 0.45));
              p.gear = newGear;
            }
          }
        }

        p.prevStart = btnStart;
        p.prevMode = btnMode;
        p.prevUp = btnUp;
        p.prevDown = btnDown;
        p.prevA = !!btnA;
        p.prevB = !!btnB;
        p.prevX = !!btnX;
        p.prevY = !!btnY;
        p.prevBack = !!btnBack;
        p.prevDpadLeft = !!dpadLeft;
        p.prevDpadUp = !!dpadUp;
        p.prevDpadDown = !!dpadDown;
        p.prevL3 = !!btnL3;
      }

      if (!gp) { p.controllerConnected = false; p.throttle = 0; p.brake = 0; p.clutch = 0; }
      if (p.gameMode === 'selection') return;

      // Lightweight vehicle telemetry model (simulated, not real vehicle sensors).
      const targetCoolant = 82 + (p.engineOn ? p.throttle * 42 + Math.min(20, p.speed * 0.055) : -10);
      const targetOil = 90 + (p.engineOn ? p.rpm / REDLINE_RPM * 35 : -14);
      p.coolantTemp += (targetCoolant - p.coolantTemp) * 0.0018 * dtScale;
      p.oilTemp += (targetOil - p.oilTemp) * 0.0014 * dtScale;
      p.engineLoad = p.engineOn ? Math.min(1, p.throttle * 0.72 + p.rpm / REDLINE_RPM * 0.28) : 0;
      const speedDelta = Math.abs(p.speed) - p.previousSpeed;
      p.gForce = Math.max(-1.8, Math.min(1.8, speedDelta * 0.075));
      p.previousSpeed = Math.abs(p.speed);
      p.distance += Math.abs(p.speed) / 3600 * (dtScale / 60);
      if (p.engineOn && !p.stalled) {
        p.fuel = Math.max(0, p.fuel - (0.000015 + p.throttle * 0.00012 + p.rpm / REDLINE_RPM * 0.000025) * dtScale);
        if (p.coolantTemp > 118 || p.oilTemp > 132) p.engineWear = Math.min(100, p.engineWear + 0.0015 * dtScale);
        if (p.coolantTemp > 130 || p.engineWear >= 100 || p.fuel <= 0) {
          p.stalled = true; p.engineOn = false; p.rpm = 0;
          audioEngineRef.current?.shutDown();
          triggerOneShotHaptic(gp, 650, 1, 1);
        }
      }

      // 2. Engine Off or Stalled Dynamics
      if (!p.engineOn || p.stalled) {
        p.speed = Math.max(0, p.speed - (p.brake * 3 + 0.2) * dtScale); // Coasting
        p.rpm = 0;
        audioEngineRef.current?.shutDown();
        return;
      }

      const modeMult = MODE_MULT[MODES[p.modeIdx]];
      const isEngaged = p.gear !== 0 && (p.gameMode === 'normal' || p.clutch < 0.5);

      // Gearhead Specifics
      if (p.gameMode === 'gearhead') {
        // Clutch Bite Point Flutter
        if (p.clutch > 0.4 && p.clutch < 0.6 && p.gear !== 0) {
          triggerOneShotHaptic(gp, 50, 0.3, 0.0);
        }

        // Engine Stalling
        if (p.gear !== 0 && p.speed < 5 && p.clutch < 0.2 && p.throttle < 0.1 && p.rpm < 1000) {
          p.stalled = true;
          p.engineOn = false;
          p.rpm = 0;
          audioEngineRef.current?.shutDown();
          triggerOneShotHaptic(gp, 400, 1.0, 1.0);
          return;
        }

        // ABS Feedback
        if (p.brake > 0.8 && p.speed > 50) {
          if (now - p.lastAbsStutter > 60) {
            triggerOneShotHaptic(gp, 40, 1.0, 0.5);
            p.lastAbsStutter = now;
          }
        }
      }

      // Launch Control Check (2-Step Antilag Fire Bursts)
      const isLaunching =
        p.speed < 2 &&
        p.brake > 0.5 &&
        p.throttle > 0.5 &&
        p.gear === 1 &&
        (p.gameMode === 'normal' || p.clutch > 0.8);

      if (isLaunching) {
        p.launchBounceOffset = (p.launchBounceOffset + 0.4 * dtScale) % (Math.PI * 2);
        p.rpm = 5500 + Math.sin(p.launchBounceOffset) * 300;
        if (now - p.lastLimiterBounce > 125) {
          triggerExhaustFireBurst(0.95);
          p.lastLimiterBounce = now;
        }
      } else if (isEngaged) {
        // In Gear Acceleration
        const maxSpeedForGear = GEAR_MAX_SPEEDS[p.gear] || 1;
        const drag = p.speed * p.speed * 0.000015 + 0.05;

        let accel = p.throttle * modeMult * 1.6 - drag;

        if (p.gameMode === 'gearhead') {
          if (p.rpm >= REDLINE_RPM - 150) {
            accel = -1.5;
            if (now - p.lastLimiterBounce > 95) {
              triggerExhaustFireBurst(1.15);
              p.rpm = 9100;
              p.lastLimiterBounce = now;
            }
          }
          // Lugging (High gear, low RPM)
          if (p.gear > 3 && p.rpm < 2000 && p.throttle > 0.5) {
            accel *= 0.1;
            triggerSmoothHaptics(gp, REDLINE_RPM);
          }
        } else {
          if (p.rpm >= REDLINE_RPM - 150) {
            accel = -0.5;
            if (now - p.lastLimiterBounce > 110) {
              triggerExhaustFireBurst(1.0);
              p.lastLimiterBounce = now;
            }
          }
        }

        let speedChange = accel - p.brake * 4;
        if (p.gear === -1) speedChange = -speedChange;

        p.speed += speedChange * dtScale;

        // Speed Constraints
        if (p.speed < 0 && p.gear !== -1) p.speed = 0;
        if (p.speed > 0 && p.gear === -1) p.speed = 0;
        if (Math.abs(p.speed) > MAX_SPEED) p.speed = Math.sign(p.speed) * MAX_SPEED;

        const speedRatio = Math.abs(p.speed) / maxSpeedForGear;
        p.rpm = Math.max(IDLE_RPM, speedRatio * REDLINE_RPM);
      } else {
        // Neutral Revving
        const rpmAccel = p.throttle * 1200 * modeMult;
        const rpmDecel = 400;

        p.rpm += (rpmAccel - rpmDecel) * dtScale;
        if (p.rpm < IDLE_RPM) p.rpm = IDLE_RPM;

        if (p.rpm >= REDLINE_RPM - 150) {
          if (now - p.lastLimiterBounce > 90) {
            p.rpm = p.gameMode === 'gearhead' ? 9050 : REDLINE_RPM - (Math.random() * 400 + 100);
            triggerExhaustFireBurst(1.1);
            p.lastLimiterBounce = now;
          }
        }

        p.speed = Math.max(0, p.speed - (p.brake * 3 + 0.1) * dtScale);
      }


      // Apply continuous calibrated engine vibration if running
      if (
        p.engineOn &&
        !isLaunching &&
        !(p.gameMode === 'gearhead' && p.gear > 3 && p.rpm < 2000 && p.throttle > 0.5)
      ) {
        triggerSmoothHaptics(gp, p.rpm);
      }
    },
    [toggleEngine, triggerExhaustFireBurst, triggerOneShotHaptic, triggerSmoothHaptics]
  );

  // --- High-refresh simulation loop: direct DOM gauge updates + low-frequency React snapshots. ---
  useEffect(() => {
    let animationFrameId;
    let previousTime = performance.now();
    let lastAudioUpdate = 0;
    const loop = (time) => {
      const dtScale = Math.min(2, Math.max(0, (time - previousTime) / 16.6667));
      previousTime = time;
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = gamepads.find((g) => g !== null);
      updatePhysics(gp, dtScale || 1);

      const p = phys.current;
      if (audioEngineRef.current && time - lastAudioUpdate >= 30) {
        lastAudioUpdate = time;
        audioEngineRef.current.update(p.rpm, p.throttle, p.engineOn, p.stalled, p.gear, p.modeIdx, p.audioMuted, p.engineLoad);
      }

      // Animate critical needles on every display refresh without scheduling a React render.
      if (speedNeedleRef.current) speedNeedleRef.current.style.transform = `rotate(${-135 + Math.min(1, Math.abs(p.speed) / MAX_SPEED) * 270}deg)`;
      if (rpmNeedleRef.current) rpmNeedleRef.current.style.transform = `rotate(${-135 + Math.min(1, p.rpm / REDLINE_RPM) * 270}deg)`;
      if (shiftLedsRef.current) shiftLedsRef.current.style.setProperty('--shift-progress', String(p.engineOn ? Math.max(0, (p.rpm - 4000) / (REDLINE_RPM - 4000)) : 0));

      // 24 Hz UI snapshots are enough for labels/telemetry; the needles stay refresh-rate smooth.
      if (time - lastUiPublishRef.current >= 40) {
        lastUiPublishRef.current = time;
        setUi({
          rpm: p.rpm, speed: Math.abs(p.speed), gear: p.gear, modeIdx: p.modeIdx,
          engineOn: p.engineOn, throttle: p.throttle, brake: p.brake, clutch: p.clutch,
          launchActive: p.gear === 1 && p.brake > 0.5 && p.throttle > 0.5 && p.speed < 2,
          gameMode: p.gameMode, stalled: p.stalled, exhaustFlameIntensity: p.exhaustFlameIntensity,
          coolantTemp: p.coolantTemp, oilTemp: p.oilTemp, fuel: p.fuel, engineWear: p.engineWear,
          engineLoad: p.engineLoad, gForce: p.gForce, distance: p.distance, audioMuted: p.audioMuted,
          themeIdx: p.themeIdx, displayPage: p.displayPage, controllerConnected: p.controllerConnected,
          gameModeChoice: p.gameModeChoice,
        });
      }
      animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [updatePhysics]);

  // All driving and cockpit navigation input is read exclusively from the Gamepad API.



  useEffect(() => () => {
    if (audioEngineRef.current?.ctx && audioEngineRef.current.ctx.state !== 'closed') {
      audioEngineRef.current.ctx.close().catch(() => {});
    }
  }, []);

  const formatGear = (g) => (g === -1 ? 'R' : g === 0 ? 'N' : g);

  // --- Calculate Gauge Needle Angles (-135 deg to +135 deg) ---
  // --- F1 Shift Lights Sync (4,000 RPM to 10,000 RPM) ---
  const totalShiftLeds = 15;
  const shiftProgress = ui.engineOn ? Math.max(0, (ui.rpm - 4000) / (REDLINE_RPM - 4000)) : 0;
  const activeShiftLeds = Math.floor(shiftProgress * totalShiftLeds);
  const isShiftFlash = ui.rpm >= 9200;

  const speedLabels = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const rpmLabels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:ital,wght@0,500;0,700;0,900;1,700;1,900&family=Rajdhani:wght@500;600;700&display=swap');

        .font-tech {
          font-family: 'Orbitron', sans-serif;
        }
        .font-hud {
          font-family: 'Rajdhani', sans-serif;
        }
        .carbon-bg {
          background-color: #050507;
          background-image: 
            radial-gradient(circle at 50% 35%, rgba(220, 20, 20, 0.12) 0%, transparent 65%),
            repeating-linear-gradient(45deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 2px, transparent 2px, transparent 4px);
        }
        .dial-shadow {
          box-shadow: 
            inset 0 0 60px rgba(0, 0, 0, 0.95),
            0 0 35px rgba(255, 0, 0, 0.18),
            inset 0 0 20px rgba(255, 20, 20, 0.15);
        }
        @keyframes redlineStrobe {
          0%, 100% { opacity: 1; transform: scale(1.06); }
          50% { opacity: 0.25; transform: scale(0.98); }
        }
        .shift-flash {
          animation: redlineStrobe 0.09s infinite;
        }
      `}</style>

      <div className="simulator-page min-h-screen w-full flex flex-col items-center justify-center bg-[#020202] relative overflow-x-hidden select-none px-4 py-8">
        {/* Mode Selection Overlay */}
        {ui.gameMode === 'selection' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md">
            <div className="max-w-3xl w-full mx-4 p-8 rounded-3xl bg-gradient-to-b from-[#111116] to-[#07070a] border border-gray-800 shadow-[0_0_80px_rgba(255,0,0,0.2)] text-center">
              <div className="inline-block px-3 py-1 rounded-full bg-red-950/60 border border-red-500/40 text-red-400 font-tech text-xs tracking-widest mb-3">
                HYPERCAR TELEMETRY & HAPTIC SIMULATOR
              </div>
              <h1 className="font-tech text-3xl md:text-4xl font-black text-white tracking-wider mb-2">
                SELECT DRIVING EXPERIENCE
              </h1>
              <p className="font-hud text-gray-400 text-lg mb-8">
                Connect a controller. All cockpit navigation and driving inputs are gamepad-only.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-left">
                {/* Normal Mode Card */}
                <div
                  className={`group p-6 rounded-2xl bg-gradient-to-b from-gray-900/90 to-black border ${ui.gameModeChoice === 0 ? 'border-[#39ff14] shadow-[0_0_30px_rgba(57,255,20,0.2)]' : 'border-gray-700'} transition-all shadow-lg`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-tech text-xl font-bold text-white group-hover:text-[#39ff14] transition-colors">
                      NORMAL MODE
                    </span>
                    <span className="px-2.5 py-0.5 text-xs font-tech rounded bg-green-950 text-[#39ff14] border border-[#39ff14]/40">
                      CINEMATIC
                    </span>
                  </div>
                  <p className="font-hud text-gray-400 text-base mb-4">
                    Smooth paddle-shift experience with auto-clutch, quadratic RPM haptics, launch control, and exhaust overrun pops.
                  </p>
                  <ul className="font-hud text-sm text-gray-300 space-y-1.5">
                    <li>• Auto-Clutch Sequential Shifting (RB / LB)</li>
                    <li>• Calibrated 800–10,000 RPM Smooth Haptics</li>
                    <li>• Exhaust Fire Bursts & Overrun Burbles</li>
                  </ul>
                </div>

                {/* Gearhead Pro Mode Card */}
                <div
                  className={`group p-6 rounded-2xl bg-gradient-to-b from-red-950/30 to-black border ${ui.gameModeChoice === 1 ? 'border-red-500 shadow-[0_0_35px_rgba(255,0,0,0.3)]' : 'border-red-900/60'} transition-all shadow-lg`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-tech text-xl font-bold text-white group-hover:text-red-400 transition-colors">
                      GEARHEAD PRO
                    </span>
                    <span className="px-2.5 py-0.5 text-xs font-tech rounded bg-red-950 text-red-400 border border-red-500/40">
                      HARDCORE SIM
                    </span>
                  </div>
                  <p className="font-hud text-gray-400 text-base mb-4">
                    Full mechanical physics: manual analog clutch on LT, bite-point flutter, engine stalling, gear grinding, and ABS brake pulse.
                  </p>
                  <ul className="font-hud text-sm text-gray-300 space-y-1.5">
                    <li>• Analog Clutch (LT) + Bite-Point Haptic Flutter</li>
                    <li>• Real Engine Stalling, Lugging & Gear Grind</li>
                    <li>• Violent Fuel-Cut Rev Limiter & ABS Stutter</li>
                  </ul>
                </div>
              </div>
              <div className={`mt-7 font-tech text-[11px] tracking-[0.22em] ${ui.controllerConnected ? 'text-gray-400' : 'text-amber-400 animate-pulse'}`}>
                {ui.controllerConnected ? 'D-PAD ◀ ▶ SELECT EXPERIENCE · A CONFIRM' : 'CONNECT GAMEPAD · WAITING FOR CONTROLLER'}
              </div>
            </div>
          </div>
        )}

        {/* Engine Stalled Overlay (Gearhead Mode) */}
        {ui.stalled && ui.gameMode !== 'selection' && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-red-950/40 backdrop-blur-sm pointer-events-auto">
            <div className="p-8 rounded-3xl bg-black/95 border-2 border-red-600 shadow-[0_0_70px_rgba(255,0,0,0.6)] text-center max-w-md">
              <div className="font-tech text-4xl font-black text-red-500 tracking-widest mb-2 animate-pulse">
                ENGINE STALLED
              </div>
              <p className="font-hud text-gray-300 text-lg mb-6">
                Clutch was released too quickly at low RPM without enough throttle. Press A on your controller to re-ignite.
              </p>
<div className="font-tech text-xs tracking-widest text-red-300">A · RESTART ENGINE</div>
            </div>
          </div>
        )}

        {/* Main Futuristic Cluster Frame */}
        <div className={`cluster-frame theme-${ui.themeIdx} relative w-full max-w-[1120px] min-h-[540px] carbon-bg rounded-[64px] border-[3px] border-[#25252b] shadow-[0_25px_90px_rgba(0,0,0,0.95),inset_0_0_80px_rgba(0,0,0,0.9)] flex flex-col items-center justify-between px-10 py-6 overflow-hidden`}>
          {/* Top Red Neon Accent Trim */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-[3px] bg-gradient-to-r from-transparent via-red-600 to-transparent opacity-80" />

          {/* F1 Shift Lights Array (Top Center) */}
          <div ref={shiftLedsRef} className="shift-leds w-full max-w-md flex items-center justify-center gap-1.5 z-20 pt-1">
            {Array.from({ length: totalShiftLeds }).map((_, idx) => {
              const isActive = idx < activeShiftLeds;
              let colorClass = 'bg-gray-900 border-gray-800 opacity-35';
              if (isActive) {
                if (idx < 5) {
                  colorClass = 'bg-[#00ff44] border-[#80ffaa] shadow-[0_0_12px_#00ff44] opacity-100';
                } else if (idx < 10) {
                  colorClass = 'bg-[#ffdd00] border-[#ffee88] shadow-[0_0_12px_#ffdd00] opacity-100';
                } else {
                  colorClass = 'bg-[#ff0022] border-[#ff8899] shadow-[0_0_16px_#ff0022] opacity-100';
                }
              }
              return (
                <div
                  key={idx}
                  className={`h-2.5 flex-1 rounded-sm border transition-all duration-75 ${colorClass} ${
                    isShiftFlash && isActive ? 'shift-flash' : ''
                  }`}
                />
              );
            })}
          </div>

          {/* Three-Column Instrument Cluster: Left Speedometer | Center Display | Right Tachometer */}
          <div className="dashboard-layout w-full flex-1 flex items-center justify-between gap-4 z-10 my-1">
            {/* LEFT DIAL: SPEEDOMETER */}
            <div className="gauge-dial relative rounded-full bg-gradient-to-b from-[#121217] to-[#050508] border-[4px] border-[#2c2c34] dial-shadow flex items-center justify-center">
              {/* Outer Glowing Crimson Ring */}
              <div className="absolute inset-2 rounded-full border border-red-600/35 pointer-events-none" />

              {/* Speedometer Ticks & Numbers */}
              {speedLabels.map((val, i) => {
                const angle = -135 + (i / (speedLabels.length - 1)) * 270;
                const rad = ((angle - 90) * Math.PI) / 180;
                const numRadius = 132;
                const x = Math.cos(rad) * numRadius;
                const y = Math.sin(rad) * numRadius;
                const isHighSpeed = val >= 240;

                return (
                  <React.Fragment key={val}>
                    {/* Major Tick */}
                    <div
                      className="absolute w-full h-full top-0 left-0 pointer-events-none"
                      style={{ transform: `rotate(${angle}deg)` }}
                    >
                      <div
                        className={`mx-auto mt-3 w-[3px] h-4 rounded-full ${
                          isHighSpeed
                            ? 'bg-red-500 shadow-[0_0_8px_#ff0000]'
                            : 'bg-gray-200'
                        }`}
                      />
                    </div>
                    {/* Number Label */}
                    <div
                      className={`absolute font-tech text-xs font-bold tracking-tighter ${
                        isHighSpeed ? 'text-red-500' : 'text-gray-200'
                      }`}
                      style={{
                        transform: `translate(${x}px, ${y}px)`,
                      }}
                    >
                      {val}
                    </div>
                  </React.Fragment>
                );
              })}

              {/* Speedometer Needle */}
              <div ref={speedNeedleRef} className="absolute inset-0 pointer-events-none will-change-transform" style={{ transform: 'rotate(-135deg)' }}>
                <div className="mx-auto mt-7 w-1.5 h-36 bg-gradient-to-b from-white via-red-500 to-red-900 rounded-full shadow-[0_0_16px_#ff1a1a]" />
              </div>

              {/* Center Digital Speed Hub */}
              <div className="w-44 h-44 rounded-full bg-gradient-to-b from-[#0c0c10] to-[#040406] border border-gray-800 shadow-[inset_0_0_30px_rgba(0,0,0,0.95)] flex flex-col items-center justify-center z-10">
                <span className="font-tech italic text-6xl font-black text-white tracking-tight drop-shadow-[0_0_12px_rgba(255,255,255,0.25)]">
                  {Math.round(ui.speed)}
                </span>
                <span className="font-hud text-sm font-semibold text-gray-400 tracking-widest mt-1">
                  km/h
                </span>
              </div>
            </div>

            {/* CENTER CONSOLE: TELEMETRY, DRIVE MODE & 3D CAR SILHOUETTE */}
            <div className="center-console relative flex-1 h-full flex flex-col items-center justify-between py-2">
              {/* Top Status Row (Temp, Brand Stripes, Clock) */}
              <div className="w-full px-4 flex items-center justify-between font-hud text-gray-300 text-base tracking-wider border-b border-red-900/30 pb-2">
                <span className={ui.coolantTemp > 118 ? "text-red-400 animate-pulse" : ""}>ECT {Math.round(ui.coolantTemp)}°C</span>
                <div className="flex items-center gap-1">
                  <span className="w-2 h-3.5 -skew-x-12 bg-gray-500 inline-block" />
                  <span className="w-2 h-3.5 -skew-x-12 bg-gray-400 inline-block" />
                  <span className="w-2 h-3.5 -skew-x-12 bg-red-600 inline-block shadow-[0_0_8px_#ff0000]" />
                </div>
                <span>{ui.controllerConnected ? "GAMEPAD LINK" : "NO CONTROLLER"}</span>
              </div>

              {/* Drive Mode & Launch Status Banner */}
              <div className="my-1 text-center">
                {ui.launchActive ? (
                  <div className="px-4 py-1 rounded bg-red-600/20 border border-red-500 text-red-400 font-tech text-xs tracking-widest animate-pulse shadow-[0_0_20px_rgba(255,0,0,0.4)]">
                    LAUNCH CONTROL ACTIVE (2-STEP)
                  </div>
                ) : ui.engineOn ? (
                  <div className="font-tech italic text-lg font-bold tracking-[0.2em] text-red-500 drop-shadow-[0_0_10px_rgba(255,0,0,0.5)]">
                    {MODES[ui.modeIdx]}
                  </div>
                ) : (
                  <span className="text-red-500 font-tech text-xs tracking-widest opacity-60 block">
                    SYSTEM STANDBY — PRESS START
                  </span>
                )}
              </div>

              {/* Controller-driven cockpit information pages. */}
              {ui.gameMode !== 'selection' && (
                <div className="cockpit-data-panel w-full min-h-[62px] px-3 py-2 rounded-xl border border-white/10 bg-black/45">
                  <div className="flex items-center justify-between text-[9px] font-tech tracking-[0.2em] text-gray-500 mb-2">
                    <span>{['DRIVE COMPUTER', 'LIVE TELEMETRY', 'POWERTRAIN STATUS', 'COCKPIT SETTINGS'][ui.displayPage]}</span>
                    <span>PAGE {ui.displayPage + 1}/4</span>
                  </div>
                  {ui.displayPage === 0 && <div className="grid grid-cols-4 gap-2 text-center">{[['COOLANT', `${Math.round(ui.coolantTemp)}°C`], ['OIL', `${Math.round(ui.oilTemp)}°C`], ['FUEL', `${Math.round(ui.fuel)}%`], ['LOAD', `${Math.round(ui.engineLoad * 100)}%`]].map(([k,v]) => <div key={k}><div className="text-[9px] text-gray-500 font-tech">{k}</div><div className="text-sm text-white font-tech">{v}</div></div>)}</div>}
                  {ui.displayPage === 1 && <div className="grid grid-cols-4 gap-2 text-center">{[['G-FORCE', `${ui.gForce >= 0 ? '+' : ''}${ui.gForce.toFixed(2)}G`], ['THROTTLE', `${Math.round(ui.throttle * 100)}%`], ['BRAKE', `${Math.round(ui.brake * 100)}%`], ['CLUTCH', `${Math.round(ui.clutch * 100)}%`]].map(([k,v]) => <div key={k}><div className="text-[9px] text-gray-500 font-tech">{k}</div><div className="text-sm text-white font-tech">{v}</div></div>)}</div>}
                  {ui.displayPage === 2 && <div className="grid grid-cols-4 gap-2 text-center">{[['ENGINE', ui.engineOn ? 'RUNNING' : 'OFF'], ['WEAR', `${Math.round(ui.engineWear)}%`], ['TRIP', `${ui.distance.toFixed(2)} KM`], ['TEMP', ui.coolantTemp > 118 ? 'WARNING' : 'NORMAL']].map(([k,v]) => <div key={k}><div className="text-[9px] text-gray-500 font-tech">{k}</div><div className={`text-sm font-tech ${k === 'TEMP' && ui.coolantTemp > 118 ? 'text-red-400' : 'text-white'}`}>{v}</div></div>)}</div>}
                  {ui.displayPage === 3 && <div className="flex items-center justify-around text-[10px] font-tech tracking-wider text-gray-300"><span>THEME {['CRIMSON', 'ICE BLUE', 'AMBER'][ui.themeIdx]}</span><span>AUDIO {ui.audioMuted ? 'MUTED' : 'LIVE'}</span><span>Y AUDIO · X THEME</span></div>}
                </div>
              )}

              {/* Center Sports Car Rear Silhouette + Dynamic Twin Exhaust Fire Burst */}
              <div className="relative w-64 h-36 flex items-center justify-center">
                {/* Perspective Highway Grid Lines */}
                <div
                  className="absolute bottom-2 w-48 h-20 opacity-30 pointer-events-none"
                  style={{
                    background:
                      'linear-gradient(to bottom, transparent, rgba(255,0,0,0.12)), repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0.08) 1px, transparent 1px, transparent 24px)',
                    transform: 'perspective(120px) rotateX(60deg)',
                  }}
                />

                {/* Ambient Backfire Ground Glow */}
                <div
                  className="absolute bottom-2 w-44 h-10 rounded-full pointer-events-none transition-opacity duration-75"
                  style={{
                    opacity: Math.min(1, ui.exhaustFlameIntensity),
                    background:
                      'radial-gradient(circle, rgba(255,115,0,0.85) 0%, rgba(255,0,0,0.4) 55%, transparent 80%)',
                    filter: 'blur(8px)',
                  }}
                />

                {/* Car Rear Vector Silhouette */}
                <svg viewBox="0 0 220 110" className="w-52 h-28 z-10 overflow-visible">
                  {/* Shadow */}
                  <ellipse cx="110" cy="94" rx="74" ry="8" fill="rgba(0,0,0,0.85)" />
                  {/* Rear Tires */}
                  <rect
                    x="38"
                    y="64"
                    width="22"
                    height="28"
                    rx="4"
                    fill="#111"
                    stroke="#222"
                    strokeWidth="1.5"
                  />
                  <rect
                    x="160"
                    y="64"
                    width="22"
                    height="28"
                    rx="4"
                    fill="#111"
                    stroke="#222"
                    strokeWidth="1.5"
                  />
                  {/* Widebody Chassis */}
                  <path
                    d="M 42 78 L 36 56 L 54 36 L 78 22 L 142 22 L 166 36 L 184 56 L 178 78 Z"
                    fill="#0b0b0e"
                    stroke="#2a2a35"
                    strokeWidth="1.5"
                  />
                  {/* Rear Glass / Engine Decklid */}
                  <path
                    d="M 76 26 L 144 26 L 154 42 L 66 42 Z"
                    fill="#16161d"
                    stroke="#333"
                    strokeWidth="1"
                  />
                  {/* Diffuser Fins */}
                  <path
                    d="M 55 78 L 165 78 L 158 88 L 62 88 Z"
                    fill="#070709"
                    stroke="#222"
                    strokeWidth="1"
                  />

                  {/* LED Taillights (glow brighter under braking) */}
                  <path
                    d="M 44 52 L 82 54 L 78 60 L 42 58 Z"
                    fill={ui.brake > 0.1 ? '#ff1a1a' : '#b30000'}
                    style={{
                      filter:
                        ui.brake > 0.1
                          ? 'drop-shadow(0 0 10px #ff0000)'
                          : 'drop-shadow(0 0 4px #ff0000)',
                    }}
                  />
                  <path
                    d="M 176 52 L 138 54 L 142 60 L 178 58 Z"
                    fill={ui.brake > 0.1 ? '#ff1a1a' : '#b30000'}
                    style={{
                      filter:
                        ui.brake > 0.1
                          ? 'drop-shadow(0 0 10px #ff0000)'
                          : 'drop-shadow(0 0 4px #ff0000)',
                    }}
                  />

                  {/* Twin Exhaust Tips */}
                  <circle cx="76" cy="82" r="5" fill="#050505" stroke="#555" strokeWidth="1.5" />
                  <circle cx="144" cy="82" r="5" fill="#050505" stroke="#555" strokeWidth="1.5" />

                  {/* Left & Right Twin Exhaust Fire Bursts */}
                  {ui.exhaustFlameIntensity > 0.05 && (
                    <g style={{ opacity: Math.min(1, ui.exhaustFlameIntensity * 1.15) }}>
                      {/* Left Outer Orange/Red Plume */}
                      <ellipse
                        cx="76"
                        cy={89 + ui.exhaustFlameIntensity * 10}
                        rx={7 * ui.exhaustFlameIntensity}
                        ry={15 * ui.exhaustFlameIntensity}
                        fill="rgba(255, 68, 0, 0.9)"
                        style={{ filter: 'blur(2px)' }}
                      />
                      {/* Left Inner Blue/White Afterburner Core */}
                      <ellipse
                        cx="76"
                        cy={85 + ui.exhaustFlameIntensity * 5}
                        rx={3.5 * ui.exhaustFlameIntensity}
                        ry={8 * ui.exhaustFlameIntensity}
                        fill="#e0f7ff"
                      />

                      {/* Right Outer Orange/Red Plume */}
                      <ellipse
                        cx="144"
                        cy={89 + ui.exhaustFlameIntensity * 10}
                        rx={7 * ui.exhaustFlameIntensity}
                        ry={15 * ui.exhaustFlameIntensity}
                        fill="rgba(255, 68, 0, 0.9)"
                        style={{ filter: 'blur(2px)' }}
                      />
                      {/* Right Inner Blue/White Afterburner Core */}
                      <ellipse
                        cx="144"
                        cy={85 + ui.exhaustFlameIntensity * 5}
                        rx={3.5 * ui.exhaustFlameIntensity}
                        ry={8 * ui.exhaustFlameIntensity}
                        fill="#e0f7ff"
                      />
                    </g>
                  )}
                </svg>
              </div>

              {/* Live Pedal Telemetry Bars (Brake / Clutch / Throttle) */}
              <div className="w-full px-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[11px] font-tech text-gray-400">
                  <span>BRAKE (L-STICK)</span>
                  {ui.gameMode === 'gearhead' && <span className="text-amber-400">CLUTCH (LT)</span>}
                  <span>THROTTLE (RT)</span>
                </div>
                <div className="w-full flex items-center gap-2">
                  {/* Brake Bar */}
                  <div className="flex-1 h-2 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
                    <div
                      className="h-full bg-red-600 transition-all duration-75"
                      style={{ width: `${Math.round(ui.brake * 100)}%` }}
                    />
                  </div>
                  {/* Clutch Bar (Gearhead Mode) */}
                  {ui.gameMode === 'gearhead' && (
                    <div className="flex-1 h-2 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
                      <div
                        className="h-full bg-amber-400 transition-all duration-75"
                        style={{ width: `${Math.round(ui.clutch * 100)}%` }}
                      />
                    </div>
                  )}
                  {/* Throttle Bar */}
                  <div className="flex-1 h-2 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
                    <div
                      className="h-full bg-[#39ff14] transition-all duration-75"
                      style={{ width: `${Math.round(ui.throttle * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Bottom Center Gear & Odometer Bar */}
              <div className="w-full px-4 pt-2 border-t border-gray-800/80 flex items-center justify-between font-hud text-sm text-gray-400">
                <span>482 km</span>
                <div className="px-4 py-0.5 rounded-t-lg bg-gradient-to-t from-red-950/60 to-transparent border-b-2 border-red-500 font-tech italic text-2xl font-black text-white">
                  {formatGear(ui.gear)}
                </div>
                <span>Trip A 163.7 km</span>
              </div>
            </div>

            {/* RIGHT DIAL: TACHOMETER (RPM & GEAR) */}
            <div className="gauge-dial relative rounded-full bg-gradient-to-b from-[#121217] to-[#050508] border-[4px] border-[#2c2c34] dial-shadow flex items-center justify-center">
              {/* Outer Glowing Crimson Ring */}
              <div className="absolute inset-2 rounded-full border border-red-600/35 pointer-events-none" />

              {/* Tachometer Ticks & Numbers (0 to 10 x1000 RPM) */}
              {rpmLabels.map((val, i) => {
                const angle = -135 + (i / (rpmLabels.length - 1)) * 270;
                const rad = ((angle - 90) * Math.PI) / 180;
                const numRadius = 132;
                const x = Math.cos(rad) * numRadius;
                const y = Math.sin(rad) * numRadius;
                const isRedlineZone = val >= 8;

                return (
                  <React.Fragment key={val}>
                    {/* Major Tick */}
                    <div
                      className="absolute w-full h-full top-0 left-0 pointer-events-none"
                      style={{ transform: `rotate(${angle}deg)` }}
                    >
                      <div
                        className={`mx-auto mt-3 w-[3.5px] h-4 rounded-full ${
                          isRedlineZone
                            ? 'bg-red-500 shadow-[0_0_10px_#ff0000]'
                            : 'bg-gray-200'
                        }`}
                      />
                    </div>
                    {/* Number Label */}
                    <div
                      className={`absolute font-tech text-base font-bold italic ${
                        isRedlineZone
                          ? 'text-red-500 drop-shadow-[0_0_8px_rgba(255,0,0,0.8)]'
                          : 'text-gray-100'
                      }`}
                      style={{
                        transform: `translate(${x}px, ${y}px)`,
                      }}
                    >
                      {val}
                    </div>
                  </React.Fragment>
                );
              })}

              {/* Tachometer Needle */}
              <div ref={rpmNeedleRef} className="absolute inset-0 pointer-events-none will-change-transform" style={{ transform: 'rotate(-135deg)' }}>
                <div className="mx-auto mt-7 w-1.5 h-36 bg-gradient-to-b from-white via-red-500 to-red-900 rounded-full shadow-[0_0_18px_#ff1a1a]" />
              </div>

              {/* Center Digital Gear & RPM Hub */}
              <div className="w-44 h-44 rounded-full bg-gradient-to-b from-[#0c0c10] to-[#040406] border border-gray-800 shadow-[inset_0_0_30px_rgba(0,0,0,0.95)] flex flex-col items-center justify-center z-10">
                <div className="flex items-center gap-2">
                  <span className="font-tech italic text-6xl font-black text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.25)]">
                    {formatGear(ui.gear)}
                  </span>
                  {ui.rpm >= 8200 && ui.gear < 6 && (
                    <span className="text-red-500 text-2xl animate-bounce">▲</span>
                  )}
                </div>
                <span className="font-hud text-xs font-semibold text-gray-400 tracking-widest mt-0.5">
                  x1000 RPM ({Math.round(ui.rpm)})
                </span>
              </div>
            </div>
          </div>

          {/* Bottom Controller Quick Legend */}
          <div className="controller-legend w-full flex items-center justify-between px-6 text-[11px] font-tech text-gray-400 tracking-wider z-20">
            <div>START: IGNITION · BACK: NEXT DISPLAY</div>
            <div>RT: THROTTLE · L-STICK: BRAKE · LT: CLUTCH</div>
            <div>RB/LB: SHIFT · D-PAD: MODE/PAGES · L3: EXHAUST · X/Y: THEME/AUDIO</div>
          </div>
        </div>


        <p className="simulator-footnote">CONTROLLER ONLY · L3: EXHAUST BURST · Y: AUDIO · X: THEME · BEST WITH HEADPHONES</p>
      </div>
    </>
  );
}