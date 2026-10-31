import { assert, describe, it } from "@effect/vitest";

import { decodeDeepseekHarnessApiKey, deepseekHarnessAuthMethods } from "./auth.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("DeepSeek Harness API key credential", () => {
  it("reads only the versioned secret it wrote", () => {
    assert.equal(
      decodeDeepseekHarnessApiKey(encode({ version: 1, apiKey: " sk-test " })),
      "sk-test",
    );
    assert.equal(decodeDeepseekHarnessApiKey(encode({ version: 2, apiKey: "sk-test" })), undefined);
    assert.equal(decodeDeepseekHarnessApiKey(encode({ version: 1, apiKey: "   " })), undefined);
    assert.equal(decodeDeepseekHarnessApiKey(new TextEncoder().encode("not json")), undefined);
    assert.equal(decodeDeepseekHarnessApiKey(undefined), undefined);
  });

  it("offers one credential method that never shares subscription windows", () => {
    assert.deepEqual(
      deepseekHarnessAuthMethods.map((method) => [method.id, method.type]),
      [["deepseek-api-key", "credentials"]],
    );
  });
});
