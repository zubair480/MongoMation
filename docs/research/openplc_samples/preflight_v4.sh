#!/bin/bash
# Local "preflight" for OpenPLC Runtime v4 (>= v4.1, STruC++ pipeline).
# 1) STruC++ (same options as openplc-editor) -> bundle + program.zip
# 2) the same g++ steps the runtime's scripts/Makefile.strucpp runs on upload
#    (minus ccache and python_loader.o), producing new_libplc.so.
#
# Usage: preflight_v4.sh <program.st> <outdir> [modbus_master.json] [modbus_slave.json]
# Env: RUNTIME_SRC = an openplc-runtime checkout (for runtime_v4_entry.cpp + iec_python.h)
# Exit: 0 ok (outdir/program.zip ready to upload), 4 STruC++ error, 5 g++ error
set -u
SCRATCH=${MM_TOOLS:-$HOME/mm-tools}
HERE=$(cd "$(dirname "$0")" && pwd)
RUNTIME_SRC=${RUNTIME_SRC:-$SCRATCH/refs/openplc-runtime}
ST=$(realpath "$1"); OUT=$(realpath -m "$2"); shift 2

node "$HERE/build_v4_bundle.mjs" "$ST" "$OUT" "$@" || exit 4

W="$OUT/runtime_sim"
rm -rf "$W"; mkdir -p "$W/core/strucpp_runtime" "$W/core/src/plc_app/include" "$W/build"
cp -a "$OUT/bundle" "$W/core/generated"
cp "$RUNTIME_SRC/core/strucpp_runtime/runtime_v4_entry.cpp" "$W/core/strucpp_runtime/"
cp "$RUNTIME_SRC/core/src/plc_app/include/iec_python.h" "$W/core/src/plc_app/include/"
cd "$W" || exit 5

FLAGS="-std=c++17 -O1 -pipe -fPIC -Wall -DSTRUCPP_THREADED -fno-gnu-unique -Wno-unknown-pragmas -Wno-deprecated-declarations -I core/generated -I core/generated/strucpp_runtime/include -I core/src/plc_app/include"
for f in core/generated/*.cpp; do
  o="build/$(basename "${f%.cpp}").o"
  echo "\$ g++ $FLAGS -include iec_python.h -c $f -o $o"
  g++ $FLAGS -include iec_python.h -c "$f" -o "$o" || { echo "PREFLIGHT_V4: g++ failed on $f"; exit 5; }
done
# STruC++ >= 0.6.5 ships iec_retain.hpp, so the runtime's probe enables retain exports.
RETAIN=""; [ -f core/generated/strucpp_runtime/include/iec_retain.hpp ] && RETAIN="-DSTRUCPP_SHIM_HAS_RETAIN"
echo "\$ g++ $FLAGS $RETAIN -c core/strucpp_runtime/runtime_v4_entry.cpp -o build/runtime_v4_entry.o"
g++ $FLAGS $RETAIN -c core/strucpp_runtime/runtime_v4_entry.cpp -o build/runtime_v4_entry.o || { echo "PREFLIGHT_V4: shim failed (CONFIGURATION Config0 missing?)"; exit 5; }
g++ -shared -fPIC -o build/new_libplc.so build/*.o -lpthread -lrt || { echo "PREFLIGHT_V4: link failed"; exit 5; }
echo "PREFLIGHT_V4: OK -> $OUT/program.zip ($(stat -c %s "$OUT/program.zip") bytes)"
