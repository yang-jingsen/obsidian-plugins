SX Tasks

A lightweight Obsidian plugin for page-local structured tasks with automatic task codes, same-note references, and completion date tracking.

Authors: Senxiu & Codex

Overview

SX Tasks is designed for users who want a slightly smarter task system inside a single Obsidian note, without turning the note into a full project-management database.

The plugin provides:

a custom sxtasks block near the top of a note

automatic task and subtask code generation

inline same-note references to tasks and subtasks

the ability to complete tasks from references

automatic completion date detection based on nearby note structure

The main goal is to support a workflow like this:

define a structured task list at the top of the note

refer to those tasks later in the same note

mark tasks complete from below

automatically update the original task and store a completion date

Core design goals

No manual task IDs

Human-friendly display codes

Stable internal references

Same-note only for MVP

Markdown file remains the source of truth

No external database or server

Main features
1. Structured task block

Tasks are defined inside a custom fenced block:

```sxtasks
tasks:
  - text: Write figure draft
    children:
      - text: Fix legend
      - text: Update caption
  - text: Reply to email
```

The plugin renders this block into an interactive task list UI.

The source block stores the raw task data.
The rendered view provides a cleaner interface for interaction.

2. Automatic task codes

Task codes are generated automatically by the plugin.

Top-level tasks

Top-level tasks use letters:

A

B

C

Subtasks

Subtasks use letter + number:

A1

A2

B1

These codes are:

generated automatically

shown at the beginning of each rendered task item

never required to be written manually by the user

Example rendered output:

A Write figure draft

A1 Fix legend

A2 Update caption

B Reply to email

3. Hidden stable internal IDs

Display codes such as A and A1 are not the real identifiers.

Each task and subtask must have a hidden stable internal ID generated automatically by the plugin.

These internal IDs are used for:

reference storage

completion updates

maintaining task identity when the task order changes

This ensures that:

inserting a new task above existing tasks

reordering tasks

renaming tasks

does not break old references or completion records.

4. Same-note inline references

Tasks and subtasks from the top sxtasks block can be referenced later in the same note.

References should point to the original task/subtask instead of duplicating its content.

For MVP, the plugin only needs to support same-note references.

Possible internal syntax:

[sxref:task-internal-id]

This syntax is only a storage format.
In reading/rendered mode, the plugin should display a human-readable reference such as:

A1 Fix legend

or A1 Fix legend ✅ 2026-03-17 if completed

The exact internal token format may be adjusted during implementation, but the principle is:

the note stores a stable internal reference

the plugin renders it into readable text

5. Completing from references

A task or subtask can be marked as done from a reference later in the note.

When a referenced item is completed:

the original task in the top sxtasks block is updated

the completion date is written back to the original task data

all rendered references to that task reflect the new completed state

This means the task is always completed at the source, not only at the reference site.

6. Completion date detection

When a task is completed from a reference, the plugin should infer the completion date from nearby note structure.

The date detection priority should be:

nearest previous explicit date marker in the form @YYYY-MM-DD

nearest previous heading that can be parsed as a date

today's date as fallback

Examples:

@2026-03-17

or

## 2026-03-17

or

## March 17, 2026

The plugin should use the nearest previous valid date context above the reference location.

Important behavior rules
Dynamic display codes

Display codes are computed dynamically from the current task order.

If a new task is inserted above existing tasks, the visible codes may change.

Example:

Before insertion:

A Write figure draft

B Reply to email

After inserting a new task at the top:

A Prepare weekly note

B Write figure draft

C Reply to email

This is acceptable.

Stable references despite code changes

Even if visible codes change, references and completion history must remain attached to the same logical task through its hidden internal ID.

Old references must not drift to the wrong task.

This is a critical requirement.

Data model

The plugin should store structured task data inside the sxtasks block.

A possible source format is YAML-like:

```sxtasks
tasks:
  - id: sx_001
    text: Write figure draft
    done:
    children:
      - id: sx_001_001
        text: Fix legend
        done:
      - id: sx_001_002
        text: Update caption
        done: 2026-03-17
  - id: sx_002
    text: Reply to email
    done:
```
Field meanings

