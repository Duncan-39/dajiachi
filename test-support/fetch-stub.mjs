// Replace globalThis.fetch for one test. Call restore() in t.after().
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: parseBody(init.body) };
    calls.push(call);
    return handler(call, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// An OpenAI-style chat completion with a plain text reply.
export function textCompletion(content) {
  return jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
}

// An OpenAI-style chat completion that asks for tool calls.
export function toolCompletion(...calls) {
  return jsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map(([name, args], i) => ({
            id: `call_${i}`,
            type: "function",
            function: {
              name,
              arguments: typeof args === "string" ? args : JSON.stringify(args),
            },
          })),
        },
      },
    ],
  });
}

function parseBody(body) {
  try {
    return typeof body === "string" ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}
