#!/bin/bash
# Local "preflight" for OpenPLC v3: reproduces the first two steps of
# OpenPLC_v3/webserver/scripts/compile_program.sh (iec2c, then g++ -c of
# Config0.c / Res0.c) without touching a runtime.
#
# Usage: preflight_matiec.sh <program.st> [outdir]
# Env overrides: IEC2C, IEC_LIB (ST std lib dir for iec2c -I), C_LIB (C headers for g++ -I)
# Exit codes: 0 ok, 1 iec2c failed, 2 C compile failed, 3 required v3 files missing
set -u
SCRATCH=${MM_TOOLS:-$HOME/mm-tools}
IEC2C=${IEC2C:-$SCRATCH/refs/matiec-build/iec2c}
IEC_LIB=${IEC_LIB:-$SCRATCH/refs/OpenPLC_v3/webserver/lib}
C_LIB=${C_LIB:-$SCRATCH/refs/OpenPLC_v3/webserver/core/lib}

ST_FILE=$(realpath "$1")
OUT=${2:-$(mktemp -d)}
mkdir -p "$OUT"
cd "$OUT" || exit 3

echo "\$ $IEC2C -f -l -p -r -R -a -I $IEC_LIB -T $OUT $ST_FILE"
"$IEC2C" -f -l -p -r -R -a -I "$IEC_LIB" -T "$OUT" "$ST_FILE"
rc=$?
if [ $rc -ne 0 ]; then
  echo "PREFLIGHT: iec2c failed (exit $rc)"
  exit 1
fi

# compile_program.sh does: mv -f POUS.c POUS.h LOCATED_VARIABLES.h VARIABLES.csv Config0.c Config0.h Res0.c ./core/
for f in POUS.c POUS.h LOCATED_VARIABLES.h VARIABLES.csv Config0.c Config0.h Res0.c; do
  if [ ! -f "$OUT/$f" ]; then
    echo "PREFLIGHT: missing $f (v3 needs CONFIGURATION Config0 / RESOURCE Res0)"
    exit 3
  fi
done

for f in Config0.c Res0.c; do
  echo "\$ g++ -std=gnu++11 -I $C_LIB -c $f -w"
  if ! g++ -std=gnu++11 -I "$C_LIB" -c "$f" -o "${f%.c}.o" -w; then
    echo "PREFLIGHT: g++ failed on $f"
    exit 2
  fi
done
echo "PREFLIGHT: OK ($OUT)"
exit 0
