import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { deleteAllKittyImages, TUI, visibleWidth } from "@earendil-works/pi-tui";

import extension, {
  clearSkillCache,
  clearVisibleTerminalImagesForOverlay,
  discoverSkills,
  filterSkills,
  formatSkillPickerPanel,
  formatSkillPickerPreview,
  getCachedSkills,
  isSkillPickerConfirmKey,
  patchTuiImageOverlayComposite,
  skillPromptInsertion,
  suppressTerminalImagesForOverlay,
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

  expect(visible).toContain("│ Search                                                 │");
  expect(visible).toContain("│ > rocket                                               │");
  expect(visible).toContain("│ › rocket-extension                                     │");
  expect(visible).toContain("│ Pi-only workflow for shipping a locally developed Pi … │");
  expect(visible.at(-1)).toBe("╰─ tab/enter select · ↑↓ move · esc ─────────────────────╯");
  expectEveryLineVisibleWidth(preview, 58);
});

test("styled preview uses a visible elevated card surface and selected row background", () => {
  const skills = [
    { name: "rocket-extension", description: "Ship a Pi extension", filePath: "/tmp/rocket/SKILL.md", source: "pi-user" as const },
    { name: "yeet", description: "Commit and push safely", filePath: "/tmp/yeet/SKILL.md", source: "pi-user" as const },
  ];
  const bg = (rgb: string, text: string) => `\u001b[48;2;${rgb}m${text}\u001b[49m`;
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => color === "selectedBg" ? bg("204;208;218", text) : bg("230;233;239", text),
    getBgAnsi: (color: string) => color === "selectedBg" ? "\u001b[48;2;204;208;218m" : "\u001b[48;2;230;233;239m",
    getColorMode: () => "truecolor" as const,
  };

  const preview = formatSkillPickerPreview(skills, "", 72, 1, theme);
  const rendered = preview.join("\n");

  expect(rendered).toContain("\u001b[48;2;230;233;239m");
  // Border at 45% mix: 230,233,239 mixed with 0,0,0 = 127,128,131
  expect(rendered).toContain("\u001b[38;2;127;128;131m╭");
  expect(rendered).toContain("\u001b[48;2;204;208;218m› yeet");
  expectEveryLineVisibleWidth(preview, 58);
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

test("clears visible Kitty graphics before opening the centered overlay", () => {
  const writes: string[] = [];
  const previousKittyImageIds = new Set([4242]);

  const tui = {
    previousKittyImageIds,
    terminal: {
      write(data: string) {
        writes.push(data);
      },
    },
  };

  clearVisibleTerminalImagesForOverlay(tui);
  clearVisibleTerminalImagesForOverlay(tui);

  expect(writes).toEqual([deleteAllKittyImages(), deleteAllKittyImages()]);
  expect(previousKittyImageIds.size).toBe(0);
});

test("suppresses all terminal image lines while selector overlay is active", () => {
  const tui = {
    render(width: number) {
      return [
        "before",
        "\u001b_Ga=T,f=100,i=4242;AAAA\u001b\\",
        "middle",
        "\u001b]1337;File=inline=1:AAAA\u0007",
        "after",
      ];
    },
    terminal: { write() {} },
    previousKittyImageIds: new Set([4242]),
  };

  const restore = suppressTerminalImagesForOverlay(tui);

  expect(tui.render(12)).toEqual(["before", "            ", "middle", "            ", "after"]);
  restore();
  expect(tui.render(12)[1]).toContain("\u001b_G");
});

test("prepares a real TUI with stale Kitty graphics before selector overlay rendering", () => {
  const writes: string[] = [];
  const terminal = {
    start() {},
    stop() {},
    drainInput: () => Promise.resolve(),
    write(data: string) {
      writes.push(data);
    },
    get columns() {
      return 100;
    },
    get rows() {
      return 32;
    },
    get kittyProtocolActive() {
      return true;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const tui = new TUI(terminal, false) as unknown as {
    terminal: typeof terminal;
    previousKittyImageIds: Set<number>;
    compositeLineAt(baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number): string;
  };
  tui.previousKittyImageIds = new Set([4242]);

  patchTuiImageOverlayComposite(tui);

  const restore = suppressTerminalImagesForOverlay(tui);

  expect(writes).toContain(deleteAllKittyImages());
  expect(tui.previousKittyImageIds.size).toBe(0);
  expect(stripAnsi(tui.compositeLineAt("\u001b_Ga=T,f=100,i=4242;AAAA\u001b\\", "PICKER", 3, 6, 12))).toBe("   PICKER   ");
  restore();
});

test("extension registers command and installs a terminal $ shortcut on session start", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-shortcut-"));
  writeSkill(join(temp, ".pi", "skills"), "21st-sdk", "21st-sdk", "21st Agents docs");

  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler: ((_event: unknown, ctx: any) => void) | undefined;
  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let pastedText: string | undefined;
  let customOptions: { overlay?: boolean; overlayOptions?: { anchor?: string; width?: number; maxHeight?: number } } | undefined;
  const terminalWrites: string[] = [];
  const previousKittyImageIds = new Set([4242]);
  let renderedDuringFactory: string[] | undefined;

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
        custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: string | null) => void) => unknown, options?: typeof customOptions) {
          customOptions = options;
          const fakeTui = {
            previousKittyImageIds,
            terminal: {
              write(data: string) {
                terminalWrites.push(data);
              },
            },
            render(width: number) {
              return ["before", "\u001b_Ga=T,f=100,i=4242;AAAA\u001b\\", "after"].map((line) => line.replace("WIDTH", String(width)));
            },
            compositeLineAt(baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number) {
              return `${baseLine}|${overlayLine}|${startCol}|${overlayWidth}|${totalWidth}`;
            },
          };
          factory(fakeTui, {}, {}, () => {});
          renderedDuringFactory = fakeTui.render(10);
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
    // $ at start of line (or after space) triggers
    expect(terminalHandler?.("$ski")).toEqual({ consume: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(customOptions?.overlay).toBe(true);
    expect(customOptions?.overlayOptions).toEqual({ anchor: "center", width: 58, maxHeight: 18 });
    expect(terminalWrites).toContain(deleteAllKittyImages());
    expect(previousKittyImageIds.size).toBe(0);
    expect(renderedDuringFactory).toEqual(["before", "          ", "after"]);
    expect(pastedText).toBe(skillPromptInsertion("21st-sdk"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("$ shortcut does not trigger when preceded by a non-space character", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-space-"));
  writeSkill(join(temp, ".pi", "skills"), "test-skill", "test-skill", "Test skill");

  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;

  try {
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") {
          handler({}, {
            cwd: temp,
            ui: {
              custom() { return Promise.resolve("test-skill"); },
              notify() {},
              onTerminalInput(h: typeof terminalHandler) {
                terminalHandler = h;
                return () => {};
              },
              pasteToEditor() {},
            },
          });
        }
      },
    };
    extension(mockExtension as any);

    expect(terminalHandler).toBeDefined();
    // Type "x" then "$" — the $ should not trigger because x is not a space
    expect(terminalHandler?.("x")).toBeUndefined();
    expect(terminalHandler?.("$")).toBeUndefined();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("$ shortcut triggers after a space", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-space-ok-"));
  writeSkill(join(temp, ".pi", "skills"), "test-skill", "test-skill", "Test skill");

  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let pastedText: string | undefined;

  try {
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") {
          handler({}, {
            cwd: temp,
            ui: {
              custom() { return Promise.resolve("test-skill"); },
              notify() {},
              onTerminalInput(h: typeof terminalHandler) {
                terminalHandler = h;
                return () => {};
              },
              pasteToEditor(text: string) {
                pastedText = text;
              },
            },
          });
        }
      },
    };
    extension(mockExtension as any);

    expect(terminalHandler).toBeDefined();
    // Type " " then "$" — the $ should trigger because space is before it
    expect(terminalHandler?.(" ")).toBeUndefined();
    expect(terminalHandler?.("$")).toEqual({ consume: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("$ shortcut triggers with Kitty keyboard protocol (CSI-u sequence)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-kitty-"));
  writeSkill(join(temp, ".pi", "skills"), "test-skill", "test-skill", "Test skill");

  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let pastedText: string | undefined;

  try {
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") {
          handler({}, {
            cwd: temp,
            ui: {
              custom() { return Promise.resolve("test-skill"); },
              notify() {},
              onTerminalInput(h: typeof terminalHandler) {
                terminalHandler = h;
                return () => {};
              },
              pasteToEditor(text: string) {
                pastedText = text;
              },
            },
          });
        }
      },
    };
    extension(mockExtension as any);

    expect(terminalHandler).toBeDefined();
    // Some terminals report the shifted printable itself.
    expect(terminalHandler?.("\x1b[36u")).toEqual({ consume: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("$ shortcut triggers with shifted Kitty keyboard protocol sequence", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-kitty-shifted-"));
  writeSkill(join(temp, ".pi", "skills"), "test-skill", "test-skill", "Test skill");

  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;

  try {
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") {
          handler({}, {
            cwd: temp,
            ui: {
              custom() { return Promise.resolve("test-skill"); },
              notify() {},
              onTerminalInput(h: typeof terminalHandler) {
                terminalHandler = h;
                return () => {};
              },
              pasteToEditor() {},
            },
          });
        }
      },
    };
    extension(mockExtension as any);

    expect(terminalHandler).toBeDefined();
    // Kitty's disambiguate+alternate-key encoding can report Shift+4 as
    // base key "4" (52), shifted printable "$" (36), modifier Shift (2).
    expect(terminalHandler?.("\x1b[52:36;2u")).toEqual({ consume: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("pressing Escape after $ dismisses without inserting a literal dollar", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-escape-"));
  writeSkill(join(temp, ".pi", "skills"), "test-skill", "test-skill", "Test skill");

  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const pastedText: string[] = [];

  try {
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") {
          handler({}, {
            cwd: temp,
            ui: {
              custom() { return Promise.resolve(null); },
              notify() {},
              onTerminalInput(h: typeof terminalHandler) {
                terminalHandler = h;
                return () => {};
              },
              pasteToEditor(text: string) {
                pastedText.push(text);
              },
            },
          });
        }
      },
    };
    extension(mockExtension as any);

    expect(terminalHandler).toBeDefined();
    expect(terminalHandler?.("$")).toEqual({ consume: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pastedText).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("$ shortcut can reopen after Escape dismisses the picker", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-escape-reopen-"));
  writeSkill(join(temp, ".pi", "skills"), "test-skill", "test-skill", "Test skill");

  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const pastedText: string[] = [];
  const pendingPickers: Array<(value: string | null) => void> = [];

  try {
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") {
          handler({}, {
            cwd: temp,
            ui: {
              custom() {
                return new Promise<string | null>((resolve) => {
                  pendingPickers.push(resolve);
                });
              },
              notify() {},
              onTerminalInput(h: typeof terminalHandler) {
                terminalHandler = h;
                return () => {};
              },
              pasteToEditor(text: string) {
                pastedText.push(text);
              },
            },
          });
        }
      },
    };
    extension(mockExtension as any);

    expect(terminalHandler).toBeDefined();
    expect(terminalHandler?.("$")).toEqual({ consume: true });
    expect(pendingPickers.length).toBe(1);

    // Pi still routes the Escape key through terminal input while the overlay is active.
    expect(terminalHandler?.("\x1b")).toBeUndefined();
    pendingPickers[0]?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pastedText).toEqual([]);
    expect(terminalHandler?.("$")).toEqual({ consume: true });
    expect(pendingPickers.length).toBe(2);

    pendingPickers[1]?.("test-skill");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pastedText).toEqual([skillPromptInsertion("test-skill")]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discoverSkills is cached and subsequent calls are fast", () => {
  clearSkillCache(); // Clear cache from previous tests

  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-cache-"));
  const home = join(temp, "home");
  const cwd = join(temp, "repo");

  writeSkill(join(home, ".pi", "agent", "skills"), "global-skill", "global-one", "Global skill");
  writeSkill(join(cwd, ".pi", "skills"), "project-skill", "project-one", "Project skill");

  try {
    // First call should scan disk
    const start1 = performance.now();
    const skills1 = discoverSkills(cwd, home);
    const duration1 = performance.now() - start1;

    expect(skills1.length).toBe(2);

    // Second call should use cache
    const start2 = performance.now();
    const skills2 = getCachedSkills(cwd, home);
    const duration2 = performance.now() - start2;

    expect(skills2.length).toBe(2);
    expect(skills2.map((s) => s.name)).toEqual(skills1.map((s) => s.name));
    // Cached call should be fast (under 1ms)
    expect(duration2).toBeLessThan(1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("extension loads in under 50ms with many skills", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-selector-perf-"));
  const home = join(temp, "home");
  const cwd = join(temp, "repo");

  // Create 100 skills to simulate a large skill library
  for (let i = 0; i < 100; i++) {
    writeSkill(join(home, ".pi", "agent", "skills"), `skill-${i}`, `skill-${i}`, `Description ${i}`);
  }

  let sessionStartHandler: ((_event: unknown, ctx: any) => void) | undefined;

  try {
    const start = performance.now();
    const mockExtension = {
      registerCommand() {},
      on(_event: string, handler: any) {
        if (_event === "session_start") sessionStartHandler = handler;
      },
    };
    extension(mockExtension as any);

    sessionStartHandler?.({}, {
      cwd,
      ui: {
        custom() { return Promise.resolve(null); },
        notify() {},
        onTerminalInput() { return () => {}; },
        pasteToEditor() {},
      },
    });

    const duration = performance.now() - start;
    // Extension should load in under 50ms — the key is that it doesn't scan skills on startup
    expect(duration).toBeLessThan(50);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("border is visible in both light and dark themes", () => {
  const skills = [
    { name: "test", description: "Test", filePath: "/tmp/test/SKILL.md", source: "pi-user" as const },
  ];

  // Dark theme (low luminance background)
  const darkTheme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => color === "toolPendingBg" ? `\u001b[48;2;30;30;30m${text}\u001b[49m` : text,
    getBgAnsi: (color: string) => color === "toolPendingBg" ? "\u001b[48;2;30;30;30m" : "",
    getColorMode: () => "truecolor" as const,
  };

  const darkPreview = formatSkillPickerPreview(skills, "", 58, 0, darkTheme);
  const darkRendered = darkPreview.join("\n");

  // Border should be mixed toward white (high luminance target)
  // 30,30,30 mixed with 255,255,255 at 45% = ~131,131,131
  expect(darkRendered).toContain("\u001b[38;2;131;131;131m");

  // Light theme (high luminance background)
  const lightTheme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => color === "toolPendingBg" ? `\u001b[48;2;230;233;239m${text}\u001b[49m` : text,
    getBgAnsi: (color: string) => color === "toolPendingBg" ? "\u001b[48;2;230;233;239m" : "",
    getColorMode: () => "truecolor" as const,
  };

  const lightPreview = formatSkillPickerPreview(skills, "", 58, 0, lightTheme);
  const lightRendered = lightPreview.join("\n");

  // Border should be mixed toward black (low luminance target)
  // 230,233,239 mixed with 0,0,0 at 45% = ~127,128,131
  expect(lightRendered).toContain("\u001b[38;2;127;128;131m");
});

test("e2e: Pi SDK loads the extension from a .pi folder in under 100ms", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-skill-selector-e2e-"));
  try {
    // Create a .pi folder structure with skills
    const piSkillsDir = join(agentDir, ".pi", "skills");
    for (let i = 0; i < 50; i++) {
      writeSkill(piSkillsDir, `skill-${i}`, `skill-${i}`, `Description ${i}`);
    }

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const start = performance.now();
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      noTools: "all",
    });

    try {
      await session.bindExtensions({});
      const duration = performance.now() - start;
      // Extension should load and bind in under 100ms with 50 skills
      expect(duration).toBeLessThan(100);
      expect(session.extensionRunner.getCommand("skill-selector")).toBeDefined();
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("e2e: skill picker opens fast with cached skills from .pi folder", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-skill-picker-e2e-"));
  let pastedText: string | undefined;

  try {
    // Create a .pi/skills folder with test skills
    const piSkillsDir = join(agentDir, ".pi", "skills");
    writeSkill(piSkillsDir, "test-skill", "test-skill", "A test skill");

    // Directly test the extension with the .pi folder
    let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    let sessionStartHandler: ((_event: unknown, ctx: any) => void) | undefined;

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

    // Simulate session_start with the .pi folder
    const start = performance.now();
    sessionStartHandler?.({}, {
      cwd: agentDir,
      ui: {
        custom() { return Promise.resolve("test-skill"); },
        notify() {},
        onTerminalInput(h: typeof terminalHandler) {
          terminalHandler = h;
          return () => {};
        },
        pasteToEditor(text: string) {
          pastedText = text;
        },
      },
    });

    const duration = performance.now() - start;
    // Session start should be fast (<20ms) because discoverSkills is lazy
    expect(duration).toBeLessThan(20);
    expect(terminalHandler).toBeDefined();

    // Now trigger the $ shortcut — this should use cached skills
    const pickerStart = performance.now();
    expect(terminalHandler?.("$")).toEqual({ consume: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pickerDuration = performance.now() - pickerStart;

    expect(pastedText).toBe(skillPromptInsertion("test-skill"));
    // Picker should open and resolve in under 50ms
    expect(pickerDuration).toBeLessThan(50);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
