// Small, frequently-imported non-WKT Google API protos bundled so an uploaded
// `.proto` that imports them (grpc-gateway / Google API style) resolves without
// the user hunting them down. Field numbers and names match
// github.com/googleapis/googleapis (Apache-2.0); comments are stripped. A user
// upload of the same path always takes precedence over these copies.
//
// The google/protobuf/* well-known types are NOT here — they come from
// @bufbuild/protobuf's canonical embedded descriptors (see grpc-proto-compiler).

const HTTP_PROTO = `syntax = "proto3";
package google.api;
option go_package = "google.golang.org/genproto/googleapis/api/annotations;annotations";
option java_package = "com.google.api";

message Http {
  repeated HttpRule rules = 1;
  bool fully_decode_reserved_expansion = 2;
}

message HttpRule {
  string selector = 1;
  oneof pattern {
    string get = 2;
    string put = 3;
    string post = 4;
    string delete = 5;
    string patch = 6;
    CustomHttpPattern custom = 8;
  }
  string body = 7;
  string response_body = 12;
  repeated HttpRule additional_bindings = 11;
}

message CustomHttpPattern {
  string kind = 1;
  string path = 2;
}
`;

const ANNOTATIONS_PROTO = `syntax = "proto3";
package google.api;
import "google/api/http.proto";
import "google/protobuf/descriptor.proto";
option go_package = "google.golang.org/genproto/googleapis/api/annotations;annotations";
option java_package = "com.google.api";

extend google.protobuf.MethodOptions {
  HttpRule http = 72295728;
}
`;

const FIELD_BEHAVIOR_PROTO = `syntax = "proto3";
package google.api;
import "google/protobuf/descriptor.proto";
option go_package = "google.golang.org/genproto/googleapis/api/annotations;annotations";
option java_package = "com.google.api";

extend google.protobuf.FieldOptions {
  repeated google.api.FieldBehavior field_behavior = 1052 [packed = false];
}

enum FieldBehavior {
  FIELD_BEHAVIOR_UNSPECIFIED = 0;
  OPTIONAL = 1;
  REQUIRED = 2;
  OUTPUT_ONLY = 3;
  INPUT_ONLY = 4;
  IMMUTABLE = 5;
  UNORDERED_LIST = 6;
  NON_EMPTY_DEFAULT = 7;
  IDENTIFIER = 8;
}
`;

/** Import path → source text for the bundled Google API protos. */
export const BUNDLED_PROTO_SOURCES: Readonly<Record<string, string>> = {
  'google/api/http.proto': HTTP_PROTO,
  'google/api/annotations.proto': ANNOTATIONS_PROTO,
  'google/api/field_behavior.proto': FIELD_BEHAVIOR_PROTO,
};
