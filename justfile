# Development verbs for the zarr-metadata TypeScript package. Recipes run
# with this directory as the working directory regardless of where `just`
# is invoked.

# List available recipes
default:
    @just --list

# Install dependencies
install:
    npm install

# Fetch dependencies when node_modules is missing (fresh clone / new
# machine). npm ci installs exactly the committed lockfile from a clean
# slate; a PARTIALLY extracted node_modules still needs a manual
# `rm -rf node_modules && npm ci`.
_deps:
    @[ -d node_modules ] || npm ci

# Compile src/ to dist/
build: _deps
    npm run build

# Run the test suite; extra args are passed to vitest
test *args: _deps
    npx vitest run {{ args }}

# Type-check the package sources and the test suite (including the
# expectTypeOf assertions, which only exist under the type checker)
typecheck: _deps
    npm run typecheck

# Run the shared conformance corpus against the Python reference
# implementation. `ref` is what `uv run --with` installs: the pinned release
# by default, or a path to a local zarr-python checkout's
# packages/zarr-metadata to test unreleased changes, e.g.
# `just conformance ../zarr-python/packages/zarr-metadata`.
conformance ref="zarr-metadata==0.6.0":
    uv run --with '{{ ref }}' --no-project python scripts/check_conformance.py

# Run everything CI runs for this package
check: typecheck test conformance

# Remove build output
clean:
    npm run clean

# Build the API reference (TypeDoc) into site/
docs: _deps
    npm run docs

# Build and serve the API reference locally
docs-serve: docs
    python3 -m http.server --directory site 8123
