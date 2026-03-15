import { startMockOmniServer } from "./lib/mock-omni-server.mjs";
import { startOpenClawGatewayForMemorySmoke } from "./lib/openclaw-smoke.mjs";

async function main() {
  const mock = await startMockOmniServer();
  const gateway = await startOpenClawGatewayForMemorySmoke({
    port: 18891,
    token: "omnimem-smoke-token",
    baseUrl: mock.baseUrl,
  });

  try {
    const search = await gateway.invokeTool({
      tool: "memory_search",
      args: { query: "What did Caroline mention about the support group?", maxResults: 3 },
      sessionKey: "agent:main:local-smoke:memory",
    });
    const details = search?.result?.details || {};
    const firstPath = details?.results?.[0]?.path;
    if (!firstPath) {
      throw new Error(`memory_search returned no path: ${JSON.stringify(search)}`);
    }

    const get = await gateway.invokeTool({
      tool: "memory_get",
      args: { path: firstPath },
      sessionKey: "agent:main:local-smoke:memory",
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          search,
          get,
          mock: {
            retrievalRequests: mock.state.retrievalRequests.length,
            ingestRequests: mock.state.ingestRequests.length,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await gateway.close();
    await mock.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
