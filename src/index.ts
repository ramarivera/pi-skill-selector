import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from "@mariozechner/pi-tui";

type SkillPickerResult = string | null;
type PickerTheme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

export type SkillEntry = {
  name: string;
  description: string;
  filePath: string;
  source: "pi-user" | "agents-user" | "pi-project" | "agents-project";
};

const MAX_VISIBLE_SKILLS = 12;
const PANEL_MIN_WIDTH = 24;

type SkillPickerPanelOptions = {
  width: number;
  title: string;
  subtitle: string;
  body: string[];
  footer: string;
  styleBorder: (text: string) => string;
  styleTitle: (text: string) => string;
  styleMuted: (text: string) => string;
};

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function plainTruncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(width, 0));
  return `${text.slice(0, width - 1)}…`;
}

function panelBorderLine(
  left: string,
  label: string,
  right: string,
  width: number,
  styleBorder: (text: string) => string,
  styleLabel: (text: string) => string,
): string {
  const safeLabel = plainTruncate(label, Math.max(width - 6, 0));
  if (!safeLabel) return styleBorder(`${left}${"─".repeat(Math.max(width - 2, 0))}${right}`);

  const prefix = `${left}─ `;
  const suffix = ` ${"─".repeat(Math.max(width - prefix.length - safeLabel.length - right.length - 1, 0))}${right}`;
  return `${styleBorder(prefix)}${styleLabel(safeLabel)}${styleBorder(suffix)}`;
}

function panelRow(content: string, width: number, styleBorder: (text: string) => string, styleContent: (text: string) => string): string {
  const innerWidth = Math.max(width - 4, 0);
  const visible = truncateToWidth(content, innerWidth, "");
  const padding = " ".repeat(Math.max(innerWidth - visibleLength(visible), 0));
  return `${styleBorder("│ ")}${styleContent(visible)}${padding}${styleBorder(" │")}`;
}

export function formatSkillPickerPanel(options: SkillPickerPanelOptions): string[] {
  const width = Math.max(Math.floor(options.width), PANEL_MIN_WIDTH);
  const rows = [
    panelBorderLine("╭", options.title, "╮", width, options.styleBorder, options.styleTitle),
    panelRow(options.subtitle, width, options.styleBorder, options.styleMuted),
    panelBorderLine("├", "", "┤", width, options.styleBorder, options.styleBorder),
    ...options.body.map((line) => panelRow(line, width, options.styleBorder, (text) => text)),
    panelBorderLine("╰", options.footer, "╯", width, options.styleBorder, options.styleMuted),
  ];

  return rows;
}

