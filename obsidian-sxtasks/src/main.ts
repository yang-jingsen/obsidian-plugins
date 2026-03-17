import {
	Editor,
	MarkdownPostProcessorContext,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile,
	moment
} from "obsidian";

type SXTaskMeta = {
	id: string;
	done: string | null;
};

type SXTaskItem = {
	id: string;
	text: string;
	done: string | null;
	line: number;
	level: number;
	code: string;
	headingPath: string[];
	parentId: string | null;
	parentText: string | null;
};

type TaskReference = {
	task: SXTaskItem;
	beforeOffset: number;
};

type FlatTaskReference = {
	task: SXTaskItem;
	searchText: string;
};

type TaskIndex = {
	tasks: SXTaskItem[];
	byId: Map<string, SXTaskItem>;
	byLine: Map<number, SXTaskItem>;
};

type SXTasksSettings = {
	codeFontFamily: string;
	taskTextFontFamily: string;
	referenceFontFamily: string;
	doneTagStyle: "filled" | "outlined";
	strikeThroughDone: boolean;
	dateDisplayFormat: string;
	doneMarkerPreset: "emoji-check" | "plain-check" | "none" | "custom";
	doneMarkerCustom: string;
	listDoneMarkerPosition: "before-code" | "after-code" | "marker-code-date";
	referenceDoneMarkerPosition: "before-code" | "after-code" | "marker-code-date";
	labelGapPx: number;
	labelPaddingY: number;
	labelPaddingX: number;
	labelRadiusPx: number;
	topLevelColors: string[];
	subtaskColors: string[];
};

const REF_PATTERN = /\[sxref:([A-Za-z0-9_-]+)\]/g;
const DATE_MARKER_PATTERN = /@(\d{4}-\d{2}-\d{2})/g;
const SX_COMMENT_PATTERN = /<!--\s*sx:([\s\S]*?)-->\s*$/;
const LIST_ITEM_PATTERN = /^(\s*)([-*+])\s+(.*)$/;
const CHECKBOX_PREFIX_PATTERN = /^\[[ xX]\]\s+/;

const DEFAULT_SETTINGS: SXTasksSettings = {
	codeFontFamily: "\"Avenir Next Condensed\", \"IBM Plex Sans Condensed\", sans-serif",
	taskTextFontFamily: "\"Avenir Next\", \"IBM Plex Sans\", sans-serif",
	referenceFontFamily: "\"IBM Plex Sans\", sans-serif",
	doneTagStyle: "outlined",
	strikeThroughDone: false,
	dateDisplayFormat: "YYYY-MM-DD",
	doneMarkerPreset: "none",
	doneMarkerCustom: "DONE",
	listDoneMarkerPosition: "marker-code-date",
	referenceDoneMarkerPosition: "marker-code-date",
	labelGapPx: 8,
	labelPaddingY: 2,
	labelPaddingX: 8,
	labelRadiusPx: 999,
	topLevelColors: ["#D9485F", "#D97706", "#2F9E44", "#0EA5A5", "#2563EB", "#7C3AED"],
	subtaskColors: ["#F08C99", "#F3A54A", "#66C27A", "#55C9C9", "#5B8DEF", "#A78BFA"]
};

export default class SXTasksPlugin extends Plugin {
	settings: SXTasksSettings = DEFAULT_SETTINGS;
	private refreshTimers = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applySettings();

		this.registerMarkdownPostProcessor(async (el, ctx) => {
			await this.decorateTaskLists(el, ctx);
			await this.renderReferenceTokens(el, ctx);
		});

