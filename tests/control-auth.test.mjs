import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlProof, createIdentity, createInvitation, deriveRoomCapability,
  encryptMessage, randomId, verifyControlProof, CONTROL_PROOF_MAX_AGE_MS,
} from "../plugin/src/protocol.mjs";
import { createRelayServer } from "../dev-relay/server.mjs";
import { createSitesRelay } from "../site/worker/index.js";
import { createD1TestDatabase, sqliteAvailable } from "./support/d1-test-db.mjs";

test("control proofs bind the operation, room, participant and exact ACK set", () => {
  const owner = createIdentity();
  const other = createIdentity();
  const invitation = createInvitation();
  const body = { participantId: owner.participantId, messageIds: [randomId(), randomId()] };
  const signed = { ...body, controlProof: createControlProof("acks", invitation.roomId, body, owner) };
  assert.equal(verifyControlProof("acks", invitation.roomId, signed, owner.publicKey), true);
  assert.equal(verifyControlProof("acks", invitation.roomId, { ...signed, messageIds: [...body.messageIds].reverse() }, owner.publicKey), true);
  assert.equal(verifyControlProof("close", invitation.roomId, signed, owner.publicKey), false);
  assert.equal(verifyControlProof("acks", createInvitation().roomId, signed, owner.publicKey), false);
  assert.equal(verifyControlProof("acks", invitation.roomId, { ...signed, participantId: other.participantId }, owner.publicKey), false);
  assert.equal(verifyControlProof("acks", invitation.roomId, { ...signed, messageIds: [randomId()] }, owner.publicKey), false);
  assert.equal(verifyControlProof("acks", invitation.roomId, signed, other.publicKey), false);
  assert.throws(() => createControlProof("acks", invitation.roomId, body, other), /matching in-memory/i);
  const packet = encryptMessage(invitation, owner.participantId, "disposable local message", owner);
  assert.equal(verifyControlProof("acks", invitation.roomId, {
    ...signed, controlProof: { ...signed.controlProof, signature: packet.signature },
  }, owner.publicKey), false, "message signatures cannot be reused as room-control proofs");
});

test("control proof freshness has exact boundaries and malformed proofs fail closed", () => {
  const owner = createIdentity();
  const invitation = createInvitation();
  const body = { participantId: owner.participantId };
  const controlProof = createControlProof("close", invitation.roomId, body, owner);
  const signed = { ...body, controlProof };
  const at = controlProof.issuedAt;
  assert.equal(verifyControlProof("close", invitation.roomId, signed, owner.publicKey, at + CONTROL_PROOF_MAX_AGE_MS - 1), true);
  assert.equal(verifyControlProof("close", invitation.roomId, signed, owner.publicKey, at + CONTROL_PROOF_MAX_AGE_MS), false);
  assert.equal(verifyControlProof("close", invitation.roomId, signed, owner.publicKey, at - 30_000), true);
  assert.equal(verifyControlProof("close", invitation.roomId, signed, owner.publicKey, at - 30_001), false);
  for (const invalid of [null, {}, [], { ...controlProof, v: 2 }, { ...controlProof, extra: true }, { ...controlProof, nonce: "bad" }]) {
    assert.equal(verifyControlProof("close", invitation.roomId, { ...body, controlProof: invalid }, owner.publicKey), false);
  }
});

