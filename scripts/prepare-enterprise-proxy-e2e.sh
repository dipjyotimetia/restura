#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="/tmp/restura-enterprise-e2e"

cd "$repo_root"
npm run echo:local:certs
sudo install -d -m 0755 "$fixture_root"
sudo install -m 0644 echo-local/certs/ca.crt "$fixture_root/ca.crt"
sudo install -m 0644 echo-local/enterprise-policy.e2e.json "$fixture_root/policy.json"
test -r "$fixture_root/ca.crt"
test -r "$fixture_root/policy.json"
test ! -w "$fixture_root/ca.crt"
test ! -w "$fixture_root/policy.json"
echo "Installed protected enterprise E2E fixtures under $fixture_root"
