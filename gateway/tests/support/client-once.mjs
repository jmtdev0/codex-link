// Test-only independent process. Private credentials travel solely over pipes.
import { createLinkClient } from "../../worker/link-client.js";
let bytes = ""; for await (const chunk of process.stdin) { bytes += chunk; if (bytes.length > 32768) throw new Error("Test input limit"); }
const input = JSON.parse(bytes), link = createLinkClient(input.session);
const session = await link.resume(), batch = await link.receive({ waitMs: 0 });
if (input.reply) await link.send(input.reply, { requestId: input.requestId });
process.stdout.write(JSON.stringify({ participantId: session.participantId, processId: process.pid, messages: batch.messages, cursor: batch.nextCursor }));
