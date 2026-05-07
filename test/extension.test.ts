import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import extension, {
  discoverSkills,
  filterSkills,
  formatSkillPickerPanel,
  formatSkillPickerPreview,
  isSkillPickerConfirmKey,
  skillPromptInsertion,
} from "../src/index.ts";

const PRETTY_PANEL_MIN_WIDTH = 44;

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const OSC_PATTERN = /\u001b\].*?(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

function expectEveryLineVisibleWidth(lines: string[], width: number) {
  expect(lines.map((line) => visibleWidth(line))).toEqual(Array(lines.length).fill(width));
}

function writeSkill(root: string, dirName: string, name: string, description: string) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

test("discovers user and project skills with frontmatter metadata", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-"));
  const home = join(temp, "home");
  const cwd = join(temp, "repo");

  writeSkill(join(home, ".pi", "agent", "skills"), "global-skill", "global-one", "Global skill");
  writeSkill(join(home, ".agents", "skills"), "agents-skill", "agents-one", "Agents skill");
  writeSkill(join(cwd, ".pi", "skills"), "project-skill", "project-one", "Project skill");

  const skills = discoverSkills(cwd, home);

  expect(skills.map((skill) => skill.name).sort()).toEqual(["agents-one", "global-one", "project-one"]);
  expect(skills.find((skill) => skill.name === "project-one")?.description).toBe("Project skill");
});

test("filters skills fuzzily across name and description", () => {
  const skills = [
    { name: "21st-sdk", description: "21st Agents docs and examples", filePath: "/tmp/a", source: "pi-user" as const },
    { name: "github-pr", description: "GitHub pull request workflow", filePath: "/tmp/b", source: "pi-user" as const },
  ];

  expect(filterSkills(skills, "21sdk").map((skill) => skill.name)).toEqual(["21st-sdk"]);
  expect(filterSkills(skills, "pull").map((skill) => skill.name)).toEqual(["github-pr"]);
});

test("inserts skill commands in Pi's built-in skill expansion format", () => {
  expect(skillPromptInsertion("21st-sdk")).toBe("/skill:21st-sdk ");
});

test("treats tab as a picker confirm key like enter", () => {
  expect(isSkillPickerConfirmKey("\t")).toBe(true);
  expect(isSkillPickerConfirmKey("\r")).toBe(true);
  expect(isSkillPickerConfirmKey("a")).toBe(false);
});

test("formats the skill picker as a bordered panel", () => {
  const panel = formatSkillPickerPanel({
    width: 36,
    title: "Skill Selector",
    subtitle: "3 skills · matching \"git\"",
    body: ["Filter", "> git", "", "github-pr  Pull requests"],
    footer: "↑↓ navigate · enter select",
    styleSurface: (text) => text,
    styleBorder: (text) => text,
    styleAccentBorder: (text) => text,
    styleTitle: (text) => text,
    styleMuted: (text) => text,
  });

  expect(panel[0]).toBe("╭─ Skill Selector ─────────────────────────╮");
  expect(panel[1]).toBe("│ 3 skills · matching \"git\"                │");
  expect(panel[2]).toBe("├──────────────────────────────────────────┤");
  expect(panel.at(-1)).toBe("╰─ ↑↓ navigate · enter select ─────────────╯");
  expectEveryLineVisibleWidth(panel, PRETTY_PANEL_MIN_WIDTH);
});

test("keeps the bordered panel aligned when theme styles add ANSI escapes", () => {
  const panel = formatSkillPickerPanel({
    width: 36,
    title: "Skill Selector",
    subtitle: "3 skills · matching \"git\"",
    body: ["Filter", "\u001b[35m> git\u001b[0m", "", "\u001b[2mgithub-pr  Pull requests\u001b[0m"],
    footer: "↑↓ navigate · enter select",
    styleSurface: (text) => `\u001b[48;5;236m${text}\u001b[0m`,
    styleBorder: (text) => `\u001b[90m${text}\u001b[0m`,
    styleAccentBorder: (text) => `\u001b[35m${text}\u001b[0m`,
    styleTitle: (text) => `\u001b[35;1m${text}\u001b[0m`,
    styleMuted: (text) => `\u001b[2m${text}\u001b[0m`,
  });
  const visible = panel.map(stripAnsi);

  expect(visible[0]).toBe("╭─ Skill Selector ─────────────────────────╮");
  expect(visible[1]).toBe("│ 3 skills · matching \"git\"                │");
  expect(visible.at(-1)).toBe("╰─ ↑↓ navigate · enter select ─────────────╯");
  expectEveryLineVisibleWidth(panel, PRETTY_PANEL_MIN_WIDTH);
});

