#!/bin/sh

set -e

if [ "$1" = "node" ] || [ "$1" = "npm" ]; then
    echo "Running $1 CLI ..."
    npm run dev
fi

echo "Starting application..."
exec "$@"