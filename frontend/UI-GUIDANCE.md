# UI design references

Use these repository copies when designing, implementing, or reviewing Envoi UI in `frontend/src/**` and `frontend/marketing-preview/**`. Apply the guidance that fits the task, then verify the result in the relevant UI. Envoi's product requirements, accessibility needs, and repository instructions take precedence over third-party examples.

| Reference | Use for | Local copy | Upstream |
| --- | --- | --- | --- |
| Emil Kowalski's Design Engineering | Visual polish, component behavior, transitions, and animation review | [SKILL.md](ui-skills/emil-design-eng/SKILL.md) | [Source](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md) |
| Emil Kowalski's Mobile Native | Touch behavior, mobile viewport, safe areas, and real-device checks | [SKILL.md](ui-skills/mobile-native/SKILL.md) | [Source](https://github.com/emilkowalski/skills/blob/main/skills/mobile-native/SKILL.md) |
| Vercel's Web Design Guidelines | Web UI and accessibility review | [SKILL.md](ui-skills/web-design-guidelines/SKILL.md) | [Source](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md) |

The Vercel skill is an entrypoint: fetch its linked [current guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) for each review. The local skill copies were retrieved from the upstream `main` branches on 2026-10-25. Check upstream before relying on a rule that may have changed.

The two Emil Kowalski skills are distributed under the [MIT license](ui-skills/EMIL-LICENSE.txt). The Vercel repository [states MIT licensing](https://github.com/vercel-labs/agent-skills#license); its source repository does not currently provide a standalone license file. These are third-party references, not Envoi product requirements.