test("renders a concise skill picker preview with clean ellipsis and tab hint", () => {
  const skills = [
    {
      name: "rocket-extension",
      description: "Pi-only workflow for shipping a locally developed Pi extension end to end without running chezmoi",
      filePath: "/tmp/rocket/SKILL.md",
      source: "pi-user" as const,
    },
    {
      name: "session-handoff",
      description: "Continue work from another agent session",
      filePath: "/tmp/handoff/SKILL.md",
      source: "pi-user" as const,
    },
  ];
  const preview = formatSkillPickerPreview(skills, "rocket", 72);
  const visible = preview.map(stripAnsi);

  expect(visible).toContain("│ › rocket-extension  Pi-only workflow for shipping a locally… │");
  expect(visible.at(-1)).toBe("╰─ tab/enter select · ↑↓ move · esc close ─────────────────────╯");
  expectEveryLineVisibleWidth(preview, 64);
});

test("keeps panel width stable with OSC links, emoji, CJK, and narrow widths", () => {
  const linkedSkill = "\u001b]8;;https://example.com\u001b\\github-pr\u001b]8;;\u001b\\  handles 🔥 PR レビュー";
  const panel = formatSkillPickerPanel({
    width: 28,
    title: "Skill ✨ Selector",
    subtitle: "12 skills · matching \"レビュー\"",
    body: ["Filter", "レビュー", linkedSkill],
    footer: "↑↓ · enter · esc",
    styleSurface: (text) => `\u001b[48;5;236m${text}\u001b[0m`,
    styleBorder: (text) => `\u001b[90m${text}\u001b[0m`,
    styleAccentBorder: (text) => `\u001b[38;5;176m${text}\u001b[0m`,
    styleTitle: (text) => `\u001b[35;1m${text}\u001b[0m`,
    styleMuted: (text) => `\u001b[2m${text}\u001b[0m`,
  });
  const visible = panel.map(stripAnsi);

  expect(visible[0]).toBe("╭─ Skill ✨ Selector ──────────────────────╮");
  expect(visible[1]).toBe("│ 12 skills · matching \"レビュー\"          │");
  expect(visible[4]).toBe("│ レビュー                                 │");
  expect(visible.at(-1)).toBe("╰─ ↑↓ · enter · esc ───────────────────────╯");
  expectEveryLineVisibleWidth(panel, PRETTY_PANEL_MIN_WIDTH);
});

test("Pi SDK discovers the local .pi extension shim without loader errors", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-skill-selector-agent-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const extensions = loader.getExtensions();
    expect(extensions.errors.filter((error) => error.path.includes("pi-skill-selector"))).toEqual([]);
    expect(extensions.extensions.some((loaded) => loaded.path.endsWith(".pi/extensions/pi-skill-selector/index.ts"))).toBe(true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Pi SDK binds the local extension and exposes /skill-selector", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-skill-selector-agent-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      noTools: "all",
    });

    try {
      await session.bindExtensions({});
      expect(session.extensionRunner.getCommand("skill-selector")).toBeDefined();
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("extension registers command and installs a terminal $ shortcut on session start", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-shortcut-"));
  writeSkill(join(temp, ".pi", "skills"), "21st-sdk", "21st-sdk", "21st Agents docs");

  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler: ((_event: unknown, ctx: any) => void) | undefined;
  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let pastedText: string | undefined;

  try {
    extension({
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      if (name === "skill-selector") commandHandler = options.handler;
    },
    on(event: string, handler: (_event: unknown, ctx: any) => void) {
      if (event === "session_start") sessionStartHandler = handler;
    },
    } as any);

    expect(commandHandler).toBeDefined();
    expect(sessionStartHandler).toBeDefined();

    sessionStartHandler?.({}, {
      cwd: temp,
      ui: {
        custom() {
          return Promise.resolve("21st-sdk");
        },
        notify() {},
        onTerminalInput(handler: typeof terminalHandler) {
          terminalHandler = handler;
          return () => {};
        },
        pasteToEditor(text: string) {
          pastedText = text;
        },
      },
    });

    expect(terminalHandler).toBeTypeOf("function");
    expect(terminalHandler?.("a")).toBeUndefined();
    expect(terminalHandler?.("$ski")).toEqual({ consume: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pastedText).toBe(skillPromptInsertion("21st-sdk"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
