import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

type SkillPickerResult = string | null;
type PickerThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type Rgb = { r: number; g: number; b: number };

type PickerTheme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
  bg?(color: PickerThemeBg, text: string): string;
  getBgAnsi?(color: PickerThemeBg): string;
  getColorMode?(): "truecolor" | "256color";
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

function parseTruecolorBg(ansi: string | undefined): Rgb | null {
  const match = ansi?.match(/\u001b\[48;2;(\d+);(\d+);(\d+)m/);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function luminance(color: Rgb): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

function truecolorFg(color: Rgb, text: string): string {
  return `\u001b[38;2;${color.r};${color.g};${color.b}m${text}\u001b[39m`;
}

function safeBg(theme: PickerTheme, color: PickerThemeBg, text: string): string {
  try {
    return theme.bg?.(color, text) ?? text;
  } catch {
    return text;
  }
}

function cardBorderStyle(theme: PickerTheme, surface: PickerThemeBg): (text: string) => string {
  const surfaceRgb = theme.getColorMode?.() === "truecolor" ? parseTruecolorBg(theme.getBgAnsi?.(surface)) : null;
  if (!surfaceRgb) return (text) => theme.fg("border", text);

  const target = luminance(surfaceRgb) > 0.55 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const border = mixRgb(surfaceRgb, target, 0.45);
  return (text) => truecolorFg(border, text);
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

function padVisible(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(width - visibleWidth(text), 0))}`;
}

function formatSkillRow(skill: SkillEntry, width: number, selected: boolean, theme: PickerTheme): string {
  const prefix = selected ? theme.fg("accent", "› ") : "  ";
  const nameWidth = Math.max(width - visibleWidth(prefix), 1);
  const rawName = fitVisible(skill.name, nameWidth);
  const name = selected ? theme.fg("accent", theme.bold(rawName)) : rawName;
  const row = padVisible(`${prefix}${name}`, width);
  return selected && theme.bg ? theme.bg("selectedBg", row) : row;
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

function plainPickerTheme(): PickerTheme {
  return {
    bold: (text) => text,
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    getColorMode: () => "256color",
  };
}

function formatSkillPickerCard(skills: SkillEntry[], query: string, width: number, selectedIndex: number, theme: PickerTheme, styled: boolean): string[] {
  const filtered = filterSkills(skills, query);
  const panelWidth = clamp(Math.floor(width), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  const bodyWidth = Math.max(panelWidth - 4, 1);
  const queryLabel = query ? `matching "${query}"` : "type to filter";
  const body = ["Search", `> ${query}`, "", ...formatSkillRows(filtered, selectedIndex, bodyWidth, theme)].map((line) => truncateToWidth(line, bodyWidth, ""));
  const cardSurface: PickerThemeBg = "toolPendingBg";
  const styleCardBorder = styled ? cardBorderStyle(theme, cardSurface) : (text: string) => text;

  return formatSkillPickerPanel({
    width: panelWidth,
    title: "Skills",
    subtitle: `${filtered.length}/${skills.length} · ${queryLabel}`,
    body,
    footer: "tab/enter select · ↑↓ move · esc",
    styleSurface: styled ? (text) => safeBg(theme, cardSurface, text) : (text) => text,
    styleBorder: styleCardBorder,
    styleAccentBorder: styleCardBorder,
    styleTitle: styled ? (text) => theme.fg("accent", theme.bold(text)) : (text) => text,
    styleMuted: styled ? (text) => theme.fg("muted", text) : (text) => text,
  });
}

export function formatSkillPickerPreview(skills: SkillEntry[], query: string, width = PANEL_MAX_WIDTH, selectedIndex = 0, theme?: PickerTheme): string[] {
  return formatSkillPickerCard(skills, query, width, selectedIndex, theme ?? plainPickerTheme(), Boolean(theme));
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

    const cardSurface: PickerThemeBg = "toolPendingBg";
    const styleCardBorder = cardBorderStyle(this.theme, cardSurface);

    return formatSkillPickerPanel({
      width: panelWidth,
      title: "Skills",
      subtitle: `${this.filtered.length}/${this.skills.length} · ${queryLabel}`,
      body,
      footer: "tab/enter select · ↑↓ move · esc",
      styleSurface: (text) => safeBg(this.theme, cardSurface, text),
      styleBorder: styleCardBorder,
      styleAccentBorder: styleCardBorder,
      styleTitle: (text) => this.theme.fg("accent", this.theme.bold(text)),
      styleMuted: (text) => this.theme.fg("muted", text),
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

// Cache for discovered skills to avoid repeated disk scans
let cachedSkills: SkillEntry[] | null = null;
let cachedSkillsCwd: string | null = null;

export function getCachedSkills(cwd: string, home?: string): SkillEntry[] {
  if (cachedSkills && cachedSkillsCwd === cwd) {
    return cachedSkills;
  }
  cachedSkills = discoverSkills(cwd, home);
  cachedSkillsCwd = cwd;
  return cachedSkills;
}

export function clearSkillCache(): void {
  cachedSkills = null;
  cachedSkillsCwd = null;
}

async function pickSkill(ctx: ExtensionContext, initialQuery = ""): Promise<SkillPickerResult> {
  const skills = getCachedSkills(ctx.cwd);
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
  let lastKeyWasSpace = true; // Start true so bare $ at prompt start triggers

  ctx.ui.onTerminalInput?.((data: string) => {
    if (pickerOpen) {
      return undefined;
    }

    // Track whether the next key should allow $ trigger
    const isSpace = data === " " || data === "\n" || data === "\r";

    // With Kitty keyboard protocol, $ is sent as \x1b[36u (CSI-u sequence), not raw "$".
    // Use matchesKey to handle both raw characters and Kitty protocol sequences.
    if (!matchesKey(data, "$") && !data.startsWith("$")) {
      lastKeyWasSpace = isSpace;
      return undefined;
    }

    // Only trigger if $ is preceded by a space (or start of line)
    if (!lastKeyWasSpace) {
      lastKeyWasSpace = isSpace;
      return undefined;
    }

    pickerOpen = true;
    // For Kitty protocol, data is the CSI-u sequence, so slice(1) is not a query.
    // Only use data.slice(1) as query when data starts with raw "$" (e.g., "$git").
    const initialQuery = data.startsWith("$") ? data.slice(1) : "";
    void pickSkill(ctx, initialQuery)
      .then((skillName) => {
        if (skillName) {
          ctx.ui.pasteToEditor(skillPromptInsertion(skillName));
          lastKeyWasSpace = true;
        }
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
