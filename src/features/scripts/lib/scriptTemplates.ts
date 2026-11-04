/** Starter scripts the Scripts editor offers for an empty pre-request / test script. */

export const PRE_REQUEST_TEMPLATE = `// Pre-request Script
// This script runs before the request is sent

// Variables for this request (and the rest of a collection run)
// rs.variables.set("timestamp", Date.now());

// Save to the active environment (kept after the request)
// rs.environment.set("authToken", generateToken());

// Add or replace a header on the outgoing request
// rs.request.headers.upsert({ key: "X-Request-Id", value: rs.variables.get("timestamp") });

// Log to console
// console.log("Request:", rs.request.url);
`;

export const TEST_SCRIPT_TEMPLATE = `// Test Script
// This script runs after the response is received

// Basic status check
rs.test("Status code is 200", function() {
  rs.response.to.have.status(200);
});

// Check response time
rs.test("Response time is acceptable", function() {
  rs.expect(rs.response.responseTime).to.be.below(1000);
});

// Validate response structure
// rs.test("Response has required fields", function() {
//   const json = rs.response.json();
//   rs.expect(json).to.have.property("data");
// });

// Save response data to the active environment for the next request
// rs.environment.set("userId", rs.response.json().data.id);
`;
