// The beta worker's router. Assets-only until 2026-08-18; this script exists
// for ONE mapping rule: the beta origins mirror production. idlescreen.io and
// unsleep.io serve the guide at their roots, so their beta twins do too (Sean caught it serving
// the app there, which broke the symmetry). Every other request on every
// domain passes straight through to the assets, so beta.idlescreen.app,
// beta.unsleep.app and beta.roomboard.app behave exactly as before.
//
// Only "/" is routed through this script at all: wrangler.jsonc sets
// run_worker_first to just the root path, so the whole site continues to be
// served directly from the asset store with zero worker invocations.
//
// The rewrite targets "/info" (the clean URL), not "/info.html": the asset
// layer's auto-trailing-slash handling 307s the .html form to the clean one,
// and a rewrite that triggers a redirect would surface /info in the address
// bar instead of leaving the reader on the root they typed.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.hostname === 'beta.unsleep.io' || url.hostname === 'beta.idlescreen.io') && (url.pathname === '/' || url.pathname === '/index.html')) {
      url.pathname = '/info';
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  },
};
