---
name: plan-skill
description: Planning templates and checklists to help the plan agent produce structured, actionable plans.
---

# Plan Skill: templates and examples

## Overview
This skill contains templates and sample plans to help the model produce consistent, reviewable plans.

## Template: implementation-plan.md

### Problem
Describe the problem or feature request.

### Goal
State clear success criteria.

### Constraints
List constraints (time, backward-compatibility, API limits).

### Tasks
- Task 1: Describe and owner
- Task 2: Describe and estimate

### Acceptance
- Tests or manual verification steps.

## Example Plan: add-search-endpoint

Problem: Add a /search endpoint to query items.

Goal: ...

Steps:
- Design API
- Implement route
- Add tests

## Templates and scripts
- `templates/implementation-plan.md` — filled by the model
- `scripts/ci-checklist.sh` — optional helper script

## Usage notes
When asked for a plan, models should pick the `implementation-plan.md` template and write the filled plan to `.opencode/plans/<timestamp>-<slug>.md`.

