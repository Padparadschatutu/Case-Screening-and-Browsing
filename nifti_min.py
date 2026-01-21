from __future__ import annotations

import gzip
import io
import os
import struct
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Literal

import numpy as np


Axis = Literal["x", "y", "z"]


_DTYPE_MAP: dict[int, str] = {
    2: "u1",  # uint8
    4: "i2",  # int16
    8: "i4",  # int32
    16: "f4",  # float32
    64: "f8",  # float64
    512: "u2",  # uint16
    768: "u4",  # uint32
}


@dataclass(frozen=True)
class NiftiHeader:
    endianness: Literal["<", ">"]
    shape: tuple[int, int, int]
    dtype: np.dtype
    vox_offset: int
    scl_slope: float
    scl_inter: float


def _read_exact(f: io.BufferedReader, n: int) -> bytes:
    buf = f.read(n)
    if buf is None or len(buf) != n:
        raise ValueError(f"Unexpected EOF while reading {n} bytes")
    return buf


def read_nifti_header(path: str) -> NiftiHeader:
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:  # type: ignore[arg-type]
        hdr = _read_exact(f, 348)

    sizeof_hdr_le = struct.unpack("<i", hdr[0:4])[0]
    sizeof_hdr_be = struct.unpack(">i", hdr[0:4])[0]
    if sizeof_hdr_le == 348:
        end = "<"
    elif sizeof_hdr_be == 348:
        end = ">"
    else:
        raise ValueError(f"Not a NIfTI-1 header (sizeof_hdr={sizeof_hdr_le}/{sizeof_hdr_be})")

    dim = struct.unpack(end + "8h", hdr[40:56])
    ndim = int(dim[0])
    if ndim < 3:
        raise ValueError(f"Expected >=3D NIfTI, got dim[0]={ndim}")
    shape = (int(dim[1]), int(dim[2]), int(dim[3]))

    datatype = struct.unpack(end + "h", hdr[70:72])[0]
    if datatype not in _DTYPE_MAP:
        raise ValueError(f"Unsupported NIfTI datatype code: {datatype}")
    dtype = np.dtype(end + _DTYPE_MAP[datatype])

    vox_offset = int(struct.unpack(end + "f", hdr[108:112])[0])
    if vox_offset <= 0:
        vox_offset = 352

    scl_slope = float(struct.unpack(end + "f", hdr[112:116])[0])
    scl_inter = float(struct.unpack(end + "f", hdr[116:120])[0])
    if scl_slope == 0.0:
        scl_slope = 1.0

    return NiftiHeader(
        endianness=end,
        shape=shape,
        dtype=dtype,
        vox_offset=vox_offset,
        scl_slope=scl_slope,
        scl_inter=scl_inter,
    )


def _load_volume(path: str) -> tuple[NiftiHeader, np.ndarray]:
    header = read_nifti_header(path)
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:  # type: ignore[arg-type]
        f.seek(header.vox_offset)
        data = f.read()

    expected = int(np.prod(header.shape)) * int(header.dtype.itemsize)
    if len(data) < expected:
        raise ValueError(f"Voxel data too small: got {len(data)} bytes, expected {expected}")
    data = data[:expected]

    arr = np.frombuffer(data, dtype=header.dtype).reshape(header.shape, order="F")
    return header, arr


def _apply_window(slice2d: np.ndarray, center: float | None, width: float | None) -> np.ndarray:
    x = slice2d.astype(np.float32, copy=False)

    if center is None or width is None or width <= 0:
        lo, hi = np.percentile(x, [1, 99]).astype(np.float32)
        if not np.isfinite(lo) or not np.isfinite(hi) or lo == hi:
            lo, hi = float(np.min(x)), float(np.max(x))
    else:
        lo = float(center) - float(width) / 2.0
        hi = float(center) + float(width) / 2.0

    x = np.clip(x, lo, hi)
    if hi == lo:
        return np.zeros_like(x, dtype=np.uint8)
    x = (x - lo) / (hi - lo) * 255.0
    return x.astype(np.uint8)


class VolumeCache:
    def __init__(self, max_volumes: int = 2):
        self._max_volumes = max_volumes
        self._items: "OrderedDict[str, tuple[float, NiftiHeader, np.ndarray]]" = OrderedDict()

    def get(self, path: str) -> tuple[NiftiHeader, np.ndarray]:
        mtime = os.path.getmtime(path)
        hit = self._items.get(path)
        if hit and hit[0] == mtime:
            self._items.move_to_end(path)
            return hit[1], hit[2]

        header, arr = _load_volume(path)
        self._items[path] = (mtime, header, arr)
        self._items.move_to_end(path)
        while len(self._items) > self._max_volumes:
            self._items.popitem(last=False)
        return header, arr


_CACHE = VolumeCache(max_volumes=1)


def get_volume_info(path: str) -> dict:
    header = read_nifti_header(path)
    return {
        "shape": list(header.shape),
        "dtype": str(header.dtype),
        "vox_offset": header.vox_offset,
        "scl_slope": header.scl_slope,
        "scl_inter": header.scl_inter,
    }


def render_slice_png(
    path: str,
    axis: Axis,
    index: int,
    window_center: float | None = None,
    window_width: float | None = None,
    max_size: int | None = None,
) -> bytes:
    header, arr = _CACHE.get(path)

    if axis == "x":
        max_idx = header.shape[0] - 1
        idx = int(np.clip(index, 0, max_idx))
        slice2d = arr[idx, :, :]
    elif axis == "y":
        max_idx = header.shape[1] - 1
        idx = int(np.clip(index, 0, max_idx))
        slice2d = arr[:, idx, :]
    else:
        max_idx = header.shape[2] - 1
        idx = int(np.clip(index, 0, max_idx))
        slice2d = arr[:, :, idx]

    slice2d = slice2d.astype(np.float32, copy=False) * float(header.scl_slope) + float(header.scl_inter)
    slice2d = np.rot90(slice2d)

    img = _apply_window(slice2d, window_center, window_width)

    try:
        from PIL import Image
    except Exception as e:  # pragma: no cover
        raise RuntimeError("Pillow is required to render PNG") from e

    im = Image.fromarray(img, mode="L")
    if max_size is not None and max_size > 0:
        w, h = im.size
        m = max(w, h)
        if m > max_size:
            s = float(max_size) / float(m)
            nw = max(1, int(round(w * s)))
            nh = max(1, int(round(h * s)))
            im = im.resize((nw, nh), resample=Image.BILINEAR)
    out = io.BytesIO()
    # Favor speed over maximum PNG compression.
    im.save(out, format="PNG", optimize=False, compress_level=1)
    return out.getvalue()
