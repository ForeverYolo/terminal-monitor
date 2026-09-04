#!/bin/bash
# Deploy script: scp project files to remote machines with retry.
#
# Targets are read from deploy.targets.conf (one per line, ignored if missing).
# Copy deploy.targets.example.conf -> deploy.targets.conf and edit the hosts.
#
# Usage:
#   ./deploy.sh                        # deploy default file set to all targets
#   ./deploy.sh server.js public/index.html   # deploy specific files
#
# Target line format:  label|user|host|port|path

PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$PROJ_DIR/deploy.targets.conf"
MAX_RETRIES=3
RETRY_DELAY=5
DEFAULT_FILES=(server.js client.js supervisor.js ai-overseer.js public/index.html)

if [ ! -f "$CONF" ]; then
  echo "[!] Target config not found: $CONF"
  echo "    Copy deploy.targets.example.conf -> deploy.targets.conf and fill in your hosts."
  exit 1
fi

# Read non-comment, non-empty lines
TARGETS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"          # strip comments
  line="$(echo "$line" | xargs)"  # trim whitespace
  [ -n "$line" ] && TARGETS+=("$line")
done < "$CONF"

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "[!] No targets defined in $CONF"
  exit 1
fi

FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  echo "[*] No files specified, deploying default set:"
  printf '    %s\n' "${DEFAULT_FILES[@]}"
  FILES=("${DEFAULT_FILES[@]}")
fi

failed=0
for target in "${TARGETS[@]}"; do
  IFS='|' read -r label user host port path <<< "$target"
  echo "=== Deploying to $label ($user@$host:$port) ==="
  for file in "${FILES[@]}"; do
    src="$PROJ_DIR/$file"
    if [ ! -f "$src" ]; then
      echo "  [SKIP] $file not found"
      continue
    fi
    echo "  scp $file -> $path/"
    retry=0
    while [ $retry -lt $MAX_RETRIES ]; do
      if scp -P "$port" "$src" "$user@$host:$path/$file"; then
        echo "  [OK] $file"
        break
      else
        retry=$((retry + 1))
        if [ $retry -lt $MAX_RETRIES ]; then
          echo "  [RETRY $retry/$MAX_RETRIES] $file failed, waiting ${RETRY_DELAY}s..."
          sleep "$RETRY_DELAY"
        else
          echo "  [FAIL] $file failed after $MAX_RETRIES attempts"
          failed=$((failed + 1))
        fi
      fi
    done
  done
  echo ""
done

if [ $failed -gt 0 ]; then
  echo "Done with $failed file(s) failed."
  exit 1
else
  echo "All files deployed successfully."
fi
