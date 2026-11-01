// Local protocol fixture. It never contacts a provider or executes a prompted tool.
const readline = require("node:readline");
const output = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let sessionId;
const configOptions = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "test-model",
    options: [{ value: "test-model", name: "Test" }],
  },
];
const setup = () => ({
  sessionId,
  configOptions,
  modes: {
    currentModeId: "agent",
    availableModes: [
      { id: "agent", name: "Agent" },
      { id: "plan", name: "Plan" },
    ],
  },
});
const update = (role, text) =>
  output({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: role, content: { type: "text", text } } },
  });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined || !method) return;
  let result = {};
  if (
    ["authenticate", "session/new", "session/load"].includes(method) &&
    !process.env.CURSOR_API_KEY &&
    process.env.TEST_ACCOUNT !== "legacy"
  )
    return output({ id, error: { code: -32000, message: "Authentication required" } });
  if (method === "fixture/environment")
    result = JSON.parse(
      require("node:child_process").execFileSync(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({home:process.env.HOME,temp:process.env.TMP,cache:process.env.XDG_CACHE_HOME,tool:process.env.TOOL_PATH,account:process.env.TEST_ACCOUNT,key:process.env.CURSOR_API_KEY,cwd:process.cwd()}))",
        ],
        { encoding: "utf8" },
      ),
    );
  else if (method === "initialize")
    result = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
      authMethods: [],
    };
  else if (method === "session/new") {
    sessionId = `native-${process.env.TEST_ACCOUNT}`;
    result = setup();
  } else if (method === "session/load") {
    if (params.sessionId === "missing")
      return output({ id, error: { code: -32602, message: "Session not found" } });
    sessionId = params.sessionId;
    update("user_message_chunk", "Complete original user history");
    update("agent_message_chunk", "Complete original assistant history");
    result = setup();
  } else if (method === "session/fork") {
    sessionId = `${params.sessionId}-fork`;
    result = setup();
  } else if (method === "session/set_config_option") result = { configOptions };
  else if (method === "session/prompt") {
    output({
      method: "cursor/update_todos",
      params: {
        toolCallId: "native-todos",
        todos: [{ content: "Keep native plan", status: "completed" }],
        merge: false,
      },
    });
    output({
      id: "native-create-plan",
      method: "cursor/create_plan",
      params: { toolCallId: "native-plan", plan: "# Native proposed plan" },
    });
    update(
      "agent_message_chunk",
      JSON.stringify({
        cwd: process.cwd(),
        account: process.env.TEST_ACCOUNT,
        home: process.env.HOME,
        temp: process.env.TMP,
        cache: process.env.XDG_CACHE_HOME,
        job: process.env.WORKENV_JOB_ID,
        key: process.env.CURSOR_API_KEY,
        tool: process.env.TOOL_PATH,
      }),
    );
    result = { stopReason: "end_turn" };
  } else if (method === "cursor/list_available_models")
    result = process.env.TEST_CATALOG_FILE
      ? JSON.parse(require("node:fs").readFileSync(process.env.TEST_CATALOG_FILE, "utf8"))
      : { models: [{ value: "test-model", name: "Test model", configOptions }] };
  output({ id, result });
});
