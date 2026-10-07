import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, executeTool, createToolState } from "./tools.js";

// TODO: set the base URL and model for your OpenAI-compatible provider.
const LLM_BASE_URL = "https://opencode.ai/inference/openai/v1";
const LLM_MODEL = "glm-5.3";

// Per model call. Later rounds carry every member plus tool results, so they
// are slower than lunch-uncle's, which used 20 seconds.
const LLM_TIMEOUT_MS = 60_000;
const MAX_ROUNDS = 8;

const GAVE_UP_REPLY = "Referee tried too many times already. Try again in a bit.";

/**
 * Run the agentic loop for one shortlist and return the referee's reply.
 *
 * Resolves to { reply, shortlist }. shortlist is what the model passed to
 * write_shortlist (the last valid call wins), or null if it never did, in
 * which case the caller records the reply as a "could not decide" row. The
 * loop does not write to D1 itself.
 */
export async function runLoop(message, env, room) {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: message },
  ];

  const ctx = { env, room, state: createToolState() };

  // One session id per run, shared by every model call in this loop, so the
  // OpenCode Go endpoint can route and cache consistently.
  const sessionId = crypto.randomUUID();

  let round = 0;
  while (round < MAX_ROUNDS) {
    let assistant;
    try {
      assistant = await callModel(messages, env, sessionId);
    } catch (err) {
      // The shortlist is only stored after the run, so do not lose a valid one
      // because the wrap-up call failed. Its summary is the verdict anyway.
      if (ctx.state.shortlist) {
        console.error("model call failed after write_shortlist, keeping it:", err);
        return { reply: ctx.state.shortlist.summary, shortlist: ctx.state.shortlist };
      }
      throw err;
    }
    messages.push(assistant);

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { reply: assistant.content ?? "", shortlist: ctx.state.shortlist };
    }

    for (const call of toolCalls) {
      const args = parseArgs(call.function.arguments);
      console.log(`room ${room} round ${round}: ${call.function.name}`, args);
      const result = await executeTool(call.function.name, args, ctx);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    round++;
  }

  return { reply: GAVE_UP_REPLY, shortlist: ctx.state.shortlist };
}

async function callModel(messages, env, sessionId) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: toolDefinitions,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices[0].message;
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
