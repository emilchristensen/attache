---
title: Front matter is left alone. Even with two sentences.
---

# A heading may hold two sentences. Nobody splits headings.

One sentence on a line.
A second sentence, e.g. with an abbreviation, sits on the next line.
Abbreviations such as i.e. Slack, etc. Gmail and vs. Jira do not end a sentence.
Version numbers like 0.1.0 and Node 24.22 are not sentence ends, nor is Ubuntu 22.04.
File names such as `install.sh`, scripts/build-release.mjs and README.md are fine.
Inline code may hold anything: `a. B. C.` stays one sentence.
Double backticks too: ``echo "one. Two."`` stays one sentence.
URLs like https://example.com/a.b. are fine, and so is <https://example.com/x.Y>.
Links keep their text: [read the guide](docs/user-guide.md#a.-b) for more.
An initial like J. Smith does not end a sentence.
Lower case after a period is not a new sentence, as in Node.js. or claude.ai. and the rest.
A sentence may end with a question mark?
An ellipsis... And this continues the thought.

- A list item with one sentence.
  Its continuation line holds the second sentence.
- **A run-in label.** The text after a bold label at the start of a line is one sentence.
- Another item, with `code. That has periods.` inside.
1. A numbered item.
   With a continuation.

**Label at the start of a paragraph!** _(An aside in italics.)_

> A quote with one sentence.
> And its second sentence on its own line.

| Table | Cell. With two sentences. |
| --- | --- |
| Row one. Row two. | Fine. Really. |

[ref]: https://example.com/ref.html "A title. With two sentences."

```sh
echo "Code blocks are skipped. Even with two sentences."
```

~~~
Tilde fences too. Really.
~~~

<!-- An HTML comment. With two sentences. -->

<!--
A multi-line comment. With two sentences.
-->

<details>
<summary>HTML lines are skipped. Even with two sentences.</summary>
</details>
