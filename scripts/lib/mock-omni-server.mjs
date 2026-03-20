import http from "node:http";
import { randomUUID } from "node:crypto";

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function extractMatchTerms(text) {
  return normalizeString(text)
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/i)
    .filter((term) => term && (term.length >= 8 || /\d/.test(term)));
}

function buildDynamicRetrievalItems({ body, state }) {
  const query = normalizeString(body?.query);
  if (!query) {
    return [];
  }
  const queryTerms = extractMatchTerms(query);
  const sessionIds = normalizeString(body?.run_id)
    ? [normalizeString(body.run_id)]
    : [...state.sessionTurns.keys()];
  const items = [];

  for (const sessionId of sessionIds) {
    const turns = state.sessionTurns.get(sessionId) || [];
    turns.forEach((turn, index) => {
      const text = normalizeString(turn?.text);
      if (!text) {
        return;
      }
      const haystack = text.toLowerCase();
      const matched =
        queryTerms.length > 0
          ? queryTerms.some((term) => haystack.includes(term))
          : haystack.includes(query.toLowerCase()) || query.toLowerCase().includes(haystack);
      if (!matched) {
        return;
      }
      items.push({
        text,
        score: 0.97,
        timestamp: turn?.timestamp_iso || new Date().toISOString(),
        source: "dialog",
        tkg_event_id: `evt_${sessionId}_${index + 1}`,
        entities: [],
      });
    });
  }

  return items;
}

function buildDefaultFixtures() {
  return {
    retrievalItems: [
      {
        text: "Caroline said she attended an LGBTQ support group and is considering a counseling path.",
        score: 0.91,
        timestamp: "2026-01-14T10:00:00Z",
        source: "dialog",
        tkg_event_id: "evt_support_group",
        entities: ["Caroline"],
      },
    ],
    explainEvents: {
      evt_support_group: {
        item: {
          entities: [{ name: "Caroline", type: "PERSON" }],
          knowledge: [
            {
              id: "k_support_group",
              summary: "Caroline attended an LGBTQ support group and is exploring counseling-related work.",
              importance: 0.82,
              t_abs_start: "2026-01-14T10:00:00Z",
            },
          ],
          utterances: [
            {
              id: "utt_support_group",
              raw_text: "I went to an LGBTQ support group and it made me think about counseling.",
              timestamp: "2026-01-14T10:00:00Z",
              confidence: 0.96,
            },
          ],
        },
      },
    },
    entityResolutions: {
      Caroline: [{ entity_id: "entity_caroline", name: "Caroline", type: "PERSON" }],
    },
    entityTimelines: {
      entity_caroline: {
        items: [
          {
            id: "timeline_1",
            text: "Caroline attended an LGBTQ support group.",
            timestamp: "2026-01-14T10:00:00Z",
            confidence: 0.95,
          },
        ],
      },
    },
  };
}

export async function startMockOmniServer(options = {}) {
  const fixtures = options.fixtures || buildDefaultFixtures();
  const handlers = options.handlers || {};
  const state = {
    retrievalRequests: [],
    retrievalResponses: [],
    ingestRequests: [],
    jobs: new Map(),
    sessions: new Map(),
    sessionTurns: new Map(),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/retrieval") {
        const body = await readBody(req);
        state.retrievalRequests.push(body);
        const handled = await handlers.retrieval?.({ body, fixtures, state, req });
        if (handled) {
          json(res, handled.status ?? 200, handled.payload ?? {});
          return;
        }
        const payload = {
          strategy: body.strategy || "dialog_v2",
          evidence_details: [...buildDynamicRetrievalItems({ body, state }), ...fixtures.retrievalItems],
        };
        state.retrievalResponses.push({ request: body, payload });
        json(res, 200, payload);
        return;
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        const body = await readBody(req);
        state.ingestRequests.push(body);
        const handled = await handlers.ingest?.({ body, fixtures, state, req });
        if (handled) {
          json(res, handled.status ?? 200, handled.payload ?? {});
          return;
        }
        const jobId = `job_${randomUUID()}`;
        const turns = Array.isArray(body.turns) ? body.turns : [];
        const lastTurnId = turns.length > 0 ? turns[turns.length - 1].turn_id : null;
        if (body.session_id) {
          state.sessions.set(String(body.session_id), {
            cursor_committed: lastTurnId,
          });
          const existingTurns = state.sessionTurns.get(String(body.session_id)) || [];
          state.sessionTurns.set(String(body.session_id), [...existingTurns, ...turns]);
        }
        state.jobs.set(jobId, { status: "COMPLETED", session_id: body.session_id || null });
        json(res, 200, { job_id: jobId });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/ingest/jobs/")) {
        const jobId = decodeURIComponent(url.pathname.slice("/ingest/jobs/".length));
        const job = state.jobs.get(jobId);
        if (!job) {
          notFound(res);
          return;
        }
        json(res, 200, job);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/ingest/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.slice("/ingest/sessions/".length));
        const session = state.sessions.get(sessionId);
        if (!session) {
          notFound(res);
          return;
        }
        json(res, 200, session);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/graph/v0/explain/event/")) {
        const eventId = decodeURIComponent(url.pathname.slice("/graph/v0/explain/event/".length));
        const payload = fixtures.explainEvents[eventId];
        if (!payload) {
          notFound(res);
          return;
        }
        json(res, 200, payload);
        return;
      }
      if (req.method === "GET" && url.pathname === "/graph/v0/entities/resolve") {
        const name = url.searchParams.get("name") || "";
        json(res, 200, { items: fixtures.entityResolutions[name] || [] });
        return;
      }
      if (req.method === "GET" && /^\/graph\/v0\/entities\/[^/]+\/timeline$/.test(url.pathname)) {
        const entityId = decodeURIComponent(url.pathname.split("/")[4]);
        json(res, 200, fixtures.entityTimelines[entityId] || { items: [] });
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      notFound(res);
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port || 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock Omni server failed to bind");
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve(undefined);
        });
      }),
  };
}
