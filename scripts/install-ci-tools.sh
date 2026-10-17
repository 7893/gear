#!/usr/bin/env bash
set -euo pipefail

# Support both GitHub's x86_64 runner and ARM64 development hosts.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    gitleaks_arch=x64
    actionlint_arch=amd64
    gitleaks_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    actionlint_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    ;;
  Linux/aarch64|Linux/arm64)
    gitleaks_arch=arm64
    actionlint_arch=arm64
    gitleaks_sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
    actionlint_sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
    ;;
  *) echo 'Supported platforms: Linux x86_64 and ARM64.' >&2; exit 1 ;;
esac
destination="${1:?Provide a temporary installation directory}"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"

install_tool() {
  local name="$1" url="$2" checksum="$3"
  local archive="$destination/$name.tar.gz"
  curl --fail --silent --show-error --location --retry 3 "$url" -o "$archive"
  echo "$checksum  $archive" | sha256sum --check --status
  tar -xzf "$archive" -C "$destination" "$name"
  rm "$archive"
}

install_tool gitleaks \
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${gitleaks_arch}.tar.gz" \
  "$gitleaks_sha"
install_tool actionlint \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_${actionlint_arch}.tar.gz" \
  "$actionlint_sha"
