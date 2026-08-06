#!/usr/bin/env node
// Install analytics, straight from GitHub.
//
//   node scripts/download-stats.mjs            # human-readable report
//   node scripts/download-stats.mjs --json     # machine-readable
//   node scripts/download-stats.mjs --jsonl    # one snapshot line, for the daily workflow
//
// Every install goes through a release asset — the installer script itself
// (www.shoots-ai.com/install.sh redirects to it) and then the platform binary —
// so GitHub's per-asset download_count is a complete, free, permanent record of
// how many people installed shoots. Nothing else needs to be collected.
//
// Set GITHUB_TOKEN to lift the unauthenticated 60 requests/hour rate limit.

const REPO = process.env.SHOOTS_REPO ?? "stefanopascazi/shoots";

const SCRIPTS = ["install.sh", "install.ps1"];
// SHA256SUMS.txt is fetched by both installers on every run, which makes it a
// decent proxy for "install attempts" independent of platform.
const CHECKSUMS = "SHA256SUMS.txt";

const isBinary = (name) => name.startsWith("shoots-") && name !== CHECKSUMS;
const targetOf = (name) => name.replace(/^shoots-/, "").replace(/\.exe$/, "");

async function fetchReleases() {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const releases = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    const batch = await res.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

function summarize(releases) {
  const scripts = Object.fromEntries(SCRIPTS.map((name) => [name, 0]));
  const binaries = {};
  let attempts = 0;

  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      const count = asset.download_count ?? 0;
      if (asset.name in scripts) scripts[asset.name] += count;
      else if (asset.name === CHECKSUMS) attempts += count;
      else if (isBinary(asset.name)) {
        binaries[targetOf(asset.name)] = (binaries[targetOf(asset.name)] ?? 0) + count;
      }
    }
  }

  const latest = releases.find((r) => !r.draft && !r.prerelease) ?? releases[0];

  return {
    date: new Date().toISOString().slice(0, 10),
    repo: REPO,
    latestTag: latest?.tag_name ?? null,
    commandRuns: Object.values(scripts).reduce((a, b) => a + b, 0),
    scripts,
    attempts,
    binaries,
    installs: Object.values(binaries).reduce((a, b) => a + b, 0),
  };
}

function report(s) {
  const pad = (label, n) => `  ${label.padEnd(22)}${String(n).padStart(7)}`;
  const lines = [
    "",
    `shoots installs — ${s.repo} (latest ${s.latestTag ?? "n/a"})`,
    "",
    "Install command run (installer script downloaded)",
    ...SCRIPTS.map((name) => pad(name, s.scripts[name])),
    pad("total", s.commandRuns),
    "",
    "Reached the download step (checksum file fetched)",
    pad(CHECKSUMS, s.attempts),
    "",
    "Binary downloaded (install completed)",
    ...Object.entries(s.binaries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, n]) => pad(target, n)),
    pad("total", s.installs),
    "",
  ];

  // Only meaningful once installers are published as assets — releases before
  // that change have no install.sh to count, so the ratio would read as 0%.
  if (s.commandRuns > 0) {
    const rate = Math.round((s.installs / s.commandRuns) * 100);
    lines.push(`Completion rate: ${rate}% of runs reached a binary download`, "");
  }

  return lines.join("\n");
}

const releases = await fetchReleases();
const summary = summarize(releases);
const arg = process.argv[2];

if (arg === "--json") {
  console.log(JSON.stringify(summary, null, 2));
} else if (arg === "--jsonl") {
  // One line per snapshot. JSONL rather than CSV so adding or dropping a build
  // target never shifts the columns of the history already recorded.
  console.log(JSON.stringify(summary));
} else {
  console.log(report(summary));
}
