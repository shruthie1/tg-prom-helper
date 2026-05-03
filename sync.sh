#!/usr/bin/env bash
# Sync script: Copy all files from remote repo (tg-promo-helper) to local repo (common)
# Force replaces existing files but does NOT delete extra files in local
# Usage: ./sync.sh

set -euo pipefail

# Get script directory (local repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO_DIR="$SCRIPT_DIR"

# Calculate remote repo path (assumes sibling directory structure)
REMOTE_REPO_DIR="$(cd "$LOCAL_REPO_DIR/.." && pwd)/../tg-promo-helper"

# Resolve to absolute path
REMOTE_REPO_DIR="$(cd "$REMOTE_REPO_DIR" 2>/dev/null && pwd)" || {
  echo "❌ Error: Remote repo not found at expected location"
  echo "   Expected: /Users/SaiKumar.Shetty/Documents/Projects/tg-promo-helper"
  exit 1
}

# Check if remote repo exists
if [[ ! -d "$REMOTE_REPO_DIR" ]]; then
  echo "❌ Error: Remote repo not found at $REMOTE_REPO_DIR"
  echo "   Please update REMOTE_REPO_DIR in this script."
  exit 1
fi

# Log file for sync operations
LOG_FILE="$LOCAL_REPO_DIR/sync.log"
SYNC_ERRORS="$LOCAL_REPO_DIR/sync-errors.log"

# Initialize log files
echo "=== Sync started at $(date) ===" > "$LOG_FILE"
echo "=== Sync errors at $(date) ===" > "$SYNC_ERRORS"

echo "🔄 Syncing files from remote to local..."
echo "   Remote: $REMOTE_REPO_DIR"
echo "   Local:  $LOCAL_REPO_DIR"
echo "   Log:    $LOG_FILE"
echo ""

# Exclude directories (will be pruned from find, preventing traversal)
EXCLUDE_DIRS=(
  ".git"
  "node_modules"
  ".husky"
  "out"
  "dist"
  "coverage"
  ".cursor"
  ".vscode"
)

# Exclude file patterns (checked after find)
EXCLUDE_FILE_PATTERNS=(
  ".env"
  "*.log"
  "sync-audit.log"
  "sync.log"
  "sync-errors.log"
  ".DS_Store"
  "Thumbs.db"
)

# Function to check if file path should be excluded
should_exclude_file() {
  local path="$1"
  local basename_path
  basename_path=$(basename "$path")

  for pattern in "${EXCLUDE_FILE_PATTERNS[@]}"; do
    # Handle wildcard patterns
    if [[ "$pattern" == *"*"* ]]; then
      local pattern_base="${pattern//\*/}"
      if [[ "$basename_path" == *"$pattern_base"* ]]; then
        return 0
      fi
    else
      if [[ "$path" == *"$pattern"* ]] || [[ "$basename_path" == "$pattern" ]]; then
        return 0
      fi
    fi
  done
  return 1
}

# Function to verify file copy
verify_copy() {
  local src="$1"
  local dest="$2"

  if [[ ! -f "$dest" ]]; then
    return 1
  fi

  local src_size=0
  local dest_size=0

  if command -v stat >/dev/null 2>&1; then
    src_size=$(stat -f%z "$src" 2>/dev/null || echo "0")
    dest_size=$(stat -f%z "$dest" 2>/dev/null || echo "0")
  fi

  if [[ "$src_size" == "0" ]] || [[ "$dest_size" == "0" ]]; then
    src_size=$(stat -c%s "$src" 2>/dev/null || echo "0")
    dest_size=$(stat -c%s "$dest" 2>/dev/null || echo "0")
  fi

  if [[ "$src_size" == "0" ]] || [[ "$dest_size" == "0" ]]; then
    src_size=$(wc -c < "$src" 2>/dev/null | tr -d ' ' || echo "0")
    dest_size=$(wc -c < "$dest" 2>/dev/null | tr -d ' ' || echo "0")
  fi

  if [[ "$src_size" != "$dest_size" ]]; then
    return 1
  fi

  if [[ "$src_size" -lt 1048576 ]] && [[ "$src_size" -gt 0 ]]; then
    local src_hash=""
    local dest_hash=""

    if command -v md5sum >/dev/null 2>&1; then
      src_hash=$(md5sum "$src" 2>/dev/null | cut -d' ' -f1 || echo "")
      dest_hash=$(md5sum "$dest" 2>/dev/null | cut -d' ' -f1 || echo "")
    elif command -v md5 >/dev/null 2>&1; then
      src_hash=$(md5 -q "$src" 2>/dev/null || echo "")
      dest_hash=$(md5 -q "$dest" 2>/dev/null || echo "")
    elif command -v shasum >/dev/null 2>&1; then
      src_hash=$(shasum -a 256 "$src" 2>/dev/null | cut -d' ' -f1 || echo "")
      dest_hash=$(shasum -a 256 "$dest" 2>/dev/null | cut -d' ' -f1 || echo "")
    fi

    if [[ -n "$src_hash" ]] && [[ -n "$dest_hash" ]] && [[ "$src_hash" != "$dest_hash" ]]; then
      return 1
    fi
  fi

  return 0
}

