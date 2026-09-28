import assert from "node:assert/strict";
import { PairingStore } from "../pairing";

let passed = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected);
  passed++;
  console.log(`ok   ${label}`);
}

const store = new PairingStore();

// 1. Session creation
const session = store.createSession("My MacBook", "mac", "https://web.test");
assert.ok(session.deviceCode.length >= 32, "deviceCode is high entropy");
assert.ok(session.userCode.startsWith("VIBE-"), "userCode format");
eq("verificationUri matches userCode", session.verificationUri, `https://web.test/pair?code=${session.userCode}`);
eq("expires in 600s", session.expiresIn, 600);

// 2. Lookup by userCode
const lookup = store.getInfo(session.userCode);
eq("lookup valid", lookup.valid, true);
eq("lookup deviceName", lookup.deviceName, "My MacBook");
eq("lookup os", lookup.os, "mac");
eq("lookup not approved", lookup.alreadyApproved, false);

// A Bonjour hostname drops its network suffix; anything else is kept as sent
const named = (name: string) => store.getInfo(store.createSession(name, "mac", "https://web.test").userCode).deviceName;
eq("hostname .local suffix dropped", named("MacBook-Air-Noname.local"), "MacBook-Air-Noname");
eq("suffix match ignores case", named("studio.LOCAL"), "studio");
eq("a .local-only name falls back", named(".local"), "My Device");
eq("an inner .local is kept", named("my.local.box"), "my.local.box");

// Case insensitive lookup
const lowerLookup = store.getInfo(session.userCode.toLowerCase());
eq("case insensitive lookup valid", lowerLookup.valid, true);

// 3. Poll before approval
const pendingPoll = store.poll(session.deviceCode);
eq("poll before approve is pending", pendingPoll.status, "pending");

// 4. Approval
const approveResult = store.approve(session.userCode, "u_test_user", "raw_secret_token_123");
eq("approve succeeds", approveResult, true);

// Cannot approve twice
const approveAgain = store.approve(session.userCode, "u_other_user", "raw_second_token");
eq("cannot approve already approved session", approveAgain, false);

// 5. Poll after approval
const approvedPoll = store.poll(session.deviceCode);
eq("poll returns approved", approvedPoll.status, "approved");
eq("poll returns token", approvedPoll.token, "raw_secret_token_123");
eq("poll returns userId", approvedPoll.userId, "u_test_user");

// 6. Single-use token claim (token destroyed immediately upon claim)
const secondPoll = store.poll(session.deviceCode);
eq("second poll returns expired (session removed after claim)", secondPoll.status, "expired");

// 6b. Reserve -> issue: no token can leave before its row exists, and a second Allow
// never mints another one (QA 2026-09-29: phantom device after a pair-page reload)
const two = store.createSession("Studio", "mac", "https://web.test");
eq("first Allow reserves", store.reserve(two.userCode, "u_a"), "reserved");
eq("reserved but not issued: the device still waits", store.poll(two.deviceCode).status, "pending");
eq("same account again is the same approval", store.reserve(two.userCode, "u_a"), "mine");
eq("another account cannot take it", store.reserve(two.userCode, "u_b"), "taken");
eq("only the reserving account can issue", store.issue(two.userCode, "u_b", "tok_b"), false);
eq("issue after the row exists", store.issue(two.userCode, "u_a", "tok_a"), true);
eq("issued once", store.issue(two.userCode, "u_a", "tok_again"), false);
eq("the device collects the first token", store.poll(two.deviceCode).token, "tok_a");
eq("a claimed code is gone", store.reserve(two.userCode, "u_a"), "invalid");

const failedInsert = store.createSession("Laptop", "windows", "https://web.test");
store.reserve(failedInsert.userCode, "u_a");
store.release(failedInsert.userCode, "u_a");
eq("a failed insert releases the code", store.reserve(failedInsert.userCode, "u_b"), "reserved");
store.release(failedInsert.userCode, "u_a");
eq("release by another account is a no-op", store.reserve(failedInsert.userCode, "u_b"), "mine");

// 7. Expired session behavior
const shortTtlStore = new PairingStore();
const expiredSession = shortTtlStore.createSession("PC", "windows", "https://web.test");
// Artificially expire the session
const sessionObj = (shortTtlStore as unknown as { byUserCode: Map<string, { expiresAt: number }> }).byUserCode.get(expiredSession.userCode);
if (sessionObj) sessionObj.expiresAt = Date.now() - 1000;

eq("lookup of expired session is not valid", shortTtlStore.getInfo(expiredSession.userCode).valid, false);
const expiredApprove = shortTtlStore.approve(expiredSession.userCode, "u1", "tok");
eq("cannot approve expired session", expiredApprove, false);
eq("poll of expired session returns expired", shortTtlStore.poll(expiredSession.deviceCode).status, "expired");

console.log(`\n${passed} passed, 0 failed`);
