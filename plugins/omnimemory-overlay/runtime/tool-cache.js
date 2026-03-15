const MAX_CACHE_ENTRIES = 512;

const state = {
  results: new Map(),
};

export function rememberToolResult(path, payload) {
  if (state.results.has(path)) {
    state.results.delete(path);
  }
  state.results.set(path, payload);
  while (state.results.size > MAX_CACHE_ENTRIES) {
    const oldest = state.results.keys().next().value;
    if (!oldest) {
      break;
    }
    state.results.delete(oldest);
  }
}

export function getToolResult(path) {
  return state.results.get(path);
}

export function clearToolResults() {
  state.results.clear();
}

