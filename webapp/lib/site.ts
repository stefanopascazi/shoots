import meta from "@/content/meta.json";

export const site = {
  name: "shoots",
  tagline: "Batch automation for professional photography workflows.",
  description:
    "A scriptable command-line tool that does the tedious work around your editor: offload, stamp metadata, cull out-of-focus frames, star-rate and learn your own develop style. Fully local, never destructive.",
  url: "https://github.com/stefanopascazi/shoots",
  version: meta.version,
  repo: "https://github.com/stefanopascazi/shoots",
  repoBlob: "https://github.com/stefanopascazi/shoots/blob/main",
  releases: "https://github.com/stefanopascazi/shoots/releases/latest",
  author: "Stefano Pascazi",
  email: "stefanopascazi@gmail.com",
  license: {
    name: "PolyForm Noncommercial 1.0.0",
    url: "https://github.com/stefanopascazi/shoots/blob/main/LICENSE",
  },
} as const;

export const installCommands = [
  {
    id: "unix",
    label: "macOS / Linux",
    lang: "sh",
    command:
      "curl -fsSL https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.sh | bash",
  },
  {
    id: "windows",
    label: "Windows",
    lang: "powershell",
    command:
      "irm https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.ps1 | iex",
  },
] as const;
