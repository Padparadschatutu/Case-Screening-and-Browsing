from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class LabelRecord:
    checked: bool
    updated_at: str


class LabelStore:
    def __init__(self, path: str):
        self.path = path
        self._cache: dict[str, Any] | None = None
        self._cache_mtime: float | None = None

    def _load(self) -> dict[str, Any]:
        if not os.path.exists(self.path):
            self._cache = {}
            self._cache_mtime = None
            return {}
        mtime = os.path.getmtime(self.path)
        if self._cache is not None and self._cache_mtime == mtime:
            return self._cache
        with open(self.path, "r", encoding="utf-8") as f:
            self._cache = json.load(f)
            self._cache_mtime = mtime
            return self._cache

    def _atomic_write(self, obj: dict[str, Any]) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, self.path)
        self._cache = obj
        self._cache_mtime = os.path.getmtime(self.path)

    def all(self) -> dict[str, Any]:
        return self._load()

    def get(self, barcode: str) -> LabelRecord | None:
        obj = self._load().get(barcode)
        if not isinstance(obj, dict):
            return None
        checked = bool(obj.get("checked", False))
        updated_at = str(obj.get("updated_at", ""))
        return LabelRecord(checked=checked, updated_at=updated_at)

    def set(self, barcode: str, checked: bool) -> LabelRecord:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        data = self._load()
        data[barcode] = {"checked": bool(checked), "updated_at": now}
        self._atomic_write(data)
        return LabelRecord(checked=bool(checked), updated_at=now)
