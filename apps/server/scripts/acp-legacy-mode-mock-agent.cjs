const readline = require("node:readline");
let modeId = "code";
const modes = () => ({
  currentModeId: modeId,
  availableModes: [
    { id: "code", name: "Code" },
    { id: "architect", name: "Architect" },
  ],
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "legacy-mode-fixture", version: "1" },
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "test", name: "Test" }],
      };
      break;
    case "authenticate":
      result = {};
      break;
    case "session/new":
      result = { sessionId: "mock-session-1", modes: modes() };
      break;
    case "session/set_mode":
      modeId = request.params.modeId;
      result = {};
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
