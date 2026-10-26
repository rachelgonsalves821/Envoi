export function createPlaybackState(stepCount, reducedMotion = false) {
  return { stepCount, visibleCount: reducedMotion ? stepCount : 1, reducedMotion, manual: false, paused: false };
}

export function advancePlayback(state) {
  if (state.reducedMotion || state.manual || state.paused) return state;
  return { ...state, visibleCount: Math.min(state.stepCount, state.visibleCount + 1) };
}

export function playbackDelay(state) {
  return state.visibleCount === state.stepCount ? 2600 : 850;
}

export function togglePlayback(state) {
  if (state.manual) return createPlaybackState(state.stepCount, state.reducedMotion);
  return { ...state, paused: !state.paused };
}

export function visibleFeatureCount(markers, visibleCount) {
  return Math.max(0, ...markers.slice(0, visibleCount));
}

export function selectScenario(stepCount, reducedMotion = false) {
  return { ...createPlaybackState(stepCount, reducedMotion), visibleCount: stepCount, manual: true };
}

export function acceptedWaitlistResponse(responseOk, payload) {
  return responseOk && payload !== null && typeof payload === 'object' && payload.accepted === true;
}
