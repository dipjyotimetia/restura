# Vendored `google.rpc` protos

Canonical copies of Google's rich-error protos, used only by the gRPC
conformance mocks (`e2e/mocks/conformanceServer.ts`) to send real
`google.rpc.Status` details. Generated into `../../gen/google/rpc/` by
`buf generate` (protoc-gen-es).

| File | Upstream | Commit | sha256 |
|---|---|---|---|
| `status.proto` | [googleapis/googleapis `google/rpc/status.proto`](https://github.com/googleapis/googleapis/blob/dcd4ef2f4046da9658750166f99ed9d27e656cdd/google/rpc/status.proto) | `dcd4ef2f4046da9658750166f99ed9d27e656cdd` (2026-11-03) | `f5bfd262e6705c7ae73f32e0ad8ee20ce8c0a2578df8c4f76ebf76b572f295ed` |
| `error_details.proto` | [googleapis/googleapis `google/rpc/error_details.proto`](https://github.com/googleapis/googleapis/blob/dcd4ef2f4046da9658750166f99ed9d27e656cdd/google/rpc/error_details.proto) | `dcd4ef2f4046da9658750166f99ed9d27e656cdd` (2026-11-03) | `5c18d42e6924f447622534b4b7cdb8b53c0606c8ce729b912ee5edf88d1c5520` |

License: Apache-2.0 (header retained in each file). Do not edit; re-vendor
from upstream and update this table instead.
