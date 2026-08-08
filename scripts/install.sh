#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.sh | sh
#
# Options:
#   --source       Install a persistent source checkout (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="${OMP_REPO:-yequ172672/oh-my-pi-cn}"
PACKAGE="${OMP_PACKAGE:-omp-cn}"
DEFAULT_REF="${OMP_REF:-main}"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
SOURCE_DIR="${OMP_SOURCE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-cn/source}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install from a selected fork ref. The checkout is intentionally persistent:
# `bun link` points at this workspace, so deleting it would break the command.
install_from_source() {
    source_ref="$1"
    if ! has_git; then
        echo "git is required for source installation"
        exit 1
    fi

    SOURCE_STAGE="$(mktemp -d)"
    trap 'rm -rf "$SOURCE_STAGE"' EXIT

    if ! git clone --depth 1 --branch "$source_ref" "https://github.com/${REPO}.git" "$SOURCE_STAGE/repo" >/dev/null 2>&1; then
        rm -rf "$SOURCE_STAGE/repo"
        git clone "https://github.com/${REPO}.git" "$SOURCE_STAGE/repo" || {
            echo "Failed to clone https://github.com/${REPO}.git"
            return 1
        }
        (cd "$SOURCE_STAGE/repo" && git checkout "$source_ref") || {
            echo "Failed to checkout $source_ref"
            return 1
        }
    fi

    # Pull LFS files
    if has_git_lfs; then
        (cd "$SOURCE_STAGE/repo" && git lfs pull) || return 1
    fi

    if [ ! -d "$SOURCE_STAGE/repo/packages/coding-agent" ]; then
        echo "Expected package at ${SOURCE_STAGE}/repo/packages/coding-agent"
        exit 1
    fi

    SOURCE_COMMIT="$(cd "$SOURCE_STAGE/repo" && git rev-parse HEAD)" || return 1
    case "$SOURCE_COMMIT" in
        ''|*[!0-9a-fA-F]*) echo "Invalid source commit: $SOURCE_COMMIT"; return 1 ;;
    esac

    mkdir -p "$SOURCE_DIR"
    SOURCE_TARGET="$SOURCE_DIR/$SOURCE_COMMIT"
    if [ ! -d "$SOURCE_TARGET" ]; then
        mv "$SOURCE_STAGE/repo" "$SOURCE_TARGET" || return 1
    fi

    echo "Installing workspace dependencies in $SOURCE_TARGET..."
    (cd "$SOURCE_TARGET" && bun install --frozen-lockfile) || {
        echo "Failed to install source workspace dependencies"
        return 1
    }

    bun --cwd="$SOURCE_TARGET/packages/coding-agent" link || {
        echo "Failed to link coding-agent from $SOURCE_TARGET"
        return 1
    }
    (cd "$SOURCE_TARGET" && sh scripts/link-omp.sh) || {
        echo "Failed to install the source omp wrapper from $SOURCE_TARGET"
        return 1
    }

    echo ""
    echo "✓ Installed omp from source ref $source_ref"
    echo "Source checkout: $SOURCE_TARGET"
    echo "Run 'omp' to get started!"
}