		this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
			const file = info.file;
			if (file instanceof TFile) {
				this.scheduleRefresh(file);
			}
		}));

		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile) {
				this.scheduleRefresh(file);
			}
		}));

		this.addSettingTab(new SXTasksSettingTab(this.app, this));

		this.addCommand({
			id: "mark-current-line-as-sx-task",
			name: "Mark current line as SX task",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) {
					new Notice("No active note.");
					return;
				}
				await this.ensureCurrentLineTask(editor, file);
			}
		});

		this.addCommand({
			id: "insert-sxtask-reference",
			name: "Insert SX Task reference",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) {
					new Notice("No active note.");
					return;
				}

				const index = await this.getTaskIndex(file);
				if (index.tasks.length === 0) {
					new Notice("No SX task available in this note.");
					return;
				}

				new SXTaskReferenceSuggestModal(this.app, createFlatReferences(index.tasks), (choice) => {
					editor.replaceSelection(`[sxref:${choice.task.id}]`);
				}).open();
			}
		});
	}

	onunload(): void {
		document.body.removeClass("sx-tasks-plugin");
		for (const timer of this.refreshTimers.values()) {
			window.clearTimeout(timer);
		}
		this.refreshTimers.clear();
	}

	private async ensureCurrentLineTask(editor: Editor, file: TFile): Promise<void> {
		const cursor = editor.getCursor();
		const lineText = editor.getLine(cursor.line);
		if (!LIST_ITEM_PATTERN.test(lineText)) {
			new Notice("Current line is not a markdown list item.");
			return;
		}

		const currentMeta = parseSXMeta(lineText);
		if (currentMeta?.id) {
			new Notice("This line is already an SX task.");
			return;
		}

		editor.setLine(cursor.line, upsertSXMeta(lineText, { id: createTaskId(), done: null }));
		await this.syncEditorToFile(editor, file);
		new Notice("SX task metadata added to current line.");
	}

	private async decorateTaskLists(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) {
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const index = parseTaskIndex(content);
		if (index.tasks.length === 0) {
			return;
		}

		const sectionInfo = ctx.getSectionInfo(el);
		if (!sectionInfo) {
			return;
		}

		const sectionTasks = index.tasks.filter((task) => task.line >= sectionInfo.lineStart && task.line <= sectionInfo.lineEnd);
		if (sectionTasks.length === 0) {
			return;
		}

		const listItems = Array.from(el.querySelectorAll("li"));
		let taskPointer = 0;
		for (const listItem of listItems) {
			const task = sectionTasks[taskPointer];
			if (!task) {
				break;
			}
			if (listItem.querySelector(":scope > .sx-task-prefix")) {
				continue;
			}

			const prefix = document.createElement("span");
			prefix.className = "sx-task-prefix";
			applyTaskAccent(prefix, task, this.settings);
			listItem.toggleClass("sx-task-top-level", task.level === 0);
			listItem.toggleClass("sx-task-subtask", task.level === 1);
			const doneParts = task.done ? createListDoneParts(task.done, this.settings) : null;
			if (doneParts && this.settings.listDoneMarkerPosition === "before-code") {
				prefix.appendChild(doneParts.container);
			}
			const codeBadge = prefix.createSpan({ cls: "sx-task-code", text: task.code });
			codeBadge.setAttribute("data-level", String(task.level));
			codeBadge.toggleClass("is-done", hasDoneDate(task.done));
			if (doneParts && this.settings.listDoneMarkerPosition === "marker-code-date") {
				if (doneParts.marker) {
					prefix.insertBefore(doneParts.marker, codeBadge);
				}
				if (doneParts.date) {
					prefix.appendChild(doneParts.date);
				}
			}
			if (doneParts && this.settings.listDoneMarkerPosition === "after-code") {
				prefix.appendChild(doneParts.container);
			}
			listItem.prepend(prefix);
			const contentEl = ensureTaskContentSpan(listItem);
			contentEl.toggleClass("is-done", hasDoneDate(task.done));
			if (doneParts) {
				listItem.addClass("is-done");
			}
			prefix.addEventListener("click", async () => {
				await this.toggleTaskById(file, task.id, offsetForLine(content, task.line));
			});
			taskPointer += 1;
		}
	}

	private async renderReferenceTokens(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) {
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const index = parseTaskIndex(content);
		if (index.tasks.length === 0) {
			return;
		}

		const sectionInfo = ctx.getSectionInfo(el);
		const beforeOffset = sectionInfo ? offsetForLine(content, sectionInfo.lineStart) : content.length;

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let currentNode = walker.nextNode();
		while (currentNode) {
			if (currentNode instanceof Text && currentNode.nodeValue?.includes("[sxref:")) {
				nodes.push(currentNode);
			}
			currentNode = walker.nextNode();
		}

		for (const node of nodes) {
			const text = node.nodeValue ?? "";
			REF_PATTERN.lastIndex = 0;

			let match: RegExpExecArray | null;
			let lastIndex = 0;
			let replaced = false;
			const fragment = document.createDocumentFragment();

			while ((match = REF_PATTERN.exec(text)) !== null) {
				replaced = true;
				const [full, taskId] = match;
				const before = text.slice(lastIndex, match.index);
				if (before) {
					fragment.append(before);
				}

				const task = index.byId.get(taskId);
				if (task) {
					fragment.append(this.createReferenceBadge({ task, beforeOffset }, file));
				} else {
					fragment.append(full);
				}

				lastIndex = match.index + full.length;
			}

			if (!replaced) {
				continue;
			}

			const after = text.slice(lastIndex);
			if (after) {
				fragment.append(after);
			}

			node.parentNode?.replaceChild(fragment, node);
		}
	}

	private createReferenceBadge(reference: TaskReference, file: TFile): HTMLElement {
		const badge = document.createElement("span");
		badge.className = "sx-task-ref";
		applyTaskAccent(badge, reference.task, this.settings);
		const doneParts = reference.task.done ? createReferenceDoneParts(reference.task.done, this.settings) : null;
		if (doneParts && this.settings.referenceDoneMarkerPosition === "before-code") {
			badge.appendChild(doneParts.container);
		}
		const codeEl = badge.createSpan({ cls: "sx-task-ref-code", text: reference.task.code });
		codeEl.toggleClass("is-done", hasDoneDate(reference.task.done));
		if (doneParts && this.settings.referenceDoneMarkerPosition === "marker-code-date") {
			if (doneParts.marker) {
				badge.insertBefore(doneParts.marker, codeEl);
			}
			if (doneParts.date) {
				badge.appendChild(doneParts.date);
			}
		}
		if (doneParts && this.settings.referenceDoneMarkerPosition === "after-code") {
			badge.appendChild(doneParts.container);
		}
		if (reference.task.parentText) {
			badge.createEl("strong", { cls: "sx-task-ref-parent", text: reference.task.parentText });
			badge.createSpan({ cls: "sx-task-ref-separator", text: ": " });
		}
		badge.createSpan({ cls: "sx-task-ref-text", text: reference.task.text });
		this.syncReferenceBadgeState(badge, reference.task.done);
		badge.addEventListener("click", async () => {
			const nextDone = await this.toggleTaskById(file, reference.task.id, reference.beforeOffset);
			this.syncReferenceBadgeState(badge, nextDone);
		});
		return badge;
	}

	async getTaskIndex(file: TFile): Promise<TaskIndex> {
		const content = await this.app.vault.cachedRead(file);
		return parseTaskIndex(content);
	}


	private syncReferenceBadgeState(badge: HTMLElement, done: string | null): void {
		const isDone = hasDoneDate(done);
		badge.toggleClass("is-done", isDone);
		badge.querySelector(".sx-task-ref-code")?.toggleClass("is-done", isDone);

		badge.querySelectorAll(".sx-task-ref-date, .sx-task-ref-date-group, .sx-task-ref-date-marker").forEach((el) => el.remove());
		const codeEl = badge.querySelector(".sx-task-ref-code");
		if (isDone) {
			const parts = createReferenceDoneParts(done, this.settings);
			if (this.settings.referenceDoneMarkerPosition === "before-code") {
				if (codeEl?.parentNode) {
					codeEl.parentNode.insertBefore(parts.container, codeEl);
				} else {
					badge.prepend(parts.container);
				}
			} else if (this.settings.referenceDoneMarkerPosition === "after-code") {
				if (codeEl?.nextSibling) {
					badge.insertBefore(parts.container, codeEl.nextSibling);
				} else {
					badge.appendChild(parts.container);
				}
			} else {
				if (parts.marker) {
					if (codeEl?.parentNode) {
						codeEl.parentNode.insertBefore(parts.marker, codeEl);
					} else {
						badge.prepend(parts.marker);
					}
				}
				if (parts.date) {
					if (codeEl?.nextSibling) {
						badge.insertBefore(parts.date, codeEl.nextSibling);
					} else {
						badge.appendChild(parts.date);
					}
				}
			}
		}
	}

	private async toggleTaskById(file: TFile, taskId: string, beforeOffset: number): Promise<string | null> {
		const content = await this.app.vault.cachedRead(file);
		const index = parseTaskIndex(content);
		const task = index.byId.get(taskId);
		if (!task) {
			new Notice("SX task not found.");
			return null;
		}

		const nextDone = hasDoneDate(task.done) ? null : inferCompletionDate(content, beforeOffset);
		const lines = content.replace(/\r/g, "").split("\n");
		lines[task.line] = upsertSXMeta(lines[task.line], {
			id: task.id,
			done: nextDone
		});
		await this.app.vault.modify(file, lines.join("\n"));
		return nextDone;
	}

	private async syncEditorToFile(editor: Editor, file: TFile): Promise<void> {
		await this.app.vault.modify(file, editor.getValue());
	}

	private scheduleRefresh(file: TFile): void {
		const existing = this.refreshTimers.get(file.path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}

		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(file.path);
			this.rerenderMarkdownViews(file);
		}, 80);
		this.refreshTimers.set(file.path, timer);
	}

	private rerenderMarkdownViews(file: TFile): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			if (view.file?.path !== file.path) {
				continue;
			}
			view.previewMode.rerender(true);
		}
	}

	private async loadSettings(): Promise<void> {
		const saved = await this.loadData();
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			dateDisplayFormat: normalizeDateDisplayTemplate(saved?.dateDisplayFormat ?? DEFAULT_SETTINGS.dateDisplayFormat),
			topLevelColors: normalizePalette(saved?.topLevelColors, DEFAULT_SETTINGS.topLevelColors),
			subtaskColors: normalizePalette(saved?.subtaskColors, DEFAULT_SETTINGS.subtaskColors)
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.applySettings();
	}

	private applySettings(): void {
		document.body.addClass("sx-tasks-plugin");
		document.body.toggleClass("sx-tasks-strike-through", this.settings.strikeThroughDone);
		document.body.toggleClass("sx-tasks-done-tag-outlined", this.settings.doneTagStyle === "outlined");
		document.body.style.setProperty("--sx-task-code-font", this.settings.codeFontFamily);
		document.body.style.setProperty("--sx-task-text-font", this.settings.taskTextFontFamily);
		document.body.style.setProperty("--sx-task-ref-font", this.settings.referenceFontFamily);
		document.body.style.setProperty("--sx-task-gap", `${this.settings.labelGapPx}px`);
		document.body.style.setProperty("--sx-task-label-pad-y", `${this.settings.labelPaddingY}px`);
		document.body.style.setProperty("--sx-task-label-pad-x", `${this.settings.labelPaddingX}px`);
		document.body.style.setProperty("--sx-task-label-radius", `${this.settings.labelRadiusPx}px`);
	}
}

