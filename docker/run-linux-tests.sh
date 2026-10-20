#!/usr/bin/env bash
# Build the Linux test image and run the full suite inside it.
# Usage: docker/run-linux-tests.sh [--platform linux/amd64|linux/arm64] [extra docker run args]
set -euo pipefail
cd "$(dirname "$0")/.."
PLATFORM=""
if [ "${1:-}" = "--platform" ]; then PLATFORM="$2"; shift 2; fi
if [ -n "$PLATFORM" ]; then
  docker build --platform "$PLATFORM" -f docker/Dockerfile.test -t node-scraper-test .
  docker run --rm --platform "$PLATFORM" --shm-size=1g "$@" node-scraper-test
else
  docker build -f docker/Dockerfile.test -t node-scraper-test .
  docker run --rm --shm-size=1g "$@" node-scraper-test
fi
