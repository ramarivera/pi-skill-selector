import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
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

const MAX_VISIBLE_SKILLS = 8;
const PANEL_MIN_WIDTH = 44;
const PANEL_MAX_WIDTH = 58;

type SkillPickerPanelOptions = {
  width: number;
  title: string;
  subtitle: string;
  body: string[];
  footer: string;
  styleSurface: (text: string) => string;
  styleBorder: (text: string) => string;
  styleAccentBorder: (text: string) => string;
  styleTitle: (text: string) => string;
  styleMuted: (text: string) => string;
};

function fitVisible(text: string, width: number): string {
  return truncateToWidth(text, Math.max(width, 0), "…");
}

function panelBorderLine(
  left: string,
  label: string,
  right: string,
  width: number,
  styleBorder: (text: string) => string,
  styleLabel: (text: string) => string,
): string {
  const safeLabel = fitVisible(label, Math.max(width - 6, 0));
  if (!safeLabel) return styleBorder(`${left}${"─".repeat(Math.max(width - 2, 0))}${right}`);

  const prefix = `${left}─ `;
  const suffixStart = " ";
  const fillWidth = Math.max(width - visibleWidth(prefix) - visibleWidth(safeLabel) - visibleWidth(suffixStart) - visibleWidth(right), 0);
  const suffix = `${suffixStart}${"─".repeat(fillWidth)}${right}`;
  return `${styleBorder(prefix)}${styleLabel(safeLabel)}${styleBorder(suffix)}`;
}

function panelRow(content: string, width: number, styleBorder: (text: string) => string, styleContent: (text: string) => string): string {
  const innerWidth = Math.max(width - 4, 0);
  const visible = truncateToWidth(content, innerWidth, "…");
  const padding = " ".repeat(Math.max(innerWidth - visibleWidth(visible), 0));
  return `${styleBorder("│ ")}${styleContent(visible)}${padding}${styleBorder(" │")}`;
}

export function formatSkillPickerPanel(options: SkillPickerPanelOptions): string[] {
  const width = Math.max(Math.floor(options.width), PANEL_MIN_WIDTH);
  const rows = [
    panelBorderLine("╭", options.title, "╮", width, options.styleAccentBorder, options.styleTitle),
    panelRow(options.subtitle, width, options.styleBorder, options.styleMuted),
    panelBorderLine("├", "", "┤", width, options.styleBorder, options.styleBorder),
    ...options.body.map((line) => panelRow(line, width, options.styleBorder, (text) => text)),
    panelBorderLine("╰", options.footer, "╯", width, options.styleAccentBorder, options.styleMuted),
  ];

  return rows.map(options.styleSurface);
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

export function isSkillPickerConfirmKey(data: string): boolean {
  return matchesKey(data, Key.enter) || matchesKey(data, Key.tab);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function formatSkillRow(skill: SkillEntry, width: number, selected: boolean, theme: PickerTheme): string {
  const prefix = selected ? theme.fg("accent", "› ") : "  ";
  const nameWidth = Math.max(width - visibleWidth(prefix), 1);
  const rawName = fitVisible(skill.name, nameWidth);
  const name = selected ? theme.fg("accent", theme.bold(rawName)) : rawName;
  return `${prefix}${name}`;
}

function formatSelectedSkillDescription(skill: SkillEntry | undefined, width: number, theme: PickerTheme): string[] {
  if (!skill) return [];
  const description = skill.description || skill.source;
  return ["", theme.fg("dim", fitVisible(description, width))];
}

function formatSkillRows(skills: SkillEntry[], selectedIndex: number, width: number, theme: PickerTheme): string[] {
  if (skills.length === 0) {
    return [theme.fg("warning", "  No matching skills")];
  }

  const visibleCount = Math.min(skills.length, MAX_VISIBLE_SKILLS);
  const normalizedSelectedIndex = clamp(selectedIndex, 0, skills.length - 1);
  const startIndex = clamp(normalizedSelectedIndex - Math.floor(visibleCount / 2), 0, Math.max(skills.length - visibleCount, 0));
  const endIndex = Math.min(startIndex + visibleCount, skills.length);
  const rows = skills.slice(startIndex, endIndex).map((skill, offset) => {
    const index = startIndex + offset;
    return formatSkillRow(skill, width, index === normalizedSelectedIndex, theme);
  });

  if (skills.length > visibleCount) {
    rows.push(theme.fg("dim", `  ${normalizedSelectedIndex + 1}/${skills.length}`));
  }

  rows.push(...formatSelectedSkillDescription(skills[normalizedSelectedIndex], width, theme));
  return rows;
}

export function formatSkillPickerPreview(skills: SkillEntry[], query: string, width = PANEL_MAX_WIDTH, selectedIndex = 0): string[] {
  const theme: PickerTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  const filtered = filterSkills(skills, query);
  const panelWidth = clamp(Math.floor(width), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  const bodyWidth = Math.max(panelWidth - 4, 1);
  const queryLabel = query ? `matching "${query}"` : "type to filter";
  const body = ["Search", `> ${query}`, "", ...formatSkillRows(filtered, selectedIndex, bodyWidth, theme)].map((line) => truncateToWidth(line, bodyWidth, ""));

  return formatSkillPickerPanel({
    width: panelWidth,
    title: "Skills",
    subtitle: `${filtered.length}/${skills.length} · ${queryLabel}`,
    body,
    footer: "tab/enter select · ↑↓ move · esc",
    styleSurface: (text) => text,
    styleBorder: (text) => text,
    styleAccentBorder: (text) => text,
    styleTitle: (text) => text,
    styleMuted: (text) => text,
  });
}

class SkillPickerComponent implements Component, Focusable {
  private readonly input = new Input();
  private query: string;
  private filtered: SkillEntry[];
  private selectedIndex = 0;
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
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  render(width: number): string[] {
    const panelWidth = clamp(Math.floor(width), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
    const bodyWidth = Math.max(panelWidth - 4, 1);
    const queryLabel = this.query ? `matching "${this.query}"` : "type to filter";
    const body = [
      this.theme.fg("dim", "Search"),
      ...this.input.render(bodyWidth),
      "",
      ...formatSkillRows(this.filtered, this.selectedIndex, bodyWidth, this.theme),
    ].map((line) => truncateToWidth(line, bodyWidth, ""));

    return formatSkillPickerPanel({
      width: panelWidth,
      title: "Skills",
      subtitle: `${this.filtered.length}/${this.skills.length} · ${queryLabel}`,
      body,
      footer: "tab/enter select · ↑↓ move · esc",
      styleSurface: (text) => text,
      styleBorder: (text) => this.theme.fg("borderMuted", text),
      styleAccentBorder: (text) => this.theme.fg("borderMuted", text),
      styleTitle: (text) => this.theme.fg("accent", this.theme.bold(text)),
      styleMuted: (text) => this.theme.fg("dim", text),
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }

    if (isSkillPickerConfirmKey(data)) {
      this.selectCurrentSkill();
      return;
    }

    this.input.handleInput(data);
    const nextQuery = this.input.getValue();
    if (nextQuery !== this.query) {
      this.query = nextQuery;
      this.filtered = filterSkills(this.skills, this.query);
      this.selectedIndex = 0;
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
  }

  private selectCurrentSkill(): void {
    const skill = this.filtered[this.selectedIndex];
    if (skill) this.done(skill.name);
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
        anchor: "center",
        width: PANEL_MAX_WIDTH,
        maxHeight: 18,
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