# Counters
TOTAL_FILES=0
SYNCED_FILES=0
UPDATED_FILES=0
UNCHANGED_FILES=0
FAILED_FILES=0
SKIPPED_FILES=0
DIRS_CREATED=0
FILE_COUNT=0

# Collect all files first
echo "📋 Scanning remote repository..."
TEMP_FILE_LIST=$(mktemp 2>/dev/null || echo "/tmp/sync_files_$$.txt")

{
  find "$REMOTE_REPO_DIR" \
    \( -name ".git" -type d -prune \) -o \
    \( -name "node_modules" -type d -prune \) -o \
    \( -name ".husky" -type d -prune \) -o \
    \( -name "out" -type d -prune \) -o \
    \( -name "dist" -type d -prune \) -o \
    \( -name "coverage" -type d -prune \) -o \
    \( -name ".cursor" -type d -prune \) -o \
    \( -name ".vscode" -type d -prune \) -o \
    \( -type f -print \)
} 2>/dev/null | sort > "$TEMP_FILE_LIST"

# Filter out excluded file patterns
TEMP_FILTERED=$(mktemp 2>/dev/null || echo "/tmp/sync_files_filtered_$$.txt")
> "$TEMP_FILTERED"
while IFS= read -r file || [[ -n "$file" ]]; do
  rel_path="${file#$REMOTE_REPO_DIR/}"
  if ! should_exclude_file "$rel_path"; then
    echo "$file" >> "$TEMP_FILTERED"
  fi
done < "$TEMP_FILE_LIST"
mv "$TEMP_FILTERED" "$TEMP_FILE_LIST"

TOTAL_FILES=$(wc -l < "$TEMP_FILE_LIST" | tr -d ' ')

echo "   Found $TOTAL_FILES files to process"
echo ""

# Create all directories first
echo "📁 Creating directories..."
TEMP_DIRS_LIST=$(mktemp 2>/dev/null || echo "/tmp/sync_dirs_$$.txt")
> "$TEMP_DIRS_LIST"

while IFS= read -r file || [[ -n "$file" ]]; do
  rel_path="${file#$REMOTE_REPO_DIR/}"
  if [[ -n "$rel_path" ]]; then
    dest_file="$LOCAL_REPO_DIR/$rel_path"
    dest_dir="$(dirname "$dest_file")"

    if [[ -n "$dest_dir" ]] && [[ ! -d "$dest_dir" ]]; then
      if ! grep -Fxq "$dest_dir" "$TEMP_DIRS_LIST" 2>/dev/null; then
        if mkdir -p "$dest_dir" 2>/dev/null; then
          DIRS_CREATED=$((DIRS_CREATED + 1))
          echo "  ✓ Created directory: $dest_dir" | tee -a "$LOG_FILE"
        else
          echo "⚠️  Warning: Failed to create directory: $dest_dir" | tee -a "$SYNC_ERRORS"
        fi
        echo "$dest_dir" >> "$TEMP_DIRS_LIST"
      fi
    fi
  fi
done < "$TEMP_FILE_LIST"

rm -f "$TEMP_DIRS_LIST"

echo "   Created/verified $DIRS_CREATED directories"
echo ""

# Copy all files with verification
echo "📦 Copying files..."
PROGRESS_INTERVAL=$((TOTAL_FILES / 20))
if [[ $PROGRESS_INTERVAL -lt 5 ]]; then
  PROGRESS_INTERVAL=5
fi