# Install the published fork package via bun. Registry failures are surfaced as
# registry failures; they are not silently reinterpreted as source installs.
install_package() {
    echo "Installing via bun..."
    if ! bun install -g "$PACKAGE"; then
        echo "Failed to install $PACKAGE from npm. Check network access and whether the requested version is published."
        return 1
    fi
    echo ""
    echo "✓ Installed omp via bun"
    echo "Run 'omp' to get started!"
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        echo "No SHA-256 tool found (sha256sum, shasum, or openssl is required)" >&2
        return 1
    fi
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; return 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; return 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            return 1
        fi
    else
        echo "Fetching latest release..."
        if ! RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest"); then
            echo "Failed to fetch the latest release"
            return 1
        fi
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        return 1
    fi
    echo "Using version: $LATEST"
    case "$LATEST" in
        omp-cn-v*) EXPECTED_VERSION="${LATEST#omp-cn-v}" ;;
        v*) EXPECTED_VERSION="${LATEST#v}" ;;
        *) echo "Unsupported release tag format: $LATEST"; return 1 ;;
    esac
    if ! printf '%s' "$EXPECTED_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "Unsupported stable release version in tag: $LATEST"
        return 1
    fi

    mkdir -p "$INSTALL_DIR"
    # Download to the destination filesystem, validate it, then atomically
    # replace the installed command. A failed update must preserve the old one.
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    CHECKSUM_URL="https://github.com/${REPO}/releases/download/${LATEST}/SHA256SUMS.txt"
    echo "Downloading ${BINARY}..."
    BINARY_TMP=$(mktemp "${INSTALL_DIR}/.omp-download.XXXXXX") || return 1
    CHECKSUM_TMP=$(mktemp "${INSTALL_DIR}/.omp-checksums.XXXXXX") || {
        rm -f "$BINARY_TMP"
        return 1
    }
    if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$BINARY_TMP"; then
        rm -f "$BINARY_TMP" "$CHECKSUM_TMP"
        echo "Failed to download ${BINARY} from release ${LATEST}"
        return 1
    fi
    if ! curl -fsSL --connect-timeout 10 --max-time 60 "$CHECKSUM_URL" -o "$CHECKSUM_TMP"; then
        rm -f "$BINARY_TMP" "$CHECKSUM_TMP"
        echo "Failed to download SHA256SUMS.txt from release ${LATEST}"
        return 1
    fi
    EXPECTED_SHA=$(awk -v name="$BINARY" '$2 == name || $2 == "*" name { print tolower($1) }' "$CHECKSUM_TMP")
    ACTUAL_SHA=$(sha256_file "$BINARY_TMP") || {
        rm -f "$BINARY_TMP" "$CHECKSUM_TMP"
        return 1
    }
    if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
        rm -f "$BINARY_TMP" "$CHECKSUM_TMP"
        echo "SHA-256 verification failed for ${BINARY}"
        return 1
    fi
    rm -f "$CHECKSUM_TMP"
    if ! chmod +x "$BINARY_TMP"; then
        rm -f "$BINARY_TMP"
        return 1
    fi

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("$BINARY_TMP" --version 2>&1)"; then
        echo ""
        echo "✗ Downloaded omp cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'omp':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        rm -f "$BINARY_TMP"
        return 1
    fi
    if [ "$SMOKE_OUTPUT" != "omp/$EXPECTED_VERSION" ]; then
        echo "Downloaded ${BINARY} reports '$SMOKE_OUTPUT', expected 'omp/$EXPECTED_VERSION'"
        rm -f "$BINARY_TMP"
        return 1
    fi

    if ! mv -f "$BINARY_TMP" "${INSTALL_DIR}/omp"; then
        rm -f "$BINARY_TMP"
        return 1
    fi

    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_from_source "${REF:-$DEFAULT_REF}"
        ;;
    binary)
        install_binary || exit $?
        ;;
    *)
        # Default: use bun only when it matches the host architecture, otherwise
        # fall back to the prebuilt binary so Rosetta bun can't force an x86_64 build.
        if has_bun && bun_arch_matches_host; then
            require_bun_version
            install_package
        else
            if has_bun; then
                echo "Detected bun with architecture '$(bun_arch)' on a '$(host_arch)' host; using the prebuilt binary instead."
            fi
            if ! install_binary; then
                echo "[WARN] No usable release binary was found; falling back to the $PACKAGE npm package."
                if ! has_bun || ! bun_arch_matches_host; then
                    install_bun
                fi
                require_bun_version
                if ! bun_arch_matches_host; then
                    echo "Installed bun architecture '$(bun_arch)' does not match host architecture '$(host_arch)'."
                    exit 1
                fi
                install_package
            fi
        fi
        ;;
esac
