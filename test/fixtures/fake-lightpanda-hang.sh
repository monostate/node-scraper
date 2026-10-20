#!/bin/sh
# Pretends to be lightpanda but never listens: used to test start timeouts.
if [ "$1" = "version" ]; then echo 1.0.1; exit 0; fi
exec sleep 60