class SXTaskReferenceSuggestModal extends SuggestModal<FlatTaskReference> {
	private readonly choices: FlatTaskReference[];
	private readonly onChoose: (value: FlatTaskReference) => void;

	constructor(app: Plugin["app"], choices: FlatTaskReference[], onChoose: (value: FlatTaskReference) => void) {
		super(app);
		this.choices = choices;
		this.onChoose = onChoose;
		this.setPlaceholder("Select an SX task reference");
	}

	getSuggestions(query: string): FlatTaskReference[] {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) {
			return this.choices;
		}
		return this.choices.filter((choice) => choice.searchText.includes(normalizedQuery));
	}

	renderSuggestion(choice: FlatTaskReference, el: HTMLElement): void {
		el.createDiv({ text: `${choice.task.code} ${referenceDisplayText(choice.task)}` });
		const context = choice.task.headingPath.length > 0 ? choice.task.headingPath.join(" / ") : "Current note";
		el.createEl("small", { text: context });
	}

	onChooseSuggestion(choice: FlatTaskReference): void {
		this.onChoose(choice);
	}
}

function parseTaskIndex(content: string): TaskIndex {
	const lines = content.replace(/\r/g, "").split("\n");
	const tasks: SXTaskItem[] = [];
	const byId = new Map<string, SXTaskItem>();
	const byLine = new Map<number, SXTaskItem>();
	const headingStack: string[] = [];
	const counters: number[] = [];
	let currentTopLevelTask: SXTaskItem | null = null;

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
		const line = lines[lineNumber];
		const heading = parseHeading(line);
		if (heading) {
			headingStack[heading.level - 1] = heading.text;
			headingStack.length = heading.level;
			continue;
		}

		const meta = parseSXMeta(line);
		if (!meta) {
			continue;
		}

		const listItem = parseListItem(line);
		if (!listItem) {
			continue;
		}

		const level = indentLevelForListItem(listItem.indent);
		counters[level] = (counters[level] ?? 0) + 1;
		counters.length = level + 1;
		if (level === 0) {
			counters[1] = 0;
		}

		const code = level === 0 ? alphaCode(counters[0] - 1) : `${alphaCode(counters[0] - 1)}${counters[1]}`;
		const task: SXTaskItem = {
			id: meta.id,
			text: listItem.text,
			done: meta.done,
			line: lineNumber,
			level,
			code,
			headingPath: [...headingStack],
			parentId: level === 1 ? currentTopLevelTask?.id ?? null : null,
			parentText: level === 1 ? currentTopLevelTask?.text ?? null : null
		};
		if (level === 0) {
			currentTopLevelTask = task;
		}
		tasks.push(task);
		byId.set(task.id, task);
		byLine.set(task.line, task);
	}

	return { tasks, byId, byLine };
}