function readFrontmatter(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readFrontmatterField(frontmatter: string | null, field: string): string | null {
  if (!frontmatter) return null;
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  return match?.[1]?.replace(/^["']|["']$/g, "").trim() || null;
}

function collectSkills(root: string, source: SkillEntry["source"]): SkillEntry[] {
  const skills: SkillEntry[] = [];
  if (!existsSync(root)) return skills;

  const visit = (dir: string) => {
    const skillFile = join(dir, "SKILL.md");
    if (existsSync(skillFile)) {
      const frontmatter = readFrontmatter(skillFile);
      const fallbackName = dirname(skillFile).split(/[\\/]/).pop() ?? "skill";
      skills.push({
        name: readFrontmatterField(frontmatter, "name") ?? fallbackName,
        description: readFrontmatterField(frontmatter, "description") ?? "",
        filePath: skillFile,
        source,
      });
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      visit(join(dir, entry));
    }
  };

  visit(root);
  return skills;
}

function findRepoRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectSkillDirs(cwd: string): Array<{ path: string; source: SkillEntry["source"] }> {
  const dirs: Array<{ path: string; source: SkillEntry["source"] }> = [{ path: join(cwd, ".pi", "skills"), source: "pi-project" }];
  const repoRoot = findRepoRoot(cwd);
  let current = resolve(cwd);

  while (true) {
    dirs.push({ path: join(current, ".agents", "skills"), source: "agents-project" });
    if (repoRoot && current === repoRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}

export function discoverSkills(cwd: string, home = homedir()): SkillEntry[] {
  const sources: Array<{ path: string; source: SkillEntry["source"] }> = [
    { path: join(home, ".pi", "agent", "skills"), source: "pi-user" },
    { path: join(home, ".agents", "skills"), source: "agents-user" },
    ...projectSkillDirs(cwd),
  ];

  const seen = new Set<string>();
  const skills: SkillEntry[] = [];

  for (const source of sources) {
    for (const skill of collectSkills(source.path, source.source)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push(skill);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function filterSkills(skills: SkillEntry[], query: string): SkillEntry[] {
  return fuzzyFilter(skills, query, (skill) => `${skill.name} ${skill.description}`);
}

export function skillPromptInsertion(skillName: string): string {
  return `/skill:${skillName} `;
}

function toSelectItem(skill: SkillEntry): SelectItem {
  return {
    value: skill.name,
    label: skill.name,
    description: skill.description || skill.source,
  };
}

class SkillPickerComponent implements Component, Focusable {
  private readonly input = new Input();
  private list: SelectList;
  private query: string;
  private filtered: SkillEntry[];
  private _focused = false;

  constructor(
    private readonly skills: SkillEntry[],
    initialQuery: string,
    private readonly theme: PickerTheme,
    private readonly done: (value: SkillPickerResult) => void,
  ) {
    this.query = initialQuery;
    this.input.setValue(initialQuery);
    this.filtered = filterSkills(skills, initialQuery);
    this.list = this.createList();
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  render(width: number): string[] {
    const panelWidth = Math.max(width, PANEL_MIN_WIDTH);
    const bodyWidth = Math.max(panelWidth - 4, 1);
    const queryLabel = this.query ? `matching "${this.query}"` : "ready to search";
    const body = [
      this.theme.fg("dim", "Filter"),
      ...this.input.render(bodyWidth),
      "",
      ...this.list.render(bodyWidth),
    ].map((line) => truncateToWidth(line, bodyWidth, ""));

    return formatSkillPickerPanel({
      width: panelWidth,
      title: "Skill Selector",
      subtitle: `${this.filtered.length}/${this.skills.length} skills · ${queryLabel}`,
      body,
      footer: "↑↓ navigate · enter select · esc cancel",
      styleBorder: (text) => this.theme.fg("muted", text),
      styleTitle: (text) => this.theme.fg("accent", this.theme.bold(text)),
      styleMuted: (text) => this.theme.fg("dim", text),
    }).map((line) => truncateToWidth(line, panelWidth, ""));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
      this.list.handleInput(data);
      return;
    }

    this.input.handleInput(data);
    const nextQuery = this.input.getValue();
    if (nextQuery !== this.query) {
      this.query = nextQuery;
      this.filtered = filterSkills(this.skills, this.query);
      this.list = this.createList();
    }
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  private createList(): SelectList {
    const list = new SelectList(
      this.filtered.map(toSelectItem),
      Math.min(Math.max(this.filtered.length, 1), MAX_VISIBLE_SKILLS),
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 42 },
    );

    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(null);
    return list;
  }
}

async function pickSkill(ctx: ExtensionContext, initialQuery = ""): Promise<SkillPickerResult> {
  const skills = discoverSkills(ctx.cwd);
  if (skills.length === 0) {
    ctx.ui.notify("No Pi skills found", "warning");
    return null;
  }

  return ctx.ui.custom<SkillPickerResult>(
    (_tui, theme, _keybindings, done) => new SkillPickerComponent(skills, initialQuery, theme, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-left",
        width: "80%",
        maxHeight: "70%",
        margin: 1,
      },
    },
  );
}

function installDollarSkillShortcut(ctx: ExtensionContext): void {
  let pickerOpen = false;

  ctx.ui.onTerminalInput?.((data: string) => {
    if (pickerOpen || !data.startsWith("$")) {
      return undefined;
    }

    pickerOpen = true;
    const initialQuery = data.slice(1);
    void pickSkill(ctx, initialQuery)
      .then((skillName) => {
        if (skillName) ctx.ui.pasteToEditor(skillPromptInsertion(skillName));
      })
      .finally(() => {
        pickerOpen = false;
      });

    return { consume: true };
  });
}

export default function extension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    installDollarSkillShortcut(ctx);
  });

  pi.registerCommand("skill-selector", {
    description: "Fuzzy-pick a skill and insert /skill:<name> into the prompt",
    handler: async (args, ctx) => {
      const skillName = await pickSkill(ctx, args.trim());
      if (skillName) ctx.ui.pasteToEditor(skillPromptInsertion(skillName));
    },
  });
}