id: hidden stable internal ID, auto-generated by plugin

text: task text

done: completion date or empty

children: optional list of subtasks

Important note

The user should not be required to manually write IDs.

If IDs are missing, the plugin should generate them automatically and write them back into the block.

Rendering requirements

The rendered UI should:

show display codes at the beginning

show task text

show completed state clearly

show completion date when available

support nested subtasks

support clicking/toggling completion

Example rendered display:

A Write figure draft

A1 Fix legend

A2 Update caption ✅ 2026-03-17

B Reply to email

Reference behavior
Reference storage

References must store internal IDs, not display codes.

Example internal storage:

[sxref:sx_001_002]
Reference rendering

In reading/rendered mode, this may appear as:

A2 Update caption

A2 Update caption ✅ 2026-03-17

Reference updates

If task order changes and A2 becomes B2, the rendered reference should update automatically.

The stored reference should not need manual editing.

Completion behavior
Source-of-truth rule

Completion state belongs to the original task inside the top sxtasks block.

References are views/actions on that source task, not independent copies.

Completing from below

Completing a task from a reference later in the note should:

update the source task

set done if empty

use the inferred date

update all rendered instances in the note

Manual vs automatic parent completion

For MVP:

parent task completion is manual only

completing all subtasks does not automatically complete the parent task

This keeps behavior simple and predictable.

Auto-completing parents can be considered a future enhancement.

Scope of MVP
Included

one sxtasks block per note

automatic internal ID generation

automatic display code generation

nested subtasks

same-note inline references

completing tasks from references

completion date inference

source block updates

Not included

cross-note references

vault-wide task queries

Dataview integration

recurring tasks

multiple completion events per task

automatic parent completion

drag-and-drop reordering

advanced task metadata such as priority, tags, status types

Commands for MVP

Suggested commands:

Insert SX Tasks block

Insert a new starter sxtasks block into the current note.

Insert SX Task reference

Show a picker of tasks/subtasks from the current note and insert a reference token for the selected item.

Refresh SX Task references in current note

Optional helper command to rewrite or refresh reference rendering in the current note, if needed.

Normalize SX Tasks block

Optional helper command to:

generate missing IDs

clean formatting

ensure valid structure

Suggested implementation notes
Recommended stack

TypeScript

Obsidian Plugin API

Suggested plugin responsibilities

parse the sxtasks block

ensure each task has a stable internal ID

compute display codes from current structure

render the task tree

parse inline reference tokens

render inline references

handle completion actions

infer completion dates from note context

write updates back to the source markdown

Data integrity priority

Correct identity tracking is more important than preserving fixed visual codes.

Display codes may change.
Task identity must not.

Example workflow
Top of note
```sxtasks
tasks:
  - text: Write figure draft
    children:
      - text: Fix legend
      - text: Update caption
  - text: Reply to email
```
Later in note
@2026-03-17

Today I finished [sxref:<id-of-Update-caption>] and may do [sxref:<id-of-Reply-to-email>] next.
Result

the referenced subtask is marked done

the original sxtasks block stores done: 2026-03-17

rendered references update accordingly

Non-goals

SX Tasks is not intended to replace:

Obsidian Tasks plugin

a full project-management system

a vault-wide GTD workflow

a kanban board

It is specifically for users who want a lightweight single-note structured task + narrative note workflow.

Summary of key rules

display codes are automatic

top-level tasks use letters

subtasks use letter + number

display codes are shown at the beginning of rendered tasks

internal IDs are hidden and stable

references store internal IDs, not display codes

inserting or reordering tasks must not break old references

completing from references updates the original source task

completion date priority is:

nearest previous @YYYY-MM-DD

nearest previous parseable heading date

today

parent task completion is manual only in MVP

MVP only requires same-note support

Suggested future enhancements

cross-note references

automatic parent completion

configurable code styles

support for multiple date marker formats

richer inline rendered badges

optional completion history

optional metadata such as priority or tags
