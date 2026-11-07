// @ts-check
// The model-catalog pre-flight, in one place.
//
// A saved model the site no longer offers used to be found out mid-run, when
// the site swapped the conversation to a substitute and never said so. The
// check lives here so both `Harness.run` (which runs it before compaction and
// MCP load) and `runTask` (which runs it for direct callers: CLI, agent, tests)
// share one implementation — and so the ordering can be fixed in one spot.
export async function checkModel(bridge, model) {
  const chosenModel = String(model ?? bridge?.model ?? '').trim();
  if (!chosenModel || chosenModel === 'auto') return { gone: false, chosenModel, summary: null };
  if (typeof bridge?.models !== 'function') return { gone: false, chosenModel, summary: null };
  const catalog = await bridge.models().catch(() => null);
  const ids = Array.isArray(catalog?.data) ? catalog.data.map((m) => m?.id).filter(Boolean) : [];
  if (catalog?.source !== 'live' || !ids.length) return { gone: false, chosenModel, summary: null };
  const normalized = chosenModel.replace(/^aipass\//, '');
  if (ids.includes(normalized)) return { gone: false, chosenModel, summary: null };
  const providerId = bridge?.providerId ?? 'aipass';
  const summary = providerId === 'aipass'
    ? `the model "${chosenModel}" is not in the model catalog anymore — the site would have swapped it for a substitute mid-run without saying so. Pick a current model in Settings and start the run again.`
    : `the model "${chosenModel}" is not in ${providerId}'s model list — that provider would refuse the request. Pick a current model in Settings and start the run again.`;
  return { gone: true, chosenModel, summary };
}