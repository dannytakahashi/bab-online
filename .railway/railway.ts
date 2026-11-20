import { defineRailway, github, project, service } from "railway/iac";
// Railway's infrastructure as code for the bab-online service (replaces
// railway.toml, which Railway stops reading on 2026-12-01). Not applied on
// push: run `railway config plan`, then `railway config apply`, from a
// checkout linked to the project (docs/claude/server-infra.md, Deploys).
//
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "bab-online";
export default defineRailway(() => {
  const babOnline = service("bab-online", {
    // checkSuites: Railway deploys a main commit only after its GitHub
    // checks (.github/workflows/ci.yml) pass, so a red CI never ships
    source: github("dannytakahashi/bab-online", { branch: "main", checkSuites: true }),
    // Railpack (2026-11-19; Nixpacks is frozen and has no Node 26) picks
    // Node from package.json engines (26.x), then .nvmrc; it runs
    // `npm ci` and `npm run build` (vite), as Nixpacks did; the start is
    // deploy.startCommand below
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    deploy: {
      // The server itself must receive the deploy's SIGTERM. The builders'
      // default start, `npm start` (npm -> sh -c -> node), gets the signal in
      // npm, which dies with "signal SIGTERM" and the server is killed without
      // its graceful shutdown (no "Graceful shutdown complete" in any deploy's
      // log before 2026-11-19): no shutdown notice to players, no drain, and
      // with LIVE_PERSIST=on no handoff
      startCommand: "node server/index.js",
      // Restart policy: Railway's default, ON_FAILURE with 10 retries (not
      // set here: Railway stores the default as null, so an explicit value
      // shows in every plan). A crash exits 1 (server/utils/shutdown.js) and
      // is restarted; a deploy's SIGTERM exits 0
      //
      // A new deploy takes traffic only once /ready (DB ping) answers.
      // Railway probes $PORT: the service variable PORT is 3000, the port
      // server/index.js listens on (a646178 pulled a healthcheck when PORT
      // was Railway's injected 8080). 120 s covers connectDB's backoff
      healthcheckPath: "/ready",
      healthcheckTimeout: 120,
      // Seconds between SIGTERM and SIGKILL for the old deploy (15 approved
      // 2026-11-16; 20 approved 2026-11-18, ahead of deploy survival PR 5).
      // The graceful shutdown (game-log notice, serverShutdown, 1 s, close,
      // in-flight stats writes, 0.5 s) takes ~1.5 s and is capped at 10 s
      // (shutdown.js HARD_EXIT_MS); PR 5's live-game handoff raises that cap
      // to 15 s, and 20 s keeps 5 s above it, so the process always exits by
      // itself with its own code
      drainingSeconds: 20,
    },
    replicas: { "us-west2": 1 },
    domains: [{ domain: "babonline.io", port: 3000 }],
  });

  return project("beautiful-analysis", {
    // Variables (MONGO_URI, TURN keys, PORT) stay in the dashboard, never here:
    // this repository is public
    variables: { managed: false },
    resources: [babOnline],
  });
});
