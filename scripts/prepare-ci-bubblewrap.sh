#!/usr/bin/env bash
set -euo pipefail

# Hosted and in-house Linux runners ship no bubblewrap, and installing it
# through the package transaction scans the image's whole dpkg database and runs
# post-install hooks. CI needs only the signed-archive payload, so this script
# downloads the distribution package, verifies it while extracting it into the
# ephemeral runner directory, and proves the binary confines a real process.
#
# The package is resolved through APT's signed package index rather than pinned
# by archive filename. Ubuntu removes a superseded revision from the pool, so a
# pinned `bubblewrap_<version>_amd64.deb` URL rots without warning and takes
# every lane that provisions it down with it. The resolved archive name and its
# SHA-256 are printed below, so a run records exactly which payload it used.

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

root="${RUNNER_TEMP}/dsh-bubblewrap"
download="${RUNNER_TEMP}/dsh-bubblewrap-package"
rm -rf "$root" "$download"
mkdir -p "$root" "$download"

# Refresh the index first: a stale list can name a revision the archive has
# already removed, which would otherwise surface as an unexplained 404.
sudo apt-get update -qq
(cd "$download" && apt-get download bubblewrap)

archive=$(find "$download" -maxdepth 1 -type f -name 'bubblewrap_*_amd64.deb' -print -quit)
if [[ -z "$archive" ]]; then
  echo 'prepare-ci-bubblewrap: the package index resolved no bubblewrap archive' >&2
  exit 1
fi
echo "prepare-ci-bubblewrap: $(basename "$archive")"
sha256sum "$archive"

dpkg-deb --extract "$archive" "$root"
printf '%s\n' "$root/usr/bin" >> "$GITHUB_PATH"

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
"$root/usr/bin/bwrap" --version
"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
