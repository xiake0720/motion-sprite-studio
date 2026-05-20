from __future__ import annotations

import json
import math
import os
import wave
import zipfile
from pathlib import Path
from typing import Any

import numpy as np

from .config import JOB_DIR

SAMPLE_RATE = 44100
NOTE_INDEX = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}
SCALES = {
    'major': [0, 2, 4, 5, 7, 9, 11, 12],
    'minor': [0, 2, 3, 5, 7, 8, 10, 12],
    'pentatonic': [0, 2, 4, 7, 9, 12],
    'dorian': [0, 2, 3, 5, 7, 9, 10, 12],
}


def _clip_audio(x: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 1.0:
        x = x / peak * 0.96
    return np.clip(x, -1.0, 1.0)


def _adsr(n: int, sr: int, attack: float, decay: float, sustain: float, release: float) -> np.ndarray:
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    a = max(1, min(n, int(max(0.0, attack) * sr)))
    d = max(1, min(n, int(max(0.0, decay) * sr)))
    r = max(1, min(n, int(max(0.0, release) * sr)))
    env = np.ones(n, dtype=np.float32) * float(np.clip(sustain, 0, 1))
    env[:a] = np.linspace(0, 1, a, dtype=np.float32)
    end_decay = min(n, a + d)
    if end_decay > a:
        env[a:end_decay] = np.linspace(1, sustain, end_decay - a, dtype=np.float32)
    rel_start = max(0, n - r)
    env[rel_start:] = np.linspace(float(env[rel_start]), 0, n - rel_start, dtype=np.float32)
    return env


def _osc(kind: str, freq: np.ndarray, sr: int, rng: np.random.Generator) -> np.ndarray:
    phase = 2 * math.pi * np.cumsum(freq) / sr
    kind = (kind or 'sine').lower()
    if kind == 'square':
        return np.sign(np.sin(phase))
    if kind == 'triangle':
        return (2 / math.pi) * np.arcsin(np.sin(phase))
    if kind in {'saw', 'sawtooth'}:
        return 2 * (phase / (2 * math.pi) - np.floor(0.5 + phase / (2 * math.pi)))
    if kind == 'noise':
        return rng.uniform(-1, 1, size=phase.shape)
    return np.sin(phase)


def _lowpass(x: np.ndarray, cutoff: float, sr: int) -> np.ndarray:
    cutoff = float(cutoff or 0)
    if cutoff <= 20 or cutoff >= sr / 2:
        return x.astype(np.float32)
    # One-pole low pass. Cheap and stable enough for short generated assets.
    dt = 1.0 / sr
    rc = 1.0 / (2 * math.pi * cutoff)
    alpha = dt / (rc + dt)
    out = np.empty_like(x, dtype=np.float32)
    prev = 0.0
    for i, sample in enumerate(x):
        prev = prev + alpha * (float(sample) - prev)
        out[i] = prev
    return out


def _highpass_noise(n: int, sr: int, rng: np.random.Generator, cutoff: float = 5000) -> np.ndarray:
    noise = rng.uniform(-1, 1, n).astype(np.float32)
    return noise - _lowpass(noise, cutoff, sr)


def _note_to_freq(note: str = 'C4', root: str = 'C', octave: int = 4, offset: int = 0, scale: str = 'major') -> float:
    note = str(note or '').strip()
    if len(note) >= 2 and note[0].upper() in 'ABCDEFG':
        name = note[:-1]
        octv = note[-1]
        if octv.lstrip('-').isdigit():
            semitone = NOTE_INDEX.get(name.upper().replace('♯', '#').replace('♭', 'b'), 0)
            midi = (int(octv) + 1) * 12 + semitone + offset
            return 440.0 * (2 ** ((midi - 69) / 12))
    root_index = NOTE_INDEX.get(str(root or 'C').replace('♯', '#').replace('♭', 'b'), 0)
    scale_steps = SCALES.get(str(scale or 'major'), SCALES['major'])
    degree = scale_steps[offset % len(scale_steps)] + 12 * (offset // len(scale_steps))
    midi = (int(octave) + 1) * 12 + root_index + degree
    return 440.0 * (2 ** ((midi - 69) / 12))


def _drive(x: np.ndarray, amount: float) -> np.ndarray:
    amount = max(0.0, min(float(amount or 0), 1.0))
    if amount <= 0:
        return x
    gain = 1.0 + amount * 12.0
    return np.tanh(x * gain) / np.tanh(gain)


def synth_note(track: dict[str, Any], freq: float, duration: float, seed: int) -> np.ndarray:
    sr = SAMPLE_RATE
    n = max(1, int(duration * sr))
    rng = np.random.default_rng(seed)
    t = np.arange(n, dtype=np.float32) / sr
    inst = str(track.get('instrument', 'piano')).lower()
    waveform = str(track.get('waveform', 'sine')).lower()
    attack = float(track.get('attack', 0.005))
    decay = float(track.get('decay', 0.16))
    sustain = float(track.get('sustain', 0.45))
    release = float(track.get('release', 0.08))
    cutoff = float(track.get('cutoff', 9000))
    drive = float(track.get('drive', 0.0))
    pitch_slide = float(track.get('pitchSlide', 0.0))
    freq_line = np.linspace(freq, max(20, freq + pitch_slide), n, dtype=np.float32)

    if inst == 'kick':
        f = np.linspace(freq * 1.8, max(32, freq * 0.42), n, dtype=np.float32)
        body = np.sin(2 * math.pi * np.cumsum(f) / sr)
        click = rng.uniform(-1, 1, n) * np.exp(-t * 85)
        sig = body * np.exp(-t * 8) + click * 0.18
        env = _adsr(n, sr, 0.001, 0.12, 0.0, 0.08)
    elif inst == 'snare':
        noise = rng.uniform(-1, 1, n).astype(np.float32)
        tone = np.sin(2 * np.pi * 180 * t)
        sig = noise * 0.78 + tone * 0.22
        env = _adsr(n, sr, 0.001, 0.18, 0.04, 0.12)
        cutoff = min(cutoff, 5200)
    elif inst == 'tom':
        f = np.linspace(freq * 1.22, max(42, freq * 0.64), n, dtype=np.float32)
        sig = np.sin(2 * math.pi * np.cumsum(f) / sr) * 0.84 + rng.uniform(-1, 1, n) * 0.06
        env = _adsr(n, sr, 0.002, 0.22, 0.0, 0.10) * np.exp(-t * 5.5)
        cutoff = min(cutoff, 3200)
    elif inst in {'hihat', 'shaker'}:
        sig = _highpass_noise(n, sr, rng, 6500 if inst == 'hihat' else 4200)
        env = _adsr(n, sr, 0.001, 0.045 if inst == 'hihat' else 0.11, 0.0, 0.035 if inst == 'hihat' else 0.08)
        cutoff = SAMPLE_RATE / 2 - 100
    elif inst in {'cymbal', 'crash'}:
        sig = _highpass_noise(n, sr, rng, 3600) + rng.uniform(-1, 1, n).astype(np.float32) * 0.25
        env = _adsr(n, sr, 0.001, 0.85, 0.0, max(release, 0.55)) * np.exp(-t * 1.6)
        cutoff = SAMPLE_RATE / 2 - 100
    elif inst == 'clap':
        sig = rng.uniform(-1, 1, n).astype(np.float32)
        pulse = np.zeros(n, dtype=np.float32)
        for delay in [0.0, 0.018, 0.034, 0.055]:
            start = int(delay * sr)
            if start < n:
                pulse[start:] += np.exp(-np.arange(n - start) / (sr * 0.035))
        env = np.clip(pulse, 0, 1)
        cutoff = min(cutoff, 4500)
    elif inst == 'piano':
        sig = (np.sin(2 * np.pi * freq * t) * 0.7 + np.sin(2 * np.pi * freq * 2 * t) * 0.18 + np.sin(2 * np.pi * freq * 3 * t) * 0.08)
        env = _adsr(n, sr, attack, max(decay, 0.22), min(sustain, 0.32), max(release, 0.12)) * np.exp(-t * 1.7)
    elif inst == 'epiano':
        trem = 1.0 + 0.08 * np.sin(2 * np.pi * 5.2 * t)
        sig = (np.sin(2 * np.pi * freq * t) * 0.62 + np.sin(2 * np.pi * freq * 2.01 * t) * 0.2 + _osc('triangle', freq_line * 0 + freq * 0.5, sr, rng) * 0.18) * trem
        env = _adsr(n, sr, max(attack, 0.008), max(decay, 0.18), sustain, release)
    elif inst == 'bell':
        sig = (np.sin(2 * np.pi * freq * t) * 0.55 + np.sin(2 * np.pi * freq * 2.41 * t) * 0.3 + np.sin(2 * np.pi * freq * 3.77 * t) * 0.15)
        env = _adsr(n, sr, 0.002, max(decay, 0.45), 0.0, max(release, 0.28)) * np.exp(-t * 1.2)
    elif inst == 'marimba':
        sig = np.sin(2 * np.pi * freq * t) * 0.8 + np.sin(2 * np.pi * freq * 3.0 * t) * 0.12
        env = _adsr(n, sr, 0.002, max(decay, 0.13), 0.0, max(release, 0.08)) * np.exp(-t * 4.0)
    elif inst in {'xylophone', 'woodblock'}:
        sig = np.sin(2 * np.pi * freq * t) * 0.72 + np.sin(2 * np.pi * freq * 2.7 * t) * 0.18 + rng.uniform(-1, 1, n) * 0.025
        env = _adsr(n, sr, 0.001, max(decay, 0.08), 0.0, max(release, 0.04)) * np.exp(-t * 6.2)
    elif inst in {'musicbox', 'celesta'}:
        sig = (np.sin(2 * np.pi * freq * t) * 0.45 + np.sin(2 * np.pi * freq * 2.01 * t) * 0.24 + np.sin(2 * np.pi * freq * 4.02 * t) * 0.12)
        env = _adsr(n, sr, 0.002, max(decay, 0.5), 0.0, max(release, 0.34)) * np.exp(-t * 1.1)
    elif inst == 'kalimba':
        sig = _osc('sine', freq_line, sr, rng) * 0.58 + _osc('triangle', freq_line * 2.03, sr, rng) * 0.23 + rng.uniform(-1, 1, n) * 0.018
        env = _adsr(n, sr, 0.002, max(decay, 0.22), 0.08, max(release, 0.14)) * np.exp(-t * 2.4)
    elif inst == 'harp':
        sig = _osc('triangle', freq_line, sr, rng) * 0.62 + _osc('sine', freq_line * 2, sr, rng) * 0.18 + _osc('sine', freq_line * 3, sr, rng) * 0.08
        env = _adsr(n, sr, 0.002, max(decay, 0.34), 0.1, max(release, 0.26)) * np.exp(-t * 1.6)
    elif inst in {'guitar', 'muted_guitar'}:
        sig = _osc('triangle', freq_line, sr, rng) * 0.55 + _osc('saw', freq_line * 2, sr, rng) * 0.12 + rng.uniform(-1, 1, n) * 0.035
        env = _adsr(n, sr, 0.004, max(decay, 0.18), 0.14 if inst == 'guitar' else 0.02, max(release, 0.10)) * np.exp(-t * (2.0 if inst == 'guitar' else 5.0))
    elif inst == 'flute':
        vibrato = 1.0 + 0.006 * np.sin(2 * np.pi * 5.4 * t)
        sig = np.sin(2 * np.pi * np.cumsum(freq_line * vibrato) / sr) * 0.76 + rng.uniform(-1, 1, n) * 0.018
        env = _adsr(n, sr, max(attack, 0.035), max(decay, 0.12), max(sustain, 0.68), max(release, 0.16))
        cutoff = min(cutoff, 7600)
    elif inst == 'strings':
        sig = _osc('saw', freq_line, sr, rng) * 0.42 + _osc('triangle', freq_line * 1.006, sr, rng) * 0.36 + _osc('sine', freq_line * 0.5, sr, rng) * 0.16
        env = _adsr(n, sr, max(attack, 0.08), max(decay, 0.28), max(sustain, 0.72), max(release, 0.32))
        cutoff = min(cutoff, 6400)
    elif inst == 'choir':
        sig = (np.sin(2 * np.pi * freq * t) * 0.40 + np.sin(2 * np.pi * freq * 1.5 * t) * 0.18 + np.sin(2 * np.pi * freq * 2.0 * t) * 0.12)
        sig += _lowpass(rng.uniform(-1, 1, n).astype(np.float32), 1200, sr) * 0.025
        env = _adsr(n, sr, max(attack, 0.12), max(decay, 0.40), max(sustain, 0.75), max(release, 0.45))
        cutoff = min(cutoff, 5200)
    elif inst == 'brass':
        sig = _osc('saw', freq_line, sr, rng) * 0.58 + _osc('square', freq_line * 0.5, sr, rng) * 0.18
        env = _adsr(n, sr, max(attack, 0.025), max(decay, 0.18), max(sustain, 0.62), max(release, 0.18))
        cutoff = min(cutoff, 6200)
    elif inst == 'organ':
        sig = (np.sin(2 * np.pi * freq * t) * 0.38 + np.sin(2 * np.pi * freq * 2 * t) * 0.22 + np.sin(2 * np.pi * freq * 3 * t) * 0.14 + np.sin(2 * np.pi * freq * 4 * t) * 0.08)
        env = _adsr(n, sr, max(attack, 0.01), max(decay, 0.05), max(sustain, 0.85), max(release, 0.14))
    elif inst == 'bass':
        sig = _osc('sine', freq_line, sr, rng) * 0.72 + _osc('square', freq_line * 0.5, sr, rng) * 0.22
        env = _adsr(n, sr, attack, decay, max(sustain, 0.58), release)
        cutoff = min(cutoff, 2800)
    elif inst == 'pad':
        sig = (_osc('saw', freq_line, sr, rng) * 0.4 + _osc('triangle', freq_line * 1.005, sr, rng) * 0.35 + _osc('sine', freq_line * 0.5, sr, rng) * 0.25)
        env = _adsr(n, sr, max(attack, 0.08), max(decay, 0.35), max(sustain, 0.65), max(release, 0.35))
    elif inst == 'pluck':
        sig = _osc('triangle', freq_line, sr, rng) * 0.58 + _osc('saw', freq_line * 2, sr, rng) * 0.16 + rng.uniform(-1, 1, n) * 0.04
        env = _adsr(n, sr, 0.001, max(decay, 0.12), 0.08, max(release, 0.06)) * np.exp(-t * 2.5)
    elif inst in {'whoosh', 'riser'}:
        start_f, end_f = (160, 5200) if inst == 'riser' else (4800, 180)
        f = np.linspace(start_f, end_f, n, dtype=np.float32)
        sig = _highpass_noise(n, sr, rng, 1200) * 0.55 + np.sin(2 * math.pi * np.cumsum(f) / sr) * 0.22
        env = np.linspace(0.0, 1.0, n, dtype=np.float32) if inst == 'riser' else np.linspace(1.0, 0.0, n, dtype=np.float32)
        env *= _adsr(n, sr, max(attack, 0.02), max(decay, 0.25), max(sustain, 0.65), max(release, 0.25))
    elif inst in {'impact', 'boom'}:
        f = np.linspace(max(freq * 1.4, 110), max(28, freq * 0.35), n, dtype=np.float32)
        sig = np.sin(2 * math.pi * np.cumsum(f) / sr) * 0.72 + rng.uniform(-1, 1, n).astype(np.float32) * np.exp(-t * 8) * 0.28
        env = _adsr(n, sr, 0.001, max(decay, 0.42), 0.0, max(release, 0.35)) * np.exp(-t * 2.4)
        cutoff = min(cutoff, 4600)
    elif inst == 'noise':
        sig = rng.uniform(-1, 1, n).astype(np.float32)
        env = _adsr(n, sr, attack, decay, sustain, release)
    else:  # lead / generic synth
        sig = _osc(waveform, freq_line, sr, rng) * 0.72 + _osc('sine', freq_line * 2, sr, rng) * 0.12
        env = _adsr(n, sr, attack, decay, sustain, release)

    sig = sig.astype(np.float32) * env.astype(np.float32)
    sig = _lowpass(sig, cutoff, sr)
    sig = _drive(sig, drive)
    return _clip_audio(sig).astype(np.float32)


def _stereo_place(mono: np.ndarray, pan: float) -> np.ndarray:
    pan = max(-1.0, min(float(pan or 0.0), 1.0))
    left = math.cos((pan + 1) * math.pi / 4)
    right = math.sin((pan + 1) * math.pi / 4)
    return np.stack([mono * left, mono * right], axis=1)


def _apply_delay(audio: np.ndarray, sr: int, amount: float, bpm: float) -> np.ndarray:
    amount = max(0.0, min(float(amount or 0), 1.0))
    if amount <= 0:
        return audio
    delay = int((60.0 / max(40, bpm)) * 0.5 * sr)
    out = audio.copy()
    feedback = 0.32 * amount
    wet = 0.38 * amount
    for i in range(delay, len(out)):
        out[i] += out[i - delay] * feedback * wet
    return out


def _apply_room(audio: np.ndarray, sr: int, amount: float) -> np.ndarray:
    amount = max(0.0, min(float(amount or 0), 1.0))
    if amount <= 0:
        return audio
    out = audio.copy()
    for ms, gain in [(31, 0.18), (57, 0.12), (83, 0.09), (127, 0.06)]:
        d = int(sr * ms / 1000)
        if d < len(out):
            out[d:] += audio[:-d] * gain * amount
    return out


def _apply_tone(audio: np.ndarray, sr: int, low_gain: float = 0.0, mid_gain: float = 0.0, high_gain: float = 0.0) -> np.ndarray:
    # Lightweight three-band tone control for generated game assets. Gains are
    # roughly in the -1..1 range from the UI.
    if abs(low_gain) < 1e-6 and abs(mid_gain) < 1e-6 and abs(high_gain) < 1e-6:
        return audio
    low = np.stack([_lowpass(audio[:, 0], 240, sr), _lowpass(audio[:, 1], 240, sr)], axis=1)
    high_src = audio - np.stack([_lowpass(audio[:, 0], 4200, sr), _lowpass(audio[:, 1], 4200, sr)], axis=1)
    mid = audio - low - high_src
    out = audio + low * float(low_gain) * 0.65 + mid * float(mid_gain) * 0.45 + high_src * float(high_gain) * 0.55
    return _clip_audio(out)


def render_studio(params: dict[str, Any]) -> tuple[np.ndarray, list[tuple[str, np.ndarray]]]:
    sr = SAMPLE_RATE
    bpm = max(40.0, min(220.0, float(params.get('bpm', 100))))
    bars = max(1, min(16, int(params.get('bars', 4))))
    root = str(params.get('root', 'C'))
    scale = str(params.get('scale', 'major'))
    swing = max(0.0, min(float(params.get('swing', 0.0)), 0.65))
    master_gain = max(0.05, min(float(params.get('masterVolume', 0.86)), 1.2))
    tracks = params.get('tracks') or []
    total_duration = bars * 4 * (60.0 / bpm)
    n = int(total_duration * sr) + sr
    mix = np.zeros((n, 2), dtype=np.float32)
    stems: list[tuple[str, np.ndarray]] = []
    seed = int(params.get('seed', 7))

    solo_tracks = [tr for tr in tracks if tr.get('solo')]
    active_tracks = solo_tracks or tracks
    for tr_index, track in enumerate(active_tracks):
        if track.get('mute'):
            continue
        steps = track.get('steps') or []
        if not steps:
            continue
        step_count = len(steps)
        step_dur = total_duration / step_count
        stem = np.zeros((n, 2), dtype=np.float32)
        volume = max(0.0, min(float(track.get('volume', 0.75)), 1.4))
        pan = float(track.get('pan', 0.0))
        octave = int(track.get('octave', 4))
        gate = max(0.05, min(float(track.get('gate', 0.78)), 1.6))
        degrees = track.get('degrees') or [0, 2, 4, 7, 4, 2, 0, 5]
        note = str(track.get('note', ''))
        for step_index, active in enumerate(steps):
            if not active:
                continue
            step_offset = (swing * step_dur * 0.45) if (step_index % 2 == 1) else 0.0
            start = int((step_index * step_dur + step_offset) * sr)
            if start >= n:
                continue
            duration = min(step_dur * gate, total_duration - step_index * step_dur)
            if duration <= 0:
                continue
            if note:
                freq = _note_to_freq(note, root=root, octave=octave, offset=0, scale=scale)
            else:
                offset = int(degrees[step_index % len(degrees)]) + int(track.get('transpose', 0))
                freq = _note_to_freq('', root=root, octave=octave, offset=offset, scale=scale)
            if track.get('instrument') in {'kick'}:
                freq = float(track.get('frequency', 58))
            elif track.get('instrument') in {'snare', 'clap'}:
                freq = float(track.get('frequency', 180))
            elif track.get('instrument') in {'tom'}:
                freq = float(track.get('frequency', 120))
            elif track.get('instrument') in {'impact', 'boom'}:
                freq = float(track.get('frequency', 72))
            elif track.get('instrument') in {'hihat', 'shaker', 'cymbal', 'crash', 'noise', 'whoosh', 'riser'}:
                freq = float(track.get('frequency', 6600))
            mono = synth_note(track, freq, duration, seed + tr_index * 1009 + step_index)
            part = _stereo_place(mono * volume, pan)
            end = min(n, start + len(part))
            stem[start:end] += part[:end - start]
        stem = _apply_tone(stem, sr, float(track.get('eqLow', 0.0)), float(track.get('eqMid', 0.0)), float(track.get('eqHigh', 0.0)))
        stem = _apply_delay(stem, sr, float(track.get('delaySend', 0.0)), bpm)
        stem = _apply_room(stem, sr, float(track.get('reverbSend', 0.0)))
        stems.append((str(track.get('name', f'track_{tr_index+1}')), _clip_audio(stem)))
        mix += stem

    mix *= master_gain
    mix = _apply_room(mix, sr, float(params.get('reverb', 0.08)))
    mix = _apply_delay(mix, sr, float(params.get('delay', 0.0)), bpm)
    # Trim one second safety tail only if silent, keep exported loop length stable.
    mix = mix[: int(total_duration * sr)]
    stems = [(name, stem[: int(total_duration * sr)]) for name, stem in stems]
    return _clip_audio(mix), stems


def generate_quick_sfx(params: dict[str, Any], seed_offset: int = 0) -> np.ndarray:
    track = {
        'instrument': params.get('instrument', 'lead'),
        'waveform': params.get('waveform', 'sine'),
        'attack': params.get('attack', 0.002),
        'decay': params.get('decay', 0.1),
        'sustain': params.get('sustain', 0.3),
        'release': params.get('release', 0.1),
        'cutoff': params.get('filter', params.get('cutoff', 9000)),
        'drive': params.get('drive', 0.0),
        'pitchSlide': params.get('pitch_slide', 0),
    }
    mono = synth_note(track, float(params.get('frequency', 440)), float(params.get('duration', 0.4)), int(params.get('seed', 1)) + seed_offset)
    return _stereo_place(mono * float(params.get('volume', 0.7)), float(params.get('pan', 0.0)))


def write_wav(path: Path, audio: np.ndarray, sr: int = SAMPLE_RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = _clip_audio(audio)
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=1)
    pcm = (audio * 32767).astype(np.int16)
    with wave.open(str(path), 'wb') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def run_audio_generate(params: dict[str, Any]) -> dict[str, Any]:
    result_id = os.urandom(8).hex()
    out_dir = JOB_DIR / 'audio' / result_id / 'outputs'
    stems_dir = out_dir / 'stems'
    out_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)
    mode = str(params.get('mode', 'studio'))
    outputs = []
    duration = 0.0

    if mode == 'studio' or params.get('tracks'):
        mix, stems = render_studio(params)
        duration = len(mix) / SAMPLE_RATE
        write_wav(out_dir / 'studio_mix.wav', mix)
        if bool(params.get('exportStems', True)):
            for name, stem in stems:
                safe = ''.join(c if c.isalnum() or c in '-_.' else '_' for c in name)[:60] or 'track'
                write_wav(stems_dir / f'{safe}.wav', stem)
    else:
        variations = min(20, max(1, int(params.get('variations', 4))))
        for i in range(variations):
            audio = generate_quick_sfx(params, i)
            duration = len(audio) / SAMPLE_RATE
            name = f'audio_{i+1:02d}.wav'
            write_wav(out_dir / name, audio)

    (out_dir / 'project.json').write_text(json.dumps(params, ensure_ascii=False, indent=2), encoding='utf-8')
    zip_path = out_dir / 'audio_project_assets.zip'
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for path in out_dir.rglob('*'):
            if path == zip_path or path.is_dir():
                continue
            zf.write(path, path.relative_to(out_dir).as_posix())
    for path in out_dir.rglob('*'):
        if path.is_file():
            rel = path.relative_to(out_dir).as_posix()
            outputs.append({'name': rel, 'url': f'/api/audio/results/{result_id}/{rel}', 'size_bytes': path.stat().st_size})
    return {'id': result_id, 'outputs': outputs, 'duration': duration, 'sample_rate': SAMPLE_RATE}
