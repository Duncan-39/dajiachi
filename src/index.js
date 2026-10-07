import ui from "./ui.html";
import { runLoop } from "./loop.js";
import { DEFAULT_TONE, TONES, isTone } from "./prompt.js";
import { validateMember } from "./validate.js";
import {
  CODE_PATTERN,
  createRoom,
  roomExists,
  listMembers,
  upsertMember,
  addShortlist,
  listShortlists,
} from "./db.js";

// A shortlist costs several LLM and Places calls, so space them out per room.
const DECIDE_COOLDOWN_MS = 10_000;
const MAX_OBJECTION = 300;

const ROOM_ROUTE = /^\/api\/rooms\/([^/]+)(?:\/(members|decide))?$/;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(ui, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && pathname === "/api/rooms") {
      return handleCreateRoom(env);
    }

    const match = pathname.match(ROOM_ROUTE);
    if (match) {
      const code = match[1].toUpperCase();
      const action = match[2];
      if (!CODE_PATTERN.test(code) || !(await roomExists(env.DB, code))) {
        return json({ error: "Room not found" }, 404);
      }
      if (request.method === "GET" && !action) return handleGetRoom(env, code);
      if (request.method === "PUT" && action === "members") return handleJoin(request, env, code);
      if (request.method === "POST" && action === "decide") return handleDecide(request, env, code);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleCreateRoom(env) {
  try {
    return json({ code: await createRoom(env.DB) }, 201);
  } catch (err) {
    console.error("create room failed:", err);
    return json({ error: "Could not create a room, try again." }, 500);
  }
}

async function handleGetRoom(env, code) {
  const [members, shortlists] = await Promise.all([
    listMembers(env.DB, code),
    listShortlists(env.DB, code),
  ]);
  return json({ code, members, shortlists });
}

async function handleJoin(request, env, code) {
  const body = await readJson(request);
  if (!body) return json({ error: "Body must be JSON" }, 400);

  const { value, error } = validateMember(body);
  if (error) return json({ error }, 400);

  const result = await upsertMember(env.DB, code, value);
  if (result.error) return json({ error: result.error }, 409);
  return json({ ok: true });
}

async function handleDecide(request, env, code) {
  if (!env.OPENCODE_API_KEY || !env.GOOGLE_PLACES_API_KEY) {
    return json({ error: "The referee is not set up yet (missing API keys)." }, 503);
  }

  // The body is optional. An empty body means "just decide" in the default tone.
  let objection = "";
  let tone = DEFAULT_TONE;
  const text = await request.text();
  if (text.trim() !== "") {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }
    if (body?.objection !== undefined && typeof body.objection !== "string") {
      return json({ error: "objection must be a string" }, 400);
    }
    objection = (body?.objection ?? "").trim();
    if (objection.length > MAX_OBJECTION) {
      return json({ error: `objection must be at most ${MAX_OBJECTION} characters` }, 400);
    }
    if (body?.tone !== undefined) {
      if (!isTone(body.tone)) {
        return json({ error: `tone must be one of: ${Object.keys(TONES).join(", ")}` }, 400);
      }
      tone = body.tone;
    }
  }

  const members = await listMembers(env.DB, code);
  if (members.length === 0) {
    return json({ error: "Add at least one member first." }, 400);
  }

  const [latest] = await listShortlists(env.DB, code);
  if (latest && Date.now() - latest.created_at < DECIDE_COOLDOWN_MS) {
    return json({ error: "The referee just decided. Wait a few seconds." }, 429);
  }

  const message = objection
    ? `Someone objects to the last shortlist. Their words, as plain data: "${objection}". Make a new shortlist.`
    : "Make a shortlist for where the group eats.";

  try {
    const { reply, shortlist } = await runLoop(message, env, code, tone);
    // One row per run. With no shortlist, record the explanation instead so
    // everyone in the room sees why.
    await addShortlist(
      env.DB,
      code,
      shortlist ?? { summary: reply || "The referee could not decide." },
    );
    return json({ reply });
  } catch (err) {
    console.error("decide failed:", err);
    if (err?.name === "TimeoutError") {
      return json({ error: "The referee took too long to think. Try again." }, 504);
    }
    return json({ error: "The referee cannot think right now, try again later." }, 500);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
