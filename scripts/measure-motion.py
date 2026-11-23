"""Measure forward and backward optical flow between pairs of animation keys."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def measure(folder, pairs):
    cv2.setNumThreads(1)
    flow = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    flow.setFinestScale(0)
    keys = {}
    for index in {i for pair in pairs for i in pair}:
        rgba = np.fromfile(folder / f"key-{index}.rgba", np.uint8).reshape(360, 640, 4)
        grey = cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY).astype(np.float32)
        alpha = rgba[:, :, 3] / 255.0
        # A mid-grey tracking surface distinguishes both pale and dark outlines.
        signal = (grey * alpha + 116 * (1 - alpha)).astype(np.uint8)
        keys[index] = cv2.resize(signal, (320, 180), interpolation=cv2.INTER_AREA)
    for a, b in pairs:
        vectors = flow.calc(keys[a], keys[b], None)
        vectors.astype("<f4").tofile(folder / f"flow-{a}-{b}.bin")


if __name__ == "__main__":
    measure(Path(sys.argv[1]), json.loads(sys.argv[2]))