for (const backend of ["d1", "volatile"]) {
  test(`${backend} relay rejects shared-capability control impersonation and permits legitimate member controls`,
    { skip: backend === "d1" && !sqliteAvailable }, async (t) => {
      let clock = Date.now();
      t.mock.method(Date, "now", () => clock);
      const db = backend === "d1" ? await createD1TestDatabase() : null;
      const worker = backend === "d1" ? createSitesRelay({ cleanupIntervalMs: 0 }) : null;
      const relay = backend === "volatile" ? createRelayServer({ port: 0 }) : null;
      const address = relay ? await relay.listen() : null;
      const baseUrl = address ? `http://127.0.0.1:${address.port}` : "https://control-auth.test";
      if (relay) t.after(() => relay.close());
      if (db) t.after(() => db.close());
      const invitation = createInvitation();
      const capability = deriveRoomCapability(invitation);
      const [owner, guest, other] = Array.from({ length: 3 }, () => createIdentity());
      const root = `/v1/rooms/${invitation.roomId}`;
      async function request(path, method = "GET", body) {
        const headers = { authorization: `Bearer ${capability}`, "cf-connecting-ip": "192.0.2.15" };
        if (body !== undefined) headers["content-type"] = "application/json";
        const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
        return worker ? worker.fetch(new Request(`${baseUrl}${path}`, init), {
          DB: db, CODEX_LINK_RATE_LIMIT_KEY: "test-only-control-auth-rate-limit-key-32-bytes",
        }) : fetch(`${baseUrl}${path}`, init);
      }
      const signed = (action, body, identity, issuedAt = clock) => {
        const before = clock;
        clock = issuedAt;
        try { return { ...body, controlProof: createControlProof(action, invitation.roomId, body, identity) }; }
        finally { clock = before; }
      };
      const member = (identity) => ({ participantId: identity.participantId, publicKey: identity.publicKey, protocolVersion: 2 });
      const ownerBody = { roomId: invitation.roomId, ...member(owner) };
      assert.equal((await request("/v1/rooms", "POST", ownerBody)).status, 403);
      assert.equal((await request("/v1/rooms", "POST", signed("create", ownerBody, owner))).status, 201);
      // Knowing someone's public key is not proof of possessing their private key.
      assert.equal((await request(`${root}/join`, "POST", member(other))).status, 403);
      for (const identity of [guest, other]) {
        assert.equal((await request(`${root}/join`, "POST", signed("join", member(identity), identity))).status, 200);
      }
      assert.equal((await request(`${root}/join`, "POST", member(owner))).status, 403, "public owner IDs and keys do not authorize an owner rejoin");
      assert.equal((await request(`${root}/join`, "POST", signed("join", member(owner), owner))).status, 200);

      const packet = encryptMessage(invitation, guest.participantId, "local control regression", guest);
      assert.equal((await request(`${root}/messages`, "POST", packet)).status, 202);
      const ackOwner = { participantId: owner.participantId, messageIds: [packet.messageId] };
      assert.equal((await request(`${root}/acks`, "POST", ackOwner)).status, 403);
      assert.equal((await request(`${root}/acks`, "POST", signed("acks", ackOwner, owner, clock - CONTROL_PROOF_MAX_AGE_MS))).status, 403);
      assert.equal((await request(`${root}/acks`, "POST", signed("acks", ackOwner, owner, clock + 30_001))).status, 403);
      const guestAck = signed("acks", { ...ackOwner, participantId: guest.participantId }, guest);
      assert.equal((await request(`${root}/acks`, "POST", { ...guestAck, participantId: owner.participantId })).status, 403);
      const ownerInbox = await (await request(`${root}/messages?participantId=${owner.participantId}`)).json();
      assert.equal(ownerInbox.messages.length, 1, "forged ACKs must not erase another participant's queued message");
      const validAck = await request(`${root}/acks`, "POST", signed("acks", ackOwner, owner));
      assert.equal(validAck.status, 200);
      assert.deepEqual(await validAck.json(), { acknowledged: 1 });

      const ownerClose = { participantId: owner.participantId };
      const guestClose = signed("close", { participantId: guest.participantId }, guest);
      assert.equal((await request(root, "DELETE", ownerClose)).status, 403);
      assert.equal((await request(root, "DELETE", { ...guestClose, participantId: owner.participantId })).status, 403);
      assert.equal((await request(root, "DELETE", guestClose)).status, 403, "a valid member signature does not grant owner privileges");

      const otherLeave = { participantId: other.participantId };
      const guestLeave = signed("leave", { participantId: guest.participantId }, guest);
      assert.equal((await request(`${root}/leave`, "POST", otherLeave)).status, 403);
      assert.equal((await request(`${root}/leave`, "POST", { ...guestLeave, participantId: other.participantId })).status, 403);
      assert.equal((await request(`${root}/leave`, "POST", signed("close", otherLeave, other))).status, 403);
      const beforeLeave = await (await request(`${root}/status?participantId=${owner.participantId}`)).json();
      assert.equal(beforeLeave.participantCount, 3);
      assert.equal((await request(`${root}/leave`, "POST", guestLeave)).status, 200);
      assert.equal((await (await request(`${root}/status?participantId=${other.participantId}`)).json()).participantCount, 2);
      assert.equal((await request(`${root}/leave`, "POST", signed("leave", ownerClose, owner))).status, 409);
      assert.equal((await request(root, "DELETE", signed("close", ownerClose, owner))).status, 200);
      assert.equal((await request(`${root}/status?participantId=${other.participantId}`)).status, 404);
    });
}
