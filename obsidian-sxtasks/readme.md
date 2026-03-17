SX Tasks

A lightweight Obsidian plugin for page-local structured tasks using normal Markdown lists, stable hidden IDs, inline task references, and automatic completion dates.

Authors: Senxiu & Codex

## What It Is

SX Tasks is for notes that mix planning and narrative.

You write a normal Markdown list near the top of a note, mark selected list items as SX tasks, and then refer to them later in the same note with stable inline references.

The plugin gives you:

- automatic display codes such as `A`, `A1`, `A2`
- stable hidden task IDs stored in HTML comments
- same-note inline task references
- completion from either the source list or a reference
- automatic completion date inference from note context
- configurable visual styling for task tags and references

The Markdown file remains the source of truth.

## Current Model

SX Tasks now uses normal Markdown lists as the task source.

The source format is:

1. a normal Markdown list
2. hidden SX metadata in HTML comments at the end of task lines

Example:

```md
## Tasks

- IMF Preparation <!-- sx:id=sx_n5mszoau -->
  - document. <!-- sx:id=sx_o5k6zg39 done=2026-03-17 -->
  - code review. <!-- sx:id=sx_cy6b9h7l -->
  - design. <!-- sx:id=sx_l3fsyx4u -->
  - implementation. <!-- sx:id=sx_mhwkjs6j -->
```

This means:

- you edit plain Markdown lists
- the plugin keeps identity in hidden metadata
- references stay stable even if visible codes change

## Core Concepts

### Task source

SX Tasks reads task items from normal Markdown lists.

Current scope:

- top-level tasks
- one level of subtasks

Indentation can use spaces or tabs. Any indented task item is treated as a subtask.

### Hidden metadata

Each SX task line stores metadata in an HTML comment:

```md
- Write draft <!-- sx:id=sx_ab12cd34 -->
```

Completed tasks store a `done` date:

```md
- Update figure <!-- sx:id=sx_ef56gh78 done=2026-03-17 -->
```

Normally, you do not have to type this metadata manually. The plugin can insert it for you.

### Display codes

Display codes are computed dynamically from list position:

- top-level tasks: `A`, `B`, `C`
- subtasks: `A1`, `A2`, `B1`

These codes are for display only.

Stable identity comes from `sx:id=...`, not from the visible code.

### Inline references

References are stored as:

```md
[sxref:sx_ef56gh78]
```

In preview mode they render as human-readable task references.

If the reference points to a subtask, SX Tasks shows:

```text
A2 Parent Task: Child Task
```

The parent task name is rendered in bold.

### Completion

Completion belongs to the source list item, not the reference.

You can complete a task by:

- clicking its rendered list tag
- clicking a rendered inline reference

When completed, the plugin writes `done=YYYY-MM-DD` back to the source task line.

## Date Inference

When a task is completed, SX Tasks infers the completion date from nearby note structure.

Priority:

1. nearest previous `@YYYY-MM-DD`
2. nearest previous parseable heading date
3. today

Examples:

```md
@2026-03-17
```

or:

```md
## 2026-03-17
```

or:

```md
## March 17, 2026
```

Stored dates remain normalized as `YYYY-MM-DD`, even if the display format is configured differently.

## Commands

### Mark current line as SX task

Adds hidden SX metadata to the current Markdown list item.

Example result:

```md
- Write figure draft <!-- sx:id=sx_ab12cd34 -->
```

### Insert SX Task reference

Opens a picker of SX tasks in the current note and inserts:

```md
[sxref:<task-id>]
```

### Editor autocomplete trigger

Inside the editor, you can type trigger tokens such as:

```text
@task
```

or:

```text
/task
```

to search tasks from the current note and insert a reference.

The trigger tokens are configurable in plugin settings.

## Typical Workflow

### 1. Create a source list

```md
## Tasks

- Write figure draft
  - Fix legend
  - Update caption
- Reply to email
```

### 2. Register tasks

Put the cursor on a list item and run:

```text
Mark current line as SX task
```

Repeat for any task or subtask that should participate in SX Tasks.

### 3. Refer to tasks later in the note

Example:

```md
## 2026-03-17

Today I finished @task update caption
```

After autocomplete insertion, this becomes:

```md
Today I finished [sxref:sx_...]
```

### 4. Complete from below

In preview mode, click the rendered reference.

SX Tasks will:

- mark the original source task as done
- write the completion date back into the list item metadata
- rerender references with the updated state

## Appearance

SX Tasks currently supports configurable appearance for:

- code font
- task text font
- reference font
- completion strike-through
- completion date display format
- completion marker style
- list completion label position
- reference completion label position
- top-level color palette
- subtask color palette
- label spacing and shape
- done task-tag style (`outlined` or `filled`)

Current default completed-tag behavior is:

- outlined task tag
- no completion emoji marker by default
- list completion layout: `emoji + code + date`
- reference completion layout: `emoji + code + date`

This means completed items are primarily indicated by:

- tag style change
- date
- optional text styling

## Important Rules

- same-note only
- one note is the unit of task lookup
- display codes may change if task order changes
- references remain attached through `sx:id`
- parent completion is manual
- completing all subtasks does not auto-complete the parent
- current task hierarchy is intentionally simple: top-level + one subtask level

## Example

```md
## Tasks

- Write figure draft <!-- sx:id=sx_a1 -->
  - Fix legend <!-- sx:id=sx_a2 -->
  - Update caption <!-- sx:id=sx_a3 -->
- Reply to email <!-- sx:id=sx_b1 -->

## 2026-03-17

Today I finished [sxref:sx_a3].
```

Rendered behavior:

- source list shows dynamic task codes
- the subtask reference renders as `A2 Write figure draft: Update caption`
- clicking the reference updates the source line to:

```md
- Update caption <!-- sx:id=sx_a3 done=2026-03-17 -->
```

## Non-goals

SX Tasks is not trying to replace:

- the Obsidian Tasks plugin
- a vault-wide task database
- Dataview task queries
- recurring task systems
- project management boards

It is specifically for lightweight, local, narrative-friendly task tracking inside a single note.

## Status

Current implementation supports:

- normal Markdown list task sources
- stable hidden task metadata
- same-note inline references
- completion from list tags and references
- automatic completion date inference
- automatic rerender of references after edits
- configurable rendering and appearance

Not implemented:

- cross-note references
- vault-wide queries
- automatic parent completion
- drag-and-drop reordering logic
- rich metadata beyond `id` and `done`
