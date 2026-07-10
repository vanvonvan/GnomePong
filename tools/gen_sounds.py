#!/usr/bin/env python3
"""Generate GnomePong's classic square-wave blips as 16-bit mono WAV files.

Frequencies mirror the original 1972 Pong: paddle 459 Hz, wall 226 Hz, and a
longer point tone at 490 Hz. Short linear fades avoid click artifacts.
"""
import math
import os
import struct
import wave

RATE = 44100
AMP = 0.32  # keep it gentle


def square(freq, seconds, path):
    n = int(RATE * seconds)
    fade = int(RATE * 0.006)  # ~6 ms fade in/out
    frames = bytearray()
    for i in range(n):
        # Square wave: sign of the sine.
        s = 1.0 if math.sin(2 * math.pi * freq * i / RATE) >= 0 else -1.0
        env = 1.0
        if i < fade:
            env = i / fade
        elif i > n - fade:
            env = max(0.0, (n - i) / fade)
        val = int(max(-1.0, min(1.0, s * AMP * env)) * 32767)
        frames += struct.pack('<h', val)
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    print(f'wrote {path} ({seconds*1000:.0f} ms, {freq} Hz)')


def main():
    out = os.path.join(os.path.dirname(__file__), '..', 'sounds')
    os.makedirs(out, exist_ok=True)
    square(459, 0.090, os.path.join(out, 'paddle.wav'))
    square(226, 0.090, os.path.join(out, 'wall.wav'))
    square(490, 0.320, os.path.join(out, 'score.wav'))


if __name__ == '__main__':
    main()