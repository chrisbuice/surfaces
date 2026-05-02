#!/usr/bin/env python3
"""
Convert streams.feather to plays.ndjson, applying music_only filter
and normalize_platform before export.

Run once: python3 scripts/feather-to-ndjson.py
Output:   data/plays.ndjson (gitignored)
"""

import json
import sys
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
INPUT = DATA_DIR / "streams.feather"
OUTPUT = DATA_DIR / "plays.ndjson"


def normalize_platform(raw: str) -> str:
    lower = raw.lower()
    if any(k in lower for k in ("ios", "iphone", "ipad")):
        return "iOS"
    if any(k in lower for k in ("os x", "mac", "osx")):
        return "macOS"
    if "android" in lower:
        return "Android"
    if "windows" in lower:
        return "Windows"
    if any(k in lower for k in ("partner", "cast", "sonos", "echo")):
        return "Cast"
    return "Other"


def main():
    print(f"Reading {INPUT} ...")
    df = pd.read_feather(INPUT)
    total = len(df)

    # music_only filter
    music = df[
        (df["_kind"] == "audio")
        & df["spotify_track_uri"].notna()
        & df["episode_name"].isna()
        & df["audiobook_title"].isna()
    ].copy()
    print(f"  Total rows: {total}, music_only: {len(music)}")

    if len(music) != 260_331:
        print(f"  WARNING: expected 260,331 music rows, got {len(music)}")
        sys.exit(1)

    # Normalize platform
    music["platform"] = music["platform"].apply(normalize_platform)

    # Convert ts to unix seconds
    music["ts"] = music["ts"].astype("int64") // 10**9

    # Select and rename columns for D1
    out = music[
        [
            "ts", "platform", "ms_played", "conn_country",
            "master_metadata_track_name", "master_metadata_album_artist_name",
            "master_metadata_album_album_name", "spotify_track_uri",
            "reason_start", "reason_end", "shuffle", "offline",
            "year", "month", "hour", "local_hour", "minutes",
        ]
    ].rename(columns={
        "master_metadata_track_name": "track_name",
        "master_metadata_album_artist_name": "artist_name",
        "master_metadata_album_album_name": "album_name",
    })

    # Cast booleans to int
    out["shuffle"] = out["shuffle"].astype(int)
    out["offline"] = out["offline"].fillna(0).astype(int)

    # Fill NaN strings with empty
    for col in ["reason_start", "reason_end"]:
        out[col] = out[col].fillna("")

    # Write NDJSON
    print(f"Writing {OUTPUT} ...")
    with open(OUTPUT, "w") as f:
        for _, row in out.iterrows():
            f.write(json.dumps(row.to_dict(), ensure_ascii=False) + "\n")

    print(f"  Wrote {len(out)} lines to {OUTPUT}")
    print("Done.")


if __name__ == "__main__":
    main()