class SXTasksSettingTab extends PluginSettingTab {
	private readonly plugin: SXTasksPlugin;

	constructor(app: Plugin["app"], plugin: SXTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();


		new Setting(containerEl)
			.setName("Code font")
			.setDesc("Font family for the colored task code labels.")
			.addText((text) =>
				text.setValue(this.plugin.settings.codeFontFamily).onChange(async (value) => {
					this.plugin.settings.codeFontFamily = value || DEFAULT_SETTINGS.codeFontFamily;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Task text font")
			.setDesc("Font family for task text in rendered lists.")
			.addText((text) =>
				text.setValue(this.plugin.settings.taskTextFontFamily).onChange(async (value) => {
					this.plugin.settings.taskTextFontFamily = value || DEFAULT_SETTINGS.taskTextFontFamily;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Reference font")
			.setDesc("Font family for inline task references.")
			.addText((text) =>
				text.setValue(this.plugin.settings.referenceFontFamily).onChange(async (value) => {
					this.plugin.settings.referenceFontFamily = value || DEFAULT_SETTINGS.referenceFontFamily;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Done tag style")
			.setDesc("Controls how the task code badge itself changes when a task is completed.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("outlined", "Outlined")
					.addOption("filled", "Filled")
					.setValue(this.plugin.settings.doneTagStyle)
					.onChange(async (value: SXTasksSettings["doneTagStyle"]) => {
						this.plugin.settings.doneTagStyle = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Done strike-through")
			.setDesc("Add strike-through to completed tasks and references.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.strikeThroughDone).onChange(async (value) => {
					this.plugin.settings.strikeThroughDone = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Date display template")
			.setDesc("Moment-style format string for rendered dates. You can also use {cnw} for Chinese weekday single character and {cnwd} for Chinese weekday with 周.")
			.addText((text) =>
				text
					.setPlaceholder("MM-DD {cnw}")
					.setValue(this.plugin.settings.dateDisplayFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateDisplayFormat = value || DEFAULT_SETTINGS.dateDisplayFormat;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("List done label position")
			.setDesc("Choose whether the completion marker and date appear before or after the task code in lists.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("before-code", "Before code")
					.addOption("after-code", "After code")
					.addOption("marker-code-date", "Emoji + code + date")
					.setValue(this.plugin.settings.listDoneMarkerPosition)
					.onChange(async (value: SXTasksSettings["listDoneMarkerPosition"]) => {
						this.plugin.settings.listDoneMarkerPosition = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Reference done label position")
			.setDesc("Choose whether the completion marker and date appear before or after the task code in task references.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("before-code", "Before code")
					.addOption("after-code", "After code")
					.addOption("marker-code-date", "Emoji + code + date")
					.setValue(this.plugin.settings.referenceDoneMarkerPosition)
					.onChange(async (value: SXTasksSettings["referenceDoneMarkerPosition"]) => {
						this.plugin.settings.referenceDoneMarkerPosition = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Done marker style")
			.setDesc("Choose how the completion marker is shown before the rendered date.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("emoji-check", "Emoji check (✅)")
					.addOption("plain-check", "Plain check (✓)")
					.addOption("none", "No marker")
					.addOption("custom", "Custom")
					.setValue(this.plugin.settings.doneMarkerPreset)
					.onChange(async (value: SXTasksSettings["doneMarkerPreset"]) => {
						this.plugin.settings.doneMarkerPreset = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom done marker")
			.setDesc("Used when done marker style is set to Custom. You can enter any text or emoji.")
			.addText((text) =>
				text
					.setPlaceholder("✅")
					.setValue(this.plugin.settings.doneMarkerCustom)
					.onChange(async (value) => {
						this.plugin.settings.doneMarkerCustom = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Label gap")
			.setDesc("Space between the colored label and task text.")
			.addSlider((slider) =>
				slider.setLimits(2, 20, 1).setValue(this.plugin.settings.labelGapPx).setDynamicTooltip().onChange(async (value) => {
					this.plugin.settings.labelGapPx = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Label horizontal padding")
			.setDesc("Internal horizontal padding for the code label.")
			.addSlider((slider) =>
				slider.setLimits(4, 16, 1).setValue(this.plugin.settings.labelPaddingX).setDynamicTooltip().onChange(async (value) => {
					this.plugin.settings.labelPaddingX = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Label vertical padding")
			.setDesc("Internal vertical padding for the code label.")
			.addSlider((slider) =>
				slider.setLimits(1, 8, 1).setValue(this.plugin.settings.labelPaddingY).setDynamicTooltip().onChange(async (value) => {
					this.plugin.settings.labelPaddingY = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Label radius")
			.setDesc("Roundness of the code label badge.")
			.addSlider((slider) =>
				slider.setLimits(4, 999, 1).setValue(this.plugin.settings.labelRadiusPx).setDynamicTooltip().onChange(async (value) => {
					this.plugin.settings.labelRadiusPx = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Top-level colors")
			.setDesc("Comma-separated palette for parent tasks.")
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.topLevelColors.join(", ")).onChange(async (value) => {
					this.plugin.settings.topLevelColors = normalizePalette(value.split(","), DEFAULT_SETTINGS.topLevelColors);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Subtask colors")
			.setDesc("Comma-separated palette for child tasks.")
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.subtaskColors.join(", ")).onChange(async (value) => {
					this.plugin.settings.subtaskColors = normalizePalette(value.split(","), DEFAULT_SETTINGS.subtaskColors);
					await this.plugin.saveSettings();
				})
			);
	}
}

function parseHeading(line: string): { level: number; text: string } | null {
	const match = line.match(/^(#{1,6})\s+(.*)$/);
	if (!match) {
		return null;
	}
	return { level: match[1].length, text: match[2].trim() };
}

function parseListItem(line: string): { indent: number; text: string } | null {
	const match = line.match(LIST_ITEM_PATTERN);
	if (!match) {
		return null;
	}

	const text = stripSXComment(match[3]).replace(CHECKBOX_PREFIX_PATTERN, "").trim();
	return { indent: match[1].length, text };
}

function indentLevelForListItem(indentWidth: number): number {
	return indentWidth > 0 ? 1 : 0;
}

function parseSXMeta(line: string): SXTaskMeta | null {
	const match = line.match(SX_COMMENT_PATTERN);
	if (!match) {
		return null;
	}

	const id = readMetaAttr(match[1], "id");
	if (!id) {
		return null;
	}

	return {
		id,
		done: readMetaAttr(match[1], "done")
	};
}

function readMetaAttr(attrs: string, key: string): string | null {
	const pattern = new RegExp(`${key}=([^\\s]+)`);
	const match = attrs.match(pattern);
	return match ? match[1] : null;
}

function upsertSXMeta(line: string, meta: SXTaskMeta): string {
	const base = stripSXComment(line).trimEnd();
	const attrs = [`id=${meta.id}`];
	if (meta.done) {
		attrs.push(`done=${meta.done}`);
	}
	return `${base} <!-- sx:${attrs.join(" ")} -->`;
}

function stripSXComment(line: string): string {
	return line.replace(SX_COMMENT_PATTERN, "");
}

function createFlatReferences(tasks: SXTaskItem[]): FlatTaskReference[] {
	return tasks.map((task) => ({
		task,
		searchText: `${task.code} ${task.text} ${task.parentText ?? ""} ${task.headingPath.join(" ")} ${task.done ?? ""}`.toLowerCase()
	}));
}

function referenceDisplayText(task: SXTaskItem): string {
	return task.parentText ? `${task.parentText}: ${task.text}` : task.text;
}

function inferCompletionDate(content: string, beforeOffset: number): string {
	const prior = content.slice(0, beforeOffset);
	const dateMarker = findLastDateMarker(prior);
	if (dateMarker) {
		return dateMarker;
	}

	const headingDate = findLastHeadingDate(prior);
	if (headingDate) {
		return headingDate;
	}

	return moment().format("YYYY-MM-DD");
}

function formatDisplayDate(date: string | null, displayFormat: string): string {
	if (!date) {
		return "";
	}

	const parsed = moment(date, "YYYY-MM-DD", true);
	if (!parsed.isValid()) {
		return date;
	}

	const template = normalizeDateDisplayTemplate(displayFormat.trim() || DEFAULT_SETTINGS.dateDisplayFormat);
	return applyDateTemplate(parsed, template);
}

function hasDoneDate(date: string | null): boolean {
	return typeof date === "string" && date.trim().length > 0;
}

function formatDoneDisplay(date: string | null, settings: SXTasksSettings): string {
	const displayDate = formatDisplayDate(date, settings.dateDisplayFormat);
	if (!displayDate) {
		return "";
	}

	const marker = resolveDoneMarker(settings);
	return marker ? `${marker} ${displayDate}` : displayDate;
}

function createListDoneParts(date: string, settings: SXTasksSettings): {
	container: HTMLElement;
	marker: HTMLElement | null;
	date: HTMLElement | null;
} {
	const container = createSpan({ cls: "sx-task-date-group" });
	const markerText = resolveDoneMarker(settings);
	const dateText = formatDisplayDate(date, settings.dateDisplayFormat);

	let marker: HTMLElement | null = null;
	if (markerText) {
		marker = createSpan({ cls: "sx-task-date-marker", text: markerText });
		container.appendChild(marker);
	}

	let dateEl: HTMLElement | null = null;
	if (dateText) {
		dateEl = createSpan({ cls: "sx-task-date", text: dateText });
		container.appendChild(dateEl);
	}

	return { container, marker, date: dateEl };
}

function createReferenceDoneParts(date: string, settings: SXTasksSettings): {
	container: HTMLElement;
	marker: HTMLElement | null;
	date: HTMLElement | null;
} {
	const container = createSpan({ cls: "sx-task-ref-date-group" });
	const markerText = resolveDoneMarker(settings);
	const dateText = formatDisplayDate(date, settings.dateDisplayFormat);

	let marker: HTMLElement | null = null;
	if (markerText) {
		marker = createSpan({ cls: "sx-task-ref-date-marker", text: markerText });
		container.appendChild(marker);
	}

	let dateEl: HTMLElement | null = null;
	if (dateText) {
		dateEl = createSpan({ cls: "sx-task-ref-date", text: dateText });
		container.appendChild(dateEl);
	}

	return { container, marker, date: dateEl };
}

function normalizeDateDisplayTemplate(template: string): string {
	return template
		.replace(/yyyy/g, "YYYY")
		.replace(/yy/g, "YY")
		.replace(/(?<!H|h):mm/g, (m) => m)
		.replace(/mm/g, "MM")
		.replace(/(^|[^A-Za-z])mm(?=[^A-Za-z]|$)/g, (m, p1) => `${p1}MM`)
		.replace(/dd/g, "DD")
		.replace(/(^|[^A-Za-z])dd(?=[^A-Za-z]|$)/g, (m, p1) => `${p1}DD`);
}

function applyDateTemplate(parsed: ReturnType<typeof moment>, template: string): string {
	const cnWeekdays = ["日", "一", "二", "三", "四", "五", "六"];
	const weekday = cnWeekdays[parsed.day()];
	const protectedTemplate = template
		.replace(/\{cnwd\}/g, "[__sx_cnwd__]")
		.replace(/\{cnw\}/g, "[__sx_cnw__]");

	return parsed.format(protectedTemplate)
		.replace(/__sx_cnwd__/g, `周${weekday}`)
		.replace(/__sx_cnw__/g, weekday);
}

function resolveDoneMarker(settings: SXTasksSettings): string {
	switch (settings.doneMarkerPreset) {
		case "emoji-check":
			return "✅";
		case "plain-check":
			return "✓";
		case "none":
			return "";
		case "custom":
			return settings.doneMarkerCustom.trim();
		default:
			return "✅";
	}
}

function findLastDateMarker(content: string): string | null {
	let match: RegExpExecArray | null;
	let result: string | null = null;
	DATE_MARKER_PATTERN.lastIndex = 0;

	while ((match = DATE_MARKER_PATTERN.exec(content)) !== null) {
		result = match[1];
	}

	return result;
}

function findLastHeadingDate(content: string): string | null {
	const lines = content.replace(/\r/g, "").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("#")) {
			continue;
		}

		const title = line.replace(/^#+\s*/, "").trim();
		const parsed = moment(title, [moment.ISO_8601, "MMMM D, YYYY", "MMM D, YYYY"], true);
		if (parsed.isValid()) {
			return parsed.format("YYYY-MM-DD");
		}
	}

	return null;
}

function alphaCode(index: number): string {
	let value = index;
	let result = "";

	do {
		result = String.fromCharCode(65 + (value % 26)) + result;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);

	return result;
}


function applyTaskAccent(el: HTMLElement, task: SXTaskItem, settings: SXTasksSettings): void {
	const palette = task.level === 0 ? settings.topLevelColors : settings.subtaskColors;
	const paletteIndex = Math.max(0, topLevelTaskIndex(task.code));
	const accent = palette[paletteIndex % palette.length] ?? DEFAULT_SETTINGS.topLevelColors[0];
	el.style.setProperty("--sx-task-accent", accent);
}

function topLevelTaskIndex(code: string): number {
	const letterPart = code.match(/^[A-Z]+/)?.[0] ?? "A";
	let index = 0;
	for (let i = 0; i < letterPart.length; i += 1) {
		index = index * 26 + (letterPart.charCodeAt(i) - 64);
	}
	return index - 1;
}


function normalizePalette(input: unknown, fallback: string[]): string[] {
	if (!Array.isArray(input)) {
		if (typeof input === "string") {
			return normalizePalette(input.split(","), fallback);
		}
		return [...fallback];
	}

	const normalized = input
		.map((item) => String(item).trim())
		.filter((item) => item.length > 0);
	return normalized.length > 0 ? normalized : [...fallback];
}

function createTaskId(): string {
	return `sx_${Math.random().toString(36).slice(2, 10)}`;
}

function offsetForLine(content: string, targetLine: number): number {
	if (targetLine <= 0) {
		return 0;
	}

	let offset = 0;
	let currentLine = 0;
	while (currentLine < targetLine && offset < content.length) {
		const nextBreak = content.indexOf("\n", offset);
		if (nextBreak === -1) {
			return content.length;
		}
		offset = nextBreak + 1;
		currentLine += 1;
	}

	return offset;
}

function ensureTaskContentSpan(listItem: HTMLElement): HTMLElement {
	const existing = listItem.querySelector(":scope > .sx-task-content");
	if (existing instanceof HTMLElement) {
		return existing;
	}

	const content = document.createElement("span");
	content.className = "sx-task-content";

	const nodesToMove: ChildNode[] = [];
	for (const node of Array.from(listItem.childNodes)) {
		if (node instanceof HTMLElement) {
			if (node.hasClass("sx-task-prefix") || node.hasClass("list-bullet") || node.hasClass("list-collapse-indicator")) {
				continue;
			}
			if (node.tagName === "UL" || node.tagName === "OL") {
				continue;
			}
			if (node.hasClass("sx-task-content")) {
				return node;
			}
		}
		nodesToMove.push(node);
	}

	if (nodesToMove.length === 0) {
		return content;
	}

	const anchor = listItem.querySelector(":scope > .sx-task-prefix");
	for (const node of nodesToMove) {
		content.appendChild(node);
	}

	if (anchor?.nextSibling) {
		listItem.insertBefore(content, anchor.nextSibling);
	} else {
		listItem.appendChild(content);
	}

	return content;
}