while IFS= read -r file || [[ -n "$file" ]]; do
  FILE_COUNT=$((FILE_COUNT + 1))
  rel_path="${file#$REMOTE_REPO_DIR/}"

  if [[ $((FILE_COUNT % 3)) -eq 0 ]] || [[ $FILE_COUNT -le 10 ]]; then
    echo "   [$FILE_COUNT/$TOTAL_FILES] Processing: $rel_path"
  fi

  if should_exclude_file "$rel_path"; then
    SKIPPED_FILES=$((SKIPPED_FILES + 1))
    continue
  fi

  dest_file="$LOCAL_REPO_DIR/$rel_path"
  dest_dir="$(dirname "$dest_file")"

  if [[ ! -d "$dest_dir" ]]; then
    if mkdir -p "$dest_dir" 2>/dev/null; then
      DIRS_CREATED=$((DIRS_CREATED + 1))
    else
      echo "❌ Failed to create directory: $dest_dir" | tee -a "$SYNC_ERRORS"
      FAILED_FILES=$((FAILED_FILES + 1))
      continue
    fi
  fi

  file_size=""
  if command -v stat >/dev/null 2>&1; then
    file_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "?")
  else
    file_size=$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo "?")
  fi

  needs_copy=true
  if [[ -f "$dest_file" ]]; then
    src_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null | tr -d ' ' || echo "0")
    dest_size=$(stat -f%z "$dest_file" 2>/dev/null || stat -c%s "$dest_file" 2>/dev/null || wc -c < "$dest_file" 2>/dev/null | tr -d ' ' || echo "0")
    if [[ "$src_size" == "$dest_size" ]] && [[ "$src_size" != "0" ]]; then
      needs_copy=false
      UNCHANGED_FILES=$((UNCHANGED_FILES + 1))
      SYNCED_FILES=$((SYNCED_FILES + 1))
      echo "  ⊙ Unchanged: $rel_path ($file_size bytes)" >> "$LOG_FILE"
    fi
  fi

  if [[ "$needs_copy" == true ]]; then
    if cp -f "$file" "$dest_file" 2>/dev/null; then
      src_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null | tr -d ' ' || echo "0")
      dest_size=$(stat -f%z "$dest_file" 2>/dev/null || stat -c%s "$dest_file" 2>/dev/null || wc -c < "$dest_file" 2>/dev/null | tr -d ' ' || echo "0")

      if [[ "$src_size" == "$dest_size" ]] && [[ "$src_size" != "0" ]]; then
        UPDATED_FILES=$((UPDATED_FILES + 1))
        SYNCED_FILES=$((SYNCED_FILES + 1))
        echo "  ✓ Updated: $rel_path ($file_size bytes)" >> "$LOG_FILE"

        if [[ $((FILE_COUNT % PROGRESS_INTERVAL)) -eq 0 ]]; then
          echo "   ✓ Progress: $FILE_COUNT/$TOTAL_FILES files processed ($UPDATED_FILES updated, $UNCHANGED_FILES unchanged, $FAILED_FILES failed)..."
        fi
      else
        echo "❌ Verification failed: $rel_path (size mismatch)" | tee -a "$SYNC_ERRORS"
        FAILED_FILES=$((FAILED_FILES + 1))
      fi
    else
      echo "❌ Copy failed: $rel_path" | tee -a "$SYNC_ERRORS"
      FAILED_FILES=$((FAILED_FILES + 1))
    fi
  fi
done < "$TEMP_FILE_LIST"

rm -f "$TEMP_FILE_LIST"

echo ""
echo "=========================================="
echo "✅ Sync completed!"
echo ""
echo "📊 Summary:"
echo "   Total files:    $TOTAL_FILES"
echo "   Updated:        $UPDATED_FILES"
echo "   Unchanged:      $UNCHANGED_FILES"
echo "   Failed:         $FAILED_FILES"
echo "   Skipped:        $SKIPPED_FILES"
echo "   Directories:    $DIRS_CREATED"
echo ""
echo "📝 Logs:"
echo "   Details:        $LOG_FILE"
if [[ $FAILED_FILES -gt 0 ]]; then
  echo "   Errors:         $SYNC_ERRORS"
fi
echo ""
echo "ℹ️  Note: Extra files in local repo were NOT deleted"
echo "=========================================="

{
  echo ""
  echo "=== Sync completed at $(date) ==="
  echo "Total files: $TOTAL_FILES | Updated: $UPDATED_FILES | Unchanged: $UNCHANGED_FILES | Failed: $FAILED_FILES | Skipped: $SKIPPED_FILES | Directories created: $DIRS_CREATED"
} >> "$LOG_FILE"

if [[ $FAILED_FILES -gt 0 ]]; then
  exit 1
fi

exit 0
