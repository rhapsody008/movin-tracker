#!/bin/sh
# Render the production manifests for a release, with the app image pinned by
# digest, into <outdir>/movin.yaml. CI runs this on every `git tag vX.Y.Z` and
# publishes the result (ghcr.io/rhapsody008/movin-tracker-deploy:X.Y.Z);
# run it locally to check a render before tagging:
#   deploy/render.sh sha256:<64 hex> /tmp/out
# KUSTOMIZE picks the renderer: "kustomize build" (default) or "kubectl kustomize".
# The working tree is never changed: deploy/ is copied to a temp dir, where a
# throwaway kustomization wraps the prod overlay and swaps the image tag for
# the digest.
set -eu

usage() { echo "usage: $0 sha256:<64 hex digest> <outdir>" >&2; exit 2; }
[ $# -eq 2 ] || usage
digest=$1
out=$2
echo "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo "render: not a sha256 digest: $digest" >&2; exit 2; }

image=ghcr.io/rhapsody008/movin-tracker
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$(dirname "$0")" "$work/deploy"
mkdir "$work/release"
cat > "$work/release/kustomization.yaml" <<YAML
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../deploy/k8s/overlays/prod
images:
  - name: $image
    digest: $digest
YAML

f=$work/movin.yaml
${KUSTOMIZE:-kustomize build} "$work/release" > "$f"

fail() { echo "render: $1" >&2; exit 1; }
[ "$(grep -c "image: $image@$digest\$" "$f")" -eq 1 ] || fail "expected exactly one app image pinned to $digest"
! grep -Eq "image: ($image:|movin:|movin\$)" "$f" || fail "an app image is not pinned by digest"
! grep -Eq '^kind: (Namespace|Secret|PersistentVolumeClaim|PersistentVolume)$' "$f" || fail "a Namespace, Secret or volume object would be published"
! grep -Eq '^  namespace:' "$f" || fail "an object names a namespace (Flux sets it)"
! grep -q 'example\.com' "$f" || fail "placeholder example.com left (host or emails in deploy/)"
n=$(grep -c '^kind:' "$f")
mkdir -p "$out"
mv "$f" "$out/movin.yaml"
echo "rendered $out/movin.yaml ($n objects, $image@$digest)"
